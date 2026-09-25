import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createResearchWorkflowService } from "../src/main/services/research-workflow-runtime.ts";
import { ToolExecutionJournal } from "../src/main/services/tool-execution-journal.ts";
import { invokeJournaledTool } from "./helpers/ephemeral-kernel.mjs";

test("workflow recovery preserves operation and scope identity through the actual runtime adapter", async t => {
  const root=await mkdtemp(join(tmpdir(),"proto-workflow-runtime-")),db=new DatabaseSync(":memory:"),journal=new ToolExecutionJournal(db);
  let dispatched=0,stopped=0;
  const service=createResearchWorkflowService(root,()=>({
    async call(tool,args,_signal,_authorization,options) {
      return invokeJournaledTool({journal,tool,arguments:args,operationId:options.operationId,scope:options.scope},async markDispatched=>{
        markDispatched();dispatched++;return {ok:true,fixture:"software adapter receipt only"};
      });
    },
    async stop(){stopped++;},
  }));
  t.after(async()=>{await service.close();db.close();await rm(root,{recursive:true,force:true});});
  const operationId=randomUUID(),request={tool:"mean",arguments:{values:[1,2,3]}},signal=new AbortController().signal;
  // Exercise the runtime dependency supplied to the production service. Recovery
  // replaces attemptId but retains operationId in the durable workflow record.
  const first=await service.dependencies.run(request,{attemptId:randomUUID(),operationId,signal});
  const second=await service.dependencies.run(request,{attemptId:randomUUID(),operationId,signal});
  assert.deepEqual(second,first);
  assert.equal(dispatched,1,"a recovered attempt replays the original receipt without another effect");
  assert.equal(stopped,2,"each invocation releases its owned client even when replaying");
  assert.deepEqual(journal.get(operationId).scope,{surface:"workflow",scopeId:operationId});
  assert.equal(journal.get(operationId).effect,"write");
  assert.deepEqual(JSON.parse(await readFile(join(root,"build/compute-inputs",`${operationId}.json`),"utf8")),request);
  await assert.rejects(service.dependencies.run({...request,arguments:{values:[9]}},{attemptId:randomUUID(),operationId,signal}),/COMPUTE_REQUEST_IDENTITY_CONFLICT/);
  assert.equal(dispatched,1);
});
