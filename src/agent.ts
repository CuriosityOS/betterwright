// BetterWright's own agent harness — the exec mode.
//
// BetterWright is normally an add-on: some other agent (Claude Code, Codex, Pi,
// an MCP client) drives it through `run()`, the MCP `browser` tool, or the Pi
// package. That is the REPL shape — bring your own harness.
//
// This module adds the other shape, exec: BetterWright supplies the
// browser-tuned harness and you plug a *model* into it, then hand it a
// natural-language task. The harness owns the observe → act → verify loop (the
// part that made a browser-specialized agent faster than a general coding agent
// in the head-to-head), and the model is a small injectable interface — which
// is also how someone brings their own model or agent.
//
// A model is any object with:
//     async complete({ system, messages, tools }) -> { text, toolCalls, stopReason }
// over the neutral message shape this file defines. Three adapters ship:
// Claude (Anthropic SDK), GPT/Codex (the ChatGPT-backend Responses API over
// Codex OAuth creds, or OpenAI-compatible with an API key), and Grok
// (OpenAI-compatible over Grok OAuth creds). Pass an actual model id, or pass
// your own object to drive the loop with anything.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { AgentModel, ResolvedAuth, RunAgentTaskOptions } from "../types/agent.js";
import type { BetterWrightOptions } from "../types/public.js";
import { uncachedInputTokens } from "./agent-usage.js";
import { codexAccessToken, codexHome, grokAccessToken, loadCodexAuth, loadGrokAuth } from "./auth.js";
import {
  BetterWright,
  NetworkPolicy,
} from "./client.js";
import { normalizeCredentialToolOptions } from "./credential-tool-options.js";
import { importOptionalPeer } from "./optional-peer.js";
import { piImageArtifacts, piImageContent } from "./pi.js";
import { agentSystemPrompt } from "./prompt.js";
import { matchSkillsForText, readSkill } from "./skills.js";
import { agentBrowserToolParameters, agentLoginToolParameters } from "./tool-schemas.js";
import {
  isBoolean,
  isCallable,
  isNumber,
  isRecord,
  isString,
  type UntrustedValue,
  untrustedField,
} from "./untrusted-value.js";

// The ChatGPT backend Responses endpoint the codex CLI drives with a ChatGPT
// OAuth access token (overridable if the backend path moves).
const CHATGPT_RESPONSES_BASE =
  process.env.CODEX_RESPONSES_BASE || "https://chatgpt.com/backend-api/codex";

const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_MAX_DURATION_MS = 30 * 60 * 1000;
const DEFAULT_MAX_TRANSCRIPT_CHARS = 1_000_000;
const MAX_TIMER_MS = 2_147_483_647;
const OBSERVATION_LIMIT = 12_000;
const AGENT_TIMEOUT = Symbol("agent-timeout");
// A caller-requested stop (the session daemon's `interrupt` op, a Ctrl-C that
// reached the daemon). Travels the same path as the timeout symbol: thrown
// past tool-level catch blocks so nothing swallows it, then turned into a
// partial result with `reason: "interrupted"` — the transcript is kept, so the
// next task in the session resumes from where the user cut it off.
const AGENT_INTERRUPT = Symbol("agent-interrupt");
// The loop has no step cap by design, so a browser step that fails the same way
// every time is otherwise free to repeat until the whole wall-clock budget is
// gone — a page the harness cannot act on, a snippet that keeps hitting the
// worker deadline, a form that will not accept input. Identical consecutive
// failures escalate instead: first a warning the model can act on, then the run
// ends and reports the blocker rather than burning the remaining budget.
const REPEATED_FAILURE_WARNING = 3;
const REPEATED_FAILURE_LIMIT = 5;

/** Control-flow signals that a tool-level `catch` must never absorb. */
function isControlSignal(error) {
  return error === AGENT_TIMEOUT || error === AGENT_INTERRUPT;
}

/** Callable is the only probe available for an injected fetch implementation. */
function isFetchImplementation(value: UntrustedValue): value is typeof fetch {
  return isCallable(value);
}

/** The documented `getAuth` contract: a nullary provider of per-request auth. */
function isAuthProvider(value: UntrustedValue): value is () => ResolvedAuth | Promise<ResolvedAuth> {
  return isCallable(value);
}

/** A bring-your-own model object: anything with an async `complete` method. */
function isAgentModel(value: UntrustedValue): value is AgentModel {
  return isRecord(value) && isCallable(untrustedField(value, "complete"));
}

/**
 * The runtime probe guards untyped JS callers; the predicate keeps the
 * declared `onStep` signature, which the void return would otherwise lose.
 */
function isStepCallback(value: UntrustedValue): value is NonNullable<RunAgentTaskOptions["onStep"]> {
  return isCallable(value);
}

function isPhaseCallback(value: UntrustedValue): value is NonNullable<RunAgentTaskOptions["onPhase"]> {
  return isCallable(value);
}

/**
 * Close an unfinished turn so the transcript stays a valid conversation.
 *
 * When a run ends mid-turn — the wall-clock budget expired, or the caller
 * interrupted it — the model's tool calls are already in the transcript with
 * no results behind them. Every provider rejects a dangling tool call on the
 * next request, which would make the saved session unresumable. Answer each
 * orphaned call with a stub instead. Mutates in place; a no-op on a transcript
 * that already ends cleanly.
 */
export function sealTranscript(messages, reason = "stopped") {
  if (!Array.isArray(messages) || !messages.length) return messages;
  const last = messages[messages.length - 1];
  if (last?.role !== "assistant" || !Array.isArray(last.toolCalls) || !last.toolCalls.length)
    return messages;
  const note =
    reason === "interrupted"
      ? "Cut short: the user interrupted the run before this call completed. Its effect on the page is unknown — re-observe before acting on it."
      : "Cut short: the run ended before this call completed. Its effect on the page is unknown — re-observe before acting on it.";
  messages.push({
    role: "tool",
    results: last.toolCalls.map((call) => ({
      id: call.id,
      name: call.name,
      content: note,
    })),
  });
  return messages;
}

// Bounded retry around the model call. Three attempts total with exponential
// backoff + jitter covers the transient blips (429s, 5xx, dropped
// connections) without turning a hard failure into a stall: per-sleep and
// honored Retry-After are capped, so the worst case adds well under half a
// minute — and the whole retry loop still runs under the agent deadline, so
// it can never outlive the wall-clock budget. The Anthropic SDK adapter
// already retries twice internally; the small caps keep the layered retries
// from compounding into a long wait.
const MODEL_RETRY_MAX_ATTEMPTS = 3;
const MODEL_RETRY_BASE_DELAY_MS = 500;
const MODEL_RETRY_MAX_DELAY_MS = 8_000;

// Adapter stopReason vocabularies, normalized. Anthropic reports
// "max_tokens" / "refusal"; OpenAI-compatible chat reports "length" /
// "content_filter"; the Responses API reports an "incomplete" status when the
// output-token limit cuts the response.
const TRUNCATED_STOP_REASONS = new Set(["max_tokens", "length", "incomplete"]);
const REFUSAL_STOP_REASONS = new Set(["refusal", "content_filter"]);

export const MODEL_ENDPOINT_PRESETS = Object.freeze({
  openrouter: Object.freeze({
    baseURL: "https://openrouter.ai/api/v1",
    baseURLEnv: "OPENROUTER_BASE_URL",
    apiKeyEnv: "OPENROUTER_API_KEY",
    requiresApiKey: true,
  }),
  ollama: Object.freeze({
    baseURL: "http://127.0.0.1:11434/v1",
    baseURLEnv: "OLLAMA_BASE_URL",
    apiKeyEnv: "OLLAMA_API_KEY",
    requiresApiKey: false,
  }),
  vllm: Object.freeze({
    baseURL: "http://127.0.0.1:8000/v1",
    baseURLEnv: "VLLM_BASE_URL",
    apiKeyEnv: "VLLM_API_KEY",
    requiresApiKey: false,
  }),
  custom: Object.freeze({
    baseURL: null,
    baseURLEnv: "BETTERWRIGHT_MODEL_BASE_URL",
    apiKeyEnv: "BETTERWRIGHT_MODEL_API_KEY",
    requiresApiKey: false,
  }),
});

// How the harness introduces its tools. `agentSystemPrompt()` speaks in terms of
// `run()`; this preamble maps that onto the `browser` tool so the same operator
// guidance applies unchanged.
const HARNESS_PREAMBLE_HEAD = `You are operating a real, persistent, policy-guarded web browser to complete the user's task end to end, autonomously.

Call the \`browser\` tool with async Playwright JavaScript to act — each call is one \`run()\` in the guidance below. A single trailing expression is returned; a statement block must \`return\`. Globals: page, pages, context, state, openPage, usePage(idOrIndex), closePage(idOrIndex?), snapshot, screenshot, artifactPath, dialogs, credentials, captcha, human, overlays, controls, media, site, webagents, webmcp. Host cleanup is automatic; do not close pages merely to finish.

Work in as few \`browser\` calls as the task safely allows: every call is a full model round-trip, so the number of calls — not the browser — sets your speed. One \`browser\` call can run a whole sequence, so plan the next stretch of work and do it in a single call.

- Plan, then batch. When you already know what to read and where from — a value on a page, the same field across several pages, a comparison between tabs — do it in ONE call: navigate (or open several tabs with \`Promise.all([openPage(a), openPage(b)])\`), extract each value, compute, and return the finished result. Do not spend one call per page, and do not snapshot article-style reference pages first — grab a generous text region (an infobox, a lead section, \`main\`) from each page in the same call and parse the values out in JS; fall back to a snapshot only if parsing comes up empty.
- Finish in the same call when you can. For a read-only task — look up, extract, compare, compute — do the whole job in ONE \`browser\` call: navigate, extract, compute, capture \`screenshot({kind: 'proof'})\`, and \`return { finalAnswer: '<the complete answer for the user>' }\`. Returning \`finalAnswer\` ends the task immediately — no \`done\` call, no extra round-trip. Compose it from the values your code just extracted (template literals), never from values you merely expect — and have the code CHECK the values satisfy the request before finishing (a ranked row's own rank cell says the requested rank; header and spanned rows shift positional indexes, so select by the row's own cells, not by index). On a failed check or dubious data, return the raw data instead and finish next turn. For actions that change state (submissions, purchases, messages), verify the outcome before finishing.
- Prefer direct extraction when the target is unambiguous: \`page.locator(...).innerText()\`, \`getByRole\`, \`allInnerTexts()\`, or \`page.url()\` after a redirect. Known shortcuts (a project's \`/releases/latest\` URL) beat click-through exploration. Compute in JS and return the finished answer, not raw page dumps.
- When the right element is not obvious — an article's first real sentence (leading nodes are often empty or hatnotes), the "main" result among many — read a scoped \`snapshot({interactive:true})\` or \`snapshot({selector})\` first to see the real structure, then target precisely. If an extraction returns empty, too short, or clearly wrong, do NOT retry the same blind locator — take one snapshot to see the structure, then extract. One snapshot beats three guesses.
- Use the read → act → verify loop when the page is interactive or its structure is unknown — forms, logins, search boxes, dynamic UIs, or when an action's outcome is uncertain: \`snapshot({interactive: true})\` to see what to click, act on \`[ref=eN]\` via \`page.locator('aria-ref=eN')\`, then \`snapshot({diff: true})\` to confirm. Snapshots cover the whole page including iframes and off-screen elements — never scroll just to read, never guess a ref or URL, and never truncate a snapshot string in code (\`slice\`/\`substring\`) — scope it with \`{ref}\`/\`{selector}\` or raise \`{maxChars}\` instead.`;

