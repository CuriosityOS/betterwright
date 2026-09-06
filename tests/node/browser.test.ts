// End-to-end Node tests. Skipped unless doctor reports a ready managed browser,
// so the policy suite still runs on machines without BetterChromium installed.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { test } from "node:test";
import zlib from "node:zlib";

import { doctorReport } from "../../dist/src/doctor.js";
import { BetterWright, NetworkPolicy, runAgentTask } from "../../dist/src/index.js";
import { _createMcpHandlersForTest } from "../../dist/src/mcp-server.js";
import { isBoolean, isCallable, isString } from "../../dist/src/untrusted-value.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const browserStatus = await doctorReport();
const ready = browserStatus.ready;
// On a laptop without a ready browser, skipping is friendly. In CI it would mean
// the entire integration suite silently reports green without running, so the
// workflows set BETTERWRIGHT_REQUIRE_BROWSER=1 to turn that into a failure.
if (!ready && process.env.BETTERWRIGHT_REQUIRE_BROWSER) {
  throw new Error(
    `BETTERWRIGHT_REQUIRE_BROWSER is set but no browser runtime is ready (doctor browser: ${browserStatus.browser}) — ` +
      "the browser integration suite would silently skip. Run `betterwright setup`.",
  );
}
const opts = {
  skip: ready ? false : `browser runtime not ready (doctor browser: ${browserStatus.browser})`,
};
const encoder = process.env.BETTERWRIGHT_FFMPEG_PATH || "ffmpeg";
const encoderProbe = spawnSync(encoder, ["-encoders"], { encoding: "utf8", timeout: 5_000 });
const recordingReady = ready && encoderProbe.status === 0 && /\blibvpx\b/.test(encoderProbe.stdout) && /\blibx264\b/.test(encoderProbe.stdout);
if (!recordingReady && process.env.BETTERWRIGHT_REQUIRE_RECORDING) {
  throw new Error("Recording tests require the managed browser and FFmpeg with libvpx and libx264.");
}
const recordingOpts = { skip: recordingReady ? false : "recording runtime is unavailable" };
function tempHome() {
  return makeTempDir("betterwright-test-");
}

function firstPngPixel(filePath: string) {
  const png = fs.readFileSync(filePath);
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat: Buffer[] = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString("ascii");
    const data = png.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
  }
  assert.equal(bitDepth, 8);
  assert.ok(colorType === 2 || colorType === 6, `unsupported PNG color type ${colorType}`);
  assert.ok(width > 0 && height > 0);
  const channels = colorType === 6 ? 4 : 3;
  const inflated = zlib.inflateSync(Buffer.concat(idat));
  const first = inflated.subarray(1, 1 + channels);
  return [first[0], first[1], first[2], colorType === 6 ? first[3] : 255];
}

function assertRgbaClose(actual: number[], expected: number[], tolerance = 2) {
  assert.equal(actual.length, expected.length);
  for (const [index, value] of actual.entries()) {
    assert.ok(
      Math.abs(value - expected[index]) <= tolerance,
      `channel ${index}: expected ${expected[index]}, got ${value} from [${actual.join(", ")}]`,
    );
  }
}

// Chromium's site isolation keys on scheme + eTLD+1 and ignores the port, so a
// caller that needs a genuinely cross-site frame has to pass a distinct
// loopback host, not just a distinct port.
async function listen(handler, host = "127.0.0.1") {
  const server = http.createServer(handler);
  server.listen(0, host);
  await once(server, "listening");
  // SAFETY: the server finished `listen` on a TCP port, so `address()` returns
  // an AddressInfo — not the null of an unbound server or a pipe-name string.
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://${host}:${port}`,
    port,
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function scriptedAgentModel(turns) {
  let index = 0;
  const seen = [];
  return {
    seen,
    async complete(request) {
      seen.push(request);
      const scripted = turns[index++];
      const turn = isCallable(scripted) ? await scripted(request) : scripted;
      assert.ok(turn, `unexpected agent turn ${index}`);
      return { text: "", usage: null, ...turn };
    },
  };
}

class LimitedBetterWright extends BetterWright {
  limits: any;
  // Declared, not defined: they are inherited from the untyped built runtime.
  declare run: (code: string, options?: any) => Promise<any>;
  declare close: () => Promise<void>;

  constructor(options, limits) {
    super(options);
    this.limits = limits;
  }

  _workerConfig() {
    return { ...super._workerConfig(), ...this.limits };
  }
}

function directorySize(root) {
  if (!fs.existsSync(root)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) total += directorySize(target);
    else total += fs.statSync(target).size;
  }
  return total;
}

function largestFileSize(root) {
  if (!fs.existsSync(root)) return 0;
  let largest = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    largest = Math.max(
      largest,
      entry.isDirectory() ? largestFileSize(target) : fs.statSync(target).size,
    );
  }
  return largest;
}

test("navigate and read the title", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), policy: new NetworkPolicy(), headless: true });
  try {
    const result = await bw.run("await page.goto('https://example.com'); return page.title()");
    assert.equal(result.ok, true, result.error);
    assert.equal(result.result, "Example Domain");
  } finally {
    await bw.close();
  }
});

test("stock software-rasterizer boilerplate warns without blocking launch", opts, async () => {
  const bw = new BetterWright({
    home: tempHome(),
    headless: true,
    chromiumArgs: ["--disable-software-rasterizer"],
  });
  try {
    const result = await bw.run("return 42");
    assert.equal(result.ok, true, result.error);
    assert.equal(result.result, 42);
    assert.ok(
      result.warnings.some((warning) =>
        /Ignored Chromium switch --disable-software-rasterizer/.test(warning),
      ),
      JSON.stringify(result.warnings),
    );
  } finally {
    await bw.close();
  }
});

