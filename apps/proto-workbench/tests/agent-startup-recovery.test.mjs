import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {mkdir,mkdtemp,readFile,rm} from "node:fs/promises";
import {resolve,join,relative,isAbsolute} from "node:path";
import {AgentService} from "../src/main/services/agent-service.ts";
import {AppDatabase} from "../src/main/services/database.ts";
import {WorkspaceFiles} from "../src/main/services/workspace-files.ts";
import {HarnessStore} from "../src/main/services/harness-store.ts";
import {HARNESS_DEFAULTS} from "../src/shared/harness.ts";

const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
async function within(promise){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error("Lifecycle test timed out")),5000);})]);}finally{clearTimeout(timer);}}
async function ownedRoot(t){const base=resolve("build/test-agent-startup-recovery");await mkdir(base,{recursive:true});const root=await mkdtemp(join(base,"case-"));await mkdir(join(root,"build"));t.after(async()=>{const child=relative(base,root);assert.ok(child&&!child.startsWith("..")&&!isAbsolute(child));await rm(root,{recursive:true,force:true});});return root;}
function service(db,root,options={}){
  const terminal=deferred(),events=[],sessions=[];
  const model={id:"lifecycle-fixture",name:"Controlled model fixture",loadState:"active"};
  let chats=0;
  const models={get:()=>model,getActiveModel:()=>model,getExecutionBinding:async()=>({modelId:model.id,instanceId:options.instanceId??"instance-before",contextLength:32768}),countExecutionTokens:async()=>({tokens:1000,method:"exact"}),chat:async(_id,payload,chunk,signal)=>{
    chats++;signal.throwIfAborted();const turn=options.turns?.shift();
    if(typeof turn==="function")return turn(payload,chunk,signal);
    if(!turn)throw new Error("Unexpected model generation");
    chunk({usage:{completion_tokens:10},choices:[{finish_reason:"tool_calls",delta:{tool_calls:[{index:0,function:{name:turn[0],arguments:JSON.stringify(turn[1])}}]}}]});
  }};
  const mcp={fork(){const child={stopped:false,tools:async()=>options.discovery?options.discovery(child):[],stop:async()=>{options.onStop?.(child);child.stopped=true;}};sessions.push(child);return child;}};
  const agent=new AgentService(db,models,new WorkspaceFiles(root,db),mcp,event=>{events.push(event);if(["message-complete","error"].includes(event.type))terminal.resolve(event);},undefined,root);
  return{agent,terminal:terminal.promise,events,sessions,get chats(){return chats;}};
}
function seed(agent,db,root,state,{unknown=false}={}){
  const thread=agent.createThread({workspacePath:root,title:`Saved ${state}`,mode:"act",modelId:"lifecycle-fixture"}),now=new Date().toISOString(),runId=randomUUID();
  db.recordRunStart({id:randomUUID(),runId,stage:"goal",actor:"user",title:"Controlled saved mission",summary:"",inputProvenance:[],outputArtifacts:[],evidenceIds:[],status:"completed",createdAt:now,completedAt:now},thread.id,root);
  const store=new HarnessStore(db.db),receipt=store.record(runId,"completed-read","workspace_read",{ok:true,content:"Original recorded result"});
  const pending={id:"unfinished-write",type:"function",function:{name:"workspace_propose_patch",arguments:JSON.stringify({path:"build/result.md",content:"Not applied by startup",rationale:"Fixture"})}};
  if(unknown)store.intent(runId,pending.id,pending.function.name,JSON.parse(pending.function.arguments),"write");
  const checkpoint={schema:"proto-workbench.execution.v1",revision:0,contract:{schema:"proto-workbench.mission.v1",runId,threadId:thread.id,workspacePath:root,goal:"Controlled saved mission",modelId:"lifecycle-fixture",mode:"act",contextTokens:32768,scope:{writeRoots:["build"],network:false,execution:false},deliverables:[],budgets:{activeTimeMs:HARNESS_DEFAULTS.activeTimeMs,maxRounds:128,maxGeneratedTokens:65536}},state,messages:[{role:"user",content:"Original immutable constraint"}],round:3,generatedTokens:321,activeTimeMs:4567,inFlightGenerationTokens:123,pendingCalls:unknown?[pending]:[],completedCalls:["completed-read"],resultHandles:[receipt.handle],deliveredPaths:[],fullContent:"",createdAt:now,updatedAt:now,hostRecovered:false};
  store.save(checkpoint);return structuredClone(checkpoint);
}

