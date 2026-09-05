import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertSameBuildInputs, captureBuildInputs, createBuildInputSnapshot } from "../scripts/build-input-snapshot.mjs";
import { relocatePrivatePnpm } from "../scripts/relocate-private-pnpm.mjs";

const modules = "apps/proto-workbench/node_modules";
async function fixture(t, storeOverride) {
  const root = await mkdtemp(join(tmpdir(), "proto-private-pnpm-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = join(root, "source"), privateRoot = join(root, "private");
  await mkdir(join(sourceRoot, modules, ".pnpm"), { recursive: true });
  const original = JSON.stringify({ packageManager: "pnpm@11.19.0", nodeLinker: "isolated", virtualStoreDir: storeOverride ?? join(sourceRoot, modules, ".pnpm"), storeDir: "external-read-only-store", preserved: ["metadata"] });
  await writeFile(join(sourceRoot, modules, ".modules.yaml"), original);
  await writeFile(join(sourceRoot, modules, ".pnpm", "toy.js"), "// explicit toy dependency bytes\n");
  const snapshot = await createBuildInputSnapshot({ sourceRoot, destinationRoot: privateRoot, roots: [modules] });
  return { sourceRoot, privateRoot, snapshot, original };
}
test("private pnpm relocation binds its derived tree while original metadata/dependency bytes remain unchanged", async t => {
  const item = await fixture(t);
  const { snapshot, receipt } = await relocatePrivatePnpm(item);
  assertSameBuildInputs(item.snapshot, await captureBuildInputs(item.sourceRoot, [modules]), "original dependency tree");
  assertSameBuildInputs(snapshot, await captureBuildInputs(item.privateRoot, [modules]), "derived private tree");
  assert.equal(await readFile(join(item.sourceRoot, modules, ".modules.yaml"), "utf8"), item.original);
  const metadata = JSON.parse(await readFile(join(item.privateRoot, modules, ".modules.yaml"), "utf8"));
  assert.equal(metadata.virtualStoreDir, join(item.privateRoot, modules, ".pnpm"));
  assert.equal(metadata.storeDir, "external-read-only-store");
  assert.deepEqual(metadata.preserved, ["metadata"]);
  assert.notEqual(receipt.sourceTreeSha256, receipt.privateTreeSha256);
  assert.equal(receipt.installOrRebuild, false);
  await writeFile(join(item.privateRoot, modules, ".pnpm", "toy.js"), "tampered");
  assert.throws(() => assertSameBuildInputs(snapshot, { ...snapshot, treeSha256: "tampered" }, "private mutation"), /publication is blocked/);
  assert.notEqual((await captureBuildInputs(item.privateRoot, [modules])).treeSha256, snapshot.treeSha256);
});
test("external virtual store metadata is rejected without changing the original or private copy", async t => {
  const item = await fixture(t, join(tmpdir(), "not-copied-store"));
  await assert.rejects(relocatePrivatePnpm(item), /exactly at the captured source/);
  assert.equal(await readFile(join(item.privateRoot, modules, ".modules.yaml"), "utf8"), item.original);
  await assert.rejects(relocatePrivatePnpm({ ...item, privateRoot: item.sourceRoot }), /independent private root/);
});
