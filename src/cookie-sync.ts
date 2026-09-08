import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import { cookieReaderError } from "./cookie-reader-error.js";

import {
  isBoolean,
  isCallable,
  isNumber,
  isRecord,
  isString,
  type UntrustedValue,
  untrustedField,
} from "./untrusted-value.js";

export const COOKIE_SYNC_MAX_COOKIES = 10_000;
export const COOKIE_SYNC_MAX_BYTES = 6 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const COOKIE_READER_VERSION = "0.6.0";

export interface CookieSyncTargetCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  sourceScheme?: "Unset" | "NonSecure" | "Secure";
  sourcePort?: number;
  partitionKey?: string;
  partitionCrossSiteAncestor?: boolean;
}

export interface NormalizedCookieSyncOptions {
  source: { browser: string; profile?: string };
  domains?: string[];
  includeSession: boolean;
  windowsAppBound: "disabled" | "injection";
  cloudConsent?: string;
  timeoutMs: number;
}

interface CookieReaderReadOptions {
  browser: string;
  profile?: string;
  includeSession: boolean;
  timeoutMs: number;
  appBound: "disabled" | "injection_only";
}

interface CookieReaderModule {
  version: () => string;
  read: (options: CookieReaderReadOptions) => Promise<UntrustedValue>;
  supportedBrowsers: () => Promise<UntrustedValue>;
  browserProfiles: (
    browser: string,
    options: { timeoutMs: number },
  ) => Promise<UntrustedValue>;
}

export interface CookieSyncExtraction {
  cookies: CookieSyncTargetCookie[];
  selected: number;
  skipped: number;
  warnings: Array<{ code: string; count: number }>;
  source: { browser: string; profile?: string };
}

function isCookieReaderModule(value: UntrustedValue): value is CookieReaderModule {
  return (
    isRecord(value) &&
    isCallable(untrustedField(value, "version")) &&
    isCallable(untrustedField(value, "read")) &&
    isCallable(untrustedField(value, "supportedBrowsers")) &&
    isCallable(untrustedField(value, "browserProfiles"))
  );
}

async function loadCookieReader(): Promise<CookieReaderModule> {
  let loaded: UntrustedValue;
  try {
    loaded = await import("rookie-cookies");
  } catch {
    throw new Error(
      "Cookie Sync is unavailable on this host. Reinstall BetterWright with optional dependencies enabled.",
    );
  }
  if (!isCookieReaderModule(loaded)) {
    throw new Error("Cookie Sync could not load its local browser reader.");
  }
  const reportedVersion = loaded.version();
  const version = isString(reportedVersion)
    ? reportedVersion.trim().split(/\s+/, 1)[0]
    : "";
  if (version !== COOKIE_READER_VERSION) {
    throw new Error("Cookie Sync found an unsupported local browser reader version.");
  }
  return loaded;
}

function cleanText(value: UntrustedValue, limit: number): string {
  return isString(value) ? value.trim().slice(0, limit) : "";
}

function hasAsciiControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function cleanPublicText(value: UntrustedValue, limit: number): string {
  if (!isString(value)) return "";
  let clean = "";
  for (const character of value.trim()) {
    const code = character.charCodeAt(0);
    clean += code <= 0x1f || code === 0x7f ? " " : character;
  }
  return clean.replace(/\s+/g, " ").trim().slice(0, limit);
}

function normalizeFilterDomain(value: UntrustedValue): string {
  const raw = cleanText(value, 2_048);
  if (!raw) throw new TypeError("Cookie Sync domains must be non-empty strings.");
  let host = "";
  try {
    const input = raw.includes("://") ? raw : `https://${raw}`;
    const parsed = new URL(input);
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) {
      throw new TypeError("invalid");
    }
    host = parsed.hostname;
  } catch {
    throw new TypeError(
      "Cookie Sync domains must be hostnames or bare HTTP(S) origins, without paths or credentials.",
    );
  }
  const ascii = domainToASCII(host.replace(/^\./, "").toLowerCase());
  if (!ascii || ascii.length > 253 || /\s/.test(ascii) || hasAsciiControl(ascii)) {
    throw new TypeError("Cookie Sync domains must be valid hostnames.");
  }
  return ascii;
}