// Autonomy paragraph — two variants. In `exec` no one is watching, so the model
// must never stall; in an interactive session the `ask` tool exists, so the model
// may ask when it genuinely needs the user (but still acts on the obvious).
const HARNESS_AUTONOMY_HEADLESS = `You are operating autonomously: the user is not watching and cannot answer mid-task. Do not ask "shall I proceed?" — for reversible steps that follow from the task, act. Work until the task is genuinely done or you are truly blocked (an MFA code you cannot obtain, a consequential choice with no reasonable default).`;

const HARNESS_AUTONOMY_INTERACTIVE = `You are operating in an interactive session: the user is present and can answer through the \`ask\` tool. Still act autonomously — do not ask "shall I proceed?" for reversible steps that follow from the task; just do them. Call \`ask\` only when you genuinely need the user: an input you cannot obtain yourself (an MFA/2FA code, which of several accounts to use), a consequential or irreversible choice with no reasonable default (a purchase, a message to send, a destructive action), or a task ambiguous enough that guessing risks doing the wrong thing. Offer short concrete options and mask any secret (e.g. "account ending 999"). Then keep working until the task is genuinely done.`;

const HARNESS_PREAMBLE_TAIL = `When finished, end the task: either return \`{ finalAnswer }\` from the final \`browser\` call (preferred — saves a round-trip) or call the \`done\` tool with a clear answer for the user. On any task with a visible result, capture \`screenshot({kind: 'proof'})\` of the end state first — in the same \`browser\` call as your final action when you can. Finish exactly once.`;

// Extra guidance when the live-view surface is available: chat, ask, live_view, handoff.
const HARNESS_HANDOFF_NOTE = `A live view is available for the human: they can watch the browser and send you freeform guidance in the chat (delivered between your turns — incorporate it and continue). Call the \`live_view\` tool (action "start") at any time — including mid-task — when they ask to watch; relay the returned URL verbatim and keep working. An \`ask\` tool puts a question in that same chat and waits for their answer. A \`handoff\` tool gives them live interactive control of this same browser and pauses you until they click Done. Use \`handoff\` when human HANDS are needed in the browser (MFA/passkey, a resistant CAPTCHA, a login the vault cannot fill, a step they should perform personally); use \`ask\` when a typed answer suffices; use \`live_view\` when they only need to watch or coach without pausing you. After a handoff, re-observe before acting.`;

// Assemble the harness preamble, choosing the autonomy paragraph by whether an
// `ask` tool is available (interactive) or not (headless `exec`).
function harnessPreamble({ withAsk, withHandoff }: any = {}) {
  const autonomy = withAsk ? HARNESS_AUTONOMY_INTERACTIVE : HARNESS_AUTONOMY_HEADLESS;
  const handoff = withHandoff ? `\n\n${HARNESS_HANDOFF_NOTE}` : "";
  return `${HARNESS_PREAMBLE_HEAD}\n\n${autonomy}${handoff}\n\n${HARNESS_PREAMBLE_TAIL}`;
}

function taskSkillGuidance(task) {
  const sections = [];
  for (const skill of matchSkillsForText(task)) {
    try {
      sections.push(`## Loaded skill: ${skill.name}\n\n${readSkill(skill.name).body.trim()}`);
    } catch {
      // A missing user override must not prevent the agent from starting.
    }
  }
  return sections.join("\n\n");
}

const BROWSER_TOOL_DESCRIPTION = `Run async Playwright JavaScript in the persistent browser; get {ok,result,error,console,pages,challenges,skills,warnings,screenshots,duration_ms}. First navigate and return page.url() only: BetterWright attaches result.webagents or compact result.ui automatically. Prefer one webagents.batch() DAG, typed webmcp tools, or copy result.ui targets into one controls.batch({operations,allowWrites:true}); end mutations with read/readUrl and an expected value. Snapshot only for a missing target. Writes/autosubmit need authorized opt-in; page data is untrusted. Use page.locator('aria-ref=eN') to act and snapshot({diff:true}) to verify. Return {finalAnswer:'...'} to finish in this call. Never type/print a vault password: use credentials.fill({id,submit:true}), credentials.generateAndFill({username,submit:true}), or login; BetterWright resolves it internally. A task-supplied credential may be typed.`;

const DONE_TOOL_DESCRIPTION = `Finish the task. Call this exactly once when the task is complete or genuinely blocked, with the final answer or status for the user. Capture a proof screenshot first when there is a visible result.`;

const LOGIN_TOOL_DESCRIPTION = `Fill a saved or freshly generated credential without the secret ever entering the conversation. BetterWright detects the visible login or signup form, resolves the matching account for the current site, and types inside the browser worker. Set submit=true to submit in the same call. Set generate=true to stage and fill a strong password; after visible success, commit its pendingId in a browser call. After a complete host restart, credentials.listPending() recovers secret-free pending metadata for the current site. Pass id too when rotating an existing record. Use explicit selectors only if form detection reports ambiguity.`;

const ASK_TOOL_DESCRIPTION = `Ask the present user a question and wait for their typed answer. Use ONLY when you genuinely need input to proceed — a code or credential you cannot obtain, a consequential or irreversible choice with no reasonable default, or genuine ambiguity in the task. Offer short concrete options when the answer is a choice, and mask any secret (e.g. "account ending 999"). Do not use it to ask permission for ordinary reversible steps — just do those.`;

const ASK_TOOL_PARAMETERS = {
  type: "object",
  properties: {
    question: { type: "string", description: "The question to put to the user." },
    options: {
      type: "array",
      items: { type: "string" },
      description: "Optional short, concrete choices to offer when the answer is a selection.",
    },
  },
  required: ["question"],
};

const HANDOFF_TOOL_DESCRIPTION = `Hand the live browser to the user and pause until they finish. Their view is the REAL session — cookies, logins, and page state carry over both ways. Use ONLY when human hands are genuinely needed in the browser itself: an MFA prompt or passkey, a CAPTCHA that resisted captcha.solve(), a login the vault cannot fill, or a consequential step the user should perform personally. Do not use it for typed answers (use ask), for watch-only (use live_view), or for steps you can do yourself. The user is shown your reason and a live, interactive view of the browser; when they click Done (or Cancel), you resume — re-observe with snapshot({diff:true}) before acting, because the page state may have changed under their hands.`;

const HANDOFF_TOOL_PARAMETERS = {
  type: "object",
  properties: {
    reason: {
      type: "string",
      description: "Why human hands are needed, shown to the user in the live viewer (e.g. 'Approve the MFA prompt for account ending 999').",
    },
    expectation: {
      type: "string",
      description: "Optional: what the page should look like when they are finished, so they know when to click Done.",
    },
  },
  required: ["reason"],
};

const LIVE_VIEW_TOOL_DESCRIPTION = `Open (or report) a live web view of this browser so the user can watch and coach you without pausing the task. Call when they ask to watch, share a screen, or open a live view — at any time, including mid-task. action "start" (default) returns the watch URL (relay it verbatim); "status" reports whether it is running; "stop" tears it down. Prefer this over handoff when they only need to see the browser; use handoff when they need to drive it themselves.`;

const LIVE_VIEW_TOOL_PARAMETERS = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["start", "status", "stop"],
      description: 'start the live view (default), check it, or stop it.',
    },
  },
};

// Parameter schemas are shared across the agent/MCP/Pi surfaces; the shared
// module is the single source of truth (see src/tool-schemas.ts).
const LOGIN_TOOL_PARAMETERS = agentLoginToolParameters();

const BROWSER_TOOL_PARAMETERS = agentBrowserToolParameters();

const DONE_TOOL_PARAMETERS = {
  type: "object",
  properties: {
    answer: { type: "string", description: "The final answer or status to report to the user." },
  },
  required: ["answer"],
};

// Normalize a provider's token-usage block to a common shape:
//   { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }
// `inputTokens` is the TOTAL prompt size for the turn (cached tokens included),
// so the final turn's `inputTokens` is the context size at the end of the task;
// `cacheReadTokens`/`cacheWriteTokens` break out the cached portion.
//
// Anthropic reports the uncached prompt in `input_tokens` and the cached parts
// separately, so the total is the sum.
function anthropicUsage(usage) {
  if (!usage) return null;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const cacheWrite = usage.cache_creation_input_tokens || 0;
  return {
    inputTokens: (usage.input_tokens || 0) + cacheRead + cacheWrite,
    outputTokens: usage.output_tokens || 0,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
  };
}

// Chat Completions uses prompt_/completion_tokens under `prompt_tokens_details`;
// the Responses API uses input_/output_tokens under `input_tokens_details` —
// accept either. Cached (read) and cache-written tokens are reported directly by
// GPT-5.6+ as descriptive fields inside that details object (both are portions of
// the prompt total); older models omit `cache_write_tokens`, so it reads as 0.
function openaiUsage(usage) {
  if (!usage) return null;
  const details = usage.prompt_tokens_details ?? usage.input_tokens_details ?? {};
  return {
    inputTokens: usage.prompt_tokens ?? usage.input_tokens ?? 0,
    outputTokens: usage.completion_tokens ?? usage.output_tokens ?? 0,
    cacheReadTokens: details.cached_tokens ?? 0,
    cacheWriteTokens: details.cache_write_tokens ?? 0,
  };
}

function toolsForHarness({ withLogin, withAsk, withHandoff }) {
  const tools: any[] = [
    { name: "browser", description: BROWSER_TOOL_DESCRIPTION, parameters: BROWSER_TOOL_PARAMETERS },
    { name: "done", description: DONE_TOOL_DESCRIPTION, parameters: DONE_TOOL_PARAMETERS },
  ];
  if (withLogin)
    tools.push({ name: "login", description: LOGIN_TOOL_DESCRIPTION, parameters: LOGIN_TOOL_PARAMETERS });
  if (withAsk)
    tools.push({ name: "ask", description: ASK_TOOL_DESCRIPTION, parameters: ASK_TOOL_PARAMETERS });
  if (withHandoff) {
    tools.push({ name: "live_view", description: LIVE_VIEW_TOOL_DESCRIPTION, parameters: LIVE_VIEW_TOOL_PARAMETERS });
    tools.push({ name: "handoff", description: HANDOFF_TOOL_DESCRIPTION, parameters: HANDOFF_TOOL_PARAMETERS });
  }
  return tools;
}

// Compact a run result envelope into a text observation the model reads back.
// Screenshot paths stay in that JSON; captcha/proof bytes are attached as
// vision blocks on the latest tool turn via `withLatestCaptchaVision`.
function observationFromResult(result) {
  const screenshots = (result.artifacts || [])
    .filter((a) => a.path && /\.(png|jpe?g)$/i.test(a.path))
    .map((a) => ({ kind: a.kind, path: a.path }));
  // Empty arrays and null placeholders repeat on almost every successful call
  // and convey nothing. Omit them from the model-facing observation: consumers
  // already treat missing optional fields as empty, and long transcripts keep
  // the saving once per browser step.
  const summary: any = { ok: result.ok };
  if (result.result !== undefined) summary.result = result.result;
  if (result.error != null) summary.error = result.error;
  if (result.pendingCredential != null)
    summary.pendingCredential = result.pendingCredential;
  for (const field of ["console", "pages", "challenges", "skills", "warnings"]) {
    if (Array.isArray(result[field]) && result[field].length)
      summary[field] = result[field];
  }
  if (result.webagents) summary.webagents = result.webagents;
  if (result.ui) summary.ui = result.ui;
  if (screenshots.length) summary.screenshots = screenshots;
  if (result.durationMs != null) summary.duration_ms = result.durationMs;
  if (summary.result !== undefined && JSON.stringify(summary.result).length > OBSERVATION_LIMIT) {
    summary.result = "[truncated; inspect via a scoped snapshot]";
  }
  return JSON.stringify(summary);
}

function browserToolObservation(id, result) {
  const observation: any = {
    id,
    name: "browser",
    content: observationFromResult(result),
  };
  const imagePaths = piImageArtifacts(result);
  if (imagePaths.length) observation.imagePaths = imagePaths;
  return observation;
}

