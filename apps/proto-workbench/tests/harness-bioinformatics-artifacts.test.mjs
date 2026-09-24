import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdir,mkdtemp,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {AppDatabase} from "../src/main/services/database.ts";
import {WorkspaceFiles} from "../src/main/services/workspace-files.ts";
import {HarnessWorkspace} from "../src/main/services/harness-workspace.ts";

test("Harness binds object-shaped scientific artifacts to actual contained bytes",async t=>{
  const parent=await mkdtemp(join(tmpdir(),"proto-harness-bio-"));
  const root=join(parent,"workspace");
  await mkdir(join(root,"build"),{recursive:true});
  const database=new AppDatabase(join(root,"state.sqlite"));
  t.after(()=>database.close());
  const workspace=new WorkspaceFiles(root,database);
  const resultText="# Synthetic coordinate results\n1 2000 100.00\n";
  await writeFile(join(root,"build/coordinates.txt"),resultText);
  await writeFile(join(root,"build/log.txt"),"engine exited 0\n");
  await writeFile(join(root,"request.json"),JSON.stringify({operation:"nucmer_align",arguments:{}}));
  await writeFile(join(parent,"outside.txt"),"Do not bind an out-of-workspace artifact");
  let calls=0;
  const mcp={call:async()=>{calls++;return {ok:true,artifacts:[
    {path:"build/coordinates.txt",sha256:"0".repeat(64),bytes:1},
    "build/log.txt",{path:"../outside.txt",sha256:"0".repeat(64)},
    {path:42},null,{unrelated:"ignored"},
  ]};}};
  const service=new HarnessWorkspace(workspace,database,mcp,{},async()=>[],()=>{});
  const checkpoint={createdAt:new Date().toISOString(),contract:{workspacePath:root,runId:"bio-artifact-test",mode:"act",scope:{execution:true,network:false},budgets:{activeTimeMs:30000}},activeTimeMs:0};
  const result=await service.execute("proto_bioinformatics_run",{path:"request.json"},"bio",checkpoint,new AbortController().signal);
  assert.equal(calls,1);
  assert.equal(result.ok,true);
  assert.equal(result._harnessArtifacts.length,2);
  const bound=result._harnessArtifacts.find(item=>item.path.endsWith("coordinates.txt"));
  assert.equal(bound.sha256,createHash("sha256").update(resultText).digest("hex"),"Reopen actual bytes; do not trust the engine's claimed digest");
  assert.equal(bound.sizeBytes,Buffer.byteLength(resultText));
  assert.ok(result._harnessArtifacts.every(item=>!item.path.endsWith("outside.txt")),"Existing containment validation still rejects object-shaped path escapes");
  checkpoint.contract.scope.execution=false;
  const denied=await service.execute("proto_bioinformatics_run",{path:"request.json"},"blocked",checkpoint,new AbortController().signal);
  assert.equal(denied.code,"POLICY_DENIED");
  assert.equal(calls,1,"No engine call without the existing mission execution scope");
});
