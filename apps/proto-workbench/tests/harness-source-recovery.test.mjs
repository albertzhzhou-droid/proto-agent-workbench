import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { AppDatabase } from "../src/main/services/database.ts";
import { WorkspaceFiles } from "../src/main/services/workspace-files.ts";
import { HarnessStore } from "../src/main/services/harness-store.ts";
import { HarnessWorkspace } from "../src/main/services/harness-workspace.ts";
import { validationPlanForPatch } from "../src/main/services/validation-journal.ts";
import { withWorkspaceWrite } from "../src/main/services/workspace-execution-queue.ts";

const evidenceRoot = fileURLToPath(new URL("../../../build/upgrade-20260904/source-recovery-tests/", import.meta.url));
const sha = content => createHash("sha256").update(content).digest("hex");
const signal = () => new AbortController().signal;

async function rig(t) {
  await mkdir(evidenceRoot, {recursive:true});
  const root = await mkdtemp(join(evidenceRoot, "case-"));
  await mkdir(join(root,"build"));
  let database, workspace, store, files, injected;
  let scientificRead = async()=>{throw Error("Unexpected scientific tool execution");};
  let writes = 0, validations = 0;
  const databasePath = join(root,"state.sqlite");
  const validate = async (patch, operationId) => {
    validations++;
    if (injected) return injected(patch,operationId);
    const operation = database.getPatchOperation(operationId);
    let journal = database.prepareValidationJournal(operationId,validationPlanForPatch(patch,operation));
    const events=[];
    for(const step of journal.steps) {
      if(step.state==="completed") {events.push(database.getRunEvent(step.eventId));continue;}
      const event={id:randomUUID(),runId:patch.runId,stage:step.key==="review-packet"?"review":"validate",actor:"tool",title:step.title,summary:"Controlled software-only validation receipt",inputProvenance:[],outputArtifacts:[],evidenceIds:[],status:"running",createdAt:new Date().toISOString()};
      journal=database.beginValidationJournalStep(operationId,journal.revision,step.key,event);
      event.status="completed";event.completedAt=new Date().toISOString();
      journal=database.finishValidationJournalStep(operationId,journal.revision,step.key,event);
      events.push(event);
    }
    return events;
  };
  const reopen=()=>{
    database?.close();database=new AppDatabase(databasePath);store=new HarnessStore(database.db);workspace=new WorkspaceFiles(root,database);
    const original=workspace.applyApprovedPatch.bind(workspace);
    workspace.applyApprovedPatch=async(...args)=>{writes++;return original(...args);};
    files=new HarnessWorkspace(workspace,database,{call:(...args)=>scientificRead(...args)},store,validate,()=>{});
  };
  reopen();
  t.after(async()=>{database.close();await rm(root,{recursive:true,force:true});});
  const c={contract:{schema:"proto-workbench.mission.v1",runId:"controlled-run",threadId:"controlled-thread",workspacePath:root,goal:"Write a controlled software document",modelId:"test-only",mode:"act",contextTokens:32768,scope:{writeRoots:["build"],network:false,execution:false},deliverables:[],budgets:{activeTimeMs:30000,maxRounds:12,maxGeneratedTokens:12000}},round:0,activeTimeMs:0,generatedTokens:0,resultHandles:[],deliveredPaths:[]};
  const apply=(call="write-1",path="build/report.md")=>files.execute("workspace_propose_patch",{path,content:"# Controlled software fixture\n",rationale:"Recovery regression fixture"},call,c,signal());
  return {root,c,apply,reopen,set injected(value){injected=value;},set scientificRead(value){scientificRead=value;},get database(){return database;},get workspace(){return workspace;},get store(){return store;},get files(){return files;},get writes(){return writes;},get validations(){return validations;}};
}

test("queued source cancellation is proved none before any proposal or write",async t=>{
  const r=await rig(t);let release,acquired;
  const gate=new Promise(resolve=>{release=resolve;}),ready=new Promise(resolve=>{acquired=resolve;});
  const held=withWorkspaceWrite(r.root,signal(),async()=>{acquired();await gate;});await ready;
  const abort=new AbortController();
  const pending=r.files.execute("workspace_propose_patch",{path:"build/report.md",content:"fixture",rationale:"fixture"},"queued",r.c,abort.signal);
  abort.abort(Object.assign(new Error("Paused while queued"),{code:"HARNESS_PAUSED"}));
  await assert.rejects(pending,error=>error.effectState==="none");
  assert.equal(r.writes,0);assert.equal(r.database.listPatchOperations(r.c.contract.runId).length,0);
  release();await held;
  assert.equal((await r.files.reconcile("workspace_propose_patch",{},"queued",r.c,signal())).code,"SOURCE_WRITE_NOT_STARTED");
});

