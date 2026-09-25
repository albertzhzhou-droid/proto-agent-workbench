import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { captureBuildInputs, createBuildInputSnapshot } from "../scripts/build-input-snapshot.mjs";
import { collectConfiguredRuntimeResources } from "../scripts/packaging-resources.mjs";
import { CHEM_SOURCE_FILTERS, isExcludedChemSource } from "../scripts/chem-source-filter.mjs";

const chem = "apps/proto-workbench/runtime/chem-workbench";
const authored = ["src/chem_workbench/cli.py", "tests/test_cli.py", "tests/fixtures/example.json", "schemas/chem.schema.json", "examples/example.chem", "pyproject.toml", "uv.lock", "LICENSE", "desktop/main.js", "package.json", ".env.example"];
const local = ["build/pytest/failure.json", "nested/build/output.json", "dist/app.zip", "scratch/result.json", ".venv/Lib/site-packages/runtime.py", "nested/.venv-local/bin/python", ".chem-backends/python.exe", "nested/.chem-backends/runtime.json", ".cache/data", ".pytest_cache/state", ".uv-cache/data", "__pycache__/module.pyc", "nested/node_modules/package/index.js", "timer.dat", "nested/timer.dat", "custom.env", ".env.local", "nested/model.safetensors", "nested/model.gguf", ".coverage", "chem_workbench.egg-info/PKG-INFO"];

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), "chem-source-packaging-"));
  t.after(async () => {
    assert.equal(dirname(root), resolve(tmpdir()));
    assert.ok(root.startsWith(join(resolve(tmpdir()), "chem-source-packaging-")));
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

async function write(root, path, data = "fixture\n") {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), data);
}

test("Chem build capture prunes local state and still binds source, tests, locks, and unrelated build paths", async t => {
  const root = await workspace(t), source = join(root, "source"), stage = join(root, "stage");
  for (const path of [...authored, ...local]) await write(source, `${chem}/${path}`);
  await write(source, "src/build/authored.ts");
  const roots = [chem, "src"];
  const baseline = await createBuildInputSnapshot({ sourceRoot: source, destinationRoot: stage, roots });
  const paths = baseline.records.filter(record => record.kind === "file").map(record => record.path);
  for (const path of authored) assert.ok(paths.includes(`${chem}/${path}`), path);
  for (const path of local) assert.ok(!paths.includes(`${chem}/${path}`), path);
  assert.ok(paths.includes("src/build/authored.ts"));
  for (const path of local) await write(source, `${chem}/${path}`, "changed local state\n");
  assert.equal((await captureBuildInputs(source, roots)).treeSha256, baseline.treeSha256);
  for (const path of [authored[0], "tests/test_cli.py", "uv.lock"]) {
    await write(source, `${chem}/${path}`, "changed authored input\n");
    assert.notEqual((await captureBuildInputs(source, roots)).treeSha256, baseline.treeSha256, path);
    await write(source, `${chem}/${path}`);
  }
  assert.equal((await captureBuildInputs(stage, roots)).treeSha256, baseline.treeSha256);
});

test("module resources and actual electron-builder filter keep the same Chem source paths", async t => {
  const root = await workspace(t), app = join(root, "app"), runtime = join(app, "runtime/chem-workbench");
  for (const path of [...authored, ...local]) await write(runtime, path);
  const config = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const entry = config.build.extraResources.find(resource => resource.from === "runtime/chem-workbench");
  assert.deepEqual(entry.filter, CHEM_SOURCE_FILTERS);
  const resources = await collectConfiguredRuntimeResources(app, { build: { extraResources: [entry] } });
  assert.deepEqual(resources.map(resource => resource.path).sort(), authored.map(path => `runtime/chem-workbench/${path}`).sort());
  const require = createRequire(import.meta.url);
  const builderRequire = createRequire(require.resolve("electron-builder/package.json"));
  const { FileMatcher } = builderRequire("app-builder-lib/out/fileMatcher.js");
  const filter = new FileMatcher(runtime, join(root, "target"), value => value, entry.filter).createFilter();
  for (const path of [...authored, ...local]) {
    assert.equal(filter(join(runtime, path), { isDirectory: () => false }), !isExcludedChemSource(path), path);
  }
  for (const path of ["build", "nested/build", ".venv", "nested/.chem-backends", "scratch", "tests", "tests/fixtures"]) {
    assert.equal(filter(join(runtime, path), { isDirectory: () => true }), !isExcludedChemSource(path), path);
  }
});

test("excluded Chem trees are pruned before link checks or descent", async t => {
  const root = await workspace(t), source = join(root, "source"), app = join(source, "apps/proto-workbench");
  await write(source, `${chem}/src/cli.py`);
  const inaccessibleTarget = join(root, "target");
  await mkdir(inaccessibleTarget);
  await symlink(inaccessibleTarget, join(source, chem, "build"), process.platform === "win32" ? "junction" : "dir");
  const snapshot = await captureBuildInputs(source, [chem]);
  assert.equal(snapshot.records.some(record => record.path.includes("/build")), false);
  const resources = await collectConfiguredRuntimeResources(app, { build: { extraResources: [{ from: "runtime/chem-workbench", to: "runtime/chem-workbench", filter: CHEM_SOURCE_FILTERS }] } });
  assert.deepEqual(resources.map(resource => resource.path), ["runtime/chem-workbench/src/cli.py"]);
});
