import assert from "node:assert/strict";
import test from "node:test";
import { classifyTool, isToolExposedToModel } from "../src/main/services/permissions.ts";
import { harnessToolEffect } from "../src/main/services/harness-workspace.ts";
import { isToolEnabledForModules, normalizeModuleSettings } from "../src/shared/modules.ts";

test("reviewed compute tools are discoverable and respect optional module enablement", () => {
  for (const tool of ["proto_compute_catalog", "proto_compute_run"]) {
    assert.equal(isToolExposedToModel(tool), true);
    assert.deepEqual(classifyTool(tool), { allowed: true, risk: "none" });
    assert.equal(isToolEnabledForModules(tool, normalizeModuleSettings({ profile: "core-only" })), false);
    assert.equal(isToolEnabledForModules(tool, normalizeModuleSettings({ profile: "full" })), true);
    assert.equal(isToolEnabledForModules(tool, normalizeModuleSettings({ profile: "custom", enabledOptional: ["analysis.biomni"] })), true);
  }
  assert.equal(classifyTool("proto_compute_arbitrary_python").allowed, false);
});

test("compute result publication takes the workspace write queue and is blocked in Plan mode", () => {
  assert.equal(harnessToolEffect("proto_compute_run"), "write");
  assert.equal(harnessToolEffect("proto_compute_catalog"), "read");
});
