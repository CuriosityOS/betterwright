import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { BetterWright } from "../../dist/src/client.js";
import { httpOrigin, installVaultCapture } from "../../dist/src/vault-capture.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const ORIGIN = "https://app.example.com";
const LOGIN_URL = `${ORIGIN}/login`;

class FakePage extends EventEmitter {
  frameTree: any;
  closed: boolean;

  constructor(frameTree) {
    super();
    this.frameTree = frameTree;
    this.closed = false;
  }

  isClosed() {
    return this.closed;
  }
}

class FakeCDPSession extends EventEmitter {
  page: any;
  worldByFrame: Map<string, number>;
  evaluateCalls: any[];
  bindingCalls: any[];
  detached: boolean;
  nextContextId: number;

  constructor(page) {
    super();
    this.page = page;
    this.worldByFrame = new Map(); // frameId -> latest contextId
    this.evaluateCalls = [];
    this.bindingCalls = [];
    this.detached = false;
    this.nextContextId = 1000;
  }

  contextIdFor(frameId) {
    return this.worldByFrame.get(frameId) || 0;
  }

  createWorld(frameId) {
    const contextId = ++this.nextContextId;
    this.worldByFrame.set(frameId, contextId);
    this.emit("Runtime.executionContextCreated", {
      context: {
        id: contextId,
        name: "betterwright-vault",
        auxData: { frameId },
      },
    });
    return contextId;
  }

  promptCalls() {
    return this.evaluateCalls
      .map((call) => call.expression.match(/__bwVaultShowPrompt\((\{.*\})\)/))
      .filter(Boolean)
      .map((match) => JSON.parse(match[1]));
  }

  async send(method, params = {}) {
    switch (method) {
      case "Page.enable":
      case "Runtime.enable":
        return {};
      case "Runtime.addBinding":
        this.bindingCalls.push(params);
        return {};
      case "Page.addScriptToEvaluateOnNewDocument":
        this.createWorld(this.page.frameTree.frame.id);
        return { identifier: "vault-sensor" };
      case "Runtime.evaluate":
        this.evaluateCalls.push(params);
        return {};
      default:
        return {};
    }
  }

  async detach() {
    this.detached = true;
  }
}

class FakeContext extends EventEmitter {
  pageList: any[];
  sessions: Map<any, any>;

  constructor(pages) {
    super();
    this.pageList = pages;
    this.sessions = new Map();
  }

  pages() {
    return this.pageList;
  }

  async newCDPSession(page) {
    const session = new FakeCDPSession(page);
    this.sessions.set(page, session);
    return session;
  }
}

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(condition, timeoutMs = 2_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (condition()) return true;
    await tick(5);
  }
  return false;
}

// A value that crossed the dist boundary (the shipped capture code drives the
// stubs below with values these tests never construct themselves).
type UntrustedValue = NonNullable<unknown> | null | undefined;

interface HarnessOverrides {
  listRecords?: Array<{ username: string }>;
  pendingFails?: boolean;
  pendingRecords?: Array<{ pendingId: string; origin: string; username: string }>;
  headed?: boolean;
  modelAt?: number | (() => number);
  prefsPath?: string;
}

function isModelClock(value: number | (() => number) | undefined): value is () => number {
  return typeof value === "function";
}

interface HarnessDeps {
  vaultCallAtOrigin: (
    session: UntrustedValue,
    origin: string,
    action: string,
    payload: UntrustedValue,
  ) => Promise<{
    credentials?: Array<{ username: string }>;
    pendingCredentials?: Array<{ pendingId: string; origin: string; username: string }>;
  }>;
  sessionForPage: () => { id: string };
  trackSecret: (value: UntrustedValue) => void;
  isHeaded: () => boolean;
  lastModelActivity: () => number;
  gateMs: number;
  confirmMs: number;
  promptTtlMs: number;
  modelWindowMs: number;
  prefsPath?: string;
}

