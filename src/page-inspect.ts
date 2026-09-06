// Page-inspection helpers behind the worker's `overlays`, `controls`, and
// `media` sandbox globals. Each takes a Playwright page and returns plain
// JSON; they are kept out of worker.ts so the worker stays orchestration
// and this stays reviewable (and testable) on its own.

const COOKIE_OVERLAY_TEXT = /\b(cookie|consent|privacy|tracking|personal data)\b/i;
const PROMO_OVERLAY_TEXT =
  /\b(newsletter|subscribe|sign[ -]?up|discount|special offer|notifications?|download (?:our|the) app|join (?:our|the) rewards)\b/i;
const COOKIE_REJECT_NAMES = [
  /^(?:reject|decline)(?: all)?(?: cookies)?$/i,
  /^(?:use |only )?(?:essential|necessary)(?: cookies)?(?: only)?$/i,
  /^(?:continue without|do not) (?:accepting|agreeing|cookies)$/i,
];
const COOKIE_ACCEPT_NAMES = [
  /^(?:accept|allow)(?: all)?(?: cookies)?$/i,
  /^(?:agree|i agree|got it|ok(?:ay)?)$/i,
];
const PROMO_DISMISS_NAMES = [
  /^(?:close|dismiss|no thanks|not now|maybe later|skip|continue without signing up)$/i,
  /^(?:×|✕|✖)$/,
];
const OVERLAY_ROOT_SELECTOR = [
  '[role="dialog"]',
  '[aria-modal="true"]',
  '[id*="cookie" i]',
  '[class*="cookie" i]',
  '[id*="consent" i]',
  '[class*="consent" i]',
  '[class*="newsletter" i]',
  '[class*="modal" i]',
  '[class*="popup" i]',
].join(",");

async function clickFirstVisibleByName(root, patterns) {
  for (const pattern of patterns) {
    for (const role of ["button", "link"]) {
      const candidates = root.getByRole(role, { name: pattern });
      const count = Math.min(await candidates.count().catch(() => 0), 4);
      for (let index = 0; index < count; index += 1) {
        const candidate = candidates.nth(index);
        if (!(await candidate.isVisible().catch(() => false))) continue;
        const label = String(
          (await candidate.getAttribute("aria-label").catch(() => "")) ||
            (await candidate.innerText().catch(() => "")) ||
            role,
        ).trim();
        if (
          await candidate
            .click({ timeout: 2_500 })
            .then(() => true)
            .catch(() => false)
        ) {
          return label;
        }
      }
    }
  }
  return null;
}

export async function dismissObstructiveOverlays(page) {
  const dismissed = [];
  for (const frame of page.frames()) {
    for (let pass = 0; pass < 8; pass += 1) {
      const roots = frame.locator(OVERLAY_ROOT_SELECTOR);
      const count = Math.min(await roots.count().catch(() => 0), 16);
      let removed = false;
      for (let index = 0; index < count; index += 1) {
        const root = roots.nth(index);
        if (!(await root.isVisible().catch(() => false))) continue;
        const text = String(await root.innerText().catch(() => "")).slice(0, 2_000);
        let kind = null;
        let label = null;
        if (COOKIE_OVERLAY_TEXT.test(text)) {
          kind = "cookie";
          label = await clickFirstVisibleByName(root, COOKIE_REJECT_NAMES);
          if (!label) label = await clickFirstVisibleByName(root, COOKIE_ACCEPT_NAMES);
        } else if (PROMO_OVERLAY_TEXT.test(text)) {
          kind = "promotion";
          label = await clickFirstVisibleByName(root, PROMO_DISMISS_NAMES);
        }
        if (!label) continue;
        dismissed.push({ kind, label });
        await root.waitFor({ state: "hidden", timeout: 2_500 }).catch(() => {});
        removed = true;
        break;
      }
      if (!removed) break;
    }
  }
  return { dismissed };
}