export function normalizeCookieSyncOptions(
  value: UntrustedValue,
): NormalizedCookieSyncOptions {
  if (!isRecord(value)) {
    throw new TypeError("syncCookies options must be an object.");
  }
  const sourceValue = untrustedField(value, "source");
  if (!isRecord(sourceValue)) {
    throw new TypeError("syncCookies options require source.browser.");
  }
  const browser = cleanText(untrustedField(sourceValue, "browser"), 128).toLowerCase();
  if (!browser || !/^[a-z0-9][a-z0-9._-]*$/.test(browser)) {
    throw new TypeError("syncCookies source.browser must be a browser id.");
  }
  const source: NormalizedCookieSyncOptions["source"] = { browser };
  const profileValue = untrustedField(sourceValue, "profile");
  if (profileValue !== undefined) {
    const profile = cleanText(profileValue, 4_096);
    if (!profile || hasAsciiControl(profile)) {
      throw new TypeError("syncCookies source.profile must be non-empty and single-line.");
    }
    source.profile = profile;
  }

  const domainsValue = untrustedField(value, "domains");
  let domains: string[] | undefined;
  if (domainsValue !== undefined) {
    if (!Array.isArray(domainsValue) || !domainsValue.length) {
      throw new TypeError("syncCookies domains must be a non-empty array when provided.");
    }
    domains = [...new Set(domainsValue.map(normalizeFilterDomain))];
  }

  const includeSessionValue = untrustedField(value, "includeSession");
  if (includeSessionValue !== undefined && !isBoolean(includeSessionValue)) {
    throw new TypeError("syncCookies includeSession must be a boolean.");
  }
  const appBoundValue = untrustedField(value, "windowsAppBound");
  const windowsAppBound = appBoundValue === undefined
    ? "disabled"
    : cleanText(appBoundValue, 32);
  if (!new Set(["disabled", "injection"]).has(windowsAppBound)) {
    throw new TypeError(
      'syncCookies windowsAppBound must be "disabled" or "injection".',
    );
  }
  const cloudConsentValue = untrustedField(value, "cloudConsent");
  const cloudConsent = cloudConsentValue === undefined
    ? undefined
    : cleanText(cloudConsentValue, 512).toLowerCase();
  if (cloudConsentValue !== undefined && !cloudConsent) {
    throw new TypeError("syncCookies cloudConsent must be non-empty when provided.");
  }
  if (cloudConsent && hasAsciiControl(cloudConsent)) {
    throw new TypeError("syncCookies cloudConsent must be a single-line target.");
  }
  const timeoutValue = untrustedField(value, "timeoutMs");
  const timeoutMs = timeoutValue === undefined ? DEFAULT_TIMEOUT_MS : timeoutValue;
  if (!isNumber(timeoutMs) || !Number.isFinite(timeoutMs) || timeoutMs < 1_000) {
    throw new TypeError("syncCookies timeoutMs must be a finite number of at least 1000.");
  }
  const normalized: NormalizedCookieSyncOptions = {
    source,
    includeSession: includeSessionValue === true,
    windowsAppBound: windowsAppBound === "injection" ? "injection" : "disabled",
    timeoutMs: Math.min(Math.floor(timeoutMs), MAX_TIMEOUT_MS),
  };
  if (domains) normalized.domains = domains;
  if (cloudConsent) normalized.cloudConsent = cloudConsent;
  return normalized;
}

function normalizeCookieDomain(value: UntrustedValue): string | null {
  if (!isString(value)) return null;
  const raw = value.trim().toLowerCase();
  const dotted = raw.startsWith(".");
  const host = raw.replace(/^\./, "");
  if (host.startsWith("[") && host.endsWith("]")) {
    return !dotted && isIP(host.slice(1, -1)) === 6 ? host : null;
  }
  const ascii = domainToASCII(host);
  if (
    !ascii ||
    ascii.length > 253 ||
    ascii.startsWith(".") ||
    ascii.endsWith(".") ||
    ascii.includes("..") ||
    /[\s/:]/.test(ascii) ||
    hasAsciiControl(ascii)
  ) return null;
  return dotted ? `.${ascii}` : ascii;
}

function firefoxOriginIsolated(value: UntrustedValue): boolean | null {
  if (value === null || value === undefined) return false;
  if (!isString(value)) return null;
  const text = value.trim();
  if (!text) return false;
  try {
    const parsed: UntrustedValue = JSON.parse(text);
    if (isRecord(parsed) && Object.keys(parsed).length === 0) return false;
  } catch {
    // Persistent Firefox rows use a compact non-JSON attribute suffix.
  }
  return true;
}

