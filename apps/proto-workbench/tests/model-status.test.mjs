import assert from "node:assert/strict";
import test from "node:test";
import { isModelConnected, readModelSnapshot } from "../src/shared/model-status.ts";
import { deriveWorkbenchReadiness } from "../src/renderer/readiness.ts";

const loaded = { id: "present", name: "Present model", modelKind: "llm", loadState: "active",
  loadedInstances: [{id: "exact", contextLength: 8192}], workbenchInstance: {id: "exact", ownedByWorkbench: false} };

test("success, external unload, removal, empty server and failure have distinct live states", async () => {
  let inventory = [loaded];
  const scan = async () => inventory;
  const first = await readModelSnapshot(scan);
  assert.equal(first.runtime.loadedModelCount, 1);
  assert.equal(isModelConnected(first.models[0]), true);
  inventory = [{...loaded, loadedInstances: []}];
  const unloaded = await readModelSnapshot(scan);
  assert.equal(unloaded.runtime.available, true);
  assert.equal(unloaded.runtime.loadedModelCount, 0);
  assert.equal(isModelConnected(unloaded.models[0]), false);
  inventory = [];
  const empty = await readModelSnapshot(scan);
  assert.equal(empty.runtime.available, true);
  assert.deepEqual(empty.models, []);
  const failure = await readModelSnapshot(async () => { throw new Error("Server stopped"); });
  assert.equal(failure.runtime.available, false);
  assert.equal(failure.runtime.loadedModelCount, 0);
  assert.deepEqual(failure.models, []);
  assert.equal(failure.runtime.detail, "Server stopped");
  inventory = [{...loaded, id: "replacement"}];
  const recovered = await readModelSnapshot(scan);
  assert.equal(recovered.runtime.available, true);
  assert.deepEqual(recovered.models.map(item => item.id), ["replacement"]);
});

test("Overview cannot call a stale or mismatched instance ready", () => {
  const input = {settings: {workspacePath: "workspace", inference: {baseUrl: "http://127.0.0.1:1234"}},
    moduleIntegrity: {ok: true, enforced: true}, workspaceEntries: [{}], threadModelId: loaded.id};
  for (const [available, instances] of [[false, loaded.loadedInstances], [true, []], [true, [{id: "different"}]]]) {
    const result = deriveWorkbenchReadiness({...input, runtime: {available, detail: "Observed state"}, models: [{...loaded, loadedInstances: instances}]});
    assert.notEqual(result.steps.find(step => step.id === "model").state, "ready");
    assert.equal(result.operational, false);
  }
});
