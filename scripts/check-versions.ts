#!/usr/bin/env bun

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { UntrustedValue } from "../types/untrusted-value.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");
const pkg = JSON.parse(read("package.json"));
const lock = parseBunLock(read("bun.lock"));
const lockWorkspace = lock.workspaces?.[""] || {};
const failures = [];

function parseBunLock(text) {
  return JSON.parse(text.replace(/,(\s*[}\]])/g, "$1"));
}

function expectMatch(label, text, expression, expected) {
  const actual = text.match(expression)?.[1];
  if (actual !== expected) failures.push(`${label}: expected ${expected}, found ${actual ?? "nothing"}`);
}

function isString(value: UntrustedValue): value is string {
  return typeof value === "string";
}

function lockPackageVersion(name) {
  const entry = lock.packages?.[name];
  if (!Array.isArray(entry)) return null;
  const spec = entry[0];
  if (!isString(spec)) return null;
  const at = spec.lastIndexOf("@");
  return at === -1 ? spec : spec.slice(at + 1);
}

if (lockWorkspace.dependencies?.["playwright-core"] !== pkg.dependencies["playwright-core"]) {
  failures.push("bun.lock playwright-core pin does not match package.json");
}
if (lockWorkspace.dependencies?.tldts !== pkg.dependencies.tldts) {
  failures.push("bun.lock tldts pin does not match package.json");
}

for (const dependency of ["playwright-core", "tldts", "@ghostery/adblocker-playwright"]) {
  if (lockPackageVersion(dependency) !== pkg.dependencies[dependency]) {
    failures.push(`bun.lock ${dependency} resolved version must be ${pkg.dependencies[dependency]}`);
  }
}

expectMatch(
  "Ad blocker cache format pin",
  read("src/ad-blocker.ts"),
  /AD_BLOCK_CACHE_FILE = "ad-blocker-([^"]+)\.bin"/,
  pkg.dependencies["@ghostery/adblocker-playwright"],
);

const patchright = pkg.optionalDependencies?.["patchright-core"];
if (patchright !== pkg.dependencies["playwright-core"]) {
  failures.push(
    `patchright-core must be pinned to playwright-core's exact version ${pkg.dependencies["playwright-core"]}; found ${patchright ?? "nothing"}`,
  );
}
if (lockWorkspace.optionalDependencies?.["patchright-core"] !== patchright) {
  failures.push("bun.lock patchright-core pin does not match package.json");
}
if (lockPackageVersion("patchright-core") !== patchright) {
  failures.push(`bun.lock patchright-core resolved version must be ${patchright}`);
}

const rookieCookies = pkg.optionalDependencies?.["rookie-cookies"];
if (rookieCookies !== "0.6.0") {
  failures.push(
    `rookie-cookies must be pinned to the audited exact version 0.6.0; found ${rookieCookies ?? "nothing"}`,
  );
}
if (lockWorkspace.optionalDependencies?.["rookie-cookies"] !== rookieCookies) {
  failures.push("bun.lock rookie-cookies pin does not match package.json");
}
expectMatch(
  "Cookie Sync runtime reader pin",
  read("src/cookie-sync.ts"),
  /COOKIE_READER_VERSION = "([^"]+)"/,
  rookieCookies,
);
for (const name of [
  "rookie-cookies",
  "rookie-cookies-darwin-arm64",
  "rookie-cookies-darwin-x64",
  "rookie-cookies-linux-arm64-gnu",
  "rookie-cookies-linux-x64-gnu",
  "rookie-cookies-win32-x64-msvc",
]) {
  if (lockPackageVersion(name) !== rookieCookies) {
    failures.push(`${name} lockfile version must be ${rookieCookies}`);
  }
}

const bunVersion = String(pkg.packageManager || "").match(/^bun@(.+)$/)?.[1];
if (!bunVersion) failures.push("packageManager must pin an exact bun version");
else {
  if (read(".bun-version").trim() !== bunVersion) {
    failures.push(`.bun-version must be ${bunVersion}`);
  }
  expectMatch(
    "package engines.bun",
    JSON.stringify(pkg.engines || {}),
    /"bun":">=([^"]+)"/,
    bunVersion,
  );
  expectMatch(
    "runtime PINNED_BUN_VERSION",
    read("src/runtime.ts"),
    /PINNED_BUN_VERSION = "([^"]+)"/,
    bunVersion,
  );
  if (!read(".cursor/install.sh").includes('BUN_VERSION="$(tr -d \'[:space:]\' < .bun-version)"')) {
    failures.push("install.sh must read the Bun pin from .bun-version");
  }
  for (const workflow of [".github/workflows/ci.yml", ".github/workflows/publish-npm.yml"]) {
    expectMatch(
      `${workflow} bun-version`,
      read(workflow),
      /bun-version:\s*"([^"]+)"/,
      bunVersion,
    );
  }
}