function chromiumSourceScheme(
  value: UntrustedValue,
): CookieSyncTargetCookie["sourceScheme"] | null {
  if (value === null || value === undefined) return undefined;
  if (value === 0) return "Unset";
  if (value === 1) return "NonSecure";
  if (value === 2) return "Secure";
  return null;
}

function chromiumSourcePort(value: UntrustedValue): number | undefined | null {
  if (value === null || value === undefined) return undefined;
  if (
    isNumber(value) &&
    Number.isInteger(value) &&
    (value === -1 || (value >= 1 && value <= 65_535))
  ) return value;
  return null;
}

function domainSelected(cookieDomain: string, filters: string[] | undefined): boolean {
  if (!filters) return true;
  const includesSubdomains = cookieDomain.startsWith(".");
  const host = cookieDomain.replace(/^\./, "");
  return filters.some(
    (domain) =>
      host === domain ||
      host.endsWith(`.${domain}`) ||
      (includesSubdomains && domain.endsWith(`.${host}`)),
  );
}

function sameSite(value: UntrustedValue): CookieSyncTargetCookie["sameSite"] | null {
  if (value === -1) return undefined;
  if (value === 0) return "None";
  if (value === 1) return "Lax";
  if (value === 2) return "Strict";
  return null;
}

function partitionSite(value: UntrustedValue): string | null {
  if (!isString(value) || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) return null;
    return url.origin;
  } catch {
    return null;
  }
}

type CookieParseResult =
  | { kind: "cookie"; cookie: CookieSyncTargetCookie }
  | { kind: "skip"; code: string };

function parseDetailedCookie(
  value: UntrustedValue,
  filters: string[] | undefined,
  nowSeconds: number,
): CookieParseResult {
  if (!isRecord(value)) return { kind: "skip", code: "malformed" };
  const raw = untrustedField(value, "cookie");
  const context = untrustedField(value, "context");
  if (!isRecord(raw) || !isRecord(context)) {
    return { kind: "skip", code: "malformed" };
  }
  const name = untrustedField(raw, "name");
  const cookieValue = untrustedField(raw, "value");
  const domain = normalizeCookieDomain(untrustedField(raw, "domain"));
  const path = untrustedField(raw, "path");
  const secure = untrustedField(raw, "secure");
  const httpOnly = untrustedField(raw, "httpOnly");
  const mappedSameSite = sameSite(untrustedField(raw, "sameSite"));
  if (
    !isString(name) ||
    name.length > 4_096 ||
    /[=;]/.test(name) ||
    hasAsciiControl(name) ||
    !isString(cookieValue) ||
    Buffer.byteLength(name, "utf8") + Buffer.byteLength(cookieValue, "utf8") > 16_384 ||
    cookieValue.length > 16_384 ||
    /;/.test(cookieValue) ||
    hasAsciiControl(cookieValue) ||
    !domain ||
    !isString(path) ||
    !path.startsWith("/") ||
    path.length > 4_096 ||
    hasAsciiControl(path) ||
    !isBoolean(secure) ||
    !isBoolean(httpOnly) ||
    mappedSameSite === null
  ) return { kind: "skip", code: "malformed" };
  if (!domainSelected(domain, filters)) return { kind: "skip", code: "domain_filtered" };
  if (mappedSameSite === "None" && !secure) {
    return { kind: "skip", code: "malformed" };
  }
  if (name.startsWith("__Secure-") && !secure) {
    return { kind: "skip", code: "malformed" };
  }
  if (
    name.startsWith("__Host-") &&
    (!secure || path !== "/" || domain.startsWith("."))
  ) return { kind: "skip", code: "malformed" };

  const expiresValue = untrustedField(raw, "expires");
  let expires: number | undefined;
  if (expiresValue !== undefined) {
    if (!isNumber(expiresValue) || !Number.isFinite(expiresValue)) {
      return { kind: "skip", code: "malformed" };
    }
    if (expiresValue <= nowSeconds) return { kind: "skip", code: "expired" };
    expires = expiresValue;
  }

  const originAttributes = untrustedField(context, "originAttributes");
  const userContextId = untrustedField(context, "userContextId");
  const privateBrowsingId = untrustedField(context, "privateBrowsingId");
  const firefoxPartition = untrustedField(context, "partitionKey");
  if (
    !(
      originAttributes === null ||
      originAttributes === undefined ||
      isString(originAttributes)
    ) ||
    !(
      userContextId === null ||
      userContextId === undefined ||
      (isNumber(userContextId) && Number.isInteger(userContextId) && userContextId >= 0)
    ) ||
    !(
      privateBrowsingId === null ||
      privateBrowsingId === undefined ||
      (isNumber(privateBrowsingId) &&
        Number.isInteger(privateBrowsingId) &&
        privateBrowsingId >= 0)
    ) ||
    !(
      firefoxPartition === null ||
      firefoxPartition === undefined ||
      isString(firefoxPartition)
    )
  ) return { kind: "skip", code: "malformed" };
  const originIsolated = firefoxOriginIsolated(originAttributes);
  if (originIsolated === null) return { kind: "skip", code: "malformed" };
  if (
    originIsolated ||
    (isNumber(userContextId) && userContextId > 0) ||
    (isNumber(privateBrowsingId) && privateBrowsingId > 0) ||
    (isString(firefoxPartition) && firefoxPartition.length > 0)
  ) return { kind: "skip", code: "unsupported_isolation" };

  const topFrame = untrustedField(context, "topFrameSiteKey");
  const hasCrossSiteAncestor = untrustedField(context, "hasCrossSiteAncestor");
  if (
    hasCrossSiteAncestor !== null &&
    hasCrossSiteAncestor !== undefined &&
    !isBoolean(hasCrossSiteAncestor)
  ) return { kind: "skip", code: "malformed" };
  let partitionKey: string | undefined;
  if (topFrame !== null && topFrame !== undefined && topFrame !== "") {
    const site = partitionSite(topFrame);
    if (!site || !isBoolean(hasCrossSiteAncestor)) {
      return { kind: "skip", code: "unsupported_partition" };
    }
    partitionKey = site;
  }

  const sourceScheme = chromiumSourceScheme(untrustedField(context, "sourceScheme"));
  const sourcePort = chromiumSourcePort(untrustedField(context, "sourcePort"));
  if (sourceScheme === null || sourcePort === null) {
    return { kind: "skip", code: "malformed" };
  }

  const cookie: CookieSyncTargetCookie = {
    name,
    value: cookieValue,
    domain,
    path,
    httpOnly,
    secure,
  };
  if (expires !== undefined) cookie.expires = expires;
  if (mappedSameSite !== undefined) cookie.sameSite = mappedSameSite;
  if (sourceScheme !== undefined) cookie.sourceScheme = sourceScheme;
  if (sourcePort !== undefined) cookie.sourcePort = sourcePort;
  if (partitionKey) {
    cookie.partitionKey = partitionKey;
    cookie.partitionCrossSiteAncestor = hasCrossSiteAncestor === true;
  }
  return { kind: "cookie", cookie };
}

