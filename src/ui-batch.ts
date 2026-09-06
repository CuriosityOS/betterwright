import { setTimeout as hostDelay } from "node:timers/promises";

import { inspectActionDirectory } from "./page-inspect.js";
import { isBoolean, isNumber, isRecord, isString, type UntrustedValue, untrustedField } from "./untrusted-value.js";

const MAX_OPERATIONS = 32;
const MAX_JSON_CHARS = 128_000;
const MAX_TEXT_CHARS = 10_000;
const MAX_PACING_MS = 1_000;
const MAX_DIRECTORY_WAIT_MS = 5_000;
const EXPECTATION_TIMEOUT_MS = 10_000;
const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const REF_PATTERN = /^(?:aria-ref=)?(?:f\d+)*e\d+$/;
const READ_ACTIONS = new Set(["read", "readUrl"]);
const ACTIONS = new Set([
  "click",
  "fill",
  "select",
  "check",
  "uncheck",
  "press",
  "read",
  "readUrl",
]);

interface UIBatchOperationResult {
  ariaLabel?: string;
  checked?: boolean;
  clicked?: boolean;
  disabled?: boolean;
  durationMs?: number;
  filled?: number;
  pressed?: string;
  selected?: string[];
  tag?: string;
  text?: string;
  title?: string;
  url?: string;
  value?: string;
}

interface BatchActivity {
  lastAt: number;
  pending: Set<unknown>;
}

function boundedString(value: UntrustedValue, label: string, maximum: number) {
  if (!isString(value)) throw new TypeError(`${label} must be a string.`);
  const text = value.trim();
  if (!text) throw new TypeError(`${label} must not be empty.`);
  if (text.length > maximum) throw new RangeError(`${label} exceeds ${maximum} characters.`);
  return text;
}

function cloneJson(value: UntrustedValue, label: string) {
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch (error) {
    throw new TypeError(`${label} must be JSON-serializable: ${error?.message || error}`);
  }
  if (encoded === undefined || encoded.length > MAX_JSON_CHARS) {
    throw new RangeError(`${label} exceeds its ${MAX_JSON_CHARS}-character limit.`);
  }
  return JSON.parse(encoded);
}