expectMatch(
  "doctor Playwright pin",
  read("src/doctor.ts"),
  /PINNED_PLAYWRIGHT_VERSION = "([^"]+)"/,
  pkg.dependencies["playwright-core"],
);

const chromiumSource = read("src/chromium-fork.ts");
const chromiumVersion = chromiumSource.match(/BETTERWRIGHT_CHROMIUM_VERSION = "([^"]+)"/)?.[1];
if (!chromiumVersion) failures.push("BetterChromium version pin is missing");
else if (!/CHROMIUM_FORK_RELEASE_TAG = `betterchromium-\$\{BETTERWRIGHT_CHROMIUM_VERSION\}-r[0-9]+`/.test(chromiumSource)) {
  failures.push("BetterChromium release tag must be versioned as betterchromium-<version>-rN");
}
const assetEntries = [...chromiumSource.matchAll(/name: "(betterchromium-(?:mac-arm64|linux-x64|win-x64)\.zip)",\s+sha256:\s+"([a-f0-9]{64})"/g)];
const declaredAssetNames = [...chromiumSource.matchAll(/name: "([^"]+)"/g)].map((match) => match[1]);
if (assetEntries.length !== declaredAssetNames.length) {
  failures.push("every BetterChromium asset must use a betterchromium-* filename and verified SHA-256");
}
if (declaredAssetNames.some((name) => name.includes("win-x64")) &&
    !assetEntries.some(([_, name]) => name === "betterchromium-win-x64.zip")) {
  failures.push("Windows x64 must not enter the BetterChromium manifest without a verified checksum");
}
if (chromiumVersion) {
  const windowsPackage = read("scripts/chromium/package.sh");
  const packagedChromiumVersion = windowsPackage.match(/chromium_version="([^"]+)"/)?.[1];
  if (packagedChromiumVersion !== chromiumVersion) {
    failures.push("Windows package assembly version must match the BetterChromium version pin");
  }
  const windowsManifestPath = `scripts/chromium/${chromiumVersion}.manifest`;
  if (!fs.existsSync(path.join(root, windowsManifestPath))) {
    failures.push(`Windows package assembly manifest is missing: ${windowsManifestPath}`);
  } else {
    const windowsManifest = read(windowsManifestPath);
    if (!windowsManifest.includes(`name="${chromiumVersion}"`) ||
        !windowsManifest.includes(`version="${chromiumVersion}"`) ||
        !windowsManifest.includes('name="chrome_elf.dll"')) {
      failures.push("Windows package assembly manifest does not match Chromium's private assembly");
    }
  }
}

for (const workflow of [".github/workflows/ci.yml", ".github/workflows/publish-npm.yml"]) {
  const source = read(workflow);
  const managedSetup = source.match(
    /- name: Install managed browser(?:s)?\n(?:\s+if:[^\n]+\n)?\s+run:\s*([^\n]+)/,
  )?.[1]?.trim();
  if (managedSetup !== "bun dist/bin/betterwright.js setup") {
    failures.push(`${workflow} must install BetterChromium with default setup`);
  }
}

const ci = read(".github/workflows/ci.yml");
if (!/name: Worker copies in sync/.test(ci)) {
  failures.push('CI must keep the branch-protected job display name "Worker copies in sync"');
}
if (!/name: Node tests/.test(ci)) {
  failures.push('CI must keep the branch-protected job display name "Node tests"');
}

const tagIndex = process.argv.indexOf("--tag");
if (tagIndex !== -1) {
  const tag = process.argv[tagIndex + 1] || "";
  if (tag !== `v${pkg.version}`) failures.push(`release tag ${tag || "<empty>"} does not match v${pkg.version}`);
}

if (failures.length) {
  console.error(`Version checks failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log(
  `versions aligned: betterwright ${pkg.version}, bun ${bunVersion}, BetterChromium ${chromiumVersion}, playwright-core ${pkg.dependencies["playwright-core"]}`,
);