function makeHarness(overrides: HarnessOverrides = {}) {
  const page = new FakePage({
    frame: { id: "frame-1", url: LOGIN_URL },
    childFrames: [],
  });
  const context = new FakeContext([page]);
  const calls = [];
  const deps: HarnessDeps = {
    vaultCallAtOrigin: async (_session, origin, action, payload) => {
      calls.push({ kind: "vault", origin, action, payload });
      if (action === "list") return { credentials: overrides.listRecords || [] };
      if (action === "list-pending") {
        if (overrides.pendingFails) throw new Error("vault unavailable");
        return overrides.pendingRecords
          ? { pendingCredentials: overrides.pendingRecords }
          : {};
      }
      return {};
    },
    sessionForPage: () => ({ id: "default" }),
    trackSecret: (value) => calls.push({ kind: "secret", value }),
    isHeaded: () => overrides.headed ?? true,
    lastModelActivity: () =>
      isModelClock(overrides.modelAt) ? overrides.modelAt() : (overrides.modelAt ?? 0),
    gateMs: 60,
    confirmMs: 50,
    promptTtlMs: 120,
    modelWindowMs: 5_000,
  };
  if (overrides.prefsPath) deps.prefsPath = overrides.prefsPath;
  const handle = installVaultCapture(context, deps);
  return { page, context, calls, handle, deps };
}

async function attached(harness) {
  const ready = await waitFor(() => {
    const session = harness.context.sessions.get(harness.page);
    return Boolean(session?.contextIdFor("frame-1"));
  });
  assert.equal(ready, true, "engine attached and injected the sensor");
  return harness.context.sessions.get(harness.page);
}

function emitCapture(session, extras = {}) {
  session.emit("Runtime.bindingCalled", {
    name: "__bwVaultEvent",
    executionContextId: session.contextIdFor("frame-1"),
    payload: JSON.stringify({
      type: "submitCapture",
      origin: ORIGIN,
      href: LOGIN_URL,
      username: "ada",
      password: "s3cret!",
      ...extras,
    }),
  });
}

function emitNavigation(session, url) {
  session.emit("Page.frameNavigated", { frame: { id: "frame-1", url } });
  session.createWorld("frame-1");
}

function emitPromptResponse(session, promptId, choice) {
  session.emit("Runtime.bindingCalled", {
    name: "__bwVaultEvent",
    executionContextId: session.contextIdFor("frame-1"),
    payload: JSON.stringify({ type: "promptResponse", promptId, choice }),
  });
}

function emitPasswordFormScan(session, present) {
  session.emit("Runtime.bindingCalled", {
    name: "__bwVaultEvent",
    executionContextId: session.contextIdFor("frame-1"),
    payload: JSON.stringify({
      type: "passwordFormScan",
      href: `${ORIGIN}/home`,
      present,
    }),
  });
}

const vaultSaves = (calls) =>
  calls.filter((call) => call.kind === "vault" && call.action === "save");

test("model-driven capture is saved silently after navigation", async () => {
  const harness = makeHarness({ headed: false, modelAt: () => Date.now() });
  const session = await attached(harness);
  assert.deepEqual(session.bindingCalls, [
    {
      name: "__bwVaultEvent",
      executionContextName: "betterwright-vault",
    },
  ]);
  emitCapture(session);
  emitNavigation(session, `${ORIGIN}/home`);
  assert.equal(await waitFor(() => vaultSaves(harness.calls).length === 1), true);
  const save = vaultSaves(harness.calls)[0];
  assert.equal(save.origin, ORIGIN);
  assert.deepEqual(save.payload, {
    username: "ada",
    password: "s3cret!",
    label: "app.example.com",
    matchMode: "base-domain",
    deferToPending: true,
  });
  // The secret enters the redaction net before any vault write.
  assert.deepEqual(harness.calls[0], { kind: "secret", value: "s3cret!" });
  assert.equal(session.promptCalls().length, 0);
  harness.handle.dispose();
});