/** Attach captcha/screenshot bytes only on the latest tool turn, from disk. */
async function withLatestCaptchaVision(messages) {
  if (!Array.isArray(messages) || !messages.length) return messages;
  const last = messages[messages.length - 1];
  if (last?.role !== "tool" || !Array.isArray(last.results)) return messages;
  const results = [];
  for (const result of last.results) {
    if (!result?.imagePaths?.length) {
      results.push(result);
      continue;
    }
    results.push({
      ...result,
      images: await piImageContent({
        artifacts: result.imagePaths.map((image) => ({
          kind: "captcha",
          path: image.path,
          media: `MEDIA:${image.path}`,
        })),
      }),
    });
  }
  return [...messages.slice(0, -1), { ...last, results }];
}

/** A stable fingerprint for a failed browser observation, used to notice a step
 * that is repeating rather than progressing. Numbers are collapsed so failures
 * differing only in a timeout, a count, or an element ref still read as the same
 * failure. A successful call has no signature, which clears the streak. */
function failureSignature(result) {
  if (!result || result.ok) return "";
  const text = String(result.error || "").trim();
  if (!text) return "";
  return text
    .toLowerCase()
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .slice(0, 200);
}

function repeatedFailureAdvice(count) {
  return count >= REPEATED_FAILURE_LIMIT
    ? `This browser step has now failed the same way ${count} times in a row, so the run stops here. Report what you established and what blocked you.`
    : `This browser step has failed the same way ${count} times in a row. Repeating it will not help — change approach (a different selector, a reload, another route to the goal), or finish with what you have and report the blocker. The run stops after ${REPEATED_FAILURE_LIMIT} identical failures.`;
}

// A browser call can end the task in the same turn: when the model's code
// returns `{ finalAnswer: "..." }`, the harness treats it as `done` without
// spending another model round-trip. Only an ok result counts — an errored
// call never finishes the task.
function finalAnswerFromResult(result) {
  if (!result?.ok) return null;
  const value = result.result;
  if (!isRecord(value)) return null;
  const finalAnswer = untrustedField(value, "finalAnswer");
  if (!isString(finalAnswer) || !finalAnswer.trim()) return null;
  return finalAnswer.trim();
}

// Run one operation under the agent's wall-clock deadline and, when the caller
// supplied one, under an external stop signal. Both resolve to an abort on the
// controller the operation sees, so an in-flight model call or browser step
// ends promptly instead of running to completion after the user gave up.
async function withinDeadline(operation, deadline, stopSignal) {
  const remainingMs = deadline - Date.now();
  if (stopSignal?.aborted) throw AGENT_INTERRUPT;
  if (remainingMs <= 0) throw AGENT_TIMEOUT;

  const controller = new AbortController();
  let timer;
  let onStop;
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      // The external stop, when there is one. Same shape as the watchdog
      // below: abort what the operation is doing, then reject the race.
      new Promise((_, reject) => {
        if (!stopSignal) return;
        onStop = () => {
          controller.abort(AGENT_INTERRUPT);
          reject(AGENT_INTERRUPT);
        };
        stopSignal.addEventListener("abort", onStop, { once: true });
      }),
      // Not unref'd: this watchdog exists to guarantee the operation ends in a
      // reported timeout, and an unref'd timer cannot make that guarantee. If
      // the operation is pending on nothing that holds the loop -- a model
      // adapter whose promise only settles on abort -- Node drains the loop and
      // the process exits silently instead of timing out. The `finally` below
      // already stops the timer from outliving the race, so ref'ing it costs
      // nothing once the operation settles.
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort(AGENT_TIMEOUT);
          reject(AGENT_TIMEOUT);
        }, remainingMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (onStop) stopSignal?.removeEventListener?.("abort", onStop);
  }
}

// Pull an HTTP status out of a failed model call. SDK errors (Anthropic)
// carry a numeric `status`; the fetch-based adapters embed it in their
// "... request failed (429): ..." message.
function statusFromModelError(error) {
  const status = untrustedField(error, "status");
  if (isNumber(status)) return status;
  const message = untrustedField(error, "message");
  const match = /request failed \((\d{3})\)/.exec(isString(message) ? message : "");
  return match ? Number(match[1]) : null;
}

const NETWORK_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENOTFOUND",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

// Retry only what can plausibly succeed on a second try: rate limits,
// server-side failures, and network-level drops. Client errors (400/401/403),
// refusals, and programming mistakes are not transient and must surface.
function isTransientModelError(error) {
  const status = statusFromModelError(error);
  if (status != null) return status === 408 || status === 429 || status >= 500;
  if (!(error instanceof Error)) return false;
  if (error.name === "APIConnectionError" || error.name === "APIConnectionTimeoutError") return true;
  // Node network errors hang `code` off Error (and undici off `cause`) without
  // declaring it; a non-string code is simply not in the set.
  const code = untrustedField(error, "code");
  const causeCode = untrustedField(error.cause, "code");
  if (
    (isString(code) && NETWORK_ERROR_CODES.has(code)) ||
    (isString(causeCode) && NETWORK_ERROR_CODES.has(causeCode))
  )
    return true;
  // Undici surfaces network failures from bare fetch() as TypeError.
  return error instanceof TypeError && /fetch/i.test(error.message);
}

// An error's `headers` may be a fetch Headers object or a plain record.
function isHeaderGetter(value: UntrustedValue): value is Pick<Headers, "get"> {
  return isCallable(untrustedField(value, "get"));
}

// Honor a Retry-After header when the failing client preserved response
// headers (the Anthropic SDK does). Accepts delta-seconds or an HTTP-date.
function retryAfterMsFromError(error) {
  const headers = error?.headers;
  if (!headers) return null;
  const value = isHeaderGetter(headers)
    ? headers.get("retry-after")
    : (headers["retry-after"] ?? headers["Retry-After"]);
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

// A sleep that ends immediately when the surrounding deadline aborts, so a
// backoff pause can never hold the loop past the wall-clock budget.
//
// This timer is deliberately NOT unref'd. During a backoff the pause *is* the
// pending work -- the failed model call has settled and the browser is idle --
// so an unref'd timer here would leave the loop to be held only by the deadline
// watchdog in `withinDeadline`. That happens to be enough today, but it makes a
// retry's liveness depend on an unrelated timer's ref state; ref this one so the
// sleep stands on its own. The deadline is still enforced by the abort listener
// below and by the caller's `Date.now() + delay >= deadline` check, so holding
// the loop for the length of the pause costs nothing.
function sleepWithSignal(ms, signal) {
  return new Promise<void>((resolve, reject) => {
    const fail = () => {
      cleanup();
      reject(signal?.reason ?? new Error("aborted"));
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", fail);
    };
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal?.addEventListener?.("abort", fail, { once: true });
  });
}

// One model turn with bounded retries, all under the agent deadline. Aborts
// (timeout) are never retried; only transient failures are, with exponential
// backoff + jitter, honoring a capped Retry-After when present, and never
// sleeping past the deadline.
async function completeWithRetry(model, request, deadline, stopSignal) {
  return withinDeadline(async (signal) => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await model.complete({ ...request, signal });
      } catch (error) {
        if (signal.aborted || isControlSignal(error)) throw error;
        if (attempt >= MODEL_RETRY_MAX_ATTEMPTS || !isTransientModelError(error)) throw error;
        const backoff = Math.min(
          MODEL_RETRY_MAX_DELAY_MS,
          MODEL_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
        );
        const jittered = backoff * (0.5 + Math.random() * 0.5);
        const delay = Math.min(
          MODEL_RETRY_MAX_DELAY_MS,
          Math.max(retryAfterMsFromError(error) ?? 0, jittered),
        );
        if (Date.now() + delay >= deadline) throw error;
        await sleepWithSignal(delay, signal);
      }
    }
  }, deadline, stopSignal);
}

/**
 * Run a natural-language task through BetterWright's own agent harness.
 *
 * @param {object} options
 * @param {string} options.task the natural-language task to complete
 * @param {string|object} [options.model="claude"] a model name ("claude",
 *   "codex", "grok") or your own object with an async `complete` method
 * @param {object} [options.modelOptions] passed to the named adapter (apiKey,
 *   model id, baseURL, maxTokens, effort, fetchImpl, client)
 * @param {BetterWright} [options.browser] drive an existing browser; otherwise
 *   one is created from the options below and closed when the task ends
 * @param {import("./prompt.js").Guardrails} [options.guardrails] deployer limits
 * @param {string} [options.session="default"] browser session name
 * @param {boolean|"auto"} [options.headless] browser headless mode (new browsers)
 * @param {string} [options.profile] named browser profile (a separate identity
 *   with its own cookies) for a browser this call creates. Ignored when
 *   `browser` is supplied — that browser already has a profile.
 * @param {NetworkPolicy} [options.policy] network policy (new browsers)
 * @param {number} [options.maxDurationMs=1800000] wall-clock budget for the
 *   agent loop; it has no fixed step cap
 * @param {number} [options.maxTranscriptChars=1000000] maximum serialized
 *   transcript size before the loop stops
 * @param {object|false|null} [options.vault] override or disable the built-in
 *   credential vault for a new browser (ignored when an external `browser` is
 *   passed, whose own vault decides login availability)
 * @param {AbortSignal} [options.signal] stop the run early. The in-flight model
 *   call or browser step is aborted, the loop returns a partial result with
 *   `reason: "interrupted"`, and the transcript is preserved so the session can
 *   pick up where it left off.
 * @param {(event: object) => void} [options.onStep] progress callback per step
 * @param {(q: {question: string, options: string[]}) => (string|Promise<string>)} [options.askUser]
 *   when provided, the loop exposes an `ask` tool so the model can put a question
 *   to the user mid-task; the returned string is fed back as the answer. Omit it
 *   (the `exec` default) to run fully autonomously with no `ask` tool.
 * @param {() => (string|string[]|Promise<string|string[]>)} [options.drainSteering]
 *   non-blocking host callback drained at model turn boundaries. Messages
 *   returned while a turn is running steer the next turn; this is the terminal
 *   equivalent of live-view chat.
 * @param {object[]} [options.history] a prior transcript (from a previous call's
 *   `transcript`) to continue from, so a follow-up task can refer back to earlier
 *   work. Omit for a fresh, single-shot run.
 * @param {boolean|object} [options.liveView] live browser view for the human.
 *   Any value except `false` offers live-view chat (freeform guidance between
 *   turns), a chat-backed `ask` tool, and `handoff` (pause + interactive
 *   takeover, resume on Done) as long as a URL surface exists (`askUser` or
 *   `onStep`). Pass `true` (or an options object forwarded to `startLiveView`)
 *   to ALSO start the viewer at run start, so the user can watch the whole
 *   task live while the agent works. When that call creates the viewer, its URL
 *   is emitted as `onStep({tool: "liveView", url})`; an already-running
 *   host-owned viewer is reused without re-announcing it.
 * @returns {Promise<{ok: boolean, answer: string, steps: number, reason: string, toolCalls: number, usage: {inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number, context: number}, durationMs: number, transcript: object[], proof: (string|null)}>}
 */