test("the selected managed browser keeps WebGL rendering available with a coherent identity", opts, async () => {
  const site = await listen((request, response) => {
    if (request.url !== "/") { response.writeHead(404).end(); return; }
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html>
      <style>body{margin:0;background:rgb(18,52,86)}</style>
      <canvas id="two" width="2" height="2"></canvas>
      <canvas id="one" width="2" height="2"></canvas>
      <canvas id="webgl2" width="2" height="2"></canvas>`);
  });
  const bw = new BetterWright({ home: tempHome(), policy: new NetworkPolicy(), headless: true });
  try {
    const result = await bw.run(`
      await page.goto(${JSON.stringify(site.origin)});
      const rendering = await page.evaluate(async () => {
        function compileShader(gl, type, source) {
          const shader = gl.createShader(type);
          if (!shader) throw new Error('createShader returned null');
          gl.shaderSource(shader, source);
          gl.compileShader(shader);
          if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            throw new Error(gl.getShaderInfoLog(shader) || 'shader compile failed');
          }
          return shader;
        }
        function drawWebgl(id, kind) {
          const canvas = document.getElementById(id);
          const gl = canvas.getContext(kind, { preserveDrawingBuffer: true });
          if (!gl) return { available: false, kind, userAgent: navigator.userAgent, platform: navigator.platform };
          const secondVersion = kind === 'webgl2';
          const vertexSource = secondVersion
            ? '#version 300 es\\nin vec2 position; void main(){ gl_Position = vec4(position, 0.0, 1.0); }'
            : 'attribute vec2 position; void main(){ gl_Position = vec4(position, 0.0, 1.0); }';
          const fragmentSource = secondVersion
            ? '#version 300 es\\nprecision mediump float; out vec4 color; void main(){ color = vec4(0.8, 0.3, 0.1, 1.0); }'
            : 'precision mediump float; void main(){ gl_FragColor = vec4(0.2, 0.4, 0.6, 1.0); }';
          const program = gl.createProgram();
          if (!program) throw new Error('createProgram returned null');
          gl.attachShader(program, compileShader(gl, gl.VERTEX_SHADER, vertexSource));
          gl.attachShader(program, compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource));
          gl.linkProgram(program);
          if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            throw new Error(gl.getProgramInfoLog(program) || 'program link failed');
          }
          gl.useProgram(program);
          const buffer = gl.createBuffer();
          gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
          gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
          const location = gl.getAttribLocation(program, 'position');
          gl.enableVertexAttribArray(location);
          gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
          gl.viewport(0, 0, 2, 2);
          gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
          const pixels = new Uint8Array(4);
          gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
          const debug = gl.getExtension('WEBGL_debug_renderer_info');
          return {
            available: true,
            kind,
            vendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : null,
            renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null,
            extensions: gl.getSupportedExtensions()?.length || 0,
            pixels: [...pixels],
            userAgent: navigator.userAgent,
            platform: navigator.platform,
          };
        }
        const two = document.getElementById('two').getContext('2d');
        two.fillStyle = 'rgb(51,102,153)';
        two.fillRect(0, 0, 2, 2);
        async function measureWebglFrames() {
          const canvas = document.getElementById('one');
          const gl = canvas.getContext('webgl');
          if (!gl) return { available: false };
          let frames = 0;
          const start = performance.now();
          await new Promise((resolve) => {
            const draw = (now) => {
              frames += 1;
              gl.clearColor(frames % 2 ? 0.1 : 0.4, 0.2, 0.3, 1);
              gl.clear(gl.COLOR_BUFFER_BIT);
              if (now - start >= 500) resolve();
              else requestAnimationFrame(draw);
            };
            requestAnimationFrame(draw);
          });
          return { available: true, frames, elapsedMs: performance.now() - start };
        }
        const webgpu = { secureContext: isSecureContext, hasGpu: 'gpu' in navigator };
        if (webgpu.hasGpu) {
          try {
            webgpu.adapter = Boolean(await navigator.gpu.requestAdapter());
          } catch (error) {
            webgpu.error = error instanceof Error ? error.message : String(error);
          }
        }
        return {
          canvas2d: [...two.getImageData(0, 0, 1, 1).data],
          webgl: drawWebgl('one', 'webgl'),
          webgl2: drawWebgl('webgl2', 'webgl2'),
          webglFrames: await measureWebglFrames(),
          webgpu,
        };
      });
      const artifact = await screenshot({kind: 'debug', name: 'rendering-css.png'});
      return { ...rendering, artifact };
    `);
    assert.equal(result.ok, true, result.error);
    assertRgbaClose(result.result.canvas2d, [51, 102, 153, 255]);
    assert.equal(result.result.webgl.available, true, JSON.stringify(result.result.webgl));
    assert.equal(result.result.webgl2.available, true, JSON.stringify(result.result.webgl2));
    assertRgbaClose(result.result.webgl.pixels, [51, 102, 153, 255]);
    assertRgbaClose(result.result.webgl2.pixels, [204, 77, 26, 255]);
    for (const gl of [result.result.webgl, result.result.webgl2]) {
      assert.ok(isString(gl.vendor));
      assert.ok(gl.vendor.length > 0);
      assert.ok(isString(gl.renderer));
      assert.ok(gl.renderer.length > 0);
      assert.ok(gl.extensions > 0);
    }
    assert.equal(result.result.webglFrames.available, true, JSON.stringify(result.result.webglFrames));
    assert.ok(result.result.webglFrames.frames >= 10, JSON.stringify(result.result.webglFrames));
    assert.ok(result.result.webglFrames.elapsedMs >= 450, JSON.stringify(result.result.webglFrames));
    assert.equal(result.result.webgpu.secureContext, true, JSON.stringify(result.result.webgpu));
    assert.equal(isBoolean(result.result.webgpu.hasGpu), true, JSON.stringify(result.result.webgpu));
    if (result.result.webgpu.hasGpu) {
      assert.equal(isBoolean(result.result.webgpu.adapter), true, JSON.stringify(result.result.webgpu));
    }
    assertRgbaClose(firstPngPixel(result.result.artifact.path), [18, 52, 86, 255], 3);
    if (browserStatus.browser === "chromium-fork" && process.platform === "linux") {
      assert.equal(result.result.webgl.platform, "Linux x86_64", JSON.stringify(result.result.webgl));
      assert.match(result.result.webgl.userAgent, /Linux/, result.result.webgl.userAgent);
      assert.doesNotMatch(result.result.webgl.userAgent, /Macintosh/, result.result.webgl.userAgent);
      assert.doesNotMatch(result.result.webgl.renderer, /SwiftShader|llvmpipe|softpipe/i, result.result.webgl.renderer);
      assert.doesNotMatch(result.result.webgl2.renderer, /SwiftShader|llvmpipe|softpipe/i, result.result.webgl2.renderer);
      assert.match(result.result.webgl.renderer, /ANGLE/, result.result.webgl.renderer);
      assert.match(result.result.webgl2.renderer, /ANGLE/, result.result.webgl2.renderer);
    } else if (/Macintosh/.test(result.result.webgl.userAgent)) {
      assert.equal(result.result.webgl.platform, "MacIntel");
    } else if (/Windows/.test(result.result.webgl.userAgent)) {
      assert.equal(result.result.webgl.platform, "Win32");
    } else {
      assert.match(result.result.webgl.userAgent, /Linux/);
      assert.match(result.result.webgl.platform, /Linux/);
    }
  } finally {
    await bw.close();
    await site.close();
  }
});

test("managed sessions preserve native service-worker behavior", opts, async () => {
  const site = await listen((request, response) => {
    if (request.url === "/sw.js") {
      response.writeHead(200, {
        "content-type": "application/javascript",
        "service-worker-allowed": "/",
      });
      response.end("self.addEventListener('fetch', () => {});");
      return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><title>Service worker fixture</title>");
  });
  const bw = new BetterWright({
    home: tempHome(),
    policy: new NetworkPolicy(),
    headless: true,
  });
  try {
    const result = await bw.run(`
      await page.goto(${JSON.stringify(site.origin)});
      return page.evaluate(async () => {
        const registration = await navigator.serviceWorker.register('/sw.js');
        await navigator.serviceWorker.ready;
        return {
          scope: registration.scope,
          active: Boolean(registration.active),
        };
      });
    `);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.result.active, true);
    assert.equal(result.result.scope, `${site.origin}/`);
  } finally {
    await bw.close();
    await site.close();
  }
});

test("page summaries identify the active tab", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const opened = await bw.run(`
      await page.setContent('<title>First</title><h1>First</h1>');
      const second = await openPage();
      await second.setContent('<title>Second</title><h1>Second</h1>');
      return pages.map(item => ({ pageId: item }));
    `);
    assert.equal(opened.ok, true, opened.error);
    assert.equal(opened.pages.length, 2);
    assert.equal(opened.pages.filter((page) => page.active).length, 1);
    assert.equal(opened.pages.find((page) => page.active).title, "Second");

    const firstId = opened.pages.find((page) => page.title === "First").pageId;
    const selected = await bw.run(`
      await usePage(${JSON.stringify(firstId)});
      return page.title();
    `);
    assert.equal(selected.ok, true, selected.error);
    assert.equal(selected.pages.filter((page) => page.active).length, 1);
    assert.equal(selected.pages.find((page) => page.active).title, "First");
  } finally {
    await bw.close();
  }
});

test("page summaries reflect changed and empty titles without snippet listeners", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true, vault: false });
  try {
    for (const title of ["First title", "Changed title", ""]) {
      const result = await bw.run(`
        await page.setContent(${JSON.stringify(`<title>${title}</title><h1>Content</h1>`)});
        return page;
      `);
      assert.equal(result.ok, true, result.error);
      assert.equal(result.result.title, title);
      assert.equal(result.pages[0].title, title);
      assert.equal(result.pages[0].active, true);
    }
    const result = await bw.run(`
      const second = await openPage();
      await second.setContent('<title>Closed tab</title>');
      await closePage();
      return page;
    `);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.pages.length, 1);
    assert.equal(result.pages[0].title, "");
  } finally {
    await bw.close();
  }
});

test("recording preserves page state and animation between browser calls", recordingOpts, async () => {
  let reportProgress: () => void;
  const progress = new Promise<void>(resolve => { reportProgress = resolve; });
  const site = await listen((request, response) => {
    if (request.url === "/progress") {
      response.end("ok");
      reportProgress();
      return;
    }
    if (request.url !== "/") { response.writeHead(404).end(); return; }
    response.end('<title>Recording fixture</title><input id="draft"><canvas width="640" height="360"></canvas>');
  });
  const bw = new BetterWright({ home: tempHome(), headless: true, vault: false, parkBackgroundPages: true });
  try {
    const started = await bw.run(`
      await page.goto(${JSON.stringify(site.origin)});
      await page.locator('#draft').fill('unsent draft');
      await page.evaluate(() => {
        sessionStorage.setItem('draft', 'preserved');
        document.cookie = 'recording=preserved; SameSite=Lax';
        window.frameNumber = 0;
        const canvas = document.querySelector('canvas');
        const context = canvas.getContext('2d');
        context.fillStyle = '#164e63';
        context.fillRect(0, 0, 640, 360);
        const draw = () => {
          window.frameNumber += 1;
          context.fillStyle = '#164e63';
          context.fillRect(0, 0, 640, 360);
          context.fillStyle = '#facc15';
          context.fillRect(window.frameNumber % 580, 100, 60, 60);
          if (window.frameNumber === window.reportAtFrame) void fetch('/progress');
          requestAnimationFrame(draw);
        };
        requestAnimationFrame(draw);
      });
      state.recordingDraft = 'preserved';
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const recordingState = await recording.start({ maxWidth: 640, maxHeight: 360 });
      const frames = await page.evaluate(() => {
        setTimeout(() => { window.reportAtFrame = window.frameNumber + 50; }, 1_500);
        return window.frameNumber;
      });
      return { recordingState, frames };
    `);
    assert.equal(started.ok, true, started.error);
    assert.equal(started.result.recordingState.state, "recording");
    assert.equal(started.result.recordingState.fps, 60);
    assert.match(started.result.recordingState.path, /\.mp4$/);
    assert.equal((started.artifacts || []).filter((artifact) => artifact.kind === "recording").length, 0);
    let progressTimer: ReturnType<typeof setTimeout>;
    await Promise.race([
      progress,
      new Promise<never>((_, reject) => {
        progressTimer = setTimeout(() => reject(new Error("Recorded page stopped animating between calls.")), 10_000);
      }),
    ]).finally(() => clearTimeout(progressTimer));
    const stopped = await bw.run(`
      const saved = await recording.stop();
      const repeated = await recording.stop();
      return {
        saved, repeated, draft: await page.locator('#draft').inputValue(), state: state.recordingDraft,
        pageState: await page.evaluate(() => ({ frames: window.frameNumber, storage: sessionStorage.getItem('draft'), cookie: document.cookie })),
        prototype: Object.getPrototypeOf(await recording.status()),
      };
    `);
    assert.equal(stopped.ok, true, stopped.error);
    assert.equal(stopped.result.saved.state, "completed", JSON.stringify(stopped.result.saved));
    assert.deepEqual(stopped.result.repeated, stopped.result.saved);
    assert.equal(stopped.result.prototype, null);
    assert.equal(stopped.result.draft, "unsent draft");
    assert.equal(stopped.result.state, "preserved");
    assert.equal(stopped.result.pageState.storage, "preserved");
    assert.match(stopped.result.pageState.cookie, /recording=preserved/);
    assert.ok(stopped.result.pageState.frames - started.result.frames >= 50, "recorded page stays awake between calls");
    assert.ok(stopped.result.saved.outputFrames > 1);
    assert.ok(stopped.result.saved.capturedFrames > 1);
    assert.ok(Math.abs(stopped.result.saved.outputFrames / 60 * 1000 - stopped.result.saved.durationMs) <= 20);
    assert.ok(stopped.result.saved.bytes > 0);
    assert.equal(fs.statSync(stopped.result.saved.path).size, stopped.result.saved.bytes);
    assert.ok(stopped.artifacts.some((artifact) => artifact.kind === "recording" && artifact.path === stopped.result.saved.path && artifact.mimeType === "video/mp4"));
    const decoded = spawnSync(encoder, ["-v", "error", "-i", stopped.result.saved.path, "-f", "framemd5", "-"], { encoding: "utf8", timeout: 10_000 });
    assert.equal(decoded.status, 0, decoded.stderr);
    const frameHashes = decoded.stdout.split("\n")
      .filter((line) => /^\d+,/.test(line))
      .map((line) => line.split(",").at(-1).trim());
    assert.ok(frameHashes.length > 1, "the saved recording contains multiple decoded frames");
    assert.ok(new Set(frameHashes).size > 1, "the saved recording preserves visible animation");
  } finally {
    await bw.close();
    await site.close();
  }
});

test("recordings are session-scoped and finalize on restart and session close", recordingOpts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true, vault: false });
  try {
    const started = await bw.run("await page.setContent('<h1>First recording</h1>'); return recording.start({name:'first.mp4'});", { session: "recorded" });
    assert.equal(started.ok, true, started.error);
    const other = await bw.run("return recording.status()", { session: "other" });
    assert.deepEqual(other.result, { state: "idle" });
    const duplicate = await bw.run("return recording.start()", { session: "recorded" });
    assert.equal(duplicate.ok, false);
    assert.match(duplicate.error, /already active/);
    const restarted = await bw.run("return recording.restart({name:'second.webm'})", { session: "recorded" });
    assert.equal(restarted.ok, true, restarted.error);
    assert.equal(restarted.result.state, "recording");
    assert.notEqual(restarted.result.path, started.result.path);
    assert.ok(restarted.artifacts.some((artifact) => artifact.path === started.result.path && artifact.mimeType === "video/mp4"));
    assert.equal((await bw.closeSession("recorded")).ok, true);
    for (const file of [started.result.path, restarted.result.path]) {
      assert.ok(fs.statSync(file).size > 0);
      const decoded = spawnSync(encoder, ["-v", "error", "-i", file, "-f", "null", "-"], { encoding: "utf8", timeout: 10_000 });
      assert.equal(decoded.status, 0, decoded.stderr);
    }
    const remaining = await bw.run("return page.title()", { session: "other" });
    assert.equal(remaining.ok, true, remaining.error);
  } finally {
    await bw.close();
  }
});

test("recording stop waits for a concurrently starting recording", recordingOpts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true, vault: false });
  try {
    const result = await bw.run(`
      await page.setContent('<h1>Concurrent recording</h1>');
      const [started, stopped] = await Promise.all([
        recording.start({name:'concurrent.webm', maxWidth:320, maxHeight:180}),
        recording.stop(),
      ]);
      return { started, stopped, status: await recording.status() };
    `);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.result.stopped.state, "completed", JSON.stringify(result.result));
    assert.equal(result.result.stopped.path, result.result.started.path);
    assert.deepEqual(result.result.status, result.result.stopped);
    assert.ok(result.result.stopped.outputFrames > 0);
    assert.equal(fs.statSync(result.result.stopped.path).size, result.result.stopped.bytes);
    assert.equal(result.artifacts.filter((artifact) => artifact.kind === "recording").length, 1);
    const decoded = spawnSync(encoder, ["-v", "error", "-i", result.result.stopped.path, "-f", "null", "-"], { encoding: "utf8", timeout: 10_000 });
    assert.equal(decoded.status, 0, decoded.stderr);
  } finally {
    await bw.close();
  }
});

test("parallel recording starts create only one active recording", recordingOpts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true, vault: false });
  try {
    const result = await bw.run(`
      await page.setContent('<h1>One recorder</h1>');
      const attempts = await Promise.allSettled([
        recording.start({name:'first.webm', maxWidth:320, maxHeight:180}),
        recording.start({name:'second.webm', maxWidth:320, maxHeight:180}),
      ]);
      return {
        attempts: attempts.map(attempt => attempt.status === 'fulfilled'
          ? {state: 'started', path: attempt.value.path}
          : {state: 'rejected', error: attempt.reason.message}),
        stopped: await recording.stop(),
        status: await recording.status(),
      };
    `);
    assert.equal(result.ok, true, result.error);
    const started = result.result.attempts.filter((attempt) => attempt.state === "started");
    const rejected = result.result.attempts.filter((attempt) => attempt.state === "rejected");
    assert.equal(started.length, 1);
    assert.equal(rejected.length, 1);
    assert.match(rejected[0].error, /already active/);
    assert.equal(result.result.stopped.state, "completed");
    assert.equal(result.result.stopped.path, started[0].path);
    assert.deepEqual(result.result.status, result.result.stopped);
    assert.equal(result.artifacts.filter((artifact) => artifact.kind === "recording").length, 1);
    assert.ok(fs.statSync(started[0].path).size > 0);
  } finally {
    await bw.close();
  }
});

test("page.close and closePage finalize recordings before closing the target", recordingOpts, async () => {
  for (const close of ["await page.close()", "await closePage()"]) {
    const bw = new BetterWright({ home: tempHome(), headless: true, vault: false });
    try {
      const result = await bw.run(`
        await page.setContent('<h1>Save before closing</h1>');
        const target = page;
        const started = await recording.start({name:'close.webm', maxWidth:320, maxHeight:180});
        ${close};
        return { path: started.path, closed: target.isClosed(), status: await recording.status() };
      `);
      assert.equal(result.ok, true, `${close}: ${result.error}`);
      assert.equal(result.result.closed, true, close);
      assert.equal(result.result.status.state, "completed", `${close}: ${JSON.stringify(result.result.status)}`);
      assert.equal(result.result.status.path, result.result.path);
      assert.ok(result.result.status.bytes > 0);
      assert.equal(fs.statSync(result.result.path).size, result.result.status.bytes);
      assert.equal(result.artifacts.filter((artifact) => artifact.kind === "recording").length, 1);
      const decoded = spawnSync(encoder, ["-v", "error", "-i", result.result.path, "-f", "null", "-"], { encoding: "utf8", timeout: 10_000 });
      assert.equal(decoded.status, 0, `${close}: ${decoded.stderr}`);
    } finally {
      await bw.close();
    }
  }
});

test("invalid recording starts leave the session ready for a valid retry", recordingOpts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true, vault: false });
  try {
    const invalid = [null, [], { fps: 0 }, { maxWidth: 3.5 }, { maxDurationMs: 0 },
      { name: "../escape.webm" }, { name: "folder\\escape.webm" }];
    const result = await bw.run(`
      await page.setContent('<h1>Retry recording</h1>');
      const attempts = [];
      for (const options of ${JSON.stringify(invalid)}) {
        try {
          await recording.start(options);
          attempts.push({accepted: true});
        } catch (error) {
          attempts.push({error: error.message, status: await recording.status()});
        }
      }
      await recording.start({name:'retry.webm', maxWidth:320, maxHeight:180});
      return { attempts, stopped: await recording.stop() };
    `);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.result.attempts.length, invalid.length);
    for (const attempt of result.result.attempts) {
      assert.ok(attempt.error, JSON.stringify(attempt));
      assert.deepEqual(attempt.status, { state: "idle" });
    }
    assert.equal(result.result.stopped.state, "completed");
    assert.ok(result.result.stopped.bytes > 0);
    assert.equal(result.artifacts.filter((artifact) => artifact.kind === "recording").length, 1);
  } finally {
    await bw.close();
  }
});

test("role names and page handles reject objects at the call boundary", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const regexName = await bw.run(`
      await page.setContent('<input aria-label="Email">');
      return page.getByRole('textbox', {name: /email/i}).count();
    `);
    assert.equal(regexName.ok, true, regexName.error);
    assert.equal(regexName.result, 1);

    const roleName = await bw.run(`
      await page.getByRole('textbox', {name: {text: 'Email'}}).click();
    `);
    assert.equal(roleName.ok, false);
    assert.equal(
      roleName.error,
      "getByRole name must be a string or RegExp, received object.",
    );
    assert.doesNotMatch(roleName.error, /\[object Object\]|InvalidSelector|timed out/i);

    const pageHandle = await bw.run("await usePage(pages[0]);");
    assert.equal(pageHandle.ok, false);
    assert.equal(
      pageHandle.error,
      "usePage page handle must be a page ID string or numeric index, received object.",
    );
    assert.doesNotMatch(pageHandle.error, /\[object Object\]|Unknown page/i);

    const closeHandle = await bw.run("await closePage({pageId: 'page-1'});");
    assert.equal(closeHandle.ok, false);
    assert.equal(
      closeHandle.error,
      "closePage page handle must be a page ID string or numeric index, received object.",
    );
  } finally {
    await bw.close();
  }
});

test("public search UIs route agents to the host search tool", opts, async () => {
  // Public search is allowed by default now, so opt into the block routing.
  const bw = new BetterWright({
    home: tempHome(),
    headless: true,
    publicSearchPolicy: "block",
  });
  try {
    const direct = await bw.run(
      "await page.goto('https://www.google.com/search?q=betterwright'); return 'loaded'",
    );
    assert.equal(direct.ok, false);
    assert.match(direct.error, /host web-search\/research tool/i);

    const clicked = await bw.run(`
      await page.setContent(
        '<a id="search" href="https://www.bing.com/search?q=betterwright">Search</a>'
      );
      await page.locator('#search').click();
      return page.url();
    `);
    assert.equal(clicked.ok, false);
    assert.ok(
      clicked.events?.some((event) => event.type === "public-search-blocked"),
      JSON.stringify(clicked.events),
    );

    for (const url of [
      "https://www.bing.com/images/search?q=betterwright",
      "https://www.bing.com/videos/search?q=betterwright",
      "https://www.bing.com/news/search?q=betterwright",
      "https://lite.duckduckgo.com/lite/?q=betterwright",
    ]) {
      const variant = await bw.run(
        `await page.goto(${JSON.stringify(url)}); return 'loaded'`,
      );
      assert.equal(variant.ok, false, url);
      assert.match(variant.error, /host web-search\/research tool/i, url);
    }
  } finally {
    await bw.close();
  }
});

test("metadata endpoint is blocked", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const result = await bw.run("await page.goto('http://169.254.169.254/'); return 'reached'");
    assert.equal(result.ok, false);
  } finally {
    await bw.close();
  }
});

test("IPv4-mapped IPv6 cannot reach an IPv4 loopback service", opts, async () => {
  let hits = 0;
  const server = await listen((_request, response) => {
    hits += 1;
    response.end("loopback reached");
  });
  // Loopback is open by default; this guards the mapped-IPv6 spelling against
  // bypassing a policy that explicitly blocks it.
  const bw = new BetterWright({
    home: tempHome(),
    policy: new NetworkPolicy({ allowLoopback: false, allowPrivateNetwork: false }),
    headless: true,
  });
  try {
    const result = await bw.run(
      `await page.goto('http://[::ffff:127.0.0.1]:${server.port}/'); return 'reached'`,
    );
    assert.equal(result.ok, false);
    assert.equal(hits, 0);
  } finally {
    await bw.close();
    await server.close();
  }
});

test("setInputFiles only reads files from the artifact root", opts, async () => {
  const home = tempHome();
  const outside = path.join(home, "host-secret.txt");
  const outsideScript = path.join(home, "host-secret.js");
  const allowed = path.join(home, "artifacts", "upload.txt");
  const linkedOutside = path.join(home, "artifacts", "linked-secret.txt");
  fs.mkdirSync(path.dirname(allowed), { recursive: true });
  fs.writeFileSync(outside, "host-secret-value");
  fs.writeFileSync(outsideScript, "globalThis.hostSecret = 'read';");
  fs.writeFileSync(allowed, "allowed-artifact-value");
  if (process.platform !== "win32") fs.symlinkSync(outside, linkedOutside);
  const bw = new BetterWright({ home, headless: true });
  try {
    const denied = await bw.run(`
      await page.setContent('<input type="file">');
      await page.locator('input').setInputFiles(${JSON.stringify(outside)});
      return page.locator('input').evaluate(element => element.files[0].text());
    `);
    assert.equal(denied.ok, false);
    assert.match(denied.error || "", /artifact directory/i);

    const accepted = await bw.run(`
      await page.setContent('<input type="file">');
      await page.locator('input').setInputFiles(${JSON.stringify(allowed)});
      return page.locator('input').evaluate(element => element.files[0].text());
    `);
    assert.equal(accepted.ok, true, accepted.error);
    assert.equal(accepted.result, "allowed-artifact-value");

    const chooserDenied = await bw.run(`
      await page.setContent('<input type="file">');
      const chooserPromise = page.waitForEvent('filechooser');
      await page.locator('input').click();
      const chooser = await chooserPromise;
      await chooser.setFiles(${JSON.stringify(outside)});
      return 'read';
    `);
    assert.equal(chooserDenied.ok, false);
    assert.match(chooserDenied.error || "", /artifact directory/i);

    const initScriptDenied = await bw.run(`
      await page.addInitScript({path: ${JSON.stringify(outsideScript)}});
      return 'read';
    `);
    assert.equal(initScriptDenied.ok, false);
    assert.match(initScriptDenied.error || "", /artifact directory/i);

    if (process.platform !== "win32") {
      const symlinkDenied = await bw.run(`
        await page.setContent('<input type="file">');
        await page.locator('input').setInputFiles(${JSON.stringify(linkedOutside)});
        return 'read';
      `);
      assert.equal(symlinkDenied.ok, false);
      assert.match(symlinkDenied.error || "", /artifact directory/i);
    }
  } finally {
    await bw.close();
  }
});

test("model-authored credentials.fill types the secret without returning it", opts, async () => {
  const secret = "vault-secret-value";
  const server = await listen((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end('<input id="u"><input id="p" type="password">');
  });
  const vault = {
    async handleRequest(action, _payload, origin) {
      assert.equal(action, "fill");
      return { secret, origin, username: "alice", id: "rec-1" };
    },
  };
  const bw = new BetterWright({
    home: tempHome(),
    headless: true,
    policy: new NetworkPolicy({ allowLoopback: true }),
    vault,
  });
  try {
    // Fill directly from run(), origin-scoped, and get metadata back — never
    // the secret.
    const result = await bw.run(`
      await page.goto(${JSON.stringify(server.origin)});
      const outcome = await credentials.fill({
        username: 'alice',
        usernameSelector: '#u',
        passwordSelector: '#p',
      });
      const typed = await page.locator('#p').evaluate(element => element.value.length);
      return { outcome, typed };
    `);
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(result.result.outcome.filled, ["username", "password"]);
    assert.equal(result.result.outcome.submitted, false);
    assert.equal(result.result.outcome.username, "alice");
    assert.equal(result.result.outcome.secret, undefined);
    // The field really was typed with the full secret.
    assert.equal(result.result.typed, secret.length);
    // The secret never appears anywhere in the envelope in plain text — the
    // redaction net scrubs even a snippet that reads the DOM value back.
    assert.ok(!JSON.stringify(result).includes(secret));

    const readBack = await bw.run(
      "return page.locator('#p').evaluate(element => element.value);",
    );
    assert.equal(readBack.ok, true);
    assert.ok(!JSON.stringify(readBack).includes(secret), "plain read-back is redacted");
  } finally {
    await bw.close();
    await server.close();
  }
});

test("browser capture saves an accepted model login through the managed browser", opts, async () => {
  const secret = "captured-model-secret";
  const calls = [];
  const loginPage = `<!doctype html><html><body>
    <form method="post" action="/login">
      <label>Email <input id="email" name="email" type="email" autocomplete="username"></label>
      <label>Password <input id="password" name="password" type="password" autocomplete="current-password"></label>
      <button type="submit">Sign in</button>
    </form>
  </body></html>`;
  const server = await listen((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    response.setHeader("content-type", "text/html; charset=utf-8");
    if (request.method === "GET" && url.pathname === "/login") {
      response.end(loginPage);
      return;
    }
    if (request.method === "POST" && url.pathname === "/login") {
      request.resume();
      response.statusCode = 302;
      response.setHeader("location", "/home");
      response.end();
      return;
    }
    if (request.method === "GET" && url.pathname === "/home") {
      response.end("<main><h1>Signed in</h1></main>");
      return;
    }
    response.statusCode = 404;
    response.end("<main>Not found</main>");
  });
  const vault = {
    async handleRequest(action, payload, origin) {
      calls.push({ action, payload, origin });
      return { id: "captured-1", origin, username: payload.username };
    },
  };
  const bw = new BetterWright({
    home: tempHome(),
    headless: true,
    policy: new NetworkPolicy({ allowLoopback: true }),
    vault,
  });
  try {
    const result = await bw.run(`
      await page.goto(${JSON.stringify(`${server.origin}/login`)});
      await page.fill('#email', 'captured@example.test');
      await page.fill('#password', ${JSON.stringify(secret)});
      await page.getByRole('button', {name: 'Sign in'}).click();
      await page.waitForURL('**/home');
      return page.getByRole('heading').textContent();
    `);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.result, "Signed in");

    const deadline = Date.now() + 4_000;
    while (!calls.some((call) => call.action === "save") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const save = calls.find((call) => call.action === "save");
    assert.ok(save, "accepted login should reach the vault save path");
    assert.equal(save.origin, server.origin);
    assert.deepEqual(save.payload, {
      username: "captured@example.test",
      password: secret,
      label: "127.0.0.1",
      matchMode: "base-domain",
      deferToPending: true,
    });
    assert.ok(!JSON.stringify(result).includes(secret));

    const synthetic = await bw.run(`
      await page.goto(${JSON.stringify(`${server.origin}/login`)});
      await page.fill('#email', 'forged@example.test');
      await page.fill('#password', 'page-script-secret');
      await Promise.all([
        page.waitForURL('**/home'),
        page.evaluate(() => document.querySelector('button').click()),
      ]);
      return page.getByRole('heading').textContent();
    `);
    assert.equal(synthetic.ok, true, synthetic.error);
    assert.equal(synthetic.result, "Signed in");
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    assert.equal(
      calls.filter((call) => call.action === "save").length,
      1,
      "page-script submission must not create a captured credential",
    );
  } finally {
    await bw.close();
    await server.close();
  }
});

test("built-in password manager signs up, persists, and logs in through the agent", opts, async () => {
  const home = tempHome();
  const account = { username: "agent@example.test", password: "" };
  const submissions = [];
  const server = await listen((request, response) => {
    const host = request.headers.host || "";
    const url = new URL(request.url || "/", `http://${host}`);
    const html = (body) => {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(`<!doctype html><html><body>${body}</body></html>`);
    };
    if (request.method === "GET" && url.pathname === "/signup") {
      html(`<form method="post" action="/signup">
        <label>Email <input name="email" type="email" autocomplete="username" required></label>
        <label>New password <input name="password" type="password" autocomplete="new-password" required></label>
        <label>Confirm password <input name="confirm" type="password" autocomplete="new-password" required></label>
        <button type="submit">Create account</button>
      </form>`);
      return;
    }
    if (request.method === "GET" && url.pathname === "/login") {
      html(`<form method="post" action="/login">
        <label>Email <input name="email" type="email" autocomplete="username" required></label>
        <label>Password <input name="password" type="password" autocomplete="current-password" required></label>
        <button type="submit">Sign in</button>
      </form>`);
      return;
    }
    if (request.method === "POST") {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
        submissions.push({ host, path: url.pathname, form: Object.fromEntries(form) });
        if (url.pathname === "/signup") {
          account.username = form.get("email") || "";
          account.password = form.get("password") || "";
          const matches = account.password === form.get("confirm");
          response.statusCode = matches ? 200 : 400;
          html(matches ? '<main><h1>Account created</h1></main>' : "<main>Passwords differ</main>");
          return;
        }
        const authenticated =
          form.get("email") === account.username && form.get("password") === account.password;
        response.statusCode = authenticated ? 200 : 401;
        html(authenticated ? '<main><h1>Signed in</h1></main>' : "<main>Invalid login</main>");
      });
      return;
    }
    response.statusCode = 404;
    html("<main>Not found</main>");
  });

  const signupUrl = `http://signup.acme.localhost:${server.port}/signup`;
  const loginUrl = `http://login.acme.localhost:${server.port}/login`;
  try {
    const signupBrowser = new BetterWright({ home, headless: true });
    try {
      const signupModel = scriptedAgentModel([
        {
          toolCalls: [
            {
              id: "open-signup",
              name: "browser",
              input: {
                note: "Opening the signup form",
                code: `await page.goto(${JSON.stringify(signupUrl)}); return snapshot({interactive: true})`,
              },
            },
          ],
        },
        {
          toolCalls: [
            {
              id: "generate-password",
              name: "login",
              input: { generate: true, username: account.username, submit: true },
            },
          ],
        },
        (request) => {
          const pendingId = JSON.stringify(request.messages).match(
            /pending_[0-9a-f-]+/i,
          )?.[0];
          assert.ok(
            pendingId,
            "generated credential observation should include a pending id",
          );
          return {
            toolCalls: [
              {
                id: "verify-signup",
                name: "browser",
                input: {
                  note: "Verifying the new account",
                  code:
                    "const heading = await page.getByRole('heading').textContent(); " +
                    `if (heading === 'Account created') await credentials.commitGenerated({pendingId: ${JSON.stringify(pendingId)}}); ` +
                    "return {finalAnswer: heading === 'Account created' ? 'Account created' : ''}",
                },
              },
            ],
          };
        },
      ]);
      const signup = await runAgentTask({
        task: "Create an account using a generated password.",
        model: signupModel,
        browser: signupBrowser,
      });
      assert.equal(signup.ok, true, signup.answer);
      assert.equal(signup.answer, "Account created");
      assert.equal(submissions.length, 1);
      assert.equal(submissions[0].path, "/signup");
      assert.equal(submissions[0].form.email, account.username);
      assert.equal(submissions[0].form.password, submissions[0].form.confirm);
      assert.ok(account.password.length >= 16);
      assert.ok(!JSON.stringify(signup.transcript).includes(account.password));
      assert.ok(signupModel.seen[0].tools.some((tool) => tool.name === "login"));
    } finally {
      await signupBrowser.close();
    }

    const loginBrowser = new BetterWright({ home, headless: true });
    try {
      const loginModel = scriptedAgentModel([
        {
          toolCalls: [
            {
              id: "open-login",
              name: "browser",
              input: {
                note: "Opening the login form",
                code: `await page.goto(${JSON.stringify(loginUrl)}); return snapshot({interactive: true})`,
              },
            },
          ],
        },
        {
          toolCalls: [
            {
              id: "fill-login",
              name: "login",
              input: { username: account.username, submit: true },
            },
          ],
        },
        {
          toolCalls: [
            {
              id: "verify-login",
              name: "browser",
              input: {
                note: "Verifying the signed-in state",
                code:
                  "const heading = await page.getByRole('heading').textContent(); " +
                  "return {finalAnswer: heading === 'Signed in' ? 'Signed in' : ''}",
              },
            },
          ],
        },
      ]);
      const login = await runAgentTask({
        task: "Sign in with the saved account.",
        model: loginModel,
        browser: loginBrowser,
      });
      assert.equal(login.ok, true, login.answer);
      assert.equal(login.answer, "Signed in");
      assert.equal(submissions.length, 2);
      assert.equal(submissions[1].path, "/login");
      assert.equal(submissions[1].form.email, account.username);
      assert.equal(submissions[1].form.password, account.password);
      assert.ok(!JSON.stringify(login.transcript).includes(account.password));
    } finally {
      await loginBrowser.close();
    }
  } finally {
    await server.close();
  }
});

