import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { normalizeRecordingOptions, startRecording } from "../../dist/src/recording.js";

const encoderAvailable = spawnSync("ffmpeg", ["-version"]).status === 0;
const probeAvailable = spawnSync("ffprobe", ["-version"]).status === 0;
const encoderOpts = { skip: !encoderAvailable && "System FFmpeg is not installed." };
const fixture = encoderAvailable ? execFileSync("ffmpeg", [
  "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=64x48",
  "-frames:v", "1", "-f", "image2pipe", "-c:v", "mjpeg", "pipe:1",
]) : Buffer.alloc(0);
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const options = { maxWidth: 64, maxHeight: 48, fps: 60, maxDurationMs: 10_000 };

class FakeCdp extends EventEmitter {
  calls: string[] = [];
  detached = 0;
  startError = "";
  async send(method, _params?) {
    this.calls.push(method);
    if (method === "Page.startScreencast") {
      if (this.startError) throw new Error(this.startError);
      this.frame();
    }
    return {};
  }
  frame(data = fixture.toString("base64"), timestamp = Date.now() / 1000) {
    this.emit("Page.screencastFrame", { data, sessionId: 1, metadata: { timestamp } });
  }
  async detach() { this.detached++; this.emit("close"); }
}

function location(t, extension = "mp4") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bw-recording-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, `capture.${extension}`);
}

function decodeFrames(output: string, frameSize: number, expectedFrames: number) {
  return execFileSync("ffmpeg", ["-v", "error", "-i", output, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], {
    maxBuffer: (expectedFrames + 1) * frameSize,
  });
}

test("recording options have bounded integer dimensions and cadence", () => {
  assert.deepEqual(normalizeRecordingOptions(), {
    fps: 60, maxWidth: 1280, maxHeight: 720, quality: 80, maxDurationMs: 300_000,
  });
  assert.equal(normalizeRecordingOptions({ maxWidth: 641 }).maxWidth, 640);
  for (const invalid of [
    { fps: 0 }, { fps: 61 }, { fps: 1.5 }, { fps: NaN }, { maxWidth: 1 },
    { maxHeight: 4097 }, { maxWidth: 4096, maxHeight: 4096 },
    { quality: 0 }, { quality: 101 }, { maxDurationMs: 0 }, { maxDurationMs: Infinity },
  ]) assert.throws(() => normalizeRecordingOptions(invalid));
  for (const invalid of [null, [], "invalid", 42]) {
    assert.throws(() => normalizeRecordingOptions(invalid), /must be an object/);
  }
});

test("a static frame records real elapsed time and stop is idempotent", encoderOpts, async t => {
  const output = location(t);
  const cdp = new FakeCdp();
  const notifications = [];
  const recording = await startRecording({ cdp, path: output, options, maxBytes: 1_000_000, onStop: status => notifications.push(status) });
  assert.equal(recording.status().state, "recording");
  assert.equal(fs.statSync(output).mode & 0o777, 0o600);
  await delay(180);
  const first = recording.stop();
  assert.equal(recording.stop(), first);
  const stopped = await first;
  assert.equal(stopped.state, "completed", JSON.stringify(stopped));
  assert.equal(stopped.capturedFrames, 1);
  assert.ok(stopped.outputFrames >= 10, JSON.stringify(stopped));
  assert.ok(Math.abs(stopped.outputFrames / 60 * 1000 - stopped.durationMs) <= 20);
  assert.equal(stopped.bytes, fs.statSync(output).size);
  assert.equal(cdp.detached, 1);
  assert.equal(cdp.listenerCount("Page.screencastFrame"), 0);
  assert.equal(cdp.listenerCount("close"), 0);
  assert.equal(notifications.length, 1);
  assert.deepEqual(recording.status(), stopped);
  if (!probeAvailable) return;
  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-count_frames", "-show_entries", "stream=codec_name,r_frame_rate,nb_read_frames", "-of", "json", output], { encoding: "utf8" }));
  assert.equal(probe.streams[0].codec_name, "h264");
  assert.equal(probe.streams[0].r_frame_rate, "60/1");
  assert.equal(Number(probe.streams[0].nb_read_frames), stopped.outputFrames);
});

