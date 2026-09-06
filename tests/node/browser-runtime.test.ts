import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  assertProfileNotNewer,
  chromiumNeedsSoftwareGpu,
  compatibleBrowserProfile,
  managedForkArgs,
} from "../../dist/src/browser-runtime.js";
import { makeTempDir } from "./helpers/temp-dir.js";

test("assertProfileNotNewer rejects a profile upgraded by a newer Chromium", () => {
  const dir = makeTempDir("betterwright-profver-");
  try {
    // Fresh profile (no marker): no-op regardless of running version.
    assert.doesNotThrow(() => assertProfileNotNewer(dir, "145.0.7632.109"));

    fs.writeFileSync(path.join(dir, "Last Version"), "149.0.7827.55\n");
    // Older binary opening a newer profile is the crash we prevent.
    assert.throws(
      () => assertProfileNotNewer(dir, "145.0.7632.109"),
      /upgraded by a newer Chromium \(149\.0\.7827\.55\)/,
    );
    // The message names the exact recovery — this is the one error a
    // first-time user most often hits after switching browsers, and "reset
    // the profile" is useless without the path.
    assert.throws(
      () => assertProfileNotNewer(dir, "145.0.7632.109"),
      (error: any) =>
        error.message.includes(`rm -rf ${dir}`) &&
        /another Chromium build/.test(error.message) &&
        /BETTERWRIGHT_HOME/.test(error.message),
    );
    // Same or newer binary is fine.
    assert.doesNotThrow(() => assertProfileNotNewer(dir, "149.0.7827.55"));
    assert.doesNotThrow(() => assertProfileNotNewer(dir, "150.0.0.0"));
    // Unknown running version is a no-op (cannot compare safely).
    assert.doesNotThrow(() => assertProfileNotNewer(dir, ""));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("compatibleBrowserProfile isolates a newer profile for an older browser", () => {
  const dir = makeTempDir("betterwright-compat-prof-");
  try {
    fs.writeFileSync(path.join(dir, "Last Version"), "152.0.0.0\n");
    const result = compatibleBrowserProfile(dir, "151.0.0.0");
    assert.equal(
      result.profileDir,
      path.join(dir, ".betterwright-compat-chromium-151"),
    );
    assert.match(result.warning, /Chromium 152\.0\.0\.0/);
    assert.match(result.warning, /preserved/);
    // Same or older profile: use it as-is.
    assert.deepEqual(compatibleBrowserProfile(dir, "152.0.0.0"), {
      profileDir: dir,
      warning: null,
    });
    // Unknown versions: no-op.
    assert.deepEqual(compatibleBrowserProfile(dir, ""), {
      profileDir: dir,
      warning: null,
    });
    const fresh = makeTempDir("betterwright-compat-fresh-");
    try {
      assert.deepEqual(compatibleBrowserProfile(fresh, "151.0.0.0"), {
        profileDir: fresh,
        warning: null,
      });
    } finally {
      fs.rmSync(fresh, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("chromiumNeedsSoftwareGpu probes only Linux render devices", () => {
  assert.equal(
    chromiumNeedsSoftwareGpu({ platform: "darwin" }),
    false,
  );
  assert.equal(
    chromiumNeedsSoftwareGpu({
      platform: "linux",
      readdirSync: () => ["renderD128"],
      accessSync: () => {},
    }),
    false,
  );
  assert.equal(
    chromiumNeedsSoftwareGpu({
      platform: "linux",
      readdirSync: () => {
        throw new Error("ENOENT");
      },
    }),
    true,
  );
  assert.equal(
    chromiumNeedsSoftwareGpu({
      platform: "linux",
      readdirSync: () => ["renderD128"],
      accessSync: () => {
        throw new Error("EACCES");
      },
    }),
    true,
  );
});

test("managed fork args pin WebRTC to the proxy and the profile seed", () => {
  const args = managedForkArgs("12345");
  assert.ok(args.includes("--webrtc-ip-handling-policy=disable_non_proxied_udp"));
  assert.ok(args.includes("--fingerprint=12345"));
  assert.ok(args.includes("--renderer-process-limit=2"));
  // A null/empty seed withholds the --fingerprint switch entirely, which is how
  // the fingerprintNoise:false path turns the fork's farbling off.
  assert.deepEqual(managedForkArgs(""), [
    "--webrtc-ip-handling-policy=disable_non_proxied_udp",
    "--renderer-process-limit=2",
    "--use-gl=angle",
    "--use-angle=gl",
  ]);
});

test("GPU-less Linux binds the SwiftShader WebGL fallback", () => {
  assert.deepEqual(managedForkArgs("seed", { softwareGpu: true }), [
    "--webrtc-ip-handling-policy=disable_non_proxied_udp",
    "--renderer-process-limit=2",
    "--use-gl=angle",
    "--use-angle=swiftshader-webgl",
    "--enable-unsafe-swiftshader",
    "--fingerprint=seed",
  ]);
  // A GPU host binds the hardware GL backend instead, so a headless launch's
  // implicit --use-angle=swiftshader-webgl never wins and forces software GL.
  const gpuArgs = managedForkArgs("seed");
  assert.ok(!gpuArgs.includes("--use-angle=swiftshader"));
  assert.ok(gpuArgs.includes("--use-angle=gl"));
});