test("user capture prompts when headed and saves on Save", async () => {
  const harness = makeHarness({ headed: true, modelAt: 0 });
  const session = await attached(harness);
  emitCapture(session);
  emitNavigation(session, `${ORIGIN}/home`);
  assert.equal(await waitFor(() => session.promptCalls().length === 1), true);
  const prompt = session.promptCalls()[0];
  assert.equal(prompt.origin, ORIGIN);
  assert.equal(prompt.username, "ada");
  assert.equal(prompt.mode, "save");
  assert.equal(vaultSaves(harness.calls).length, 0);
  emitPromptResponse(session, prompt.promptId, "save");
  assert.equal(await waitFor(() => vaultSaves(harness.calls).length === 1), true);
  harness.handle.dispose();
});

test("user capture is dropped when headless", async () => {
  const harness = makeHarness({ headed: false, modelAt: 0 });
  const session = await attached(harness);
  emitCapture(session);
  emitNavigation(session, `${ORIGIN}/home`);
  await tick(150);
  assert.equal(vaultSaves(harness.calls).length, 0);
  assert.equal(session.promptCalls().length, 0);
  harness.handle.dispose();
});

test("capture without a success signal times out unsaved", async () => {
  const harness = makeHarness({ headed: true, modelAt: () => Date.now() });
  const session = await attached(harness);
  emitCapture(session);
  await tick(200);
  assert.equal(vaultSaves(harness.calls).length, 0);
  assert.equal(session.promptCalls().length, 0);
  harness.handle.dispose();
});

test("fieldsCleared resolves the success gate", async () => {
  const harness = makeHarness({ headed: false, modelAt: () => Date.now() });
  const session = await attached(harness);
  emitCapture(session);
  session.emit("Runtime.bindingCalled", {
    name: "__bwVaultEvent",
    executionContextId: session.contextIdFor("frame-1"),
    payload: JSON.stringify({ type: "fieldsCleared", href: LOGIN_URL }),
  });
  assert.equal(await waitFor(() => vaultSaves(harness.calls).length === 1), true);
  harness.handle.dispose();
});

test("a password form on the new page drops the capture (rejected login)", async () => {
  const harness = makeHarness({ headed: true, modelAt: () => Date.now() });
  const session = await attached(harness);
  const firstContextId = session.contextIdFor("frame-1");
  emitCapture(session);
  emitNavigation(session, `${ORIGIN}/login?error=1`);
  assert.equal(
    await waitFor(() => session.contextIdFor("frame-1") !== firstContextId),
    true,
    "sensor re-injected on the post-navigation document",
  );
  emitPasswordFormScan(session, true);
  await tick(150);
  assert.equal(vaultSaves(harness.calls).length, 0);
  assert.equal(session.promptCalls().length, 0);
  harness.handle.dispose();
});

test("no password form on the new page confirms acceptance promptly", async () => {
  const harness = makeHarness({ headed: false, modelAt: () => Date.now() });
  const session = await attached(harness);
  const firstContextId = session.contextIdFor("frame-1");
  emitCapture(session);
  emitNavigation(session, `${ORIGIN}/home`);
  assert.equal(
    await waitFor(() => session.contextIdFor("frame-1") !== firstContextId),
    true,
  );
  emitPasswordFormScan(session, false);
  assert.equal(await waitFor(() => vaultSaves(harness.calls).length === 1), true);
  harness.handle.dispose();
});

test("same-URL navigation drops the pending capture", async () => {
  const harness = makeHarness({ headed: true, modelAt: () => Date.now() });
  const session = await attached(harness);
  emitCapture(session);
  emitNavigation(session, LOGIN_URL);
  emitNavigation(session, `${LOGIN_URL}#section`);
  // A later real navigation must not revive the dropped capture.
  emitNavigation(session, `${ORIGIN}/home`);
  await tick(200);
  assert.equal(vaultSaves(harness.calls).length, 0);
  assert.equal(session.promptCalls().length, 0);
  harness.handle.dispose();
});

test("existing username switches the prompt to update mode", async () => {
  const harness = makeHarness({
    headed: true,
    modelAt: 0,
    listRecords: [{ username: "ada" }],
  });
  const session = await attached(harness);
  emitCapture(session);
  emitNavigation(session, `${ORIGIN}/home`);
  assert.equal(await waitFor(() => session.promptCalls().length === 1), true);
  assert.equal(session.promptCalls()[0].mode, "update");
  harness.handle.dispose();
});

