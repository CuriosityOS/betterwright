import {
  agentSystemPrompt,
  BetterWright,
  type BetterWrightOptions,
  BrowserError,
  CAPTCHA_SOLVE_STATUSES,
  CAPTCHA_STAGES,
  type CookieSyncOptions,
  type CookieSyncResult,
  classifyChallengeStage,
  detectBotChallenge,
  type GenerateAndFillCredentialOptions,
  type Guardrails,
  LocalCredentialVault,
  type LocalCredentialVaultOptions,
  listCookieSourceBrowsers,
  listCookieSourceProfiles,
  METADATA_ADDRESSES,
  METADATA_HOSTNAMES,
  NetworkPolicy,
  type PendingCredentialListResult,
  piImageArtifacts,
  piImageContent,
  piPrimaryImageArtifact,
  type RecordingStats,
  type RecordingStatus,
  type RunResult,
  type SessionRecordingStatus,
  type VaultMatchMode,
} from "betterwright";
import { type CaptureOptions, installVaultCapture } from "betterwright/capture";
import { configureElectronNetwork, createElectronHostTarget, type ElectronHostOptions } from "betterwright/electron";

const electronNetworkSetup: () => void = configureElectronNetwork;
const electronTargetFactory: (options: ElectronHostOptions) => NonNullable<BetterWrightOptions["hostTarget"]> = createElectronHostTarget;
const captureInstaller: (context: Parameters<typeof installVaultCapture>[0], options: CaptureOptions) => { dispose(): Promise<void> } = installVaultCapture;
void electronNetworkSetup;
void electronTargetFactory;
void captureInstaller;

import {
  type AgentMessage,
  type AgentModel,
  type AgentResult,
  claudeModel,
  discoveryTimeoutMs,
  endpointDiscoverySources,
  endpointModel,
  endpointSourceName,
  listEndpointModels,
  MODEL_ENDPOINT_PRESETS,
  type ModelEndpointSource,
  modelSelectionChoices,
  nativeModelCatalog,
  resolveModel,
  resolveModelSelection,
  runAgentTask,
  sealTranscript,
} from "betterwright/agent";
import { type CodexAuth, type LoginResult, loadCodexAuth, loginProvider } from "betterwright/auth";
import type { PiImageContentBlock } from "betterwright/pi";
import createBetterWrightPiExtension, {
  createPiExtension,
  type PiExtension,
} from "betterwright/pi-extension";
import type { NetworkDecision } from "betterwright/policy";
import type { Guardrails as PromptGuardrails } from "betterwright/prompt";
import {
  BROWSER_PROVIDER_NAMES,
  browserProviderInfo,
  createProviderSession,
  describeCdpUrl,
  getProviderSession,
  listProviderSessions,
  listCookieSourceBrowsers as listSdkCookieSourceBrowsers,
  listCookieSourceProfiles as listSdkCookieSourceProfiles,
  type ProviderBox,
  type ProviderLifecycleKind,
  REST_BROWSER_PROVIDER_NAMES,
  stopProviderSession,
} from "betterwright/sdk";
import {
  createLocalCredentialVault,
  type VaultAuditEntry,
  type VaultOwnerListResult,
  type VaultRevealedRecord,
} from "betterwright/vault";
import { METADATA_RESOLVER_RULES } from "betterwright/worker";

const policy = new NetworkPolicy({
  allowLoopback: true,
  custom: (_url, details): NetworkDecision | null =>
    details.method === "DELETE" ? { allowed: false, reason: "blocked" } : null,
});
const options: BetterWrightOptions = {
  policy,
  browser: "chromium-fork",
  headless: "auto",
  adBlock: true,
  downloadPolicy: "ask",
  profile: "social",
  provider: { provider: "browserbase", apiKey: "k" },
};
const cdpBrowser = new BetterWright({
  provider: { cdpUrl: "wss://browser.example.com" },
});
const browser = new BetterWright(options);
const vaultOptions: LocalCredentialVaultOptions = { home: "/tmp/betterwright-types" };
const localVault = new LocalCredentialVault(vaultOptions);
const browserWithoutVault = new BetterWright({ vault: false });
const cookieSyncOptions: CookieSyncOptions = {
  source: { browser: "chrome", profile: "Work" },
  domains: ["example.com"],
  includeSession: false,
  windowsAppBound: "disabled",
};
const cookieSync: Promise<CookieSyncResult> = browser.syncCookies(cookieSyncOptions);
const cookieBrowsers = listCookieSourceBrowsers();
const cookieProfiles = listCookieSourceProfiles("chrome", { timeoutMs: 10_000 });
void [cookieSync, cookieBrowsers, cookieProfiles];
const run: Promise<RunResult<{ title: string }>> = browser.run<{ title: string }>(
  "return { title: await page.title() }",
  { session: "docs", note: "Reading the page" },
);
const generatedMatchMode: VaultMatchMode = "exact-origin";
const generatedOptions: GenerateAndFillCredentialOptions = {
  matchMode: generatedMatchMode,
  currentPasswordSelector: "#old-password",
};
browser.generateAndFillCredential(generatedOptions);
const pendingCredentials: Promise<PendingCredentialListResult> =
  browser.listPendingCredentials({ session: "docs" });