test("restart between operation completion and Harness result commit reopens exact staged receipt",async t=>{
  const r=await rig(t);const result=await r.apply();assert.equal(result.ok,true);
  assert.equal(r.store.resultForCall(r.c.contract.runId,"write-1"),undefined);
  r.reopen();
  const recovered=await r.files.reconcile("workspace_propose_patch",{},"write-1",r.c,signal());
  assert.equal(recovered.ok,true);assert.equal(recovered.recovered,true);
  assert.equal(recovered._harnessArtifacts[0].sha256,sha(await readFile(join(r.root,"build/report.md"))));
  assert.equal(r.writes,1);assert.equal(r.validations,1);
  r.store.record(r.c.contract.runId,"write-1","workspace_propose_patch",recovered);
  assert.equal(r.store.uncertainEffect(r.c.contract.runId,"write-1"),false);
});

test("source retained before validation is continued through its existing operation without reapply",async t=>{
  const r=await rig(t);r.injected=async()=>{throw Error("Crash after source CAS before validation starts");};
  await assert.rejects(r.apply(),/Crash/);r.reopen();r.injected=undefined;
  const recovered=await r.files.reconcile("workspace_propose_patch",{},"write-1",r.c,signal());
  assert.equal(recovered.code,"SOURCE_VALIDATION_INCOMPLETE");assert.equal(recovered.effect_state,"committed");
  const resumed=await r.files.execute("workspace_resume_validation",recovered.resume_arguments,"resume-1",r.c,signal());
  assert.equal(resumed.ok,true);assert.equal(resumed.operation.id,recovered.operation_id);
  assert.equal(r.writes,1);assert.equal(r.validations,2);
  assert.equal(r.database.getValidationJournal(resumed.operation.id).state,"completed");
});

test("completed journal reconstructs lost receipt without another validation or source write",async t=>{
  const r=await rig(t);r.store.stageSourceReceipt=()=>{throw Error("Crash before staging receipt");};
  await assert.rejects(r.apply(),/Crash before/);r.reopen();
  const recovered=await r.files.reconcile("workspace_propose_patch",{},"write-1",r.c,signal());
  assert.equal(recovered.ok,true);assert.equal(recovered.validation.steps.length,3);
  assert.equal(r.writes,1);assert.equal(r.validations,1);
});

test("changed source, changed material library and foreign run cannot resume validation",async t=>{
  const r=await rig(t);await writeFile(join(r.root,"build/toy-parts.json"),"{\"fixture\":true}");
  const library=await r.workspace.read("build/toy-parts.json");r.c.contract.materialBinding={partsPath:library.path,partsSha256:library.sha256};
  r.injected=async()=>{throw Error("Interrupted validation");};await assert.rejects(r.apply());
  const operation=r.database.listPatchOperations(r.c.contract.runId)[0];r.injected=undefined;
  await writeFile(library.path,"changed fixture library");
  assert.equal((await r.files.execute("workspace_resume_validation",{operation_id:operation.id},"changed-library",r.c,signal())).code,"VALIDATION_INPUT_CHANGED");
  await writeFile(library.path,"{\"fixture\":true}");await writeFile(operation.targetPath,"Changed by another editor");
  assert.equal((await r.files.execute("workspace_resume_validation",{operation_id:operation.id},"changed-source",r.c,signal())).code,"VALIDATION_INPUT_CHANGED");
  const other={...r.c,contract:{...r.c.contract,runId:"foreign"}};
  assert.equal((await r.files.execute("workspace_resume_validation",{operation_id:operation.id},"foreign",other,signal())).code,"VALIDATION_RUN_MISMATCH");
  assert.equal(r.validations,1);assert.equal(r.writes,1);
});