test("Never for this site persists and suppresses later prompts", async () => {
  const prefsPath = path.join(
    makeTempDir("bw-capture-"),
    "save-prompt.json",
  );
  const first = makeHarness({ headed: true, modelAt: 0, prefsPath });
  const firstSession = await attached(first);
  emitCapture(firstSession);
  emitNavigation(firstSession, `${ORIGIN}/home`);
  assert.equal(await waitFor(() => firstSession.promptCalls().length === 1), true);
  emitPromptResponse(firstSession, firstSession.promptCalls()[0].promptId, "never");
  assert.equal(
    await waitFor(() => {
      try {
        return JSON.parse(fs.readFileSync(prefsPath, "utf8")).neverOrigins.includes(
          ORIGIN,
        );
      } catch {
        return false;
      }
    }),
    true,
  );
  assert.equal(vaultSaves(first.calls).length, 0);
  first.handle.dispose();

  const second = makeHarness({ headed: true, modelAt: 0, prefsPath });
  const secondSession = await attached(second);
  emitCapture(secondSession);
  emitNavigation(secondSession, `${ORIGIN}/home`);
  await tick(150);
  assert.equal(secondSession.promptCalls().length, 0);
  assert.equal(vaultSaves(second.calls).length, 0);
  second.handle.dispose();

  const model = makeHarness({ headed: false, modelAt: Date.now(), prefsPath });
  const modelSession = await attached(model);
  emitCapture(modelSession);
  emitNavigation(modelSession, `${ORIGIN}/home`);
  await tick(150);
  assert.equal(vaultSaves(model.calls).length, 0);
  model.handle.dispose();
});

test("an expired prompt cannot save afterwards", async () => {
  const harness = makeHarness({ headed: true, modelAt: 0 });
  const session = await attached(harness);
  emitCapture(session);
  emitNavigation(session, `${ORIGIN}/home`);
  assert.equal(await waitFor(() => session.promptCalls().length === 1), true);
  const promptId = session.promptCalls()[0].promptId;
  await tick(200);
  emitPromptResponse(session, promptId, "save");
  await tick(50);
  assert.equal(vaultSaves(harness.calls).length, 0);
  harness.handle.dispose();
});

test("dispose detaches sessions and ignores later events", async () => {
  const harness = makeHarness({ headed: true, modelAt: () => Date.now() });
  const session = await attached(harness);
  await harness.handle.dispose();
  assert.equal(session.detached, true);
  emitCapture(session);
  emitNavigation(session, `${ORIGIN}/home`);
  await tick(100);
  assert.equal(vaultSaves(harness.calls).length, 0);
});

test("credentialCapture option defaults on, forced off without a vault", () => {
  const home = makeTempDir("bw-home-");
  assert.equal(
    new BetterWright({ home: path.join(home, "a") })._workerConfig()
      .credentialCapture,
    true,
  );
  assert.equal(
    new BetterWright({ home: path.join(home, "b"), vault: false })._workerConfig()
      .credentialCapture,
    false,
  );
  assert.equal(
    new BetterWright({ home: path.join(home, "c"), credentialCapture: false })
      ._workerConfig().credentialCapture,
    false,
  );
});

test("httpOrigin accepts only parseable http(s) URLs (shared with the worker)", () => {
  assert.equal(httpOrigin("https://app.example.com/login?next=/x"), "https://app.example.com");
  assert.equal(httpOrigin("http://example.com:8080/path"), "http://example.com:8080");
  assert.equal(httpOrigin("chrome://settings"), "");
  assert.equal(httpOrigin("file:///etc/passwd"), "");
  assert.equal(httpOrigin("not a url"), "");
  assert.equal(httpOrigin(""), "");
  assert.equal(httpOrigin(null), "");
  assert.equal(httpOrigin(undefined), "");
});