export async function inspectControls(page) {
  const frames = [];
  for (const frame of page.frames()) {
    const controls = await frame
      .evaluate(() => {
        const selector = [
          "input",
          "select",
          "textarea",
          '[role="checkbox"]',
          '[role="combobox"]',
          '[role="listbox"]',
          '[role="radio"]',
          '[role="slider"]',
          '[role="spinbutton"]',
          '[role="switch"]',
          '[aria-selected="true"]',
          '[aria-pressed="true"]',
        ].join(",");
        const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
        const labelFor = (element) => {
          const label = element.labels?.[0] || element.closest("label");
          let labelText = "";
          if (label) {
            const copy = label.cloneNode(true);
            for (const control of copy.querySelectorAll("input,select,textarea,button")) {
              control.remove();
            }
            labelText = copy.textContent;
          }
          return clean(
            element.getAttribute("aria-label") ||
              labelText ||
              element.getAttribute("placeholder") ||
              element.getAttribute("title") ||
              element.getAttribute("name"),
          ).slice(0, 180);
        };
        return [...document.querySelectorAll(selector)].slice(0, 120).map((element) => {
          const type = clean(
            element.getAttribute("role") ||
              element.getAttribute("type") ||
              element.tagName.toLowerCase(),
          );
          const password = type.toLowerCase() === "password";
          const options =
            element instanceof HTMLSelectElement
              ? [...element.options].slice(0, 60).map((option) => ({
                  text: clean(option.textContent).slice(0, 120),
                  value: option.value,
                  selected: option.selected,
                  disabled: option.disabled,
                }))
              : undefined;
          const control = {
            type,
            label: labelFor(element),
            value: password ? "[redacted]" : "value" in element ? String(element.value) : null,
            checked: "checked" in element ? Boolean(element.checked) : null,
            selected: element.getAttribute("aria-selected"),
            pressed: element.getAttribute("aria-pressed"),
            ariaChecked: element.getAttribute("aria-checked"),
            min: element.getAttribute("min"),
            max: element.getAttribute("max"),
            step: element.getAttribute("step"),
            disabled:
              ("disabled" in element && Boolean(element.disabled)) ||
              element.getAttribute("aria-disabled") === "true",
            visible: Boolean(element.getClientRects().length),
          };
          // `options` stays absent (not present-undefined) for non-selects, as
          // the serialized inspection result is compared and rendered as JSON.
          return options ? { ...control, options } : control;
        });
      })
      .catch(() => []);
    if (controls.length) frames.push({ url: frame.url(), controls });
  }
  return { frames };
}

