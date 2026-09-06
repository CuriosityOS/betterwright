import type { BetterWright } from "./client.js";
import type { CredentialVault } from "./common.js";
import type { NetworkPolicy } from "./policy.js";
import type { Guardrails } from "./prompt.js";
import type { UntrustedValue } from "./untrusted-value.js";

/** Per-request auth an OAuth adapter resolves before each model call. */
export interface ResolvedAuth {
  apiKey?: string;
  headers?: Record<string, string>;
}

/** A tool call the model asked the harness to run. */
export interface AgentToolCall {
  id: string;
  name: string;
  /** Model-authored arguments — untrusted until narrowed by the tool handler. */
  input: Record<string, UntrustedValue>;
}

/** A neutral transcript turn the harness passes to a model adapter. */
export type AgentMessage =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; toolCalls: AgentToolCall[] }
  | { role: "tool"; results: Array<{ id: string; name: string; content: string }> };

/** A tool definition exposed to the model. */
export interface AgentTool {
  name: string;
  description: string;
  /** A JSON Schema object, passed to the provider verbatim. */
  parameters: Record<string, UntrustedValue>;
}

/** The pluggable model interface. Implement `complete` to bring your own. */
export interface AgentModel {
  name?: string;
  modelId?: string;
  complete(request: {
    system: string;
    messages: AgentMessage[];
    tools: AgentTool[];
    /** Aborted when the run's wall-clock budget expires or the caller's `signal` stops the run. */
    signal: AbortSignal;
  }): Promise<{ text: string; toolCalls: AgentToolCall[]; stopReason?: string; usage?: AgentUsage | null }>;
}

/**
 * Token usage for one turn, normalized across model adapters (0 when a provider
 * omits it). `inputTokens` is the full prompt size for the turn, cached tokens
 * included; `cacheReadTokens`/`cacheWriteTokens` break out the cached portion.
 */
export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface AgentStepEvent {
  step: number;
  tool: string;
  note?: string;
  /** Live-view URL, present on `tool: "liveView"` and `tool: "handoff"` events. */
  url?: string;
  /** The handoff prompt shown to the human, present on `tool: "handoff"`. */
  prompt?: string;
}

export interface AgentPhaseEvent {
  /** "reasoning" while a model turn is in flight, "acting" while its tool calls run. */
  phase: "reasoning" | "acting";
  step: number;
  /** The tool names about to run, present on `phase: "acting"`. */
  tools?: string[];
}

export interface RunAgentTaskOptions {
  task: string;
  model?: string | AgentModel;
  modelOptions?: Record<string, UntrustedValue>;
  browser?: BetterWright;
  guardrails?: Guardrails;
  session?: string;
  /**
   * Named browser profile — a separate identity, with its own cookies — for a
   * browser this call creates. Ignored when `browser` is supplied, since that
   * browser already has a profile.
   */
  profile?: string;
  headless?: boolean | "auto";
  /** Ad/tracker blocking for a browser this call creates (default on). */
  adBlock?: boolean;
  policy?: NetworkPolicy;
  /** Wall-clock budget for the loop in milliseconds (default 30 minutes). */
  maxDurationMs?: number;
  /** Maximum serialized transcript size before stopping (default 1,000,000 characters). */
  maxTranscriptChars?: number;
  /** Override or disable the built-in vault. Ignored when an external browser is passed. */
  vault?: CredentialVault | false | null;
  /**
   * Stop the run early: the in-flight model call or browser step is aborted,
   * the loop returns a partial result with `reason: "interrupted"`, and the
   * transcript is preserved so the session can pick up where it left off.
   */
  signal?: AbortSignal;
  onStep?: (event: AgentStepEvent) => void;
  /**
   * Fired at the start of each model turn ("reasoning") and again when its
   * tool calls begin ("acting"), so a live UI can label the current wait.
   */
  onPhase?: (event: AgentPhaseEvent) => void;
  /**
   * When provided, the loop exposes an `ask` tool so the model can put a
   * question to the user mid-task; the returned string is fed back as the
   * answer. Omit it (the `exec` default) to run fully autonomously with no
   * `ask` tool.
   */
  askUser?: (question: {
    question: string;
    options: string[];
    signal: AbortSignal;
  }) => string | Promise<string>;
  /**
   * Non-blocking host callback drained at model turn boundaries. Returned
   * messages steer the active task, like live-view chat.
   */
  drainSteering?: () =>
    | string
    | string[]
    | Promise<string | string[]>;
  /**
   * A prior transcript (from a previous call's `transcript`) to continue from, so
   * a follow-up task can refer back to earlier work. Omit for a fresh run.
   */
  history?: AgentMessage[];
  /**
   * Live browser view for the human. Anything except `false` offers the model
   * `live_view` (watch anytime mid-task), `handoff` (pause for human hands),
   * live-view-backed `ask`, and freeform chat when a URL surface exists
   * (`askUser` or `onStep`). Pass `true` — or startLiveView options — to also
   * start the viewer at run start so the whole task can be watched live. A
   * newly created viewer's URL arrives as `onStep({tool: "liveView", url})`;
   * an already-running host viewer is reused without re-announcing it.
   */
  liveView?: boolean | Record<string, UntrustedValue>;
}

