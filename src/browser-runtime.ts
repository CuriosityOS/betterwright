// Browser runtime helpers: profile version compatibility, the Linux
// render-device probe, and the managed fork's launch arguments.

import fs from "node:fs";
import path from "node:path";

function versionMajor(value) {
  return Number.parseInt(String(value || "").split(".")[0], 10);
}

function storedProfileVersion(profileDir, readFileSync = fs.readFileSync) {
  try {
    return readFileSync(path.join(profileDir, "Last Version"), "utf8").trim();
  } catch {
    return null;
  }
}

/**
 * Guard against opening a profile that a newer Chromium already upgraded.
 * Chromium records its version in a "Last Version" file and does not downgrade
 * the profile format; an older binary that opens a newer profile crashes during
 * startup (on macOS the crash surfaces deep in the AppKit window/session-restore
 * path as an opaque SIGTRAP). A caller-supplied provider binary can ship an
 * older Chromium than the managed fork, so this turns that latent crash into a
 * clear, actionable error. `runningVersion` is a dotted version like
 * "151.0.7922.108"; a missing or unparseable version, or a fresh profile, is a
 * no-op.
 */
export function assertProfileNotNewer(profileDir, runningVersion) {
  const runningMajor = versionMajor(runningVersion);
  if (!Number.isFinite(runningMajor)) return;
  const stored = storedProfileVersion(profileDir);
  if (!stored) return; /* fresh profile, or Chromium has not written the marker yet */
  const profileMajor = versionMajor(stored);
  if (Number.isFinite(profileMajor) && profileMajor > runningMajor) {
    throw new Error(
      `Browser profile at ${profileDir} was upgraded by a newer Chromium ` +
        `(${stored}) than the one launching now (${runningVersion}); a newer ` +
        "profile cannot be opened by an older browser. This usually means the " +
        "profile was created by another Chromium build — fix it with " +
        `\`rm -rf ${profileDir}\` and sign in again (logins saved in that ` +
        "profile are lost; vault credentials are not), or point " +
        "BETTERWRIGHT_HOME at a separate directory.",
    );
  }
}

/**
 * Keep a lower-version browser away from a profile upgraded by newer Chromium.
 * The original profile is preserved in place; the stable nested path gives the
 * older browser persistence across restarts.
 */
export function compatibleBrowserProfile(profileDir, runningVersion, {
  readFileSync = fs.readFileSync,
} = {}) {
  const runningMajor = versionMajor(runningVersion);
  const stored = storedProfileVersion(profileDir, readFileSync);
  const profileMajor = versionMajor(stored);
  if (
    !Number.isFinite(runningMajor) ||
    !Number.isFinite(profileMajor) ||
    profileMajor <= runningMajor
  ) {
    return { profileDir, warning: null };
  }
  const isolated = path.join(
    profileDir,
    `.betterwright-compat-chromium-${runningMajor}`,
  );
  return {
    profileDir: isolated,
    warning:
      `The existing browser profile was upgraded by Chromium ${stored}; ` +
      `the Chromium ${runningVersion} browser is using ${isolated} ` +
      "instead. The original profile and its logins were preserved.",
  };
}

/** Whether Linux lacks an accessible hardware-rendering device. */
export function chromiumNeedsSoftwareGpu({
  platform = process.platform,
  readdirSync = fs.readdirSync,
  accessSync = fs.accessSync,
} = {}) {
  if (platform !== "linux") return false;
  let devices = [];
  try {
    devices = readdirSync("/dev/dri")
      .filter((name) => /^(?:renderD|card)\d+$/.test(name))
      .map((name) => path.join("/dev/dri", name));
  } catch {
    return true;
  }
  for (const device of devices) {
    try {
      accessSync(device, fs.constants.R_OK | fs.constants.W_OK);
      return false;
    } catch {
      /* try the next DRI device */
    }
  }
  return true;
}

/** Managed fork arguments: guarded WebRTC and a stable fingerprint seed. */
export function managedForkArgs(fingerprintSeed, { softwareGpu = false } = {}) {
  return [
    // WebRTC is not represented by Playwright request routing and can
    // otherwise send STUN/data-channel UDP directly around the TCP-only guard
    // proxy, leaking the host's real IP past any residential/egress upstream.
    // Force it onto the proxied TCP path instead — the same
    // disable_non_proxied_udp policy every anti-detect browser and cloud
    // browser (Browserbase, Kernel, Multilogin) applies for leak prevention.
    "--webrtc-ip-handling-policy=disable_non_proxied_udp",
    // Chromium 151 otherwise keeps a spare renderer resident beside the page
    // and Top Chrome WebUI renderers. Two is a soft ceiling: Chromium still
    // creates site-isolated renderers when security requires them, but it does
    // not retain an unused ~120 MiB process for a workload that already has a
    // warm persistent browser.
    "--renderer-process-limit=2",
    // GPU-less Linux needs an explicit WebGL fallback. Keep SwiftShader
    // scoped to WebGL instead of making it the general OpenGL ES driver.
    ...(softwareGpu
      ? [
          "--use-gl=angle",
          "--use-angle=swiftshader-webgl",
          "--enable-unsafe-swiftshader",
        ]
      : // On a host WITH a GPU, the opposite risk applies: a headless launch
        // (Playwright's default for the browser worker) appends
        // --use-angle=swiftshader-webgl on its own, which forces software GL
        // even when hardware is present. That trips the fork's integrated-GPU
        // spoof, and the resulting "Intel UHD 620" string contradicts the
        // UA's desktop hardware — exactly the cross-signal inconsistency
        // PixelScan flags as "Masking detected". Bind the real GL backend so
        // the software default never wins and the genuine GPU is reported.
        // mergeChromiumArgs drops a same-name caller switch rather than
        // letting it override, so a host that passes its own --use-angle gets
        // this managed value and a chromiumArgs warning naming the dropped
        // switch.
        ["--use-gl=angle", "--use-angle=gl"]),
    ...(fingerprintSeed ? [`--fingerprint=${fingerprintSeed}`] : []),
  ];
}