// A compact, model-facing action directory for pages without a first-party
// WebAgents manifest. It deliberately favors semantic locators that can be
// copied verbatim into browser_batch and caps link-heavy pages so a generic
// article never turns into a multi-thousand-token accessibility dump.
export async function inspectActionDirectory(page) {
  const controls: any[] = [];
  let truncated = false;
  const frames = page.frames();
  const frameNames = new Map();
  for (const frame of frames) {
    const name = frame.name();
    if (name) frameNames.set(name, (frameNames.get(name) || 0) + 1);
  }
  for (const frame of frames) {
    const entries = await frame.evaluate(() => {
      const clean = (value, limit = 180) => String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
      const visible = (element) => {
        const style = getComputedStyle(element);
        return Boolean(element.getClientRects().length) && style.visibility !== "hidden" && style.display !== "none";
      };
      const labelFor = (element) => {
        const labelledBy = clean(element.getAttribute("aria-labelledby"));
        const labelledText = labelledBy
          ? labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent || "").join(" ")
          : "";
        const label = element.labels?.[0] || element.closest("label");
        let labelText = "";
        if (label) {
          const copy = label.cloneNode(true);
          for (const nested of copy.querySelectorAll("input,select,textarea,button")) nested.remove();
          labelText = copy.textContent;
        }
        return clean(element.getAttribute("aria-label") || labelledText || labelText);
      };
      const roleFor = (element) => {
        const explicit = clean(element.getAttribute("role"), 40);
        if (explicit) return explicit;
        const tag = element.tagName.toLowerCase();
        if (tag === "button") return "button";
        if (tag === "a") return "link";
        if (tag === "select") return "combobox";
        if (tag === "textarea") return "textbox";
        if (tag !== "input") return tag;
        const type = clean(element.getAttribute("type") || "text", 40).toLowerCase();
        if (["button", "submit", "reset", "image"].includes(type)) return "button";
        if (type === "checkbox") return "checkbox";
        if (type === "radio") return "radio";
        if (type === "number") return "spinbutton";
        if (type === "range") return "slider";
        if (type === "search") return "searchbox";
        return "textbox";
      };
      const contexts = new Map<Element, string>();
      const contextFor = (element) => {
        let root = element.closest("article,li,[role='listitem'],form,section");
        if (!root) {
          let cursor = element.parentElement;
          for (let depth = 0; cursor && depth < 4; depth += 1, cursor = cursor.parentElement) {
            const text = clean(cursor.innerText, 500);
            if (text && text.length <= 500) root = cursor;
          }
        }
        if (!root) return "";
        const cached = contexts.get(root);
        if (cached !== undefined) return cached;
        const copy = root.cloneNode(true);
        for (const control of copy.querySelectorAll(
          "button,input,select,textarea,[role='button'],[role='link']",
        )) control.remove();
        const context = clean(copy.textContent, 180);
        contexts.set(root, context);
        return context;
      };
      const candidates = [...document.querySelectorAll([
        "button", "input", "select", "textarea", "a[href]",
        "[role='button']", "[role='checkbox']", "[role='combobox']",
        "[role='link']", "[role='radio']", "[role='searchbox']",
        "[role='slider']", "[role='spinbutton']", "[role='switch']", "[role='textbox']",
      ].join(","))].filter(visible);
      const unique = [...new Set(candidates)].filter((element) =>
        !(element instanceof HTMLInputElement && element.type.toLowerCase() === "file"));
      const primary = unique.filter((element) => roleFor(element) !== "link");
      const links = unique.filter((element) => roleFor(element) === "link");
      const selected = [...primary.slice(0, 36), ...links.slice(0, Math.max(0, 40 - primary.length))].slice(0, 40);
      return {
        total: unique.length,
        entries: selected.map((element) => {
          const role = roleFor(element);
          const label = labelFor(element);
          const placeholder = clean(element.getAttribute("placeholder"));
          const formControl = element instanceof HTMLInputElement ||
            element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement;
          const buttonValue = element instanceof HTMLInputElement &&
            ["button", "submit", "reset", "image"].includes(element.type.toLowerCase())
            ? element.value
            : "";
          const name = clean(
            element.getAttribute("aria-label") ||
            label ||
            element.getAttribute("alt") ||
            (!formControl && element instanceof HTMLElement ? element.innerText : "") ||
            buttonValue ||
            element.getAttribute("title") ||
            placeholder,
          );
          const password = element instanceof HTMLInputElement && element.type.toLowerCase() === "password";
          const value = "value" in element
            ? password ? "[redacted]" : clean(element.value, 240)
            : "";
          const options = element instanceof HTMLSelectElement
            ? [...element.options].slice(0, 20).map((option) => [clean(option.textContent, 100), clean(option.value, 100), option.selected])
            : undefined;
          return {
            role,
            label,
            placeholder,
            name,
            value,
            checked: element instanceof HTMLInputElement && ["checkbox", "radio"].includes(element.type)
              ? Boolean(element.checked)
              : undefined,
            disabled: "disabled" in element ? Boolean(element.disabled) : element.getAttribute("aria-disabled") === "true",
            options,
            context: contextFor(element),
          };
        }).filter((entry) => !(["button", "link"].includes(entry.role) && !entry.name)),
      };
    }).catch(() => ({ total: 0, entries: [] }));
    if (!entries.entries.length) continue;
    if (entries.total > entries.entries.length) truncated = true;
    const methodFor = (entry) =>
      ["combobox", "listbox"].includes(entry.role)
        ? "role"
        : entry.label
          ? "label"
          : entry.placeholder
            ? "placeholder"
            : "role";
    const duplicateCounts = new Map();
    for (const entry of entries.entries) {
      const method = methodFor(entry);
      const value = method === "label" ? entry.label : method === "placeholder" ? entry.placeholder : `${entry.role}\u0000${entry.name}`;
      const key = `${method}\u0000${value}`;
      duplicateCounts.set(key, (duplicateCounts.get(key) || 0) + 1);
    }
    const seen = new Map();
    for (const entry of entries.entries) {
      const method = methodFor(entry);
      const value = method === "label" ? entry.label : method === "placeholder" ? entry.placeholder : `${entry.role}\u0000${entry.name}`;
      const key = `${method}\u0000${value}`;
      const index = seen.get(key) || 0;
      seen.set(key, index + 1);
      const target: any = method === "label"
        ? { label: entry.label, exact: true }
        : method === "placeholder"
          ? { placeholder: entry.placeholder, exact: true }
          : entry.name
            ? { role: entry.role, name: entry.name, exact: true }
            : { role: entry.role, exact: true };
      if ((duplicateCounts.get(key) || 0) > 1) target.nth = index;
      if (frame !== page.mainFrame()) {
        const frameName = frame.name();
        if (frameName && frameNames.get(frameName) === 1) target.frameName = frameName;
        else target.frameUrlIncludes = frame.url();
      }
      const actions = ["read"];
      if (["textbox", "searchbox", "spinbutton"].includes(entry.role)) actions.unshift("fill");
      else if (["combobox", "listbox"].includes(entry.role)) actions.unshift("select");
      else if (["checkbox", "radio", "switch"].includes(entry.role)) actions.unshift("check");
      else if (["button", "link"].includes(entry.role)) actions.unshift("click");
      const compact: any = { target, actions };
      if (entry.value) compact.value = entry.value;
      if (entry.checked !== undefined) compact.checked = entry.checked;
      if (entry.disabled) compact.disabled = true;
      if (entry.options) compact.options = entry.options;
      if ((duplicateCounts.get(key) || 0) > 1 && entry.context) compact.context = entry.context;
      controls.push(compact);
    }
  }
  const evidence = await page.evaluate(() => {
    const clean = (value, limit = 500) => String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
    const visible = (element) => {
      const style = getComputedStyle(element);
      return Boolean(element.getClientRects().length) && style.visibility !== "hidden" && style.display !== "none";
    };
    const candidates = [...document.querySelectorAll([
      "[role='status']", "[role='alert']", "[aria-live]",
      "[id*='summary' i]", "[id*='result' i]", "[id*='confirmation' i]",
    ].join(","))].filter(visible).slice(0, 12);
    return candidates.flatMap((element) => {
      const text = clean(element instanceof HTMLElement ? element.innerText : element.textContent);
      if (!text) return [];
      const id = element.getAttribute("id");
      const role = element.getAttribute("role");
      const target = id
        ? { css: `#${CSS.escape(id)}` }
        : role
          ? { role }
          : null;
      return target ? [{ target, text }] : [];
    });
  }).catch(() => []);
  return {
    protocol: "betterwright-ui/1",
    tool: "browser_batch",
    controls,
    evidence,
    truncated,
  };
}

