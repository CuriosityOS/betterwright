import type { UntrustedValue } from "./untrusted-value.js";
import type { VaultMatchMode } from "./vault.js";

export type BrowserFlavor = "chromium-fork";
export type HeadlessMode = boolean | "auto";
export type PublicSearchPolicy = "block" | "allow";
export type DownloadPolicy = "ask" | "allow" | "deny";

export interface CredentialVault {
  handleRequest(
    action: string,
    payload: Record<string, UntrustedValue>,
    origin: string,
  ): UntrustedValue | Promise<UntrustedValue>;
  redact?(value: UntrustedValue): UntrustedValue;
  /** Called only after the owning worker and all of its pages are closed. */
  resetRedactionSecrets?(): void;
}

export interface BetterWrightArtifact {
  kind?: string;
  path?: string;
  media?: string;
  size?: number;
  /** Downscaled model-facing companion of a proof screenshot, when written. */
  inlinePath?: string;
  [key: string]: UntrustedValue;
}

export interface SkillHint {
  name: string;
  description: string;
  path: string;
}

export interface ResultEnvelopeBase {
  console?: unknown[];
  events?: unknown[];
  artifacts?: BetterWrightArtifact[];
  warnings?: string[];
  challenges?: unknown[];
  pages?: unknown[];
  /** Skill packs whose autoInject.url patterns match an open page. */
  skills?: SkillHint[];
  /** One-time compact action directory when the active origin publishes WebAgents. */
  webagents?: unknown;
  /** One-time compact semantic action directory synthesized from an ordinary page. */
  ui?: unknown;
  profileMode?: string;
  durationMs?: number;
  envelopeTruncated?: boolean;
  /** Secret-free metadata for a generated credential that still needs recovery. */
  pendingCredential?: PendingCredentialRecovery;
}

export interface SuccessfulRunResult<T = unknown> extends ResultEnvelopeBase {
  ok: true;
  result: T;
  error?: never;
}

export interface FailedRunResult extends ResultEnvelopeBase {
  ok: false;
  error: string;
  result?: never;
}

export type RunResult<T = unknown> = SuccessfulRunResult<T> | FailedRunResult;

export interface RunOptions {
  session?: string;
  /** Optional host-facing status text. It is never evaluated in the browser sandbox. */
  note?: string;
  timeout?: number;
  approvedDownloads?: boolean;
}

export interface FillCredentialOptions {
  /** Optional CSS or current `aria-ref=eN` target; omit for semantic detection. */
  passwordSelector?: string;
  /** Explicit current-password target for rotation with generated credentials. */
  currentPasswordSelector?: string;
  usernameSelector?: string;
  confirmPasswordSelector?: string;
  submitSelector?: string;
  /** Detect and click the matching form's submit control after filling. */
  submit?: boolean;
  id?: string;
  username?: string;
  session?: string;
  timeout?: number;
}

interface GeneratedCredentialOptions {
  length?: number;
  includeSymbols?: boolean;
  label?: string | null;
}

export type GenerateAndFillCredentialOptions =
  | (Omit<FillCredentialOptions, "id"> &
      GeneratedCredentialOptions & {
        id?: undefined;
        /** URL scope assigned to a new generated credential. Defaults to `"base-domain"`. */
        matchMode?: VaultMatchMode;
      })
  | (FillCredentialOptions &
      GeneratedCredentialOptions & {
        /** Rotate this stored record while preserving its existing URL scope. */
        id: string;
        matchMode?: never;
      });

export interface PendingCredentialRecovery {
  pendingId: string;
  origin: string;
  matchMode: VaultMatchMode;
  username: string | null;
  label: string | null;
  expiresAt: string | null;
}

export interface PendingCredentialOptions {
  pendingId: string;
  session?: string;
  timeout?: number;
}

export interface PendingCredentialListOptions {
  session?: string;
  timeout?: number;
}

export interface PendingCredentialMetadata extends PendingCredentialRecovery {
  id?: string;
  category: "login";
  createdAt: string;
  expiresAt: string;
  expired: boolean;
}

export interface PendingCredentialPublicRecord {
  pendingId?: string;
  committed?: boolean;
  discarded?: boolean;
  [key: string]: UntrustedValue;
}

export interface CredentialPublicRecord {
  filled: Array<"username" | "currentPassword" | "password" | "confirmPassword">;
  submitted: boolean;
  [key: string]: UntrustedValue;
}

export type CredentialFillResult =
  | (ResultEnvelopeBase & {
      ok: true;
      result: CredentialPublicRecord;
      error?: never;
    })
  | (ResultEnvelopeBase & {
      ok: false;
      error: string;
      result?: never;
    });

export type PendingCredentialResult =
  | (ResultEnvelopeBase & {
      ok: true;
      result: PendingCredentialPublicRecord;
      error?: never;
    })
  | (ResultEnvelopeBase & {
      ok: false;
      error: string;
      result?: never;
    });

export type PendingCredentialListResult =
  | (ResultEnvelopeBase & {
      ok: true;
      result: PendingCredentialMetadata[];
      error?: never;
    })
  | (ResultEnvelopeBase & {
      ok: false;
      error: string;
      result?: never;
    });
