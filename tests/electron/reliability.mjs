import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { app, BrowserWindow, clipboard } from "electron";
import { chromium } from "playwright-core";
import WebSocket from "ws";
import { configureElectronNetwork, createElectronHostTarget } from "../../dist/src/electron.js";
import { BetterWright, NetworkPolicy } from "../../dist/src/index.js";
import { installVaultCapture } from "../../dist/src/vault-capture.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "bw-electron-e2e-"));
app.setPath("userData", path.join(home, "electron"));
configureElectronNetwork();
async function main() {
console.log("E2E starting", app.isReady());
await app.whenReady();
console.log("E2E Electron ready");
const server = http.createServer((_req, res) => {
  res.setHeader("content-type", "text/html");
  res.end('<html><body style="background:#fff"><label>Name<input id="name"></label><button onclick="document.querySelector(\'output\').textContent=document.querySelector(\'input\').value">Save</button><output></output></body></html>');
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
const window = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: { partition: `bw-test-${process.pid}`, sandbox: true, nodeIntegration: false, contextIsolation: true } });
const contents = window.webContents;
await contents.loadURL("about:blank");
const staged = path.join(fs.realpathSync(home), "upload.txt");
fs.writeFileSync(staged, "synthetic upload", { mode: 0o600 });
const takeover = new AbortController();
const hostTarget = createElectronHostTarget({ contents, signal: takeover.signal, uploadFiles: [staged] });
const browser = new BetterWright({ home, hostTarget, hostUploadFiles: [staged], headless: false, adBlock: false, parkBackgroundPages: false, vault: false, policy: new NetworkPolicy({ allowLoopback: true }) });
console.log("E2E attaching");
try {
  async function run(code) {
    const result = await browser.run(code, { timeout: 12 });
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.result;
  }
  assert.deepEqual(await run(`await page.goto(${JSON.stringify(url)}); return [];`), []);
  contents.setZoomFactor(1.25);
  assert.equal(await run("await page.getByLabel('Name').fill('Ada'); await page.getByRole('button', {name:'Save'}).click(); return await page.locator('output').innerText();"), "Ada");
  console.log("PASS hidden target, zoom, batched native input, empty result");
  const denied = await browser.run("await page.keyboard.press('Meta+L');", { timeout: 5 });
  assert.equal(denied.ok, false);
  assert.equal(await run("await page.getByLabel('Name').fill('Grace'); await page.getByRole('button', {name:'Save'}).click(); return await page.locator('output').innerText();"), "Grace");
  assert.equal((await browser.run("await page.close();")).ok, false);
  assert.equal(contents.isDestroyed(), false);
  console.log("PASS denied shortcuts recover and host tab cannot be closed");
  const previousClipboard = clipboard.availableFormats().map(format => [format, clipboard.readBuffer(format)]);
  try {
    await run("await page.getByLabel('Name').click(); await page.keyboard.press('Meta+A'); await page.keyboard.press('Meta+C'); return true;");
    assert.equal(clipboard.readText(), "Grace");
    clipboard.writeText("Native paste");
    assert.equal(await run("await page.keyboard.press('Meta+V'); return await page.getByLabel('Name').inputValue();"), "Native paste");
  } finally {
    clipboard.clear();
    for (const [format, buffer] of previousClipboard) clipboard.writeBuffer(format, buffer);
  }
  console.log("PASS native system clipboard copy and paste");
  await contents.executeJavaScript("document.body.insertAdjacentHTML('beforeend', '<input type=file aria-label=Upload>')");
  assert.equal(await run(`await page.getByLabel('Upload').setInputFiles(${JSON.stringify(staged)}); return await page.getByLabel('Upload').evaluate(el => el.files[0].name);`), "upload.txt");
  assert.equal((await browser.run("await page.getByLabel('Upload').setInputFiles('/etc/hosts');")).ok, false);
  assert.equal((await browser.run("await page.getByLabel('Upload').setInputFiles({name:'hidden.txt',mimeType:'text/plain',buffer:new Uint8Array([1])});")).ok, false);
  console.log("PASS exact staged uploads; unapproved paths and payloads denied");
  browser.policy.custom = () => ({ allowed: false, reason: "test denial" });
  const blocked = await contents.executeJavaScript(`fetch(${JSON.stringify(url.replace("127.0.0.1", "localhost"))}).then(() => false, () => true)`);
  assert.equal(blocked, true);
  browser.policy.custom = null;
  console.log("PASS transport guard blocks native renderer requests outside sandbox");
  const image = await contents.capturePage();
  assert.equal(image.isEmpty(), false);
  assert.ok(image.toBitmap().some(byte => byte !== 0));
  const proofDir = path.resolve("artifacts/electron-e2e");
  fs.mkdirSync(proofDir, { recursive: true });
  fs.writeFileSync(path.join(proofDir, "native-browser.png"), image.toPNG());
  const operation = browser.run("await new Promise(() => {});", { timeout: 30 });
  setTimeout(() => takeover.abort(), 200);
  const aborted = await operation;
  assert.equal(aborted.errorCode, "BW_ABORTED", JSON.stringify(aborted));
  assert.equal(contents.isDestroyed(), false);
  await browser.close();
  assert.equal(contents.isDestroyed(), false);
  console.log("PASS cancellation drains and disconnect preserves host tab");
  const connection = await createElectronHostTarget({ contents }).connect({ proxyUrl: "socks5://127.0.0.1:1" });
  try {
    await new Promise((resolve, reject) => {
      const unauthorized = new WebSocket(connection.provider.cdpUrl);
      unauthorized.once("open", () => { unauthorized.close(); reject(new Error("Unauthenticated CDP connected")); });
      unauthorized.once("error", resolve);
    });
    const attached = await chromium.connectOverCDP(connection.provider.cdpUrl, { headers: connection.provider.headers, noDefaults: true });
    try {
      assert.equal(attached.contexts().length, 1);
      assert.equal(attached.contexts()[0].pages().length, 1);
      const page = attached.contexts()[0].pages()[0];
      await page.setContent('<form><label>Username<input autocomplete="username"></label><label>Password<input type="password" autocomplete="current-password"></label><button>Submit</button></form><script>document.querySelector("form").onsubmit=e=>{e.preventDefault();document.querySelector("form").remove()}</script>');
      let capture;
      let prompt;
      let save;
      const saved = new Promise(resolve => { save = resolve; });
      await new Promise(resolve => {
        capture = installVaultCapture(attached.contexts()[0], {
          onReady: resolve, sessionForPage: () => ({ id: "host" }),
          lastModelActivity: () => 0, isHeaded: () => true,
          matchMode: "exact-origin", trackSecret: () => {},
          requestSave: async metadata => { prompt = metadata; return "save"; },
          vaultCallAtOrigin: async (_session, _origin, action, payload) => {
            if (action === "save") { assert.equal(payload.matchMode, "exact-origin"); save(); }
            return { credentials: [] };
          },
        });
      });
      await page.getByLabel("Username").fill("test-user");
      await page.getByLabel("Password").fill("synthetic-test-password");
      await page.getByRole("button", { name: "Submit" }).click();
      let timer;
      await Promise.race([saved, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Capture did not save")), 5000); })]).finally(() => clearTimeout(timer));
      assert.deepEqual(Object.keys(prompt).sort(), ["mode", "origin", "page", "username"]);
      await capture.dispose();
      const cdp = await attached.contexts()[0].newCDPSession(page);
      const worlds = await cdp.send("Page.createIsolatedWorld", { frameId: (await cdp.send("Page.getFrameTree")).frameTree.frame.id, worldName: "betterwright-vault" });
      const removed = await cdp.send("Runtime.evaluate", { contextId: worlds.executionContextId, expression: "typeof globalThis.__bwVaultDispose === 'undefined'" });
      assert.equal(removed.result.value, true);
      await cdp.detach();
      console.log("PASS authenticated single-tab attachment, native save prompt, sensor cleanup");
    } finally { await attached.close(); }
  } finally { await connection.close(); }
} finally {
  await browser.close();
  window.destroy();
  server.close();
  fs.rmSync(home, { recursive: true, force: true });
  app.quit();
}
}
void main().catch(error => { console.error(error); app.exit(1); });
