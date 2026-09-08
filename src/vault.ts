import { execFile } from "node:child_process";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { constants as FS_CONSTANTS } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";

import { getDomain } from "tldts";

import {
  redactSecretsDeep,
  VAULT_MATCH_MODES,
} from "./credential-constants.js";
import { defaultHome } from "./home.js";
import {
  isBoolean,
  isCallable,
  isNumber,
  isRecord,
  isString,
  stringValue,
  type UntrustedValue,
  untrustedField,
} from "./untrusted-value.js";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const KEY_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const SNAPSHOT_VERSION = 1;
const SNAPSHOT_AAD = Buffer.from("betterwright-local-credential-vault:v1");
const MAX_PLAINTEXT_BYTES = 4 * 1024 * 1024;
const MAX_CIPHERTEXT_FILE_BYTES = 6 * 1024 * 1024;
const MAX_AUDIT_BYTES = 4 * 1024 * 1024;
const MAX_RECORDS = 4096;
const MAX_PENDING_SECRETS = 64;
const MAX_ACTIVE_SECRETS = 256;
const MAX_FIELDS_BYTES = 256 * 1024;
const MAX_SECRET_CHARS = 64 * 1024;
const DEFAULT_PENDING_TTL_MS = 60_000;
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_STALE_LOCK_MS = 30_000;
const PROCESS_IDENTITY_TIMEOUT_MS = 250;
const WINDOWS_PROCESS_IDENTITY_TIMEOUT_MS = 2_000;
const PROCESS_IDENTITY_MAX_BUFFER = 1024;
const MUTATION_AUDIT_WARNING = Object.freeze({
  code: "AUDIT_WRITE_FAILED",
  message: "Credential vault mutation succeeded, but its audit entry could not be written.",
});
const execFileAsync = promisify(execFile);

export const VAULT_CATEGORIES = Object.freeze([
  "login",
  "credit-card",
  "identity",
  "api-credential",
  "secure-note",
  "ssh-key",
]);

export { VAULT_MATCH_MODES };

const CATEGORY_SET = new Set(VAULT_CATEGORIES);
const MATCH_MODE_SET = new Set(VAULT_MATCH_MODES);
const operationQueues = new Map();

export class LocalCredentialVaultError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "LocalCredentialVaultError";
    this.code = code;
  }
}

function vaultError(message, code) {
  return new LocalCredentialVaultError(message, code);
}

function isMissing(error) {
  return error?.code === "ENOENT";
}

function isRenameCollision(error) {
  return ["EEXIST", "ENOTEMPTY"].includes(error?.code);
}

function isWindowsRenameDestinationError(error) {
  return process.platform === "win32" && ["EACCES", "EPERM"].includes(error?.code);
}

async function pathExists(candidate) {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function normalizeOptions(options) {
  if (isString(options)) return { dir: options };
  if (options == null) return {};
  // Guard an alias: narrowing `options` itself would type the returned object
  // as bare `object` and break the constructor's untyped property reads.
  const candidate: UntrustedValue = options;
  if (!isRecord(candidate)) {
    throw new TypeError("LocalCredentialVault options must be a path or an object.");
  }
  return options;
}

function boundedInteger(value, fallback, minimum, maximum, label) {
  if (value == null) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw vaultError(`${label} must be an integer from ${minimum} to ${maximum}.`, "BAD_INPUT");
  }
  return number;
}

function requiredString(value, label, maximum = 1024) {
  if (!isString(value) || !value.trim()) {
    throw vaultError(`${label} is required.`, "BAD_INPUT");
  }
  if (value.length > maximum) {
    throw vaultError(`${label} is too long.`, "BAD_INPUT");
  }
  return value;
}

function optionalString(value, label, maximum = 1024, fallback = null) {
  if (value == null) return fallback;
  if (!isString(value)) {
    throw vaultError(`${label} must be a string.`, "BAD_INPUT");
  }
  if (value.length > maximum) {
    throw vaultError(`${label} is too long.`, "BAD_INPUT");
  }
  return value;
}

function normalizeCategory(value, fallback = "login") {
  const category = value == null ? fallback : String(value).trim().toLowerCase();
  if (!CATEGORY_SET.has(category)) {
    throw vaultError(`Unsupported credential category: ${category || "(empty)"}.`, "BAD_INPUT");
  }
  return category;
}

function normalizeMatchMode(value, fallback = "base-domain") {
  const mode = value == null ? fallback : String(value).trim().toLowerCase();
  if (!MATCH_MODE_SET.has(mode)) {
    throw vaultError(`Unsupported credential URL match mode: ${mode || "(empty)"}.`, "BAD_INPUT");
  }
  return mode;
}

function normalizeHttpOrigin(value) {
  let parsed;
  try {
    parsed = new URL(requiredString(value, "Credential origin", 8192));
  } catch (error) {
    if (error instanceof LocalCredentialVaultError) throw error;
    throw vaultError("Credential origin must be a valid http(s) URL.", "BAD_ORIGIN");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw vaultError("Credential origin must use http or https.", "BAD_ORIGIN");
  }
  parsed.username = "";
  parsed.password = "";
  parsed.pathname = "/";
  parsed.search = "";
  parsed.hash = "";
  if (!parsed.hostname.startsWith("[") && parsed.hostname.endsWith(".")) {
    parsed.hostname = parsed.hostname.slice(0, -1);
  }
  return Object.freeze({
    origin: parsed.origin,
    protocol: parsed.protocol,
    hostname: parsed.hostname.toLowerCase(),
  });
}

function bareIpHostname(hostname) {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

function localBaseDomain(hostname) {
  const labels = hostname.split(".").filter(Boolean);
  if (labels.at(-1) !== "localhost" || labels.length < 2) return hostname;
  return `${labels.at(-2)}.localhost`;
}

function baseDomain(hostname) {
  const bare = bareIpHostname(hostname);
  if (net.isIP(bare) || !hostname.includes(".")) return hostname;
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    return localBaseDomain(hostname);
  }
  return (
    getDomain(hostname, {
      allowPrivateDomains: true,
      extractHostname: false,
    }) || hostname
  );
}

function scopeMatches(scope, target) {
  if (scope.matchMode === "never") return false;
  const source = normalizeHttpOrigin(scope.origin);
  // A credential captured over TLS is never offered to a plaintext page.
  // HTTP-scoped local/dev credentials may still follow an upgrade to HTTPS.
  if (source.protocol === "https:" && target.protocol !== "https:") return false;
  if (scope.matchMode === "exact-origin") return source.origin === target.origin;
  if (scope.matchMode === "host") return source.hostname === target.hostname;
  return baseDomain(source.hostname) === baseDomain(target.hostname);
}

function managementScopeMatches(scope, target) {
  if (scope.matchMode !== "never") return scopeMatches(scope, target);
  const source = normalizeHttpOrigin(scope.origin);
  return source.origin === target.origin;
}

function pendingScopeMatches(pending, target) {
  if (pending.matchMode !== "never") return scopeMatches(pending, target);
  return pending.creationOrigin === target.origin;
}

/**
 * Constant-time secret comparison. Both operands are local plaintext the
 * process already holds, so this is defence in depth rather than a fix for a
 * known oracle — but a length-independent compare costs nothing here.
 */
function secretsEqual(left, right) {
  if (!isString(left) || !isString(right)) return false;
  const a = createHash("sha256").update(left, "utf8").digest();
  const b = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(a, b);
}

function upgradedScopeOrigin(record, target) {
  const source = normalizeHttpOrigin(record.origin);
  return source.protocol === "http:" && target.protocol === "https:"
    ? target.origin
    : record.origin;
}

function sameUsername(left, right) {
  return String(left || "").toLocaleLowerCase() === String(right || "").toLocaleLowerCase();
}

function recordTimestamp(record) {
  const value = Date.parse(record.updatedAt || record.createdAt || "");
  return Number.isFinite(value) ? value : 0;
}

function newest(records) {
  let selected = null;
  let selectedTime = -1;
  let selectedIndex = -1;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const timestamp = recordTimestamp(record);
    if (timestamp > selectedTime || (timestamp === selectedTime && index > selectedIndex)) {
      selected = record;
      selectedTime = timestamp;
      selectedIndex = index;
    }
  }
  return selected;
}

function recordVersion(record) {
  return createHash("sha256").update(JSON.stringify(record)).digest("base64url");
}

