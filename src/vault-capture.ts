// Worker-side vault capture engine. Injects the compiled vault-sensor.js into a
// dedicated CDP isolated world on every web frame, then owns every decision:
// the accepted-login success gate, model-vs-user classification, silent
// model saves, headed save prompts, and the per-origin never-list.
//
// The sensor is a dumb renderer/sensor; this module is the only place that
// sees both the captured secret and the vault. All vault writes go through
// the injected deps.vaultCallAtOrigin, the same worker->client->vault path
// the sandbox `credentials` API uses, so matching, upsert, and audit rules
// are unchanged.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SENSOR_SOURCE = fs.readFileSync(
  new URL("./vault-sensor.js", import.meta.url),
  "utf8",
);
const BINDING_NAME = "__bwVaultEvent";
const WORLD_NAME = "betterwright-vault";
const MAX_NEVER_ORIGINS = 500;

/** The http(s) origin of a URL, or "" for anything unparseable or non-web.
 * Exported because the worker shares this exact rule for origin attribution. */
export function httpOrigin(url) {
  try {
    const parsed = new URL(String(url || ""));
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.origin : "";
  } catch {
    return "";
  }
}

function stripHash(url) {
  return String(url || "").split("#")[0];
}

function hostLabel(origin) {
  try {
    return new URL(origin).hostname;
  } catch {
    return "";
  }
}

function loadNeverOrigins(prefsPath) {
  try {
    const raw = JSON.parse(fs.readFileSync(prefsPath, "utf8"));
    const list = Array.isArray(raw?.neverOrigins) ? raw.neverOrigins : [];
    return new Set(list.filter((origin) => httpOrigin(origin)));
  } catch {
    return new Set();
  }
}

function saveNeverOrigins(prefsPath, neverOrigins) {
  try {
    fs.mkdirSync(path.dirname(prefsPath), { recursive: true, mode: 0o700 });
    const temp = `${prefsPath}.tmp-${process.pid}`;
    const trimmed = [...neverOrigins].slice(-MAX_NEVER_ORIGINS);
    fs.writeFileSync(temp, `${JSON.stringify({ neverOrigins: trimmed }, null, 2)}\n`, {
      mode: 0o600,
    });
    fs.renameSync(temp, prefsPath);
  } catch {
    /* never-list is a convenience; losing a write only re-prompts later */
  }
}

/**
 * @param {object} context Playwright BrowserContext (worker-owned).
 * @param {object} deps
 * @param {(session, origin, action, payload) => Promise<object>} deps.vaultCallAtOrigin
 * @param {(page) => object} deps.sessionForPage owning session for a page
 * @param {(value: string) => void} deps.trackSecret redaction-net registration
 * @param {() => boolean} deps.isHeaded whether a user can answer prompts
 * @param {(page, origin) => number} deps.lastModelActivity ms timestamp, using
 *   the current time while a model execution is in flight on the page's session
 * @param {string} [deps.prefsPath] never-list file; memory-only when omitted
 * @param {(error: Error) => void} [deps.onError] background failure sink
 * @param {number} [deps.gateMs] success-gate window (default 8000)
 * @param {number} [deps.promptTtlMs] prompt lifetime (default 30000)
 * @param {number} [deps.modelWindowMs] model-activity window (default 5000)
 */
