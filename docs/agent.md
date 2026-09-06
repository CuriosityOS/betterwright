# The built-in agent harness (`betterwright exec`)

This page covers the **standalone** shape: BetterWright supplies a
browser-tuned agent loop, you plug a *model* into it, and you hand it a
natural-language task. For how it compares to the integrated shape, see
[Pick your shape first](getting-started.md#pick-your-shape-first).

The two nest: a coding agent can shell out `betterwright exec "<task>"` as a
browser **sub-agent** — one command in, one JSON answer out, with the entire
browsing transcript (snapshots, retries, verification) kept out of the caller's
context.

This shape exists because the browser runtime is rarely the slow part.
The end-to-end gap is usually the *agent scaffold* — a browser-specialized
loop takes fewer, tighter steps than a general coding agent.
`betterwright exec` gives BetterWright that scaffold.

## CLI

```bash
betterwright exec "find the top Hacker News story and give me its title and points" --model gpt-5.6-sol
```

Shells expand dollar signs inside double quotes, so use single quotes for tasks
that contain prices or other literal `$` text:

```bash
betterwright exec 'find options under $4000' --model gpt-5.6-sol
printf '%s\n' 'find options under $4000' | betterwright exec --stdin --model gpt-5.6-sol
```

The `--stdin` form is also useful for generated or multiline tasks because the
task does not go through another round of shell parsing.

Progress notes stream to stderr as the loop runs — the last one summarizes the
run's cost (`done in 6 steps, 7 tool calls, 11.4s, 6,880 in / 1,330 out · 40,000
cache read · context 20,000`) — and the final result is one JSON object on
stdout:

```json
{
  "ok": true,
  "answer": "…",
  "steps": 6,
  "reason": "done",
  "toolCalls": 7,
  "usage": {
    "inputTokens": 6880,
    "outputTokens": 1330,
    "cacheReadTokens": 40000,
    "cacheWriteTokens": 0,
    "context": 20000
  },
  "durationMs": 11400,
  "proof": "/…/proof-….png"
}
```

`toolCalls` counts the `browser`/`login`/`ask`/`done` calls the model issued (it
can exceed `steps` when a turn batches several). `usage` sums the token counts the
model adapter reported across turns (a field is `0` when the provider returned no
usage block); `inputTokens` is fresh input only: each turn's provider input total
minus the portion served from cache.
`cacheReadTokens` and `cacheWriteTokens` come straight from the provider's usage
block — the Responses API's `input_tokens_details.cached_tokens` /
`cache_write_tokens`, the Chat Completions `prompt_tokens_details` equivalents, or
Anthropic's `cache_read_input_tokens` / `cache_creation_input_tokens`. The CLI
always shows cache reads; it shows cache writes only when the run has a positive,
provider-reported count. It never derives writes from fresh input. `context` is
the full prompt size at the **end** of the task — the last turn's provider input
total, i.e. how much context the model was holding when it finished. `durationMs`
is the task wall-clock (it excludes tearing down a browser the loop created for
itself). The loop has no fixed step cap, but it does have a 30-minute wall-clock
budget and a 1,000,000-character transcript bound so a stalled or repetitive
provider cannot run forever or grow context without limit. Expiry aborts model
requests, and BetterWright's worker timeout terminates in-flight browser work.

A third bound catches the loop that is running but not progressing: when a
browser step fails **the same way three times in a row**, the observation carries
a warning telling the model to change approach; at five, the run ends with
`reason: "no_progress"` rather than spending the rest of the budget on a step
that cannot succeed. Any successful browser call — or new human steering through
the live view — clears the streak.

`reason` is one of `done`, `answered` (the model gave its answer in prose
instead of calling `done`), `stopped`, `interrupted` (see
[sessions.md](sessions.md)), `timeout`, `context_limit`, `no_progress`,
`max_tokens` (the provider truncated the final response at the output-token
limit), `refusal` (the model declined the task), or `model_error`. Only `done`
and `answered` yield `ok: true`; every other reason still returns the partial
answer and the full transcript.

Flags:

| Flag | Default | Meaning |
| --- | --- | --- |
| `--model <id>` | whatever backend you have configured (or `BETTERWRIGHT_MODEL`) | Real model id. Bare ids auto-select a source when unique; use `source/id` only to pin a collision. See [Choosing a model](#choosing-a-model) |
| `--base-url <url>` | none | Pin `--model` to a custom OpenAI-compatible `/v1` base URL (`--endpoint` is an alias) |
| `--api-key-env <name>` | source default | Read the API key from a named environment variable; raw keys are never accepted as CLI values |
| `--protocol <name>` | `chat` | `chat` for Chat Completions (widest compatibility), or `responses` when the server implements it |
| `--allow-insecure-model-endpoint` | off | Allow a key over non-loopback plain HTTP; HTTPS and loopback HTTP work without it |
| `--effort <level>` (alias `--reasoning`) | `low` | Reasoning effort: `low`/`medium`/`high`/`xhigh`/`max` where the model supports it |
| `--session <name>` | `default` | Parallel lanes inside one identity; the browser and the conversation both persist under that name |
| `--profile <name>` | the shared profile | A separate identity: its own cookies, its own daemon, its own `exec` history (`BETTERWRIGHT_PROFILE` sets one for the whole shell; the flag wins) |
| `--headed` | off | Show the managed browser |
| `--live-view` | off | Start the viewer at step 0 and print its URL (see [live-view.md](live-view.md)) |
| `--stdin` | off | Read the task from stdin instead of an argument — no second round of shell parsing |
| `--fresh` | off | Forget this session's `exec` conversation and start the transcript over; the browser and its logins are untouched |
| `--close` | off | Close the session after this task instead of leaving it live |
| `--no-daemon` | off | Do not use the background session daemon; the browser lives and dies with this command |

Network flags (`--block-private-network`, `--allow-host`, …) work the same as on
`run`/`repl`.

## Interactive console (`betterwright`)

`betterwright exec` runs one task and exits. Run **`betterwright`** with no
subcommand for the interactive counterpart — a console where you type tasks and
watch the agent work:

```
$ betterwright --model gpt-5.6-sol
BetterWright — interactive agent console
model gpt-5.6-sol · reasoning model default · session default · headless
Type a task and press Enter. /help for commands, /exit or Ctrl-D to quit.

▸ what is the page title of example.com
  · [1] browser: opening the page and reading its title

The page title is "Example Domain."
proof: /…/proof-….png
done · 2 steps · 2 tool calls · 2.1s · 1,889 in / 120 out · 3,072 cache read · context 4,961

▸
```

Each step the agent takes streams as it happens, then the answer, the proof
screenshot path, and the same cost summary `exec` prints. **The session carries
across tasks**: both the browser (you stay signed in, tabs stay open) *and* the
conversation — a follow-up task remembers what earlier ones did and can refer back
to them without repeating the work (it's fed the running transcript). `/new` clears
both the memory and the browser to start fresh. The same `--model`, endpoint,
`--effort`/`--reasoning`, `--session`, `--headed`, and network flags apply.

With `--live-view`, the console starts and prints one viewer before the first
prompt. That viewer remains open across follow-up tasks. Commands that replace
the browser (`/new`, `/headed`, and `/headless`) also replace the viewer and
print its new URL without restarting the console.

While a task is running, type a plain-text message and press Enter to steer it.
The message is queued safely and applied at the next model turn boundary, just
like chat sent from the live viewer. Slash commands typed during a task wait
until that task finishes, so `/new` cannot tear down a browser mid-step. The
active prompt changes to `steer ▸`; progress output redraws that prompt without
discarding partially typed guidance and wraps with aligned continuation lines.

Because the transcript accumulates, a long session grows the context each task
sends (largely served from cache — watch `cache read` in the summary); `/new` when
you switch to unrelated work.

Meta-commands (a line starting with `/`):

| Command | Effect |
| --- | --- |
| `/help` | list the commands |
| `/endpoint <url>` | switch to a custom OpenAI-compatible base URL |
| `/models [source]` | list available ids, optionally limited to `openrouter`, `ollama`, or `vllm` |
| `/model <id>` | switch model id; use `source/id` only to resolve a collision |
| `/reasoning <level>` | change reasoning effort (`/effort` also works) |
| `/headed` | show the browser window (`/headless` to hide it again) |
| `/new` | clear conversation memory and close open tabs (fresh session) |
| `/clear` | clear the screen |
| `/exit` | quit (or Ctrl-D) |

### The `ask` tool

Because a user is present, the interactive console gives the agent an **`ask`
tool**: when it genuinely needs input — a code it cannot obtain, a consequential
choice with no reasonable default, or a task ambiguous enough that guessing risks
the wrong thing — it asks you a question (offering short concrete options when the
answer is a choice) and waits for your typed reply before continuing. It still
acts on its own for ordinary reversible steps; it does not ask permission to
proceed. `betterwright exec` has no user watching, so it runs without the `ask`
tool and never stalls on a question.

## Choosing a model

`--model` always takes a **real model id** (or a source-qualified id). There
are no adapter nicknames: `claude`, `codex`, and `grok` by themselves are
rejected. Pick the id you want to run; BetterWright figures out *where* it
comes from.

The examples below use the current model selections in the
[README](../README.md#2-standalone--betterwright-is-the-browser-agent):
Claude Opus 5, Grok 4.6, Qwen3.8 27B, and GPT-5.6 Sol for the subscription
quick start. The older IDs under **When you name none** describe 2.4.0's
built-in fallbacks. Pass an explicit `--model` (or set `BETTERWRIGHT_MODEL`)
to select the current examples instead of those fallbacks.

### When you name none

Omitting `--model` uses whichever backend you have actually configured, in this
order: `ANTHROPIC_API_KEY` (with the `@anthropic-ai/sdk` peer installed) →
`claude-opus-4-8`; a `betterwright auth --login codex` session → `gpt-5.6-sol`;
a `betterwright auth --login grok` session → `grok-4.3`. `BETTERWRIGHT_MODEL`
overrides all of it, and `--model` overrides that.

With nothing configured, `exec` and the console say so before doing any work
and print the ways to fix it, rather than failing inside a model adapter.
`betterwright doctor` reports the same thing under **Built-in agent**.

### How selection works

1. **Source-qualified** (`ollama/qwen3.8:27b`, `openrouter/anthropic/claude-sonnet-5`,
   `codex/gpt-5.6-sol`) — used immediately; no discovery.
2. **Custom base URL** (`--base-url` / `--endpoint`) — pins the source to that
   URL; the bare id is the model name on that server.
3. **Bare id** — BetterWright probes reachable catalogs and native family
   routes. If **exactly one** source exposes the id, that source is selected.
   If several do, the error lists the shortest unambiguous choices
   (for example `codex/gpt-5.6-sol` and `ollama/gpt-5.6-sol`). If none do, it
   tells you to run `betterwright models` or pin a source.

What bare-id discovery probes:

| Source | When it is probed |
| --- | --- |
| **Ollama** | Always (default `http://127.0.0.1:11434/v1`; short timeout if down) |
| **vLLM** | Always (default `http://127.0.0.1:8000/v1`) |
| **OpenRouter** | Only when `OPENROUTER_API_KEY` is set |
| **Native Claude / Codex / Grok** | When the id's family prefix matches (`claude*`, `gpt*` / `o*`, `grok*`, …) |

Listing is separate from selection:

```bash
betterwright models                 # native defaults + reachable endpoints
betterwright models ollama          # only Ollama
betterwright models openrouter      # only OpenRouter
betterwright models --json          # machine-readable
```

Suggested lines use a bare id when it is unique, and `source/id` only when
the same name appears in more than one place.

### Quick starts by source

```bash
# Codex (ChatGPT subscription) — sign in once, then use a real GPT/Codex id
betterwright auth --login codex
betterwright exec "inspect example.com" --model gpt-5.6-sol

# Optional GPT-6 Astra (OpenAI API) — Responses is required for tool calling
OPENAI_API_KEY=… betterwright exec "inspect example.com" \
  --model gpt-6-astra --protocol responses

# Claude (Anthropic API) — optional peer dep + API key
npm install @anthropic-ai/sdk
ANTHROPIC_API_KEY=… betterwright exec "inspect example.com" \
  --model claude-opus-5

# Grok (xAI OAuth or API key)
betterwright auth --login grok
betterwright exec "inspect example.com" --model grok-4.6
# or: XAI_API_KEY=… betterwright exec "…" --model grok-4.6

# Ollama (local, no key) — Qwen3.8 27B supports tool/function calling
# About 18 GB of weights; allow additional memory for the context and browser
ollama pull qwen3.8:27b
betterwright models ollama
betterwright exec "inspect example.com" --model qwen3.8:27b
# pin if another source also exposes that id:
betterwright exec "inspect example.com" --model ollama/qwen3.8:27b

# vLLM (local OpenAI-compatible server with tool calling enabled)
betterwright exec "inspect example.com" --model vllm/<served-model-id>

# OpenRouter — canonical author/model id; pin only on collisions
OPENROUTER_API_KEY=… betterwright exec "inspect example.com" \
  --model anthropic/claude-sonnet-5
OPENROUTER_API_KEY=… betterwright exec "inspect example.com" \
  --model openrouter/anthropic/claude-sonnet-5

# Any other OpenAI-compatible /v1 base URL
BETTERWRIGHT_MODEL_API_KEY=… betterwright exec "inspect example.com" \
  --base-url https://models.example/v1 --model <model-id>
```

### Preset endpoints and environment

| Source | Default base URL | Key env var | Notes |
| --- | --- | --- | --- |
| OpenRouter | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` (required for runs) | Listing can work without a key; execution needs one |
| Ollama | `http://127.0.0.1:11434/v1` | `OLLAMA_API_KEY` (optional) | No key for local defaults |
| vLLM | `http://127.0.0.1:8000/v1` | `VLLM_API_KEY` (optional) | Start the server with tool-calling flags (below) |
| Custom | from `--base-url` or `BETTERWRIGHT_MODEL_BASE_URL` | `BETTERWRIGHT_MODEL_API_KEY` (optional) | `--base-url` alone pins the source |

Override a preset URL with `OPENROUTER_BASE_URL`, `OLLAMA_BASE_URL`, or
`VLLM_BASE_URL`. Use `--api-key-env MY_KEY` when the key lives under another
name (CLI flags never accept raw key values). BetterWright refuses to send a
key to a non-loopback `http://` URL unless `--allow-insecure-model-endpoint`
is set; HTTPS and loopback HTTP are fine without it.

Environment-driven defaults for scripts and hosts:

| Variable | Role |
| --- | --- |
| `BETTERWRIGHT_MODEL` | Default `--model` when the flag is omitted |
| `BETTERWRIGHT_MODEL_BASE_URL` | Default custom endpoint base URL |
| `BETTERWRIGHT_MODEL_API_KEY` | Key for that custom endpoint |
| `BETTERWRIGHT_MODEL_PROTOCOL` | `chat` (default) or `responses` |
| `BETTERWRIGHT_CLAUDE_MODEL` / `BETTERWRIGHT_CODEX_MODEL` / `BETTERWRIGHT_GROK_MODEL` | Defaults shown by `betterwright models` for each native source |

### Protocol and tool calling

Chat Completions (`--protocol chat`, the default) is the widest common
surface. Use `--protocol responses` only when the server implements the
Responses API.

GPT-6 Astra requires Responses for tool calling: pass
`--model gpt-6-astra --protocol responses` when using an OpenAI API key.
See the [OpenAI model guide](https://developers.openai.com/api/docs/guides/latest-model).

**Tool / function calling is required.** The loop drives the browser through
tools (`browser`, `done`, optional `login` / `ask` / `handoff`). A text-only
model will not work, even if chat completions succeed.

- **Ollama** — use a model that advertises tool support (and a recent Ollama
  build). Prefer ids you have verified with `ollama run` tool demos, or pin
  explicitly with `--model ollama/<id>`.
- **vLLM** — start the server with `--enable-auto-tool-choice` and the
  `--tool-call-parser` required by the served model.
- **OpenRouter / custom** — pick models known to support tools; partial
  OpenAI compatibility without tools is not enough.

### Native Claude, Codex, and Grok

Native sources are chosen from the **model id family**, or by an explicit
`source/` prefix:

| Family pattern | Source | Auth |
| --- | --- | --- |
| starts with `claude` | Claude | `ANTHROPIC_API_KEY` + optional peer dep `@anthropic-ai/sdk` |
| starts with `gpt`, `o`+digit, `chatgpt`, or `codex` | Codex | `betterwright auth --login codex`, or `OPENAI_API_KEY` / `CODEX_BASE_URL` |
| starts with `grok` | Grok | `betterwright auth --login grok`, or `GROK_API_KEY` / `XAI_API_KEY` |

Built-in 2.4.0 fallbacks: Claude `claude-opus-4-8`, Codex `gpt-5.6-sol` (or
the model stored in `~/.codex/config.toml`), Grok `grok-4.3`. Qualify when needed
(`codex/gpt-5.6-sol`). Base-URL overrides: `CODEX_BASE_URL`,
`GROK_BASE_URL` / `XAI_BASE_URL`. xAI may gate OAuth API access by
subscription tier; a 403 usually means switch to an API key.

### Signing in (`betterwright auth`)

```bash
betterwright auth --login codex     # opens "Sign in to Codex with ChatGPT"
betterwright auth --login grok      # opens the xAI sign-in
betterwright auth --status          # who am I signed in as?
```

`auth --login` runs the provider's OAuth 2.0 PKCE flow: it starts a loopback
callback server, opens the consent page in your default browser, and stores
tokens (Codex in `~/.codex/auth.json`, shared with the codex CLI; Grok in
`~/.grok/auth.json`). No API key is pasted and no router is required —
BetterWright refreshes the access token per request.

### Migration notes

Older docs and scripts used adapter nicknames and a separate id flag. Current
CLI behavior:

| Old | New |
| --- | --- |
| `--model claude` / `codex` / `grok` | Real id: `--model claude-opus-5`, `gpt-5.6-sol`, `grok-4.6` |
| `--model-id <id>` | Merged into `--model <id>` (the old flag errors with a hint) |
| `--provider ollama` (or similar) | Put the source in the id only when needed: `--model ollama/<id>` |

### Troubleshooting model selection

| Symptom | What to try |
| --- | --- |
| `Unknown model "codex"` (or `claude` / `grok`) | Pass a real id, not the old adapter name |
| `No available model source exposes "…"` | Run `betterwright models`; start Ollama/vLLM; set `OPENROUTER_API_KEY`; or pin `source/id` / `--base-url` |
| `available from multiple sources: …` | Pick one of the listed selectors, e.g. `ollama/qwen3.8:27b` |
| Ollama listed empty / connection errors | Confirm `ollama serve` is up; override with `OLLAMA_BASE_URL` if not on the default port |
| Model answers in prose but never calls tools | Switch to a tool-calling model; for vLLM enable auto tool choice + parser |
| Key over plain HTTP refused | Use HTTPS, loopback, or pass `--allow-insecure-model-endpoint` deliberately |

## Programmatic use

`runAgentTask` is the same loop the CLI uses:

```js
import { runAgentTask } from "betterwright/agent";

const result = await runAgentTask({
  task: "log in to example.com and download this month's invoice",
  model: "claude-opus-5",         // actual model id, or your own model object
  maxDurationMs: 30 * 60 * 1000,   // configurable; there is no fixed step cap
  maxTranscriptChars: 1_000_000,   // bound accumulated model/tool context
  guardrails: { confirmBeforePurchase: true },
  onStep: ({ step, tool, note }) => console.error(`[${step}] ${tool}: ${note}`),
});
console.log(result.answer, result.proof);
console.log(result.toolCalls, result.usage, result.durationMs);
// 7, { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, context }, 11400
```

Pass an **`askUser`** handler to let the loop ask the human mid-task — this is
how the interactive console wires the `ask` tool. Given a handler, `runAgentTask`
exposes an `ask` tool to the model; without one it runs fully autonomously.

```js
const result = await runAgentTask({
  task: "book me a table for dinner tonight",
  model: "gpt-5.6-sol",
  askUser: async ({ question, options }) => {
    // Route to your UI/host; return the user's answer as a string.
    return await promptTheUser(question, options);
  },
});
```

`runAgentTask` constructs and closes its own browser unless you pass one:

```js
import { BetterWright } from "betterwright";
import { runAgentTask } from "betterwright/agent";

const browser = new BetterWright(); // encrypted local vault + `login` tool by default
await runAgentTask({ task: "…", browser, model: "claude-opus-5" });
await browser.close();
```

The loop exposes a selector-free `login` tool backed by the same URL-matched
worker fill as MCP/Pi's `browser_login`. Generated signup/rotation passwords
remain pending until a later browser step verifies success and commits them, so
failed forms do not leave stale saved items. Pass `vault: false` to disable the
tool or a custom adapter to replace the local store.

## Bring your own model or agent

The model is a small pluggable interface — this is how you plug in anything the
three built-in adapters don't cover:

```js
const myModel = {
  name: "my-model",
  async complete({ system, messages, tools }) {
    // messages is a neutral transcript (see types/agent.d.ts); tools is
    // [{ name, description, parameters }]. Return the model's reply:
    return { text: "…", toolCalls: [{ id, name, input }], stopReason };
  },
};

await runAgentTask({ task: "…", model: myModel });
```

The harness handles the browser tools, the observe/act/verify discipline, proof
capture, and the operator guidance; your adapter only has to translate the
neutral transcript to and from your provider's wire format.

For a preset-compatible endpoint, prefer `endpointModel`:

```js
import { endpointModel, runAgentTask } from "betterwright/agent";

const model = endpointModel({
  source: "ollama",          // openrouter | ollama | vllm | custom
  model: "qwen3.8:27b",
  // baseURL: "http://127.0.0.1:11434/v1",  // optional override
});
await runAgentTask({ task: "…", model });
```

Or pass a string the same way the CLI does (`"ollama/qwen3.8:27b"`,
`"gpt-5.6-sol"`, …). The lower-level `openaiModel({ baseURL, model, apiKey })`
remains available when you need full control of the request shape.

## What the loop does

Each turn: the model sees the task, the operator guidance from
[`agentSystemPrompt`](agent-prompt.md), and the tools (`browser`, `done`,
`login` when a vault is present, and `ask` when an `askUser` handler is present).
It calls `browser` with async Playwright
JavaScript; BetterWright runs it and feeds back a compact JSON observation
(`ok`, `result`, `console`, `pages`, `challenges`, `skills`, `warnings`,
`screenshots`). The loop ends when the model calls `done` (or answers in
prose) — there is no step cap. Screenshots are captured as artifacts and their
paths surfaced; the last `proof` screenshot is returned on the result.

A `browser` call can also end the task in the *same* turn: when the model's
code returns `{ finalAnswer: "…" }` (from an `ok` run), the harness records
that as the answer and finishes without spending another model round-trip. The
preamble teaches the model to use this single-call shape for read-only tasks —
navigate, extract, compute, capture proof, and return `finalAnswer` in one
call — which makes a simple lookup cost one model turn instead of two.