test("actual database reopen recovers every orphan nonterminal phase without replay or usage refund",async t=>{
  const root=await ownedRoot(t),dbPath=join(root,"state.sqlite");let db=new AppDatabase(dbPath);
  const first=service(db,root),active=["queued","preparing","generating","executing","checkpointing","validating","recovering"];
  const originals=active.map(state=>seed(first.agent,db,root,state));
  const unknown=seed(first.agent,db,root,"executing",{unknown:true});
  const terminal=["completed","cancelled","incomplete","paused","effect-unknown","failed"].map(state=>seed(first.agent,db,root,state));
  const foreignRoot=join(root,"other-workspace"),foreign=seed(service(db,foreignRoot).agent,db,foreignRoot,"generating");
  db.close();db=new AppDatabase(dbPath);
  try{
    const restarted=service(db,root),store=new HarnessStore(db.db);
    for(const before of originals){const after=store.get(before.contract.runId);assert.equal(after.state,"paused");assert.equal(after.revision,before.revision+1);assert.equal(after.error.code,"HARNESS_INTERRUPTED");assert.match(after.error.message,/application or workspace service stopped/i);assert.deepEqual(after.contract,before.contract);assert.equal(after.generatedTokens,before.generatedTokens);assert.equal(after.activeTimeMs,before.activeTimeMs);assert.equal(after.inFlightGenerationTokens,123);assert.deepEqual(after.pendingCalls,before.pendingCalls);assert.deepEqual(after.resultHandles,before.resultHandles);assert.equal(store.project(after).resumable,true);assert.equal(db.getRunEvents(before.contract.runId).at(-1).payload.startupRecovery.automaticReplay,false);}
    const interrupted=store.get(unknown.contract.runId);assert.equal(interrupted.state,"effect-unknown");assert.equal(interrupted.error.effectState,"unknown");assert.ok(store.uncertainEffect(unknown.contract.runId,"unfinished-write"));assert.deepEqual(interrupted.pendingCalls,unknown.pendingCalls);
    for(const before of terminal)assert.deepEqual(store.get(before.contract.runId),before);
    assert.deepEqual(store.get(foreign.contract.runId),foreign);
    assert.equal(restarted.chats,0);assert.equal(restarted.sessions.length,0);await assert.rejects(readFile(join(root,"build/result.md")),{code:"ENOENT"});
    const once=store.get(originals[0].contract.runId);service(db,root);assert.deepEqual(store.get(once.contract.runId),once,"startup normalization is idempotent");
  }finally{db.close();}
});