function targetLocator(page, targetValue, operationId) {
  if (!isRecord(targetValue)) {
    throw new TypeError(`UI batch operation ${JSON.stringify(operationId)} target must be an object.`);
  }
  const methods = ["ref", "role", "label", "text", "placeholder", "testId", "css"]
    .filter((key) => untrustedField(targetValue, key) !== undefined);
  if (methods.length !== 1) {
    throw new Error(
      `UI batch operation ${JSON.stringify(operationId)} target must use exactly one of ref, role, label, text, placeholder, testId, or css.`,
    );
  }
  const method = methods[0];
  const exactValue = untrustedField(targetValue, "exact");
  if (exactValue !== undefined && !isBoolean(exactValue)) {
    throw new TypeError(`UI batch operation ${JSON.stringify(operationId)} target exact must be boolean.`);
  }
  const exact = exactValue === true;
  const nameValue = untrustedField(targetValue, "name");
  const frameUrlValue = untrustedField(targetValue, "frameUrlIncludes");
  const frameNameValue = untrustedField(targetValue, "frameName");
  if (frameUrlValue !== undefined && frameNameValue !== undefined) {
    throw new Error(`UI batch operation ${JSON.stringify(operationId)} target cannot combine frameUrlIncludes and frameName.`);
  }
  let root = page;
  if (frameUrlValue !== undefined || frameNameValue !== undefined) {
    const frameUrl = frameUrlValue === undefined
      ? ""
      : boundedString(frameUrlValue, "UI batch frameUrlIncludes", 1_000);
    const frameName = frameNameValue === undefined
      ? ""
      : boundedString(frameNameValue, "UI batch frameName", 500);
    const frames = page.frames().filter((frame) =>
      (frameUrl && frame.url().includes(frameUrl)) || (frameName && frame.name() === frameName));
    if (frames.length !== 1) {
      throw new Error(
        `UI batch operation ${JSON.stringify(operationId)} frame matched ${frames.length} frames; use a unique frame URL fragment or name.`,
      );
    }
    root = frames[0];
  }
  let locator;
  if (method === "ref") {
    const ref = boundedString(untrustedField(targetValue, "ref"), "UI batch ref", 64);
    if (!REF_PATTERN.test(ref)) throw new Error(`UI batch operation ${JSON.stringify(operationId)} has an invalid aria ref.`);
    locator = root.locator(ref.startsWith("aria-ref=") ? ref : `aria-ref=${ref}`);
  } else if (method === "role") {
    const role = boundedString(untrustedField(targetValue, "role"), "UI batch role", 64);
    const options: any = { exact };
    if (nameValue !== undefined) options.name = boundedString(nameValue, "UI batch accessible name", 500);
    locator = root.getByRole(role, options);
  } else if (method === "label") {
    locator = root.getByLabel(
      boundedString(untrustedField(targetValue, "label"), "UI batch label", 500),
      { exact },
    );
  } else if (method === "text") {
    locator = root.getByText(
      boundedString(untrustedField(targetValue, "text"), "UI batch text", 500),
      { exact },
    );
  } else if (method === "placeholder") {
    locator = root.getByPlaceholder(
      boundedString(untrustedField(targetValue, "placeholder"), "UI batch placeholder", 500),
      { exact },
    );
  } else if (method === "testId") {
    locator = root.getByTestId(
      boundedString(untrustedField(targetValue, "testId"), "UI batch test id", 500),
    );
  } else {
    locator = root.locator(boundedString(untrustedField(targetValue, "css"), "UI batch CSS", 2_000));
  }
  const nthValue = untrustedField(targetValue, "nth");
  if (nthValue !== undefined) {
    if (!isNumber(nthValue) || !Number.isInteger(nthValue) || nthValue < 0 || nthValue > 99) {
      throw new RangeError(`UI batch operation ${JSON.stringify(operationId)} target nth must be an integer from 0 to 99.`);
    }
    locator = locator.nth(nthValue);
  }
  return locator;
}

async function exactLocator(page, target, operationId) {
  const locator = targetLocator(page, target, operationId);
  // Role/text engines intentionally omit hidden controls. Waiting for one
  // match before enforcing uniqueness lets a delayed result become visible
  // while still refusing an ambiguous target once it is actionable.
  await locator.first().waitFor({ state: "attached" });
  const count = await locator.count();
  if (count !== 1) {
    throw new Error(
      `UI batch operation ${JSON.stringify(operationId)} target matched ${count} elements; use a more precise target or nth.`,
    );
  }
  return locator;
}

async function readLocator(locator) {
  await locator.waitFor({ state: "visible" });
  return locator.evaluate((element) => {
    const input = element instanceof HTMLInputElement ? element : null;
    const valueControl = element instanceof HTMLInputElement ||
        element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement
      ? element
      : null;
    const disableable = valueControl || element instanceof HTMLButtonElement
      ? element
      : null;
    const text = element instanceof HTMLElement
      ? (element.innerText || element.textContent || "").trim()
      : (element.textContent || "").trim();
    return {
      tag: element.tagName.toLowerCase(),
      text: text.slice(0, 4_000),
      value: input?.type === "password"
        ? "[redacted]"
        : valueControl
          ? String(valueControl.value ?? "").slice(0, 4_000)
          : undefined,
      checked: input && ["checkbox", "radio"].includes(input.type) ? input.checked : undefined,
      disabled: disableable ? disableable.matches(":disabled") : undefined,
      ariaLabel: element.getAttribute("aria-label") || undefined,
    };
  });
}