test("unknown artifact validation effect remains blocked and is never replayed",async t=>{
  const r=await rig(t);await writeFile(join(r.root,"build/toy-parts.json"),"{\"fixture\":true}");
  const library=await r.workspace.read("build/toy-parts.json");r.c.contract.materialBinding={partsPath:library.path,partsSha256:library.sha256};
  r.injected=async(patch,operationId)=>{
    const operation=r.database.getPatchOperation(operationId);let journal=r.database.prepareValidationJournal(operationId,validationPlanForPatch(patch,operation));
    for(const step of journal.steps.slice(0,3)){
      const event={id:randomUUID(),runId:patch.runId,stage:"validate",actor:"tool",title:step.title,summary:"Controlled interrupted artifact fixture",inputProvenance:[],outputArtifacts:[],evidenceIds:[],status:"running",createdAt:new Date().toISOString()};
      journal=r.database.beginValidationJournalStep(operationId,journal.revision,step.key,event);
      event.status=step.effect==="artifact-write"?"effect-unknown":"completed";
      journal=r.database.finishValidationJournalStep(operationId,journal.revision,step.key,event);
    }
    throw Error("Interrupted artifact write");
  };
  await assert.rejects(r.apply("dna-write","build/toy.proto"));r.injected=undefined;
  const operation=r.database.listPatchOperations(r.c.contract.runId)[0];
  assert.equal(await r.files.reconcile("workspace_propose_patch",{},"dna-write",r.c,signal()),undefined);
  assert.equal((await r.files.execute("workspace_resume_validation",{operation_id:operation.id},"blocked-resume",r.c,signal())).code,"VALIDATION_EFFECT_UNKNOWN");
  assert.equal(r.writes,1);assert.equal(r.validations,1);
});

test("prepared but untouched operation is retired without keeping the target locked",async t=>{
  const r=await rig(t);const original=r.workspace.applyApprovedPatch.bind(r.workspace);
  r.workspace.applyApprovedPatch=async(id,revision)=>{
    const patch=r.database.getPatch(id);
    r.database.preparePatchOperation(id,revision,{targetPath:patch.targetPath,existed:false,content:"",sha256:sha(""),resultSha256:sha(patch.after),resultExists:true});
    throw Error("Crash before atomic replacement");
  };
  await assert.rejects(r.apply());r.workspace.applyApprovedPatch=original;
  assert.equal((await r.files.reconcile("workspace_propose_patch",{},"write-1",r.c,signal())).code,"SOURCE_WRITE_NOT_RETAINED");
  assert.equal((await r.apply("fresh-write")).ok,true);
});

test("recovered provenance proof is bound to bytes before and after the read-only verifier",async t=>{
  const r=await rig(t);await writeFile(join(r.root,"build/toy-parts.json"),"{\"fixture\":true}");
  const library=await r.workspace.read("build/toy-parts.json");r.c.contract.materialBinding={partsPath:library.path,partsSha256:library.sha256};
  const provenancePath=join(r.root,"build/toy-provenance.json"),provenanceText="{\"software_test_fixture\":true}";
  await writeFile(provenancePath,provenanceText);
  // This test checks transport/digest binding, not scientific validity of the toy document.
  r.injected=async(patch,operationId)=>{
    let journal=r.database.prepareValidationJournal(operationId,validationPlanForPatch(patch,r.database.getPatchOperation(operationId)));const events=[];
    for(const step of journal.steps){
      const event={id:randomUUID(),runId:patch.runId,stage:"validate",actor:"tool",title:step.title,summary:"Controlled verifier transport fixture",tool:step.key==="proto-workflow"?"proto_workflow_run":undefined,inputProvenance:[],outputArtifacts:[],evidenceIds:[],status:"running",createdAt:new Date().toISOString()};
      journal=r.database.beginValidationJournalStep(operationId,journal.revision,step.key,event);
      if(step.key==="proto-workflow"){const output={ok:true,provenance_path:provenancePath};event.payload={...event.payload,output,outputSha256:sha(JSON.stringify(output))};}
      event.status="completed";journal=r.database.finishValidationJournalStep(operationId,journal.revision,step.key,event);events.push(event);
    }
    return events;
  };
  r.store.stageSourceReceipt=()=>{throw Error("Crash before receipt");};await assert.rejects(r.apply("proof","build/toy.proto"));r.reopen();
  const tools=[];r.scientificRead=async(name,args)=>{tools.push(name);assert.equal(args.path,"build/toy-provenance.json");return{ok:true};};
  const recovered=await r.files.reconcile("workspace_propose_patch",{},"proof",r.c,signal());
  assert.deepEqual(recovered._harnessRecoveredProvenance,{path:provenancePath,sha256:sha(provenanceText)});
  assert.deepEqual(recovered.artifacts,[join(r.root,"build/toy.proto")]);assert.deepEqual(tools,["proto_provenance_verify"]);
  r.scientificRead=async()=>{await writeFile(provenancePath,"changed during verification");return{ok:true};};
  assert.equal(await r.files.reconcile("workspace_propose_patch",{},"proof",r.c,signal()),undefined);
  assert.equal(r.writes,1);assert.equal(r.validations,1);
});
