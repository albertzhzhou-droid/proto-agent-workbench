import assert from "node:assert/strict";
import test from "node:test";
import { connectedContext, modelContextLabel, modelPreflightIdentity } from "../src/renderer/model-presentation.ts";

const model = { id:"qwen", fingerprint:"a", contextLength:262144, loadState:"active", toolCapability:"agent-ready", vision:false,
  workbenchInstance:{ id:"owned-qwen", ownedByWorkbench:true, contextLength:32768 },
  loadedInstances:[{id:"other-qwen",contextLength:4096}] };

test("connected context is the exact actual instance, never the catalog maximum or another instance", () => {
  assert.equal(connectedContext(model),32768);
  assert.equal(modelContextLabel(model),"32,768 loaded");
  const uncached={...model,workbenchInstance:{id:"owned-qwen",ownedByWorkbench:true}};
  assert.equal(connectedContext(uncached),undefined);
  assert.equal(modelContextLabel(uncached),"Loaded context awaiting refresh");
  assert.equal(modelContextLabel({...model,loadState:"unloaded",workbenchInstance:undefined}),"262,144 max context");
});

test("VRAM metrics, timestamps, catalog order and unrelated models keep the reviewed launch identity stable", () => {
  const before=modelPreflightIdentity([model],"qwen");
  assert.equal(modelPreflightIdentity([{id:"unrelated"},{...model,measuredVramBytes:999,lastUsedAt:"new",estimatedVramBytes:333}],"qwen"),before);
  for(const changed of [
    {...model,fingerprint:"b"}, {...model,loadState:"unloaded"}, {...model,toolCapability:"chat-only"}, {...model,vision:true},
    {...model,workbenchInstance:{...model.workbenchInstance,id:"replacement"}},
    {...model,workbenchInstance:{...model.workbenchInstance,contextLength:16384}},
  ]) assert.notEqual(modelPreflightIdentity([changed],"qwen"),before);
  assert.notEqual(modelPreflightIdentity([],"qwen"),before);
});
