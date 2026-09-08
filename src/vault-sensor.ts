// BetterWright vault sensor. Evaluated by the worker inside a dedicated
// CDP-created isolated world ("betterwright-vault") on every web frame. The
// isolated world gives this script the same boundary an extension content
// script has: it shares the DOM with the page but none of its globals, so
// page JavaScript cannot see, call, or tamper with it.
//
// This file is a sensor and prompt renderer only. Every decision (success
// gate, model-vs-user classification, saving, never-list) lives worker-side
// in src/vault-capture.ts. The sensor never receives the password back: a
// parked capture stays in worker memory and the banner shows only origin and
// username.
//
// Events out (via the scoped Runtime binding): submitCapture, fieldsCleared,
// promptResponse. Commands in (via Runtime.evaluate on globalThis):
// __bwVaultShowPrompt(opts), __bwVaultDismissPrompt(promptId).

(() => {

  if (globalThis.__bwVaultSensorInstalled) return;
  globalThis.__bwVaultSensorInstalled = true;

  const BINDING_NAME = "__bwVaultEvent";
  const PROMPT_TIMEOUT_MS = 30_000;
  const CLEAR_WATCH_MS = 10_000;
  const DUPLICATE_CAPTURE_MS = 1_500;
  const lifecycle = new AbortController();

  // Mirrors UntrustedValue in untrusted-value.ts: this sensor compiles to a
  // self-contained page script, so it cannot import the shared contract.
  type UntrustedPageValue = NonNullable<unknown> | null | undefined;

  // The Runtime binding the worker installs in this isolated world. It takes
  // the JSON-encoded event; callability is the checked invariant.
  const isEventBinding = (value: UntrustedPageValue): value is (encoded: string) => void =>
    typeof value === "function";

  const emit = (payload) => {
    const encoded = JSON.stringify(payload);
    let attempts = 0;
    const deliver = () => {
      if (lifecycle.signal.aborted) return;
      try {
        const binding = globalThis[BINDING_NAME];
        if (isEventBinding(binding)) {
          binding(encoded);
          return;
        }
      } catch {
        return; /* world tearing down */
      }
      attempts += 1;
      if (attempts <= 100) setTimeout(deliver, 10);
    };
    deliver();
  };

  const isWebPage = () =>
    location.protocol === "http:" || location.protocol === "https:";

  const isPasswordField = (el) =>
    Boolean(el) && el.tagName === "INPUT" && el.type === "password";

  const isVisible = (el) => {
    try {
      if (!el?.isConnected) return false;
      if (el.getClientRects().length === 0) return false;
      const style = getComputedStyle(el);
      return style.visibility !== "hidden" && style.display !== "none";
    } catch {
      return false;
    }
  };

  // Collect input fields in a root, descending into open shadow roots.
  const collectInputs = (root, out = []) => {
    try {
      if (!root) return out;
      if (root.tagName === "INPUT") out.push(root);
      const children = root.querySelectorAll ? root.querySelectorAll("input") : [];
      for (const input of children) out.push(input);
      const all = root.querySelectorAll ? root.querySelectorAll("*") : [];
      for (const el of all) {
        if (el.shadowRoot) collectInputs(el.shadowRoot, out);
      }
    } catch {
      /* hostile DOM */
    }
    return out;
  };

  const USERNAME_TYPES = new Set(["", "text", "email", "tel", "url"]);
  const USERNAME_HINT = /user|email|login|account|identifier/i;

  const autocompleteToken = (el) =>
    String(el.getAttribute("autocomplete") || "")
      .trim()
      .toLowerCase();

  // Pick the most plausible username field accompanying `passwordField`.
  const findUsernameField = (passwordField) => {
    const form = passwordField.closest ? passwordField.closest("form") : null;
    const scope = form || document;
    const inputs = collectInputs(scope === document ? document.documentElement : scope);
    const usable = inputs.filter((input) => input !== passwordField && input.value);
    const visibleText = usable.filter(
      (input) => USERNAME_TYPES.has(input.type) && isVisible(input),
    );
    const byToken = (list, token) =>
      list.find((input) => autocompleteToken(input) === token);
    const tokenMatch =
      byToken(visibleText, "username") || byToken(visibleText, "email");
    if (tokenMatch) return tokenMatch;
    // Nearest visible text-ish field before the password field in DOM order.
    let nearest = null;
    for (const input of visibleText) {
      const position = passwordField.compareDocumentPosition(input);
      if (position & Node.DOCUMENT_POSITION_PRECEDING) nearest = input;
    }
    if (nearest) return nearest;
    if (visibleText.length) return visibleText[0];
    // Two-step flows often carry the username in a hidden field.
    const hidden = usable.find(
      (input) =>
        input.type === "hidden" &&
        (autocompleteToken(input) === "username" ||
          autocompleteToken(input) === "email" ||
          USERNAME_HINT.test(`${input.name || ""} ${input.id || ""}`)),
    );
    return hidden || null;
  };

  const passwordFieldFor = (target) => {
    if (isPasswordField(target)) return target;
    const form = target?.closest ? target.closest("form") : null;
    const scope = form || document;
    const inputs = collectInputs(scope === document ? document.documentElement : scope);
    return (
      inputs.find((input) => isPasswordField(input) && input.value && isVisible(input)) ||
      null
    );
  };

  // --- capture -----------------------------------------------------------

  let clearObserver = null;
  let clearTimer = null;
  let lastCapture = { field: null, password: "", at: 0 };

  const stopClearWatch = () => {
    if (clearObserver) clearObserver.disconnect();
    clearObserver = null;
    if (clearTimer) clearTimeout(clearTimer);
    clearTimer = null;
  };

  // A real navigation must not look like "the app unmounted the form".
  addEventListener("pagehide", () => stopClearWatch(), { capture: true, signal: lifecycle.signal });

  // Report whether this document still shows a password form. The worker uses
  // it to confirm a post-submit navigation: a page that lands back on a
  // password form is a rejected login, not one worth saving.
  const reportPasswordFormScan = () => {
    try {
      if (!isWebPage()) return;
      const present = collectInputs(document.documentElement).some(
        (input) => {
          if (!isPasswordField(input) || !input.isConnected) return false;
          const style = getComputedStyle(input);
          return style.display !== "none" && style.visibility !== "hidden";
        },
      );
      emit({ type: "passwordFormScan", href: location.href, present });
    } catch {
      /* scan is advisory; the worker falls back to the navigation alone */
    }
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", reportPasswordFormScan, {
      signal: lifecycle.signal,
      once: true,
    });
  } else {
    reportPasswordFormScan();
  }

  const watchFieldCleared = (field) => {
    stopClearWatch();
    try {
      clearObserver = new MutationObserver(() => {
        // Success signal for no-navigation (SPA) logins: the app unmounted
        // the form. A cleared value is NOT one — failed logins typically
        // clear the password for a retry, so it must not count.
        if (!field.isConnected || !isVisible(field)) {
          stopClearWatch();
          emit({ type: "fieldsCleared", href: location.href });
        }
      });
      clearObserver.observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["style", "class", "hidden", "type", "disabled", "value"],
      });
      clearTimer = setTimeout(stopClearWatch, CLEAR_WATCH_MS);
    } catch {
      /* observer unsupported; navigation events still close the gate */
    }
  };

  const capture = (passwordField) => {
    try {
      if (!isWebPage() || !passwordField?.value) return;
      const now = Date.now();
      if (
        lastCapture.field === passwordField &&
        lastCapture.password === passwordField.value &&
        now - lastCapture.at < DUPLICATE_CAPTURE_MS
      ) {
        return;
      }
      lastCapture = { field: passwordField, password: passwordField.value, at: now };
      const usernameField = findUsernameField(passwordField);
      emit({
        type: "submitCapture",
        origin: location.origin,
        href: location.href,
        username: usernameField ? String(usernameField.value || "").slice(0, 1024) : "",
        password: String(passwordField.value),
      });
      watchFieldCleared(passwordField);
    } catch {
      /* never break the page's own submit */
    }
  };

  const isSubmitLikeControl = (el) => {
    if (!el?.closest) return false;
    return Boolean(
      el.closest(
        'button, input[type="submit"], input[type="image"], input[type="button"], [role="button"]',
      ),
    );
  };

  // Capture phase so a stopPropagation in page code cannot hide the gesture.
  document.addEventListener(
    "keydown",
    (event) => {
      if (!event.isTrusted || event.key !== "Enter") return;
      const field = passwordFieldFor(event.target);
      if (field) capture(field);
    },
    { capture: true, signal: lifecycle.signal },
  );
  document.addEventListener(
    "click",
    (event) => {
      if (!event.isTrusted || !isSubmitLikeControl(event.target)) return;
      const field = passwordFieldFor(event.target);
      if (field) capture(field);
    },
    { capture: true, signal: lifecycle.signal },
  );

  // --- save prompt ---------------------------------------------------------

  let activePrompt = null;

  const removePrompt = () => {
    if (!activePrompt) return;
    if (activePrompt.timer) clearTimeout(activePrompt.timer);
    activePrompt.timer = null;
    try {
      activePrompt.host.remove();
    } catch {
      /* page already removed it */
    }
    activePrompt = null;
  };

  const respond = (choice) => {
    const prompt = activePrompt;
    if (!prompt) return;
    const promptId = prompt.promptId;
    removePrompt();
    emit({ type: "promptResponse", promptId, choice });
  };

  const PROMPT_CSS = [
    ":host{all:initial}",
    ".bw-wrap{width:320px;",
    "background:#1c1c1f;color:#f2f2f5;border:1px solid #3a3a40;border-radius:10px;",
    "box-shadow:0 8px 28px rgba(0,0,0,.45);padding:14px 16px;",
    "font:13px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}",
    ".bw-title{font-weight:600;font-size:14px;margin-bottom:4px}",
    ".bw-site{color:#b9b9c2;word-break:break-all}",
    ".bw-user{color:#e8e8ec;font-weight:600;margin-top:6px;word-break:break-all}",
    ".bw-user span{color:#b9b9c2;font-weight:400}",
    ".bw-row{display:flex;gap:8px;margin-top:12px;align-items:center}",
    "button{cursor:pointer;border-radius:7px;border:1px solid transparent;",
    "padding:6px 12px;font:13px -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}",
    ".bw-save{background:#3b82f6;color:#fff}",
    ".bw-save:hover{background:#2f6fdd}",
    ".bw-plain{background:transparent;color:#b9b9c2;border-color:#4a4a52}",
    ".bw-plain:hover{background:#2a2a2f}",
    ".bw-never{margin-left:auto;background:transparent;border:none;color:#8b8b94;font-size:12px}",
    ".bw-never:hover{color:#c9c9d1}",
  ].join("");

  globalThis.__bwVaultShowPrompt = (opts) => {
    try {
      if (!isWebPage() || !document.documentElement) return;
      removePrompt();
      const promptId = String((opts?.promptId) || "");
      if (!promptId) return;
      const origin = String((opts?.origin) || "");
      const username = String((opts?.username) || "");
      const mode = (opts?.mode) === "update" ? "update" : "save";

      const host = document.createElement("div");
      host.setAttribute("data-bw-vault-prompt", "");
      // Position on the host so its bounding rect matches the visible banner
      // (shadow content does not size an unstyled host).
      host.style.cssText =
        "position:fixed;top:14px;right:14px;z-index:2147483647;display:block";
      const shadow = host.attachShadow({ mode: "closed" });
      const style = document.createElement("style");
      style.textContent = PROMPT_CSS;
      const wrap = document.createElement("div");
      wrap.className = "bw-wrap";

      const title = document.createElement("div");
      title.className = "bw-title";
      title.textContent =
        mode === "update" ? "Update saved password?" : "Save password?";
      const site = document.createElement("div");
      site.className = "bw-site";
      site.textContent = origin;
      wrap.append(title, site);
      if (username) {
        const user = document.createElement("div");
        user.className = "bw-user";
        const label = document.createElement("span");
        label.textContent = "for ";
        user.append(label, document.createTextNode(username));
        wrap.append(user);
      }
      const row = document.createElement("div");
      row.className = "bw-row";
      const save = document.createElement("button");
      save.className = "bw-save";
      save.textContent = mode === "update" ? "Update" : "Save";
      save.addEventListener("click", () => respond("save"));
      const notNow = document.createElement("button");
      notNow.className = "bw-plain";
      notNow.textContent = "Not now";
      notNow.addEventListener("click", () => respond("dismiss"));
      const never = document.createElement("button");
      never.className = "bw-never";
      never.textContent = "Never for this site";
      never.addEventListener("click", () => respond("never"));
      row.append(save, notNow, never);
      wrap.append(row);
      shadow.append(style, wrap);
      (document.body || document.documentElement).append(host);

      activePrompt = { host, promptId, timer: null };
      activePrompt.timer = setTimeout(() => respond("dismiss"), PROMPT_TIMEOUT_MS);
    } catch {
      /* prompt is best-effort; the worker-side TTL still cleans up */
    }
  };

  globalThis.__bwVaultDismissPrompt = (promptId) => {
    if (activePrompt && activePrompt.promptId === String(promptId || "")) {
      removePrompt();
    }
  };
  globalThis.__bwVaultDispose = () => {
    lifecycle.abort();
    stopClearWatch();
    removePrompt();
    lastCapture = { field: null, password: "", at: 0 };
    delete globalThis.__bwVaultSensorInstalled;
    delete globalThis.__bwVaultShowPrompt;
    delete globalThis.__bwVaultDismissPrompt;
    delete globalThis.__bwVaultDispose;
  };
})();