test("credentials.save/list carry category and filter, and never leak field secrets", opts, async () => {
  const apiKey = "sk-live-supersecret-01";
  const calls = [];
  const vault = {
    async handleRequest(action, payload, origin) {
      calls.push({ action, payload });
      if (action === "save") return { id: "rec-1", origin, category: payload.category };
      if (action === "list")
        // A well-behaved backend returns metadata only; the redaction net is a
        // second defense the test also exercises below.
        return { credentials: [{ id: "rec-1", category: "api-credential", label: "CI token" }] };
      return {};
    },
  };
  const bw = new BetterWright({
    home: tempHome(),
    headless: true,
    policy: new NetworkPolicy({ allowLoopback: true }),
    vault,
  });
  const server = await listen((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end("<main>ok</main>");
  });
  try {
    const result = await bw.run(
      `
      await page.goto(${JSON.stringify(server.origin)});
      const saved = await credentials.save({
        category: 'api-credential',
        label: 'CI token',
        fields: { secret: ${JSON.stringify(apiKey)} },
      });
      const listed = await credentials.list({ text: 'CI', category: 'api-credential' });
      // Try to smuggle the secret back out through ordinary console output.
      console.log('leak-probe ' + ${JSON.stringify(apiKey)});
      return { saved, listed };
    `,
    );
    assert.equal(result.ok, true, result.error);
    // Category flows through save and list unchanged.
    assert.equal(calls.find((c) => c.action === "save").payload.category, "api-credential");
    assert.deepEqual(calls.find((c) => c.action === "list").payload, {
      text: "CI",
      category: "api-credential",
    });
    assert.equal(result.result.saved.category, "api-credential");
    assert.equal(result.result.listed[0].label, "CI token");
    // The field secret was tracked, so it is scrubbed from console output.
    const consoleText = JSON.stringify(result.console || []);
    assert.doesNotMatch(consoleText, /supersecret/);
  } finally {
    await bw.close();
    await server.close();
  }
});

test("snapshot redacts filled password values but keeps other fields", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const result = await bw.run(`
      await page.setContent(\`
        <form>
          <input id="u" placeholder="Username">
          <input id="p" type="password" placeholder="Password">
          <button>Sign in</button>
        </form>
      \`);
      await page.fill('#u', 'alice');
      await page.fill('#p', 'hunter2-super-secret');
      const snap = await snapshot({ interactive: true });
      return {
        leaks: snap.includes('hunter2-super-secret'),
        redacted: snap.includes('[redacted]'),
        keepsUsername: snap.includes('alice'),
      };
    `);
    assert.equal(result.ok, true, result.error);
    // The password value must never reach the model-facing snapshot text.
    assert.equal(result.result.leaks, false);
    assert.equal(result.result.redacted, true);
    // Non-secret fields still read normally.
    assert.equal(result.result.keepsUsername, true);
  } finally {
    await bw.close();
  }
});

test("overlays dismisses cookie and promotional popups but preserves task dialogs", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const result = await bw.run(`
      await page.setContent(\`
        <div role="dialog" id="cookie"><p>We value your privacy and use cookies.</p><button onclick="this.parentElement.remove()">Reject all</button></div>
        <div role="dialog" id="promo"><p>Subscribe to our newsletter for a discount.</p><button aria-label="Close" onclick="this.parentElement.remove()">×</button></div>
        <div role="dialog" id="checkout"><p>Confirm purchase</p><button aria-label="Close">×</button></div>
      \`);
      const dismissed = await overlays.dismiss();
      return {
        dismissed,
        cookie: await page.locator('#cookie').count(),
        promo: await page.locator('#promo').count(),
        checkoutVisible: await page.locator('#checkout').isVisible(),
      };
    `);
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(
      result.result.dismissed.dismissed.map((item) => item.kind),
      ["cookie", "promotion"],
    );
    assert.equal(result.result.cookie, 0);
    assert.equal(result.result.promo, 0);
    assert.equal(result.result.checkoutVisible, true);
  } finally {
    await bw.close();
  }
});

test("controls and media inspectors expose exact live state", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const result = await bw.run(`
      await page.setContent(\`
        <label>Radius <select><option>10 miles</option><option selected>25 miles</option></select></label>
        <label>Maximum price <input type="number" min="0" max="25000" step="1" value="24999"></label>
        <input type="password" aria-label="Password" value="never-return-this">
        <h1>Game recap: Knicks vs Spurs</h1>
        <video aria-label="Game recap: Knicks vs Spurs" src="recap.mp4"></video>
      \`);
      return { controls: await controls.inspect(), media: await media.inspect() };
    `);
    assert.equal(result.ok, true, result.error);
    const controls = result.result.controls.frames[0].controls;
    const radius = controls.find((control) => control.label === "Radius");
    assert.equal(radius.options.find((option) => option.selected).text, "25 miles");
    assert.equal(controls.find((control) => control.label === "Maximum price").value, "24999");
    assert.equal(controls.find((control) => control.label === "Password").value, "[redacted]");
    const media = result.result.media.frames[0].media[0];
    assert.equal(media.title, "Game recap: Knicks vs Spurs");
    assert.equal(media.paused, true);
    assert.deepEqual(media.headings, ["Game recap: Knicks vs Spurs"]);
  } finally {
    await bw.close();
  }
});