export async function inspectMedia(page) {
  const frames = [];
  for (const frame of page.frames()) {
    const media = await frame
      .evaluate(() => {
        const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
        const headings = [...document.querySelectorAll("h1,h2,h3")]
          .filter((element) => element.getClientRects().length)
          .slice(0, 8)
          .map((element) => clean(element.textContent).slice(0, 180));
        return [...document.querySelectorAll<HTMLMediaElement>("video,audio")]
          .slice(0, 20)
          .map((element) => ({
              kind: element.tagName.toLowerCase(),
              title: clean(
                element.getAttribute("aria-label") ||
                  element.getAttribute("title") ||
                  element
                    .closest("figure,section,article")
                    ?.querySelector("figcaption,h1,h2,h3")?.textContent,
              ).slice(0, 240),
              source: element.currentSrc || element.src || null,
              paused: element.paused,
              ended: element.ended,
              currentTime: Number.isFinite(element.currentTime)
                ? element.currentTime
                : null,
              duration: Number.isFinite(element.duration) ? element.duration : null,
              readyState: element.readyState,
              visible: Boolean(element.getClientRects().length),
              documentTitle: document.title,
              headings,
            }));
      })
      .catch(() => []);
    if (media.length) frames.push({ url: frame.url(), media });
  }
  return { frames };
}
