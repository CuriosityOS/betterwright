// The BetterWright session daemon.
//
// One background process per (BETTERWRIGHT_HOME, profile) owns a single BetterWright
// instance — policy guard, stealth hooks, vault, worker, browser — and serves
// thin CLI clients over a local socket. This is what makes `betterwright run`
// and `betterwright exec` persistent: open tabs, in-page state, and the repl
// `state` object live here between invocations, keyed by `--session` name,
// until the session is closed explicitly or idles out. The Playwright layer
// (network-policy routes, stealth hooks, credential capture) never tears down
// between calls, so there is no unguarded window and nothing to rewire.
//
// Protocol: newline-delimited JSON over a unix domain socket (win32: a named
// pipe). Requests are `{id, op, ...}`; responses `{id, ok, ...}`. Ops:
//   hello         {version, configSig}     -> {ok, pid, version, configSig,
//                                              profile, withVault, sessions,
//                                              startedAt, uptimeMs, runs}
//   call          {method, args, session}  -> {ok, result} for a whitelisted
//                                             BetterWright method; the daemon
//                                             pins `session` into the options
//   exec          {task, model, modelOptions, session, fresh?, liveView?}
//                                          -> streamed `{id, ok, event:"step",
//                                             runId, seq, step}` frames while
//                                             the agent works, then a final
//                                             `{id, ok, result}` summary. The
//                                             agent loop (src/agent.ts) runs
//                                             HERE, in the daemon, so its
//                                             conversation history and browser
//                                             session both live across CLI
//                                             invocations; history is also
//                                             persisted (elided) to disk via
//                                             src/session-store.ts so resume
//                                             survives a daemon restart.
//   attach        {session, cursor?}       -> re-subscribe to the session's
//                                             in-flight (or just-finished) run
//                                             and replay the frames missed
//                                             since `cursor` ({runId, seq}),
//                                             then stream live and deliver the
//                                             same final summary. This is what
//                                             makes a dropped connection a
//                                             cosmetic event rather than a lost
//                                             run.
//   interrupt     {session}                -> {ok, interrupted} — stop the
//                                             session's run at the next safe
//                                             point; the transcript is kept
//   close_session {session}                -> {ok, closed, pagesClosed}
//   status        {}                        -> same payload as hello
//   shutdown      {}                        -> {ok}, then the daemon exits
//
// Auth model: filesystem permissions (socket 0600 inside the 0700 home), the
// ssh-agent shape — same-user processes only. Sessions are collaboration
// scopes, not a security boundary.
//
// Lifecycle: sessions idle out after BETTERWRIGHT_SESSION_TTL_SECONDS
// (default 900); the daemon exits on its own once no sessions remain. A run
// whose last subscriber vanishes is interrupted after
// BETTERWRIGHT_ORPHAN_GRACE_SECONDS (default 30, 0 disables) so a killed
// terminal cannot leave an agent burning tokens unattended.

import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

// `client.ts` pulls the whole browser/worker/vault graph (~20 ms to import).
// Only the daemon *server* needs it; every client that imports this module for
// a socket path or config signature would otherwise pay that cost too. Loaded
// lazily in `createBrowserFromDaemonConfig`, the sole place it is used.
// Type-only imports of the client/agent graph are erased at compile time, so
// they do not defeat the lazy loading described above.
import type { RunAgentTaskOptions } from "../types/agent.js";
import type { BetterWrightOptions, BrowserProviderOptions } from "../types/public.js";
import { defaultHome as defaultDaemonHome } from "./home.js";
import { profileFileSuffix, profileLabel, resolveProfileName } from "./profile-name.js";
import { isString, type UntrustedValue, untrustedField } from "./untrusted-value.js";

const require = createRequire(import.meta.url);

export const DAEMON_PROTOCOL = 2;
export const DEFAULT_SESSION_TTL_MS = 15 * 60 * 1000;
const MIN_SESSION_TTL_MS = 30_000;
const EMPTY_GRACE_MS = 60_000;
const REAP_INTERVAL_MS = 15_000;
// How long a run survives with nobody watching before it is interrupted. The
// CLI sends an explicit `interrupt` on Ctrl-C; this is the backstop for the
// hard kills (closed terminal, SIGKILL) that never get to send anything.
export const DEFAULT_ORPHAN_GRACE_MS = 30_000;
// Frames kept per run for replay after a reconnect. A step frame is a short
// note, so this is kilobytes, and it bounds what one wedged reader can cost.
const REPLAY_BUFFER_FRAMES = 512;
// A finished run stays available this long so a client that reconnects just
// after the agent stopped still collects its answer instead of a bare error.
const FINISHED_RUN_RETENTION_MS = 60_000;
// One request line cannot exceed this. Same-user clients are trusted, but a
// buggy one must not be able to grow the daemon's heap without bound.
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
// A subscriber that stops reading is dropped once this much unwritten data has
// piled up in its socket, rather than buffering it in the daemon forever.
const MAX_SOCKET_BACKLOG_BYTES = 8 * 1024 * 1024;
// Teardown gets this long to finish before the process exits anyway. A wedged
// Chromium must never leave a daemon holding an unreachable socket.
const SHUTDOWN_DEADLINE_MS = 10_000;

export function daemonPackageVersion() {
  try {
    return String(require("../../package.json").version || "0");
  } catch {
    return "0";
  }
}

// Kept under the daemon-flavored name because daemon-client, session-store and
// the CLI import it as such; the resolution rule itself lives in home.js.
export { defaultDaemonHome };