test("controls.batch runs a guarded semantic UI transaction and waits for verification", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const result = await bw.run(`
      await page.setContent(\`
        <form id="signup">
          <label>Display name <input name="name"></label>
          <label>Plan <select name="plan"><option value="free">Free</option><option value="pro">Pro</option></select></label>
          <label><input name="terms" type="checkbox"> Accept terms</label>
          <button>Create account</button>
        </form>
        <div role="status" hidden></div>
        <script>
          document.querySelector('#signup').addEventListener('submit', (event) => {
            event.preventDefault();
            setTimeout(() => {
              const status = document.querySelector('[role=status]');
              status.hidden = false;
              status.textContent = 'Created ' + event.target.elements.name.value + ' on ' + event.target.elements.plan.value;
            }, 75);
          });
        </script>
      \`);
      return controls.batch({
        operations: [
          {id:'name', action:'fill', target:{label:'Display name', exact:true}, value:'Ada'},
          {id:'plan', action:'select', target:{label:'Plan'}, value:'pro'},
          {id:'terms', action:'check', target:{label:'Accept terms', exact:true}},
          {id:'submit', action:'click', target:{role:'button', name:'Create account', exact:true}},
          {id:'verify', action:'read', target:{role:'status'}, value:'Created Ada on pro'},
        ],
        allowWrites: true,
        minIntervalMs: 0,
      });
    `);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.result.protocol, "ui-batch/1");
    assert.equal(result.result.pageUpdated, true);
    assert.equal(result.result.results.verify.text, "Created Ada on pro");
    assert.equal(result.result.results.terms.checked, true);

    const expected = await bw.run(`
      await page.setContent('<button id="run">Run</button><div id="status">Waiting</div><script>document.querySelector("#run").onclick=()=>setTimeout(()=>document.querySelector("#status").textContent="Finished",75)</script>');
      return controls.batch({
        operations: [
          {id:'run', action:'click', target:{role:'button', name:'Run', exact:true}},
          {id:'status', action:'read', target:{css:'#status'}, value:'Finished'},
        ],
        allowWrites:true,
        minIntervalMs:0,
      });
    `);
    assert.equal(expected.ok, true, expected.error);
    assert.equal(expected.result.results.status.text, "Finished");
    assert.ok(expected.result.durationMs >= 60);

    const missingExpectation = await bw.run(`
      return controls.batch({
        operations: [
          {id:'run', action:'click', target:{role:'button', name:'Run', exact:true}},
          {id:'status', action:'read', target:{css:'#status'}},
        ],
        allowWrites:true,
      });
    `);
    assert.equal(missingExpectation.ok, false);
    assert.match(missingExpectation.error, /non-empty expected value/);

    const targetOnlyVerification = await bw.run(`
      await page.setContent('<button id="run">Resolve</button><article id="ticket">T-1</article><section id="summary">Status resolved</section><script>document.querySelector("#run").onclick=()=>setTimeout(()=>{document.querySelector("#ticket").textContent="Ticket resolved"},300)</script>');
      return controls.batch({
        operations: [
          {id:'run', action:'click', target:{role:'button', name:'Resolve', exact:true}},
          {id:'status', action:'read', target:{css:'#ticket'}, value:'resolved'},
        ],
        allowWrites:true,
        minIntervalMs:0,
      });
    `);
    assert.equal(targetOnlyVerification.ok, true, targetOnlyVerification.error);
    assert.equal(targetOnlyVerification.result.results.status.text, "Ticket resolved");
    assert.ok(targetOnlyVerification.result.durationMs >= 250);

    const directory = await bw.run(`
      await page.setContent('<label>Query <input value="browser automation"></label><select><option selected>Current plan</option></select><button>Search</button><article><h2>T-1</h2><button>Assign</button></article><article><h2>T-2</h2><button>Assign</button></article>');
      return controls.directory();
    `);
    assert.equal(directory.ok, true, directory.error);
    assert.equal(directory.result.protocol, "betterwright-ui/1");
    assert.equal(directory.result.tool, "browser_batch");
    assert.deepEqual(directory.result.controls[0].target, { label: "Query", exact: true });
    assert.equal(directory.result.controls[0].value, "browser automation");
    assert.deepEqual(directory.result.controls[1].target, { role: "combobox", exact: true });
    assert.equal(directory.result.controls[1].value, "Current plan");
    const assigns = directory.result.controls.filter((control) => control.target.name === "Assign");
    assert.equal(assigns.length, 2);
    assert.equal(assigns[0].target.nth, 0);
    assert.equal(assigns[0].context, "T-1");
    assert.equal(assigns[1].target.nth, 1);
    assert.equal(assigns[1].context, "T-2");

    const framed = await bw.run(`
      await page.setContent('<iframe name="billing" srcdoc="<label>Region <select><option>US</option><option selected>EU</option></select></label>"></iframe>');
      await page.locator('iframe').contentFrame().getByLabel('Region').waitFor();
      return controls.batch([
        {id:'region', action:'read', target:{frameName:'billing', label:'Region'}},
      ]);
    `);
    assert.equal(framed.ok, true, framed.error);
    assert.equal(framed.result.results.region.value, "EU");

    const gated = await bw.run(`
      return controls.batch([
        {id:'submit', action:'click', target:{role:'button', name:'Create account', exact:true}},
        {id:'verify', action:'read', target:{role:'status'}},
      ]);
    `);
    assert.equal(gated.ok, false);
    assert.match(gated.error, /allowWrites:true/);

    const password = await bw.run(`
      await page.setContent('<label>Password <input type="password"></label><div role="status">Ready</div>');
      return controls.batch({
        operations: [
          {id:'secret', action:'fill', target:{label:'Password'}, value:'must-not-leak'},
          {id:'verify', action:'read', target:{role:'status'}, value:'Ready'},
        ],
        allowWrites: true,
      });
    `);
    assert.equal(password.ok, false);
    assert.match(password.error, /cannot fill a password/);
    assert.ok(!JSON.stringify(password).includes("must-not-leak"));

    const suppliedPassword = await bw.run(`
      return controls.batch({
        operations: [
          {id:'secret', action:'fill', target:{label:'Password'}, value:'task-supplied'},
          {id:'verify', action:'read', target:{role:'status'}, value:'Ready'},
        ],
        allowWrites: true,
        allowPasswordFill: true,
      });
    `);
    assert.equal(suppliedPassword.ok, true, suppliedPassword.error);
    assert.equal(suppliedPassword.result.results.secret.filled, 13);
    assert.ok(!JSON.stringify(suppliedPassword).includes("task-supplied"));

    const ambiguous = await bw.run(`
      await page.setContent('<button>Save</button><button>Save</button>');
      return controls.batch({
        operations: [
          {id:'save', action:'click', target:{role:'button', name:'Save', exact:true}},
          {id:'url', action:'readUrl', value:'about:blank'},
        ],
        allowWrites: true,
      });
    `);
    assert.equal(ambiguous.ok, false);
    assert.match(ambiguous.error, /matched 2 elements/);
  } finally {
    await bw.close();
  }
});

test("ordinary navigation attaches one compact UI directory automatically", opts, async () => {
  let probes = 0;
  const site = await listen((request, response) => {
    if (request.url === "/webagents.md" || request.url === "/.well-known/webagents.json") {
      probes += 1;
      response.statusCode = 404;
      response.end("missing");
      return;
    }
    response.setHeader("content-type", "text/html");
    response.end('<label>Search <input value="compact"></label><button>Go</button>');
  });
  const bw = new BetterWright({
    home: tempHome(),
    headless: true,
    policy: new NetworkPolicy({ allowLoopback: true }),
  });
  try {
    const opened = await bw.run(`await page.goto('${site.origin}/form'); return page.url()`);
    assert.equal(opened.ok, true, opened.error);
    assert.equal(opened.ui.protocol, "betterwright-ui/1");
    assert.deepEqual(opened.ui.controls[0].target, { label: "Search", exact: true });
    assert.equal(probes, 2);

    const repeated = await bw.run("return page.title()");
    assert.equal(repeated.ok, true, repeated.error);
    assert.equal(repeated.ui, undefined);
    assert.equal(probes, 2);

    const nextPath = await bw.run(`await page.goto('${site.origin}/other'); return page.url()`);
    assert.equal(nextPath.ok, true, nextPath.error);
    assert.equal(nextPath.ui.protocol, "betterwright-ui/1");
    assert.equal(probes, 2);
  } finally {
    await bw.close();
    await site.close();
  }
});

test("action directory preserves shared contexts and refreshes them across scans and frames", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true, vault: false });
  try {
    const html = `<form><p>  First   context </p><button>Save</button><button>Save</button>
      <input aria-label="Password" type="password" value="never-return-this"></form>
      <section><p>${"Long context ".repeat(30)}</p><button>Choose</button><button>Choose</button></section>
      <iframe name="settings" srcdoc="<form><p>Frame context</p><button>Save</button><button>Save</button></form>"></iframe>`;
    const result = await bw.run(`
      await page.setContent(${JSON.stringify(html)});
      await page.frameLocator('iframe').getByRole('button', {name:'Save'}).first().waitFor();
      return controls.directory();
    `);
    assert.equal(result.ok, true, result.error);
    const controls = result.result.controls;
    const saves = controls.filter((control) => control.target.name === "Save");
    assert.deepEqual(saves.map((control) => ({ target: control.target, context: control.context })), [
      { target: { role: "button", name: "Save", exact: true, nth: 0 }, context: "First context" },
      { target: { role: "button", name: "Save", exact: true, nth: 1 }, context: "First context" },
      { target: { role: "button", name: "Save", exact: true, nth: 0, frameName: "settings" }, context: "Frame context" },
      { target: { role: "button", name: "Save", exact: true, nth: 1, frameName: "settings" }, context: "Frame context" },
    ]);
    const choices = controls.filter((control) => control.target.name === "Choose");
    assert.equal(choices.length, 2);
    assert.equal(choices[0].context.length, 180);
    assert.equal(choices[1].context, choices[0].context);
    assert.equal(controls.find((control) => control.target.label === "Password").value, "[redacted]");
    assert.equal(JSON.stringify(result.result).includes("never-return-this"), false);

    const changed = await bw.run(`
      await page.locator('form p').evaluate(element => { element.textContent = 'Updated context'; });
      return controls.directory();
    `);
    assert.equal(changed.ok, true, changed.error);
    assert.deepEqual(changed.result.controls.filter((control) => control.target.name === "Save").map((control) => control.context), [
      "Updated context", "Updated context", "Frame context", "Frame context",
    ]);

    const emptied = await bw.run(`
      await page.locator('form p').evaluate(element => { element.textContent = ''; });
      return controls.directory();
    `);
    assert.equal(emptied.ok, true, emptied.error);
    assert.deepEqual(emptied.result.controls.filter((control) => control.target.name === "Save").map((control) => control.context), [
      undefined, undefined, "Frame context", "Frame context",
    ]);
  } finally {
    await bw.close();
  }
});

test("WebAgents auto-discovery executes one same-origin operation DAG", opts, async () => {
  let status = "open";
  let workflowBody: any;
  const site = await listen((request, response) => {
    if (request.url === "/webagents.md") {
      response.setHeader("content-type", "text/markdown");
      response.end(`\`\`\`webagents
{"version":"0.1","workflow":{"endpoint":"/workflow"},"actions":{"resolve":{"effect":"write"},"status":{"effect":"read"}}}
\`\`\``);
      return;
    }
    if (request.url === "/.well-known/webagents.json") {
      response.statusCode = 404;
      response.end("missing");
      return;
    }
    if (request.url === "/workflow" && request.method === "POST") {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        workflowBody = JSON.parse(body);
        status = "resolved";
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ status }));
      });
      return;
    }
    response.setHeader("content-type", "text/html");
    response.end(`<main><div role="status">${status}</div></main>`);
  });
  const bw = new BetterWright({
    home: tempHome(),
    headless: true,
    policy: new NetworkPolicy({ allowLoopback: true }),
  });
  try {
    const opened = await bw.run(`await page.goto('${site.origin}/tickets'); return page.url()`);
    assert.equal(opened.ok, true, opened.error);
    assert.equal(opened.webagents.protocol, "webagents/0.1");
    assert.deepEqual(opened.webagents.actions.map((action) => action.name), ["resolve", "status"]);

    const batch = await bw.run(`
      return webagents.batch([
        {id:'resolve', action:'resolve', input:{}},
        {id:'verify', action:'status', input:{}},
      ], {allowWrites:true});
    `);
    assert.equal(batch.ok, true, batch.error);
    assert.equal(batch.result.pageUpdated, true);
    assert.equal(batch.result.result.status, "resolved");
    assert.deepEqual(workflowBody.operations, [
      { id: "resolve", action: "resolve", input: {} },
      { id: "verify", action: "status", input: {}, dependsOn: ["resolve"] },
    ]);
  } finally {
    await bw.close();
    await site.close();
  }
});

test("WebAgents path scopes are rediscovered after navigation", opts, async () => {
  let probes = 0;
  const site = await listen((request, response) => {
    if (request.url === "/webagents.md") {
      probes += 1;
      response.setHeader("content-type", "text/markdown");
      response.end(`\`\`\`webagents
{"version":"0.1","workflow":{"endpoint":"/workflow"},"actions":{"store":{"effect":"read","pathPrefixes":["/store"]}}}
\`\`\``);
      return;
    }
    if (request.url === "/.well-known/webagents.json") {
      probes += 1;
      response.statusCode = 404;
      response.end("missing");
      return;
    }
    response.setHeader("content-type", "text/html");
    response.end("<main>Scoped workflow</main>");
  });
  const bw = new BetterWright({
    home: tempHome(),
    headless: true,
    policy: new NetworkPolicy({ allowLoopback: true }),
  });
  try {
    const landing = await bw.run(`await page.goto('${site.origin}/'); return page.url()`);
    assert.equal(landing.ok, true, landing.error);
    assert.equal(landing.webagents, undefined);
    assert.equal(probes, 2);

    const store = await bw.run(`await page.goto('${site.origin}/store'); return page.url()`);
    assert.equal(store.ok, true, store.error);
    assert.deepEqual(store.webagents.actions.map((action) => action.name), ["store"]);
    assert.equal(probes, 4);
  } finally {
    await bw.close();
    await site.close();
  }
});

test("guard decisions are not reused across request methods", opts, async () => {
  let deleteRequests = 0;
  const server = await listen((request, response) => {
    if (request.method === "DELETE") deleteRequests += 1;
    response.setHeader("content-type", request.url === "/" ? "text/html" : "text/plain");
    response.end(request.url === "/" ? "<h1>cache test</h1>" : "ok");
  });
  const policy = new NetworkPolicy({
    allowLoopback: true,
    custom: (_url, details) =>
      details.method === "DELETE" ? { allowed: false, reason: "DELETE denied" } : null,
  });
  const bw = new BetterWright({ home: tempHome(), headless: true, policy });
  try {
    const result = await bw.run(`
      await page.goto(${JSON.stringify(server.origin)});
      return page.evaluate(async () => {
        await fetch('/api');
        try {
          await fetch('/api', {method: 'DELETE'});
          return 'allowed';
        } catch {
          return 'blocked';
        }
      });
    `);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.result, "blocked");
    assert.equal(deleteRequests, 0);
  } finally {
    await bw.close();
    await server.close();
  }
});

test("screenshots are rejected before an oversized file is written", opts, async () => {
  const home = tempHome();
  const bw = new LimitedBetterWright(
    { home, headless: true },
    { maxScreenshotBytes: 512 },
  );
  try {
    const result = await bw.run(`
      await page.setContent('<main style="width:1000px;height:1000px;background:red"></main>');
      return screenshot({kind: 'proof', name: 'oversized.png'});
    `);
    assert.equal(result.ok, false);
    assert.match(result.error || "", /screenshot.*limit/i);
    assert.equal(directorySize(path.join(home, "artifacts")), 0);
  } finally {
    await bw.close();
  }
});

test("downloads are canceled while crossing the byte limit", opts, async () => {
  const chunk = Buffer.alloc(4096, 0x61);
  const chunkCount = 64;
  const server = await listen((request, response) => {
    if (request.url === "/") {
      response.setHeader("content-type", "text/html");
      response.end(`
        <a id="download-1" href="/large-1.bin" download>Download one</a>
        <a id="download-2" href="/large-2.bin" download>Download two</a>
      `);
      return;
    }
    response.setHeader("content-type", "application/octet-stream");
    response.setHeader("content-disposition", 'attachment; filename="large.bin"');
    let sent = 0;
    const timer = setInterval(() => {
      if (sent >= chunkCount || response.destroyed) {
        clearInterval(timer);
        if (!response.destroyed) response.end();
        return;
      }
      response.write(chunk);
      sent += 1;
    }, 50);
    response.on("close", () => clearInterval(timer));
  });
  const home = tempHome();
  const maxDownloadBytes = 32 * 1024;
  // Chromium batches Browser.downloadProgress notifications. Permit one 64 KiB
  // notification window beyond the configured ceiling, but still prove that
  // cancellation stops this 256 KiB response well before completion.
  const progressAllowance = 64 * 1024;
  const bw = new LimitedBetterWright(
    {
      home,
      headless: true,
      downloadPolicy: "allow",
      policy: new NetworkPolicy({ allowLoopback: true }),
    },
    { maxArtifactBytes: maxDownloadBytes, maxDownloadBytes },
  );
  let maxObservedFile = 0;
  const observer = setInterval(() => {
    // The limit is per download. Summing both concurrent Chromium temp files
    // compares an aggregate to a per-file ceiling and flakes on platforms
    // where their progress overlaps for longer.
    maxObservedFile = Math.max(
      maxObservedFile,
      largestFileSize(path.join(home, "artifacts")),
    );
  }, 10);
  try {
    const result = await bw.run(`
      await page.goto(${JSON.stringify(server.origin)});
      await page.locator('#download-1').click();
      await page.waitForTimeout(100);
      await page.locator('#download-2').click();
      await page.waitForTimeout(1500);
      return 'done';
    `);
    assert.equal(result.ok, true, result.error);
    assert.ok(
      maxObservedFile <= maxDownloadBytes + progressAllowance,
      `download grew to ${maxObservedFile} bytes before cancellation`,
    );
    const rejected = (result.events || []).filter(
      event => event.type === "download-rejected",
    );
    assert.equal(rejected.length, 2, JSON.stringify(result.events));
  } finally {
    clearInterval(observer);
    await bw.close();
    await server.close();
  }
});

test("downloads require a trusted per-run approval by default", opts, async () => {
  const body = Buffer.from("approved download contents");
  const server = await listen((request, response) => {
    if (request.url === "/") {
      response.setHeader("content-type", "text/html");
      response.end('<a id="download" href="/report.txt" download>Download</a>');
      return;
    }
    response.setHeader("content-type", "text/plain");
    response.setHeader(
      "content-disposition",
      'attachment; filename="report.txt"',
    );
    response.end(body);
  });
  const home = tempHome();
  const bw = new BetterWright({
    home,
    headless: true,
    policy: new NetworkPolicy({ allowLoopback: true }),
  });
  const code = `
    await page.goto(${JSON.stringify(server.origin)});
    await page.locator('#download').click();
    await page.waitForTimeout(100);
    return 'done';
  `;
  try {
    const blocked = await bw.run(code);
    assert.equal(blocked.ok, true, blocked.error);
    assert.equal(
      directorySize(path.join(home, "artifacts", "downloads")),
      0,
    );
    assert.equal(
      (blocked.artifacts || []).filter((item) => item.kind === "download").length,
      0,
    );

    const approved = await bw.run(code, { approvedDownloads: true });
    assert.equal(approved.ok, true, approved.error);
    const downloads = (approved.artifacts || []).filter(
      (item) => item.kind === "download",
    );
    assert.equal(downloads.length, 1, JSON.stringify(approved.events));
    assert.deepEqual(fs.readFileSync(downloads[0].path), body);
  } finally {
    await bw.close();
    await server.close();
  }
});

