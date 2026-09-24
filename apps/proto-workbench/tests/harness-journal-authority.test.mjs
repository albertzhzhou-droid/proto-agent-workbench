import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdir,mkdtemp,rm,readFile } from "node:fs/promises";
import { join,resolve } from "node:path";
import test from "node:test";
import { HarnessStore } from "../src/main/services/harness-store.ts";
import { ToolExecutionJournal } from "../src/main/services/tool-execution-journal.ts";
import { invokeJournaledTool,recordPolicyDenial } from "../src/main/services/execution-kernel.ts";
import { executionActivity,completionGate } from "../src/main/services/turn-engine.ts";
import { AppDatabase } from "../src/main/services/database.ts";
import { WorkspaceFiles } from "../src/main/services/workspace-files.ts";
import { HarnessWorkspace } from "../src/main/services/harness-workspace.ts";
import { McpClient } from "../src/main/services/mcp-client.ts";
import { openWorkspaceExecutionJournal } from "../src/main/services/workspace-execution-journal.ts";

function rig(){
  const ledger=new DatabaseSync(":memory:"),profile=new DatabaseSync(":memory:"),journal=new ToolExecutionJournal(ledger),store=new HarnessStore(profile,journal);
  return {ledger,profile,journal,store,close(){profile.close();ledger.close();}};
}
const scope={surface:"harness",scopeId:"run-1"};
const input=(journal,tool="proto_compute_run",operationId="call-1")=>({journal,operationId,scope,tool,arguments:{path:"build/input.json"}});

for(const effect of ["read","write"])for(const fault of ["intent","dispatched","server-rejection","tool-error","timeout","process-exit"]){
  test(`Harness journal-first fault matrix ${effect}/${fault}: shared gate and no independent ledger authority`,async()=>{
    const r=rig(),call=input(r.journal,effect==="write"?"proto_compute_run":"proto_compute_catalog");
    r.store.intent(scope.scopeId,call.operationId,call.tool,call.arguments,effect);
    try{
      const receipt=await invokeJournaledTool(call,async mark=>{
        if(fault==="intent")throw new Error("Intent crash");
        mark();
        if(fault==="tool-error")return {isError:true,content:[{type:"text",text:"Tool error"}]};
        if(fault==="server-rejection")throw Object.assign(new Error("No effect"),{effectState:"none"});
        throw new Error(`Injected ${fault}`);
      });
      r.store.record(scope.scopeId,call.operationId,call.tool,receipt);
    }catch(error){if(error.effectState==="none")r.store.record(scope.scopeId,call.operationId,call.tool,{ok:false,effect_state:"none",message:error.message});}
    const record=r.journal.get(call.operationId),unknown=effect==="write"&&["dispatched","timeout","process-exit"].includes(fault);
    assert.equal(r.store.uncertainEffect(scope.scopeId,call.operationId),unknown);
    assert.equal(r.store.recoveryReport().disagreements,0);
    assert.equal(r.store.recoveryReport().legacyFallbackCalls,0);
    const chatActivity=executionActivity(call.operationId,"complete",record),harnessActivity=r.store.activityForCall(scope.scopeId,call.operationId);
    assert.equal(harnessActivity.evidenceSource,"journal");
    assert.equal(completionGate([chatActivity]),completionGate([harnessActivity]));
    assert.equal(completionGate([harnessActivity]),"incomplete-evidence");
    r.close();
  });
}

test("a stale successful cache cannot override an unknown durable write; disagreement is persistent and bounded",async()=>{
  const r=rig(),call=input(r.journal);
  r.store.intent(scope.scopeId,call.operationId,call.tool,call.arguments,"write");
  r.store.record(scope.scopeId,call.operationId,call.tool,{ok:true});
  await assert.rejects(invokeJournaledTool(call,async mark=>{mark();throw new Error("Lost result");}));
  assert.equal(r.store.resultForCall(scope.scopeId,call.operationId),undefined);
  assert.equal(r.store.uncertainEffect(scope.scopeId,call.operationId),true);
  assert.equal(r.store.uncertainEffect(scope.scopeId,call.operationId),true);
  assert.equal(new HarnessStore(r.profile,r.journal).recoveryReport().disagreements,1);
  assert.equal(completionGate(r.store.executionActivities(scope.scopeId)),"incomplete-evidence");
  r.close();
});