function publicRecord(record) {
  return {
    id: record.id,
    origin: record.origin,
    matchMode: record.matchMode,
    username: record.username,
    label: record.label,
    category: record.category,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

// `id` is present only for a rotation, naming the record it will replace.
interface PendingIdentity {
  pendingId: string;
  id?: string;
}

function publicPendingRecord(pending) {
  const identity: PendingIdentity = { pendingId: pending.pendingId };
  if (pending.recordId) identity.id = pending.recordId;
  return {
    ...identity,
    origin: pending.creationOrigin,
    matchMode: pending.matchMode,
    username: pending.username,
    label: pending.label,
    category: "login",
    createdAt: pending.createdAt,
    expiresAt: pending.expiresAt,
    expired: Date.now() >= Date.parse(pending.expiresAt),
  };
}

function generationFingerprint(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("base64url");
}

function attachPendingCredential(error, pendingCredential) {
  const failure = error instanceof Error ? error : new Error(String(error));
  try {
    failure.pendingCredential = pendingCredential;
    return failure;
  } catch {
    const wrapped = new Error(failure.message, { cause: failure });
    wrapped.code = failure.code;
    wrapped.pendingCredential = pendingCredential;
    return wrapped;
  }
}

/** A JSON value as accepted for credential fields and bounded by cloneJsonValue. */
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

function cloneJsonValue(value, depth = 0, seen = new WeakSet()) {
  if (value == null || isBoolean(value) || isString(value)) return value;
  if (isNumber(value)) {
    if (!Number.isFinite(value)) throw vaultError("Credential fields must be JSON values.", "BAD_INPUT");
    return value;
  }
  if ((!isRecord(value) && !Array.isArray(value)) || depth >= 12 || seen.has(value)) {
    throw vaultError("Credential fields must be bounded, acyclic JSON values.", "BAD_INPUT");
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > 2048) throw vaultError("Credential fields contain too many values.", "BAD_INPUT");
      return value.map((item) => cloneJsonValue(item, depth + 1, seen));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw vaultError("Credential fields must contain plain objects.", "BAD_INPUT");
    }
    const entries = Object.entries(value);
    if (entries.length > 2048) throw vaultError("Credential fields contain too many values.", "BAD_INPUT");
    const output = Object.create(null);
    for (const [key, item] of entries) {
      if (key.length > 256 || ["__proto__", "constructor", "prototype"].includes(key)) {
        throw vaultError("Credential fields contain an invalid key.", "BAD_INPUT");
      }
      output[key] = cloneJsonValue(item, depth + 1, seen);
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

function normalizeFields(value) {
  if (value == null) return null;
  if (!isRecord(value)) {
    throw vaultError("Credential fields must be an object.", "BAD_INPUT");
  }
  const fields = cloneJsonValue(value);
  if (Buffer.byteLength(JSON.stringify(fields)) > MAX_FIELDS_BYTES) {
    throw vaultError("Credential fields are too large.", "BAD_INPUT");
  }
  return fields;
}

function visitStrings(value, callback, seen = new WeakSet()) {
  if (isString(value)) {
    callback(value);
    return;
  }
  if ((!isRecord(value) && !Array.isArray(value)) || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) visitStrings(item, callback, seen);
    return;
  }
  for (const item of Object.values(value)) visitStrings(item, callback, seen);
}

function generatePassword(length, includeSymbols) {
  const lower = "abcdefghijkmnopqrstuvwxyz";
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const digits = "23456789";
  const symbols = "!@#$%^&*()-_=+[]{}:,.?";
  const groups = includeSymbols ? [lower, upper, digits, symbols] : [lower, upper, digits];
  const all = groups.join("");
  const characters = groups.map((group) => group[randomInt(group.length)]);
  while (characters.length < length) characters.push(all[randomInt(all.length)]);
  for (let index = characters.length - 1; index > 0; index -= 1) {
    const swap = randomInt(index + 1);
    [characters[index], characters[swap]] = [characters[swap], characters[index]];
  }
  return characters.join("");
}

function encodeEnvelope(snapshot, key) {
  const plaintext = Buffer.from(JSON.stringify(snapshot));
  if (plaintext.length > MAX_PLAINTEXT_BYTES) {
    throw vaultError("Credential vault has reached its storage limit.", "VAULT_TOO_LARGE");
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: AUTH_TAG_BYTES });
  cipher.setAAD(SNAPSHOT_AAD);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const envelope = Buffer.from(
    `${JSON.stringify({
      version: SNAPSHOT_VERSION,
      algorithm: "aes-256-gcm",
      iv: iv.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
    })}\n`,
  );
  plaintext.fill(0);
  if (envelope.length > MAX_CIPHERTEXT_FILE_BYTES) {
    throw vaultError("Credential vault has reached its storage limit.", "VAULT_TOO_LARGE");
  }
  return envelope;
}

function strictBase64url(value, label, expectedLength = null) {
  if (!isString(value) || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw vaultError(`Credential vault ${label} is invalid.`, "VAULT_CORRUPT");
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value || (expectedLength != null && decoded.length !== expectedLength)) {
    throw vaultError(`Credential vault ${label} is invalid.`, "VAULT_CORRUPT");
  }
  return decoded;
}

// The decoded snapshot is plaintext this module wrote and AES-GCM
// authenticated, but it is still re-validated field by field on every load so
// a foreign or hand-edited plaintext can never reach the request handlers.
// The decoders below claim only what they check; the fields they leave as
// `UntrustedValue` (record secrets, pending timestamps) are validated — or
// deliberately tolerated — by their consumers.

interface PersistedSnapshot {
  version: number;
  revision: number;
  records: UntrustedValue[];
  pending?: UntrustedValue;
}

function isPersistedSnapshot(value: UntrustedValue): value is PersistedSnapshot {
  if (!isRecord(value)) return false;
  const revision = untrustedField(value, "revision");
  const records = untrustedField(value, "records");
  return (
    untrustedField(value, "version") === SNAPSHOT_VERSION &&
    isNumber(revision) &&
    Number.isSafeInteger(revision) &&
    revision >= 0 &&
    Array.isArray(records) &&
    records.length <= MAX_RECORDS
  );
}

interface PersistedRecord {
  id: string;
  origin: string;
  matchMode: string;
  username: string;
  label?: string | null;
  category: string;
  createdAt: string;
  updatedAt: string;
}

function isPersistedRecord(value: UntrustedValue): value is PersistedRecord {
  if (!isRecord(value)) return false;
  const category = untrustedField(value, "category");
  const matchMode = untrustedField(value, "matchMode");
  const label = untrustedField(value, "label");
  return (
    isString(untrustedField(value, "id")) &&
    isString(category) &&
    CATEGORY_SET.has(category) &&
    isString(matchMode) &&
    MATCH_MODE_SET.has(matchMode) &&
    isString(untrustedField(value, "origin")) &&
    isString(untrustedField(value, "username")) &&
    (label == null || isString(label)) &&
    isString(untrustedField(value, "createdAt")) &&
    isString(untrustedField(value, "updatedAt"))
  );
}

interface PersistedPendingSecret {
  pendingId: string;
  recordId: string | null;
  recordVersion: string | null;
  requestFingerprint?: string;
  origin: string;
  creationOrigin: string;
  matchMode: string;
  usernameOverride: boolean;
  username: string;
  labelOverride: boolean;
  label: string | null;
  secret: string;
  createdAt?: UntrustedValue;
  updatedAt?: UntrustedValue;
  expiresAt?: UntrustedValue;
}

function isPersistedPendingSecret(value: UntrustedValue): value is PersistedPendingSecret {
  if (!isRecord(value)) return false;
  const pendingId = untrustedField(value, "pendingId");
  const recordId = untrustedField(value, "recordId");
  const recordVersion = untrustedField(value, "recordVersion");
  const requestFingerprint = untrustedField(value, "requestFingerprint");
  const matchMode = untrustedField(value, "matchMode");
  const username = untrustedField(value, "username");
  const label = untrustedField(value, "label");
  const secret = untrustedField(value, "secret");
  return (
    isString(pendingId) &&
    pendingId.length > 0 &&
    pendingId.length <= 256 &&
    (recordId === null ||
      (isString(recordId) && recordId.length > 0 && recordId.length <= 256)) &&
    (recordVersion === null || isString(recordVersion)) &&
    (requestFingerprint === undefined ||
      (isString(requestFingerprint) && requestFingerprint.length > 0)) &&
    isString(untrustedField(value, "origin")) &&
    isString(untrustedField(value, "creationOrigin")) &&
    isString(matchMode) &&
    MATCH_MODE_SET.has(matchMode) &&
    isBoolean(untrustedField(value, "usernameOverride")) &&
    isString(username) &&
    username.length <= 1024 &&
    isBoolean(untrustedField(value, "labelOverride")) &&
    (label === null || (isString(label) && label.length <= 1024)) &&
    isString(secret) &&
    secret.length >= 12 &&
    secret.length <= 128 &&
    // A pending rotation must pin the exact record version it read.
    (recordId === null) === (recordVersion === null)
  );
}

function validateSnapshot(snapshot) {
  // Guard an alias: narrowing `snapshot` itself would retype the returned
  // object and its arrays for the untyped request handlers downstream.
  const container: UntrustedValue = snapshot;
  if (!isPersistedSnapshot(container)) {
    throw vaultError("Credential vault snapshot is invalid.", "VAULT_CORRUPT");
  }
  if (container.pending === undefined) container.pending = [];
  if (!Array.isArray(container.pending) || container.pending.length > MAX_PENDING_SECRETS) {
    throw vaultError("Credential vault snapshot is invalid.", "VAULT_CORRUPT");
  }
  for (const record of container.records) {
    if (!isPersistedRecord(record)) {
      throw vaultError("Credential vault contains an invalid record.", "VAULT_CORRUPT");
    }
    normalizeHttpOrigin(record.origin);
  }
  const pendingIds = new Set();
  for (const pending of container.pending) {
    if (!isPersistedPendingSecret(pending) || pendingIds.has(pending.pendingId)) {
      throw vaultError("Credential vault contains an invalid pending secret.", "VAULT_CORRUPT");
    }
    // `|| ""` before coercing mirrors Date.parse's rejection of falsy
    // non-string timestamps: a numeric 0 must stay invalid, not become "0".
    const createdAtMs = Date.parse(stringValue(pending.createdAt || ""));
    const updatedAtMs = Date.parse(stringValue(pending.updatedAt || ""));
    const expiresAtMs = Date.parse(stringValue(pending.expiresAt || ""));
    if (
      !Number.isFinite(createdAtMs) ||
      !Number.isFinite(updatedAtMs) ||
      !Number.isFinite(expiresAtMs) ||
      expiresAtMs < createdAtMs
    ) {
      throw vaultError("Credential vault contains an invalid pending secret.", "VAULT_CORRUPT");
    }
    if (normalizeHttpOrigin(pending.origin).origin !== pending.origin) {
      throw vaultError("Credential vault contains an invalid pending secret.", "VAULT_CORRUPT");
    }
    if (normalizeHttpOrigin(pending.creationOrigin).origin !== pending.creationOrigin) {
      throw vaultError("Credential vault contains an invalid pending secret.", "VAULT_CORRUPT");
    }
    if (pending.recordVersion !== null) {
      strictBase64url(pending.recordVersion, "pending record version", 32);
    }
    if (pending.requestFingerprint !== undefined) {
      strictBase64url(pending.requestFingerprint, "pending request fingerprint", 32);
    }
    pendingIds.add(pending.pendingId);
  }
  return snapshot;
}

function decodeEnvelope(contents, key) {
  let envelope;
  try {
    envelope = JSON.parse(contents.toString("utf8"));
    if (
      envelope?.version !== SNAPSHOT_VERSION ||
      envelope?.algorithm !== "aes-256-gcm" ||
      !isString(envelope?.ciphertext)
    ) {
      throw new Error("invalid envelope");
    }
    const iv = strictBase64url(envelope.iv, "IV", IV_BYTES);
    const tag = strictBase64url(envelope.tag, "authentication tag", AUTH_TAG_BYTES);
    const ciphertext = strictBase64url(envelope.ciphertext, "ciphertext");
    if (ciphertext.length > MAX_PLAINTEXT_BYTES) throw new Error("ciphertext is too large");
    const decipher = createDecipheriv("aes-256-gcm", key, iv, {
      authTagLength: AUTH_TAG_BYTES,
    });
    decipher.setAAD(SNAPSHOT_AAD);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    try {
      return validateSnapshot(JSON.parse(plaintext.toString("utf8")));
    } finally {
      plaintext.fill(0);
    }
  } catch (error) {
    if (error instanceof LocalCredentialVaultError && error.code === "VAULT_CORRUPT") throw error;
    throw vaultError(
      "Credential vault authentication failed; its ciphertext is corrupted or its key does not match.",
      "VAULT_AUTH_FAILED",
    );
  }
}

async function ensurePrivateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
  const stats = await lstat(directory);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw vaultError("Credential vault directory must be a real directory.", "UNSAFE_PATH");
  }
  await chmod(directory, DIRECTORY_MODE);
}

