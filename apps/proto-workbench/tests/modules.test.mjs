import assert from "node:assert/strict";
import test from "node:test";
import {
  CORE_MODULES,
  defaultModuleSettings,
  isToolEnabledForModules,
  modulesForProfile,
  normalizeModuleSettings,
  OPTIONAL_MODULES,
} from "../src/shared/modules.ts";

test("every module has a stable ID, version, and unique ownership record", () => {
  const modules = [...CORE_MODULES, ...OPTIONAL_MODULES];
  assert.equal(new Set(modules.map((module) => module.id)).size, modules.length);
  for (const module of modules) {
    assert.match(module.id, /^(core|evidence|analysis|media)\.[a-z0-9-]+$/);
    assert.equal(Number.isSafeInteger(module.version), true);
    assert.equal(module.version > 0, true);
  }
});
test("load profiles change optional capability only", () => {
  assert.deepEqual(modulesForProfile("core-only"), []);
  assert.equal(modulesForProfile("research").every((id) => id.startsWith("evidence.")), true);
  assert.deepEqual(modulesForProfile("full"), OPTIONAL_MODULES.map((module) => module.id));
  assert.deepEqual(defaultModuleSettings(), {
    profile: "research",
    enabledOptional: modulesForProfile("research"),
  });
});

test("core tools stay enabled while optional tools follow module settings", () => {
  const coreOnly = normalizeModuleSettings({ profile: "core-only" });
  assert.equal(isToolEnabledForModules("workspace_read", coreOnly), true);
  assert.equal(isToolEnabledForModules("proto_check", coreOnly), true);
  assert.equal(isToolEnabledForModules("proto_review_packet", coreOnly), true);
  assert.equal(isToolEnabledForModules("proto_pubmed_search", coreOnly), false);
  assert.equal(isToolEnabledForModules("proto_run_analysis", coreOnly), false);

  const research = normalizeModuleSettings({ profile: "research" });
  assert.equal(isToolEnabledForModules("proto_pubmed_search", research), true);
  assert.equal(isToolEnabledForModules("proto_rhea_search", research), true);
  assert.equal(isToolEnabledForModules("proto_run_analysis", research), false);
});