function cookieIdentity(cookie: CookieSyncTargetCookie): string {
  return JSON.stringify([
    cookie.name,
    cookie.domain,
    cookie.path,
    cookie.partitionKey || "",
    cookie.partitionCrossSiteAncestor ?? null,
  ]);
}

function warningCode(value: UntrustedValue): string {
  const raw = cleanText(value, 80).toLowerCase().replace(/[^a-z0-9_-]+/g, "_");
  return raw || "source_warning";
}

function addWarning(counts: Map<string, number>, code: string, count = 1) {
  counts.set(code, (counts.get(code) || 0) + Math.max(0, Math.floor(count)));
}

export function normalizeCookieSnapshot(
  snapshot: UntrustedValue,
  options: Pick<NormalizedCookieSyncOptions, "source" | "domains">,
  { now = Date.now() }: { now?: number } = {},
): CookieSyncExtraction {
  const detailed = untrustedField(snapshot, "detailedCookies");
  if (!Array.isArray(detailed)) {
    throw new Error("Cookie Sync could not read a valid browser snapshot.");
  }
  const warningCounts = new Map<string, number>();
  const upstreamWarnings = untrustedField(snapshot, "warnings");
  if (Array.isArray(upstreamWarnings)) {
    for (const warning of upstreamWarnings) {
      const countValue = untrustedField(warning, "count");
      addWarning(
        warningCounts,
        warningCode(untrustedField(warning, "code")),
        isNumber(countValue) && Number.isFinite(countValue) ? countValue : 1,
      );
    }
  }

  const cookies = new Map<string, CookieSyncTargetCookie>();
  const nowSeconds = now / 1000;
  let skipped = 0;
  for (const entry of detailed) {
    const parsed = parseDetailedCookie(entry, options.domains, nowSeconds);
    if (parsed.kind === "skip") {
      skipped += 1;
      addWarning(warningCounts, parsed.code);
      continue;
    }
    const identity = cookieIdentity(parsed.cookie);
    if (cookies.has(identity)) addWarning(warningCounts, "duplicate_replaced");
    cookies.set(identity, parsed.cookie);
  }

  const selected = cookies.size;
  if (selected > COOKIE_SYNC_MAX_COOKIES) {
    throw new Error(
      `Cookie Sync selected more than ${COOKIE_SYNC_MAX_COOKIES} cookies. Add domain filters and try again.`,
    );
  }
  const output = [...cookies.values()];
  if (Buffer.byteLength(JSON.stringify(output), "utf8") > COOKIE_SYNC_MAX_BYTES) {
    throw new Error(
      "Cookie Sync selected more data than the secure transfer limit. Add domain filters and try again.",
    );
  }
  return {
    cookies: output,
    selected,
    skipped,
    warnings: [...warningCounts.entries()]
      .filter(([, count]) => count > 0)
      .map(([code, count]) => ({ code, count })),
    source: { ...options.source },
  };
}