test("workspace journal recovery remains available with an empty second profile and no duplicate effect rows",async t=>{
  const base=resolve("build/test-harness-portability");await mkdir(base,{recursive:true});const root=await mkdtemp(join(base,"case-"));
  t.after(()=>rm(root,{recursive:true,force:true}));
  let ledger=new DatabaseSync(join(root,"execution.sqlite")),journal=new ToolExecutionJournal(ledger);
  let profile=new DatabaseSync(join(root,"profile-one.sqlite")),store=new HarnessStore(profile,journal);
  const call=input(journal);store.intent(scope.scopeId,call.operationId,call.tool,call.arguments,"write");
  await assert.rejects(invokeJournaledTool(call,async mark=>{mark();throw new Error("Crash");}));
  profile.close();ledger.close();
  ledger=new DatabaseSync(join(root,"execution.sqlite"));journal=new ToolExecutionJournal(ledger);
  profile=new DatabaseSync(join(root,"profile-two.sqlite"));store=new HarnessStore(profile,journal);
  assert.equal(store.uncertainEffect(scope.scopeId,call.operationId),true);
  assert.equal(profile.prepare("SELECT COUNT(*) AS n FROM harness_effects").get().n,0);
  assert.equal(completionGate(store.executionActivities(scope.scopeId)),"incomplete-evidence");
  journal.reconcile(call.operationId,"applied","reviewer","build/verified-proof.json");
  assert.equal(store.uncertainEffect(scope.scopeId,call.operationId),false);
  assert.equal(completionGate(store.executionActivities(scope.scopeId)),"incomplete-evidence","an applied effect alone proves no successful execution");
  journal.recordReconciledReceipt(call.operationId,{ok:true,artifacts:["build/result.json"]});
  assert.equal(store.resultForCall(scope.scopeId,call.operationId).ok,true);
  assert.equal(completionGate(store.executionActivities(scope.scopeId)),"complete");
  assert.equal(ledger.prepare("SELECT COUNT(*) AS n FROM tool_execution_journal WHERE operation_id=?").get(call.operationId).n,1);
  profile.close();ledger.close();
});

test("legacy fallback is explicit and Harness migrations preserve checkpoint and result bytes",()=>{
  const r=rig();r.store.intent(scope.scopeId,"legacy","proto_compute_run",{},"write");
  assert.equal(r.store.uncertainEffect(scope.scopeId,"legacy"),true);
  assert.equal(r.store.recoveryReport().legacyFallbackCalls,1);
  const report=new HarnessStore(r.profile,r.journal).migrationReport;
  assert.equal(report.namespace,"harness-store");assert.ok(report.entries.every(entry=>entry.status==="verified"));
  assert.equal(r.profile.prepare("SELECT arguments_json FROM harness_effects WHERE call_id='legacy'").get().arguments_json,"{}");
  r.close();
});

for(const envelope of ["raw","structured","outer"])test(`applied effect review cannot promote an ambiguous successful ${envelope} receipt to completion`,async()=>{
  const r=rig(),call=input(r.journal),ambiguous={ok:true,effect_state:"unknown",artifacts:["build/result.json"]};
  const original=envelope==="raw"?ambiguous:envelope==="structured"?{structuredContent:ambiguous,content:[{type:"text",text:"Effect could not be established."}]}:{effect_state:"unknown",structuredContent:{ok:true,artifacts:["build/result.json"]}};
  let dispatched=0;
  await invokeJournaledTool(call,async mark=>{mark();dispatched++;return original;});
  assert.equal(r.journal.get(call.operationId).outcome,"ok","the original software observation is retained");
  r.journal.reconcile(call.operationId,"applied","reviewer","build/effect-proof.json");
  const reviewed=r.journal.get(call.operationId);
  assert.deepEqual(reviewed.receipt,original);
  assert.equal(reviewed.outcome,"ok");
  assert.equal(completionGate([executionActivity(call.operationId,"complete",reviewed)]),"incomplete-evidence");
  const result=r.store.resultForCall(scope.scopeId,call.operationId);
  assert.equal(result.ok,false,"even a newly restored cache uses the durable completion guard");
  assert.equal(r.store.read(scope.scopeId,result.handle).ok,false);
  assert.equal(completionGate(r.store.executionActivities(scope.scopeId)),"incomplete-evidence");
  await assert.rejects(invokeJournaledTool(call,async mark=>{mark();dispatched++;return {ok:true};}),error=>error.code==="TOOL_OPERATION_RECONCILED");
  assert.equal(dispatched,1);
  for(const effect_state of ["unknown","none"]) {
    assert.throws(()=>r.journal.recordReconciledReceipt(call.operationId,{ok:true,structuredContent:{ok:true,effect_state}}),/TOOL_RECOVERY_RECEIPT_EFFECT_CONFLICT/);
    assert.equal(r.journal.get(call.operationId).recoveredReceipt,undefined);
  }
  r.journal.recordReconciledReceipt(call.operationId,{ok:true,effect_state:"committed",artifacts:["build/result.json"]});
  assert.deepEqual(r.journal.get(call.operationId).receipt,original);
  const historical=r.store.read(scope.scopeId,result.handle),recovered=r.store.resultForCall(scope.scopeId,call.operationId);
  assert.equal(historical.ok,false,"the historical unknown receipt never becomes successful data");
  assert.equal(historical.sha256,result.sha256);assert.deepEqual(historical.data,result.data);
  assert.equal(recovered.ok,true);assert.notEqual(recovered.handle,result.handle);
  assert.equal(recovered.data.effect_state,"committed");
  assert.equal(r.store.read(scope.scopeId,recovered.handle).sha256,recovered.sha256);
  assert.equal(r.store.resultForCall(scope.scopeId,call.operationId).handle,recovered.handle);
  assert.equal(completionGate(r.store.executionActivities(scope.scopeId)),"complete");
  r.close();
});

