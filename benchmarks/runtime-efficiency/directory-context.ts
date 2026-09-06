import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    baseline: { type: "string" },
    candidate: { type: "string" },
    output: { type: "string" },
    help: { type: "boolean" },
  },
});
if (values.help) {
  process.stdout.write("bun benchmarks/runtime-efficiency/directory-context.ts --baseline /built/baseline --candidate /built/candidate [--output results.json]\n");
  process.exit(0);
}
assert.ok(values.baseline && values.candidate, "--baseline and --candidate package directories are required");
assert.ok(process.env.BETTERWRIGHT_CHROMIUM_PATH, "Set BETTERWRIGHT_CHROMIUM_PATH to the shared browser executable");

const forms = {
  normal: '<form><p>Account settings</p><input aria-label="Name" value="Alex"><input aria-label="Email" value="alex@example.test"><select aria-label="Theme"><option>Light</option><option>Dark</option></select><button>Save</button><button>Save</button></form>',
  sharedLarge: `<form><div>${Array.from({ length: 2000 }, (_, i) => `<span>Context item ${i} nested text. </span>`).join('')}</div>${Array.from({ length: 36 }, () => '<button>Save</button>').join('')}</form>`,
  distinct: `<main>${Array.from({ length: 36 }, (_, i) => `<article><p>Product ${i} price $${i + 10}</p><button>Choose</button></article>`).join('')}</main>`,
};

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

async function treeIdentity(root: string, directories: string[]) {
  const files: Record<string, string> = {};
  async function visit(relative: string) {
    for (const entry of (await readdir(path.join(root, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) await visit(name);
      else if (entry.isFile()) files[name] = sha256(await readFile(path.join(root, name)));
    }
  }
  for (const directory of directories) await visit(directory);
  return { sha256: sha256(JSON.stringify(files)), files };
}

async function packageIdentity(directory: string) {
  return {
    directory,
    packageJsonSha256: sha256(await readFile(path.join(directory, "package.json"))),
    source: await treeIdentity(directory, ["src", "bin"]),
    runtime: await treeIdentity(directory, ["dist"]),
  };
}

interface FixtureResult {
  directory: unknown;
  samples: number[];
}

const variants = [
  { name: "baseline", directory: path.resolve(values.baseline) },
  { name: "candidate", directory: path.resolve(values.candidate) },
];
const identities: Record<string, Awaited<ReturnType<typeof packageIdentity>>> = {};
const results: Record<string, Record<string, FixtureResult>> = {};
const startedAt = new Date().toISOString();
const browserPath = path.resolve(process.env.BETTERWRIGHT_CHROMIUM_PATH);
const browserSha256 = sha256(await readFile(browserPath));
for (const { name, directory } of variants) {
  identities[name] = await packageIdentity(directory);
  const { BetterWright } = await import(pathToFileURL(path.join(directory, "dist/src/index.js")).href);
  const home = await mkdtemp(path.join(os.tmpdir(), "bw-context-"));
  const browser = new BetterWright({ home, headless: true, vault: false });
  try {
    results[name] = {};
    for (const [fixture, html] of Object.entries(forms)) {
      const setup = await browser.run(`await page.setContent(${JSON.stringify(html)}); return controls.directory();`);
      assert.equal(setup.ok, true, setup.error);
      const measurement = await browser.run(`
        const times = [];
        for (let i = 0; i < 25; i++) {
          const start = Date.now();
          for (let j = 0; j < 5; j++) await controls.directory();
          if (i >= 5) times.push((Date.now() - start) / 5);
        }
        return times;
      `, { timeout: 120 });
      assert.equal(measurement.ok, true, measurement.error);
      assert.ok(Array.isArray(measurement.result) && measurement.result.length === 20);
      assert.ok(measurement.result.every((sample) => Number.isFinite(sample) && sample >= 0));
      results[name][fixture] = { directory: setup.result, samples: measurement.result };
    }
  } finally {
    await browser.close();
    await rm(home, { recursive: true, force: true });
  }
  assert.deepEqual(await packageIdentity(directory), identities[name], `${name} changed during measurement`);
}
assert.equal(sha256(await readFile(browserPath)), browserSha256, "Browser changed during measurement");

const median = (samples: number[]) => {
  const sorted = [...samples].sort((a, b) => a - b);
  return (sorted[9] + sorted[10]) / 2;
};
const summary: Record<string, { equal: boolean; baselineMs: number; candidateMs: number }> = {};
for (const fixture of Object.keys(forms)) {
  assert.deepEqual(results.candidate[fixture].directory, results.baseline[fixture].directory, fixture);
  summary[fixture] = {
    equal: true,
    baselineMs: median(results.baseline[fixture].samples),
    candidateMs: median(results.candidate[fixture].samples),
  };
}
const report = `${JSON.stringify({
  startedAt,
  finishedAt: new Date().toISOString(),
  measurement: { unit: "milliseconds per directory scan", clock: "worker Date.now", warmupGroups: 5, sampleGroups: 20, scansPerGroup: 5, variantOrder: ["baseline", "candidate"] },
  host: { platform: process.platform, arch: process.arch, versions: process.versions, cpu: os.cpus()[0]?.model },
  browser: { path: browserPath, sha256: browserSha256 },
  fixtureSha256: sha256(JSON.stringify(forms)),
  identities,
  summary,
  results,
}, null, 2)}\n`;
if (values.output) await writeFile(path.resolve(values.output), report);
else process.stdout.write(report);