export async function extractCookieSync(
  options: NormalizedCookieSyncOptions,
  load: () => Promise<CookieReaderModule> = loadCookieReader,
): Promise<CookieSyncExtraction> {
  let reader: CookieReaderModule;
  let snapshot: UntrustedValue;
  reader = await load();
  const readOptions: CookieReaderReadOptions = {
    browser: options.source.browser,
    includeSession: options.includeSession,
    timeoutMs: options.timeoutMs,
    appBound: options.windowsAppBound === "injection"
      ? "injection_only"
      : "disabled",
  };
  if (options.source.profile) readOptions.profile = options.source.profile;
  try {
    snapshot = await reader.read(readOptions);
  } catch (cause) {
    throw await cookieReaderError(cause, reader, readOptions);
  }
  return normalizeCookieSnapshot(snapshot, options);
}

export async function listCookieSourceBrowsers(
  load: () => Promise<CookieReaderModule> = loadCookieReader,
): Promise<Array<{ id: string; name: string; engine: string }>> {
  const reader = await load();
  let value: UntrustedValue;
  try {
    value = await reader.supportedBrowsers();
  } catch {
    throw new Error("Cookie Sync could not list browsers on this host.");
  }
  if (!Array.isArray(value)) throw new Error("Cookie Sync returned an invalid browser list.");
  return value.flatMap((entry) => {
    const id = cleanPublicText(untrustedField(entry, "id"), 128).toLowerCase();
    const name = cleanPublicText(untrustedField(entry, "displayName"), 256);
    const engine = cleanPublicText(untrustedField(entry, "engine"), 64);
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(id)) return [];
    return id && name ? [{ id, name, engine }] : [];
  });
}

export async function listCookieSourceProfiles(
  browser: UntrustedValue,
  { timeoutMs = DEFAULT_TIMEOUT_MS }: { timeoutMs?: number } = {},
  load: () => Promise<CookieReaderModule> = loadCookieReader,
): Promise<Array<{ id: string; name: string; isDefault: boolean }>> {
  const normalized = normalizeCookieSyncOptions({ source: { browser }, timeoutMs });
  const source = normalized.source;
  const reader = await load();
  let value: UntrustedValue;
  try {
    value = await reader.browserProfiles(source.browser, {
      timeoutMs: normalized.timeoutMs,
    });
  } catch {
    throw new Error("Cookie Sync could not list profiles for the selected browser.");
  }
  if (!Array.isArray(value)) throw new Error("Cookie Sync returned an invalid profile list.");
  return value.flatMap((entry) => {
    const profile = untrustedField(entry, "profile");
    const id = cleanPublicText(untrustedField(profile, "profileId"), 4_096);
    const name = cleanPublicText(untrustedField(profile, "displayName"), 512);
    return id
      ? [{ id, name: name || id, isDefault: untrustedField(entry, "isDefault") === true }]
      : [];
  });
}

