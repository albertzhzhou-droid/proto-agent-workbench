import assert from "node:assert/strict";
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
