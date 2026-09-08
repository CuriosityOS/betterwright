import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BetterWright } from "../../dist/src/client.js";
import { betterwrightExpectedInputs } from "../../dist/src/electron-input.js";
import { BetterwrightKeyboardPolicy } from "../../dist/src/electron-keyboard-policy.js";
import { LocalCredentialVault } from "../../dist/src/vault.js";

test("host key provider does not persist its key and zeroes every borrowed buffer", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bw-host-key-"));
  const buffers: Buffer[] = [];
  const keyProvider = async () => { const key = Buffer.alloc(32, 7); buffers.push(key); return key; };
  try {
    const vault = new LocalCredentialVault({ dir, keyProvider });
    await vault.handleRequest("save", { username: "test", password: "synthetic-only" }, "https://example.com");
    assert.ok(buffers.every(buffer => buffer.every(byte => byte === 0)));
    const reopened = new LocalCredentialVault({ dir, keyProvider });
    const records = await reopened.handleRequest("list", {}, "https://example.com");
    assert.equal(records.credentials.length, 1);
    assert.equal(fs.existsSync(path.join(dir, "vault.key")), false);
    vault.trackRedactionSecret("capture-secret");
    assert.ok(!JSON.stringify(vault.redact({ nested: "capture-secret" })).includes("capture-secret"));
    const wrong = Buffer.alloc(32, 8);
    const bad = new LocalCredentialVault({ dir, keyProvider: async () => wrong });
    await assert.rejects(bad.handleRequest("list", {}, "https://example.com"));
    assert.ok(wrong.every(byte => byte === 0));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("host configuration forbids unsafely mixed providers and upload grants", () => {
  const hostTarget = { connect: async () => ({ provider: { cdpUrl: "ws://127.0.0.1:1" }, close: async () => {} }) };
  assert.throws(() => new BetterWright({ hostTarget, provider: { cdpUrl: "ws://localhost:2" } }));
  assert.throws(() => new BetterWright({ hostTarget, hostUploadFiles: ["relative"] }));
  assert.throws(() => new BetterWright({ hostUploadFiles: ["/tmp/file"] }));
});

test("host keys accept typed-array views and zero only the supplied storage", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bw-host-key-view-"));
  const storage = new Uint8Array(40).fill(9);
  try {
    const vault = new LocalCredentialVault({ dir, keyProvider: async () => storage.subarray(4, 36) });
    await vault.handleRequest("save", { username: "test", password: "synthetic-only" }, "https://example.com");
    assert.ok(storage.subarray(4, 36).every(byte => byte === 0));
    assert.ok(storage.subarray(0, 4).every(byte => byte === 9));
    assert.ok(storage.subarray(36).every(byte => byte === 9));
    const invalid = new Uint8Array(31).fill(4);
    const bad = new LocalCredentialVault({ dir, keyProvider: async () => invalid });
    await assert.rejects(bad.handleRequest("list", {}, "https://example.com"), { code: "VAULT_KEY_INVALID" });
    assert.ok(invalid.every(byte => byte === 0));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("keyboard denies app navigation while allowing native copy and paste", () => {
  const policy = new BetterwrightKeyboardPolicy();
  policy.check({ type: "keyDown", key: "Meta", code: "MetaLeft", modifiers: 4 });
  assert.throws(() => policy.check({ type: "keyDown", key: "l", code: "KeyL" }));
  policy.check({ type: "keyUp", key: "Meta", code: "MetaLeft" });
  policy.check({ type: "keyDown", key: "l", code: "KeyL" });
  policy.check({ type: "keyDown", key: "c", modifiers: 4, commands: ["copy"] });
  policy.check({ type: "keyDown", key: "v", modifiers: 4, commands: ["paste"] });
  assert.throws(() => policy.check({ type: "keyDown", key: "x", commands: ["terminate:"] }));
  assert.deepEqual(betterwrightExpectedInputs("Input.dispatchMouseEvent", { type: "mouseMoved", x: 2, y: 4 }), []);
  assert.deepEqual(betterwrightExpectedInputs("Input.dispatchMouseEvent", { type: "mousePressed", x: 2, y: 4, button: "left" }), [{ kind: "mouse", type: "mouseDown", x: 2, y: 4, button: "left" }]);
});

test("aborting a run also settles other sessions in the stopped worker", async () => {
  const browser = new BetterWright({ vault: false });
  const child = {};
  browser._process = child;
  browser._send = () => {};
  browser.close = async options => {
    assert.notEqual(options.preservePending, true);
    browser._resolvePendingForWorkerExit(child);
  };
  const controller = new AbortController();
  const first = browser._dispatch({ type: "execute" }, 5, controller.signal);
  const second = browser._dispatch({ type: "execute" }, 5);
  controller.abort();
  const [aborted, stopped] = await Promise.all([first, second]);
  assert.equal(aborted.errorCode, "BW_ABORTED");
  assert.equal(aborted.effectMayHaveCommitted, true);
  assert.equal(stopped.ok, false);
  assert.equal(browser._pending.size, 0);
});