test("recording writes encoded video while capture remains active", encoderOpts, async t => {
  const output = location(t);
  const recording = await startRecording({ cdp: new FakeCdp(), path: output, options, maxBytes: 1_000_000 });
  t.after(() => recording.stop());
  const deadline = performance.now() + 1500;
  while (!fs.statSync(output).size && performance.now() < deadline) await delay(20);
  assert.equal(recording.status().state, "recording");
  assert.ok(fs.statSync(output).size > 0, "Encoder must produce output before capture stops.");
  assert.equal((await recording.stop()).state, "completed");
});

test("recording stops automatically at its duration limit", encoderOpts, async t => {
  const output = location(t);
  const cdp = new FakeCdp();
  let terminal;
  const done = new Promise(resolve => { terminal = resolve; });
  const recording = await startRecording({ cdp, path: output, options: { ...options, maxDurationMs: 80 }, maxBytes: 1_000_000, onStop: terminal });
  const stopped: any = await done;
  assert.equal(stopped.state, "completed", JSON.stringify(stopped));
  assert.ok(stopped.durationMs >= 60 && stopped.durationMs < 1000);
  assert.deepEqual(await recording.stop(), stopped);
  assert.equal(cdp.detached, 1);
});

test("output byte ceiling fails explicitly and removes the partial file", encoderOpts, async t => {
  const output = location(t);
  const cdp = new FakeCdp();
  const recording = await startRecording({ cdp, path: output, options, maxBytes: 16 });
  await delay(50);
  const result = await recording.stop();
  assert.equal(result.state, "failed");
  assert.match(result.error, /16-byte limit/);
  assert.ok(result.bytes <= 16);
  assert.equal(fs.existsSync(output), false);
  assert.equal(cdp.detached, 1);
});

test("a burst of browser frames keeps a latest slot and counts discarded source frames", encoderOpts, async t => {
  const output = location(t);
  const cdp = new FakeCdp();
  const recording = await startRecording({ cdp, path: output, options, maxBytes: 1_000_000 });
  for (let i = 0; i < 1000; i++) cdp.frame();
  await delay(35);
  const result = await recording.stop();
  assert.equal(result.state, "completed", JSON.stringify(result));
  assert.equal(result.capturedFrames, 1001);
  assert.ok(result.droppedFrames >= 999);
  assert.ok(result.outputFrames < 20);
});

test("CDP closure stops encoding without closing the browser", encoderOpts, async t => {
  const output = location(t);
  const cdp = new FakeCdp();
  const recording = await startRecording({ cdp, path: output, options, maxBytes: 1_000_000 });
  cdp.emit("close");
  const result = await recording.stop();
  assert.equal(result.state, "failed");
  assert.match(result.error, /page or CDP session closed/);
  assert.equal(cdp.detached, 1);
  assert.equal(fs.existsSync(output), false);
});

test("invalid start options detach the recording session without creating a file", async t => {
  const output = location(t);
  const cdp = new FakeCdp();
  await assert.rejects(startRecording({ cdp, path: output, options: { fps: 90 }, maxBytes: 1000 }), /fps/);
  assert.equal(cdp.detached, 1);
  assert.equal(fs.existsSync(output), false);
});

test("a preexisting output path is preserved", async t => {
  const output = location(t);
  fs.writeFileSync(output, "existing");
  const cdp = new FakeCdp();
  await assert.rejects(startRecording({ cdp, path: output, options, maxBytes: 1000 }), /EEXIST/);
  assert.equal(fs.readFileSync(output, "utf8"), "existing");
  assert.equal(cdp.detached, 1);
});

test("a capture startup error cleans up encoder and file", encoderOpts, async t => {
  const output = location(t);
  const cdp = new FakeCdp();
  cdp.startError = "capture unavailable";
  await assert.rejects(startRecording({ cdp, path: output, options, maxBytes: 1000 }), /capture unavailable/);
  assert.equal(cdp.detached, 1);
  assert.equal(fs.existsSync(output), false);
});

