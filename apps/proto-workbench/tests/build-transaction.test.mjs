import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { BUILD_INPUT_ROOTS, assertSameBuildInputs, captureBuildInputs, createBuildInputSnapshot } from "../scripts/build-input-snapshot.mjs";

const helper = fileURLToPath(new URL("../scripts/build-transaction.ps1", import.meta.url));
const quote = text => `'${text.replaceAll("'", "''")}'`;
const encoded = text => Buffer.from(text, "utf16le").toString("base64");
async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), "proto-build-transaction-"));
  t.after(async () => {
    assert.equal(dirname(root), resolve(tmpdir()));
    assert.ok(root.includes("proto-build-transaction-"));
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

test("private input copies preserve dirty bytes and never share source file writes", async t => {
  const root = await workspace(t);
  const source = join(root, "source");
  const stage = join(root, "stage");
  await mkdir(join(source, "src"), { recursive: true });
  await writeFile(join(source, "src", "unsaved-in-git.txt"), "working tree content\r\n");
  const expected = await createBuildInputSnapshot({ sourceRoot: source, destinationRoot: stage, roots: ["src"] });
  assertSameBuildInputs(expected, await captureBuildInputs(stage, ["src"]), "test");
  await writeFile(join(stage, "src", "unsaved-in-git.txt"), "stage edit");
  assert.equal(await readFile(join(source, "src", "unsaved-in-git.txt"), "utf8"), "working tree content\r\n");
  assert.throws(() => assertSameBuildInputs(expected, { ...expected, treeSha256: "changed" }, "stage"), /publication is blocked/);
  await assert.rejects(createBuildInputSnapshot({ sourceRoot: source, destinationRoot: stage, roots: ["src"] }), /must not exist/);
});

test("source edits and added files invalidate the recorded input tree", async t => {
  const root = await workspace(t);
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "input.ts"), "original");
  const expected = await captureBuildInputs(root, ["src"]);
  await writeFile(join(root, "src", "input.ts"), "changed!");
  assert.throws(() => assertSameBuildInputs(expected, {}, "source"), /publication is blocked/);
  const changed = await captureBuildInputs(root, ["src"]);
  assert.throws(() => assertSameBuildInputs(expected, changed, "source"), /publication is blocked/);
  await writeFile(join(root, "src", "input.ts"), "original");
  await writeFile(join(root, "src", "new.ts"), "new");
  assert.throws(() => assertSameBuildInputs(expected, { ...changed, treeSha256: expected.treeSha256, fileCount: 99 }, "source"), /publication is blocked/);
  assert.notEqual((await captureBuildInputs(root, ["src"])).treeSha256, expected.treeSha256);
});

test("release input capture includes the exact available literature connector seed", async t => {
  const root = await workspace(t), source = join(root, "source"), stage = join(root, "stage");
  const seed = "literature/seed_sources.json";
  assert.ok(BUILD_INPUT_ROOTS.includes(seed));
  await mkdir(join(source, "literature"), {recursive:true});
  const bytes = '{"notice":"Toy capture fixture; no literature claims."}\n';
  await writeFile(join(source, seed), bytes);
  const snapshot = await createBuildInputSnapshot({sourceRoot:source,destinationRoot:stage,roots:BUILD_INPUT_ROOTS.filter(path=>path===seed)});
  assert.equal(await readFile(join(stage,seed),"utf8"),bytes);
  assertSameBuildInputs(snapshot,await captureBuildInputs(stage,[seed]),"connector seed");
  const registry = JSON.parse(await readFile(new URL("../../../connectors/proto_workbench.json",import.meta.url),"utf8"));
  for(const connector of registry.connectors.filter(item=>item.status==="available"&&item.path))assert.ok(BUILD_INPUT_ROOTS.some(path=>connector.path===path||connector.path.startsWith(path+"/")),`Available connector input missing: ${connector.path}`);
});

test("failed sidecar bytes move only to a fresh validated build evidence directory", {skip:process.platform!=="win32"}, async t => {
  const root = await workspace(t), runtime = join(root,"runtime"), build = join(root,"build"), stage = join(runtime,"staging"), failed = join(build,"failed-runtime");
  await mkdir(stage,{recursive:true});await mkdir(build);await writeFile(join(stage,"failure.bin"),"preserved bytes");
  const run = (source,destination) => spawnSync("powershell.exe",["-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-EncodedCommand",encoded(`$ErrorActionPreference='Stop'; . ${quote(helper)}; Move-FailedBuildEvidence -Path ${quote(source)} -SourceBoundary ${quote(runtime)} -Destination ${quote(destination)} -BuildRoot ${quote(build)}`)],{encoding:"utf8",windowsHide:true,timeout:5000});
  assert.notEqual(run(stage,join(root,"outside-build")).status,0);
  assert.equal(await readFile(join(stage,"failure.bin"),"utf8"),"preserved bytes");
  const moved=run(stage,failed);assert.equal(moved.status,0,moved.stderr);assert.equal(await readFile(join(failed,"failure.bin"),"utf8"),"preserved bytes");
  await mkdir(stage);await writeFile(join(stage,"second.bin"),"second failure");
  assert.notEqual(run(stage,failed).status,0);assert.equal(await readFile(join(stage,"second.bin"),"utf8"),"second failure");
  await symlink(failed,join(build,"linked"),"junction");assert.notEqual(run(stage,join(build,"linked","escaped")).status,0);
});