export async function runAgentTask(options: RunAgentTaskOptions) {
  const task = String(options.task || "").trim();
  if (!task) throw new Error("runAgentTask requires a non-empty `task`.");

  const model = await resolveModelSelection(
    options.model || "claude-opus-4-8",
    options.modelOptions || {},
  );
  const session = String(options.session || "default");
  const stopSignal = options.signal instanceof AbortSignal ? options.signal : null;
  const onStep = isStepCallback(options.onStep) ? options.onStep : () => {};
  const onPhase = isPhaseCallback(options.onPhase) ? options.onPhase : () => {};
  const askUser = isCallable(options.askUser) ? options.askUser : null;
  const drainSteering = isCallable(options.drainSteering) ? options.drainSteering : null;
  const maxDurationMs = options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;
  if (!Number.isFinite(maxDurationMs) || maxDurationMs <= 0 || maxDurationMs > MAX_TIMER_MS) {
    throw new TypeError(
      `runAgentTask maxDurationMs must be between 1 and ${MAX_TIMER_MS}.`,
    );
  }
  const maxTranscriptChars = options.maxTranscriptChars ?? DEFAULT_MAX_TRANSCRIPT_CHARS;
  if (!Number.isFinite(maxTranscriptChars) || maxTranscriptChars <= 0) {
    throw new TypeError("runAgentTask maxTranscriptChars must be a positive finite number.");
  }

  const ownsBrowser = !options.browser;
  let browser = options.browser;
  if (!browser) {
    const ownedBrowserOptions: BetterWrightOptions = {
      policy: options.policy || new NetworkPolicy(),
      headless: options.headless,
      adBlock: options.adBlock,
    };
    if (options.profile) ownedBrowserOptions.profile = options.profile;
    // `vault: undefined` and an absent vault mean different things to the
    // constructor (explicit override vs built-in default), so mirror the key's
    // presence, not just its value.
    if (Object.hasOwn(options, "vault")) ownedBrowserOptions.vault = options.vault;
    browser = new BetterWright(ownedBrowserOptions);
  }
  const withLogin = Boolean(browser.vault);
  // The handoff tool needs the live-view server (started on demand when the
  // model calls it) plus somewhere to put the URL in front of the user.
  const liveViewOption = options.liveView;
  const withHandoff =
    liveViewOption !== false &&
    isCallable(browser.startLiveView) &&
    (Boolean(askUser) || isCallable(options.onStep));
  // Live view doubles as a chat + ask surface, so offer `ask` whenever the
  // host provided askUser OR a live-view chat channel can answer.
  const withAsk = Boolean(askUser) || withHandoff;
  let agentStartedLiveView = false;
  let liveViewReady = false;

  async function ensureAgentLiveView() {
    if (!withHandoff || !isCallable(browser.startLiveView)) return null;
    try {
      // Caller-supplied options spread last so they can override `session`.
      const view = await browser.startLiveView(
        isRecord(liveViewOption) ? { session, ...liveViewOption } : { session },
      );
      if (view?.ok && view.url) {
        if (!view.alreadyRunning) agentStartedLiveView = true;
        liveViewReady = true;
        return view;
      }
      // Explicit --live-view / options object: surface the failure so the URL
      // absence is not silent. On-demand handoff stays quiet if start fails.
      if (liveViewOption) {
        onStep({
          step: 0,
          tool: "liveView",
          note: `live view failed to start: ${view?.error || "no url returned"}`,
        });
      }
    } catch (error) {
      if (liveViewOption) {
        onStep({
          step: 0,
          tool: "liveView",
          note: `live view failed to start: ${error?.message || error}`,
        });
      }
    }
    return null;
  }

  async function postLiveChat({ text, kind, role = "agent" }: any = {}) {
    if (!withHandoff || !isCallable(browser.liveViewPostChat)) return;
    const body = String(text || "").trim();
    if (!body) return;
    try {
      if (!liveViewReady) await ensureAgentLiveView();
      if (!liveViewReady) return;
      await browser.liveViewPostChat({ role, text: body, kind });
    } catch {
      /* chat mirror must never break the agent loop */
    }
  }

  function normalizeGuidanceLines(value) {
    return (Array.isArray(value) ? value : [value])
      .map((item) => String(item || "").trim())
      .filter(Boolean);
  }

  async function collectLiveViewGuidance() {
    if (!withHandoff || !isCallable(browser.liveViewDrainChat)) return [];
    if (!liveViewReady) return [];
    try {
      const drained = await browser.liveViewDrainChat();
      const items = Array.isArray(drained?.messages) ? drained.messages : [];
      return normalizeGuidanceLines(items.map((item) => item?.text));
    } catch {
      /* drain is best-effort */
      return [];
    }
  }

  async function collectTerminalGuidance() {
    if (!drainSteering) return [];
    try {
      return normalizeGuidanceLines(await drainSteering());
    } catch {
      /* steering must never break the agent loop */
      return [];
    }
  }

  async function collectHumanGuidance() {
    const batches = [];
    const liveView = await collectLiveViewGuidance();
    if (liveView.length) batches.push({ source: "live view", lines: liveView });
    const terminal = await collectTerminalGuidance();
    if (terminal.length)
      batches.push({ source: "interactive terminal", lines: terminal });
    return batches;
  }

  function appendHumanGuidance(batches) {
    if (!batches.length) return false;
    const lines = batches.flatMap(({ source, lines: items }) =>
      items.map((line) => `- [${source}] ${line}`),
    );
    appendTranscriptMessage({
      role: "user",
      text:
        "The human sent steering while you were working. " +
        "Incorporate it and continue the task:\n\n" +
        lines.join("\n"),
    });
    return true;
  }

  function reportStep(event) {
    onStep(event);
    // Mirror progress into the live-view chat so watching feels alive.
    // ask/handoff post their own chat lines when the wait begins; liveView is
    // host-facing URL noise.
    if (event?.tool === "liveView" || event?.tool === "ask" || event?.tool === "handoff") return;
    const note = String(event?.note || "").trim();
    const label = event?.tool ? String(event.tool) : "step";
    const text = note || label;
    void postLiveChat({ text, kind: label });
  }

  const matchedSkills = taskSkillGuidance(task);
  const system = [
    harnessPreamble({ withAsk, withHandoff }),
    agentSystemPrompt(options.guardrails || {}),
    matchedSkills,
  ]
    .filter(Boolean)
    .join("\n\n");
  const tools = toolsForHarness({ withLogin, withAsk, withHandoff });
  // Seed from a prior transcript when continuing a session (the interactive
  // console passes the previous task's transcript), so a follow-up task can refer
  // back to earlier work; otherwise start fresh.
  const history = Array.isArray(options.history) ? options.history : [];
  const messages = [...history, { role: "user", text: task }];
  // The transcript only grows by appending complete JSON-safe messages. Track
  // its exact serialized size as those messages arrive instead of rebuilding
  // the entire string at every turn (quadratic total work on long runs).
  let transcriptChars = JSON.stringify(messages).length;
  function appendTranscriptMessage(message) {
    const separator = messages.length ? 1 : 0;
    messages.push(message);
    transcriptChars += separator + JSON.stringify(message).length;
  }

  let answer = "";
  let proof = null;
  let finished = false;
  let reason = "stopped";
  let steps = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  // The final turn's prompt size — the context the model was holding when the
  // task ended. Overwritten each turn that reports usage, so it keeps the last.
  let contextTokens = 0;
  let toolCallCount = 0;
  let durationMs = 0;
  // The current run of identical browser failures, and whether it has gone on
  // long enough to end the task.
  let repeated = { signature: "", count: 0 };
  let noProgress = false;

  const startedAt = Date.now();
  const deadline = startedAt + maxDurationMs;
  try {
    // Explicitly enabled live view starts before step 1, so the user can watch
    // the whole run (watch-only by default while the agent drives). Best
    // effort: a failed viewer must never stop the task itself.
    if (withHandoff && liveViewOption) {
      const view = await ensureAgentLiveView();
      if (view?.url && !view.alreadyRunning) {
        reportStep({ step: 0, tool: "liveView", note: `watch live: ${view.url}`, url: view.url });
        await postLiveChat({
          role: "system",
          kind: "system",
          text: "You can message the agent here — guidance is delivered between its turns. Use Take control or wait for a handoff to drive the browser.",
        });
      }
    }
    // No step cap: the loop runs until the model finishes or the wall-clock
    // budget expires.
    for (steps = 1; ; steps += 1) {
      // A stop that arrived between turns ends the run here, before spending
      // another model call. Mid-turn stops abort through `withinDeadline`.
      if (stopSignal?.aborted) {
        steps = Math.max(1, steps - 1);
        reason = "interrupted";
        break;
      }
      if (transcriptChars > maxTranscriptChars) {
        reason = "context_limit";
        break;
      }
      // Human guidance lands at turn boundaries (never mid-browser step).
      appendHumanGuidance(await collectHumanGuidance());
      // The two long silences in a run are the model turn and the tool batch
      // that follows it. Announce each so a live UI can say which one the
      // user is waiting on; step events only fire once a tool has news.
      onPhase({ phase: "reasoning", step: steps });
      let response;
      try {
        response = await completeWithRetry(
          model,
          { system, messages: await withLatestCaptchaVision(messages), tools },
          deadline,
          stopSignal,
        );
      } catch (error) {
        if (isControlSignal(error) || !isTransientModelError(error)) throw error;
        // A transient provider failure that survived the bounded retries:
        // return a partial result that preserves the transcript instead of
        // throwing the whole run away. Non-transient errors (bad request,
        // auth) still throw so configuration problems surface loudly.
        reason = "model_error";
        break;
      }
      const toolCalls = Array.isArray(response.toolCalls) ? response.toolCalls : [];
      if (response.usage) {
        // Provider input totals include cached reads. Keep the full last-turn
        // value for context, but report only the portion that was not read from
        // cache as the run's user-facing input cost.
        inputTokens += uncachedInputTokens(response.usage.inputTokens, response.usage.cacheReadTokens);
        outputTokens += response.usage.outputTokens || 0;
        cacheReadTokens += response.usage.cacheReadTokens || 0;
        cacheWriteTokens += response.usage.cacheWriteTokens || 0;
        contextTokens = response.usage.inputTokens || 0;
      }
      toolCallCount += toolCalls.length;
      appendTranscriptMessage({ role: "assistant", text: response.text || "", toolCalls });

      // No tool call: the model answered in prose. Treat that text as the
      // result unless steering arrived while the model was answering.
      if (!toolCalls.length) {
        if (appendHumanGuidance(await collectHumanGuidance())) continue;
        answer = String(response.text || "").trim();
        const stopReason = String(response.stopReason || "");
        if (TRUNCATED_STOP_REASONS.has(stopReason)) {
          // The provider cut the response at the output-token limit, so the
          // text is an unfinished fragment, not an answer. Keep it (and the
          // transcript) in the result, but do not report success.
          reason = "max_tokens";
          break;
        }
        if (REFUSAL_STOP_REASONS.has(stopReason)) {
          // The model declined the task; distinct from an ordinary answer.
          reason = "refusal";
          break;
        }
        reason = answer ? "answered" : "stopped";
        finished = true;
        break;
      }

      onPhase({ phase: "acting", step: steps, tools: toolCalls.map((call) => call.name) });
      const results = [];
      for (const call of toolCalls) {
        if (call.name === "done") {
          answer = String(call.input?.answer ?? "").trim();
          reason = "done";
          finished = true;
          results.push({ id: call.id, name: call.name, content: "Task marked complete." });
          continue;
        }
        if (finished) {
          // Ignore any tool calls the model batched after `done`.
          results.push({ id: call.id, name: call.name, content: "Ignored — task already finished." });
          continue;
        }
        if (call.name === "login") {
          reportStep({ step: steps, tool: "login", note: "filling credential" });
          try {
            const remainingSeconds = Math.max(0.001, (deadline - Date.now()) / 1000);
            if (remainingSeconds <= 0.001) throw AGENT_TIMEOUT;
            const result = await browser.fillCredential({
              ...normalizeCredentialToolOptions(call.input, { session }),
              timeout: remainingSeconds,
            });
            results.push({ id: call.id, name: call.name, content: observationFromResult(result) });
          } catch (error) {
            if (isControlSignal(error)) throw error;
            results.push({ id: call.id, name: call.name, content: `login error: ${error?.message || error}` });
          }
          continue;
        }
        if (call.name === "ask") {
          const question = String(call.input?.question ?? "").trim();
          const choices = Array.isArray(call.input?.options) ? call.input.options.map(String) : [];
          reportStep({ step: steps, tool: "ask", note: question });
          if (!askUser && !withHandoff) {
            results.push({ id: call.id, name: call.name, content: "No user is available to answer in this run." });
            continue;
          }
          try {
            const remainingSeconds = Math.max(5, Math.floor((deadline - Date.now()) / 1000));
            let reply = "";
            // A host-provided askUser is someone actually at a terminal, so
            // the question goes there. The live-view chat handles the rest:
            // exec-style runs where a viewer URL is the only human surface.
            // Preferring live view when both exist parked the question in a
            // chat nobody had open while the console sat on a silent prompt.
            const canLiveAsk =
              !askUser && withHandoff && isCallable(browser.waitForAsk);
            if (canLiveAsk) {
              const view = await withinDeadline(() => ensureAgentLiveView(), deadline, stopSignal);
              if (view?.url) {
                const outcome = await withinDeadline(
                  () =>
                    browser.waitForAsk({
                      session,
                      question,
                      options: choices,
                      timeout: remainingSeconds,
                    }),
                  deadline,
                  stopSignal,
                );
                if (!outcome?.ok) throw new Error(outcome?.error || "the ask failed");
                if (outcome.action === "answer")
                  reply = String(outcome.answer || "").trim();
              }
            }
            if (!reply && askUser) {
              reply = String((await withinDeadline(
                (signal) => askUser({ question, options: choices, signal }),
                deadline,
                stopSignal,
              )) ?? "").trim();
            }
            results.push({
              id: call.id,
              name: call.name,
              content: reply ? `User answered: ${reply}` : "User gave no answer; use your best judgment or report it blocked.",
            });
          } catch (error) {
            if (isControlSignal(error)) throw error;
            results.push({ id: call.id, name: call.name, content: `ask error: ${error?.message || error}` });
          }
          continue;
        }
        if (call.name === "live_view") {
          if (!withHandoff) {
            results.push({
              id: call.id,
              name: call.name,
              content: "Live view is not available in this run.",
            });
            continue;
          }
          const action = String(call.input?.action || "start").trim().toLowerCase() || "start";
          try {
            if (action === "stop") {
              if (isCallable(browser.stopLiveView)) await browser.stopLiveView();
              liveViewReady = false;
              agentStartedLiveView = false;
              results.push({
                id: call.id,
                name: call.name,
                content: "Live view stopped.",
              });
              continue;
            }
            if (action === "status") {
              const status =
                isCallable(browser.liveViewStatus)
                  ? await browser.liveViewStatus()
                  : null;
              const running = Boolean(status?.running || liveViewReady);
              liveViewReady = running;
              results.push({
                id: call.id,
                name: call.name,
                content: running
                  ? `Live view is running${status?.url ? `: ${status.url}` : ""}. Relay any URL to the user verbatim.`
                  : "Live view is not running. Call live_view with action \"start\" to open it.",
              });
              continue;
            }
            if (action !== "start") {
              results.push({
                id: call.id,
                name: call.name,
                content: `Unknown live_view action "${action}". Use start, status, or stop.`,
              });
              continue;
            }
            const view = await withinDeadline(() => ensureAgentLiveView(), deadline, stopSignal);
            if (!view?.ok || !view.url) {
              throw new Error(view?.error || "the live view failed to start");
            }
            reportStep({
              step: steps,
              tool: "liveView",
              note: view.alreadyRunning
                ? `live view already running: ${view.url}`
                : `watch live: ${view.url}`,
              url: view.url,
            });
            results.push({
              id: call.id,
              name: call.name,
              content:
                `Live view is open for the user. Relay this URL to them verbatim (it embeds the access token): ${view.url}. ` +
                "Keep working — they can watch and type guidance in the chat. Use handoff only if they need to drive the browser themselves.",
            });
          } catch (error) {
            if (isControlSignal(error)) throw error;
            results.push({
              id: call.id,
              name: call.name,
              content: `live_view error: ${error?.message || error}`,
            });
          }
          continue;
        }
        if (call.name === "handoff") {
          const handoffReason =
            String(call.input?.reason ?? "").trim() ||
            "The agent needs your hands in the browser.";
          const expectation = String(call.input?.expectation ?? "").trim();
          if (!withHandoff) {
            results.push({ id: call.id, name: call.name, content: "Handoff is not available in this run." });
            continue;
          }
          try {
            const view = await withinDeadline(() => ensureAgentLiveView(), deadline, stopSignal);
            if (!view?.ok || !view.url)
              throw new Error(view?.error || "the live view failed to start");
            const prompt = expectation ? `${handoffReason} — done when: ${expectation}` : handoffReason;
            reportStep({
              step: steps,
              tool: "handoff",
              note: `${handoffReason} — open ${view.url} and click Done when finished`,
              url: view.url,
              prompt,
            });
            // The viewer's Done/Cancel buttons are the single ack channel; the
            // remaining wall-clock budget bounds the wait on both sides.
            const remainingSeconds = Math.max(5, Math.floor((deadline - Date.now()) / 1000));
            const outcome = await withinDeadline(
              () => browser.waitForHandoff({ session, prompt, timeout: remainingSeconds }),
              deadline,
              stopSignal,
            );
            if (!outcome?.ok) throw new Error(outcome?.error || "the handoff failed");
            const humanNote = String(outcome.note || "").trim();
            const content =
              outcome.action === "done"
                ? `Human handoff finished (done).${humanNote ? ` Human note: ${humanNote}` : ""} The page state may have changed under their hands — re-observe with snapshot({diff:true}) before acting.`
                : outcome.action === "cancel"
                  ? `The user cancelled the handoff${humanNote ? ` with note: ${humanNote}` : ""}. Treat this step as blocked — do not retry the handoff; finish with what you have or report the blocker.`
                  : "The handoff timed out with no human response. Treat this step as blocked and report it in your answer.";
            results.push({ id: call.id, name: call.name, content });
          } catch (error) {
            if (isControlSignal(error)) throw error;
            results.push({ id: call.id, name: call.name, content: `handoff error: ${error?.message || error}` });
          }
          continue;
        }
        if (call.name === "browser") {
          const note = String(call.input?.note || "");
          reportStep({ step: steps, tool: "browser", note });
          const remainingSeconds = Math.max(0.001, (deadline - Date.now()) / 1000);
          if (remainingSeconds <= 0.001) throw AGENT_TIMEOUT;
          // BetterWright's own timeout path terminates and restarts the worker,
          // so browser mutations cannot continue after this await returns.
          // A stop signal abandons the await rather than the step: the worker
          // finishes (or times out) the snippet it already started, so no page
          // mutation is left half-applied, and the session's queue keeps the
          // next call behind it.
          const result = await withinDeadline(
            () =>
              browser.run(String(call.input?.code || ""), {
                session,
                note: note || undefined,
                timeout: remainingSeconds,
              }),
            deadline,
            stopSignal,
          );
          for (const shot of result.artifacts || [])
            if (shot.kind === "proof" && shot.path) proof = shot.path;
          const signature = failureSignature(result);
          repeated =
            signature && signature === repeated.signature
              ? { signature, count: repeated.count + 1 }
              : { signature, count: signature ? 1 : 0 };
          if (repeated.count >= REPEATED_FAILURE_WARNING) {
            // Carried in the observation's own warnings, so the model reads it
            // in the same place it reads every other harness advisory.
            result.warnings = [
              ...(result.warnings || []),
              repeatedFailureAdvice(repeated.count),
            ];
            if (repeated.count >= REPEATED_FAILURE_LIMIT) noProgress = true;
          }
          // Returning { finalAnswer } from the code completes the task in this
          // same turn — the single-call shape that saves a full model round-trip.
          const final = finalAnswerFromResult(result);
          if (final != null) {
            answer = final;
            reason = "done";
            finished = true;
          }
          results.push(browserToolObservation(call.id, result));
          continue;
        }
        results.push({ id: call.id, name: call.name, content: `Unknown tool: ${call.name}` });
      }
      const toolMessage = { role: "tool", results };
      const toolMessageChars = JSON.stringify(toolMessage).length;
      appendTranscriptMessage(toolMessage);
      // A terminal or live-view message can arrive during model inference or a
      // long browser call. Apply it before accepting a completion from that
      // turn, so steering never becomes a stray follow-up task.
      if (appendHumanGuidance(await collectHumanGuidance())) {
        for (const result of results) {
          if (result.name === "done")
            result.content =
              "Completion deferred because new human steering arrived.";
        }
        finished = false;
        reason = "stopped";
        answer = "";
        // New instructions are a new approach: let the model try again rather
        // than ending a run the human just redirected.
        repeated = { signature: "", count: 0 };
        noProgress = false;
      }
      // Steering can rewrite a batched `done` result after the message was
      // appended. Account for that tiny mutation so the next cap check remains
      // byte-for-byte equivalent to JSON.stringify(messages).length.
      transcriptChars += JSON.stringify(toolMessage).length - toolMessageChars;
      if (finished) break;
      if (noProgress) {
        reason = "no_progress";
        break;
      }
    }
    if (finished && answer) {
      await postLiveChat({ text: answer, kind: "done" });
    }
  } catch (error) {
    if (error === AGENT_TIMEOUT) reason = "timeout";
    else if (error === AGENT_INTERRUPT) reason = "interrupted";
    else throw error;
  } finally {
    // A run cut short mid-turn (timeout, interrupt) leaves the model's tool
    // calls unanswered. Every provider rejects that shape on the next request,
    // so close the turn before the transcript is handed back for persistence.
    sealTranscript(messages, reason);
    // Measure task wall-clock before tearing down an owned browser, so the
    // reported time is the work, not the teardown.
    durationMs = Date.now() - startedAt;
    // Stop only a viewer this run started; a live view the host was already
    // running (e.g. `betterwright view`) is not ours to tear down.
    if (agentStartedLiveView && !ownsBrowser) {
      try {
        await browser.stopLiveView();
      } catch {
        /* viewer teardown is best effort */
      }
    }
    if (ownsBrowser) await browser.close();
  }

  return {
    ok: finished && reason !== "stopped",
    answer,
    steps,
    reason,
    // How many tool calls the model issued (browser/login/done) — can exceed
    // `steps` when a turn batches several — and the token usage the adapters
    // reported. `inputTokens` excludes the cached-read portion so it reflects
    // fresh input work; `context` below retains the full final prompt size.
    toolCalls: toolCallCount,
    usage: {
      inputTokens,
      outputTokens,
      // Cached-input counts summed across turns, and `context` = the full prompt
      // size at the end of the task (last turn's provider input total).
      cacheReadTokens,
      cacheWriteTokens,
      context: contextTokens,
    },
    // Task wall-clock in milliseconds (excludes owned-browser teardown).
    durationMs,
    transcript: messages,
    proof,
  };
}

