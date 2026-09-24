import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,readFile,writeFile,rm,mkdir} from "node:fs/promises";
import {randomUUID} from "node:crypto";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {AppDatabase} from "../src/main/services/database.ts";
import {loadFrozenPack,PACK_PATH,PACK_DIGEST_PATH,sha256,scoreFixture,summarizeEvaluation,runFrozenEvaluation,readEvaluationReport} from "../scripts/harness-evaluation-core.mjs";

const binding={modelId:"fixture-model",instanceId:"fixture-instance",contextLength:32768,ownedByWorkbench:false,observedAt:new Date().toISOString()};
const model={id:"fixture-model",providerModelId:"fixture/model",provider:"lmstudio",sizeBytes:1234,quantization:"fixture"};
const call=(emit,name,args)=>emit({usage:{prompt_tokens:20,completion_tokens:10,total_tokens:30},choices:[{finish_reason:"tool_calls",delta:{tool_calls:[{index:0,id:"provider-reuses-call-id",function:{name,arguments:JSON.stringify(args)}}]}}]});
function provider(overrides={}){return {getExecutionBinding:async()=>({...binding}),countPromptTokens:async()=>({tokens:256,method:"tokenizer"}),chat:async(_modelId,payload,emit)=>{
  const goal=payload.messages.find(m=>m.role==="user")?.content??"";
  if(!goal.startsWith("Read fixtures/input.json."))return call(emit,"harness_report_blocked",{reason:"Deterministic test adapter deliberately abstains.",unmet_requirements:["Fixture test intentionally performs no other categories."]});
  const results=payload.messages.filter(m=>m.role==="tool").map(m=>JSON.parse(m.content));
  if(results.length===0)return call(emit,"workspace_read",{path:"fixtures/input.json"});
  if(results.length===1){const raw=results[0].data??results[0];return call(emit,"workspace_propose_patch",{path:"build/result.json",content:JSON.stringify({value:JSON.parse(raw.content).record.label}),rationale:"Copy the observed fixture label."});}
  return call(emit,"harness_finish",{summary:"Copied the observed fixture value to the saved artifact."});
},...overrides};}
async function temporary(fn){const root=await mkdtemp(join(tmpdir(),"proto-harness-eval-"));try{return await fn(root);}finally{await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}}

test("frozen pack contains 30 software cases and rejects drift before any generation",async()=>temporary(async root=>{
  const frozen=await loadFrozenPack();assert.equal(frozen.pack.tasks.length,30);assert.equal(frozen.pack.tasks.filter(t=>!t.possible).length,6);assert.equal(new Set(frozen.pack.tasks.map(t=>t.category)).size,7);
  const path=join(root,"changed.json");await writeFile(path,(await readFile(PACK_PATH,"utf8"))+" ");await assert.rejects(loadFrozenPack(path,PACK_DIGEST_PATH),/DIGEST_MISMATCH/);
}));

test("independent scorer checks exact saved output and never accepts impossible fixture prose",async()=>{
  const {pack}=await loadFrozenPack(),task=pack.tasks[0];
  assert.equal((await scoreFixture(task,{read:async()=>({content:JSON.stringify(task.expected.value)})})).pass,true);
  assert.equal((await scoreFixture(task,{read:async()=>({content:'{"value":"invented"}'})})).pass,false);
  assert.equal((await scoreFixture(pack.tasks.at(-1),{read:async()=>({content:'{"verified":true}'})})).diagnostics[0].blockingClass,"conflicting");
});

test("report retains all outcomes and unknown tokens in separate frozen denominators",async()=>{
  const {pack}=await loadFrozenPack();const records=[
    {arm:"direct",caseId:pack.tasks[0].id,state:"completed",status:"success",validationPassed:true,tokens:30,toolCalls:3,wallTimeMs:5,duplicateEffects:1,recovery:{outputRepairs:1},diagnosticClasses:{repairable:2}},
    {arm:"direct",caseId:pack.tasks[1].id,state:"abstained",status:"refused",validationPassed:false,tokens:null},
    {arm:"direct",caseId:pack.tasks[2].id,state:"cancelled",status:"timeout",validationPassed:false,tokens:null},
    {arm:"direct",caseId:pack.tasks[3].id,state:"cancelled",status:"cancelled",validationPassed:false,tokens:null},
    {arm:"direct",caseId:pack.tasks.at(-1).id,state:"needs-human",status:"unsupported",validationPassed:false,tokens:12},
  ];
  const report=summarizeEvaluation(pack,records);assert.equal(report.arms.direct.taskCompletion.denominator,30);assert.equal(report.arms.direct.correctAbstention.count,1);assert.equal(report.arms.direct.falseAbstention.count,1);assert.equal(report.arms.direct.falseAbstention.denominator,24);assert.equal(report.arms.direct.tokens.unknownAttempts,3);assert.equal(report.arms.direct.statuses.timeout,1);assert.equal(report.arms.direct.statuses.cancelled,1);assert.equal(report.arms.direct.recovery.outputRepairs,1);assert.equal(report.arms.direct.diagnosticClasses.repairable,2);assert.equal(report.arms.direct.notStarted,25);
  assert.throws(()=>summarizeEvaluation(pack,[...records,records[0]]),/DUPLICATE/);
});