// A unix socket path is bounded by `sockaddr_un.sun_path` — 104 bytes on
// macOS/BSD, 108 on Linux — and the kernel rejects anything longer with EINVAL
// instead of truncating. A BETTERWRIGHT_HOME under a deep path (a CI
// workspace, a long project directory, a container mount) therefore cost you
// session persistence silently: the daemon died on listen, and every run/exec
// fell back to a private browser with only "the session daemon did not start"
// to go on. Below the limit nothing changes; above it, fall back to a short
// owner-only path derived from the same home so sessions still persist.
const MAX_SOCKET_PATH_BYTES = 100;

// Canonicalize a home path so two spellings of the same directory (a symlinked
// ~, a bind mount, macOS `/tmp`→`/private/tmp`) resolve identically — AND so
// the answer does not change once the directory is created. The client hashes
// the home before `spawnDaemon` makes it; the daemon hashes it after. A plain
// `realpathSync` gives different answers across that boundary (it can only
// resolve an existing path), which desynced the two onto different sockets.
// Resolve the deepest ancestor that exists, then re-append the not-yet-created
// tail — `mkdir` creates real directories, so the daemon's later full realpath
// equals this.
function canonicalHome(home) {
  let head = path.resolve(home);
  const tail = [];
  for (;;) {
    try {
      head = fs.realpathSync(head);
      break;
    } catch {
      const parent = path.dirname(head);
      if (parent === head) break; // reached the filesystem root
      tail.unshift(path.basename(head));
      head = parent;
    }
  }
  return tail.length ? path.join(head, ...tail) : head;
}

// The profile joins the hash so two profiles in a deep home get two distinct
// fallback sockets — a shared one would silently put both identities in one
// browser, which is the exact confusion named profiles exist to prevent.
function homeHash(home, profile?: UntrustedValue) {
  const key = `${canonicalHome(home)}\u0000${resolveProfileName(profile) ?? ""}`;
  return crypto.createHash("sha256").update(key).digest("hex").slice(0, 16);
}

/** Owner-only directory holding fallback sockets for over-long homes. */
export function fallbackSocketDir() {
  // getuid is absent on Windows; a getuid() result is a number, never nullish.
  const uid = process.getuid?.() ?? "shared";
  return path.join(os.tmpdir(), `betterwright-${uid}`);
}

// A named profile is a separate identity — separate cookie jar, separate
// browser — so it gets its OWN daemon rather than sharing one and losing
// session persistence to a config mismatch. The socket, info file, and log are
// therefore keyed by (home, profile). The default profile keeps the historical
// bare names, so an upgraded install finds the daemon it already had.
export function daemonSocketPath(home = defaultDaemonHome(), profile?: UntrustedValue) {
  const suffix = profileFileSuffix(profile);
  if (process.platform === "win32") {
    // Named pipes live in their own namespace and have no such limit.
    return `\\\\.\\pipe\\betterwright-${homeHash(home, profile)}`;
  }
  const natural = path.join(home, `daemon${suffix}.sock`);
  if (Buffer.byteLength(natural) <= MAX_SOCKET_PATH_BYTES) return natural;
  return path.join(fallbackSocketDir(), `${homeHash(home, profile)}.sock`);
}

/**
 * Make sure the socket's directory exists before binding.
 *
 * Two cases, deliberately handled differently:
 *   - The natural path puts the socket directly in BETTERWRIGHT_HOME, which the
 *     user owns and manages. It may legitimately be a symlink (a dotfiles
 *     manager, a home relocated to another volume) and may carry permissions
 *     the user chose. Ensure it exists and otherwise leave it untouched —
 *     rejecting a symlinked home or silently chmod-ing it would break setups
 *     that worked, which is the exact silent degradation the fallback exists
 *     to prevent.
 *   - The fallback path puts the socket in a per-uid directory under the
 *     shared `os.tmpdir()`, which on Linux other users can reach. Harden that
 *     one: refuse a symlink or a directory another user owns, and tighten it
 *     to 0700.
 */
export function ensureSocketDirectory(socketPath) {
  const directory = path.dirname(socketPath);
  if (directory !== fallbackSocketDir()) {
    fs.mkdirSync(directory, { recursive: true });
    return;
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stats = fs.lstatSync(directory);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`Session daemon socket directory is not a real directory: ${directory}`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined && stats.uid !== uid) {
    throw new Error(
      `Session daemon socket directory ${directory} is owned by another user; refusing to use it.`,
    );
  }
  fs.chmodSync(directory, 0o700);
}

export function daemonInfoPath(home = defaultDaemonHome(), profile?: UntrustedValue) {
  return path.join(home, `daemon${profileFileSuffix(profile)}.json`);
}

export function daemonLogPath(home = defaultDaemonHome(), profile?: UntrustedValue) {
  return path.join(home, `daemon${profileFileSuffix(profile)}.log`);
}

/**
 * Every profile that has a daemon info file in this home, default first.
 *
 * `betterwright sessions` and `close --all` are home-wide, so they must see
 * every profile's daemon, not just the one the current flags select. An info
 * file is written at startup and removed on clean shutdown; a stale one left
 * by a killed daemon simply fails to connect, which the callers treat as "not
 * running". Returns profile names (`null` for the default profile).
 */
export function daemonProfilesInHome(home = defaultDaemonHome()): (string | null)[] {
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(home);
  } catch {
    return [];
  }
  const found: (string | null)[] = [];
  for (const entry of entries.sort()) {
    if (entry === "daemon.json") {
      found.unshift(null);
      continue;
    }
    const match = /^daemon-(.+)\.json$/.exec(entry);
    if (!match) continue;
    // A file whose name is not a valid profile name cannot have been written
    // by this code; ignore it rather than trust an arbitrary string.
    let profile: string | null = null;
    try {
      profile = resolveProfileName(match[1]);
    } catch {
      continue;
    }
    if (profile) found.push(profile);
  }
  return found;
}