async function readLocatorWhen(locator, expected, operationId) {
  if (expected === undefined) return readLocator(locator);
  if (!isString(expected) || !expected.trim() || expected.length > MAX_TEXT_CHARS) {
    throw new TypeError(
      `UI batch operation ${JSON.stringify(operationId)} read value must be a non-empty expected substring of at most ${MAX_TEXT_CHARS} characters.`,
    );
  }
  const deadline = Date.now() + EXPECTATION_TIMEOUT_MS;
  let result;
  do {
    result = await readLocator(locator);
    if ([result.text, result.value].some((value) => isString(value) && value.includes(expected))) {
      return result;
    }
    await hostDelay(25);
  } while (Date.now() < deadline);
  throw new Error(
    `UI batch operation ${JSON.stringify(operationId)} did not reach expected text/value ${JSON.stringify(expected)} within ${EXPECTATION_TIMEOUT_MS}ms.`,
  );
}

async function readUrlWhen(page, expected, operationId) {
  if (expected === undefined) return { url: page.url(), title: await page.title() };
  if (!isString(expected) || !expected.trim() || expected.length > 2_000) {
    throw new TypeError(
      `UI batch operation ${JSON.stringify(operationId)} readUrl value must be a non-empty expected URL substring of at most 2000 characters.`,
    );
  }
  const deadline = Date.now() + EXPECTATION_TIMEOUT_MS;
  while (!page.url().includes(expected) && Date.now() < deadline) await hostDelay(25);
  if (!page.url().includes(expected)) {
    throw new Error(
      `UI batch operation ${JSON.stringify(operationId)} URL did not include ${JSON.stringify(expected)} within ${EXPECTATION_TIMEOUT_MS}ms.`,
    );
  }
  return { url: page.url(), title: await page.title() };
}

async function assertNotPassword(locator, operationId, allowPasswordFill) {
  const password = await locator.evaluate((element) =>
    element instanceof HTMLInputElement && element.type.toLowerCase() === "password");
  if (password && !allowPasswordFill) {
    throw new Error(
      `UI batch operation ${JSON.stringify(operationId)} cannot fill a password. Use credentials.fill(), credentials.generateAndFill(), or an explicitly task-supplied credential in ordinary browser code.`,
    );
  }
}

function normalizeOptions(value: UntrustedValue) {
  if (value === undefined) {
    return {
      allowWrites: false,
      allowIrreversible: false,
      minIntervalMs: 40,
      returnDirectory: false,
      directoryWaitMs: 0,
      allowPasswordFill: false,
    };
  }
  if (!isRecord(value)) throw new TypeError("controls.batch options must be an object.");
  const pacing = untrustedField(value, "minIntervalMs");
  if (pacing !== undefined && (!isNumber(pacing) || !Number.isInteger(pacing) || pacing < 0 || pacing > MAX_PACING_MS)) {
    throw new RangeError(`controls.batch minIntervalMs must be an integer from 0 to ${MAX_PACING_MS}.`);
  }
  const returnDirectory = untrustedField(value, "returnDirectory") === true;
  const directoryWait = untrustedField(value, "directoryWaitMs");
  if (
    directoryWait !== undefined &&
    (!isNumber(directoryWait) || !Number.isInteger(directoryWait) || directoryWait < 0 || directoryWait > MAX_DIRECTORY_WAIT_MS)
  ) {
    throw new RangeError(
      `controls.batch directoryWaitMs must be an integer from 0 to ${MAX_DIRECTORY_WAIT_MS}.`,
    );
  }
  return {
    allowWrites: untrustedField(value, "allowWrites") === true,
    allowIrreversible: untrustedField(value, "allowIrreversible") === true,
    minIntervalMs: pacing === undefined ? 40 : Number(pacing),
    returnDirectory,
    directoryWaitMs: directoryWait === undefined ? 2_500 : Number(directoryWait),
    allowPasswordFill: untrustedField(value, "allowPasswordFill") === true,
  };
}

