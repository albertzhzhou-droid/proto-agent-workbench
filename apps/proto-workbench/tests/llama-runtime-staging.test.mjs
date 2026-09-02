import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const APP_ROOT = process.cwd();
const SCRIPT_PATH = join(APP_ROOT, "scripts", "stage-llama-runtime.ps1");
const LOCK_PATH = join(APP_ROOT, "runtime", "llama.cpp", "release-lock.json");

test("llama runtime staging consumes the repository release lock", async () => {
  const source = await readFile(SCRIPT_PATH, "utf8");
  assert.match(source, /release-lock\.json/u);
  assert.match(source, /ExpectedArchive\.sha256/u);
  assert.match(source, /ExpectedCompanion\.sha256/u);
  assert.match(source, /StageTarget/u);
  assert.doesNotMatch(source, /Copy-Item -Destination \$Target/u);
  assert.doesNotMatch(source, /\[string\]\$Sha256/u);
  assert.doesNotMatch(source, /\[string\]\$ReleaseTag/u);
});

test("llama runtime staging rejects bytes that do not match the locked digest", {
  skip: process.platform !== "win32",
}, async (context) => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "proto-llama-lock-"));
  context.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const lock = JSON.parse(await readFile(LOCK_PATH, "utf8"));
  const archivePath = join(fixtureRoot, lock.assets.cpu.name);
  await writeFile(archivePath, "not the reviewed archive", "utf8");

  const result = spawnSync("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-NonInteractive",
    "-File",
    SCRIPT_PATH,
    "-Flavor",
    "cpu",
    "-ArchivePath",
    archivePath,
  ], { encoding: "utf8", windowsHide: true });

  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /SHA256 mismatch/u);
});