export function validateCookieSyncTargetCookies(
  value: UntrustedValue,
): CookieSyncTargetCookie[] {
  if (!Array.isArray(value) || value.length > COOKIE_SYNC_MAX_COOKIES) {
    throw new Error("Cookie Sync received an invalid cookie batch.");
  }
  let encoded = "";
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new Error("Cookie Sync received an invalid cookie batch.");
  }
  if (Buffer.byteLength(encoded, "utf8") > COOKIE_SYNC_MAX_BYTES) {
    throw new Error("Cookie Sync received a cookie batch above the transfer limit.");
  }
  const parsed: CookieSyncTargetCookie[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      throw new Error("Cookie Sync received a malformed cookie batch.");
    }
    const name = untrustedField(entry, "name");
    const cookieValue = untrustedField(entry, "value");
    const domain = normalizeCookieDomain(untrustedField(entry, "domain"));
    const path = untrustedField(entry, "path");
    const httpOnly = untrustedField(entry, "httpOnly");
    const secure = untrustedField(entry, "secure");
    const expiresValue = untrustedField(entry, "expires");
    const sameSiteValue = untrustedField(entry, "sameSite");
    const sourceSchemeValue = untrustedField(entry, "sourceScheme");
    const sourcePortValue = untrustedField(entry, "sourcePort");
    const partitionKeyValue = untrustedField(entry, "partitionKey");
    const ancestorValue = untrustedField(entry, "partitionCrossSiteAncestor");
    if (
      !isString(name) ||
      name.length > 4_096 ||
      /[=;]/.test(name) ||
      hasAsciiControl(name) ||
      !isString(cookieValue) ||
      cookieValue.length > 16_384 ||
      /;/.test(cookieValue) ||
      hasAsciiControl(cookieValue) ||
      Buffer.byteLength(name, "utf8") + Buffer.byteLength(cookieValue, "utf8") > 16_384 ||
      !domain ||
      !isString(path) ||
      !path.startsWith("/") ||
      path.length > 4_096 ||
      hasAsciiControl(path) ||
      !isBoolean(httpOnly) ||
      !isBoolean(secure) ||
      (expiresValue !== undefined &&
        (!isNumber(expiresValue) ||
          !Number.isFinite(expiresValue))) ||
      (sameSiteValue !== undefined &&
        (!isString(sameSiteValue) ||
          !["Strict", "Lax", "None"].includes(sameSiteValue))) ||
      (sourceSchemeValue !== undefined &&
        (!isString(sourceSchemeValue) ||
          !["Unset", "NonSecure", "Secure"].includes(sourceSchemeValue))) ||
      (sourcePortValue !== undefined &&
        (!isNumber(sourcePortValue) ||
          !Number.isInteger(sourcePortValue) ||
          (sourcePortValue !== -1 &&
            (sourcePortValue < 1 || sourcePortValue > 65_535)))) ||
      (sameSiteValue === "None" && !secure) ||
      (name.startsWith("__Secure-") && !secure) ||
      (name.startsWith("__Host-") &&
        (!secure || path !== "/" || domain.startsWith("."))) ||
      (partitionKeyValue !== undefined && !partitionSite(partitionKeyValue)) ||
      (partitionKeyValue === undefined && ancestorValue !== undefined) ||
      (partitionKeyValue !== undefined && !isBoolean(ancestorValue))
    ) {
      throw new Error("Cookie Sync received a malformed cookie batch.");
    }
    if (isNumber(expiresValue) && expiresValue <= Date.now() / 1000) continue;
    const cookie: CookieSyncTargetCookie = {
      name,
      value: cookieValue,
      domain,
      path,
      httpOnly,
      secure,
    };
    if (isNumber(expiresValue)) cookie.expires = expiresValue;
    if (isString(sameSiteValue) && ["Strict", "Lax", "None"].includes(sameSiteValue)) {
      cookie.sameSite = sameSiteValue === "Strict"
        ? "Strict"
        : sameSiteValue === "Lax"
          ? "Lax"
          : "None";
    }
    if (
      isString(sourceSchemeValue) &&
      ["Unset", "NonSecure", "Secure"].includes(sourceSchemeValue)
    ) {
      cookie.sourceScheme = sourceSchemeValue === "Unset"
        ? "Unset"
        : sourceSchemeValue === "NonSecure"
          ? "NonSecure"
          : "Secure";
    }
    if (isNumber(sourcePortValue)) cookie.sourcePort = sourcePortValue;
    const validPartition = partitionSite(partitionKeyValue);
    if (validPartition) {
      cookie.partitionKey = validPartition;
      cookie.partitionCrossSiteAncestor = ancestorValue === true;
    }
    parsed.push(cookie);
  }
  return parsed;
}