// Infer the native source from an actual model id. Source names alone are not
// model shortcuts; `codex/`, `claude/`, and `grok/` only pin a collision.
function adapterForModelId(id) {
  if (id === "claude" || id === "codex" || id === "grok") return null;
  if (id.startsWith("claude")) return "claude";
  if (id.startsWith("grok")) return "grok";
  if (/^(gpt|o[0-9]|chatgpt|codex)/.test(id)) return "codex";
  return null;
}

const NATIVE_MODEL_SOURCES = Object.freeze({
  claude: claudeModel,
  codex: codexModel,
  grok: grokModel,
});
const QUALIFIED_MODEL_SOURCES = new Set([
  ...Object.keys(NATIVE_MODEL_SOURCES),
  ...Object.keys(MODEL_ENDPOINT_PRESETS),
]);

// Canonical endpoint-source parsing. Exported so the CLI's `models` command
// accepts exactly the same names (and emits exactly the same error) as
// `--model source/id` parsing — the two had drifted when the CLI kept a copy.
export function endpointSourceName(value) {
  const name = String(value || "custom")
    .trim()
    .toLowerCase()
    .replace(/[-_ ]/g, "");
  if (name === "openrouter") return "openrouter";
  if (name === "ollama") return "ollama";
  if (name === "vllm") return "vllm";
  if (name === "custom") return "custom";
  throw new Error(
    `Unknown model source "${value}". Use openrouter, ollama, vllm, or custom.`,
  );
}

