import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  packagedMaterialsCliPath,
  resolveMaterialsRootPath,
} from "../src/main/services/materials-admin.ts";

test("packaged Materials CLI follows the PyInstaller onedir resource layout", () => {
  const resourcesPath = resolve("fixture-resources");
  assert.equal(
    packagedMaterialsCliPath(resourcesPath),
    join(
      resourcesPath,
      "runtime",
      "proto-agent",
      "proto-agent",
      "proto-agent.exe",
    ),
  );
});

test("explicit absolute materials root overrides development and packaged defaults", () => {
  const configuredRoot = resolve("external-materials");
  for (const isPackaged of [false, true]) {
    assert.equal(resolveMaterialsRootPath({
      configuredRoot,
      isPackaged,
      documentsPath: resolve("documents"),
      repoRoot: resolve("repo"),
    }), configuredRoot);
  }
});

test("materials root defaults stay outside the source and packaged application bundles", () => {
  const repoRoot = resolve("workspace", "Proto CLI");
  const documentsPath = resolve("fixture-documents");
  assert.equal(resolveMaterialsRootPath({
    isPackaged: false,
    documentsPath,
    repoRoot,
  }), resolve(repoRoot, "..", "Proto CLI Materials"));
  assert.equal(resolveMaterialsRootPath({
    isPackaged: true,
    documentsPath,
    repoRoot,
  }), join(documentsPath, "Proto CLI Materials"));
});

test("relative materials root overrides fail closed", () => {
  assert.throws(() => resolveMaterialsRootPath({
    configuredRoot: "relative-materials",
    isPackaged: false,
    documentsPath: resolve("documents"),
    repoRoot: resolve("repo"),
  }), /must be an absolute path/u);
});

test("materials activation IPC forwards bounded operator evidence to the CLI", async () => {
  const source = await readFile(resolve("src", "main", "index.ts"), "utf8");
  assert.match(source, /IPC\.materialsActivate[\s\S]*?`--operator=\$\{evidence\.operator\}`[\s\S]*?`--approval-reference=\$\{evidence\.approval_reference\}`/);
  assert.match(source, /IPC\.materialsRollback[\s\S]*?`--operator=\$\{evidence\.operator\}`[\s\S]*?`--approval-reference=\$\{evidence\.approval_reference\}`/);
  assert.doesNotMatch(source, /materialsActivate[\s\S]{0,240}"human"/);
  assert.doesNotMatch(source, /materialsRollback[\s\S]{0,240}"human"/);
});