test("MCP browser tool collects page console through page.on", opts, async () => {
  const bw = new BetterWright({
    home: tempHome(),
    headless: true,
    policy: new NetworkPolicy({ allowLoopback: true }),
  });
  const handlers = _createMcpHandlersForTest({
    browser: bw,
    downloadPolicy: "deny",
    liveView: { enabled: false, host: "127.0.0.1", port: 0 },
  });
  try {
    const missing = await handlers.callTool({
      params: {
        name: "browser",
        arguments: {
          code: `
            const messages = [];
            page.on("console", (message) => messages.push(message.text()));
            return { onType: typeof page.on, messages };
          `,
        },
      },
    });
    assert.equal(missing.isError, undefined, missing.content[0].text);
    const missingSummary = JSON.parse(missing.content[0].text);
    assert.equal(missingSummary.ok, true, missingSummary.error);
    assert.deepEqual(missingSummary.result, { onType: "function", messages: [] });

    const collected = await handlers.callTool({
      params: {
        name: "browser",
        arguments: {
          code: `
            const messages = [];
            page.on("console", (message) => messages.push(message.text()));
            await page.evaluate(() => console.log("mcp-console"));
            return messages;
          `,
        },
      },
    });
    assert.equal(collected.isError, undefined, collected.content[0].text);
    const collectedSummary = JSON.parse(collected.content[0].text);
    assert.equal(collectedSummary.ok, true, collectedSummary.error);
    assert.deepEqual(collectedSummary.result, ["mcp-console"]);
  } finally {
    await bw.close();
  }
});

test("MCP browser_download saves one real file without elicitation", opts, async () => {
  const body = Buffer.from("MCP autonomous download contents");
  const server = await listen((request, response) => {
    if (request.url === "/") {
      response.setHeader("content-type", "text/html");
      response.end('<a id="download" href="/report.txt" download>Download</a>');
      return;
    }
    response.setHeader("content-type", "text/plain");
    response.setHeader(
      "content-disposition",
      'attachment; filename="report.txt"',
    );
    response.end(body);
  });
  const home = tempHome();
  const bw = new BetterWright({
    home,
    headless: true,
    policy: new NetworkPolicy({ allowLoopback: true }),
  });
  const handlers = _createMcpHandlersForTest({
    browser: bw,
    downloadPolicy: "ask",
    liveView: { enabled: false, host: "127.0.0.1", port: 0 },
  });
  const code = `
    await page.goto(${JSON.stringify(server.origin)});
    await page.locator('#download').click();
    await page.waitForTimeout(100);
    return 'done';
  `;
  try {
    const ordinary = await handlers.callTool({
      params: { name: "browser", arguments: { code } },
    });
    assert.equal(ordinary.isError, undefined, ordinary.content[0].text);
    const ordinarySummary = JSON.parse(ordinary.content[0].text);
    assert.equal(ordinarySummary.ok, true, ordinarySummary.error);
    assert.equal(ordinarySummary.files, undefined);
    assert.equal(directorySize(path.join(home, "artifacts", "downloads")), 0);

    const download = await handlers.callTool({
      params: { name: "browser_download", arguments: { code } },
    });
    assert.equal(download.isError, undefined, download.content[0].text);
    const downloadSummary = JSON.parse(download.content[0].text);
    assert.equal(downloadSummary.ok, true, downloadSummary.error);
    const file = downloadSummary.files?.find((item) => item.kind === "download");
    assert.ok(file?.path, JSON.stringify(downloadSummary));
    assert.deepEqual(fs.readFileSync(file.path), body);
  } finally {
    await bw.close();
    await server.close();
  }
});

test("download approval cannot be borrowed by a different browser session", opts, async () => {
  const body = Buffer.from("cross-session download must stay blocked");
  let downloadRequests = 0;
  const server = await listen((request, response) => {
    if (request.url === "/") {
      response.setHeader("content-type", "text/html");
      response.end('<a id="download" href="/report.txt" download>Download</a>');
      return;
    }
    downloadRequests += 1;
    response.setHeader("content-type", "text/plain");
    response.setHeader(
      "content-disposition",
      'attachment; filename="report.txt"',
    );
    response.end(body);
  });
  const home = tempHome();
  const bw = new BetterWright({
    home,
    headless: true,
    policy: new NetworkPolicy({ allowLoopback: true }),
  });
  try {
    const armed = await bw.run(
      `
        await page.goto(${JSON.stringify(server.origin)});
        await page.evaluate(() => {
          setTimeout(() => {
            window.downloadAttempted = true;
            document.querySelector('#download').click();
          }, 750);
        });
        return 'armed';
      `,
      { session: "attacker" },
    );
    assert.equal(armed.ok, true, armed.error);

    const approvedVictim = await bw.run(
      "await page.waitForTimeout(1800); return 'victim complete'",
      { session: "victim", approvedDownloads: true },
    );
    assert.equal(approvedVictim.ok, true, approvedVictim.error);
    assert.equal(
      (approvedVictim.artifacts || []).some((item) => item.kind === "download"),
      false,
    );

    const attempted = await bw.run(
      "return page.evaluate(() => window.downloadAttempted === true)",
      { session: "attacker" },
    );
    assert.equal(attempted.result, true, attempted.error);
    // A canceled Chromium download may retry the transfer. Request count is
    // not the security boundary; the unapproved session must retain no bytes.
    assert.ok(downloadRequests >= 1);
    assert.equal(directorySize(path.join(home, "artifacts")), 0);
  } finally {
    await bw.close();
    await server.close();
  }
});

test("an approved run's open download gate does not leak into a concurrent session", opts, async () => {
  const body = Buffer.from("a concurrent session must not ride the open gate");
  let downloadRequests = 0;
  const server = await listen((request, response) => {
    if (request.url === "/") {
      response.setHeader("content-type", "text/html");
      response.end('<a id="download" href="/report.txt" download>Download</a>');
      return;
    }
    downloadRequests += 1;
    response.setHeader("content-type", "text/plain");
    response.setHeader("content-disposition", 'attachment; filename="report.txt"');
    response.end(body);
  });
  const home = tempHome();
  const bw = new BetterWright({
    home,
    headless: true,
    policy: new NetworkPolicy({ allowLoopback: true }),
  });
  try {
    // Sessions run concurrently now, so the browser-wide download permission
    // is open for the whole of the approved run while the unapproved one is
    // clicking. Only the session that was granted approval may keep a file.
    const [approved, sneaky] = await Promise.all([
      bw.run(
        `await page.goto(${JSON.stringify(server.origin)});
         await page.locator('#download').click();
         await page.waitForTimeout(1200);
         return 'approved done';`,
        { session: "approved", approvedDownloads: true },
      ),
      bw.run(
        `await page.waitForTimeout(300);
         await page.goto(${JSON.stringify(server.origin)});
         await page.locator('#download').click();
         await page.waitForTimeout(500);
         return 'sneaky done';`,
        { session: "sneaky" },
      ),
    ]);
    assert.equal(approved.ok, true, approved.error);
    assert.equal(sneaky.ok, true, sneaky.error);
    assert.equal(
      (approved.artifacts || []).filter((item) => item.kind === "download").length,
      1,
      "the approved session still got its download",
    );
    assert.equal(
      (sneaky.artifacts || []).filter((item) => item.kind === "download").length,
      0,
      "the unapproved session got nothing",
    );
    // Chromium starts the transfer before the guard can rule on it — the same
    // as when the two runs were serialized — so the request reaching the
    // server proves nothing. What matters is which bytes survived: only the
    // approved session's file exists, and it is the real one.
    const kept = (approved.artifacts || []).find((item) => item.kind === "download");
    assert.deepEqual(fs.readFileSync(kept.path), body);
    assert.ok(downloadRequests >= 1);
  } finally {
    await bw.close();
    await server.close();
  }
});

test("downloadPolicy deny rejects even trusted approval", opts, async () => {
  const bw = new BetterWright({
    home: tempHome(),
    headless: true,
    downloadPolicy: "deny",
  });
  try {
    const result = await bw.run("state.executed = true; return 'ran'", {
      approvedDownloads: true,
    });
    assert.equal(result.ok, false);
    assert.match(result.error || "", /downloadPolicy=deny/);
    const state = await bw.run("return state.executed ?? false");
    assert.equal(state.result, false);
  } finally {
    await bw.close();
  }
});

test("screenshot without an extension still yields a png", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    await bw.run("await page.goto('https://example.com')");
    const result = await bw.run("return screenshot({kind: 'proof', name: 'home'})");
    assert.equal(result.ok, true, result.error);
    assert.ok(result.artifacts[0].path.endsWith(".png"));
  } finally {
    await bw.close();
  }
});

test("screenshots encode at CSS scale without changing page identity", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const result = await bw.run(`
      await page.setContent('<main style="width:100px;height:100px;background:#369"></main>');
      const viewport = await page.evaluate(() => ({
        width: innerWidth,
        height: innerHeight,
        devicePixelRatio,
      }));
      const artifact = await screenshot({kind: 'debug', name: 'css-scale.png'});
      return {viewport, artifact};
    `);
    assert.equal(result.ok, true, result.error);
    const image = fs.readFileSync(result.result.artifact.path);
    assert.equal(image.subarray(1, 4).toString("ascii"), "PNG");
    assert.equal(image.readUInt32BE(16), result.result.viewport.width);
    assert.equal(image.readUInt32BE(20), result.result.viewport.height);
    assert.ok(result.result.viewport.devicePixelRatio >= 1);
  } finally {
    await bw.close();
  }
});

test("visible bot challenges include actionable state and a vision artifact", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const result = await bw.run(
      "await page.setContent('<h1>One last step</h1><p>Please solve the challenge below to continue</p>'); return 'loaded'",
    );
    assert.equal(result.ok, true, result.error);
    assert.equal(result.challenges?.[0]?.type, "bot_challenge");
    assert.equal(result.challenges?.[0]?.solve?.maxAttempts, 3);
    assert.ok(result.warnings?.some((warning) => /solve it before retrying/i.test(warning)));
    assert.ok(result.artifacts?.some((artifact) => artifact.kind === "captcha"));
  } finally {
    await bw.close();
  }
});

test("inactive stale challenges do not contaminate the active tab result", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const result = await bw.run(`
      await page.setContent('<h1>Verify you are human to continue</h1>');
      const blockedId = pages[0];
      const clean = await openPage();
      await clean.setContent('<h1>Current clean result</h1>');
      return { blockedId, clean: await clean.title() };
    `);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.challenges, undefined);
    assert.equal(
      result.artifacts?.some((artifact) => artifact.kind === "captcha") ?? false,
      false,
    );

    const blockedId = result.result.blockedId.pageId;
    const selected = await bw.run(`
      await usePage(${JSON.stringify(blockedId)});
      return page.url();
    `);
    assert.equal(selected.challenges?.[0]?.type, "bot_challenge");
    assert.ok(selected.artifacts?.some((artifact) => artifact.kind === "captcha"));
  } finally {
    await bw.close();
  }
});

test("iframe-only bot challenges are detected", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const result = await bw.run(`
      await page.setContent('<iframe srcdoc="<h1>Verify you are human</h1>"></iframe>');
      return 'loaded';
    `);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.challenges?.[0]?.detectedIn, "frame");
  } finally {
    await bw.close();
  }
});

// The staged scan reads same-origin frame text without a round trip, so the
// srcdoc case above never exercises the hard half. A real out-of-process frame
// is opaque to that read, and this one names no provider anywhere in its URL:
// only the gate's unread-frame budget can reach it.
test("bot challenges in a cross-origin frame are detected", opts, async () => {
  const embed = await listen((_request, response) => {
    response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
    response.end("<!doctype html><body><h1>Verify you are human</h1></body>");
  }, "localhost");
  const site = await listen((_request, response) => {
    response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
    response.end(
      `<!doctype html><body><h1>Checkout</h1>` +
        `<iframe width="320" height="120" src="${embed.origin}/w/9f3.html"></iframe>` +
        `</body>`,
    );
  });
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const result = await bw.run(`
      await page.goto(${JSON.stringify(site.origin)});
      const frames = page.frames();
      return frames.map(frame => frame.url());
    `);
    assert.equal(result.ok, true, result.error);
    assert.ok(
      result.result.some((url) => url.startsWith(embed.origin)),
      `the challenge frame never attached: ${JSON.stringify(result.result)}`,
    );
    assert.equal(result.challenges?.[0]?.detectedIn, "frame");
  } finally {
    await bw.close();
    await site.close();
    await embed.close();
  }
});

test("a completed provider response clears the challenge and resumes", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const unresolved = await bw.run(`
      await page.setContent(
        "<p>I'm not a robot</p>" +
        "<textarea hidden name='g-recaptcha-response'></textarea>" +
        "<textarea hidden name='g-recaptcha-response'></textarea>"
      );
      return 'waiting';
    `);
    assert.equal(unresolved.ok, true, unresolved.error);
    assert.equal(unresolved.challenges?.[0]?.provider, "recaptcha");

    const partial = await bw.run(`
      await page.locator('[name="g-recaptcha-response"]').first().evaluate(
        element => { element.value = 'first-provider-response'; }
      );
      return 'one widget remains';
    `);
    assert.equal(partial.challenges?.[0]?.provider, "recaptcha");

    const solved = await bw.run(`
      await page.locator('[name="g-recaptcha-response"]').evaluateAll(
        elements => elements.forEach(
          (element, index) => { element.value = 'provider-response-' + index; }
        )
      );
      return 'continue original task';
    `);
    assert.equal(solved.ok, true, solved.error);
    assert.equal(solved.result, "continue original task");
    assert.equal(solved.challenges, undefined);
  } finally {
    await bw.close();
  }
});

test("failed snippets preserve bot-challenge evidence for recovery", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const result = await bw.run(`
      await page.setContent('<h1>Verify you are human to continue</h1>');
      throw new Error('blocked action');
    `);
    assert.equal(result.ok, false);
    assert.match(result.error, /blocked action/);
    assert.equal(result.challenges?.[0]?.type, "bot_challenge");
    assert.ok(result.artifacts?.some((artifact) => artifact.kind === "captcha"));
    assert.ok(Array.isArray(result.pages));
  } finally {
    await bw.close();
  }
});

test("a missing locator fails before the run deadline and preserves the page", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const seeded = await bw.run(
      "await page.setContent('<p id=kept>still here</p>'); return true",
    );
    assert.equal(seeded.ok, true, seeded.error);

    const started = Date.now();
    const missed = await bw.run(
      "await page.getByRole('button', {name:'never appears'}).click(); return true",
      { timeout: 25_000 },
    );
    assert.equal(missed.ok, false);
    assert.match(missed.error, /Timeout 10000ms exceeded/);
    assert.ok(Date.now() - started < 20_000, `locator miss took ${Date.now() - started}ms`);

    const recovered = await bw.run("return page.locator('#kept').textContent()");
    assert.equal(recovered.ok, true, recovered.error);
    assert.equal(recovered.result, "still here");
  } finally {
    await bw.close();
  }
});

test("timed-out challenge runs report that the page must be reopened", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const result = await bw.run(
      `
        await page.setContent('<h1>Verify you are human to continue</h1>');
        await new Promise(() => {});
      `,
      { timeout: 5 },
    );
    assert.equal(result.ok, false);
    assert.match(result.error, /timed out/i);
    assert.equal(result.challenges?.[0]?.solve?.resumeOnClear, false);
    assert.equal(result.challenges?.[0]?.solve?.reopenRequired, true);
    assert.equal(result.challenges?.[0]?.recovery?.pagePreserved, false);
    assert.match(result.warnings?.join(" ") || "", /next browser call, reopen/i);

    const restarted = await bw.run("return page.url()");
    assert.equal(restarted.ok, true, restarted.error);
  } finally {
    await bw.close();
  }
});

test("timeout restart flushes recent persistent-profile changes", opts, async () => {
  const server = await listen((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<title>Profile flush</title><h1>Profile flush</h1>");
  });
  const home = tempHome();
  try {
    const seed = new BetterWright({ home, headless: true });
    try {
      const stored = await seed.run(`
        await page.goto(${JSON.stringify(server.origin)});
        return page.evaluate(() => {
          document.cookie = 'seeded=alive; Max-Age=3600; Path=/; SameSite=Lax';
          return document.cookie;
        });
      `);
      assert.equal(stored.ok, true, stored.error);
      assert.match(stored.result, /seeded=alive/);
    } finally {
      await seed.close();
    }

    const bw = new BetterWright({ home, headless: true });
    try {
      const stored = await bw.run(`
        await page.goto(${JSON.stringify(server.origin)});
        return page.evaluate(() => {
          document.cookie = 'recent=alive; Max-Age=3600; Path=/; SameSite=Lax';
          return document.cookie;
        });
      `);
      assert.equal(stored.ok, true, stored.error);
      assert.equal(stored.profileMode, "persistent");
      assert.match(stored.result, /seeded=alive/);
      assert.match(stored.result, /recent=alive/);

      const timedOut = await bw.run("await new Promise(() => {})", {
        timeout: 5,
      });
      assert.equal(timedOut.ok, false);
      assert.match(timedOut.error, /timed out/i);

      const restarted = await bw.run(`
        await page.goto(${JSON.stringify(server.origin)});
        return page.evaluate(() => document.cookie);
      `);
      assert.equal(restarted.ok, true, restarted.error);
      assert.equal(restarted.profileMode, "persistent");
      assert.match(restarted.result, /seeded=alive/);
      assert.match(restarted.result, /recent=alive/);
    } finally {
      await bw.close();
    }
  } finally {
    await server.close();
  }
});