export function sessionTtlMs() {
  const raw = Number(process.env.BETTERWRIGHT_SESSION_TTL_SECONDS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_SESSION_TTL_MS;
  return Math.max(raw * 1000, MIN_SESSION_TTL_MS);
}

export function orphanGraceMs() {
  const raw = process.env.BETTERWRIGHT_ORPHAN_GRACE_SECONDS;
  if (raw === undefined || String(raw).trim() === "") return DEFAULT_ORPHAN_GRACE_MS;
  const seconds = Number(raw);
  // 0 is meaningful: let a detached run finish on its own.
  if (!Number.isFinite(seconds) || seconds < 0) return DEFAULT_ORPHAN_GRACE_MS;
  return seconds * 1000;
}

/**
 * Canonicalize the browser-shaping options a daemon is launched with, so a
 * client can tell whether a running daemon matches its flags. The signature is
 * the JSON of this canonical form — build both the signature and the actual
 * BetterWright construction from the same object and they can never drift.
 */
// The identity platform reaches the daemon already validated — `BetterWright`
// throws on anything else at construction — so an unrecognized value here means
// a hand-written config, and null (host default) is the safe reading of it.
function identityPlatform(value: UntrustedValue): "macos" | "windows" | "linux" | null {
  const platform = value ? String(value) : "";
  return platform === "macos" || platform === "windows" || platform === "linux"
    ? platform
    : null;
}

// The daemon protocol's option bags historically accept ANY non-null object —
// arrays included, which JSON-derived payloads make behave as empty bags — so
// this deliberately mirrors `typeof === "object"` rather than isRecord's
// plain-object test. The value claim is trivially sound: every property of any
// object is a valid UntrustedValue.
function isObjectPayload(value: UntrustedValue): value is Record<string, UntrustedValue> {
  return typeof value === "object" && value !== null;
}

interface NormalizedDaemonPolicy {
  allowLoopback: boolean;
  allowPrivateNetwork: boolean;
  allowHosts: string[];
  blockHosts: string[];
}

interface NormalizedDaemonBrowser {
  adBlock: boolean;
  launchIdentity: boolean;
  upstreamProxy: string | null;
  geoip: boolean;
  locale: string | null;
  timezone: string | null;
  headedInvisible: boolean;
  platform: "macos" | "windows" | "linux" | null;
  stealthRuntimeFix: boolean;
  provider: DaemonProviderConfig | null;
}

// `policy` and `browser` are always present in a finished config; they are
// optional only so normalizeDaemonConfig can assemble the object field by
// field, keeping `profile` — when present — in its historical position in the
// signature JSON (the signature is compared byte-wise).
export interface NormalizedDaemonConfig {
  protocol: number;
  headless: boolean;
  profile?: string;
  policy?: NormalizedDaemonPolicy;
  browser?: NormalizedDaemonBrowser;
}

export function normalizeDaemonConfig(config: any = {}): NormalizedDaemonConfig {
  const policy: UntrustedValue = config.policy;
  const browser: UntrustedValue = config.browser;
  const hosts = (list: UntrustedValue) =>
    [...new Set((Array.isArray(list) ? list : []).map((h) => String(h).trim().toLowerCase()).filter(Boolean))].sort();
  const profile = resolveProfileName(config.profile);
  const normalized: NormalizedDaemonConfig = {
    protocol: DAEMON_PROTOCOL,
    headless: config.headless !== false,
  };
  // A daemon serves exactly one profile (it owns one browser), and the
  // socket is already keyed by profile — but keep it in the signature too so
  // a client that somehow reaches a daemon on another identity's browser
  // sees a mismatch instead of quietly acting as the wrong account.
  //
  // Present ONLY for a named profile: the default profile's signature then
  // stays byte-identical to the pre-profiles one, so upgrading while a
  // daemon holds live sessions reuses that daemon instead of falling back to
  // a one-shot browser that finds the profile locked and comes up signed
  // out. A named profile has its own socket, so nothing can be there but a
  // daemon that already understands this field.
  if (profile) normalized.profile = profile;
  const upstreamProxy = untrustedField(browser, "upstreamProxy");
  const locale = untrustedField(browser, "locale");
  const timezone = untrustedField(browser, "timezone");
  normalized.policy = {
    allowLoopback: untrustedField(policy, "allowLoopback") !== false,
    allowPrivateNetwork: untrustedField(policy, "allowPrivateNetwork") !== false,
    allowHosts: hosts(untrustedField(policy, "allowHosts")),
    blockHosts: hosts(untrustedField(policy, "blockHosts")),
  };
  normalized.browser = {
    adBlock: untrustedField(browser, "adBlock") !== false,
    launchIdentity: untrustedField(browser, "launchIdentity") !== false,
    upstreamProxy: upstreamProxy ? String(upstreamProxy) : null,
    geoip: untrustedField(browser, "geoip") === true,
    locale: locale ? String(locale) : null,
    timezone: timezone ? String(timezone) : null,
    headedInvisible: untrustedField(browser, "headedInvisible") === true,
    platform: identityPlatform(untrustedField(browser, "platform")),
    stealthRuntimeFix: untrustedField(browser, "stealthRuntimeFix") === true,
    provider: normalizeDaemonProvider(untrustedField(browser, "provider")),
  };
  // Include both modes in the signature: a pre-blocker daemon must not be
  // silently reused when the default now requires blocking.
  return normalized;
}

// A provider config enters the daemon signature so a client asking for a
// different browser never silently reuses a daemon on the old one. Provider
// secrets (apiKey, cdpUrl userinfo) are part of the match: two different keys
// must not share a browser, and the signature file is written 0600 under the
// private daemon home, matching the transcripts it already guards.
type DaemonProviderConfig = Partial<
  Record<
    "provider" | "apiKey" | "cdpUrl" | "executablePath" | "headers" | "sessionOptions",
    UntrustedValue
  >
>;

function normalizeDaemonProvider(provider: UntrustedValue): DaemonProviderConfig | null {
  if (provider == null || provider === false) return null;
  const record = isString(provider) ? { provider } : provider;
  if (!isObjectPayload(record)) return null;
  const normalized: DaemonProviderConfig = {};
  for (const key of [
    "provider",
    "apiKey",
    "cdpUrl",
    "executablePath",
    "headers",
    "sessionOptions",
  ] as const) {
    const value = untrustedField(record, key);
    if (value !== undefined && value !== null) {
      normalized[key] = value;
    }
  }
  return normalized;
}

export function daemonConfigSignature(config) {
  return JSON.stringify(normalizeDaemonConfig(config));
}

export async function createBrowserFromDaemonConfig(config) {
  const { BetterWright, NetworkPolicy } = await import("./client.js");
  const normalized = normalizeDaemonConfig(config);
  const options: BetterWrightOptions = {
    policy: new NetworkPolicy(normalized.policy),
    headless: normalized.headless,
    adBlock: normalized.browser.adBlock === true,
    launchIdentity: normalized.browser.launchIdentity,
    upstreamProxy: normalized.browser.upstreamProxy || undefined,
    geoip: normalized.browser.geoip,
    locale: normalized.browser.locale || undefined,
    timezone: normalized.browser.timezone || undefined,
    headedInvisible: normalized.browser.headedInvisible,
    platform: normalized.browser.platform || undefined,
    stealthRuntimeFix: normalized.browser.stealthRuntimeFix || undefined,
  };
  if (normalized.profile) options.profile = normalized.profile;
  if (normalized.browser.provider) {
    // Assigned only when present: BetterWright treats a `provider` KEY on its
    // options — even a nullish one — as an explicit choice (Object.hasOwn)
    // that suppresses the BETTERWRIGHT_CDP_URL fallback.
    // SAFETY: normalizeDaemonProvider guarantees a non-null object; its fields
    // crossed the daemon boundary as parsed JSON and BetterWright forwards the
    // record opaquely to the worker, which validates provider configs at
    // launch — nothing on this side relies on the asserted field types.
    options.provider = normalized.browser.provider as BrowserProviderOptions;
  }
  return new BetterWright(options);
}

// BetterWright methods a client may invoke, and where the session name pins
// into their arguments. `run(code, options)` is special-cased.
const SESSION_OPTION_METHODS = new Set([
  "fillCredential",
  "generateAndFillCredential",
  "commitGeneratedCredential",
  "discardGeneratedCredential",
  "listPendingCredentials",
  "startLiveView",
  "waitForHandoff",
  "waitForAsk",
]);
const PLAIN_METHODS = new Set([
  "syncCookies",
  "stopLiveView",
  "liveViewStatus",
  "liveViewPostChat",
  "liveViewDrainChat",
]);

export function sessionName(value) {
  const name = String(value ?? "default").trim();
  return name || "default";
}

/**
 * A bounded ring of run frames, replayable from a cursor.
 *
 * A reconnecting client says "I last saw seq N of run R"; this answers with
 * everything after it, or reports a `gap` when the frames it missed have
 * already rolled out of the ring — a client that is told it missed steps can
 * say so, which is strictly better than silently resuming mid-story.
 */
export class ReplayBuffer {
  declare limit: number;
  declare frames: any[];

  constructor(limit = REPLAY_BUFFER_FRAMES) {
    this.limit = Math.max(1, limit);
    this.frames = [];
  }

  clear() {
    this.frames.length = 0;
  }

  append(frame) {
    this.frames.push(frame);
    if (this.frames.length > this.limit) this.frames.shift();
  }

  /** @returns {{kind: "frames", frames: object[]} | {kind: "gap", firstSeq: number}} */
  since(cursor: UntrustedValue) {
    if (!isObjectPayload(cursor)) return { kind: "frames", frames: [...this.frames] };
    const { runId, seq } = cursor;
    // A cursor from an older run tells us nothing about this one — replay all.
    if (!runId || !this.frames.length || this.frames[0].runId !== runId)
      return { kind: "frames", frames: [...this.frames] };
    const wanted = Number(seq);
    if (!Number.isFinite(wanted)) return { kind: "frames", frames: [...this.frames] };
    const firstSeq = this.frames[0].seq;
    // The next frame the client needs is wanted+1; if the ring already starts
    // past it, the intervening frames are gone.
    if (wanted + 1 < firstSeq) return { kind: "gap", firstSeq };
    return { kind: "frames", frames: this.frames.filter((frame) => frame.seq > wanted) };
  }
}

/** Injectable knobs for {@link startSessionDaemon}; tests use all of them. */
export interface SessionDaemonOptions {
  home?: string;
  /** Raw daemon config (typically parsed JSON); normalized before use. */
  config?: UntrustedValue;
  socketPath?: string;
  version?: string;
  ttlMs?: number;
  emptyGraceMs?: number;
  reapIntervalMs?: number;
  orphanGraceMs?: number;
  finishedRunRetentionMs?: number;
  log?: (line: string) => void;
  onExit?: (code: number) => void;
  /** Test seam: a BetterWright-shaped stub instead of a real browser. */
  createBrowser?: (config: NormalizedDaemonConfig) => any;
  /** Test seam: drive exec without a model or a browser. */
  runTask?: (options: RunAgentTaskOptions) => Promise<any> | any;
}

/**
 * Start the session daemon. Everything is injectable for tests; production
 * callers pass only `{home, config}` (see `runSessionDaemon`).
 *
 * @returns {Promise<{socketPath: string, close: () => Promise<void>}>}
 */
export async function startSessionDaemon(options: SessionDaemonOptions = {}) {
  const home = options.home || defaultDaemonHome();
  const config = normalizeDaemonConfig(options.config);
  const configSig = JSON.stringify(config);
  // Normalize first: the socket, info file, and log are keyed by the profile
  // this daemon serves, so they must come from the same normalized config the
  // browser is built from — never from a raw, unvalidated option.
  const profile = config.profile ?? null;
  const socketPath = options.socketPath || daemonSocketPath(home, profile);
  const version = options.version || daemonPackageVersion();
  const ttlMs = Math.max(Number(options.ttlMs) || sessionTtlMs(), 1_000);
  const emptyGraceMs = Math.max(Number(options.emptyGraceMs) || EMPTY_GRACE_MS, 250);
  const reapIntervalMs = Math.max(Number(options.reapIntervalMs) || REAP_INTERVAL_MS, 50);
  const graceMs = options.orphanGraceMs === undefined ? orphanGraceMs() : Number(options.orphanGraceMs);
  const retentionMs =
    options.finishedRunRetentionMs === undefined
      ? FINISHED_RUN_RETENTION_MS
      : Math.max(0, Number(options.finishedRunRetentionMs));
  const log =
    options.log ?? ((line) => process.stderr.write(`${new Date().toISOString()} ${line}\n`));
  const onExit = options.onExit ?? null;
  const startedAt = Date.now();

  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const browser = await (options.createBrowser
    ? options.createBrowser(config)
    : createBrowserFromDaemonConfig(config));

  /** @type {Map<string, {lastUsed: number, inflight: number, createdAt: number}>} */
  const sessions = new Map();
  // Per-session exec state: the agent's running transcript (in memory, with
  // the elided copy on disk), and a promise chain so two execs on the same
  // session can never interleave their conversations.
  const execHistories = new Map();
  const execChains = new Map();
  // Per-session run record: the live (or just-finished) agent run, its frame
  // ring, its subscribers, and the controller that stops it.
  /** @type {Map<string, object>} */
  const runs = new Map();
  const connections = new Set<any>();
  let lastTouch = Date.now();
  let shuttingDown = false;
  let runsStarted = 0;

  const touch = (name?) => {
    lastTouch = Date.now();
    if (name === undefined) return null;
    const key = sessionName(name);
    let session = sessions.get(key);
    if (!session) {
      session = { lastUsed: Date.now(), inflight: 0, createdAt: Date.now() };
      sessions.set(key, session);
    }
    session.lastUsed = Date.now();
    return { key, session };
  };

  const sessionsPayload = () =>
    [...sessions.entries()].map(([name, session]) => {
      const run = runs.get(name);
      return {
        name,
        idleMs: Math.max(0, Date.now() - session.lastUsed),
        createdAt: new Date(session.createdAt).toISOString(),
        inflight: session.inflight,
        running: Boolean(run && !run.settled),
        watchers: run ? run.subscribers.size : 0,
      };
    });

  const statusPayload = () => ({
    pid: process.pid,
    version,
    protocol: DAEMON_PROTOCOL,
    configSig,
    // Which identity this daemon is holding, so a client can say so in a
    // message and a home-wide command can label each daemon it finds.
    profile,
    withVault: Boolean(browser.vault),
    ttlMs,
    startedAt: new Date(startedAt).toISOString(),
    uptimeMs: Date.now() - startedAt,
    runs: { started: runsStarted, active: [...runs.values()].filter((run) => !run.settled).length },
    sessions: sessionsPayload(),
  });

  // ---- run registry -------------------------------------------------------

  function dropSubscriber(run, subscriber) {
    if (!run.subscribers.delete(subscriber)) return;
    armOrphanTimer(run);
  }

  // Nobody is watching a live run: give a reconnect a window, then stop it.
  function armOrphanTimer(run) {
    if (run.orphanTimer) {
      clearTimeout(run.orphanTimer);
      run.orphanTimer = null;
    }
    if (run.settled || run.subscribers.size > 0 || !(graceMs > 0)) return;
    run.orphanTimer = setTimeout(() => {
      run.orphanTimer = null;
      if (run.settled || run.subscribers.size > 0) return;
      log(`run ${run.runId} (session ${run.session}) lost its last watcher; interrupting`);
      run.controller.abort();
    }, graceMs);
    run.orphanTimer.unref?.();
  }

  function addSubscriber(run, subscriber) {
    run.subscribers.add(subscriber);
    if (run.orphanTimer) {
      clearTimeout(run.orphanTimer);
      run.orphanTimer = null;
    }
  }

  function emitFrame(run, step) {
    run.seq += 1;
    const frame = { runId: run.runId, seq: run.seq, step };
    run.buffer.append(frame);
    for (const subscriber of [...run.subscribers]) {
      if (!subscriber.send({ id: subscriber.id, ok: true, event: "step", ...frame }))
        dropSubscriber(run, subscriber);
    }
  }

  function settleRun(run, payload) {
    run.settled = payload;
    run.settledAt = Date.now();
    if (run.orphanTimer) {
      clearTimeout(run.orphanTimer);
      run.orphanTimer = null;
    }
    for (const subscriber of [...run.subscribers])
      subscriber.send({ id: subscriber.id, ...payload });
    run.subscribers.clear();
  }

  // Hand a subscriber everything it has not seen. Returns false when the
  // subscriber's socket died on the way, so the caller can forget it.
  function catchUp(run, subscriber, cursor) {
    const replay = run.buffer.since(cursor);
    if (replay.kind === "gap") {
      if (
        !subscriber.send({
          id: subscriber.id,
          ok: true,
          event: "gap",
          runId: run.runId,
          firstSeq: replay.firstSeq,
        })
      )
        return false;
      for (const frame of run.buffer.frames)
        if (!subscriber.send({ id: subscriber.id, ok: true, event: "step", ...frame })) return false;
      return true;
    }
    for (const frame of replay.frames)
      if (!subscriber.send({ id: subscriber.id, ok: true, event: "step", ...frame })) return false;
    return true;
  }

  function forgetRunIfExpired(key) {
    const run = runs.get(key);
    if (!run?.settled) return;
    if (Date.now() - run.settledAt < retentionMs) return;
    runs.delete(key);
  }

  /** Stop a session's run and wait for the agent loop to unwind. */
  async function interruptSession(key, { wait = true }: any = {}) {
    const run = runs.get(key);
    if (!run || run.settled) return false;
    run.controller.abort();
    if (wait) await run.promise.catch(() => {});
    return true;
  }

  async function closeOneSession(name) {
    const key = sessionName(name);
    // Never pull the pages out from under a running agent: stop it first and
    // let it unwind, the way an explicit `interrupt` would.
    await interruptSession(key);
    const existed = sessions.delete(key);
    // The elided transcript stays on disk (like cookies do), so a later exec
    // in a re-created session still remembers past work; `exec --fresh` is
    // the explicit forget. The memory copy mirrors disk, so just drop it.
    execHistories.delete(key);
    execChains.delete(key);
    runs.delete(key);
    let result = { ok: true, closed: false, pagesClosed: 0 };
    try {
      result = await browser.closeSession(key);
    } catch (error) {
      log(`session close failed for ${key}: ${error?.message || error}`);
    }
    return { ok: true, closed: Boolean(result?.closed) || existed, pagesClosed: result?.pagesClosed || 0 };
  }

  // One exec at a time per session; different sessions run concurrently.
  function runExecOp(message, subscriber) {
    const key = sessionName(message.session ?? "default");
    const prior = execChains.get(key) || Promise.resolve();
    const next = prior.then(() => execOne(key, message, subscriber));
    const chained = next.then(
      () => {},
      () => {},
    );
    execChains.set(key, chained);
    // Keep the map from growing one dead promise per session name forever.
    void chained.then(() => {
      if (execChains.get(key) === chained) execChains.delete(key);
    });
    return next;
  }

  async function execOne(key, message, subscriber) {
    const tracked = touch(key);
    tracked.session.inflight += 1;
    const controller = new AbortController();
    const run = {
      session: key,
      runId: crypto.randomUUID(),
      seq: 0,
      buffer: new ReplayBuffer(REPLAY_BUFFER_FRAMES),
      subscribers: new Set(),
      controller,
      settled: null,
      settledAt: 0,
      orphanTimer: null,
      promise: null,
      startedAt: Date.now(),
    };
    runs.set(key, run);
    runsStarted += 1;
    if (subscriber) addSubscriber(run, subscriber);
    else armOrphanTimer(run);
    // Announce the run id before any step, so a client that drops immediately
    // still has a cursor to reattach with.
    subscriber?.send({ id: subscriber.id, ok: true, event: "run", runId: run.runId, session: key });

    const body = (async () => {
      // Lazy imports keep daemon startup light and avoid a module cycle with
      // session-store (which imports this file's path helpers). `runTask` is
      // injectable so tests can drive exec without a model or a browser.
      const runAgentTask = options.runTask ?? (await import("./agent.js")).runAgentTask;
      const store = await import("./session-store.js");
      if (message.fresh) {
        execHistories.delete(key);
        store.clearTranscript(home, key, profile);
      }
      const history = message.fresh
        ? []
        : (execHistories.get(key) ?? store.loadTranscript(home, key, profile));
      const taskOptions: RunAgentTaskOptions = {
        task: String(message.task || ""),
        browser,
        session: key,
        history,
        model: message.model,
        modelOptions: isObjectPayload(message.modelOptions) ? message.modelOptions : {},
        signal: controller.signal,
        onStep: (event) => {
          try {
            emitFrame(run, event);
          } catch {
            /* a vanished viewer must never break the task */
          }
        },
      };
      if (message.liveView !== undefined) taskOptions.liveView = message.liveView;
      const result = await runAgentTask(taskOptions);
      // Persist even an interrupted transcript: the whole point of stopping a
      // run is to pick it back up.
      if (result.transcript) {
        execHistories.set(key, result.transcript);
        try {
          store.saveTranscript(home, key, result.transcript, {}, profile);
        } catch (error) {
          log(`transcript save failed for ${key}: ${error?.message || error}`);
        }
      }
      const { transcript: _transcript, ...summary } = result;
      return { ...summary, session: key, runId: run.runId, resumedMessages: history.length };
    })();

    run.promise = body;
    try {
      const result = await body;
      settleRun(run, { ok: true, result });
      return result;
    } catch (error) {
      const payload = { ok: false, error: String(error?.message || error) };
      settleRun(run, payload);
      throw error;
    } finally {
      tracked.session.inflight = Math.max(0, tracked.session.inflight - 1);
      tracked.session.lastUsed = Date.now();
      lastTouch = Date.now();
    }
  }

  /**
   * Re-subscribe to a session's run. Resolves with the run's final payload,
   * exactly as the original `exec` request would have.
   */
  function attachToRun(message, subscriber) {
    const key = sessionName(message.session ?? "default");
    const run = runs.get(key);
    if (!run) return { ok: false, error: `no run to attach to on session "${key}"` };
    if (message.runId && message.runId !== run.runId)
      return { ok: false, error: `run ${message.runId} is no longer available on session "${key}"` };
    touch(key);
    if (!catchUp(run, subscriber, message.cursor)) return { ok: false, error: "the client went away" };
    // Already finished: hand over the stored answer instead of a subscription.
    if (run.settled) return run.settled;
    addSubscriber(run, subscriber);
    return null; // the run settles it later
  }

  async function handleCall(message) {
    const method = String(message.method || "");
    const args = Array.isArray(message.args) ? message.args : [];
    const tracked = touch(message.session ?? "default");
    tracked.session.inflight += 1;
    try {
      if (method === "run") {
        const [code, runOptions] = args;
        const base = isObjectPayload(runOptions) ? runOptions : {};
        return await browser.run(String(code ?? ""), { ...base, session: tracked.key });
      }
      if (SESSION_OPTION_METHODS.has(method)) {
        const [callOptions] = args;
        const base = isObjectPayload(callOptions) ? callOptions : {};
        return await browser[method]({ ...base, session: tracked.key });
      }
      if (PLAIN_METHODS.has(method)) {
        return await browser[method](...args.slice(0, 1));
      }
      throw new Error(`Unknown or disallowed method: ${method}`);
    } finally {
      tracked.session.inflight = Math.max(0, tracked.session.inflight - 1);
      tracked.session.lastUsed = Date.now();
      lastTouch = Date.now();
    }
  }

  let server;
  let reaper;

  async function shutdown(code = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(reaper);
    // Teardown must not be able to wedge the process: whatever happens below,
    // the daemon is gone within SHUTDOWN_DEADLINE_MS. Removing the socket
    // first means a client that arrives during teardown starts a fresh daemon
    // instead of connecting to one that is on its way out.
    // Deliberately not unref'd. This watchdog exists to guarantee the process
    // ends on our terms, and an unref'd timer cannot promise that: once the
    // server and its sockets are gone, nothing else holds the loop, so Node
    // would drain and exit 0 on its own — turning a crash shutdown into a
    // silent success. `clearTimeout` below keeps it from adding any delay to
    // a teardown that finishes normally.
    const failsafe = setTimeout(() => {
      if (onExit) onExit(code);
      else process.exit(code);
    }, SHUTDOWN_DEADLINE_MS);
    try {
      server?.close();
    } catch {
      /* already closed */
    }
    for (const run of runs.values()) {
      if (run.orphanTimer) clearTimeout(run.orphanTimer);
      if (!run.settled) run.controller.abort();
    }
    for (const file of [socketPath, daemonInfoPath(home, profile)]) {
      if (process.platform === "win32" && file === socketPath) continue;
      try {
        fs.rmSync(file, { force: true });
      } catch {
        /* best effort */
      }
    }
    for (const socket of connections) socket.destroy();
    try {
      await browser.close();
    } catch {
      /* browser teardown is best effort */
    }
    clearTimeout(failsafe);
    if (onExit) onExit(code);
    else process.exit(code);
  }

  function maybeShutdownWhenEmpty() {
    if (shuttingDown) return;
    const inflight = [...sessions.values()].some((s) => s.inflight > 0);
    if (inflight) return;
    if (sessions.size === 0 && Date.now() - lastTouch >= emptyGraceMs) {
      void shutdown(0);
    }
  }

  async function reap() {
    const cutoff = Date.now() - ttlMs;
    for (const key of [...runs.keys()]) forgetRunIfExpired(key);
    for (const [name, session] of sessions) {
      if (session.inflight > 0 || session.lastUsed >= cutoff) continue;
      await closeOneSession(name);
    }
    maybeShutdownWhenEmpty();
  }

  function handleConnection(socket) {
    connections.add(socket);
    // Release this connection's subscriptions the moment it goes away, rather
    // than discovering they are dead at the next broadcast — that is what
    // starts the orphan timer while there is still time to reattach.
    const release = () => {
      connections.delete(socket);
      for (const run of runs.values())
        for (const subscriber of [...run.subscribers])
          if (subscriber.socket === socket) dropSubscriber(run, subscriber);
    };
    socket.on("close", release);
    socket.on("error", () => socket.destroy());

    const respond = (payload) => {
      if (socket.destroyed) return false;
      // A client that stopped reading must not be able to grow the daemon's
      // heap: past the backlog ceiling it is disconnected, and its run's
      // orphan timer takes over from there.
      if (socket.writableLength > MAX_SOCKET_BACKLOG_BYTES) {
        log("dropping a subscriber that stopped reading");
        socket.destroy();
        return false;
      }
      try {
        // Callback form so a client that vanished mid-stream surfaces as a
        // swallowed write error, not an uncaught EPIPE in the daemon.
        socket.write(`${JSON.stringify(payload)}\n`, () => {});
        return true;
      } catch {
        return false; /* client went away */
      }
    };

    const lines = readline.createInterface({ input: socket, crlfDelay: Infinity });
    // Readline re-emits input-stream errors on itself; a vanished client must
    // not take the daemon down with an uncaught exception.
    lines.on("error", () => {});
    lines.on("line", (line) => {
      if (line.length > MAX_REQUEST_BYTES) {
        respond({ id: null, ok: false, error: "request too large" });
        socket.destroy();
        return;
      }
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      const id = message?.id;
      void (async () => {
        try {
          const op = String(message.op || "");
          if (op === "hello" || op === "status") {
            touch();
            respond({ id, ok: true, ...statusPayload() });
            return;
          }
          if (op === "call") {
            const result = await handleCall(message);
            respond({ id, ok: true, result });
            return;
          }
          if (op === "exec") {
            // `settleRun` answers this request through the subscriber, so the
            // originating client and a later reattach take the same path —
            // including the failure envelope, hence the swallow here.
            await runExecOp(message, { id, send: respond, socket }).catch(() => {});
            return;
          }
          if (op === "attach") {
            const settled = attachToRun(message, { id, send: respond, socket });
            // A live run answers later, through its subscriber list.
            if (settled) respond({ id, ...settled });
            return;
          }
          if (op === "interrupt") {
            touch(message.session ?? "default");
            const interrupted = await interruptSession(sessionName(message.session ?? "default"), {
              wait: message.wait !== false,
            });
            respond({ id, ok: true, interrupted });
            return;
          }
          if (op === "close_session") {
            touch();
            const outcome = await closeOneSession(message.session);
            respond({ id, ok: true, ...outcome });
            // The last explicit close ends the daemon promptly rather than
            // holding the profile (and a Chromium) for the empty-grace window.
            if (sessions.size === 0) {
              lastTouch = Date.now() - emptyGraceMs;
              setTimeout(() => maybeShutdownWhenEmpty(), 25).unref?.();
            }
            return;
          }
          if (op === "shutdown") {
            respond({ id, ok: true });
            setTimeout(() => void shutdown(0), 10);
            return;
          }
          respond({ id, ok: false, error: `Unknown daemon op: ${op}` });
        } catch (error) {
          respond({ id, ok: false, error: String(error?.message || error) });
        }
      })();
    });
  }

  server = net.createServer(handleConnection);
  if (process.platform !== "win32") ensureSocketDirectory(socketPath);
  await new Promise<void>((resolve, reject) => {
    const tryListen = (retried) => {
      server.once("error", (error) => {
        if (error?.code !== "EADDRINUSE" || retried) {
          reject(error);
          return;
        }
        // Either another daemon is alive (we lost the spawn race — defer to
        // it) or a previous daemon died without unlinking its socket.
        const probe = net.connect(socketPath);
        probe.once("connect", () => {
          probe.destroy();
          reject(Object.assign(new Error("another session daemon is already running"), { code: "ALREADY_RUNNING" }));
        });
        probe.once("error", () => {
          probe.destroy();
          if (process.platform !== "win32") {
            try {
              fs.rmSync(socketPath, { force: true });
            } catch {
              /* fall through to the retry */
            }
          }
          tryListen(true);
        });
      });
      server.listen(socketPath, () => resolve());
    };
    tryListen(false);
  });
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(socketPath, 0o600);
    } catch {
      /* the 0700 home directory is the outer gate */
    }
  }
  try {
    fs.writeFileSync(
      daemonInfoPath(home, profile),
      JSON.stringify({
        pid: process.pid,
        socket: socketPath,
        profile,
        version,
        protocol: DAEMON_PROTOCOL,
        configSig,
        startedAt: new Date(startedAt).toISOString(),
      }),
      { encoding: "utf8", mode: 0o600 },
    );
  } catch {
    /* informational only */
  }

  reaper = setInterval(() => void reap(), reapIntervalMs);
  reaper.unref?.();
  log(
    `listening on ${socketPath} (pid ${process.pid}, v${version}, protocol ${DAEMON_PROTOCOL}, ` +
      `profile ${profileLabel(profile)})`,
  );

  return {
    socketPath,
    // The code matters: the crash handler passes 1 so a supervisor and the log
    // agree that this was a failure, not a clean stop.
    close: (code = 0) => shutdown(code),
    // Exposed for tests and for the signal handlers below.
    _internals: { runs, sessions, statusPayload },
  };
}