export interface AgentResult {
  ok: boolean;
  answer: string;
  steps: number;
  /**
   * How the run ended. Success reasons: "answered" (prose answer), "done"
   * (done tool or finalAnswer). Failure reasons: "stopped" (no answer),
   * "interrupted" (the caller's `signal` stopped the run — the transcript is
   * preserved), "timeout" (wall-clock budget), "context_limit" (transcript
   * budget), "no_progress" (the same browser step failed identically five
   * times in a row), "max_tokens" (the provider truncated the final response
   * at the output-token limit — `answer` holds the fragment), "refusal" (the
   * model declined the task), "model_error" (a transient provider failure
   * survived the bounded retries — the transcript is preserved).
   */
  reason:
    | "answered"
    | "stopped"
    | "done"
    | "interrupted"
    | "timeout"
    | "context_limit"
    | "no_progress"
    | "max_tokens"
    | "refusal"
    | "model_error";
  /** How many tool calls the model issued; can exceed `steps` when a turn batches several. */
  toolCalls: number;
  /**
   * Token usage summed across turns (fields are 0 when unavailable).
   * `inputTokens` excludes the portion served from cache; `cacheReadTokens` is
   * that cached portion. `cacheWriteTokens` is reported only from a provider's
   * real cache-write field (0 when unavailable), and can overlap fresh input.
   * `context` is the full prompt size at the end of the task (the last turn's
   * provider input total) — how much context the model was holding when it
   * finished.
   */
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    context: number;
  };
  /** Task wall-clock in milliseconds (excludes owned-browser teardown). */
  durationMs: number;
  transcript: AgentMessage[];
  proof: string | null;
}

export function runAgentTask(options: RunAgentTaskOptions): Promise<AgentResult>;

/**
 * Close an unfinished turn so a saved transcript stays a valid conversation:
 * when the last message is an assistant turn with unanswered tool calls, a
 * stub result is appended for each so providers accept the transcript on the
 * next request. Mutates `messages` in place and returns it; a no-op on a
 * transcript that already ends cleanly.
 */
export function sealTranscript(messages: AgentMessage[], reason?: string): AgentMessage[];

export function resolveModel(model: string | AgentModel, modelOptions?: Record<string, UntrustedValue>): AgentModel;
export function resolveModelSelection(
  model: string | AgentModel,
  modelOptions?: Record<string, UntrustedValue>,
): Promise<AgentModel>;

export interface ClaudeModelOptions {
  model?: string;
  apiKey?: string;
  maxTokens?: number;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  client?: unknown;
}
export function claudeModel(options?: ClaudeModelOptions): AgentModel;

export interface OpenAIModelOptions {
  baseURL?: string;
  model: string;
  apiKey?: string;
  headers?: Record<string, string>;
  maxTokens?: number;
  maxTokensField?: "max_tokens" | "max_completion_tokens";
  parallelToolCalls?: boolean | null;
  bodyExtra?: Record<string, UntrustedValue>;
  effort?: string;
  name?: string;
  getAuth?: () => ResolvedAuth | Promise<ResolvedAuth>;
  fetchImpl?: typeof fetch;
}
export function openaiModel(options: OpenAIModelOptions): AgentModel;

export type ModelEndpointSource =
  | "openrouter"
  | "ollama"
  | "vllm"
  | "custom";

export interface ModelEndpointPreset {
  readonly baseURL: string | null;
  readonly baseURLEnv: string;
  readonly apiKeyEnv: string;
  readonly requiresApiKey: boolean;
}

export const MODEL_ENDPOINT_PRESETS: Readonly<
  Record<ModelEndpointSource, ModelEndpointPreset>
>;

/**
 * Canonical endpoint-source parsing: case-, dash-, and underscore-insensitive,
 * falling back to `"custom"`. Shared with the CLI so `betterwright models` and
 * `--model source/id` accept exactly the same names.
 */
export function endpointSourceName(value: string): ModelEndpointSource;

/**
 * Sources probed during bare-id model discovery: the loopback runtimes always,
 * OpenRouter only when `OPENROUTER_API_KEY` is set (its probe is a remote call).
 */
export function endpointDiscoverySources(): ModelEndpointSource[];

/** Per-source quick-probe budget, in milliseconds. */
export function discoveryTimeoutMs(source: ModelEndpointSource): number;

export interface EndpointModelOptions {
  /** Omit when `baseURL` identifies a custom endpoint. */
  source?: ModelEndpointSource;
  model: string;
  baseURL?: string;
  apiKey?: string;
  /** Read the API key from this environment variable instead of the preset default. */
  apiKeyEnv?: string;
  protocol?: "chat" | "responses";
  headers?: Record<string, string>;
  maxTokens?: number;
  effort?: string;
  bodyExtra?: Record<string, UntrustedValue>;
  fetchImpl?: typeof fetch;
  /** Optional cancellation signal for model discovery. */
  signal?: AbortSignal;
  /**
   * Permit a key-bearing request to a non-loopback http:// endpoint.
   * HTTPS and loopback endpoints do not need this override.
   */
  allowInsecureEndpoint?: boolean;
}

export function endpointModel(options: EndpointModelOptions): AgentModel;

export interface EndpointModelList {
  source: ModelEndpointSource;
  baseURL: string;
  models: string[];
}

export function listEndpointModels(
  options: Omit<EndpointModelOptions, "model"> & { model?: string },
): Promise<EndpointModelList>;

export interface ModelCatalogEntry {
  source: string;
  model: string;
}

export interface ModelSelectionChoice extends ModelCatalogEntry {
  selector: string;
  qualified: string;
  ambiguous: boolean;
}

export function modelSelectionChoices(
  entries?: ModelCatalogEntry[],
): ModelSelectionChoice[];
export function nativeModelCatalog(): ModelCatalogEntry[];

export interface OAuthModelOptions {
  baseURL?: string;
  model?: string;
  apiKey?: string;
  /** `"responses"` forces the Responses protocol against an API-key endpoint. */
  protocol?: "responses" | "chat";
  headers?: Record<string, string>;
  name?: string;
  maxTokens?: number;
  effort?: string;
  fetchImpl?: typeof fetch;
}
export function codexModel(options?: OAuthModelOptions): AgentModel;
export function grokModel(options?: OAuthModelOptions): AgentModel;