function qualifiedModelSelector(value) {
  const selector = String(value || "").trim();
  const slash = selector.indexOf("/");
  if (slash <= 0 || slash === selector.length - 1) return null;
  const source = selector.slice(0, slash).toLowerCase();
  if (!QUALIFIED_MODEL_SOURCES.has(source)) return null;
  return { source, model: selector.slice(slash + 1) };
}

function modelIdAliasValues(value) {
  const id = String(value || "").trim();
  const aliases = new Set([id]);
  const firstSlash = id.indexOf("/");
  const lastSlash = id.lastIndexOf("/");
  if (firstSlash !== -1) aliases.add(id.slice(firstSlash + 1));
  if (lastSlash !== -1) aliases.add(id.slice(lastSlash + 1));
  return [...aliases].filter(Boolean);
}

function modelIdAliases(value) {
  return new Set(modelIdAliasValues(value).map((alias) => alias.toLowerCase()));
}

// The sources worth probing without an explicit selection: the local runtimes
// always, OpenRouter only when a key is configured (its probe is a remote
// call). Exported so CLI model listing discovers from the same set as bare-id
// resolution.
export function endpointDiscoverySources() {
  const sources = ["ollama", "vllm"];
  if (process.env.OPENROUTER_API_KEY) sources.push("openrouter");
  return sources;
}

// Per-source quick-probe budget: OpenRouter is a remote API and needs more
// headroom than the loopback ollama/vllm probes. Exported so the CLI's quick
// listing uses the same budgets as bare-id discovery.
export function discoveryTimeoutMs(source) {
  return source === "openrouter" ? 3_000 : 750;
}

function endpointURL(value, source) {
  let parsed;
  try {
    parsed = new URL(String(value || ""));
  } catch {
    throw new Error(
      `The ${source} source needs a valid --base-url such as https://host.example/v1.`,
    );
  }
  if (!["http:", "https:"].includes(parsed.protocol))
    throw new Error("Model base URLs must use http:// or https://.");
  if (parsed.username || parsed.password)
    throw new Error("Do not put credentials in a model base URL; use --api-key-env instead.");
  if (parsed.search || parsed.hash)
    throw new Error("Model base URLs cannot contain query strings or fragments.");
  return parsed.href.replace(/\/+$/, "");
}

function isLoopbackEndpoint(value) {
  const host = new URL(value).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    host === "localhost" ||
    host === "::1" ||
    host === "0:0:0:0:0:0:0:1" ||
    /^127(?:\.\d{1,3}){3}$/.test(host)
  );
}

function endpointConfig(
  options: any = {},
  { requireModel = true, requireApiKey = true }: any = {},
) {
  const source = endpointSourceName(options.source || "custom");
  const preset = MODEL_ENDPOINT_PRESETS[source];
  const configuredBase =
    options.baseURL ||
    process.env[preset.baseURLEnv] ||
    (source === "custom"
      ? process.env.BETTERWRIGHT_MODEL_BASE_URL
      : null) ||
    preset.baseURL;
  if (!configuredBase)
    throw new Error(
      "The custom endpoint needs --base-url <url> (or BETTERWRIGHT_MODEL_BASE_URL).",
    );
  const baseURL = endpointURL(configuredBase, source);

  const explicitApiKeyEnv = String(options.apiKeyEnv || "").trim();
  if (
    explicitApiKeyEnv &&
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(explicitApiKeyEnv)
  ) {
    throw new Error(
      `Invalid --api-key-env "${explicitApiKeyEnv}". Use an environment variable name such as MODEL_API_KEY.`,
    );
  }
  const apiKeyEnv = explicitApiKeyEnv || preset.apiKeyEnv;
  const apiKey =
    options.apiKey !== undefined && options.apiKey !== null
      ? String(options.apiKey)
      : String(process.env[apiKeyEnv] || "");
  if (explicitApiKeyEnv && !apiKey)
    throw new Error(
      `The environment variable ${explicitApiKeyEnv} is empty. Set it or remove --api-key-env.`,
    );
  if (requireApiKey && preset.requiresApiKey && !apiKey)
    throw new Error(
      `OpenRouter needs an API key. Set ${preset.apiKeyEnv} or pass --api-key-env <name>.`,
    );
  if (
    apiKey &&
    new URL(baseURL).protocol === "http:" &&
    !isLoopbackEndpoint(baseURL) &&
    !options.allowInsecureEndpoint
  ) {
    throw new Error(
      `Refusing to send ${apiKeyEnv || "the model API key"} over plain HTTP to ${baseURL}. ` +
        "Use HTTPS or pass --allow-insecure-model-endpoint.",
    );
  }

  const model = String(options.model || "").trim();
  if (requireModel && !model) {
    const hint =
      source === "ollama"
        ? " Run `betterwright models ollama` or `ollama list`."
        : ` Run \`betterwright models ${source === "custom" ? "--base-url <url>" : source}\`.`;
    throw new Error(`The ${source} source needs --model <id>.${hint}`);
  }
  const protocol = String(
    options.protocol || process.env.BETTERWRIGHT_MODEL_PROTOCOL || "chat",
  )
    .trim()
    .toLowerCase();
  if (!["chat", "responses"].includes(protocol))
    throw new Error('Model protocol must be "chat" or "responses".');

  const headers: Record<string, string> = {};
  if (source === "openrouter") {
    headers["HTTP-Referer"] = "https://github.com/BetterWright/betterwright";
    headers["X-OpenRouter-Title"] = "BetterWright";
  }
  Object.assign(headers, options.headers);
  return { source, preset, baseURL, apiKey, apiKeyEnv, model, protocol, headers };
}

/**
 * A preset-backed OpenAI-compatible endpoint model. Presets only configure
 * endpoint/auth defaults; model ids remain opaque.
 * @param {object} options source, model, baseURL, apiKey/apiKeyEnv, protocol
 */
export function endpointModel(options: any = {}) {
  const config = endpointConfig(options);
  const common = {
    ...options,
    name: config.source,
    baseURL: config.baseURL,
    apiKey: config.apiKey,
    model: config.model,
    headers: config.headers,
    // Generic providers converge on max_tokens. Keep optional OpenAI-only
    // controls out of the baseline request so partial implementations work.
    maxTokensField: "max_tokens",
    parallelToolCalls: null,
  };
  if (config.protocol === "responses") {
    return responsesModel({
      ...common,
      includeMaxOutputTokens: true,
      stream: false,
      store: null,
    });
  }
  return openaiModel(common);
}

/**
 * List models from a preset or custom endpoint's OpenAI-compatible /models
 * route. OpenRouter's list is public; task execution still requires its key.
 */
export async function listEndpointModels(options: any = {}) {
  const config = endpointConfig(options, { requireModel: false, requireApiKey: false });
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (!isFetchImplementation(fetchImpl))
    throw new Error("No fetch implementation available (need Node 22+ or a fetchImpl).");
  const requestHeaders: Record<string, string> = {};
  if (config.apiKey) requestHeaders.authorization = `Bearer ${config.apiKey}`;
  Object.assign(requestHeaders, config.headers);
  const response = await fetchImpl(`${config.baseURL}/models`, {
    headers: requestHeaders,
    redirect: "error",
    signal: options.signal || AbortSignal.timeout(10_000),
  });
  const raw = await response.text().catch(() => "");
  if (!response.ok) {
    throw new Error(
      `${config.source} model listing failed (${response.status}): ${raw.slice(0, 500)}`,
    );
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`${config.source} returned a non-JSON response from /models.`);
  }
  const entries = Array.isArray(data?.data)
    ? data.data
    : Array.isArray(data?.models)
      ? data.models
      : [];
  const models = entries
    .map((entry) =>
      isString(entry)
        ? entry
        : untrustedField(entry, "id") ||
          untrustedField(entry, "name") ||
          untrustedField(entry, "model"),
    )
    .filter(Boolean)
    .map(String);
  return {
    source: config.source,
    baseURL: config.baseURL,
    models: [...new Set(models)],
  };
}

/**
 * Choose the shortest unambiguous user selector for each discovered endpoint
 * model. A source prefix appears only when every bare form collides.
 */
export function modelSelectionChoices(entries = []) {
  const models = [
    ...new Map(
      entries.map((entry) => [
        `${entry.source}\0${entry.model}`,
        { source: String(entry.source), model: String(entry.model) },
      ]),
    ).values(),
  ];
  return models.map((entry) => {
    const aliases = modelIdAliasValues(entry.model).sort(
      (left, right) => left.length - right.length,
    );
    const selector = aliases.find((alias) => {
      const lowered = alias.toLowerCase();
      if (qualifiedModelSelector(alias)) return false;
      const nativeSource = adapterForModelId(lowered);
      if (nativeSource && nativeSource !== entry.source) return false;
      return (
        models.filter((candidate) =>
          modelIdAliases(candidate.model).has(lowered),
        ).length === 1
      );
    });
    const qualified = `${entry.source}/${entry.model}`;
    return {
      ...entry,
      selector: selector || qualified,
      qualified,
      ambiguous: !selector,
    };
  });
}

export function nativeModelCatalog() {
  const stored = readCodexConfig();
  return [
    {
      source: "claude",
      model:
        process.env.BETTERWRIGHT_CLAUDE_MODEL || "claude-opus-4-8",
    },
    {
      source: "codex",
      model:
        process.env.BETTERWRIGHT_CODEX_MODEL ||
        stored.model ||
        "gpt-5.6-sol",
    },
    {
      source: "grok",
      model:
        process.env.BETTERWRIGHT_GROK_MODEL ||
        process.env.XAI_MODEL ||
        "grok-4.3",
    },
  ];
}

async function discoverModelCandidates(model, options: any = {}) {
  const wanted = String(model || "").trim().toLowerCase();
  const discovered = await Promise.all(
    endpointDiscoverySources().map(async (source) => {
      try {
        const timeoutMs =
          Number(options.discoveryTimeoutMs) || discoveryTimeoutMs(source);
        const result = await listEndpointModels({
          source,
          fetchImpl: options.fetchImpl,
          signal: AbortSignal.timeout(timeoutMs),
        });
        return result.models
          .filter((id) => modelIdAliases(id).has(wanted))
          .map((id) => ({ source, model: id }));
      } catch {
        return [];
      }
    }),
  );
  return discovered.flat();
}

/**
 * Resolve the model-first user selector. Explicit source/model ids resolve
 * immediately. Bare ids are matched across running/configured endpoint
 * catalogs and only auto-selected when exactly one source exposes them.
 */