test("captcha.click activates a checkbox-style challenge and returns a fresh snapshot", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const result = await bw.run(`
      await page.setContent('<button id="verify" style="width:300px;height:80px;padding:0">Verify you are human</button><script>window.pointerMoves=0;document.addEventListener("pointermove",()=>window.pointerMoves++);</script>');
      await page.locator('#verify').evaluate(element => {
        element.addEventListener('click', event => {
          const rect = element.getBoundingClientRect();
          window.clickRatio = (event.clientX - rect.left) / rect.width;
          if (window.clickRatio <= 0.2) element.textContent = 'Verified';
        });
      });
      const bounds = await page.locator('#verify').boundingBox();
      await captcha.click(bounds);
      return {
        text: await page.locator('#verify').textContent(),
        pointerMoves: await page.evaluate(() => window.pointerMoves),
        clickRatio: await page.evaluate(() => window.clickRatio),
      };
    `);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.result.text, "Verified");
    assert.ok(result.result.pointerMoves >= 18, result.result.pointerMoves);
    assert.ok(result.result.clickRatio >= 0.12, result.result.clickRatio);
    assert.ok(result.result.clickRatio <= 0.18, result.result.clickRatio);
  } finally {
    await bw.close();
  }
});

test("captcha.inspect emits a challenge image for model vision", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const result = await bw.run(`
      await page.setContent('<div id="challenge" style="width:300px;height:180px">Select every bus</div>');
      const bounds = await page.locator('#challenge').boundingBox();
      return captcha.inspect(bounds);
    `);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.result.kind, "captcha");
    assert.match(result.result.instruction, /inspect the attached challenge/i);
    assert.equal(result.artifacts?.[0]?.kind, "captcha");
  } finally {
    await bw.close();
  }
});

test("captcha.drag performs a smooth pointer drag and returns a fresh snapshot", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const result = await bw.run(`
      await page.setContent(\`
        <button id="handle" style="position:absolute;left:40px;top:40px;width:40px;height:40px">Slide</button>
        <p id="status" aria-live="polite">Waiting</p>
        <script>
          let started = false;
          document.querySelector('#handle').addEventListener('mousedown', () => { started = true; });
          document.addEventListener('mouseup', event => {
            if (started && event.clientX > 200) document.querySelector('#status').textContent = 'Dragged';
          });
        </script>
      \`);
      const bounds = await page.locator('#handle').boundingBox();
      const from = {x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2};
      return captcha.drag(from, {x: 260, y: from.y}, {steps: 12});
    `);
    assert.equal(result.ok, true, result.error);
    assert.match(result.result, /Dragged/);
  } finally {
    await bw.close();
  }
});

test("captcha.readText emits only a cropped image artifact for Pi vision", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const result = await bw.run(`
      await page.setContent('<div id="code" style="font:32px monospace;width:220px;height:70px">A7K9</div>');
      const bounds = await page.locator('#code').boundingBox();
      return captcha.readText(bounds);
    `);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.result.kind, "captcha");
    assert.match(result.result.instruction, /attached CAPTCHA crop/i);
    assert.equal(result.artifacts.length, 1);
    assert.equal(result.artifacts[0].kind, "captcha");
    assert.deepEqual(fs.readFileSync(result.artifacts[0].path).subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  } finally {
    await bw.close();
  }
});

test("human helpers use shaped pointer, keyboard, and wheel events", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const result = await bw.run(`
      await page.setContent(\`
        <button id="go" style="margin:80px;width:180px;height:50px">Go</button>
        <input id="name" style="display:block;margin:40px;width:240px;height:40px" value="old">
        <div id="bio" contenteditable="true" style="display:block;margin:40px;width:240px;height:40px">stale words</div>
        <div style="height:2400px"></div>
        <p id="status">Waiting</p>
        <script>
          window.pointerMoves = 0;
          window.wheelEvents = 0;
          document.addEventListener('pointermove', () => window.pointerMoves++);
          document.addEventListener('wheel', () => window.wheelEvents++);
          document.querySelector('#go').addEventListener('click', () => {
            document.querySelector('#status').textContent = 'Clicked';
          });
        </script>
      \`);
      await human.click(page.locator('#go'));
      await human.type('#name', 'Ada');
      await human.type('#bio', 'Lovelace');
      await human.scroll(600, {steps: 6});
      return page.evaluate(() => ({
        status: document.querySelector('#status').textContent,
        value: document.querySelector('#name').value,
        bio: document.querySelector('#bio').textContent,
        pointerMoves: window.pointerMoves,
        wheelEvents: window.wheelEvents,
        scrollY,
      }));
    `);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.result.status, "Clicked");
    assert.equal(result.result.value, "Ada");
    // The clear must actually remove pre-existing text — on the Chromium
    // fork a synthesized Control+A never ran the select-all editing command,
    // so "old"/"stale words" used to survive underneath the typed text.
    assert.equal(result.result.bio, "Lovelace");
    assert.ok(result.result.pointerMoves >= 18, result.result.pointerMoves);
    assert.ok(result.result.wheelEvents >= 2, result.result.wheelEvents);
    assert.ok(result.result.scrollY > 0, result.result.scrollY);
  } finally {
    await bw.close();
  }
});

test("human.type clears even when Backspace is swallowed", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const result = await bw.run(`
      await page.setContent(\`
        <input id="name" value="old" style="width:240px;height:40px">
        <script>
          document.querySelector('#name').addEventListener('keydown', (event) => {
            if (event.key === 'Backspace' || event.key === 'Delete') event.preventDefault();
          });
        </script>
      \`);
      const typed = await human.type('#name', 'hello');
      return {
        typed,
        value: await page.evaluate(() => document.querySelector('#name').value),
      };
    `);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.result.typed.typed, 5);
    assert.equal(result.result.value, "hello");
  } finally {
    await bw.close();
  }
});

test("human.type inserts into a rich-text editor that swallows key events", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const result = await bw.run(`
      await page.setContent(\`
        <div id="editor" contenteditable="true" style="width:400px;height:80px"></div>
        <script>
          document.querySelector('#editor').addEventListener('keydown', (event) => {
            if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
              event.preventDefault();
            }
          });
        </script>
      \`);
      const typed = await human.type('#editor', 'hello from human');
      return {
        typed,
        text: await page.evaluate(() => document.querySelector('#editor').textContent),
      };
    `);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.result.typed.typed, 16);
    assert.equal(result.result.text, "hello from human");
  } finally {
    await bw.close();
  }
});

test("human.type retries when key events only land a prefix", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const result = await bw.run(`
      await page.setContent(\`
        <input id="name" style="width:240px;height:40px">
        <script>
          const name = document.querySelector('#name');
          name.addEventListener('keydown', (event) => {
            if (event.key.length === 1 && name.value.length >= 3) event.preventDefault();
          });
        </script>
      \`);
      const typed = await human.type('#name', 'hello');
      return {
        typed,
        value: await page.evaluate(() => document.querySelector('#name').value),
      };
    `);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.result.typed.typed, 5);
    assert.equal(result.result.value, "hello");
  } finally {
    await bw.close();
  }
});

test("human.type restores a contenteditable before retrying a partial append", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const result = await bw.run(`
      await page.setContent(\`
        <div id="editor" contenteditable="true" style="width:400px;height:80px">Ada</div>
        <script>
          const editor = document.querySelector('#editor');
          let accepted = 0;
          editor.addEventListener('keydown', (event) => {
            if (event.key.length !== 1) return;
            event.preventDefault();
            if (accepted < 1) {
              accepted += 1;
              editor.textContent += event.key;
            }
          });
        </script>
      \`);
      const typed = await human.type('#editor', 'Ada', {clear: false});
      return {
        typed,
        text: await page.evaluate(() => document.querySelector('#editor').textContent),
      };
    `);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.result.typed.typed, 3);
    assert.equal(result.result.text, "AdaAda");
  } finally {
    await bw.close();
  }
});

test("human.type retries a partial append onto existing matching text", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const result = await bw.run(`
      await page.setContent(\`
        <input id="name" value="Ada" style="width:240px;height:40px">
        <script>
          const name = document.querySelector('#name');
          let accepted = 0;
          name.addEventListener('keydown', (event) => {
            if (event.key.length !== 1) return;
            event.preventDefault();
            if (accepted < 1) {
              accepted += 1;
              name.value += event.key;
            }
          });
        </script>
      \`);
      const typed = await human.type('#name', 'Ada', {clear: false});
      return {
        typed,
        value: await page.evaluate(() => document.querySelector('#name').value),
      };
    `);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.result.typed.typed, 3);
    assert.equal(result.result.value, "AdaAda");
  } finally {
    await bw.close();
  }
});

test("human.type appends when the field already contains the requested text", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const result = await bw.run(`
      await page.setContent(\`
        <input id="name" value="Ada" style="width:240px;height:40px">
        <script>
          document.querySelector('#name').addEventListener('keydown', (event) => {
            if (event.key.length === 1) event.preventDefault();
          });
        </script>
      \`);
      const typed = await human.type('#name', 'Ada', {clear: false});
      return {
        typed,
        value: await page.evaluate(() => document.querySelector('#name').value),
      };
    `);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.result.typed.typed, 3);
    assert.equal(result.result.value, "AdaAda");
  } finally {
    await bw.close();
  }
});

test("human.type throws when the field stays empty", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const result = await bw.run(`
      await page.setContent(\`
        <div id="editor" contenteditable="true" style="width:400px;height:80px"></div>
        <script>
          const editor = document.querySelector('#editor');
          new MutationObserver(() => { editor.textContent = ''; }).observe(editor, {
            childList: true, subtree: true, characterData: true,
          });
          editor.addEventListener('keydown', (event) => {
            if (event.key.length === 1) event.preventDefault();
          });
          editor.addEventListener('beforeinput', (event) => event.preventDefault());
        </script>
      \`);
      await human.type('#editor', 'hello');
    `);
    assert.equal(result.ok, false);
    assert.match(String(result.error), /did not change the field/i);
  } finally {
    await bw.close();
  }
});

test("interactive snapshots expose refs that aria-ref locators can act on", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const snap = await bw.run(`
      await page.setContent(\`
        <h1>Title</h1><p>Lots of static prose.</p>
        <button id="go">Go</button>
        <script>
          document.querySelector('#go').addEventListener('click', () => {
            document.querySelector('h1').textContent = 'Done';
          });
        </script>
      \`);
      return snapshot({interactive: true});
    `);
    assert.equal(snap.ok, true, snap.error);
    assert.match(snap.result, /button "Go" \[ref=(e\d+)\]/);
    assert.ok(!snap.result.includes("static prose"), snap.result);
    const ref = snap.result.match(/button "Go" \[ref=(e\d+)\]/)[1];
    const clicked = await bw.run(`
      await page.locator('aria-ref=${ref}').click();
      return page.locator('h1').textContent();
    `);
    assert.equal(clicked.ok, true, clicked.error);
    assert.equal(clicked.result, "Done");
  } finally {
    await bw.close();
  }
});

test("controls.batch accepts snapshot aria refs from frames", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const result = await bw.run(`
      await page.setContent(\`
        <button id="main">Main action</button>
        <p id="mainStatus">main waiting</p>
        <iframe name="outer" title="outer"></iframe>
        <script>
          document.querySelector('#main').addEventListener('click', () => {
            document.querySelector('#mainStatus').textContent = 'main clicked';
          });
        </script>
      \`);
      const outer = page.frame({name: 'outer'});
      await outer.setContent(\`
        <button id="outerButton">Outer action</button>
        <p id="outerStatus">outer waiting</p>
        <iframe name="inner" title="inner"></iframe>
        <script>
          document.querySelector('#outerButton').addEventListener('click', () => {
            document.querySelector('#outerStatus').textContent = 'outer clicked';
          });
        </script>
      \`);
      const inner = page.frame({name: 'inner'});
      await inner.setContent(\`
        <button id="deepPlain">Deep plain action</button>
        <button id="deepPrefixed">Deep prefixed action</button>
        <p id="deepPlainStatus">deep plain waiting</p>
        <p id="deepPrefixedStatus">deep prefixed waiting</p>
        <script>
          document.querySelector('#deepPlain').addEventListener('click', () => {
            document.querySelector('#deepPlainStatus').textContent = 'deep plain clicked';
          });
          document.querySelector('#deepPrefixed').addEventListener('click', () => {
            document.querySelector('#deepPrefixedStatus').textContent = 'deep prefixed clicked';
          });
        </script>
      \`);
      const snap = await snapshot({interactive: true});
      const refFor = (label) => {
        const line = snap.split('\\n').find((entry) => entry.includes('button "' + label + '" [ref='));
        const match = line?.match(/\\[ref=([^\\]]+)\\]/);
        if (!match) throw new Error('missing ref for ' + label + '\\n' + snap);
        return match[1];
      };
      const mainRef = refFor('Main action');
      const outerRef = refFor('Outer action');
      const deepPlainRef = refFor('Deep plain action');
      const deepPrefixedRef = refFor('Deep prefixed action');
      if (!/^e\\d+$/.test(mainRef)) throw new Error('expected main ref, got ' + mainRef);
      for (const ref of [outerRef, deepPlainRef, deepPrefixedRef]) {
        if (!/^(?:f\\d+)+e\\d+$/.test(ref)) throw new Error('expected frame ref, got ' + ref);
      }
      const run = async (id, ref, target, expected) => controls.batch({
        operations: [
          {id: 'click' + id, action: 'click', target: {ref}},
          {id: 'read' + id, action: 'read', target, value: expected},
        ],
        allowWrites: true,
        returnDirectory: false,
      });
      const main = await run('Main', mainRef, {css: '#mainStatus'}, 'main clicked');
      const outerResult = await run('Outer', 'aria-ref=' + outerRef, {css: '#outerStatus', frameName: 'outer'}, 'outer clicked');
      const deepPlain = await run('DeepPlain', deepPlainRef, {css: '#deepPlainStatus', frameName: 'inner'}, 'deep plain clicked');
      const deepPrefixed = await run('DeepPrefixed', 'aria-ref=' + deepPrefixedRef, {css: '#deepPrefixedStatus', frameName: 'inner'}, 'deep prefixed clicked');
      const invalid = await controls.batch({
        operations: [
          {id: 'clickBad', action: 'click', target: {ref: 'f1'}},
          {id: 'readBad', action: 'read', target: {css: '#mainStatus'}, value: 'main clicked'},
        ],
        allowWrites: true,
        returnDirectory: false,
      }).then(
        () => 'accepted',
        (error) => String(error?.message || error),
      );
      return {
        refs: {mainRef, outerRef, deepPlainRef, deepPrefixedRef},
        main: main.results.readMain.text,
        outer: outerResult.results.readOuter.text,
        deepPlain: deepPlain.results.readDeepPlain.text,
        deepPrefixed: deepPrefixed.results.readDeepPrefixed.text,
        invalid,
      };
    `);
    assert.equal(result.ok, true, result.error);
    assert.match(result.result.refs.mainRef, /^e\d+$/);
    assert.match(result.result.refs.outerRef, /^(?:f\d+)+e\d+$/);
    assert.match(result.result.refs.deepPlainRef, /^(?:f\d+)+e\d+$/);
    assert.match(result.result.refs.deepPrefixedRef, /^(?:f\d+)+e\d+$/);
    assert.equal(result.result.main, "main clicked");
    assert.equal(result.result.outer, "outer clicked");
    assert.equal(result.result.deepPlain, "deep plain clicked");
    assert.equal(result.result.deepPrefixed, "deep prefixed clicked");
    assert.match(result.result.invalid, /invalid aria ref/);
  } finally {
    await bw.close();
  }
});

