import assert from "node:assert/strict";
import test from "node:test";
import { cookieReaderError } from "../../dist/src/cookie-reader-error.js";

test("cookie errors retain actionable codes without native diagnostic text", async () => {
  const error = await cookieReaderError({ rookieCode: "source_extraction_failed", message: "Permission denied: /private/secret-profile" }, {}, { timeoutMs: 1000 });
  assert.equal(error.cookiePermissionDenied, true);
  assert.equal(error.cookieReaderCode, "source_extraction_failed");
  assert.ok(!JSON.stringify(error).includes("secret-profile"));
  assert.ok(!error.message.includes("secret-profile"));
});

test("nested native acquisition reports explain generic extraction errors", async () => {
  const reader = { report: async () => ({ profiles: [{ sources: [{ issues: [{ severity: "error", stage: "acquisition", message: "Operation not permitted /private/profile" }] }] }] }) };
  const error = await cookieReaderError({ rookieCode: "source_extraction_failed" }, reader, { timeoutMs: 1000 });
  assert.equal(error.cookiePermissionDenied, true);
  assert.equal(error.cookieReaderStage, "acquisition");
  assert.ok(!JSON.stringify(error).includes("/private/profile"));
  const unavailable = await cookieReaderError({ rookieCode: "secret-code" }, reader, { timeoutMs: 1000 });
  assert.equal(unavailable.cookieReaderCode, "reader_failed");
  assert.equal(unavailable.cookieReaderStage, undefined);
});