test("missing FFmpeg returns setup guidance without leaving a partial file", async t => {
  const output = location(t);
  const previous = process.env.BETTERWRIGHT_FFMPEG_PATH;
  process.env.BETTERWRIGHT_FFMPEG_PATH = path.join(path.dirname(output), "missing-ffmpeg");
  t.after(() => {
    if (previous === undefined) delete process.env.BETTERWRIGHT_FFMPEG_PATH;
    else process.env.BETTERWRIGHT_FFMPEG_PATH = previous;
  });
  const cdp = new FakeCdp();
  try {
    const recording = await startRecording({ cdp, path: output, options, maxBytes: 1000 });
    const result = await recording.stop();
    assert.equal(result.state, "failed");
    assert.match(result.error, /Install FFmpeg|BETTERWRIGHT_FFMPEG_PATH/);
  } catch (error) {
    assert.match(error.message, /Install FFmpeg|BETTERWRIGHT_FFMPEG_PATH/);
  }
  assert.equal(cdp.detached, 1);
  assert.equal(fs.existsSync(output), false);
});

test("slow encoder input and delayed timers preserve elapsed duration with bounded source frames", {
  skip: !encoderAvailable || process.platform === "win32",
}, async t => {
  const output = location(t);
  const wrapper = path.join(path.dirname(output), "slow-encoder.cjs");
  const executable = execFileSync("which", ["ffmpeg"], { encoding: "utf8" }).trim();
  fs.writeFileSync(wrapper, `#!${process.execPath}\nconst {spawn}=require('node:child_process');\nconst child=spawn(${JSON.stringify(executable)},process.argv.slice(2));\nsetTimeout(()=>process.stdin.pipe(child.stdin),250);\nchild.stdout.pipe(process.stdout);\nchild.stderr.pipe(process.stderr);\nchild.on('close',code=>{process.exitCode=code});\n`, { mode: 0o700 });
  const previous = process.env.BETTERWRIGHT_FFMPEG_PATH;
  process.env.BETTERWRIGHT_FFMPEG_PATH = wrapper;
  t.after(() => {
    if (previous === undefined) delete process.env.BETTERWRIGHT_FFMPEG_PATH;
    else process.env.BETTERWRIGHT_FFMPEG_PATH = previous;
  });
  const comment = Buffer.concat([Buffer.from([255, 254, 234, 98]), Buffer.alloc(60_000, 65)]);
  const large = Buffer.concat([fixture.subarray(0, 2), ...Array.from({ length: 16 }, () => comment), fixture.subarray(2)]).toString("base64");
  const cdp = new FakeCdp();
  const recording = await startRecording({ cdp, path: output, options, maxBytes: 1_000_000 });
  cdp.frame(large);
  await delay(30);
  // A synthetic burst shares a capture time even when decoding its payloads
  // takes multiple output-frame intervals on a busy runner.
  const burstTimestamp = Date.now() / 1000;
  for (let i = 0; i < 20; i++) cdp.frame(large, burstTimestamp);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
  await delay(70);
  const result = await recording.stop();
  assert.equal(result.state, "completed", JSON.stringify(result));
  assert.equal(result.capturedFrames, 22);
  assert.ok(result.droppedFrames >= 19 && result.droppedFrames < result.capturedFrames, JSON.stringify(result));
  assert.ok(result.durationMs >= 400, JSON.stringify(result));
  assert.ok(result.outputFrames >= 6, JSON.stringify(result));
  assert.ok(Math.abs(result.outputFrames / options.fps * 1000 - result.durationMs) <= 1000 / options.fps, JSON.stringify(result));
});

test("oversized source frames fail before decoding an unbounded payload", encoderOpts, async t => {
  const output = location(t);
  const cdp = new FakeCdp();
  const recording = await startRecording({ cdp, path: output, options, maxBytes: 1_000_000 });
  cdp.frame("A".repeat(12 * 1024 * 1024));
  const result = await recording.stop();
  assert.equal(result.state, "failed");
  assert.match(result.error, /frame exceeds/);
  assert.equal(fs.existsSync(output), false);
});

