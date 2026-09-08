import { isCallable, isString, type UntrustedValue, untrustedField } from "./untrusted-value.js";

const CODES = new Set(["source_extraction_failed", "source_inspection_failed", "discovery_failed", "no_selected_source", "no_discovered_source", "timed_out", "cancelled", "resource_exhausted"]);
const STAGES = new Set(["acquisition", "parse", "decrypt", "decode", "query", "discovery"]);
const denied = (value: UntrustedValue) => isString(value) && /\b(?:Permission denied|Operation not permitted|os error (?:1|13))\b/i.test(value);

export class CookieReaderError extends Error {
  cookieReaderCode: string;
  cookiePermissionDenied: boolean;
  cookieReaderStage?: string;
  constructor(cause: UntrustedValue) {
    super("Cookie Sync could not read the selected local browser profile.");
    const code = untrustedField(cause, "rookieCode");
    this.cookieReaderCode = isString(code) && CODES.has(code) ? code : "reader_failed";
    this.cookiePermissionDenied = denied(untrustedField(cause, "message"));
  }
}

/** Extract only fixed diagnostic fields. Native messages can contain paths or secrets. */
export async function cookieReaderError(cause, reader, options): Promise<CookieReaderError> {
  const error = new CookieReaderError(cause);
  const report = untrustedField(reader, "report");
  if (error.cookiePermissionDenied || error.cookieReaderCode !== "source_extraction_failed" || !isCallable(report)) return error;
  try {
    const pending = [await report.call(reader, { ...options, select: "legacy_first", timeoutMs: Math.min(options.timeoutMs, 10_000), appBound: "disabled" })];
    for (let visited = 0; pending.length && visited < 100; visited++) {
      const node = pending.shift();
      const issues = untrustedField(node, "issues");
      if (Array.isArray(issues)) for (const issue of issues.slice(0, 100)) {
        if (untrustedField(issue, "severity") !== "error") continue;
        const stage = untrustedField(issue, "stage");
        if (isString(stage) && STAGES.has(stage)) error.cookieReaderStage = stage;
        if (denied(untrustedField(issue, "message"))) error.cookiePermissionDenied = true;
      }
      for (const field of ["profiles", "sources"]) {
        const children = untrustedField(node, field);
        if (Array.isArray(children)) pending.push(...children.slice(0, 100));
      }
    }
  } catch { /* The fixed original error remains useful without a report. */ }
  return error;
}
