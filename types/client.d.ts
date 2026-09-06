import type {
  AskResult,
  BetterWrightOptions,
  CookieSyncOptions,
  CookieSyncResult,
  CredentialFillResult,
  FillCredentialOptions,
  GenerateAndFillCredentialOptions,
  HandoffResult,
  LiveViewChatMessage,
  LiveViewDrainChatResult,
  LiveViewOptions,
  LiveViewStatus,
  PendingCredentialListOptions,
  PendingCredentialListResult,
  PendingCredentialOptions,
  PendingCredentialResult,
  RunOptions,
  RunResult,
  WaitForAskOptions,
  WaitForHandoffOptions,
} from "./public.js";
import type { CredentialVault } from "./common.js";
import type { NetworkPolicy } from "./policy.js";
import type { UntrustedValue } from "./untrusted-value.js";
import type { VaultMatchMode } from "./vault.js";

export class BrowserError extends Error {}

export function validateCredentialMatchMode(value: UntrustedValue): VaultMatchMode;

export class BetterWright {
  constructor(options?: BetterWrightOptions);

  home: string;
  policy: NetworkPolicy;
  vault: CredentialVault | null;
  credentialCapture: boolean;
  browserFlavor: "chromium-fork";
  /** The configured provider, or null for the managed BetterChromium fork. */
  provider: import("./public.js").BrowserProviderOptions | null;
  headless: boolean;
  searchMinIntervalMs: number;
  publicSearchPolicy: "block" | "allow";
  adBlock: boolean;
  downloadPolicy: "ask" | "allow" | "deny";
  stealthRuntimeFix: boolean;
  launchIdentity: boolean;
  fingerprintNoise: boolean;
  upstreamProxy: string | null;
  geoip: boolean;
  locale: string | null;
  timezone: string | null;
  headedInvisible: boolean;
  platform: "macos" | "windows" | "linux" | null;
  /** Validated extra Chromium switches, from the option and the environment. */
  chromiumArgs: string[];
  /**
   * Explicit page-parking choice, or `undefined` to leave it to the worker
   * (which also reads `BETTERWRIGHT_PARK_BACKGROUND_PAGES` and never parks a
   * browser a human can see).
   */
  parkBackgroundPages: boolean | undefined;
  defaultTimeout: number;
  /**
   * Live-view defaults: constructor built-ins merged with `<home>/config.json`
   * and constructor options. `expose` is a plain string here because config
   * files are hand-editable; presets are validated when the viewer starts.
   */
  liveView: Omit<LiveViewOptions, "expose"> & { expose?: string };

  run<T = unknown>(code: string, options?: RunOptions): Promise<RunResult<T>>;
  /** Merge local browser cookies into this browser's persistent context. */
  syncCookies(options: CookieSyncOptions): Promise<CookieSyncResult>;
  /**
   * Close one session's pages and forget its state (tabs, `state`, cursor)
   * without touching the browser, the profile, or other sessions.
   */
  closeSession(
    session?: string,
  ): Promise<{ ok: boolean; closed: boolean; pagesClosed: number; error?: string }>;
  /** Start (or return the already-running) token-gated live-view server. */
  startLiveView(options?: LiveViewOptions): Promise<LiveViewStatus>;
  /** Stop the live-view server (no-op when not running). */
  stopLiveView(): Promise<LiveViewStatus>;
  /** Report live-view server state. */
  liveViewStatus(): Promise<LiveViewStatus>;
  /** Block until a human clicks Done/Cancel in the live viewer's handoff banner. */
  waitForHandoff(options?: WaitForHandoffOptions): Promise<HandoffResult>;
  /** Post a line into the live-view chat (agent steps / system notices). */
  liveViewPostChat(options?: {
    role?: "agent" | "you" | "system";
    text?: string;
    kind?: string;
  }): Promise<{ ok: boolean; message?: LiveViewChatMessage; error?: string }>;
  /**
   * Drain freeform human messages typed in the live-view chat since the last
   * drain (agent harness uses this between turns).
   */
  liveViewDrainChat(): Promise<LiveViewDrainChatResult>;
  /** Block until a human answers a question in the live-view chat. */
  waitForAsk(options?: WaitForAskOptions): Promise<AskResult>;
  fillCredential(options?: FillCredentialOptions): Promise<CredentialFillResult>;
  generateAndFillCredential(
    options?: GenerateAndFillCredentialOptions,
  ): Promise<CredentialFillResult>;
  commitGeneratedCredential(
    options: PendingCredentialOptions,
  ): Promise<PendingCredentialResult>;
  discardGeneratedCredential(
    options: PendingCredentialOptions,
  ): Promise<PendingCredentialResult>;
  listPendingCredentials(
    options?: PendingCredentialListOptions,
  ): Promise<PendingCredentialListResult>;
  close(): Promise<void>;
}