test("paired runner uses actual Harness workspace CAS and ledger, same instance, and digest-bound reopen",async()=>temporary(async root=>{
  const out=join(root,"campaign"),report=await runFrozenEvaluation({out,provider:provider(),model,instanceId:binding.instanceId});
  assert.equal(report.attempted,60);assert.equal(report.arms.direct.taskCompletion.count,6);assert.equal(report.arms.harness.taskCompletion.count,6);assert.equal(report.arms.harness.validation.count,6);assert.equal(report.arms.direct.falseAbstention.count,18);assert.equal(report.arms.harness.correctAbstention.count,6);
  assert.equal(report.arms.direct.toolCalls,42);assert.equal(report.arms.harness.toolCalls,42);assert.equal(report.arms.direct.externalToolCalls,12);assert.equal(report.arms.harness.externalToolCalls,12);
  const reopened=await readEvaluationReport(out);assert.deepEqual(reopened.arms,report.arms);assert.equal(reopened.interruptedStarts.length,0);
  const manifest=JSON.parse(await readFile(join(out,"campaign.json"),"utf8")),db=new AppDatabase(join(out,"evaluation.sqlite"));let attempts;try{attempts=db.listModelEvaluationAttempts(`${manifest.campaignId}:harness`);assert.equal(attempts.length,30);assert.ok(attempts.every(a=>a.instanceId===binding.instanceId&&a.scientificAnswer.result==="not-run"));}finally{db.close();}
  const path=join(out,"attempts",attempts[0].attemptId,"result.json");await writeFile(path,(await readFile(path,"utf8"))+" ");await assert.rejects(readEvaluationReport(out),/RESULT_DIGEST_MISMATCH/);
}));

test("cancellation retains the active attempt and stops remaining slots without inventing successes",async()=>temporary(async root=>{
  const cancelled=new AbortController(),out=join(root,"cancelled");
  const report=await runFrozenEvaluation({out,model,instanceId:binding.instanceId,signal:cancelled.signal,provider:provider({chat:async(_id,_payload,_emit,signal)=>{cancelled.abort(Object.assign(new Error("Operator cancellation"),{code:"EVALUATION_CANCELLED"}));signal.throwIfAborted();}})});
  assert.equal(report.attempted,1);assert.equal(report.arms.direct.statuses.cancelled,1);assert.equal(report.arms.direct.tokens.unknownAttempts,1);assert.equal(report.arms.harness.notStarted,30);assert.equal((await readEvaluationReport(out)).attempted,1);
}));

test("exact instance mismatch fails before creating a campaign",async()=>temporary(async root=>{
  await assert.rejects(runFrozenEvaluation({out:join(root,"never-created"),provider:provider(),model,instanceId:"other-instance"}),/EXACT_INSTANCE_REQUIRED/);
}));

test("wall timeout is durable and never disappears from the sixty-slot denominator",async()=>temporary(async root=>{
  let calls=0;const fallback=provider(),out=join(root,"timeout"),report=await runFrozenEvaluation({out,model,instanceId:binding.instanceId,attemptMs:1000,provider:provider({chat:async(...args)=>{
    if(calls++===0){const signal=args[3];await new Promise((resolve,reject)=>{signal.addEventListener("abort",()=>reject(signal.reason),{once:true});});}else await fallback.chat(...args);
  }})});
  assert.equal(report.attempted,60);assert.equal(report.arms.direct.statuses.timeout,1);assert.equal(report.arms.direct.taskCompletion.denominator,30);assert.equal(report.arms.direct.tokens.unknownAttempts,1);assert.equal((await readEvaluationReport(out)).arms.direct.statuses.timeout,1);
}));

test("hard interruption start remains an unknown-usage attempt without mutating historical ledger",async()=>temporary(async root=>{
  const controller=new AbortController(),out=join(root,"interrupted");await runFrozenEvaluation({out,model,instanceId:binding.instanceId,signal:controller.signal,provider:provider({chat:async()=>{controller.abort();throw controller.signal.reason;}})});
  const manifestBytes=await readFile(join(out,"campaign.json")),manifest=JSON.parse(manifestBytes),{pack}=await loadFrozenPack(),attemptId=randomUUID(),dir=join(out,"attempts",attemptId);await mkdir(dir);
  await writeFile(join(dir,"started.json"),JSON.stringify({attemptId,evaluationId:`${manifest.campaignId}:harness`,arm:"harness",caseId:pack.tasks[0].id,caseSha256:sha256(pack.tasks[0]),taskPackSha256:manifest.taskPackSha256,campaignSha256:sha256(manifestBytes),identity:manifest.identity,startedAt:new Date().toISOString()}));
  const report=await readEvaluationReport(out);assert.equal(report.attempted,2);assert.equal(report.arms.harness.statuses.interrupted,1);assert.equal(report.arms.harness.unknownMeasurements.toolCalls,1);assert.equal(report.arms.harness.tokens.unknownAttempts,1);
  const db=new AppDatabase(join(out,"evaluation.sqlite"));try{assert.equal(db.listModelEvaluationAttempts(`${manifest.campaignId}:harness`).length,0);}finally{db.close();}
}));

test("instance changes after generation retain a failure and halt the paired campaign",async()=>temporary(async root=>{
  let changed=false;const fallback=provider(),out=join(root,"drift");const report=await runFrozenEvaluation({out,model,instanceId:binding.instanceId,provider:provider({getExecutionBinding:async()=>({...binding,instanceId:changed?"replacement-instance":binding.instanceId}),chat:async(...args)=>{await fallback.chat(...args);changed=true;}})});
  assert.equal(report.attempted,1);assert.equal(report.arms.direct.statuses.error,1);assert.equal(report.arms.direct.taskCompletion.count,0);assert.equal(report.arms.harness.notStarted,30);
}));
