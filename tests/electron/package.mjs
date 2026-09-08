import fs from "node:fs/promises";
import path from "node:path";
import { createPackage } from "@electron/asar";

const output = path.resolve(".tmp/electron-e2e");
const stage = path.join(output, "stage");
await fs.rm(stage, { recursive: true, force: true });
await fs.mkdir(path.join(stage, "tests/electron"), { recursive: true });
await fs.cp("dist", path.join(stage, "dist"), { recursive: true });
await fs.copyFile("tests/electron/reliability.mjs", path.join(stage, "tests/electron/reliability.mjs"));
const manifest = JSON.parse(await fs.readFile("package.json", "utf8"));
manifest.main = "tests/electron/reliability.mjs";
await fs.writeFile(path.join(stage, "package.json"), JSON.stringify(manifest));
await createPackage(stage, path.join(output, "app.asar"));
console.log("Created isolated Electron E2E archive.");