test("canonical IDs and paginated metadata are persisted without loading receipt bodies",async()=>{
  const r=rig();for(let i=0;i<4;i++)await invokeJournaledTool(input(r.journal,"proto_compute_run",`call-${i}`),async mark=>{mark();return {ok:true,text:"x".repeat(10000)};});
  r.ledger.exec("UPDATE tool_execution_journal SET receipt_json='corrupt' WHERE operation_id='call-0'");
  const page=r.journal.listPage({surface:"harness",scopeId:scope.scopeId,limit:2,offset:0});
  assert.equal(page.total,4);assert.equal(page.records.length,2);assert.equal(page.records[0].capabilityId,"compute.run");
  assert.ok(page.records.every(record=>record.receipt===undefined));
  assert.equal(r.journal.recoverySummary().unknownEffects,0);
  assert.throws(()=>r.journal.listPage({limit:201}),/PAGE_INVALID/);r.close();
});

test("policy decisions cannot be attached to a different operation and denial never dispatches",async()=>{
  const r=rig(),call=input(r.journal),decision={decisionId:"denied",tool:call.tool,surface:"harness",scopeId:scope.scopeId,operationId:call.operationId,allowed:false,code:"POLICY_DENIED",requiredRisk:"write",reason:"No scope",decidedAt:new Date().toISOString()};
  assert.throws(()=>recordPolicyDenial({...call,decision:{...decision,scopeId:"wrong"}}),error=>error.code==="POLICY_DENIED");
  assert.equal(r.journal.get(call.operationId),undefined);
  await assert.rejects(invokeJournaledTool({...call,decision},async()=>{throw new Error("Dispatched denied call");}),error=>error.code==="POLICY_DENIED");
  assert.equal(r.journal.get(call.operationId).state,"no-effect");r.close();
});

test("shared completion recognizes only exact durable retries and never hides an unreconciled effect",async()=>{
  const r=rig();
  await invokeJournaledTool(input(r.journal,"proto_compute_run","failed"),async mark=>{mark();return {ok:false,effect_state:"none"};});
  await invokeJournaledTool(input(r.journal,"proto_compute_run","retry"),async mark=>{mark();return {ok:true};});
  const activities=()=>r.journal.list(scope).map(record=>executionActivity(record.operationId,"complete",record));
  assert.equal(completionGate(activities()),"complete");
  await assert.rejects(invokeJournaledTool(input(r.journal,"proto_compute_run","unknown"),async mark=>{mark();throw new Error("Unknown");}));
  assert.equal(completionGate(activities()),"incomplete-evidence");r.close();
});

test("host source writes reconcile through one journal with a portable hash-bound inspection proof",async t=>{
  const base=resolve("build/test-harness-source-authority");await mkdir(base,{recursive:true});const root=await mkdtemp(join(base,"case-"));
  const database=new AppDatabase(join(root,"profile.sqlite")),owned=openWorkspaceExecutionJournal(root),store=new HarnessStore(database.db,owned.journal);
  const mcp=new McpClient({packaged:false,resourcesPath:root,repoRoot:root,workspacePath:root,workspaceCapability:"42".repeat(32)},{journal:owned.journal});
  t.after(async()=>{await mcp.stop();database.close();owned.close();await rm(root,{recursive:true,force:true});});
  const workspace=new WorkspaceFiles(root,database),files=new HarnessWorkspace(workspace,database,mcp,store,async()=>[],()=>{});
  const c={createdAt:new Date().toISOString(),contract:{runId:"source-run",workspacePath:root,mode:"act",scope:{writeRoots:["build"],network:false,execution:false},budgets:{activeTimeMs:30000}},activeTimeMs:0,resultHandles:[],deliveredPaths:[]};
  const args={path:"build/report.md",content:"# Controlled document\n",rationale:"Journal recovery test"};
  const complete=owned.journal.complete.bind(owned.journal);
  owned.journal.complete=()=>{throw new Error("Crash after result preparation before journal receipt");};
  await assert.rejects(files.execute("workspace_propose_patch",args,"source-call",c,new AbortController().signal));
  owned.journal.complete=complete;
  assert.equal(owned.journal.get("source-call").state,"effect-unknown");
  const recovered=await files.reconcile("workspace_propose_patch",args,"source-call",c,new AbortController().signal);
  assert.equal(recovered.ok,true);
  assert.equal(owned.journal.get("source-call").state,"reconciled-applied");
  assert.equal(owned.journal.get("source-call").recoveredReceipt.ok,true);
  const history=owned.journal.reconciliationHistory("source-call");assert.equal(history.length,1);
  assert.match(history[0].evidenceRef,/^build\/harness-reconciliation\/.+\.json#sha256=[a-f0-9]{64}$/);
  const proof=JSON.parse(await readFile(join(root,history[0].evidenceRef.split("#")[0]),"utf8"));
  assert.equal(proof.operationId,"source-call");assert.equal(proof.patchOperationId,database.listPatchOperations("source-run")[0].id);
  assert.equal(store.uncertainEffect("source-run","source-call"),false);
  assert.equal(store.resultForCall("source-run","source-call").ok,true);
  assert.equal(await readFile(join(root,"build/report.md"),"utf8"),args.content);
});