export function installVaultCapture(context, deps: any = {}) {
  const timings = {
    gateMs: Math.max(50, Number(deps.gateMs) || 8_000),
    confirmMs: Math.max(50, Number(deps.confirmMs) || 2_500),
    promptTtlMs: Math.max(50, Number(deps.promptTtlMs) || 30_000),
    modelWindowMs: Math.max(50, Number(deps.modelWindowMs) || 5_000),
  };
  const neverOrigins = deps.prefsPath
    ? loadNeverOrigins(deps.prefsPath)
    : new Set();

  const state = {
    disposed: false,
    cdpByPage: new Map(), // page -> CDPSession
    framesByPage: new Map(), // page -> Map<frameId, {contextId, url}>
    pendingByPage: new Map(), // page -> Map<frameId, capture>
    prompts: new Map(), // promptId -> {page, frameId, capture, timer}
    scriptByPage: new Map(),
    attaching: new Set<Promise<void>>(),
  };

  const fail = (error) => {
    try {
      deps.onError?.(error instanceof Error ? error : new Error(String(error)));
    } catch {
      /* error sink must not take the engine down */
    }
  };

  const frameIdForContext = (page, contextId) => {
    const frames = state.framesByPage.get(page);
    if (!frames) return "";
    for (const [frameId, frame] of frames) {
      if (frame.contextId === contextId) return frameId;
    }
    return "";
  };

  /**
   * Hand the observed submission to the vault.
   *
   * `generateAndFill` types its secret into the page, so the sensor sees a
   * perfectly ordinary accepted submission and used to save it a second time —
   * leaving two records per agent signup. Worse, the capture's own
   * `base-domain` default silently widened a credential the caller had asked
   * to scope to `host` or `exact-origin`: the same password ended up offered
   * across the whole registrable domain.
   *
   * `deferToPending` lets the vault suppress exactly that case and nothing
   * else. The decision has to happen inside the vault because it turns on
   * whether this password *is* the pending secret, and the pending secret is
   * never returned out here. Deciding by account name instead would drop a
   * different password typed at the same site during the pending window — a
   * failed fill retried by hand, or a headed user's own "Save password?" —
   * and that one is unrecoverable.
   */
  async function saveCapture(capture) {
    try {
      const session = deps.sessionForPage(capture.page);
      await deps.vaultCallAtOrigin(session, capture.origin, "save", {
        username: capture.username,
        password: capture.password,
        label: hostLabel(capture.origin),
        matchMode: deps.matchMode || "base-domain",
        deferToPending: true,
      });
    } catch (error) {
      fail(error);
    }
  }

  function dropPrompt(promptId, notifySensor) {
    const prompt = state.prompts.get(promptId);
    if (!prompt) return;
    state.prompts.delete(promptId);
    clearTimeout(prompt.timer);
    if (notifySensor) {
      const cdp = state.cdpByPage.get(prompt.page);
      const contextId = state.framesByPage.get(prompt.page)?.get(prompt.frameId)
        ?.contextId;
      if (cdp && contextId) {
        void cdp
          .send("Runtime.evaluate", {
            expression: `globalThis.__bwVaultDismissPrompt(${JSON.stringify(promptId)})`,
            contextId,
          })
          .catch(() => {});
      }
    }
  }

  async function showPrompt(page, frameId, capture, mode) {
    if (state.disposed || page.isClosed()) return;
    if (deps.requestSave) {
      const promptId = crypto.randomUUID();
      const timer = setTimeout(() => dropPrompt(promptId, false), timings.promptTtlMs);
      state.prompts.set(promptId, { page, frameId, capture, timer });
      try {
        const choice = await deps.requestSave({ page, origin: capture.origin, username: capture.username, mode });
        if (state.disposed || page.isClosed() || !state.prompts.has(promptId)) return;
        if (choice === "save") await saveCapture(capture);
        else if (choice === "never") {
          neverOrigins.add(capture.origin);
          if (deps.prefsPath) saveNeverOrigins(deps.prefsPath, neverOrigins);
        }
      } finally { dropPrompt(promptId, false); }
      return;
    }
    const frames = state.framesByPage.get(page);
    const frame = frames?.get(frameId);
    if (!frame) return;
    await frame.bindingReady;
    const contextId = frames.get(frameId)?.contextId;
    const cdp = state.cdpByPage.get(page);
    if (!cdp || !contextId || state.disposed) return;
    const promptId = crypto.randomUUID();
    const timer = setTimeout(
      () => dropPrompt(promptId, false),
      timings.promptTtlMs,
    );
    state.prompts.set(promptId, { page, frameId, capture, timer });
    void cdp
      .send("Runtime.evaluate", {
        expression: `globalThis.__bwVaultShowPrompt(${JSON.stringify({
          promptId,
          origin: capture.origin,
          username: capture.username,
          mode,
        })})`,
        contextId,
      })
      .catch(() => dropPrompt(promptId, false));
  }

  function resolveCapture(page, frameId) {
    return resolveCaptureInner(page, frameId).catch(error => {
      if (!state.disposed && !page.isClosed()) fail(error);
    });
  }

  async function resolveCaptureInner(page, frameId) {
    const pendings = state.pendingByPage.get(page);
    const capture = pendings?.get(frameId);
    if (!capture) return;
    pendings.delete(frameId);
    clearTimeout(capture.timer);
    if (neverOrigins.has(capture.origin)) return;
    if (deps.shouldCapture && !await deps.shouldCapture(capture)) return;
    if (state.disposed) return;

    const lastModelAt = deps.lastModelActivity(page, capture.origin);
    if (
      Number.isFinite(lastModelAt) &&
      Date.now() - lastModelAt <= timings.modelWindowMs
    ) {
      // The model just drove this page/origin: signups and logins it types
      // are always saved without a prompt.
      await saveCapture(capture);
      return;
    }
    if (!deps.isHeaded() || state.disposed) return;

    let mode = "save";
    try {
      const session = deps.sessionForPage(page);
      const response = await deps.vaultCallAtOrigin(session, capture.origin, "list", {});
      const records = response?.credentials || [];
      if (
        capture.username &&
        records.some((record) => record?.username === capture.username)
      ) {
        mode = "update";
      }
    } catch {
      /* prompt as a fresh save when the vault cannot be queried */
    }
    await showPrompt(page, frameId, capture, mode);
  }

  function onSubmitCapture(page, frameId, message) {
    const origin = httpOrigin(message.origin);
    const password = String(message.password || "");
    if (!origin || !password || state.disposed) return;
    deps.trackSecret(password);
    const pendings = state.pendingByPage.get(page);
    if (!pendings) return;
    const previous = pendings.get(frameId);
    if (previous) clearTimeout(previous.timer);
    const timer = setTimeout(() => {
      if (pendings.get(frameId)?.timer === timer) pendings.delete(frameId);
    }, timings.gateMs);
    pendings.set(frameId, {
      page,
      origin,
      href: String(message.href || ""),
      username: String(message.username || ""),
      password,
      timer,
    });
  }

  function onNavigation(page, frameId, newUrl, documentNavigated) {
    const pendings = state.pendingByPage.get(page);
    const capture = pendings?.get(frameId);
    if (!capture) return;
    // Success gate: the accepted login moved the frame somewhere new. Failed
    // attempts keep the same URL and either time out or are dropped outright
    // when the same-URL document is replaced (reload or re-rendered form).
    if (newUrl && stripHash(newUrl) !== stripHash(capture.href)) {
      // A changed URL alone cannot tell "logged in" apart from "rejected and
      // bounced to an error page" (/login?error=1, POST-200 at /auth). Wait
      // for the new document's password-form scan; if none arrives in time,
      // fall back to treating the navigation itself as acceptance.
      clearTimeout(capture.timer);
      capture.confirming = true;
      capture.timer = setTimeout(() => {
        if (pendings.get(frameId) === capture) {
          void resolveCapture(page, frameId);
        }
      }, timings.confirmMs);
    } else if (documentNavigated) {
      clearTimeout(capture.timer);
      pendings.delete(frameId);
    }
  }

  function onPasswordFormScan(page, frameId, message) {
    const capture = state.pendingByPage.get(page)?.get(frameId);
    if (!capture?.confirming) return;
    if (message.present === true) {
      // Still a password form on the new page: a rejected login's re-render.
      clearTimeout(capture.timer);
      state.pendingByPage.get(page)?.delete(frameId);
    } else {
      void resolveCapture(page, frameId);
    }
  }

  function onBindingCalled(page, event) {
    if (event?.name !== BINDING_NAME || state.disposed) return;
    let message;
    try {
      message = JSON.parse(event.payload || "{}");
    } catch {
      return;
    }
    if (message.type === "promptResponse") {
      const promptId = String(message.promptId || "");
      const choice = String(message.choice || "");
      const prompt = state.prompts.get(promptId);
      dropPrompt(promptId, false);
      if (!prompt) return;
      if (choice === "save") void saveCapture(prompt.capture);
      else if (choice === "never") {
        neverOrigins.add(prompt.capture.origin);
        if (deps.prefsPath) saveNeverOrigins(deps.prefsPath, neverOrigins);
      }
      return;
    }
    const frameId = frameIdForContext(page, event.executionContextId);
    if (!frameId) return;
    if (message.type === "submitCapture") onSubmitCapture(page, frameId, message);
    else if (message.type === "fieldsCleared") void resolveCapture(page, frameId);
    else if (message.type === "passwordFormScan") {
      onPasswordFormScan(page, frameId, message);
    }
  }

  async function attachPage(page) {
    if (state.disposed || page.isClosed() || state.cdpByPage.has(page)) return;
    let cdp;
    try {
      cdp = await context.newCDPSession(page);
    } catch {
      return;
    }
    if (state.disposed || page.isClosed()) {
      await cdp.detach().catch(() => {});
      return;
    }
    state.cdpByPage.set(page, cdp);
    state.framesByPage.set(page, new Map());
    state.pendingByPage.set(page, new Map());
    cdp.on("Runtime.executionContextCreated", (event) => {
      const context = event?.context;
      if (context?.name !== WORLD_NAME) return;
      const frameId = String(context.auxData?.frameId || "");
      if (!frameId) return;
      const frames = state.framesByPage.get(page);
      if (!frames) return;
      const previous = frames.get(frameId);
      // The managed fork accepts executionContextName only after the
      // named world exists. Register here so the binding remains world-scoped
      // without relying on the deprecated executionContextId parameter.
      const bindingReady = cdp
        .send("Runtime.addBinding", {
          name: BINDING_NAME,
          executionContextName: WORLD_NAME,
        })
        .catch(fail);
      frames.set(frameId, {
        contextId: context.id,
        url: previous?.url || "",
        bindingReady,
      });
    });
    cdp.on("Runtime.bindingCalled", (event) => onBindingCalled(page, event));
    cdp.on("Page.frameNavigated", (event) => {
      const frame = event?.frame;
      if (!frame?.id) return;
      onNavigation(page, frame.id, String(frame.url || ""), true);
      const frames = state.framesByPage.get(page);
      const previous = frames?.get(frame.id);
      frames?.set(frame.id, {
        contextId: previous?.contextId || null,
        url: frame.url || "",
        bindingReady: previous?.bindingReady || Promise.resolve(),
      });
    });
    cdp.on("Page.navigatedWithinDocument", (event) => {
      if (event?.frameId) {
        onNavigation(page, event.frameId, String(event.url || ""), false);
      }
    });
    cdp.on("Page.frameDetached", (event) => {
      if (event?.frameId) void resolveCapture(page, event.frameId);
    });
    page.once("close", () => detachPage(page));
    try {
      await cdp.send("Page.enable");
      await cdp.send("Runtime.enable");
      const script = await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
        source: SENSOR_SOURCE,
        worldName: WORLD_NAME,
        runImmediately: true,
      });
      state.scriptByPage.set(page, script.identifier);
      if (state.disposed || page.isClosed()) await detachPage(page);
      else deps.onReady?.();
    } catch (error) {
      fail(error);
    }
  }

  async function detachPage(page) {
    const pendings = state.pendingByPage.get(page);
    if (pendings) {
      for (const capture of pendings.values()) clearTimeout(capture.timer);
    }
    state.pendingByPage.delete(page);
    const frames = state.framesByPage.get(page);
    state.framesByPage.delete(page);
    for (const [promptId, prompt] of [...state.prompts]) {
      if (prompt.page === page) dropPrompt(promptId, false);
    }
    const cdp = state.cdpByPage.get(page);
    state.cdpByPage.delete(page);
    if (cdp) {
      const script = state.scriptByPage.get(page);
      state.scriptByPage.delete(page);
      if (script) await cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: script }).catch(() => {});
      for (const frame of frames?.values() || []) {
        if (frame.contextId) await cdp.send("Runtime.evaluate", {
          expression: "globalThis.__bwVaultDispose?.()", contextId: frame.contextId,
        }).catch(() => {});
      }
      await cdp.detach().catch(() => {});
    }
  }

  const onPage = (page) => {
    const operation = attachPage(page).catch(fail).finally(() => state.attaching.delete(operation));
    state.attaching.add(operation);
  };
  context.on("page", onPage);
  for (const page of context.pages()) onPage(page);

  let disposal: Promise<void> | undefined;
  return {
    dispose() {
      if (disposal) return disposal;
      state.disposed = true;
      context.off("page", onPage);
      disposal = (async () => {
      await Promise.all([...state.attaching]);
      for (const page of [...state.cdpByPage.keys()]) await detachPage(page);
      for (const promptId of [...state.prompts.keys()]) {
        dropPrompt(promptId, false);
      }
      })();
      return disposal;
    },
    /**
     * Whether this page has credential work in flight: a captured password
     * waiting on its success gate, or a save prompt on screen.
     *
     * Page parking (src/page-park.ts) asks before it quiets a page. It has to:
     * parking disables script execution for the whole renderer, isolated worlds
     * included, and this sensor lives in one. A capture's success gate is
     * decided by what happens *after* the submit — the navigation, or the app
     * tearing down the form — which is exactly the window between two
     * executions that parking would otherwise cover. Quieting the page there
     * would drop logins on the floor.
     */
    isBusy(page) {
      if (state.pendingByPage.get(page)?.size) return true;
      for (const prompt of state.prompts.values()) {
        if (prompt.page === page) return true;
      }
      return false;
    },
    /** Test introspection: parked captures and live prompts. */
    _state: state,
  };
}