test("normal-close pause survives database reopen and resumes without repeating a committed write",async t=>{
  const root=await ownedRoot(t),dbPath=join(root,"state.sqlite"),generating=deferred();let db=new AppDatabase(dbPath);
  const first=service(db,root,{turns:[
    ["harness_plan",{deliverables:[{path:"build/result.md",kind:"document"}]}],
    ["workspace_propose_patch",{path:"build/result.md",content:"# Original model-authored fixture\n",rationale:"Create the authorized test output"}],
    async(_payload,chunk,signal)=>{chunk({choices:[{delta:{reasoning_content:"Partial generation after saved output"}}]});generating.resolve();await new Promise((_,reject)=>{signal.addEventListener("abort",()=>reject(signal.reason),{once:true});if(signal.aborted)reject(signal.reason);});},
  ]});
  const thread=first.agent.createThread({workspacePath:root,title:"Close and reopen fixture",mode:"act",modelId:"lifecycle-fixture"});
  try{
    await first.agent.send(thread.id,"Create build/result.md.");await within(generating.promise);
    const before=new HarnessStore(db.db).latest(thread.id),concurrent=service(db,root);
    assert.deepEqual(new HarnessStore(db.db).latest(thread.id),before,"a second service cannot normalize a live owner");
    await assert.rejects(concurrent.agent.resumeExecution(before.contract.runId),/already running/);
    await assert.rejects(concurrent.agent.send(thread.id,"A conflicting task"),/running request/);
    await first.agent.pauseAll("The application closed during the controlled lifecycle test.");
    const paused=new HarnessStore(db.db).latest(thread.id);assert.equal(paused.state,"paused");assert.match(paused.error.message,/application closed/);assert.equal(first.agent.hasActiveRuns(),false);assert.ok(first.sessions.every(session=>session.stopped));assert.ok(paused.generatedTokens>=before.generatedTokens);assert.deepEqual(paused.contract.budgets,before.contract.budgets);
    const source=await readFile(join(root,"build/result.md"),"utf8"),writeReceipts=paused.resultHandles.map(handle=>new HarnessStore(db.db).read(paused.contract.runId,handle)).filter(result=>result.tool==="workspace_propose_patch");assert.equal(writeReceipts.length,1);
    db.close();db=new AppDatabase(dbPath);
    const second=service(db,root,{instanceId:"instance-after-explicit-reload",turns:[["harness_finish",{summary:"The preserved model-authored file is verified."}]]});
    assert.deepEqual(new HarnessStore(db.db).latest(thread.id),paused);
    await second.agent.resumeExecution(paused.contract.runId);const terminal=await within(second.terminal);assert.equal(terminal.harness.state,"completed",JSON.stringify(terminal));assert.equal(second.agent.hasActiveRuns(),false);
    const completed=new HarnessStore(db.db).latest(thread.id);assert.equal(completed.recoveryCounters.resumes,1);assert.equal(completed.recoveryCounters.instanceRebinds,1);assert.equal(completed.hostRecovered,false);assert.deepEqual(completed.contract.budgets,paused.contract.budgets);assert.ok(completed.generatedTokens>=paused.generatedTokens);assert.ok(completed.activeTimeMs>=paused.activeTimeMs);assert.equal(await readFile(join(root,"build/result.md"),"utf8"),source);assert.deepEqual(completed.resultHandles.filter(handle=>new HarnessStore(db.db).read(completed.contract.runId,handle).tool==="workspace_propose_patch"),writeReceipts.map(result=>result.handle));
  }finally{await first.agent.cancelAll();db.close();}
});

test("closing during initial MCP discovery preserves a resumable contract before any schema or model response",async t=>{
  const root=await ownedRoot(t),dbPath=join(root,"state.sqlite"),started=deferred();let rejectDiscovery,db=new AppDatabase(dbPath);
  const first=service(db,root,{discovery:async()=>{started.resolve();return new Promise((_,reject)=>{rejectDiscovery=reject;});},onStop:()=>rejectDiscovery?.(new Error("Owned discovery interrupted"))});
  const thread=first.agent.createThread({workspacePath:root,title:"Close during discovery",mode:"act",modelId:"lifecycle-fixture"});
  try{
    await first.agent.send(thread.id,"Create build/result.md.");await within(started.promise);
    const before=new HarnessStore(db.db).latest(thread.id);assert.ok(before,"trusted contract must exist before the first discovery await");assert.equal(before.state,"preparing");assert.deepEqual(before.selectedTools,[]);assert.equal(before.round,0);assert.equal(before.contract.goal,"Create build/result.md.");assert.equal(first.chats,0);
    await new Promise(resolve=>setTimeout(resolve,12));
    await first.agent.pauseAll("Application closed during initial tool discovery.");
    const paused=new HarnessStore(db.db).latest(thread.id);assert.equal(paused.state,"paused");assert.equal(paused.round,0);assert.ok(paused.activeTimeMs>=10,"preparation consumes the original active budget");assert.deepEqual(paused.selectedTools,[]);assert.deepEqual(paused.contract,before.contract);assert.ok(first.sessions.every(session=>session.stopped));
    db.close();db=new AppDatabase(dbPath);
    const second=service(db,root,{turns:[["workspace_propose_patch",{path:"build/result.md",content:"# Prepared after reopening\n",rationale:"Resume the original scoped goal"}],["harness_finish",{summary:"Saved the original requested artifact after preparation resumed."}]]});
    await second.agent.resumeExecution(paused.contract.runId);const terminal=await within(second.terminal);assert.equal(terminal.harness.state,"completed",JSON.stringify(terminal));assert.equal(terminal.harness.recoveryCounters.resumes,1);assert.ok(terminal.harness.activeTimeMs>=paused.activeTimeMs);assert.equal(await readFile(join(root,"build/result.md"),"utf8"),"# Prepared after reopening\n");
  }finally{await first.agent.cancelAll();db.close();}
});