async function regularFileStats(file, { missing = false }: any = {}) {
  try {
    const stats = await lstat(file);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw vaultError("Credential vault files must be regular files.", "UNSAFE_PATH");
    }
    return stats;
  } catch (error) {
    if (missing && isMissing(error)) return null;
    throw error;
  }
}

function readFlags() {
  const noFollow = process.platform === "win32" ? 0 : FS_CONSTANTS.O_NOFOLLOW || 0;
  return FS_CONSTANTS.O_RDONLY | noFollow;
}

async function readBoundedFile(file, maximum, label) {
  await regularFileStats(file);
  const handle = await open(file, readFlags());
  try {
    await handle.chmod(FILE_MODE);
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > maximum) {
      throw vaultError(`${label} exceeds its size limit.`, "VAULT_TOO_LARGE");
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (!(["EINVAL", "ENOTSUP", "EBADF", "EISDIR", "EPERM"].includes(error?.code))) throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function atomicWrite(file, contents) {
  const directory = path.dirname(file);
  const temporary = path.join(
    directory,
    `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle;
  try {
    handle = await open(temporary, "wx", FILE_MODE);
    await handle.chmod(FILE_MODE);
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = null;
    await renameOutlastingReaders(temporary, file);
    await chmod(file, FILE_MODE);
    await syncDirectory(directory);
  } catch (error) {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

// One metadata-only audit line. `id` names the affected record (or the record
// a pending rotation targets); `recovered`/`expired` mark finalizations that
// happened after the pending TTL. Secrets never appear here.
interface AuditEntry {
  at: string;
  action: string;
  origin?: string;
  id?: string;
  category?: string;
  count?: number;
  recovered?: boolean;
  expired?: boolean;
}

async function appendAudit(paths, entry: AuditEntry) {
  const line = `${JSON.stringify(entry)}\n`;
  const existing = await regularFileStats(paths.audit, { missing: true });
  if (existing && existing.size + Buffer.byteLength(line) > MAX_AUDIT_BYTES) {
    await atomicWrite(
      paths.audit,
      `${JSON.stringify({ at: entry.at, action: "audit-rotated" })}\n${line}`,
    );
    return;
  }
  await regularFileStats(paths.audit, { missing: true });
  const handle = await open(paths.audit, "a", FILE_MODE);
  try {
    await handle.chmod(FILE_MODE);
    await handle.writeFile(line);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(path.dirname(paths.audit));
}

async function appendMutationAudit(paths, entry: AuditEntry) {
  try {
    await appendAudit(paths, entry);
    return null;
  } catch {
    return MUTATION_AUDIT_WARNING;
  }
}

function withAuditWarning(result, warning) {
  return warning ? { ...result, auditWarning: { ...warning } } : result;
}

function serialize(directory, operation) {
  const previous = operationQueues.get(directory) || Promise.resolve();
  const current = previous.then(operation, operation);
  const settled = current.then(
    () => {},
    () => {},
  );
  operationQueues.set(directory, settled);
  return current.finally(() => {
    if (operationQueues.get(directory) === settled) operationQueues.delete(directory);
  });
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function linuxProcessIdentity(pid) {
  try {
    const contents = await readFile(`/proc/${pid}/stat`, "utf8");
    if (contents.length > 4096) return null;
    const openParenthesis = contents.indexOf("(");
    const closeParenthesis = contents.lastIndexOf(")");
    if (
      openParenthesis <= 0 ||
      closeParenthesis <= openParenthesis ||
      contents.slice(0, openParenthesis).trim() !== String(pid)
    ) {
      return null;
    }
    // Fields after the final ')' begin at field 3, so index 19 is field 22.
    const fields = contents.slice(closeParenthesis + 1).trim().split(/\s+/);
    const startTime = fields[19];
    return /^\d+$/.test(startTime || "") ? `linux:${startTime}` : null;
  } catch {
    return null;
  }
}

const BSD_PROCESS_PLATFORMS = new Set(["darwin", "freebsd", "openbsd", "netbsd"]);

async function bsdProcessIdentity(pid) {
  try {
    const { stdout } = await execFileAsync(
      "ps",
      ["-o", "lstart=", "-p", String(pid)],
      {
        encoding: "utf8",
        env: { ...process.env, LANG: "C", LC_ALL: "C", TZ: "UTC" },
        maxBuffer: PROCESS_IDENTITY_MAX_BUFFER,
        timeout: PROCESS_IDENTITY_TIMEOUT_MS,
        windowsHide: true,
      },
    );
    const started = String(stdout || "").trim().replace(/\s+/g, " ");
    return started && started.length <= 128 ? `${process.platform}:${started}` : null;
  } catch {
    return null;
  }
}

function windowsPowerShellPath(systemRoot) {
  const root = isString(systemRoot) ? systemRoot.trim() : "";
  if (!/^[A-Za-z]:[\\/]/.test(root) || root.split(/[\\/]+/).includes("..")) {
    return null;
  }
  return path.win32.join(
    path.win32.normalize(root),
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

async function windowsProcessIdentity(
  pid,
  execute = execFileAsync,
  systemRoot = process.env.SystemRoot ?? process.env.windir,
) {
  const powershell = windowsPowerShellPath(systemRoot);
  if (!powershell) return null;
  try {
    const script =
      `$target = Get-Process -Id ${pid} -ErrorAction Stop; ` +
      "[Console]::Out.Write($target.StartTime.ToUniversalTime().Ticks)";
    const { stdout } = await execute(
      powershell,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      {
        encoding: "utf8",
        maxBuffer: PROCESS_IDENTITY_MAX_BUFFER,
        timeout: WINDOWS_PROCESS_IDENTITY_TIMEOUT_MS,
        windowsHide: true,
      },
    );
    const ticks = String(stdout || "").trim();
    return /^\d{1,32}$/.test(ticks) && BigInt(ticks) > 0n
      ? `win32:${ticks}`
      : null;
  } catch {
    return null;
  }
}

export async function _windowsProcessIdentityForTest(pid, execute, systemRoot) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  return windowsProcessIdentity(pid, execute, systemRoot);
}

async function readProcessIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (process.platform === "linux") return linuxProcessIdentity(pid);
  if (BSD_PROCESS_PLATFORMS.has(process.platform)) return bsdProcessIdentity(pid);
  if (process.platform === "win32") return windowsProcessIdentity(pid);
  return null;
}

let currentProcessIdentityPromise = null;

function currentProcessIdentity() {
  currentProcessIdentityPromise ??= readProcessIdentity(process.pid);
  return currentProcessIdentityPromise;
}

const LOCK_OWNER_FILE = "owner.json";

async function readLockDirectory(lockPath) {
  let stats;
  try {
    stats = await lstat(lockPath);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw vaultError("Credential vault lock must be a real directory.", "UNSAFE_PATH");
  }
  let owner = null;
  let ownerStats = null;
  const ownerPath = path.join(lockPath, LOCK_OWNER_FILE);
  try {
    owner = JSON.parse(
      (await readBoundedFile(ownerPath, 4096, "Credential vault lock")).toString("utf8"),
    );
    ownerStats = await regularFileStats(ownerPath);
  } catch (error) {
    if (error instanceof LocalCredentialVaultError && error.code === "UNSAFE_PATH") throw error;
    if (!isMissing(error) && error instanceof LocalCredentialVaultError) throw error;
  }
  return { stats, owner, ownerStats };
}

function lockFingerprint(observation) {
  const { stats, owner, ownerStats } = observation;
  return createHash("sha256")
    .update(
      [
        stats.dev,
        stats.ino,
        stats.birthtimeMs,
        stats.mtimeMs,
        ownerStats?.mtimeMs || 0,
        String(owner?.token || ""),
      ].join(":"),
    )
    .digest("hex")
    .slice(0, 32);
}

async function lockIsReclaimable(observation, staleMs) {
  const pid = Number(observation.owner?.pid);
  const hasOwnerPid = Number.isSafeInteger(pid) && pid > 0;
  const leaseMtimeMs = observation.ownerStats?.mtimeMs ?? observation.stats.mtimeMs;
  const age = Date.now() - leaseMtimeMs;
  if (!hasOwnerPid) return age >= staleMs;
  if (!processIsAlive(pid)) return true;
  if (age < staleMs) return false;

  const storedIdentity = observation.owner?.processIdentity;
  if (!isString(storedIdentity) || !storedIdentity) return false;
  const liveIdentity = await readProcessIdentity(pid);
  return isString(liveIdentity) && liveIdentity !== storedIdentity;
}

async function quarantineStaleLock(lockPath, staleMs) {
  const observation = await readLockDirectory(lockPath);
  if (!observation) return true;
  if (!(await lockIsReclaimable(observation, staleMs))) return false;

  const confirmation = await readLockDirectory(lockPath);
  if (!confirmation) return true;
  if (lockFingerprint(confirmation) !== lockFingerprint(observation)) return false;
  if (!(await lockIsReclaimable(confirmation, staleMs))) return false;

  // The destination is deterministic for the observed directory and is kept
  // as a non-empty tombstone. If several processes observed the same stale
  // lock, only the first rename can succeed; every late contender collides
  // with the tombstone instead of renaming or deleting a fresh replacement.
  const tombstone = `${lockPath}.stale.${lockFingerprint(observation)}`;
  try {
    await rename(lockPath, tombstone);
    await syncDirectory(path.dirname(lockPath));
    return true;
  } catch (error) {
    if (isMissing(error)) return true;
    if (isRenameCollision(error)) return false;
    if (isWindowsRenameDestinationError(error)) {
      // Another contender's tombstone won the race: stand down.
      if (await pathExists(tombstone)) return false;
      // Windows also refuses to rename a directory whose owner still holds
      // the lease handle open inside it (research/windows-fs-probe.mjs). An
      // open lease is stronger evidence of life than the heartbeat that made
      // the lock look stale, so if the lock is still there, treat the owner
      // as alive and keep waiting. If it is gone, the owner released (or a
      // contender quarantined it) mid-race, which is the same outcome as our
      // own rename finding nothing — report it reclaimed so the caller
      // retries acquisition.
      return !(await pathExists(lockPath));
    }
    throw error;
  }
}

function lockWriteFlags() {
  const noFollow = process.platform === "win32" ? 0 : FS_CONSTANTS.O_NOFOLLOW || 0;
  return FS_CONSTANTS.O_RDWR | noFollow;
}

function lockCompromisedError() {
  return vaultError(
    "Credential vault lock ownership changed while an operation was in progress.",
    "VAULT_LOCK_COMPROMISED",
  );
}

async function verifyLockOwnership(lockPath, token, handle) {
  const [current, handleStats] = await Promise.all([
    readLockDirectory(lockPath),
    handle.stat(),
  ]);
  if (
    !current ||
    current.owner?.token !== token ||
    !current.ownerStats ||
    current.ownerStats.dev !== handleStats.dev ||
    current.ownerStats.ino !== handleStats.ino
  ) {
    throw lockCompromisedError();
  }
}

function startLockHeartbeat(lockPath, token, handle, staleMs) {
  // Renew the acquired owner inode, never a path that may now name a replacement lock.
  const intervalMs = Math.max(25, Math.floor(staleMs / 3));
  let stopped = false;
  let compromise = null;
  let inFlight = Promise.resolve();
  const recordCompromise = (error) => {
    compromise ||=
      error instanceof LocalCredentialVaultError && error.code === "VAULT_LOCK_COMPROMISED"
        ? error
        : lockCompromisedError();
  };
  const scheduleHeartbeat = () => {
    inFlight = inFlight.then(async () => {
      if (stopped || compromise) return;
      try {
        await verifyLockOwnership(lockPath, token, handle);
        const now = new Date();
        await handle.utimes(now, now);
        await verifyLockOwnership(lockPath, token, handle);
      } catch (error) {
        recordCompromise(error);
      }
    });
  };
  const timer = setInterval(scheduleHeartbeat, intervalMs);
  timer.unref();
  return {
    async assertOwned() {
      await inFlight;
      if (compromise) throw compromise;
      try {
        await verifyLockOwnership(lockPath, token, handle);
      } catch (error) {
        recordCompromise(error);
        throw compromise;
      }
    },
    async stop() {
      stopped = true;
      clearInterval(timer);
      try {
        await inFlight;
        if (!compromise) await verifyLockOwnership(lockPath, token, handle);
      } catch (error) {
        recordCompromise(error);
      }
      if (compromise) throw compromise;
    },
  };
}

// Windows refuses a rename whenever another process pins a path it touches:
// a directory cannot move while any file inside it is held open, and a file
// cannot be renamed over an open destination (research/windows-fs-probe.mjs).
// Both pins here are momentary — contenders polling readLockDirectory hold
// the lock's owner.json for a few milliseconds per poll, and a concurrent
// vault read (or an antivirus scan) holds vault.enc about as long — so a
// rename can lose that race repeatedly but never for long. Retry briefly;
// the pin vanishes as soon as the reader's descriptor closes. The lock's
// publish rename deliberately does not come through here: EPERM there is
// the collision signal that tells a contender the lock is already taken.
async function renameOutlastingReaders(from, to) {
  if (process.platform !== "win32") return rename(from, to);
  let delay = 5;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await rename(from, to);
    } catch (error) {
      if (!["EPERM", "EACCES", "EBUSY"].includes(error?.code) || attempt >= 20) {
        throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(50, delay * 2);
  }
}

async function retireOwnedLock(lockPath, token, handle, retired) {
  // `handle` is null only on the Windows path where the publish rename
  // succeeded but opening the lease afterwards failed; the token check alone
  // then decides ownership, which is sound because the token never left this
  // process.
  const [current, handleStats] = await Promise.all([
    readLockDirectory(lockPath),
    handle ? handle.stat() : null,
  ]);
  if (!current || current.owner?.token !== token || !current.ownerStats) {
    return false;
  }
  if (
    handleStats &&
    (current.ownerStats.dev !== handleStats.dev ||
      current.ownerStats.ino !== handleStats.ino)
  ) {
    return false;
  }
  // Windows cannot rename a directory while a handle is open to a file
  // inside it (research/windows-fs-probe.mjs), so the lease closes first
  // there. Nothing can steal the lock in the gap: contenders only reclaim
  // locks whose lease has gone stale (lockIsReclaimable), and this one's
  // heartbeat is fresh.
  if (process.platform === "win32" && handle) {
    await handle.close().catch(() => {});
  }
  await renameOutlastingReaders(lockPath, retired);
  try {
    await syncDirectory(path.dirname(lockPath));
  } finally {
    await rm(retired, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 10,
    });
  }
  return true;
}

async function createLockCandidate(lockPath, token) {
  const candidate = `${lockPath}.candidate.${process.pid}.${token}`;
  await mkdir(candidate, { mode: DIRECTORY_MODE });
  try {
    await chmod(candidate, DIRECTORY_MODE);
    const processIdentity = await currentProcessIdentity();
    await atomicWrite(
      path.join(candidate, LOCK_OWNER_FILE),
      `${JSON.stringify({
        pid: process.pid,
        processIdentity,
        token,
        createdAt: Date.now(),
      })}\n`,
    );
    await syncDirectory(candidate);
    // POSIX opens the lease handle before the publish rename, so the handle
    // provably references the exact inode this process created — the rename
    // then carries that inode to the published path unchanged. Windows cannot
    // do this: renaming a directory fails with EPERM while any handle is open
    // to a file inside it (research/windows-fs-probe.mjs), so there the
    // handle opens after publish and ownership is re-proven by token and
    // file identity instead (see acquireLock).
    const leaseHandle =
      process.platform === "win32"
        ? null
        : await open(path.join(candidate, LOCK_OWNER_FILE), lockWriteFlags());
    return { path: candidate, leaseHandle };
  } catch (error) {
    await rm(candidate, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function acquireLock(paths, timeoutMs, staleMs, afterPublish = null) {
  const started = Date.now();
  while (true) {
    const token = randomUUID();
    const candidate = await createLockCandidate(paths.lock, token);
    let observedWindowsDestination = false;
    let published = false;
    try {
      let retriedWindowsReleaseRace = false;
      while (true) {
        try {
          await rename(candidate.path, paths.lock);
          published = true;
          if (candidate.leaseHandle === null) {
            // Windows: the lease handle could not be held across the publish
            // rename, so acquire it now and prove it is really ours — the
            // owner file at the published path must carry the token only this
            // process knows, and the handle must be that same file (dev+ino).
            candidate.leaseHandle = await open(
              path.join(paths.lock, LOCK_OWNER_FILE),
              lockWriteFlags(),
            );
            await verifyLockOwnership(paths.lock, token, candidate.leaseHandle);
          }
          await afterPublish?.(paths.lock);
          break;
        } catch (error) {
          if (isWindowsRenameDestinationError(error)) {
            const current = await readLockDirectory(paths.lock);
            if (current !== null) {
              observedWindowsDestination = true;
              throw error;
            }
          }
          if (isWindowsRenameDestinationError(error) && !retriedWindowsReleaseRace) {
            // Windows reports an existing destination as EACCES/EPERM. The
            // owner may release between that error and our observation, so
            // retry this intact candidate once before treating it as a real
            // access failure.
            retriedWindowsReleaseRace = true;
            continue;
          }
          throw error;
        }
      }
      await syncDirectory(path.dirname(paths.lock));
      const heartbeat = startLockHeartbeat(paths.lock, token, candidate.leaseHandle, staleMs);
      const release = async () => {
        let compromise = null;
        try {
          await heartbeat.stop();
        } catch (error) {
          compromise = error;
        }
        const retired = `${paths.lock}.released.${process.pid}.${token}`;
        try {
          await retireOwnedLock(
            paths.lock,
            token,
            candidate.leaseHandle,
            retired,
          );
        } catch (error) {
          if (!isMissing(error)) throw error;
        } finally {
          await candidate.leaseHandle?.close().catch(() => {});
        }
        if (compromise) throw compromise;
      };
      release.assertOwned = heartbeat.assertOwned;
      return release;
    } catch (error) {
      if (published) {
        const retired = `${paths.lock}.failed.${process.pid}.${token}`;
        await retireOwnedLock(
          paths.lock,
          token,
          candidate.leaseHandle,
          retired,
        ).catch(() => {});
      }
      await candidate.leaseHandle?.close().catch(() => {});
      await rm(candidate.path, { recursive: true, force: true }).catch(() => {});
      if (published) throw error;
      const contention =
        isRenameCollision(error) ||
        (isWindowsRenameDestinationError(error) &&
          (observedWindowsDestination ||
            (await readLockDirectory(paths.lock)) !== null));
      if (!contention) throw error;
    }

    if (Date.now() - started >= timeoutMs) {
      throw vaultError("Timed out waiting for the credential vault lock.", "VAULT_LOCK_TIMEOUT");
    }
    if (await quarantineStaleLock(paths.lock, staleMs)) continue;
    await new Promise((resolve) => setTimeout(resolve, 15 + randomInt(36)));
  }
}

function emptySnapshot() {
  return { version: SNAPSHOT_VERSION, revision: 0, records: [], pending: [] };
}

async function loadKeyAndSnapshot(paths, keyProvider?) {
  const [keyStats, dataStats] = await Promise.all([
    regularFileStats(paths.key, { missing: true }),
    regularFileStats(paths.data, { missing: true }),
  ]);
  if (!keyProvider && !keyStats && dataStats) {
    throw vaultError(
      "Credential vault key is missing; refusing to replace it while ciphertext exists.",
      "VAULT_KEY_MISSING",
    );
  }
  let key;
  if (keyProvider) {
    const supplied = await keyProvider();
    if (!(supplied instanceof Uint8Array) || supplied.length !== KEY_BYTES) {
      if (supplied instanceof Uint8Array) supplied.fill(0);
      throw vaultError("Host vault key is invalid.", "VAULT_KEY_INVALID");
    }
    // Share the caller's fresh storage so every success/error cleanup zeroes it.
    key = Buffer.from(supplied.buffer, supplied.byteOffset, supplied.byteLength);
  } else if (keyStats) {
    key = await readBoundedFile(paths.key, KEY_BYTES, "Credential vault key");
    if (key.length !== KEY_BYTES) {
      key.fill(0);
      throw vaultError("Credential vault key has an invalid length.", "VAULT_KEY_INVALID");
    }
  } else {
    key = randomBytes(KEY_BYTES);
    await atomicWrite(paths.key, key);
  }
  try {
    if (!dataStats) {
      const snapshot = emptySnapshot();
      await atomicWrite(paths.data, encodeEnvelope(snapshot, key));
      return { key, snapshot };
    }
    const contents = await readBoundedFile(
      paths.data,
      MAX_CIPHERTEXT_FILE_BYTES,
      "Credential vault ciphertext",
    );
    return { key, snapshot: decodeEnvelope(contents, key) };
  } catch (error) {
    key.fill(0);
    throw error;
  }
}

async function persistSnapshot(paths, key, snapshot) {
  snapshot.revision += 1;
  await atomicWrite(paths.data, encodeEnvelope(snapshot, key));
}

function idFromPayload(payload) {
  if (payload?.id == null) return null;
  return requiredString(String(payload.id), "Credential id", 256);
}

function pendingIdFromPayload(payload) {
  if (payload?.pendingId == null && payload?.pending_id == null) return null;
  return requiredString(String(payload.pendingId ?? payload.pending_id), "Pending credential id", 256);
}

function metadataSearch(record, query) {
  if (!query) return true;
  const metadata = publicRecord(record);
  return [metadata.id, metadata.origin, metadata.username, metadata.label, metadata.category]
    .filter((value) => isString(value))
    .some((value) => value.toLocaleLowerCase().includes(query));
}

// Finalization flags echoed to the caller: `recovered` marks a commit that
// landed after the pending TTL, `expired` the discard of one.
interface CommitOutcome {
  committed: true;
  recovered?: true;
}

interface DiscardResult {
  pendingId: string;
  discarded: true;
  expired?: true;
}

// Secret material a committed record may carry; a pending signup never has it.
interface RevealedSecretMaterial {
  notes?: string;
  fields?: Record<string, JsonValue>;
}

/**
 * Encrypted, origin-scoped credential backend for BetterWright.
 *
 * The only methods intended for integration are `handleRequest`, which
 * implements the worker vault RPC, and `redact`, which scrubs secrets that have
 * been active in this process from result envelopes.
 */
export class LocalCredentialVault {
  #activeSecrets = new Set();
  #lockAcquiredForTest = null;
  #beforeGeneratePersistForTest = null;
  #afterGeneratePersistForTest = null;
  #afterLockPublishForTest = null;
  declare dir: string;
  declare paths: {
    key: string;
    data: string;
    audit: string;
    lock: string;
  };
  declare pendingTtlMs: number;
  declare lockTimeoutMs: number;
  declare staleLockMs: number;
  declare keyProvider: (() => Promise<Uint8Array>) | undefined;

  constructor(options: any = {}) {
    const resolved = normalizeOptions(options);
    if (resolved.keyProvider != null && !isCallable(resolved.keyProvider)) {
      throw new TypeError("keyProvider must be a function.");
    }
    this.keyProvider = resolved.keyProvider;
    // Behavior note: the fallback used to hard-code ~/.betterwright, ignoring
    // BETTERWRIGHT_HOME. It now uses the shared defaultHome() so a vault
    // constructed without dir/home lands in the same home directory as every
    // other BetterWright component. The client always passes an explicit
    // home, so only direct no-option constructions are affected.
    const directory = resolved.dir
      ? path.resolve(String(resolved.dir))
      : path.resolve(String(resolved.home || defaultHome()), "vault");
    this.dir = directory;
    this.paths = Object.freeze({
      key: path.join(directory, "vault.key"),
      data: path.join(directory, "vault.enc"),
      audit: path.join(directory, "audit.jsonl"),
      lock: path.join(directory, "vault.lock"),
    });
    this.pendingTtlMs = boundedInteger(
      resolved.pendingTtlMs,
      DEFAULT_PENDING_TTL_MS,
      10,
      5 * 60_000,
      "pendingTtlMs",
    );
    this.lockTimeoutMs = boundedInteger(
      resolved.lockTimeoutMs,
      DEFAULT_LOCK_TIMEOUT_MS,
      100,
      60_000,
      "lockTimeoutMs",
    );
    this.staleLockMs = boundedInteger(
      resolved.staleLockMs,
      DEFAULT_STALE_LOCK_MS,
      100,
      10 * 60_000,
      "staleLockMs",
    );
    if (isCallable(resolved._lockAcquiredForTest)) {
      this.#lockAcquiredForTest = resolved._lockAcquiredForTest;
    }
    if (isCallable(resolved._afterGeneratePersistForTest)) {
      this.#afterGeneratePersistForTest = resolved._afterGeneratePersistForTest;
    }
    if (isCallable(resolved._beforeGeneratePersistForTest)) {
      this.#beforeGeneratePersistForTest = resolved._beforeGeneratePersistForTest;
    }
    if (isCallable(resolved._afterLockPublishForTest)) {
      this.#afterLockPublishForTest = resolved._afterLockPublishForTest;
    }
  }

  #trackSecret(value) {
    const secret = String(value ?? "");
    if (!secret) return;
    if (
      !this.#activeSecrets.has(secret) &&
      this.#activeSecrets.size >= MAX_ACTIVE_SECRETS
    ) {
      throw vaultError(
        "Credential redaction capacity was reached; close and reopen the browser before handling another secret.",
        "VAULT_SECRET_CAPACITY",
      );
    }
    this.#activeSecrets.delete(secret);
    this.#activeSecrets.add(secret);
  }

  #trackSecretMaterial(record) {
    this.#trackSecret(record.password);
    this.#trackSecret(record.notes);
    visitStrings(record.fields, (value) => this.#trackSecret(value));
  }

  #safePublicRecord(record) {
    const metadata = publicRecord(record);
    return {
      ...metadata,
      username: this.redact(metadata.username),
      label: this.redact(metadata.label),
    };
  }

  #safePublicPending(pending) {
    const metadata = publicPendingRecord(pending);
    return {
      ...metadata,
      username: this.redact(metadata.username),
      label: this.redact(metadata.label),
    };
  }

  #matchingRecords(snapshot, target, { category = null }: any = {}) {
    return snapshot.records.filter(
      (record) =>
        (category == null || record.category === category) && scopeMatches(record, target),
    );
  }

  #recordById(
    snapshot,
    id,
    target,
    { category = null, management = false }: any = {},
  ) {
    const record = snapshot.records.find((candidate) => candidate.id === id);
    if (
      !record ||
      (category != null && record.category !== category) ||
      !(management
        ? managementScopeMatches(record, target)
        : scopeMatches(record, target))
    ) {
      throw vaultError("No matching credential is available for this site.", "NOT_FOUND");
    }
    return record;
  }

  #pendingForRequest(snapshot, payload, target) {
    const pendingId = pendingIdFromPayload(payload);
    if (!pendingId) {
      throw vaultError("Pending credential action requires a pendingId.", "BAD_INPUT");
    }
    const pending = snapshot.pending.find((candidate) => candidate.pendingId === pendingId);
    if (!pending || !pendingScopeMatches(pending, target)) {
      throw vaultError("No pending generated credential is available for this site.", "PENDING_NOT_FOUND");
    }
    this.#trackSecret(pending.secret);
    return pending;
  }

  #newRecord(payload, target, now, category = normalizeCategory(payload?.category)) {
    const username = optionalString(payload?.username, "Credential username", 1024, "");
    const label = optionalString(payload?.label, "Credential label", 1024);
    const matchMode = normalizeMatchMode(payload?.matchMode ?? payload?.match_mode);
    const password =
      category === "login"
        ? requiredString(payload?.password, "Login password", MAX_SECRET_CHARS)
        : null;
    const fields = normalizeFields(payload?.fields);
    const notes = optionalString(payload?.notes, "Credential notes", MAX_SECRET_CHARS);
    const record = {
      id: `cred_${randomUUID()}`,
      origin: target.origin,
      matchMode,
      username,
      label,
      category,
      password,
      fields,
      notes,
      createdAt: now,
      updatedAt: now,
    };
    this.#trackSecretMaterial(record);
    return record;
  }

  #updatedRecord(
    record,
    payload,
    now,
    { requirePassword = false }: any = {},
  ) {
    if (payload?.category != null && normalizeCategory(payload.category) !== record.category) {
      throw vaultError("Changing a credential category is not supported.", "BAD_INPUT");
    }
    const next = {
      ...record,
      username:
        payload?.username === undefined
          ? record.username
          : optionalString(payload.username, "Credential username", 1024, ""),
      label:
        payload?.label === undefined
          ? record.label
          : optionalString(payload.label, "Credential label", 1024),
      matchMode:
        payload?.matchMode === undefined && payload?.match_mode === undefined
          ? record.matchMode
          : normalizeMatchMode(payload.matchMode ?? payload.match_mode),
      updatedAt: now,
    };
    if (payload?.password !== undefined || requirePassword) {
      if (record.category !== "login") {
        throw vaultError("Only login records have passwords.", "BAD_INPUT");
      }
      next.password = requiredString(payload?.password, "Login password", MAX_SECRET_CHARS);
    }
    if (payload?.fields !== undefined) next.fields = normalizeFields(payload.fields);
    if (payload?.notes !== undefined) {
      next.notes = optionalString(payload.notes, "Credential notes", MAX_SECRET_CHARS);
    }
    this.#trackSecretMaterial(next);
    return next;
  }

  async #list(snapshot, payload, target) {
    const category = payload?.category == null ? null : normalizeCategory(payload.category);
    const text = optionalString(payload?.text, "Credential search text", 1024, "")
      .trim()
      .toLocaleLowerCase();
    const records = this.#matchingRecords(snapshot, target, { category })
      .filter((record) => metadataSearch(record, text))
      .sort((left, right) => recordTimestamp(right) - recordTimestamp(left));
    await appendAudit(this.paths, {
      at: new Date().toISOString(),
      action: "list",
      origin: target.origin,
      count: records.length,
    });
    return { credentials: records.map((record) => this.#safePublicRecord(record)) };
  }

  async #listPending(snapshot, target) {
    const pendingCredentials = snapshot.pending
      .filter((pending) => pendingScopeMatches(pending, target))
      .sort((left, right) => recordTimestamp(right) - recordTimestamp(left))
      .map((pending) => this.#safePublicPending(pending));
    await appendAudit(this.paths, {
      at: new Date().toISOString(),
      action: "list-pending",
      origin: target.origin,
      count: pendingCredentials.length,
    });
    return { pendingCredentials };
  }

  async #save(snapshot, key, payload, target) {
    const now = new Date().toISOString();
    const category = normalizeCategory(payload?.category);

    // `deferToPending` is the browser capture sensor saying "save this unless
    // an in-flight generation already owns this exact value". `generateAndFill`
    // types its secret into the page, so the sensor sees an ordinary accepted
    // submission and would store a second, base-domain-scoped copy of a
    // credential the caller may have deliberately scoped to one host.
    //
    // The comparison is against the stored secret, not the username: deciding
    // by account name would suppress a *different* password typed at the same
    // site during the pending window — a fill that failed and was retried by
    // hand — and that password would be lost for good. Only the vault can
    // compare, because the pending secret never leaves it.
    if (payload?.deferToPending) {
      const offered = optionalString(payload?.password, "Credential password", 4096, "");
      const owner = offered
        ? snapshot.pending.find(
            (pending) =>
              Date.now() < Date.parse(pending.expiresAt) &&
              pendingScopeMatches(pending, target) &&
              secretsEqual(pending.secret, offered),
          )
        : null;
      if (owner) return { deferred: true, pendingId: owner.pendingId };
    }
    const explicitId = idFromPayload(payload);
    let record = null;
    let action = "save-created";
    if (explicitId) {
      record = this.#recordById(snapshot, explicitId, target);
    } else if (payload?.upsert !== false && category === "login") {
      const username = optionalString(payload?.username, "Credential username", 1024, "");
      record = newest(
        this.#matchingRecords(snapshot, target, { category: "login" }).filter((candidate) =>
          sameUsername(candidate.username, username),
        ),
      );
    }
    if (record) {
      const replacement = this.#updatedRecord(record, { ...payload, category }, now, {
        requirePassword: category === "login",
      });
      if (category === "login") replacement.origin = upgradedScopeOrigin(record, target);
      snapshot.records[snapshot.records.indexOf(record)] = replacement;
      record = replacement;
      action = "save-updated";
    } else {
      if (snapshot.records.length >= MAX_RECORDS) {
        throw vaultError("Credential vault has reached its record limit.", "VAULT_TOO_LARGE");
      }
      record = this.#newRecord({ ...payload, category }, target, now, category);
      snapshot.records.push(record);
    }
    await persistSnapshot(this.paths, key, snapshot);
    const auditWarning = await appendMutationAudit(this.paths, {
      at: now,
      action,
      origin: target.origin,
      id: record.id,
      category: record.category,
    });
    return withAuditWarning(this.#safePublicRecord(record), auditWarning);
  }

  async #update(snapshot, key, payload, target) {
    const id = idFromPayload(payload);
    if (!id) throw vaultError("Credential update requires an id.", "BAD_INPUT");
    const record = this.#recordById(snapshot, id, target, { management: true });
    const now = new Date().toISOString();
    const replacement = this.#updatedRecord(record, payload, now);
    if (payload?.password !== undefined && scopeMatches(record, target)) {
      replacement.origin = upgradedScopeOrigin(record, target);
    }
    snapshot.records[snapshot.records.indexOf(record)] = replacement;
    await persistSnapshot(this.paths, key, snapshot);
    const auditWarning = await appendMutationAudit(this.paths, {
      at: now,
      action: "update",
      origin: target.origin,
      id,
      category: replacement.category,
    });
    return withAuditWarning(this.#safePublicRecord(replacement), auditWarning);
  }

  async #remove(snapshot, key, payload, target) {
    const id = idFromPayload(payload);
    if (!id) throw vaultError("Credential removal requires an id.", "BAD_INPUT");
    const record = this.#recordById(snapshot, id, target, { management: true });
    snapshot.records.splice(snapshot.records.indexOf(record), 1);
    const now = new Date().toISOString();
    await persistSnapshot(this.paths, key, snapshot);
    const auditWarning = await appendMutationAudit(this.paths, {
      at: now,
      action: "remove",
      origin: target.origin,
      id,
      category: record.category,
    });
    return withAuditWarning(
      { ...this.#safePublicRecord(record), removed: true },
      auditWarning,
    );
  }

  async #fill(snapshot, payload, target) {
    const id = idFromPayload(payload);
    const requestedUsername =
      payload?.username == null
        ? null
        : optionalString(payload.username, "Credential username", 1024, "");
    let matches = this.#matchingRecords(snapshot, target, { category: "login" });
    if (id) matches = matches.filter((record) => record.id === id);
    if (requestedUsername != null) {
      matches = matches.filter((record) => sameUsername(record.username, requestedUsername));
    }
    if (matches.length > 1) {
      throw vaultError(
        "Multiple credentials match this site. List credentials and choose one by id.",
        "AMBIGUOUS_CREDENTIAL",
      );
    }
    const record = matches[0] || null;
    if (!record || !isString(record.password) || !record.password) {
      throw vaultError("No matching credential is available for this site.", "NOT_FOUND");
    }
    this.#trackSecret(record.password);
    await appendAudit(this.paths, {
      at: new Date().toISOString(),
      action: "fill",
      origin: target.origin,
      id: record.id,
      category: record.category,
    });
    return { ...publicRecord(record), secret: record.password };
  }

  async #generate(snapshot, key, payload, target) {
    const length = boundedInteger(payload?.length, 24, 12, 128, "Generated password length");
    const includeSymbols = payload?.include_symbols ?? payload?.includeSymbols ?? true;
    if (!isBoolean(includeSymbols)) {
      throw vaultError("includeSymbols must be a boolean.", "BAD_INPUT");
    }
    const recordId = idFromPayload(payload);
    const existing = recordId
      ? this.#recordById(snapshot, recordId, target, { category: "login" })
      : null;
    const pendingId =
      pendingIdFromPayload(payload) || `pending_${randomUUID()}`;
    const matchMode =
      existing?.matchMode ||
      normalizeMatchMode(payload?.matchMode ?? payload?.match_mode);
    const usernameOverride = payload?.username !== undefined;
    const username = usernameOverride
      ? optionalString(payload.username, "Credential username", 1024, "")
      : existing?.username || "";
    const labelOverride = payload?.label !== undefined;
    const label = labelOverride
      ? optionalString(payload.label, "Credential label", 1024)
      : existing?.label || null;
    const requestFingerprint = generationFingerprint({
      pendingId,
      recordId: existing?.id || null,
      recordVersion: existing ? recordVersion(existing) : null,
      creationOrigin: target.origin,
      matchMode,
      usernameOverride,
      username,
      labelOverride,
      label,
      length,
      includeSymbols,
    });
    const duplicate = snapshot.pending.find(
      (candidate) => candidate.pendingId === pendingId,
    );
    if (duplicate) {
      if (duplicate.requestFingerprint !== requestFingerprint) {
        throw vaultError(
          "Pending credential id is already bound to a different generation request.",
          "PENDING_CONFLICT",
        );
      }
      this.#trackSecret(duplicate.secret);
      const retriedEntry: AuditEntry = {
        at: new Date().toISOString(),
        action: "generate-pending-retried",
        origin: target.origin,
        category: "login",
      };
      if (duplicate.recordId) retriedEntry.id = duplicate.recordId;
      const auditWarning = await appendMutationAudit(this.paths, retriedEntry);
      return withAuditWarning(
        { ...this.#safePublicPending(duplicate), secret: duplicate.secret },
        auditWarning,
      );
    }
    if (snapshot.pending.length >= MAX_PENDING_SECRETS) {
      throw vaultError(
        // Addressed to the caller that hit the cap, which is model-authored
        // code: name its own remedy. The human's route out is `vault list`,
        // which already shows every uncommitted signup; deliberately not
        // advertising `vault rm` to a model that can reach a shell.
        `Credential vault has reached its pending generated-secret limit (${MAX_PENDING_SECRETS}); commit the signup you just completed with commitGenerated, or release an abandoned attempt with discardGenerated, before generating another. listPending reports the ones still open.`,
        "VAULT_TOO_LARGE",
      );
    }
    const secret = generatePassword(length, includeSymbols);
    const createdAtMs = Date.now();
    const pending = {
      pendingId,
      recordId: existing?.id || null,
      recordVersion: existing ? recordVersion(existing) : null,
      requestFingerprint,
      origin: existing?.origin || target.origin,
      creationOrigin: target.origin,
      matchMode,
      usernameOverride,
      username,
      labelOverride,
      label,
      secret,
      createdAt: new Date(createdAtMs).toISOString(),
      updatedAt: new Date(createdAtMs).toISOString(),
      expiresAt: new Date(createdAtMs + this.pendingTtlMs).toISOString(),
    };
    snapshot.pending.push(pending);
    this.#trackSecret(secret);
    try {
      await this.#beforeGeneratePersistForTest?.(this.paths.data);
      await persistSnapshot(this.paths, key, snapshot);
      await this.#afterGeneratePersistForTest?.(this.paths.data);
    } catch (error) {
      if (error?.code === "VAULT_TOO_LARGE") throw error;
      throw attachPendingCredential(error, this.#safePublicPending(pending));
    }
    const pendingEntry: AuditEntry = {
      at: pending.createdAt,
      action: existing ? "generate-rotation-pending" : "generate-pending",
      origin: target.origin,
      category: "login",
    };
    if (existing) pendingEntry.id = existing.id;
    const auditWarning = await appendMutationAudit(this.paths, pendingEntry);
    return withAuditWarning(
      {
        ...this.#safePublicPending(pending),
        secret,
      },
      auditWarning,
    );
  }

  async #commit(snapshot, key, payload, target) {
    const pending = this.#pendingForRequest(snapshot, payload, target);
    if (!pending) {
      throw vaultError("No pending generated credential is available for this site.", "PENDING_NOT_FOUND");
    }
    const recovered = Date.now() >= Date.parse(pending.expiresAt);
    const requestedId = idFromPayload(payload);
    if (requestedId && requestedId !== pending.recordId) {
      throw vaultError("Pending credential rotation id does not match.", "BAD_INPUT");
    }
    const recordId = requestedId || pending.recordId;
    const now = new Date().toISOString();
    let record;
    let action;
    if (recordId) {
      const existing = this.#recordById(snapshot, recordId, target, { category: "login" });
      if (recordVersion(existing) !== pending.recordVersion) {
        throw vaultError(
          "Saved credential changed after password generation; generate a new password before committing.",
          "STALE_PENDING",
        );
      }
      record = {
        ...existing,
        origin: upgradedScopeOrigin(existing, target),
        username:
          payload?.username === undefined
            ? pending.usernameOverride
              ? pending.username
              : existing.username
            : optionalString(payload.username, "Credential username", 1024, ""),
        label:
          payload?.label === undefined
            ? pending.labelOverride
              ? pending.label
              : existing.label
            : optionalString(payload.label, "Credential label", 1024),
        password: pending.secret,
        updatedAt: now,
      };
      snapshot.records[snapshot.records.indexOf(existing)] = record;
      action = "generate-rotation-committed";
    } else {
      if (snapshot.records.length >= MAX_RECORDS) {
        throw vaultError("Credential vault has reached its record limit.", "VAULT_TOO_LARGE");
      }
      record = {
        id: `cred_${randomUUID()}`,
        origin: upgradedScopeOrigin(pending, target),
        matchMode: pending.matchMode,
        username:
          payload?.username === undefined
            ? pending.username
            : optionalString(payload.username, "Credential username", 1024, ""),
        label:
          payload?.label === undefined
            ? pending.label
            : optionalString(payload.label, "Credential label", 1024),
        category: "login",
        password: pending.secret,
        fields: null,
        notes: null,
        createdAt: now,
        updatedAt: now,
      };
      snapshot.records.push(record);
      action = "generate-committed";
    }
    this.#trackSecret(pending.secret);
    snapshot.pending.splice(snapshot.pending.indexOf(pending), 1);
    await persistSnapshot(this.paths, key, snapshot);
    const committedEntry: AuditEntry = {
      at: now,
      action,
      origin: target.origin,
      id: record.id,
      category: "login",
    };
    if (recovered) committedEntry.recovered = true;
    const auditWarning = await appendMutationAudit(this.paths, committedEntry);
    const outcome: CommitOutcome = { committed: true };
    if (recovered) outcome.recovered = true;
    return withAuditWarning(
      {
        ...this.#safePublicRecord(record),
        pendingId: pending.pendingId,
        ...outcome,
      },
      auditWarning,
    );
  }

  async #discard(snapshot, key, payload, target) {
    const pending = this.#pendingForRequest(snapshot, payload, target);
    if (!pending) {
      throw vaultError("No pending generated credential is available for this site.", "PENDING_NOT_FOUND");
    }
    const expired = Date.now() >= Date.parse(pending.expiresAt);
    snapshot.pending.splice(snapshot.pending.indexOf(pending), 1);
    const now = new Date().toISOString();
    await persistSnapshot(this.paths, key, snapshot);
    const discardedEntry: AuditEntry = {
      at: now,
      action: "generate-discarded",
      origin: target.origin,
      category: "login",
    };
    if (pending.recordId) discardedEntry.id = pending.recordId;
    if (expired) discardedEntry.expired = true;
    const auditWarning = await appendMutationAudit(this.paths, discardedEntry);
    const result: DiscardResult = {
      pendingId: pending.pendingId,
      discarded: true,
    };
    if (expired) result.expired = true;
    return withAuditWarning(result, auditWarning);
  }

  async #dispatch(action, payload, target) {
    const { key, snapshot } = await loadKeyAndSnapshot(this.paths, this.keyProvider);
    try {
      if (action === "list") return await this.#list(snapshot, payload, target);
      if (action === "list-pending") {
        return await this.#listPending(snapshot, target);
      }
      if (action === "save") return await this.#save(snapshot, key, payload, target);
      if (action === "update") return await this.#update(snapshot, key, payload, target);
      if (action === "remove") return await this.#remove(snapshot, key, payload, target);
      if (action === "fill") return await this.#fill(snapshot, payload, target);
      if (action === "generate") return await this.#generate(snapshot, key, payload, target);
      if (action === "commit") return await this.#commit(snapshot, key, payload, target);
      if (action === "discard") return await this.#discard(snapshot, key, payload, target);
      throw vaultError(`Unsupported credential vault action: ${action || "(empty)"}.`, "BAD_ACTION");
    } finally {
      key.fill(0);
    }
  }

  async handleRequest(action, payload: any = {}, origin) {
    const name = String(action || "").trim().toLowerCase();
    if (!isRecord(payload)) {
      throw vaultError("Credential vault payload must be an object.", "BAD_INPUT");
    }
    const target = normalizeHttpOrigin(origin);
    return serialize(this.dir, async () => {
      await ensurePrivateDirectory(this.dir);
      const release = await acquireLock(
        this.paths,
        this.lockTimeoutMs,
        this.staleLockMs,
        this.#afterLockPublishForTest,
      );
      let result;
      let failure = null;
      try {
        await this.#lockAcquiredForTest?.(this.paths.lock);
        await release.assertOwned();
        result = await this.#dispatch(name, payload, target);
        await release.assertOwned();
      } catch (error) {
        failure = error;
      } finally {
        try {
          await release();
        } catch (error) {
          failure ||= error;
        }
      }
      if (failure) {
        if (name === "generate" && result?.pendingId) {
          failure = attachPendingCredential(failure, {
            pendingId: result.pendingId,
            origin: target.origin,
            matchMode: result.matchMode,
            username: result.username ?? null,
            label: result.label ?? null,
            expiresAt: result.expiresAt ?? null,
          });
        }
        throw failure;
      }
      return result;
    });
  }

  redact(value) {
    // Delegates to the one shared algorithm so the host-side net cannot drift
    // from the worker-side one; only the secret set differs per process.
    return redactSecretsDeep(value, this.#activeSecrets);
  }

  /** Register secrets captured by a trusted host for output redaction. */
  trackRedactionSecret(value: string): void {
    this.#trackSecret(value);
  }

  /** Clear redaction material only after all owning browser pages are closed. */
  resetRedactionSecrets() {
    this.#activeSecrets.clear();
  }

  // --- Owner-only local access ---------------------------------------------
  //
  // The person who owns these files can already read vault.key, so refusing
  // them their own saved passwords protects nothing and strands anything the
  // agent captured or generated. These methods give them a supported way in.
  //
  // They are deliberately NOT reachable through `handleRequest`: that method
  // resolves a fixed action list in `#dispatch`, which is the only surface the
  // worker RPC (and therefore model-authored browser code) can address. Adding
  // an action there would hand the sandbox a secret-read primitive; adding a
  // method here does not. Keep it that way.

  /**
   * Open the vault read-only. Returns null when no vault exists, so the owner
   * read paths report an empty vault rather than materializing one. (If the
   * ciphertext is deleted in the narrow window after the existence check,
   * loadKeyAndSnapshot will create a fresh empty vault — an accepted race, not
   * a supported way to create a vault.)
   */
  async #readSnapshot() {
    if (!(await pathExists(this.paths.data))) return null;
    const { key, snapshot } = await loadKeyAndSnapshot(this.paths, this.keyProvider);
    key.fill(0);
    return snapshot;
  }

  /**
   * Every stored record, metadata only, newest first — not scoped to a site.
   * @param {{query?: string, category?: string}} [options]
   */
  async ownerList({ query = null, category = null }: any = {}) {
    const wanted = category == null ? null : normalizeCategory(category);
    const text = optionalString(query, "Credential search text", 1024, "")
      .trim()
      .toLocaleLowerCase();
    return serialize(this.dir, async () => {
      const snapshot = await this.#readSnapshot();
      if (!snapshot) return { credentials: [], pendingCredentials: [] };
      const credentials = snapshot.records
        .filter((record) => wanted == null || record.category === wanted)
        .filter((record) => metadataSearch(record, text))
        .sort((left, right) => recordTimestamp(right) - recordTimestamp(left))
        .map((record) => publicRecord(record));
      // `category` is not a pending concept — a pending is always an
      // in-flight login — so a category filter hides them all rather than
      // leaving unrelated entries under a filtered list. `query` applies to
      // the public pending shape, whose id field is `pendingId`.
      const pendingCredentials =
        wanted != null && wanted !== "login"
          ? []
          : snapshot.pending
              .map((pending) => publicPendingRecord(pending))
              .filter(
                (pending) =>
                  !text ||
                  [
                    pending.pendingId,
                    pending.id, // present when the pending rotates an existing record
                    pending.origin,
                    pending.username,
                    pending.label,
                  ]
                    .filter((value) => isString(value))
                    .some((value) => value.toLocaleLowerCase().includes(text)),
              )
              .sort((left, right) => recordTimestamp(right) - recordTimestamp(left));
      return { credentials, pendingCredentials };
    });
  }

  /**
   * Resolve one record's stored secret for its owner. Audited like a mutation:
   * a read that exposes plaintext is the entry a compromise investigation
   * needs most, so a failed audit append is reported rather than swallowed.
   *
   * The returned secret is deliberately not added to `#activeSecrets`. That
   * set exists to scrub values a browser worker handled out of its result
   * envelopes; a value revealed to the owner never entered a page, and
   * tracking it would consume the bounded redaction capacity that a real fill
   * needs — `#trackSecret` fails closed when that set is full.
   *
   * @param {string} id record id, or a pending id for an uncommitted signup
   */
  async ownerReveal(id) {
    const wanted = requiredString(String(id ?? ""), "Credential id", 256);
    return serialize(this.dir, async () => {
      const snapshot = await this.#readSnapshot();
      if (!snapshot) throw vaultError("No credential vault exists yet.", "NOT_FOUND");
      const record = snapshot.records.find((candidate) => candidate.id === wanted);
      const pending = record
        ? null
        : snapshot.pending.find((candidate) => candidate.pendingId === wanted);
      if (!record && !pending) {
        throw vaultError(`No credential with id "${wanted}" is stored.`, "NOT_FOUND");
      }
      const metadata = record ? publicRecord(record) : publicPendingRecord(pending);
      const auditWarning = await appendMutationAudit(this.paths, {
        at: new Date().toISOString(),
        action: record ? "owner-reveal" : "owner-reveal-pending",
        origin: metadata.origin,
        id: wanted,
        category: metadata.category,
      });
      const storedExtras: RevealedSecretMaterial = {};
      if (record?.notes != null) storedExtras.notes = record.notes;
      if (record?.fields != null) storedExtras.fields = record.fields;
      return withAuditWarning(
        {
          ...metadata,
          pending: Boolean(pending),
          secret: record ? (record.password ?? null) : pending.secret,
          ...storedExtras,
        },
        auditWarning,
      );
    });
  }

  /**
   * Delete one record by id regardless of the site it was saved for. The
   * site-scoped `remove` action cannot reach a record whose origin no longer
   * resolves, which would otherwise make some entries undeletable.
   * @param {string} id
   */
  async ownerRemove(id) {
    const wanted = requiredString(String(id ?? ""), "Credential id", 256);
    return serialize(this.dir, async () => {
      await ensurePrivateDirectory(this.dir);
      const release = await acquireLock(this.paths, this.lockTimeoutMs, this.staleLockMs);
      try {
        await release.assertOwned();
        if (!(await pathExists(this.paths.data))) {
          throw vaultError("No credential vault exists yet.", "NOT_FOUND");
        }
        const { key, snapshot } = await loadKeyAndSnapshot(this.paths, this.keyProvider);
        try {
          const index = snapshot.records.findIndex((candidate) => candidate.id === wanted);
          const pendingIndex =
            index === -1
              ? snapshot.pending.findIndex((candidate) => candidate.pendingId === wanted)
              : -1;
          if (index === -1 && pendingIndex === -1) {
            throw vaultError(`No credential with id "${wanted}" is stored.`, "NOT_FOUND");
          }
          const [removed] =
            index === -1
              ? snapshot.pending.splice(pendingIndex, 1)
              : snapshot.records.splice(index, 1);
          const metadata =
            index === -1 ? publicPendingRecord(removed) : publicRecord(removed);
          await persistSnapshot(this.paths, key, snapshot);
          await release.assertOwned();
          const auditWarning = await appendMutationAudit(this.paths, {
            at: new Date().toISOString(),
            action: index === -1 ? "owner-remove-pending" : "owner-remove",
            origin: metadata.origin,
            id: wanted,
            category: metadata.category,
          });
          return withAuditWarning({ ...metadata, removed: true }, auditWarning);
        } finally {
          key.fill(0);
        }
      } finally {
        await release();
      }
    });
  }

  /**
   * Recent metadata-only audit entries, newest first.
   * @param {{limit?: number}} [options]
   */
  async ownerAudit({ limit = 50 }: any = {}) {
    const count = boundedInteger(limit, 50, 1, 10_000, "limit");
    let contents;
    try {
      contents = await readBoundedFile(this.paths.audit, MAX_AUDIT_BYTES, "Credential vault audit log");
    } catch (error) {
      if (isMissing(error)) return { entries: [] };
      throw error;
    }
    const entries = [];
    for (const line of contents.toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line));
      } catch {
        // A torn final line from a crashed append is not worth failing over.
      }
    }
    return { entries: entries.slice(-count).reverse() };
  }
}

export function createLocalCredentialVault(options: any = {}) {
  return new LocalCredentialVault(options);
}