localVault.handleRequest("list-pending", {}, "https://signup.example.com");
// @ts-expect-error Generated credential URL scope is a closed four-value union.
browser.generateAndFillCredential({ matchMode: "same-site" });
// @ts-expect-error Rotation preserves the stored credential's existing URL scope.
browser.generateAndFillCredential({ id: "login-1", matchMode: "exact-origin" });
const promptOptions: Guardrails & PromptGuardrails = {
  confirmBeforePurchase: true,
  passwordManager: "1Password",
};
const prompt: string = agentSystemPrompt(promptOptions);
const images: Promise<PiImageContentBlock[]> = piImageContent({ artifacts: [] });
const artifacts = piImageArtifacts({ artifacts: [] });
const primaryArtifact = piPrimaryImageArtifact({ artifacts: [] });
const extension: PiExtension = createPiExtension({ maxSteps: 100 });
const defaultExtension: PiExtension = createBetterWrightPiExtension;
const error: Error = new BrowserError("failed");
const metadataAddress: boolean = METADATA_ADDRESSES.has("169.254.169.254");
const metadataHost: boolean = METADATA_HOSTNAMES.has("metadata.google.internal");
const captchaStage = classifyChallengeStage({
  frames: [{ url: "https://www.google.com/recaptcha/api2/anchor?k=k", text: "I'm not a robot" }],
});
const captchaStatus: string = CAPTCHA_SOLVE_STATUSES.READY;
const captchaStageName: string = CAPTCHA_STAGES.CHECKBOX;
const challenge = detectBotChallenge({
  url: "https://example.com",
  text: "Verify you are human",
});
const customModel: AgentModel = {
  name: "custom",
  async complete({ system, messages, tools }) {
    void [system, messages, tools];
    return { text: "", toolCalls: [] };
  },
};
const resolvedModel: AgentModel = resolveModel("claude-opus-4-8");
const selectedModel: Promise<AgentModel> =
  resolveModelSelection("qwen3:8b");
const modelChoices = modelSelectionChoices(nativeModelCatalog());
const claudeAdapter: AgentModel = claudeModel({ model: "claude-fable-5", effort: "low" });
const endpointAdapter: AgentModel = endpointModel({
  source: "ollama",
  model: "qwen3:8b",
});
const customEndpointAdapter: AgentModel = endpointModel({
  baseURL: "https://models.example/v1",
  model: "vendor/opaque-id",
});
const endpointModels: Promise<{
  source: "openrouter" | "ollama" | "vllm" | "custom";
  baseURL: string;
  models: string[];
}> = listEndpointModels({ source: "vllm" });
const openRouterBaseURL: string | null =
  MODEL_ENDPOINT_PRESETS.openrouter.baseURL;
const agentResult: Promise<AgentResult> = runAgentTask({
  task: "read the page title",
  model: customModel,
  maxDurationMs: 120_000,
  maxTranscriptChars: 500_000,
  signal: new AbortController().signal,
  onStep: ({ step, tool, note }) => void [step, tool, note],
});
const sealed: AgentMessage[] = sealTranscript([], "interrupted");
const reasonCheck: AgentResult["reason"] = "no_progress";
const discoverySources: ModelEndpointSource[] = endpointDiscoverySources();
const discoveryBudget: number = discoveryTimeoutMs(endpointSourceName("open-router"));
const login: Promise<LoginResult> = loginProvider({ provider: "codex", open: false });
const codexAuth: CodexAuth | null = loadCodexAuth();

// @ts-expect-error BetterWright ships only the managed BetterChromium fork.
new BetterWright({ browser: "firefox" });
// @ts-expect-error The stock Chromium fallback was removed.
new BetterWright({ browser: "chromium" });
// @ts-expect-error Custom binaries go through the provider option.
new BetterWright({ executablePath: "/opt/chromium" });
// @ts-expect-error CDP attach goes through the provider option.
new BetterWright({ connectOverCdp: "http://127.0.0.1:9222" });
// Custom provider names from `betterwright configure` are accepted alongside
// the built-in union (which keeps its completions via the string intersection).
new BetterWright({ provider: { provider: "driverdotnet" } });
new BetterWright({ provider: { provider: "steel" } });

