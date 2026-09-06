import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { PlaywrightBlocker, Request } from "@ghostery/adblocker-playwright";
import { adBlockFromFlags, resolveAdBlock } from "../../dist/src/ad-block-config.js";
import { AD_BLOCK_CACHE_FILE, loadAdBlocker } from "../../dist/src/ad-blocker.js";
import { BetterWright } from "../../dist/src/client.js";
import { createBrowserFromDaemonConfig, daemonConfigSignature } from "../../dist/src/daemon.js";
import { makeTempDir } from "./helpers/temp-dir.js";

test("ad blocking defaults on and explicit toggles override the environment", async () => {
  assert.equal(resolveAdBlock(undefined, {}), true);
  assert.equal(resolveAdBlock(undefined, { BETTERWRIGHT_AD_BLOCK: "1" }), true);
  assert.equal(resolveAdBlock(false, { BETTERWRIGHT_AD_BLOCK: "1" }), false);
  assert.equal(adBlockFromFlags(new Set(["--ad-block"]), {}), true);
  assert.equal(adBlockFromFlags(new Set(["--no-ad-block"]), { BETTERWRIGHT_AD_BLOCK: "1" }), false);
  assert.throws(() => adBlockFromFlags(new Set(["--ad-block", "--no-ad-block"])), /either/);
  assert.throws(() => resolveAdBlock(undefined, { BETTERWRIGHT_AD_BLOCK: "typo" }), /must be/);
  const home = makeTempDir("bw-ad-client-");
  const browser = new BetterWright({ home, vault: false, adBlock: true });
  try {
    assert.equal(browser._workerConfig().adBlock, true);
    browser.adBlock = false;
    assert.equal(browser._workerConfig().adBlock, false);
  } finally {
    await browser.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("daemon signatures default to blocking and distinguish explicitly disabled blocking", async () => {
  assert.equal(daemonConfigSignature({}), daemonConfigSignature({ browser: { adBlock: true } }));
  assert.notEqual(daemonConfigSignature({}), daemonConfigSignature({ browser: { adBlock: false } }));
  const browser = await createBrowserFromDaemonConfig({});
  try { assert.equal(browser.adBlock, true); } finally { await browser.close(); }
});

const rule = "||ad.example^$script\n@@||ad.example/allowed.js$script";
function matches(blocker: PlaywrightBlocker, url = "https://ad.example/ad.js") {
  return blocker.match(Request.fromRawDetails({ url, sourceUrl: "https://site.example/", type: "script" })).match;
}

test("a fresh compiled filter cache works offline and retains exceptions", async () => {
  const dir = makeTempDir("bw-ad-cache-");
  fs.writeFileSync(path.join(dir, AD_BLOCK_CACHE_FILE), PlaywrightBlocker.parse(rule).serialize());
  let calls = 0;
  try {
    const blocker = await loadAdBlocker(dir, { fetchImpl: async () => { calls++; throw new Error("offline"); } });
    assert.equal(calls, 0);
    assert.equal(matches(blocker), true);
    assert.equal(matches(blocker, "https://ad.example/allowed.js"), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a failed refresh retains stale rules but a failed first use reports an error", async () => {
  const dir = makeTempDir("bw-ad-stale-");
  const file = path.join(dir, AD_BLOCK_CACHE_FILE);
  fs.writeFileSync(file, PlaywrightBlocker.parse(rule).serialize());
  fs.utimesSync(file, new Date(0), new Date(0));
  const warnings: string[] = [];
  const options = { fetchImpl: async () => new Response("unavailable", { status: 503 }), warn: (s: string) => warnings.push(s) };
  try {
    assert.equal(matches(await loadAdBlocker(dir, options)), true);
    assert.match(warnings[0], /last cached lists/);
    fs.writeFileSync(file, "corrupt cache");
    await assert.rejects(loadAdBlocker(dir, options), /could not load its filter lists/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a corrupt cache is rebuilt atomically from valid filter responses", async () => {
  const dir = makeTempDir("bw-ad-refresh-");
  const file = path.join(dir, AD_BLOCK_CACHE_FILE);
  fs.writeFileSync(file, "invalid");
  try {
    const blocker = await loadAdBlocker(dir, {
      fetchImpl: async (url) => new Response(String(url).endsWith("resources.json")
        ? JSON.stringify({ resources: [], scriptlets: [] }) : rule),
    });
    assert.equal(matches(blocker), true);
    assert.equal(matches(PlaywrightBlocker.deserialize(fs.readFileSync(file))), true);
    assert.deepEqual(fs.readdirSync(dir), [AD_BLOCK_CACHE_FILE]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