async function refreshedActionDirectory(page, waitMs: number, activity: BatchActivity) {
  const deadline = Date.now() + waitMs;
  const minimumUntil = Date.now() + Math.min(125, waitMs);
  let directory = await inspectActionDirectory(page);
  let signature = JSON.stringify(directory);
  let stableSince = Date.now();
  do {
    await hostDelay(25);
    const next = await inspectActionDirectory(page);
    const nextSignature = JSON.stringify(next);
    if (nextSignature !== signature) {
      directory = next;
      signature = nextSignature;
      stableSince = Date.now();
    }
    const now = Date.now();
    if (
      now >= minimumUntil &&
      now - stableSince >= 100 &&
      now - activity.lastAt >= 100 &&
      activity.pending.size === 0
    ) {
      break;
    }
  } while (Date.now() < deadline);
  return directory;
}

async function settleAfterWrites(activity: BatchActivity, waitMs = 2_500) {
  const deadline = Date.now() + waitMs;
  const minimumUntil = Date.now() + Math.min(125, waitMs);
  do {
    const now = Date.now();
    if (
      now >= minimumUntil &&
      now - activity.lastAt >= 100 &&
      activity.pending.size === 0
    ) {
      return;
    }
    await hostDelay(25);
  } while (Date.now() < deadline);
}