const restLifecycle: ProviderLifecycleKind = "rest";
const kernelInfo = browserProviderInfo("kernel");
const kernelBoxes: Promise<ProviderBox> = createProviderSession("kernel", { apiKey: "k" });
const kernelList: Promise<ProviderBox[]> = listProviderSessions("kernel", { apiKey: "k" });
const kernelShown: Promise<ProviderBox> = getProviderSession("kernel", "s1", { apiKey: "k" });
const kernelStopped: Promise<{ provider: string; id: string }> = stopProviderSession(
  "kernel",
  "s1",
  { apiKey: "k" },
);
const sdkCookieBrowsers = listSdkCookieSourceBrowsers();
const sdkCookieProfiles = listSdkCookieSourceProfiles("firefox");
const maskedCdp: string = describeCdpUrl("wss://host?apiKey=SECRET");
void [
  restLifecycle,
  kernelInfo,
  kernelBoxes,
  kernelList,
  kernelShown,
  kernelStopped,
  sdkCookieBrowsers,
  sdkCookieProfiles,
  maskedCdp,
  BROWSER_PROVIDER_NAMES,
  REST_BROWSER_PROVIDER_NAMES,
];

void [
  run,
  cdpBrowser,
  generatedMatchMode,
  generatedOptions,
  pendingCredentials,
  prompt,
  images,
  artifacts,
  primaryArtifact,
  extension,
  defaultExtension,
  error,
  metadataAddress,
  metadataHost,
  METADATA_RESOLVER_RULES,
  captchaStage,
  captchaStatus,
  captchaStageName,
  challenge,
  resolvedModel,
  selectedModel,
  modelChoices,
  claudeAdapter,
  endpointAdapter,
  customEndpointAdapter,
  endpointModels,
  openRouterBaseURL,
  agentResult,
  sealed,
  reasonCheck,
  discoverySources,
  discoveryBudget,
  login,
  codexAuth,
  localVault,
  browserWithoutVault,
];

// The owner-only vault surface behind `betterwright vault`. These must never be
// reachable from model code; they exist for a trusted host acting for the user.
const ownedVault = createLocalCredentialVault({ home: "/tmp/betterwright-types" });
const ownerListed: Promise<VaultOwnerListResult> = ownedVault.ownerList({
  query: "github",
  category: "login",
});
const ownerRevealed: Promise<VaultRevealedRecord> = ownedVault.ownerReveal("cred_1");
const ownerAudited: Promise<{ entries: VaultAuditEntry[] }> = ownedVault.ownerAudit({
  limit: 10,
});
const ownerRemoved = ownedVault.ownerRemove("cred_1");
void ownerListed;
void ownerRevealed;
void ownerAudited;
void ownerRemoved;

const recordingStats: RecordingStats = {
  path: "/tmp/betterwright-types/recording.webm",
  fps: 60,
  capturedFrames: 45,
  outputFrames: 60,
  droppedFrames: 0,
  durationMs: 1000,
  bytes: 1024,
};
const encoderStatus: RecordingStatus = { ...recordingStats, state: "completed" };
const completedRecording: SessionRecordingStatus = { ...encoderStatus, pageId: "page-1" };
const idleRecording: SessionRecordingStatus = { state: "idle" };
const failedRecording: SessionRecordingStatus = {
  ...recordingStats,
  state: "failed",
  pageId: "page-1",
  error: "Encoder exited",
};
const recordingRun: Promise<RunResult<SessionRecordingStatus>> =
  browser.run<SessionRecordingStatus>("return recording.status()");
function describeRecording(status: SessionRecordingStatus): string {
  if (status.state === "idle") {
    // @ts-expect-error Idle sessions have no recording file or page owner.
    void status.path;
    // @ts-expect-error Idle sessions have no page owner.
    void status.pageId;
    return status.state;
  }
  const file: string = status.path;
  const page: string = status.pageId;
  if (status.state === "failed") {
    const error: string = status.error;
    return `${page}: ${error}`;
  }
  // @ts-expect-error Only failed recordings carry an error.
  void status.error;
  return `${page}: ${file}`;
}
// @ts-expect-error A non-idle session recording must identify its page.
const missingRecordingPage: SessionRecordingStatus = encoderStatus;
// @ts-expect-error A failed recording must explain the failure.
const missingRecordingError: SessionRecordingStatus = { ...recordingStats, state: "failed", pageId: "page-1" };
// @ts-expect-error Encoder handles never report idle.
const idleEncoder: RecordingStatus = { state: "idle" };
void [
  completedRecording,
  idleRecording,
  failedRecording,
  recordingRun,
  describeRecording,
  missingRecordingPage,
  missingRecordingError,
  idleEncoder,
];