test("WebMCP discovers and invokes a real page-published tool without exposing CDP", opts, async () => {
  const site = await listen((_request, response) => {
    response.writeHead(200, {"content-type": "text/html"});
    response.end(`<!doctype html>
      <h1>WebMCP fixture</h1>
      <p id="status">waiting</p>
      <script>
        const modelContext = navigator.modelContext || document.modelContext;
        modelContext.registerTool({
          name: "calculateSum",
          description: "Add two numbers.",
          inputSchema: {
            type: "object",
            properties: {a: {type: "number"}, b: {type: "number"}},
            required: ["a", "b"],
          },
          annotations: {readOnly: true, untrustedContent: false},
          execute: ({a, b}) => {
            document.querySelector("#status").textContent = "invoked";
            return {a, b, sum: Number(a) + Number(b)};
          },
        });
      </script>`);
  });
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const result = await bw.run(`
      await page.goto(${JSON.stringify(site.origin)});
      const tools = await webmcp.tools({timeout: 1000});
      const invocation = await webmcp.invoke(
        "calculateSum",
        {a: 19, b: 23},
        {frameId: tools[0].frameId, timeout: 5000},
      );
      return {
        tools,
        invocation,
        visibleState: await page.locator("#status").innerText(),
        cdpType: typeof context.newCDPSession,
      };
    `);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.result.tools.length, 1);
    assert.equal(result.result.tools[0].name, "calculateSum");
    assert.equal(result.result.tools[0].trust, "untrusted_external_data");
    // Chromium normalizes annotations before emitting the descriptor (the
    // pinned build currently reports an explicit boolean here even when the
    // registration supplied true), so this pins preservation, not a browser
    // implementation detail.
    assert.ok(isBoolean(result.result.tools[0].annotations.readOnly));
    assert.equal(result.result.invocation.status, "Completed");
    assert.deepEqual(result.result.invocation.output, {a: 19, b: 23, sum: 42});
    assert.equal(result.result.invocation.trust, "untrusted_external_data");
    assert.equal(result.result.visibleState, "invoked");
    assert.equal(result.result.cdpType, "undefined");
  } finally {
    await bw.close();
    await site.close();
  }
});

test("snapshot compresses wrappers and urls but keeps refs actionable", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const result = await bw.run(`
      await page.setContent(\`
        <div><div><a href="/docs">Docs</a></div></div>
        <p>First.</p><p>Second.</p>
      \`);
      const plain = await snapshot();
      const withUrls = await snapshot({urls: true});
      return {plain, withUrls};
    `);
    assert.equal(result.ok, true, result.error);
    // Wrapper divs are unwrapped, /url dropped, paragraphs merged into text.
    assert.match(result.result.plain, /link "Docs" \[ref=e\d+\]/);
    assert.ok(!result.result.plain.includes("/url"), result.result.plain);
    assert.match(result.result.plain, /text: First\. Second\./);
    assert.match(result.result.withUrls, /\/url: \/docs/);
  } finally {
    await bw.close();
  }
});

test("oversized snapshots return scoping hints instead of a cut-off tree", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const result = await bw.run(`
      const rows = Array.from({length: 200}, (_, i) =>
        \`<li><a href="/item/\${i}">Item number \${i} with some label text</a></li>\`).join("");
      await page.setContent(\`<ul>\${rows}</ul>\`);
      return snapshot({maxChars: 1000});
    `);
    assert.equal(result.ok, true, result.error);
    assert.match(result.result, /Snapshot is \d+ chars, over the 1000 limit/);
    assert.match(result.result, /interactive: true/);
    assert.ok(!result.result.includes("[ref="), result.result);
  } finally {
    await bw.close();
  }
});

test("snapshot retries compare only against trees delivered within the size limit", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true, vault: false });
  try {
    const result = await bw.run(`
      await page.setContent(Array.from({ length: 60 }, (_, i) =>
        '<button>Item ' + i + ' with a useful label</button>').join(''));
      const refused = await snapshot({ diff: true, maxChars: 1000 });
      const retried = await snapshot({ diff: true, maxChars: 20000 });
      const unchanged = await snapshot({ diff: true, maxChars: 20000 });
      await page.setContent('<button>Original</button>');
      await snapshot();
      await page.evaluate(() => {
        const extra = document.createElement('section');
        extra.id = 'extra';
        extra.innerHTML = Array.from({ length: 60 }, (_, i) =>
          '<button>Different ' + i + ' with a useful label</button>').join('');
        document.body.append(extra);
      });
      const refusedDiff = await snapshot({ diff: true, maxChars: 1000 });
      await page.locator('#extra').evaluate(element => element.remove());
      const restored = await snapshot({ diff: true, maxChars: 20000 });
      return { refused, retried, unchanged, refusedDiff, restored };
    `);
    assert.equal(result.ok, true, result.error);
    assert.match(result.result.refused, /over the 1000 limit/);
    assert.match(result.result.retried, /button "Item 59 with a useful label"/);
    assert.doesNotMatch(result.result.retried, /no changes|diff vs previous/);
    assert.match(result.result.unchanged, /no changes since previous snapshot/);
    assert.match(result.result.refusedDiff, /over the 1000 limit/);
    assert.match(result.result.restored, /no changes since previous snapshot/);
  } finally {
    await bw.close();
  }
});

test("snapshot diff keeps separate histories for URL visibility", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true, vault: false });
  try {
    const result = await bw.run(`
      await page.setContent('<a href="/docs">Docs</a>');
      const plain = await snapshot({ diff: true });
      const urls = await snapshot({ diff: true, urls: true });
      const plainAgain = await snapshot({ diff: true });
      const urlsAgain = await snapshot({ diff: true, urls: true });
      return { plain, urls, plainAgain, urlsAgain };
    `);
    assert.equal(result.ok, true, result.error);
    assert.doesNotMatch(result.result.plain, /\/url/);
    assert.match(result.result.urls, /\/url: \/docs/);
    assert.doesNotMatch(result.result.urls, /diff vs previous/);
    assert.match(result.result.plainAgain, /no changes since previous snapshot/);
    assert.match(result.result.urlsAgain, /no changes since previous snapshot/);
  } finally {
    await bw.close();
  }
});

test("snapshot diff returns only what changed", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const result = await bw.run(`
      await page.setContent('<button id="go">Go</button><p id="status">Idle</p>');
      const first = await snapshot({diff: true});
      const unchanged = await snapshot({diff: true});
      await page.locator('#status').evaluate(el => { el.textContent = 'Running'; });
      const changed = await snapshot({diff: true});
      return {first, unchanged, changed};
    `);
    assert.equal(result.ok, true, result.error);
    assert.match(result.result.first, /button "Go"/);
    assert.match(result.result.unchanged, /no changes since previous snapshot/);
    assert.match(result.result.changed, /diff vs previous snapshot \(\+\d+ -\d+\)/);
    assert.match(result.result.changed, /\+.*Running/);
    assert.ok(!result.result.changed.includes('button "Go"'), result.result.changed);
  } finally {
    await bw.close();
  }
});

test("snapshot scopes to a selector", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const result = await bw.run(`
      await page.setContent('<nav><a href="#x">Away</a></nav><main id="m"><button>In</button></main>');
      return snapshot({selector: '#m'});
    `);
    assert.equal(result.ok, true, result.error);
    assert.match(result.result, /button "In"/);
    assert.ok(!result.result.includes("Away"), result.result);
  } finally {
    await bw.close();
  }
});

test("empty envelope collections are omitted, not sent as []", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const result = await bw.run("return 1 + 1");
    assert.equal(result.ok, true, result.error);
    assert.equal(result.result, 2);
    assert.ok(!("console" in result), "console should be omitted when empty");
    assert.ok(!("events" in result), "events should be omitted when empty");
    assert.ok(!("artifacts" in result), "artifacts should be omitted when empty");
  } finally {
    await bw.close();
  }
});

test("model code cannot reach CDP or Playwright private channels", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const result = await bw.run(`
      return {
        pageContext: typeof page.context,
        contextCdp: typeof context.newCDPSession,
        pageChannel: typeof page._channel,
        contextBrowser: typeof context.browser,
        contextAddCookies: typeof context.addCookies,
        contextClearCookies: typeof context.clearCookies,
        contextSetStorageState: typeof context.setStorageState,
      };
    `);
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(result.result, {
      pageContext: "undefined",
      contextCdp: "undefined",
      pageChannel: "undefined",
      contextBrowser: "undefined",
      contextAddCookies: "undefined",
      contextClearCookies: "undefined",
      contextSetStorageState: "undefined",
    });
  } finally {
    await bw.close();
  }
});

test("page.on collects page console and pageerror for the current snippet", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const issueRepro = await bw.run(`
      const messages = [];
      page.on("console", (message) => messages.push(message.text()));
      return { onType: typeof page.on, messages };
    `);
    assert.equal(issueRepro.ok, true, issueRepro.error);
    assert.deepEqual(issueRepro.result, { onType: "function", messages: [] });

    const captured = await bw.run(`
      const messages = [];
      const errors = [];
      page.on("console", (message) => messages.push({
        type: message.type(),
        text: message.text(),
      }));
      page.on("pageerror", (error) => errors.push(error.message));
      await page.setContent(\`<script>
        console.log("hello from page");
        console.warn("careful");
        throw new Error("page boom");
      </script>\`);
      return { messages, errors };
    `);
    assert.equal(captured.ok, true, captured.error);
    assert.ok(
      captured.result.messages.some((item) => item.type === "log" && item.text.includes("hello from page")),
      JSON.stringify(captured.result.messages),
    );
    assert.ok(
      captured.result.messages.some((item) => item.type === "warning" && item.text.includes("careful")),
      JSON.stringify(captured.result.messages),
    );
    assert.ok(
      captured.result.errors.some((text) => text.includes("page boom")),
      JSON.stringify(captured.result.errors),
    );

    const fromEvaluate = await bw.run(`
      const messages = [];
      page.on("console", (message) => messages.push(message.text()));
      await page.evaluate(() => console.log("from-evaluate"));
      return messages;
    `);
    assert.equal(fromEvaluate.ok, true, fromEvaluate.error);
    assert.deepEqual(fromEvaluate.result, ["from-evaluate"]);

    const onceOnly = await bw.run(`
      const seen = [];
      page.once("console", (message) => seen.push(message.text()));
      await page.evaluate(() => { console.log("first"); console.log("second"); });
      return { seen };
    `);
    assert.equal(onceOnly.ok, true, onceOnly.error);
    assert.deepEqual(onceOnly.result, { seen: ["first"] });

    const detached = await bw.run(`
      const seen = [];
      const listener = (message) => seen.push(message.text());
      page.on("console", listener);
      page.off("console", listener);
      await page.evaluate(() => console.log("should not collect"));
      return { seen };
    `);
    assert.equal(detached.ok, true, detached.error);
    assert.deepEqual(detached.result, { seen: [] });
  } finally {
    await bw.close();
  }
});

test("page.on listeners do not leak into the next snippet", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const first = await bw.run(`
      state.seen = [];
      page.on("console", (message) => state.seen.push(message.text()));
      await page.evaluate(() => console.log("one"));
      return { seen: state.seen };
    `);
    assert.equal(first.ok, true, first.error);
    assert.deepEqual(first.result, { seen: ["one"] });

    const second = await bw.run(`
      await page.evaluate(() => console.log("two"));
      return { seen: state.seen };
    `);
    assert.equal(second.ok, true, second.error);
    assert.deepEqual(second.result, { seen: ["one"] });
  } finally {
    await bw.close();
  }
});

test("page.on still refuses routing events and cannot strip worker listeners", opts, async () => {
  const server = await listen((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end("<p>ok</p>");
  });
  const bw = new BetterWright({
    home: tempHome(),
    headless: true,
    policy: new NetworkPolicy({ allowLoopback: true }),
  });
  try {
    const result = await bw.run(`
      const surface = {
        on: typeof page.on,
        once: typeof page.once,
        off: typeof page.off,
        route: typeof page.route,
        removeAllListeners: typeof page.removeAllListeners,
        prependListener: typeof page.prependListener,
        contextOn: typeof context.on,
      };
      let requestError = "";
      try { page.on("request", () => {}); }
      catch (error) { requestError = error.message; }
      await page.goto(${JSON.stringify(server.origin)});
      const requests = await site.requests();
      return { surface, requestError, requestCount: requests.length };
    `);
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(result.result.surface, {
      on: "function",
      once: "function",
      off: "function",
      route: "undefined",
      removeAllListeners: "undefined",
      prependListener: "undefined",
      contextOn: "undefined",
    });
    assert.match(result.result.requestError, /can only listen for console and pageerror/);
    assert.ok(result.result.requestCount > 0, JSON.stringify(result.result));
  } finally {
    await bw.close();
    await server.close();
  }
});

test("restricted routing documents working page-local fixture alternatives", opts, async () => {
  const server = await listen((request, response) => {
    response.setHeader("content-type", request.url === "/" ? "text/html" : "application/json");
    response.end(
      request.url === "/"
        ? `<!doctype html><body>loading<script>
            fetch("/api/value")
              .then((reply) => reply.json())
              .then(({ message }) => { document.body.textContent = message; });
          </script></body>`
        : JSON.stringify({ message: "live" }),
    );
  });
  const bw = new BetterWright({
    home: tempHome(),
    headless: true,
    policy: new NetworkPolicy({ allowLoopback: true }),
  });
  try {
    const result = await bw.run(`
      await page.addInitScript(() => {
        const nativeFetch = window.fetch.bind(window);
        window.fetch = (input, init) => {
          const url = typeof input === "string" ? input : input.url;
          if (new URL(url, location.href).pathname === "/api/value") {
            return Promise.resolve(new Response(
              JSON.stringify({ message: "mocked" }),
              { headers: { "content-type": "application/json" } },
            ));
          }
          return nativeFetch(input, init);
        };
      });
      await page.goto(${JSON.stringify(server.origin)});
      await page.getByText("mocked").waitFor();
      const mocked = await page.locator("body").innerText();
      await page.setContent('<p id="fixture">fixture</p>');
      return { mocked, fixture: await page.locator("#fixture").innerText() };
    `);
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(result.result, { mocked: "mocked", fixture: "fixture" });
  } finally {
    await bw.close();
    await server.close();
  }
});

test("returned Playwright objects cannot serialize host internals", opts, async () => {
  const variable = "BETTERWRIGHT_SERIALIZER_SENTINEL";
  const sentinel = `serializer-secret-${Date.now()}`;
  const previous = process.env[variable];
  process.env[variable] = sentinel;
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const contextResult = await bw.run("return context");
    assert.equal(contextResult.ok, true, contextResult.error);
    assert.deepEqual(contextResult.result, { type: "BrowserContext" });

    const locatorResult = await bw.run("return page.locator('body')");
    assert.equal(locatorResult.ok, true, locatorResult.error);
    assert.deepEqual(locatorResult.result, {
      type: "Locator",
      locator: "locator('body')",
    });

    const serialized = JSON.stringify([contextResult, locatorResult]);
    assert.ok(!serialized.includes(sentinel), serialized);
    assert.doesNotMatch(
      serialized,
      /_connection|_channel|newCDPSession|executablePath|process\.env/,
    );
  } finally {
    await bw.close();
    if (previous === undefined) delete process.env[variable];
    else process.env[variable] = previous;
  }
});

test("model navigation cannot open browser-internal control pages", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const chrome = await bw.run(
      "await page.goto('chrome://version'); return page.locator('body').innerText()",
    );
    assert.equal(chrome.ok, false);
    assert.match(chrome.error, /scheme is not available: chrome:/);
    assert.doesNotMatch(JSON.stringify(chrome), /remote-debugging|fingerprint=/i);

    const devtools = await bw.run(
      "await openPage('devtools://devtools/bundled/inspector.html'); return 'opened'",
    );
    assert.equal(devtools.ok, false);
    assert.match(devtools.error, /scheme is not available: devtools:/);
  } finally {
    await bw.close();
  }
});

test("an image-grid challenge is solvable with aria-ref tile clicks and Verify", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    // A synthetic reCAPTCHA-style grid: three "correct" tiles must be selected,
    // then Verify reveals success. Exercises the documented flow — snapshot for
    // refs, click tiles by aria-ref, click Verify — without touching a provider.
    const result = await bw.run(`
      await page.setContent(\`
        <div role="dialog" aria-label="Select all images with bicycles">
          <button aria-label="tile 0" data-correct="1"></button>
          <button aria-label="tile 1"></button>
          <button aria-label="tile 2" data-correct="1"></button>
          <button aria-label="tile 3"></button>
          <button aria-label="tile 4" data-correct="1"></button>
          <button id="verify">Verify</button>
          <p id="status" aria-live="polite">Unsolved</p>
        </div>
        <script>
          const chosen = new Set();
          for (const b of document.querySelectorAll('button[aria-label^="tile"]')) {
            b.addEventListener('click', () => { b.dataset.on = '1'; chosen.add(b); });
          }
          document.querySelector('#verify').addEventListener('click', () => {
            const correct = [...document.querySelectorAll('button[data-correct]')];
            const ok = correct.every(b => b.dataset.on === '1') &&
              [...chosen].every(b => b.dataset.correct === '1');
            document.querySelector('#status').textContent = ok ? 'Verified' : 'Try again';
          });
        </script>
      \`);
      const tree = await snapshot({interactive: true});
      const refFor = (label) =>
        (tree.match(new RegExp('"' + label + '" \\\\[ref=(e\\\\d+)\\\\]')) || [])[1];
      for (const label of ['tile 0', 'tile 2', 'tile 4']) {
        await human.click(page.locator('aria-ref=' + refFor(label)));
      }
      await human.click(page.locator('aria-ref=' + refFor('Verify')));
      return page.locator('#status').textContent();
    `);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.result, "Verified");
  } finally {
    await bw.close();
  }
});

// --- Named profiles: separate identities in one home -----------------------

