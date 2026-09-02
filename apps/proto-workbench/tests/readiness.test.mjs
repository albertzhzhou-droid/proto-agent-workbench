import assert from "node:assert/strict";
import test from "node:test";
import { deriveWorkbenchReadiness } from "../src/renderer/readiness.ts";

const settings = {
  inference: {
    provider: "lmstudio",
    baseUrl: "http://127.0.0.1:1234",
    tokenEnvNames: ["LMSTUDIO_API_KEY", "LM_API_TOKEN"],
    explicitLoadOnly: true,
  },
  workspacePath: "C:\\workspace",
  residencyPolicy: { mode: "quick-switch", budgetBytes: 20 * 1024 ** 3, warmTtlMinutes: 30, pinnedModelIds: [] },
  modules: { profile: "core-only", enabledOptional: [] },
};
const integrity = {
  ok: true,
  enforced: true,
  manifestPath: "out/module-manifest.json",
  checkedAt: "2026-08-30T00:00:00.000Z",
  modules: [],
};
const runtime = { available: true, provider: "lmstudio", endpoint: "http://127.0.0.1:1234", modelCount: 1, loadedModelCount: 1, detail: "LM Studio ready" };
const entry = {
  path: "C:\\workspace\\designs\\toggle.proto",
  relativePath: "designs/toggle.proto",
  name: "toggle.proto",
  mediaType: "text/x-proto",
  sizeBytes: 42,
  modifiedAt: "2026-08-30T00:00:00.000Z",
};
const model = {
  id: "model-1",
  name: "Local model",
  loadState: "active",
  workbenchInstance: { id: "instance-1", ownedByWorkbench: true },
};

test("readiness becomes operational only when every real prerequisite is ready", () => {
  const result = deriveWorkbenchReadiness({
    settings,
    runtime,
    moduleIntegrity: integrity,
    models: [model],
    workspaceEntries: [entry],
  });

  assert.equal(result.operational, true);
  assert.equal(result.readyCount, 4);
  assert.equal(result.next, undefined);
});

test("a discovered but unloaded model requires explicit review and load", () => {
  const result = deriveWorkbenchReadiness({
    settings,
    runtime,
    moduleIntegrity: integrity,
    models: [{ ...model, loadState: "unloaded" }],
    workspaceEntries: [entry],
  });

  assert.equal(result.operational, false);
  assert.equal(result.next.id, "model");
  assert.equal(result.next.action, "open-models");
  assert.match(result.next.detail, /connect or load one explicitly/i);
});

test("an active model cannot satisfy readiness for a thread bound to another model", () => {
  const result = deriveWorkbenchReadiness({
    settings,
    runtime,
    moduleIntegrity: integrity,
    models: [
      model,
      { ...model, id: "model-2", name: "Thread model", loadState: "unloaded" },
    ],
    workspaceEntries: [entry],
    threadModelId: "model-2",
  });

  assert.equal(result.operational, false);
  assert.equal(result.next.id, "model");
  assert.match(result.next.detail, /Thread model.*not connected/i);
});

test("integrity failures block before setup actions and empty workspaces remain actionable", () => {
  const blocked = deriveWorkbenchReadiness({
    settings,
    runtime,
    moduleIntegrity: { ...integrity, ok: false },
    models: [model],
    workspaceEntries: [],
  });

  assert.equal(blocked.next.id, "modules");
  assert.equal(blocked.next.state, "blocked");
  assert.equal(blocked.steps.find((step) => step.id === "workspace").state, "action");
});