test("failed final release preserves exact bytes under a full-GUID identity without overwrite", {skip:process.platform!=="win32"}, async t => {
  const root=await workspace(t), build=join(root,"build"), id="0123456789abcdef".repeat(2);
  const stage=join(build,`release-staging-${id}`), failed=join(build,`release-failed-build-${id}`);
  await mkdir(stage,{recursive:true});await writeFile(join(stage,"setup.exe"),"unverified fixture bytes; never execute");
  const run=(path,buildId)=>spawnSync("powershell.exe",["-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-EncodedCommand",encoded(`$ErrorActionPreference='Stop'; . ${quote(helper)}; Move-FailedReleaseStage -Path ${quote(path)} -BuildRoot ${quote(build)} -BuildId ${quote(buildId)}`)],{encoding:"utf8",windowsHide:true,timeout:5000});
  assert.notEqual(run(stage,id.slice(0,16)).status,0);
  assert.notEqual(run(join(root,`release-staging-${id}`),id).status,0);
  const moved=run(stage,id);assert.equal(moved.status,0,moved.stderr);
  assert.equal(await readFile(join(failed,"setup.exe"),"utf8"),"unverified fixture bytes; never execute");
  await mkdir(stage);await writeFile(join(stage,"second.exe"),"later failure");
  assert.notEqual(run(stage,id).status,0);
  assert.equal(await readFile(join(stage,"second.exe"),"utf8"),"later failure");
});

test("pnpm directory links resolve exclusively into private copied dependencies", async t => {
  const root = await workspace(t);
  const source = join(root, "source");
  const stage = join(root, "stage");
  const modules = "apps/proto-workbench/node_modules";
  const target = join(source, modules, ".pnpm", "toy", "node_modules", "toy");
  await mkdir(target, { recursive: true });
  await writeFile(join(target, "index.js"), "export const toy = true;");
  await symlink(target, join(source, modules, "toy"), process.platform === "win32" ? "junction" : "dir");
  const expected = await createBuildInputSnapshot({ sourceRoot: source, destinationRoot: stage, roots: [modules] });
  assert.equal(await realpath(join(stage, modules, "toy")), join(stage, modules, ".pnpm", "toy", "node_modules", "toy"));
  assertSameBuildInputs(expected, await captureBuildInputs(stage, [modules]), "copied dependency links");
  await writeFile(join(target, "index.js"), "source changed");
  assert.equal(await readFile(join(stage, modules, "toy", "index.js"), "utf8"), "export const toy = true;");
});

test("dependency links outside the allowlisted dependency tree fail closed", async t => {
  const root = await workspace(t);
  const modules = "apps/proto-workbench/node_modules";
  await mkdir(join(root, modules), { recursive: true });
  await mkdir(join(root, "outside"));
  await symlink(join(root, "outside"), join(root, modules, "escape"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(captureBuildInputs(root, [modules]), /escapes its root/);
});

test("all Windows build entrypoints share one lease; releasing nested scope keeps contention blocked", { skip: process.platform !== "win32", timeout: 20_000 }, async t => {
  const root = await workspace(t);
  const holderCode = `$ErrorActionPreference='Stop'; . ${quote(helper)}; $lease=Enter-ProjectBuildLease -AppRoot ${quote(root)}; try { $nested=Enter-ProjectBuildLease -AppRoot ${quote(root)} -ParentLease $lease; Exit-ProjectBuildLease $nested; [Console]::Out.WriteLine('READY'); [void][Console]::ReadLine() } finally { Exit-ProjectBuildLease $lease }`;
  const holder = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded(holderCode)], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => holder.kill());
  await new Promise((resolveReady, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`Lock holder did not become ready: ${output}`)), 8_000);
    holder.stdout.on("data", bytes => { output += bytes; if (output.includes("READY")) { clearTimeout(timer); resolveReady(); } });
    holder.stderr.on("data", bytes => { output += bytes; });
    holder.on("error", reject);
  });
  const contenderCode = `$ErrorActionPreference='Stop'; . ${quote(helper)}; $lease=Enter-ProjectBuildLease -AppRoot ${quote(root)}; Exit-ProjectBuildLease $lease`;
  const blocked = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded(contenderCode)], { encoding: "utf8", windowsHide: true, timeout: 5_000 });
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /project build lock/);
  holder.stdin.end("release\n");
  await new Promise(resolveExit => holder.on("exit", resolveExit));
  const acquired = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded(contenderCode)], { encoding: "utf8", windowsHide: true, timeout: 5_000 });
  assert.equal(acquired.status, 0, acquired.stderr);
});