/** A guarded one-call UI transaction for sites without a first-party protocol. */
export async function executeUIBatch(page, operationsValue: UntrustedValue, optionsValue?: UntrustedValue) {
  if (!Array.isArray(operationsValue) || !operationsValue.length) {
    throw new TypeError("controls.batch operations must be a non-empty array.");
  }
  if (operationsValue.length > MAX_OPERATIONS) {
    throw new RangeError(`controls.batch accepts at most ${MAX_OPERATIONS} operations.`);
  }
  cloneJson(operationsValue, "controls.batch operations");
  const options = normalizeOptions(optionsValue);
  const ids = new Set<string>();
  const operations = operationsValue.map((value, index) => {
    if (!isRecord(value)) throw new TypeError(`UI batch operation ${index + 1} must be an object.`);
    const id = boundedString(untrustedField(value, "id"), `UI batch operation ${index + 1} id`, 64);
    if (!ID_PATTERN.test(id)) throw new Error(`UI batch operation ${index + 1} has an invalid id.`);
    if (ids.has(id)) throw new Error(`UI batch operation id ${JSON.stringify(id)} is duplicated.`);
    ids.add(id);
    const action = boundedString(untrustedField(value, "action"), `UI batch operation ${JSON.stringify(id)} action`, 32);
    if (!ACTIONS.has(action)) throw new Error(`UI batch operation ${JSON.stringify(id)} has unsupported action ${JSON.stringify(action)}.`);
    const irreversible = untrustedField(value, "irreversible") === true;
    if (!READ_ACTIONS.has(action) && !options.allowWrites) {
      throw new Error(`UI batch action ${JSON.stringify(action)} changes page state; pass {allowWrites:true} only when authorized.`);
    }
    if (irreversible && !options.allowIrreversible) {
      throw new Error(`UI batch operation ${JSON.stringify(id)} is marked irreversible; pass {allowIrreversible:true} only after required confirmation.`);
    }
    const target = untrustedField(value, "target");
    if (action !== "readUrl" && !isRecord(target)) {
      throw new TypeError(`UI batch operation ${JSON.stringify(id)} requires a target.`);
    }
    return { id, action, target, value: untrustedField(value, "value"), irreversible };
  });
  const hasWrites = operations.some((operation) => !READ_ACTIONS.has(operation.action));
  const finalOperation = operations.at(-1);
  if (hasWrites && !READ_ACTIONS.has(finalOperation?.action || "")) {
    throw new Error("A mutating controls.batch transaction must end with read or readUrl verification.");
  }
  if (
    hasWrites &&
    (!isString(finalOperation?.value) || !finalOperation.value.trim())
  ) {
    throw new Error(
      "A mutating controls.batch transaction's final read/readUrl must include a non-empty expected value.",
    );
  }

  const results = new Map<string, UIBatchOperationResult>();
  const startedAt = Date.now();
  const activity: BatchActivity = { lastAt: startedAt, pending: new Set() };
  const relevantRequest = (request) => ["document", "fetch", "xhr"].includes(request.resourceType());
  const requestStarted = (request) => {
    if (!relevantRequest(request)) return;
    activity.pending.add(request);
    activity.lastAt = Date.now();
  };
  const requestEnded = (request) => {
    if (!activity.pending.delete(request)) return;
    activity.lastAt = Date.now();
  };
  if (hasWrites) {
    page.on("request", requestStarted);
    page.on("requestfinished", requestEnded);
    page.on("requestfailed", requestEnded);
  }
  try {
    let needsSettle = false;
    for (const [index, operation] of operations.entries()) {
      if (index && options.minIntervalMs) await hostDelay(options.minIntervalMs);
      const operationStartedAt = Date.now();
      try {
        if (READ_ACTIONS.has(operation.action) && needsSettle) {
          await settleAfterWrites(activity);
          needsSettle = false;
        }
        if (operation.action === "readUrl") {
          results.set(operation.id, await readUrlWhen(page, operation.value, operation.id));
          continue;
        }
        const locator = await exactLocator(page, operation.target, operation.id);
        if (operation.action === "click") {
          await locator.click();
          results.set(operation.id, { clicked: true });
        } else if (operation.action === "fill") {
          await assertNotPassword(locator, operation.id, options.allowPasswordFill);
          if (!isString(operation.value) || operation.value.length > MAX_TEXT_CHARS) {
            throw new TypeError(`UI batch operation ${JSON.stringify(operation.id)} fill value must be a string of at most ${MAX_TEXT_CHARS} characters.`);
          }
          await locator.fill(operation.value);
          results.set(operation.id, { filled: operation.value.length });
        } else if (operation.action === "select") {
          const values = Array.isArray(operation.value) ? operation.value : [operation.value];
          if (!values.length || values.length > 50 || values.some((entry) => !isString(entry) || !entry.length || entry.length > 500)) {
            throw new TypeError(`UI batch operation ${JSON.stringify(operation.id)} select value must be a string or a bounded string array.`);
          }
          results.set(operation.id, { selected: await locator.selectOption(values) });
        } else if (operation.action === "check") {
          await locator.check();
          results.set(operation.id, { checked: true });
        } else if (operation.action === "uncheck") {
          await locator.uncheck();
          results.set(operation.id, { checked: false });
        } else if (operation.action === "press") {
          const key = boundedString(operation.value, `UI batch operation ${JSON.stringify(operation.id)} key`, 100);
          await locator.press(key);
          results.set(operation.id, { pressed: key });
        } else {
          results.set(operation.id, await readLocatorWhen(locator, operation.value, operation.id));
        }
        if (!READ_ACTIONS.has(operation.action)) needsSettle = true;
      } catch (error) {
        throw new Error(
          `UI batch operation ${JSON.stringify(operation.id)} (${operation.action}) failed: ${error?.message || error}`,
        );
      } finally {
        const result = results.get(operation.id);
        if (result) result.durationMs = Date.now() - operationStartedAt;
      }
    }
    const ui = options.returnDirectory && hasWrites
      ? await refreshedActionDirectory(page, options.directoryWaitMs, activity)
      : undefined;
    const outcome: any = {
      protocol: "ui-batch/1",
      pageUpdated: hasWrites,
      durationMs: Date.now() - startedAt,
      results: Object.fromEntries(results),
    };
    if (ui) outcome.ui = ui;
    return outcome;
  } finally {
    page.off("request", requestStarted);
    page.off("requestfinished", requestEnded);
    page.off("requestfailed", requestEnded);
  }
}