export async function resolveModelSelection(model, modelOptions: any = {}) {
  if (isAgentModel(model)) return model;
  const selector = String(model || "").trim();
  const qualified = qualifiedModelSelector(selector);
  if (modelOptions.baseURL || qualified) {
    return resolveModel(selector, modelOptions);
  }

  const candidates = await discoverModelCandidates(selector, modelOptions);
  const nativeSource = adapterForModelId(selector.toLowerCase());
  if (nativeSource) {
    candidates.unshift({ source: nativeSource, model: selector });
  }
  const unique = [
    ...new Map(
      candidates.map((candidate) => [
        `${candidate.source}\0${candidate.model}`,
        candidate,
      ]),
    ).values(),
  ];
  if (unique.length === 1) {
    const [match] = unique;
    if (NATIVE_MODEL_SOURCES[match.source]) {
      return NATIVE_MODEL_SOURCES[match.source]({
        ...modelOptions,
        model: modelOptions.model || match.model,
      });
    }
    return endpointModel({
      ...modelOptions,
      source: match.source,
      model: modelOptions.model || match.model,
    });
  }
  if (unique.length > 1) {
    const choices = modelSelectionChoices(unique)
      .map((choice) => choice.selector)
      .join(", ");
    throw new Error(
      `Model "${selector}" is available from multiple sources: ${choices}. ` +
        "Choose one with --model <source/model-id>.",
    );
  }
  throw new Error(
    `No available model source exposes "${selector}". Run \`betterwright models\`, ` +
      "or use --model openrouter/<id>, ollama/<id>, vllm/<id>, or --base-url <url>.",
  );
}

/**
 * Resolve a model name (or pass-through object) to a model adapter.
 * @param {string|object} model A model id, a source-qualified model id, or an
 *   object with an async `complete` method to use directly.
 * @param {object} [modelOptions]
 * @returns {{name: string, complete: Function}}
 */
export function resolveModel(model, modelOptions: any = {}) {
  if (isAgentModel(model)) return model;
  const selector = String(model || "");
  const name = selector.toLowerCase();
  const qualified = qualifiedModelSelector(selector);
  if (modelOptions.baseURL)
    return endpointModel({
      ...modelOptions,
      source: "custom",
      model: modelOptions.model || selector,
    });
  if (qualified) {
    if (NATIVE_MODEL_SOURCES[qualified.source]) {
      return NATIVE_MODEL_SOURCES[qualified.source]({
        ...modelOptions,
        model: modelOptions.model || qualified.model,
      });
    }
    return endpointModel({
      ...modelOptions,
      source: qualified.source,
      model: modelOptions.model || qualified.model,
    });
  }
  // A bare native model id routes by its family prefix.
  const inferred = adapterForModelId(name);
  if (inferred) {
    const options = { ...modelOptions, model: modelOptions.model || selector };
    return NATIVE_MODEL_SOURCES[inferred](options);
  }
  throw new Error(
    `Unknown model "${model}". Use a model id (for example "gpt-5.6-sol") or ` +
      `a source-qualified id (for example "ollama/qwen3:8b").`,
  );
}

// --- Claude (Anthropic SDK) ------------------------------------------------

function anthropicMessages(messages) {
  const mapped = messages.map((m) => {
    if (m.role === "user") return { role: "user", content: [{ type: "text", text: m.text }] };
    if (m.role === "tool")
      return {
        role: "user",
        content: m.results.map((r) => ({
          type: "tool_result",
          tool_use_id: r.id,
          content: anthropicToolResultContent(r),
        })),
      };
    const content = [];
    if (m.text) content.push({ type: "text", text: m.text });
    for (const tc of m.toolCalls || [])
      content.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input || {} });
    return { role: "assistant", content };
  });
  // The Messages API requires roles to alternate. Tool results are user-role, so
  // continuing a session (a carried transcript ending in a tool result, then a
  // new user task) yields two user turns in a row — coalesce adjacent same-role
  // messages into one so the request stays valid.
  const merged = [];
  for (const msg of mapped) {
    const last = merged[merged.length - 1];
    if (last && last.role === msg.role) last.content.push(...msg.content);
    else merged.push({ role: msg.role, content: [...msg.content] });
  }
  return merged;
}

function anthropicToolResultContent(result) {
  if (!result?.images?.length) return result.content;
  return [
    { type: "text", text: String(result.content || "") },
    ...result.images.map((image) => ({
      type: "image",
      source: {
        type: "base64",
        media_type: image.mimeType,
        data: image.data,
      },
    })),
  ];
}

function parseAnthropicResponse(message) {
  let text = "";
  const toolCalls = [];
  for (const block of message.content || []) {
    if (block.type === "text") text += block.text;
    else if (block.type === "tool_use")
      toolCalls.push({ id: block.id, name: block.name, input: block.input || {} });
  }
  return { text, toolCalls, stopReason: message.stop_reason, usage: anthropicUsage(message.usage) };
}

/**
 * Claude adapter over the official Anthropic SDK (an optional peer dependency —
 * `npm install @anthropic-ai/sdk`). Auth resolves from ANTHROPIC_API_KEY, or an
 * explicit `apiKey`, the SDK's usual way.
 * @param {object} [options]
 * @param {string} [options.model="claude-opus-4-8"] override with any current id
 *   (e.g. "claude-fable-5", "claude-sonnet-5")
 * @param {string} [options.apiKey]
 * @param {number} [options.maxTokens=4096]
 * @param {"low"|"medium"|"high"|"xhigh"|"max"} [options.effort="low"]
 * @param {object} [options.client] inject a preconstructed SDK client (tests)
 */
export function claudeModel(options: any = {}) {
  const modelId = options.model || process.env.BETTERWRIGHT_CLAUDE_MODEL || "claude-opus-4-8";
  const maxTokens = Number(options.maxTokens) || DEFAULT_MAX_TOKENS;
  const effort = options.effort || "low";
  let clientPromise = options.client ? Promise.resolve(options.client) : null;

  async function client() {
    if (!clientPromise)
      clientPromise = (async () => {
        const { default: Anthropic } = await importOptionalPeer(
          "@anthropic-ai/sdk",
          "The Claude model",
        );
        return new Anthropic(options.apiKey ? { apiKey: options.apiKey } : {});
      })();
    return clientPromise;
  }

  return {
    name: "claude",
    modelId,
    async complete({ system, messages, tools, signal }) {
      const anthropic = await client();
      // Anthropic prompt caching is opt-in per request, so mark the two standard
      // breakpoints: after the static prefix (tools + system) and on the final
      // message, so each turn reads the whole prior conversation from cache and
      // writes only the new tail. Prompts under the model's cacheable minimum
      // just ignore the marks.
      const mapped = anthropicMessages(messages);
      const lastBlock = mapped.at(-1)?.content.at(-1);
      if (lastBlock) lastBlock.cache_control = { type: "ephemeral" };
      const message = await anthropic.messages.create(
        {
          model: modelId,
          max_tokens: maxTokens,
          system: system
            ? [{ type: "text", text: system, cache_control: { type: "ephemeral" } }]
            : undefined,
          output_config: { effort },
          tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
          messages: mapped,
        },
        { signal },
      );
      return parseAnthropicResponse(message);
    },
  };
}

// --- OpenAI-compatible (codex, grok) --------------------------------------

function openaiMessages(system, messages) {
  const out: any[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.text });
    } else if (m.role === "tool") {
      for (const r of m.results)
        out.push({
          role: "tool",
          tool_call_id: r.id,
          content: openaiToolResultContent(r),
        });
    } else {
      const turn: any = { role: "assistant", content: m.text || null };
      if (m.toolCalls?.length)
        turn.tool_calls = m.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: JSON.stringify(tc.input || {}) },
        }));
      out.push(turn);
    }
  }
  return out;
}

function openaiToolResultContent(result) {
  if (!result?.images?.length) return result.content;
  return [
    { type: "text", text: String(result.content || "") },
    ...result.images.map((image) => ({
      type: "image_url",
      image_url: { url: `data:${image.mimeType};base64,${image.data}` },
    })),
  ];
}

function openaiText(content) {
  if (isString(content)) return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (isString(part)) return part;
      const text = untrustedField(part, "text");
      if (isString(text)) return text;
      const inner = untrustedField(part, "content");
      return isString(inner) ? inner : "";
    })
    .join("");
}

function openaiToolInput(value) {
  if (isRecord(value)) return value;
  if (!value) return {};
  try {
    return JSON.parse(String(value));
  } catch {
    return { _raw: value };
  }
}

function parseOpenaiResponse(data) {
  const choice = data?.choices?.[0] || {};
  const msg = choice.message || {};
  const toolCalls = [];
  let synthetic = 0;
  for (const tc of msg.tool_calls || []) {
    // Some OpenAI-compatible servers omit ids; synthesize a stable one so the
    // assistant turn and its tool result line up on the next request.
    synthetic += 1;
    toolCalls.push({
      id: tc.id || `call_${synthetic}`,
      name: tc.function?.name,
      input: openaiToolInput(tc.function?.arguments),
    });
  }
  if (!toolCalls.length && msg.function_call) {
    synthetic += 1;
    toolCalls.push({
      id: `call_${synthetic}`,
      name: msg.function_call.name,
      input: openaiToolInput(msg.function_call.arguments),
    });
  }
  return {
    text: openaiText(msg.content),
    toolCalls,
    stopReason: choice.finish_reason,
    usage: openaiUsage(data?.usage),
  };
}

/**
 * A generic OpenAI-compatible chat-completions adapter over `fetch` — no SDK
 * dependency. Both the codex and grok adapters build on it; you can also use it
 * directly against any OpenAI-compatible endpoint.
 * @param {object} options
 * @param {string} options.baseURL e.g. "https://api.openai.com/v1"
 * @param {string} options.model model id the endpoint serves
 * @param {string} [options.apiKey] bearer token
 * @param {object} [options.headers] extra request headers
 * @param {number} [options.maxTokens=4096]
 * @param {string} [options.effort] passed as reasoning_effort when set
 * @param {string} [options.name="openai"] adapter name
 * @param {typeof fetch} [options.fetchImpl] inject a fetch (tests)
 */
export function openaiModel(options: any = {}) {
  const baseURL = String(options.baseURL || "https://api.openai.com/v1").replace(/\/+$/, "");
  const modelId = options.model;
  const maxTokens = Number(options.maxTokens) || DEFAULT_MAX_TOKENS;
  const maxTokensField = options.maxTokensField || "max_completion_tokens";
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (!modelId) throw new Error(`The ${options.name || "openai"} model needs a model id.`);
  if (!isFetchImplementation(fetchImpl))
    throw new Error("No fetch implementation available (need Node 22+ or a fetchImpl).");

  return {
    name: options.name || "openai",
    modelId,
    async complete({ system, messages, tools, signal }) {
      // A dynamic auth provider (OAuth) refreshes the token per request; a
      // static apiKey is the simple case.
      const auth: ResolvedAuth = isAuthProvider(options.getAuth) ? await options.getAuth() : {};
      const apiKey = auth.apiKey ?? options.apiKey;
      const body: any = {
        model: modelId,
        [maxTokensField]: maxTokens,
        messages: openaiMessages(system, messages),
        tools: tools.map((t) => ({
          type: "function",
          function: { name: t.name, description: t.description, parameters: t.parameters },
        })),
        tool_choice: "auto",
      };
      if (isBoolean(options.parallelToolCalls))
        body.parallel_tool_calls = options.parallelToolCalls;
      else if (options.parallelToolCalls === undefined) body.parallel_tool_calls = true;
      if (options.effort) body.reasoning_effort = options.effort;
      Object.assign(body, options.bodyExtra || {});
      const requestHeaders: Record<string, string> = {};
      requestHeaders["content-type"] = "application/json";
      if (apiKey) requestHeaders.authorization = `Bearer ${apiKey}`;
      Object.assign(requestHeaders, options.headers, auth.headers);
      const response = await fetchImpl(`${baseURL}/chat/completions`, {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify(body),
        signal,
        redirect: "error",
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`${options.name || "openai"} request failed (${response.status}): ${detail.slice(0, 500)}`);
      }
      let data;
      try {
        data = await response.json();
      } catch {
        throw new Error(`${options.name || "openai"} returned a non-JSON chat response.`);
      }
      return parseOpenaiResponse(data);
    },
  };
}

