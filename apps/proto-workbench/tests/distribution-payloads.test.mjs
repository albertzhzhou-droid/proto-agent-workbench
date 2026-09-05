import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { validateArchiveListing, verifyDistributionPayloads } from "../scripts/verify-distribution-payloads.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const evidenceParent = join(repository, "build", "upgrade-20260904", "distribution-unit-tests");
const fullArchiveExecutable = process.env.PROTO_TEST_NSIS_ARCHIVE_TOOL ?? join(repository, "build", "tools", "7zip-26.03", "bin", "7z.exe");
const listing = blocks => `7-Zip technical listing\n----------\n${blocks.join("\n\n")}\n`;
test("archive inspection rejects traversal, alternate streams, aliases, links and excessive expansion before extraction", () => {
  assert.deepEqual(validateArchiveListing(listing(["Path = $PLUGINSDIR/app-64.7z\nSize = 40"])), { entries: 1, totalBytes: 40 });
  for (const path of ["../outside", "C:/outside", "/outside", "resources/app.asar:stream", "folder/../outside", "folder./file"])
    assert.throws(() => validateArchiveListing(listing([`Path = ${path}\nSize = 2`])), /Unsafe archive path/);
  assert.throws(() => validateArchiveListing(listing(["Path = resources/alias\nSymbolic Link = outside"])), /links/);
  assert.throws(() => validateArchiveListing(listing(["Path = App.exe\nSize = 2", "Path = APP.EXE\nSize = 2"])), /collide/);
  assert.throws(() => validateArchiveListing(listing(["Path = huge\nSize = 4294967297"])), /4 GiB/);
});

test("real NSIS extraction binds both nested distribution payloads to the full unpacked byte tree", { skip: process.platform !== "win32" || !existsSync(fullArchiveExecutable) ? "Requires the full NSIS-capable archive verifier prerequisite" : false, timeout: 30_000 }, async t => {
  const archiveExecutable = fullArchiveExecutable;
  const cache = join(process.env.LOCALAPPDATA, "electron-builder", "Cache", "nsis-3.0.4.1");
  const candidates = (await readdir(cache, { withFileTypes: true })).filter(entry => entry.isDirectory() && entry.name.startsWith("nsis-3.0.4.1")).map(entry => entry.name);
  assert.equal(candidates.length, 1, "A single cached NSIS compiler is required for this isolated fixture.");
  const nsis = join(cache, candidates[0], "Bin", "makensis.exe");
  await mkdir(evidenceParent, { recursive: true });
  const root = await mkdtemp(join(evidenceParent, "r-"));
  t.after(async () => { assert.equal(dirname(root), evidenceParent); await rm(root, { recursive: true, force: true }); });
  const unpackedRoot = join(root, "unpacked"), releaseRoot = join(root, "release"), outer = join(root, "outer");
  await mkdir(join(unpackedRoot, "resources"), { recursive: true });
  await mkdir(join(outer, "$PLUGINSDIR"), { recursive: true });
  await mkdir(releaseRoot);
  // Real NSIS containers with explicit toy app bytes. This tests archive/payload
  // integrity, not Electron execution, scientific IR or installer OS effects.
  await writeFile(join(unpackedRoot, "Toy.exe"), "toy executable bytes");
  await writeFile(join(unpackedRoot, "resources", "app.asar"), "toy payload bytes");
  function archive(cwd, destination) {
    const result = spawnSync(archiveExecutable, ["a", "-t7z", "-bd", destination, ".\\*"], { cwd, windowsHide: true, shell: false, encoding: "utf8", timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
  }
  archive(unpackedRoot, join(outer, "$PLUGINSDIR", "app-64.7z"));
  for (const kind of ["setup", "portable"]) {
    const script = join(root, `${kind}.nsi`);
    await writeFile(script, `Unicode true\nName "Toy package verification fixture"\nOutFile "${join(releaseRoot, `Toy-${kind}.exe`)}"\nRequestExecutionLevel user\nSection\nInitPluginsDir\nFile /oname=$PLUGINSDIR\\app-64.7z "${join(outer, "$PLUGINSDIR", "app-64.7z")}"\nSectionEnd\n`);
    const compiled = spawnSync(nsis, ["/V1", script], { cwd: root, windowsHide: true, shell: false, encoding: "utf8", timeout: 5000 });
    assert.equal(compiled.status, 0, compiled.stderr);
  }
  const report = await verifyDistributionPayloads({ releaseRoot, unpackedRoot, archiveExecutable, evidenceRoot: join(root, "evidence") });
  assert.equal(report.distributions.length, 2);
  for (const distribution of report.distributions) {
    assert.equal(distribution.payload.treeSha256, report.unpackedPayload.treeSha256);
    assert.equal(distribution.launchStatus, "not-run");
    assert.match(distribution.artifact.sha256, /^[a-f0-9]{64}$/);
  }
  await writeFile(join(unpackedRoot, "resources", "unexpected.txt"), "drift");
  await assert.rejects(verifyDistributionPayloads({ releaseRoot, unpackedRoot, archiveExecutable, evidenceRoot: join(root, "drift") }), /differs from the verified unpacked/);
});
