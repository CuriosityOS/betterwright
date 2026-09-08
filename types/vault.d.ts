import type { UntrustedValue } from "./untrusted-value.js";

export type VaultCategory =
  | "login"
  | "credit-card"
  | "identity"
  | "api-credential"
  | "secure-note"
  | "ssh-key";

export type VaultMatchMode = "base-domain" | "host" | "exact-origin" | "never";

/**
 * A JSON value as accepted for credential `fields`: the vault clones and
 * bounds every stored field, so nothing beyond plain JSON survives a save.
 */
export type VaultJsonValue =
  | string
  | number
  | boolean
  | null
  | VaultJsonValue[]
  | { [key: string]: VaultJsonValue };

export interface LocalCredentialVaultOptions {
  /** Host-owned encryption key. Return fresh 32-byte storage; the vault zeroes it. */
  keyProvider?: () => Promise<Uint8Array>;
  /** Exact vault directory. Takes precedence over `home`. */
  dir?: string;
  /** BetterWright home directory; the vault is stored in its `vault` child. */
  home?: string;
  /**
   * Normal generated-secret finalization window. After this threshold, the
   * encrypted pending secret remains recoverable only by its exact pendingId
   * until it is explicitly committed or discarded. Defaults to 60 seconds.
   */
  pendingTtlMs?: number;
  /** Maximum wait for another process holding the vault lock. */
  lockTimeoutMs?: number;
  /** Age after which a malformed or orphaned lock can be recovered. */
  staleLockMs?: number;
}

export interface VaultPublicRecord {
  id: string;
  origin: string;
  matchMode: VaultMatchMode;
  username: string;
  label: string | null;
  category: VaultCategory;
  createdAt: string;
  updatedAt: string;
}

export interface VaultPendingRecord {
  pendingId: string;
  id?: string;
  origin: string;
  matchMode: VaultMatchMode;
  username: string;
  label: string | null;
  category: "login";
  createdAt: string;
  expiresAt: string;
  expired: boolean;
}

export interface VaultAuditWarning {
  code: string;
  message: string;
}

export interface VaultOwnerListResult {
  credentials: VaultPublicRecord[];
  pendingCredentials: VaultPendingRecord[];
}

/**
 * The only shape in this module that carries a stored secret.
 *
 * `ownerReveal` accepts either a committed record id or a pending id, and the
 * metadata it echoes back differs accordingly: a committed record carries `id`
 * and `updatedAt`; an uncommitted signup carries `pendingId` and neither. The
 * fields that only one case has are therefore optional — `pending` tells them
 * apart.
 */
export interface VaultRevealedRecord {
  id?: string;
  pendingId?: string;
  origin: string;
  matchMode: VaultMatchMode;
  username: string;
  label: string | null;
  category: VaultCategory;
  createdAt: string;
  updatedAt?: string;
  expiresAt?: string;
  expired?: boolean;
  pending: boolean;
  secret: string | null;
  notes?: string | null;
  fields?: Record<string, VaultJsonValue>;
  auditWarning?: VaultAuditWarning;
}

export interface VaultAuditEntry {
  at: string;
  action: string;
  origin?: string;
  id?: string;
  category?: VaultCategory;
  count?: number;
  /** A commit that landed after the pending TTL. */
  recovered?: boolean;
  /** A discard of a pending secret that had already expired. */
  expired?: boolean;
}

export class LocalCredentialVaultError extends Error {
  code: string;
}

export class LocalCredentialVault {
  constructor(options?: string | LocalCredentialVaultOptions);

  readonly dir: string;
  readonly paths: Readonly<{
    key: string;
    data: string;
    audit: string;
    lock: string;
  }>;
  readonly pendingTtlMs: number;
  readonly lockTimeoutMs: number;
  readonly staleLockMs: number;

  handleRequest(
    action:
      | "list"
      | "list-pending"
      | "save"
      | "update"
      | "remove"
      | "fill"
      | "generate"
      | "commit"
      | "discard",
    /** `generate` accepts an idempotency `pendingId`; finalization requires it. */
    payload: Record<string, UntrustedValue> | undefined,
    origin: string,
  ): Promise<UntrustedValue>;

  /** Return a cloned value with every active secret replaced. */
  redact<T>(value: T): T;
  /** Keep host-captured credentials redacted for as long as their pages remain alive. */
  trackRedactionSecret(value: string): void;

  /** Clear tracked material after every page in the owning worker is closed. */
  resetRedactionSecrets(): void;

  // Owner-only local access, for a trusted host acting on behalf of the person
  // who owns the vault files (`betterwright vault`). Deliberately unreachable
  // through `handleRequest`, which is the surface the browser worker — and so
  // model-authored code — addresses. Never expose these to a model.

  /** Every stored record, metadata only, ignoring site scope. */
  ownerList(options?: {
    query?: string | null;
    category?: VaultCategory | null;
  }): Promise<VaultOwnerListResult>;

  /** Resolve one record's stored secret by id. Audited. */
  ownerReveal(id: string): Promise<VaultRevealedRecord>;

  /**
   * Delete one record by id, ignoring site scope. Audited. Accepts a pending
   * id too, so the echoed metadata is a record or a pending shape.
   */
  ownerRemove(
    id: string,
  ): Promise<
    (VaultPublicRecord | VaultPendingRecord) & {
      removed: true;
      auditWarning?: VaultAuditWarning;
    }
  >;

  /** Recent metadata-only audit entries, newest first. */
  ownerAudit(options?: { limit?: number }): Promise<{ entries: VaultAuditEntry[] }>;
}

export const VAULT_CATEGORIES: readonly VaultCategory[];
export const VAULT_MATCH_MODES: readonly VaultMatchMode[];

export function createLocalCredentialVault(
  options?: string | LocalCredentialVaultOptions,
): LocalCredentialVault;