/**
 * Entry point for the hidden `betterwright __daemon` command: parse the
 * base64 config from argv, start the daemon, and stay alive until the empty
 * reaper or a signal ends the process.
 */
export async function runSessionDaemon(argv = process.argv) {
  process.title = "betterwright-daemon";
  const flagIndex = argv.indexOf("--config");
  let config: UntrustedValue = {};
  if (flagIndex !== -1 && argv[flagIndex + 1]) {
    try {
      config = JSON.parse(Buffer.from(argv[flagIndex + 1], "base64url").toString("utf8"));
    } catch {
      process.stderr.write("Invalid --config payload; starting with defaults.\n");
    }
  }
  let daemon;
  try {
    daemon = await startSessionDaemon({ config });
  } catch (error) {
    if (error?.code === "ALREADY_RUNNING") return 0;
    process.stderr.write(`${error?.stack || error}\n`);
    return 1;
  }
  const stop = () => void daemon.close();
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  // A stray rejection is a bug, not a reason to take every live session with
  // it. Log it and keep serving; the per-op try/catch already answers the
  // request that caused it. Without this handler Node turns the rejection
  // into an uncaught exception and the daemon dies mid-run.
  process.on("unhandledRejection", (error) => {
    const stack = untrustedField(error, "stack");
    process.stderr.write(
      `${new Date().toISOString()} daemon unhandled rejection: ${stack || error}\n`,
    );
  });
  // An uncaught exception leaves the process in an unknown state, so this one
  // does end the daemon — but gracefully (browser closed, socket unlinked)
  // and with a failure code, so a supervisor and the log agree on what
  // happened.
  process.on("uncaughtException", (error) => {
    process.stderr.write(`${new Date().toISOString()} daemon uncaught: ${error?.stack || error}\n`);
    void daemon.close(1);
  });
  // Stay alive until shutdown() calls process.exit.
  await new Promise<void>(() => {});
  return 0;
}