test("two named profiles browse concurrently, both persistent", opts, async () => {
  const home = tempHome();
  const social = new BetterWright({ home, profile: "social", headless: true });
  const review = new BetterWright({ home, profile: "review", headless: true });
  try {
    const [a, b] = await Promise.all([
      social.run("await page.goto('about:blank'); return 'social'"),
      review.run("await page.goto('about:blank'); return 'review'"),
    ]);
    assert.equal(a.ok, true, a.error);
    assert.equal(b.ok, true, b.error);
    // Neither was pushed onto the signed-out ephemeral fallback.
    assert.equal(a.profileMode, "persistent");
    assert.equal(b.profileMode, "persistent");
    assert.ok(fs.existsSync(path.join(home, "browser", "profiles", "social")));
    assert.ok(fs.existsSync(path.join(home, "browser", "profiles", "review")));
    assert.equal(fs.existsSync(path.join(home, "browser", "profile")), false);
  } finally {
    await Promise.all([social.close(), review.close()]);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("cookies are per profile, and survive a restart of the same profile", opts, async () => {
  // The point of a named profile is a separate, *persistent* cookie jar. A
  // local server keeps this test offline and loopback-only.
  const server = await listen((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<title>jar</title><p>cookie jar</p>");
  });
  const { origin } = server;

  const home = tempHome();
  const social = new BetterWright({ home, profile: "social", headless: true });
  const review = new BetterWright({ home, profile: "review", headless: true });
  try {
    const set = await social.run(
      `await page.goto(${JSON.stringify(origin)}); ` +
        "await page.evaluate(() => { document.cookie = 'bw=social; path=/; max-age=3600'; }); " +
        "return page.evaluate(() => document.cookie)",
    );
    assert.equal(set.ok, true, set.error);
    assert.match(set.result, /bw=social/);

    const other = await review.run(
      `await page.goto(${JSON.stringify(origin)}); return page.evaluate(() => document.cookie)`,
    );
    assert.equal(other.ok, true, other.error);
    assert.doesNotMatch(other.result, /bw=social/, "the other profile must not see the cookie");

    // Reopen "social" after closing it: a named profile persists like the
    // default one, rather than being an ephemeral directory per launch.
    await social.close();
    const again = new BetterWright({ home, profile: "social", headless: true });
    try {
      const back = await again.run(
        `await page.goto(${JSON.stringify(origin)}); return page.evaluate(() => document.cookie)`,
      );
      assert.equal(back.ok, true, back.error);
      assert.match(back.result, /bw=social/, "the profile did not persist its cookie jar");
    } finally {
      await again.close();
    }
  } finally {
    await Promise.all([social.close(), review.close()]);
    await server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("Cookie Sync installs an HttpOnly cookie and persists it across restart", opts, async () => {
  const sentinel = `cookie-sync-${Date.now()}`;
  const rotatedPrefix = `cookie-rotated-${Date.now()}`;
  const rotatedValues: string[] = [];
  const server = await listen((request, response) => {
    const authenticated = String(request.headers.cookie || "")
      .split(/;\s*/)
      .includes(`bw_sync=${sentinel}`);
    let setCookie: string[] | undefined;
    if (request.url === "/") {
      const rotated = `${rotatedPrefix}-${rotatedValues.length + 1}`;
      rotatedValues.push(rotated);
      setCookie = [
        `bw_response=${sentinel}; HttpOnly; Path=/`,
        `bw_public=${rotated}; Path=/`,
      ];
    }
    if (setCookie) {
      response.writeHead(200, {
        "content-type": "text/plain",
        "set-cookie": setCookie,
      });
    } else {
      response.writeHead(200, { "content-type": "text/plain" });
    }
    response.end(authenticated ? "authenticated" : "signed out");
  });
  const home = tempHome();
  const options = {
    home,
    profile: "cookie-sync",
    headless: true,
    vault: false,
    policy: new NetworkPolicy({ allowLoopback: true }),
  };
  const browser = new BetterWright(options);
  browser._extractCookieSync = async () => ({
    cookies: [{
      name: "bw_sync",
      value: sentinel,
      domain: "127.0.0.1",
      path: "/",
      expires: Date.now() / 1000 + 3_600,
      httpOnly: true,
      secure: false,
      sameSite: "Lax",
      sourceScheme: "NonSecure",
      sourcePort: server.port,
    }, {
      name: "bw_public",
      value: sentinel,
      domain: "127.0.0.1",
      path: "/",
      expires: Date.now() / 1000 + 3_600,
      httpOnly: false,
      secure: false,
      sameSite: "Lax",
      sourceScheme: "NonSecure",
      sourcePort: server.port,
    }],
    selected: 2,
    skipped: 0,
    warnings: [],
    source: { browser: "fixture" },
  });
  try {
    const previousDebug = process.env.DEBUG;
    process.env.DEBUG = "pw:protocol";
    let synced;
    try {
      synced = await browser.syncCookies({
        source: { browser: "fixture" },
        domains: ["127.0.0.1"],
      });
    } finally {
      if (previousDebug === undefined) delete process.env.DEBUG;
      else process.env.DEBUG = previousDebug;
    }
    assert.equal(synced.ok, true, synced.error);
    assert.equal(synced.synced, 2);
    assert.equal(JSON.stringify(synced).includes(sentinel), false);
    assert.equal(browser._stderrTail.some((line) => line.includes(sentinel)), false);
    const first = await browser.run(
      `const requestPending = page.waitForRequest(${JSON.stringify(`${server.origin}/`)});
       const responsePending = page.waitForResponse(${JSON.stringify(`${server.origin}/`)});
       await page.goto(${JSON.stringify(server.origin)});
       const request = await requestPending;
       const response = await responsePending;
       return {
         body: await page.locator("body").innerText(),
         visibleCookie: await page.evaluate(() => document.cookie),
         requestMethods: ["allHeaders", "headersArray", "headerValue"].map((key) => typeof request[key]),
         responseMethods: ["allHeaders", "headersArray", "headerValue", "headerValues"].map((key) => typeof response[key]),
         filteredRequestHeaders: await request.headers(),
         filteredResponseHeaders: await response.headers(),
         postDataType: typeof request.postData,
       }`,
    );
    assert.equal(first.ok, true, first.error);
    assert.equal(first.result.body, "authenticated");
    assert.equal(JSON.stringify(first).includes(sentinel), false);
    assert.equal(JSON.stringify(first).includes(rotatedValues.at(-1)), false);
    assert.match(first.result.visibleCookie, /REDACTED_PASSWORD/);
    assert.deepEqual(first.result.requestMethods, Array(3).fill("undefined"));
    assert.deepEqual(first.result.responseMethods, Array(4).fill("undefined"));
    assert.equal(Object.hasOwn(first.result.filteredRequestHeaders, "cookie"), false);
    assert.equal(Object.hasOwn(first.result.filteredResponseHeaders, "set-cookie"), false);
    assert.equal(first.result.postDataType, "function");

    const failed = await browser.run(
      `await page.goto(${JSON.stringify(server.origin)});
       throw new Error(await page.evaluate(() => document.cookie));`,
    );
    assert.equal(failed.ok, false);
    assert.equal(JSON.stringify(failed).includes(rotatedValues.at(-1)), false);
    assert.match(failed.error, /REDACTED_PASSWORD/);

    await browser.close();
    const again = new BetterWright(options);
    try {
      const persisted = await again.run(
        `await page.goto(${JSON.stringify(server.origin)}); return {
          body: await page.locator("body").innerText(),
          visibleCookie: await page.evaluate(() => document.cookie),
        }`,
      );
      assert.equal(persisted.ok, true, persisted.error);
      assert.equal(persisted.result.body, "authenticated");
      assert.equal(JSON.stringify(persisted).includes(sentinel), false);
      assert.equal(JSON.stringify(persisted).includes(rotatedValues.at(-1)), false);
      assert.match(persisted.result.visibleCookie, /REDACTED_PASSWORD/);
    } finally {
      await again.close();
    }
  } finally {
    await browser.close();
    await server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("Cookie Sync refuses a batch that could evict target cookies", opts, async () => {
  const sentinel = `cookie-capacity-${Date.now()}`;
  const home = tempHome();
  const browser = new BetterWright({
    home,
    profile: "cookie-sync-capacity",
    headless: true,
    vault: false,
  });
  browser._extractCookieSync = async () => ({
    cookies: Array.from({ length: 151 }, (_, index) => ({
      name: `cookie_${index}`,
      value: `${sentinel}_${index}`,
      domain: `host-${index}.example.test`,
      path: "/",
      httpOnly: true,
      secure: true,
    })),
    selected: 151,
    skipped: 0,
    warnings: [],
    source: { browser: "fixture" },
  });
  try {
    const result = await browser.syncCookies({ source: { browser: "fixture" } });
    assert.equal(result.ok, false);
    assert.match(result.error, /exceed the target cookie capacity/);
    assert.equal(JSON.stringify(result).includes(sentinel), false);
  } finally {
    await browser.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("Cookie Sync refuses a local ephemeral target profile", opts, async () => {
  const home = tempHome();
  const options = { home, profile: "cookie-sync-lock", headless: true, vault: false };
  const owner = new BetterWright(options);
  const contender = new BetterWright(options);
  contender._extractCookieSync = async () => ({
    cookies: [{
      name: "session",
      value: "fixture-secret",
      domain: "example.test",
      path: "/",
      httpOnly: true,
      secure: true,
    }],
    selected: 1,
    skipped: 0,
    warnings: [],
    source: { browser: "fixture" },
  });
  try {
    const started = await owner.run("return true");
    assert.equal(started.ok, true, started.error);
    const temporary = await contender.run("return true");
    assert.equal(temporary.ok, true, temporary.error);
    assert.equal(temporary.profileMode, "ephemeral");
    const synced = await contender.syncCookies({ source: { browser: "fixture" } });
    assert.equal(synced.ok, false);
    assert.match(synced.error, /requires the selected BetterWright profile to be persistent/);
    assert.equal(JSON.stringify(synced).includes("fixture-secret"), false);
    await owner.close();
    const retried = await contender.syncCookies({ source: { browser: "fixture" } });
    assert.equal(retried.ok, true, retried.error);
    assert.equal(retried.profileMode, "persistent");
  } finally {
    await Promise.all([owner.close(), contender.close()]);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("Cookie Sync cannot reuse an in-flight ephemeral browser launch", opts, async () => {
  const home = tempHome();
  const options = { home, profile: "cookie-sync-launch-race", headless: true, vault: false };
  const owner = new BetterWright(options);
  const contender = new BetterWright(options);
  const cookie = {
    name: "session",
    value: "fixture-race-secret",
    domain: "example.test",
    path: "/",
    httpOnly: true,
    secure: true,
  };
  try {
    const started = await owner.run("return true");
    assert.equal(started.ok, true, started.error);
    const config = await contender._prepare();
    const liveView = contender._dispatch(
      { type: "live_view_start", config, options: {} },
      30,
    );
    const sync = contender._dispatch(
      {
        type: "cookie_sync",
        config,
        cookies: [cookie],
        source: { browser: "fixture" },
        selected: 1,
        skipped: 0,
        warnings: [],
      },
      30,
    );
    const [liveResult, result] = await Promise.all([liveView, sync]);
    assert.equal(liveResult.ok, true, liveResult.error);
    assert.equal(result.ok, false);
    assert.match(result.error, /requires the selected BetterWright profile to be persistent/);
    assert.equal(JSON.stringify(result).includes(cookie.value), false);
    const liveStatus = await contender._dispatch({ type: "live_view_status" }, 30);
    assert.equal(liveStatus.ok, true, liveStatus.error);
    assert.equal(liveStatus.running, true);

    await owner.close();
    const retried = await contender._dispatch(
      {
        type: "cookie_sync",
        config,
        cookies: [cookie],
        source: { browser: "fixture" },
        selected: 1,
        skipped: 0,
        warnings: [],
      },
      30,
    );
    assert.equal(retried.ok, true, retried.error);
    assert.equal(retried.profileMode, "persistent");
  } finally {
    await Promise.all([owner.close(), contender.close()]);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a second browser on the SAME profile falls back to ephemeral", opts, async () => {
  const home = tempHome();
  const first = new BetterWright({ home, profile: "social", headless: true });
  const second = new BetterWright({ home, profile: "social", headless: true });
  try {
    const a = await first.run("return 'first'");
    assert.equal(a.ok, true, a.error);
    assert.equal(a.profileMode, "persistent");
    const b = await second.run("return 'second'");
    assert.equal(b.ok, true, b.error);
    assert.equal(b.profileMode, "ephemeral");
  } finally {
    await Promise.all([first.close(), second.close()]);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("recording and live view keep independent capture lifetimes", recordingOpts, async () => {
  const bw = new BetterWright({
    home: tempHome(), headless: true, vault: false,
    liveView: { enabled: false, host: "127.0.0.1", port: 0 },
  });
  let viewer: WebSocket | undefined;
  try {
    const loaded = await bw.run(`
      await page.setContent('<canvas width="640" height="360"></canvas>');
      await page.evaluate(() => {
        const ctx = document.querySelector('canvas').getContext('2d');
        let frame = 0;
        function draw() {
          ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 640, 360);
          ctx.fillStyle = 'blue'; ctx.fillRect(frame++ % 600, 30, 40, 100);
          requestAnimationFrame(draw);
        }
        draw();
      });
    `);
    assert.equal(loaded.ok, true, loaded.error);
    for (const first of ["view", "recording"]) {
      let viewerFrames = 0;
      const openView = async () => {
        const info = await bw.startLiveView({ host: "127.0.0.1", port: 0 });
        assert.equal(info.ok, true, info.error);
        const url = new URL(info.url);
        viewer = new WebSocket(`ws://${url.host}/ws?t=${info.token}`);
        viewer.binaryType = "arraybuffer";
        viewer.addEventListener("message", (event) => {
          if (!isString(event.data)) viewerFrames += 1;
        });
        await once(viewer, "open");
      };
      const start = async () => {
        const result = await bw.run("return recording.start({maxWidth:640,maxHeight:360})");
        assert.equal(result.ok, true, result.error);
      };
      if (first === "view") { await openView(); await start(); }
      else { await start(); await openView(); }
      await new Promise(resolve => setTimeout(resolve, 500));
      const active = await bw.run("return recording.status()");
      assert.equal(active.ok, true, active.error);
      assert.ok(active.result.capturedFrames > 5);
      assert.ok(viewerFrames > 5);
      if (first === "view") {
        const stopped = await bw.run("return recording.stop()");
        assert.equal(stopped.result.state, "completed", JSON.stringify(stopped));
        const before = viewerFrames;
        await new Promise(resolve => setTimeout(resolve, 300));
        assert.ok(viewerFrames > before, "live view continues after recording stops");
        viewer.close();
        await bw.stopLiveView();
      } else {
        viewer.close();
        await bw.stopLiveView();
        await new Promise(resolve => setTimeout(resolve, 300));
        const stopped = await bw.run("return recording.stop()");
        assert.equal(stopped.result.state, "completed", JSON.stringify(stopped));
        assert.ok(stopped.result.capturedFrames > active.result.capturedFrames,
          "recording continues after live view stops");
      }
    }
  } finally {
    viewer?.close();
    await bw.close();
  }
});

test("failed recording startup does not prevent concurrent tab closure", recordingOpts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true, vault: false });
  try {
    for (const close of ["page.close()", "closePage()"] ) {
      const result = await bw.run(`
        const target = page;
        const results = await Promise.allSettled([recording.start({fps:0}), ${close}]);
        return { results: results.map(result => result.status), closed: target.isClosed(), status: await recording.status() };
      `);
      assert.equal(result.ok, true, result.error);
      assert.deepEqual(result.result.results, ["rejected", "fulfilled"]);
      assert.equal(result.result.closed, true);
      assert.equal(result.result.status.state, "idle");
    }
  } finally {
    await bw.close();
  }
});

test("MCP recording selects MP4 by default and preserves explicit WebM artifacts", recordingOpts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true, vault: false });
  const handlers = _createMcpHandlersForTest({ browser: bw, downloadPolicy: "deny" });
  try {
    const ready = await bw.run("await page.setContent('<h1>Recording format</h1>')");
    assert.equal(ready.ok, true, ready.error);
    for (const [name, extension, mimeType] of [[undefined, "mp4", "video/mp4"], ["explicit.webm", "webm", "video/webm"]]) {
      const start = await handlers.callTool({ params: {
        name: "browser_record", arguments: { action: "start", name, maxWidth: 320, maxHeight: 180 },
      } });
      const started = JSON.parse(start.content[0].text);
      assert.equal(started.ok, true, started.error);
      assert.ok(started.result.path.endsWith(`.${extension}`));
      const stop = await handlers.callTool({ params: { name: "browser_record", arguments: { action: "stop" } } });
      const stopped = JSON.parse(stop.content[0].text);
      assert.equal(stopped.result.state, "completed", JSON.stringify(stopped));
      const artifact = stopped.files.find(file => file.path === started.result.path);
      assert.equal(artifact.mimeType, mimeType);
      const decoded = spawnSync(encoder, ["-v", "error", "-i", artifact.path, "-f", "null", "-"], { encoding: "utf8", timeout: 10_000 });
      assert.equal(decoded.status, 0, decoded.stderr);
    }
  } finally {
    await bw.close();
  }
});