test("capture disposal waits for an in-flight attachment and is idempotent", async () => {
  const page = new FakePage({ frame: { id: "frame-1", url: LOGIN_URL } });
  const context = new FakeContext([page]);
  const cdp = new FakeCDPSession(page);
  let release: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  context.newCDPSession = async () => { await gate; return cdp; };
  const handle = installVaultCapture(context, {});
  const disposing = handle.dispose();
  assert.equal(handle.dispose(), disposing);
  release();
  await disposing;
  assert.equal(cdp.detached, true);
  assert.equal(cdp.evaluateCalls.length, 0);
  assert.equal(context.listenerCount("page"), 0);
});

test("native save prompts receive metadata only and cannot save after disposal", async () => {
  const harness = makeHarness({ headed: true, modelAt: 0 });
  await harness.handle.dispose();
  let answer: (choice: string) => void;
  let request;
  const ready = new Promise<void>(resolve => {
    harness.handle = installVaultCapture(harness.context, {
      ...harness.deps,
      onReady: resolve,
      requestSave: metadata => { request = metadata; return new Promise<string>(resolveChoice => { answer = resolveChoice; }); },
    });
  });
  await ready;
  const session = harness.context.sessions.get(harness.page);
  emitCapture(session);
  emitNavigation(session, `${ORIGIN}/home`);
  assert.equal(await waitFor(() => Boolean(request)), true);
  assert.deepEqual(Object.keys(request).sort(), ["mode", "origin", "page", "username"]);
  assert.equal(harness.handle.isBusy(harness.page), true);
  await harness.handle.dispose();
  answer("save");
  await tick();
  assert.equal(vaultSaves(harness.calls).length, 0);
});

test("disposal removes the installed sensor and suppresses a pending save", async () => {
  const harness = makeHarness({ modelAt: () => Date.now() });
  const cdp = await attached(harness);
  const commands: string[] = [];
  const send = cdp.send.bind(cdp);
  cdp.send = async (method, params) => { commands.push(method); return send(method, params); };
  emitCapture(cdp);
  await harness.handle.dispose();
  assert.ok(commands.includes("Page.removeScriptToEvaluateOnNewDocument"));
  assert.ok(cdp.evaluateCalls.some(call => call.expression === "globalThis.__bwVaultDispose?.()"));
  emitNavigation(cdp, `${ORIGIN}/home`);
  await tick(100);
  assert.equal(vaultSaves(harness.calls).length, 0);
});

// `generateAndFill` types its generated secret into the page, so the sensor
// sees an ordinary accepted submission. Saving it again left two records per
// agent signup — and the capture's `base-domain` default silently widened a
// credential the caller had scoped to `host` or `exact-origin`.
// Whether an observed submission duplicates an in-flight generated credential
// turns on comparing it to the pending *secret*, which never leaves the vault.
// So the sensor no longer decides: it always saves, and marks the save so the
// vault can suppress exactly the duplicate. The suppression rule itself is
// tested against a real vault in vault-generated-credentials.test.ts.
test("every capture save asks the vault to defer to a matching generation", async () => {
  const harness = makeHarness({ headed: false, modelAt: () => Date.now() });
  const session = await attached(harness);
  emitCapture(session);
  emitNavigation(session, `${ORIGIN}/home`);

  assert.equal(await waitFor(() => vaultSaves(harness.calls).length === 1), true);
  const [save] = vaultSaves(harness.calls);
  assert.equal(save.payload.deferToPending, true);
  assert.equal(save.payload.password, "s3cret!");
  harness.handle.dispose();
});

test("a headed user's own Save also defers rather than bypassing the check", async () => {
  const harness = makeHarness({ headed: true, modelAt: 0 });
  const session = await attached(harness);
  emitCapture(session);
  emitNavigation(session, `${ORIGIN}/home`);
  assert.equal(await waitFor(() => session.promptCalls().length === 1), true);
  emitPromptResponse(session, session.promptCalls()[0].promptId, "save");

  assert.equal(await waitFor(() => vaultSaves(harness.calls).length === 1), true);
  assert.equal(vaultSaves(harness.calls)[0].payload.deferToPending, true);
  harness.handle.dispose();
});