function responsesInput(messages) {
  const input = [];
  for (const message of messages) {
    if (message.role === "user") {
      input.push({ role: "user", content: message.text });
      continue;
    }
    if (message.role === "assistant") {
      if (message.text) input.push({ role: "assistant", content: message.text });
      for (const call of message.toolCalls || []) {
        input.push({
          type: "function_call",
          call_id: call.id,
          name: call.name,
          arguments: JSON.stringify(call.input || {}),
        });
      }
      continue;
    }
    if (message.role === "tool") {
      for (const result of message.results) {
        input.push({
          type: "function_call_output",
          call_id: result.id,
          output: result.content,
        });
        if (result.images?.length) {
          input.push({
            role: "user",
            content: result.images.map((image) => ({
              type: "input_image",
              image_url: `data:${image.mimeType};base64,${image.data}`,
            })),
          });
        }
      }
    }
  }
  return input;
}

// A function_call's `arguments` field is a JSON-encoded string; a server that
// sends malformed JSON still surfaces its payload under `_raw` rather than
// losing the call.
function responsesToolInput(rawArguments) {
  if (!rawArguments) return {};
  try {
    return JSON.parse(rawArguments);
  } catch {
    return { _raw: rawArguments };
  }
}

function parseResponsesOutput(output = []) {
  const text = [];
  const toolCalls = [];
  let synthetic = 0;
  for (const item of output) {
    if (item.type === "message") {
      for (const part of item.content || []) {
        if ((part.type === "output_text" || part.type === "text") && part.text) text.push(part.text);
      }
    } else if (item.type === "function_call") {
      const input = responsesToolInput(item.arguments);
      synthetic += 1;
      toolCalls.push({ id: item.call_id || item.id || `call_${synthetic}`, name: item.name, input });
    }
  }
  return { text: text.join(""), toolCalls };
}

function parseResponsesStream(raw) {
  let text = "";
  let completed;
  const toolCalls = [];
  const seenCalls = new Set();
  let synthetic = 0;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let event;
    try {
      event = JSON.parse(payload);
    } catch {
      continue;
    }
    if (event.type === "response.output_text.delta") text += event.delta || "";
    if (event.type === "response.output_item.done" && event.item?.type === "function_call") {
      const item = event.item;
      const input = responsesToolInput(item.arguments);
      synthetic += 1;
      const id = item.call_id || item.id || `call_${synthetic}`;
      if (!seenCalls.has(id)) {
        seenCalls.add(id);
        toolCalls.push({ id, name: item.name, input });
      }
    }
    if (event.type === "response.completed") completed = event.response;
    if (event.type === "response.failed" || event.type === "error") {
      const detail = event.response?.error?.message || event.error?.message || event.message || JSON.stringify(event);
      throw new Error(`Responses request failed: ${detail}`);
    }
  }
  const fallback = parseResponsesOutput(completed?.output);
  return {
    text: text || fallback.text,
    toolCalls: toolCalls.length ? toolCalls : fallback.toolCalls,
    stopReason: completed?.status || (toolCalls.length ? "tool_calls" : "completed"),
    usage: openaiUsage(completed?.usage),
  };
}

function responsesModel(options: any = {}) {
  const baseURL = String(options.baseURL || "https://api.openai.com/v1").replace(/\/+$/, "");
  const modelId = options.model;
  const maxTokens = Number(options.maxTokens) || DEFAULT_MAX_TOKENS;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (!modelId) throw new Error(`The ${options.name || "responses"} model needs a model id.`);
  if (!isFetchImplementation(fetchImpl))
    throw new Error("No fetch implementation available (need Node 22+ or a fetchImpl).");

  return {
    name: options.name || "responses",
    modelId,
    async complete({ system, messages, tools, signal }) {
      // A dynamic auth provider (OAuth) refreshes the token per request; a
      // static apiKey is the simple case.
      const auth: ResolvedAuth = isAuthProvider(options.getAuth) ? await options.getAuth() : {};
      const apiKey = auth.apiKey ?? options.apiKey;
      // Tri-state request fields: an explicit boolean is sent as-is, undefined
      // selects the adapter default, and null omits the field entirely (for
      // partial server implementations). bodyExtra overrides everything last.
      const body: Record<string, UntrustedValue> = {};
      body.model = modelId;
      body.instructions = system;
      body.input = responsesInput(messages);
      if (options.includeMaxOutputTokens) body.max_output_tokens = maxTokens;
      body.tools = tools.map((tool) => ({
        type: "function",
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }));
      body.tool_choice = "auto";
      if (isBoolean(options.parallelToolCalls)) body.parallel_tool_calls = options.parallelToolCalls;
      else if (options.parallelToolCalls === undefined) body.parallel_tool_calls = true;
      if (isBoolean(options.store)) body.store = options.store;
      else if (options.store === undefined) body.store = false;
      body.stream = options.stream === undefined ? true : Boolean(options.stream);
      if (options.effort) body.reasoning = { effort: options.effort };
      Object.assign(body, options.bodyExtra);
      const requestHeaders: Record<string, string> = {};
      requestHeaders["content-type"] = "application/json";
      requestHeaders.accept =
        options.stream === false ? "application/json" : "text/event-stream";
      if (apiKey) requestHeaders.authorization = `Bearer ${apiKey}`;
      Object.assign(requestHeaders, options.headers, auth.headers);
      const response = await fetchImpl(`${baseURL}${options.responsesPath || "/responses"}`, {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify(body),
        signal,
        redirect: "error",
      });
      const raw = await response.text().catch(() => "");
      if (!response.ok) {
        throw new Error(`${options.name || "responses"} request failed (${response.status}): ${raw.slice(0, 500)}`);
      }
      if (/^(?:event|data):/m.test(raw)) return parseResponsesStream(raw);
      const data = JSON.parse(raw);
      const parsed = parseResponsesOutput(data.output);
      return { ...parsed, stopReason: data.status || "completed", usage: openaiUsage(data.usage) };
    },
  };
}

// Read codex's stored OAuth credentials (~/.codex/auth.json) and configured
// model (~/.codex/config.toml). Best-effort — every field is overridable.
interface StoredCodexConfig {
  apiKey?: string;
  model?: string;
}

function readCodexConfig() {
  const dir = codexHome();
  const out: StoredCodexConfig = {};
  try {
    const auth = JSON.parse(fs.readFileSync(path.join(dir, "auth.json"), "utf8"));
    if (auth.OPENAI_API_KEY) out.apiKey = auth.OPENAI_API_KEY;
  } catch {
    // no stored codex auth
  }
  try {
    const toml = fs.readFileSync(path.join(dir, "config.toml"), "utf8");
    const match = toml.match(/^\s*model\s*=\s*"([^"]+)"/m);
    if (match) out.model = match[1];
  } catch {
    // no codex config
  }
  return out;
}

// Per-request auth for the ChatGPT backend: a fresh access token (refreshed if
// expired) plus the account header codex requires.
function codexOAuthAuth(sessionId) {
  return async () => {
    const { accessToken, accountId } = await codexAccessToken();
    // Headers match the codex CLI's ChatGPT-backend client (bearer_auth_provider
    // + default_client): originator identifies the caller; session_id ties a
    // task's turns together for prompt caching. OpenAI-Beta is not required on
    // the plain SSE path.
    const headers = {
      authorization: `Bearer ${accessToken}`,
      originator: "codex_cli_rs",
      session_id: sessionId,
    };
    if (accountId) headers["ChatGPT-Account-ID"] = accountId;
    return { headers };
  };
}

/**
 * Codex adapter. Three ways to reach the model, in priority order:
 *   1. An explicit API key (OPENAI_API_KEY / options.apiKey) → OpenAI-compatible.
 *   2. A ChatGPT OAuth session from `betterwright auth --login codex` → the
 *      ChatGPT backend Responses API directly, refreshing the token per request.
 *   3. A configured router base URL (CODEX_BASE_URL) → Responses over that.
 * @param {object} [options] baseURL, model, apiKey, protocol, effort, fetchImpl
 */
export function codexModel(options: any = {}) {
  const stored = readCodexConfig();
  const configuredBase = options.baseURL || process.env.CODEX_BASE_URL || process.env.OPENAI_BASE_URL;
  const apiKey = options.apiKey || process.env.OPENAI_API_KEY || stored.apiKey;
  const model = options.model || process.env.BETTERWRIGHT_CODEX_MODEL || stored.model || "gpt-5.6-sol";
  const effort = options.effort || "low";
  if (apiKey) {
    const baseURL = configuredBase || "https://api.openai.com/v1";
    if (options.protocol === "responses")
      return responsesModel({ ...options, name: "codex", baseURL, apiKey, model, effort });
    return openaiModel({ ...options, name: "codex", baseURL, apiKey, model, effort });
  }
  // ChatGPT OAuth session (from `betterwright auth --login codex`): call the
  // backend directly, no router binary required.
  if (!configuredBase && loadCodexAuth()) {
    const sessionId = crypto.randomUUID();
    return responsesModel({
      ...options,
      name: "codex",
      baseURL: CHATGPT_RESPONSES_BASE,
      responsesPath: "/responses",
      model,
      effort,
      getAuth: codexOAuthAuth(sessionId),
      bodyExtra: { include: [], prompt_cache_key: sessionId, ...options.bodyExtra },
    });
  }
  // Bring-your-own Responses-compatible base URL (CODEX_BASE_URL): the endpoint
  // supplies its own auth (or none, for a local proxy).
  if (configuredBase) {
    return responsesModel({ ...options, name: "codex", baseURL: configuredBase, model, effort });
  }
  throw new Error(
    "No codex credentials found. Run `betterwright auth --login codex`, or set OPENAI_API_KEY / CODEX_BASE_URL.",
  );
}

/**
 * Grok adapter. Three ways to reach the model, in priority order:
 *   1. An explicit xAI API key (GROK_API_KEY / XAI_API_KEY) → OpenAI-compatible.
 *   2. An xAI OAuth session from `betterwright auth --login grok` → xAI's
 *      OpenAI-compatible endpoint, refreshing the token per request.
 *   3. A configured router base URL (GROK_BASE_URL) → Responses over that.
 * @param {object} [options] baseURL, model, apiKey, protocol, effort, fetchImpl
 */
export function grokModel(options: any = {}) {
  const configuredBase = options.baseURL || process.env.GROK_BASE_URL || process.env.XAI_BASE_URL;
  const apiKey = options.apiKey || process.env.GROK_API_KEY || process.env.XAI_API_KEY;
  const model = options.model || process.env.BETTERWRIGHT_GROK_MODEL || process.env.XAI_MODEL || "grok-4.3";
  const effort = options.effort || "low";
  if (apiKey) {
    const baseURL = configuredBase || "https://api.x.ai/v1";
    if (options.protocol === "responses")
      return responsesModel({ ...options, name: "grok", baseURL, apiKey, model, effort });
    return openaiModel({ ...options, name: "grok", baseURL, apiKey, model, effort });
  }
  // xAI OAuth session (from `betterwright auth --login grok`): call xAI's
  // OpenAI-compatible endpoint directly with a per-request fresh access token.
  if (!configuredBase && loadGrokAuth()) {
    return openaiModel({
      ...options,
      name: "grok",
      baseURL: "https://api.x.ai/v1",
      model,
      effort,
      getAuth: async () => {
        const { accessToken } = await grokAccessToken();
        return { headers: { authorization: `Bearer ${accessToken}` } };
      },
    });
  }
  // Bring-your-own Responses-compatible base URL (GROK_BASE_URL): the endpoint
  // supplies its own auth (or none, for a local proxy).
  if (configuredBase) {
    return responsesModel({ ...options, name: "grok", baseURL: configuredBase, model, effort });
  }
  throw new Error(
    "No grok credentials found. Run `betterwright auth --login grok`, set GROK_API_KEY (or XAI_API_KEY), or configure GROK_BASE_URL.",
  );
}