test("a stalled encoder is killed at the stop deadline", {
  skip: process.platform === "win32",
}, async t => {
  const output = location(t);
  const wrapper = path.join(path.dirname(output), "stalled-encoder.cjs");
  const pidFile = path.join(path.dirname(output), "encoder.pid");
  fs.writeFileSync(wrapper, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));\nsetInterval(()=>{},1000);\n`, { mode: 0o700 });
  const previous = process.env.BETTERWRIGHT_FFMPEG_PATH;
  process.env.BETTERWRIGHT_FFMPEG_PATH = wrapper;
  t.after(() => {
    if (previous === undefined) delete process.env.BETTERWRIGHT_FFMPEG_PATH;
    else process.env.BETTERWRIGHT_FFMPEG_PATH = previous;
  });
  const cdp = new FakeCdp();
  if (!encoderAvailable) cdp.frame = function () {
    this.emit("Page.screencastFrame", { data: Buffer.from([255, 216, 255, 217]).toString("base64"), sessionId: 1, metadata: {} });
  };
  const recording = await startRecording({ cdp, path: output, options, maxBytes: 1_000_000 });
  await delay(40);
  const before = performance.now();
  const result = await recording.stop();
  assert.equal(result.state, "failed");
  assert.match(result.error, /encoder stop timed out/);
  assert.ok(performance.now() - before < 12_000);
  assert.equal(cdp.detached, 1);
  assert.equal(fs.existsSync(output), false);
  const pid = Number(fs.readFileSync(pidFile, "utf8"));
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
});

test("viewport resize keeps a fixed recording canvas without upscaling page pixels", encoderOpts, async t => {
  const output = location(t);
  const cdp = new FakeCdp();
  const recording = await startRecording({ cdp, path: output, options: { ...options, maxWidth: 128, maxHeight: 96 }, maxBytes: 1_000_000 });
  await delay(600);
  const smaller = execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=green:s=32x24", "-frames:v", "1", "-f", "image2pipe", "-c:v", "mjpeg", "pipe:1"]);
  cdp.frame(smaller.toString("base64"));
  await delay(100);
  const result = await recording.stop();
  assert.equal(result.state, "completed", JSON.stringify(result));
  const frameSize = 128 * 96 * 3;
  const pixels = decodeFrames(output, frameSize, result.outputFrames);
  assert.ok(pixels.length > 1024 * 1024);
  assert.equal(pixels.length / frameSize, result.outputFrames);
  const last = pixels.subarray(-frameSize);
  const center = (48 * 128 + 64) * 3;
  assert.ok(last[center + 1] > 80 && last[center] < 20 && last[center + 2] < 20);
  const margin = (30 * 128 + 40) * 3;
  assert.ok(last[margin] < 10 && last[margin + 1] < 10 && last[margin + 2] < 10);
});

test("an explicit WebM path retains VP8 recording", encoderOpts, async t => {
  const output = location(t, "webm");
  const recording = await startRecording({ cdp: new FakeCdp(), path: output, options, maxBytes: 1_000_000 });
  await delay(120);
  const stopped = await recording.stop();
  assert.equal(stopped.state, "completed", JSON.stringify(stopped));
  assert.equal(fs.readFileSync(output).readUInt32BE(0), 0x1a45dfa3);
  const decoded = decodeFrames(output, 64 * 48 * 3, stopped.outputFrames);
  assert.equal(decoded.length, stopped.outputFrames * 64 * 48 * 3);
  if (probeAvailable) {
    const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name", "-of", "json", output], { encoding: "utf8" }));
    assert.equal(probe.streams[0].codec_name, "vp8");
  }
});

test("MP4 writes complete media fragments before recording stops", encoderOpts, async t => {
  const output = location(t);
  const recording = await startRecording({ cdp: new FakeCdp(), path: output, options, maxBytes: 1_000_000 });
  t.after(() => recording.stop());
  const boxTypes = () => {
    const bytes = fs.readFileSync(output);
    const types: string[] = [];
    for (let offset = 0; offset + 8 <= bytes.length;) {
      const size = bytes.readUInt32BE(offset);
      if (size < 8 || offset + size > bytes.length) break;
      types.push(bytes.toString("ascii", offset + 4, offset + 8));
      offset += size;
    }
    return types;
  };
  const deadline = performance.now() + 2500;
  let boxes = boxTypes();
  while (!boxes.includes("mdat") && performance.now() < deadline) {
    await delay(20);
    boxes = boxTypes();
  }
  assert.equal(recording.status().state, "recording");
  for (const type of ["ftyp", "moov", "moof", "mdat"]) assert.ok(boxes.includes(type), `${type} missing while recording`);
  const stopped = await recording.stop();
  assert.equal(stopped.state, "completed", JSON.stringify(stopped));
  const pixels = decodeFrames(output, 64 * 48 * 3, stopped.outputFrames);
  assert.equal(pixels.length, stopped.outputFrames * 64 * 48 * 3);
});
