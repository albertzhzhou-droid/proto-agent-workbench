import assert from "node:assert/strict";
import test from "node:test";
import {createResearchStudyStore,reduceStudyEditorDraft,studyEditorDraft,STUDY_RUN_WINDOW} from "../src/renderer/research-study-state.ts";

const a="a".repeat(32),b="b".repeat(32),c="c".repeat(32);
const projectA="11111111-1111-4111-8111-111111111111",projectB="22222222-2222-4222-8222-222222222222";
const at="2026-09-22T12:00:00.000Z";
const binding={tool:"compare_two_groups",createdAt:at,manifestSha256:"1".repeat(64),provenanceSha256:"2".repeat(64),inputSha256:"3".repeat(64),resultSha256:"4".repeat(64)};
const integrity={status:"verified",checkedAt:at,code:"VERIFIED",message:"Saved artifact hashes match.",authority:"unsigned-local-artifacts"};
const study=(id=projectA,linked=[],revision=1)=>({id,revision,name:`Project ${id}`,question:"A question",createdAt:at,updatedAt:at,runCount:linked.length,links:linked.map(runId=>({runId,linkedAt:at,binding})),history:[]});
const opened=(runId=a,change={})=>({runId,tool:binding.tool,createdAt:at,integrity,sourceFreshness:{status:"current",checkedAt:at,details:[]},request:{tool:binding.tool,arguments:{group_a:[1,2,3],group_b:[3,4,5],method:"welch_t",unit:"mg"}},receipt:{ok:true,run_id:runId,tool:binding.tool,result:{mean_difference:-2,missing:null},implementation:"historical-implementation",implementation_version:1},...change});
const runPage=(runs=[],generation="1",nextCursor=null,extra={})=>({runs,page:{generation,nextCursor,...extra}});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function harness(){
  const queue=[];
  const store=createResearchStudyStore(input=>new Promise((resolve,reject)=>queue.push({input,resolve,reject})));
  store.getState().activate("workspace-A");
  return {store,queue,take(action){const index=queue.findIndex(item=>item.input.action===action);assert.notEqual(index,-1,`Pending ${action} request`);return queue.splice(index,1)[0];}};
}
async function choose(h,record=study()){
  const selected=h.store.getState().select(record.id);h.take("get").resolve({study:record});await tick();h.take("runs").resolve(runPage());await selected;
}
async function allRuns(h){const pending=h.store.getState().setRunMode("all");h.take("runs").resolve(runPage());await pending;}

test("all-runs reopening and comparisons retain each selected project's immutable anchor",async()=>{
  const h=harness();await choose(h,study(projectA,[a]));await allRuns(h);
  const opening=h.store.getState().openRun(a),request=h.take("open-run");
  assert.deepEqual(request.input,{action:"open-run",runId:a,studyId:projectA});
  const saved=opened(a,{sourceFreshness:{status:"changed",checkedAt:at,details:[]}});request.resolve({run:saved});
  assert.deepEqual(await opening,saved);assert.equal(h.store.getState().opened.sourceFreshness.status,"changed");
  h.store.getState().toggleCompare(a);h.store.getState().toggleCompare(b);
  const comparing=h.store.getState().compare(),left=h.take("open-run"),right=h.take("open-run");
  assert.equal(left.input.studyId,projectA);assert.equal(right.input.studyId,undefined);
  left.resolve({run:saved});right.resolve({run:opened(b)});await comparing;
  assert.deepEqual(h.store.getState().comparison[0].request,saved.request);
  assert.equal(h.store.getState().comparison[0].receipt.implementation,"historical-implementation");
});

test("late opens and their finally handlers cannot replace or unlock the newer open",async()=>{
  const h=harness(),first=h.store.getState().openRun(a),old=h.take("open-run");
  const second=h.store.getState().openRun(b),current=h.take("open-run");old.resolve({run:opened(a)});
  assert.equal(await first,undefined);assert.equal(h.store.getState().openBusy,true);assert.equal(h.store.getState().opened,undefined);
  current.resolve({run:opened(b)});assert.equal((await second).runId,b);assert.equal(h.store.getState().openBusy,false);
});

test("old workspace responses stay invalid after leaving and returning to the same workspace",async()=>{
  const h=harness(),opening=h.store.getState().openRun(a),request=h.take("open-run");
  const loading=h.store.getState().loadRuns("reset"),runs=h.take("runs");
  h.store.getState().activate("workspace-B");h.store.getState().activate("workspace-A");
  request.resolve({run:opened(a)});runs.resolve(runPage([opened(a)]));
  assert.equal(await opening,undefined);await loading;
  assert.equal(h.store.getState().opened,undefined);assert.deepEqual(h.store.getState().runs.rows,[]);
});

test("out-of-order selection cannot replace the selected project or trigger its run page",async()=>{
  const h=harness(),first=h.store.getState().select(projectA),old=h.take("get");
  const second=h.store.getState().select(projectB),current=h.take("get");
  current.resolve({study:study(projectB)});await tick();h.take("runs").resolve(runPage());await second;
  old.resolve({study:study(projectA)});await first;
  assert.equal(h.store.getState().study.id,projectB);assert.equal(h.store.getState().selectionBusy,false);assert.equal(h.queue.length,0);
});

test("creating a project invalidates prior selection, open and project-list responses",async()=>{
  const h=harness(),selection=h.store.getState().select(projectA),oldSelection=h.take("get");
  const opening=h.store.getState().openRun(a),oldOpen=h.take("open-run");
  const listing=h.store.getState().loadStudies("reset"),oldList=h.take("list");
  const creating=h.store.getState().create("New project","New question"),create=h.take("create");
  create.resolve({study:study(projectB)});assert.equal(await creating,true);
  assert.equal(h.store.getState().selectionBusy,false);assert.equal(h.store.getState().openBusy,false);
  const newPage=h.take("runs");assert.equal(newPage.input.studyId,projectB);newPage.resolve(runPage());
  oldSelection.resolve({study:study(projectA)});oldOpen.resolve({run:opened(a)});oldList.resolve({studies:[study(projectA)],page:{generation:"old",nextCursor:null}});
  await selection;await listing;assert.equal(await opening,undefined);await tick();
  assert.equal(h.store.getState().study.id,projectB);assert.equal(h.store.getState().studies.changed,true);assert.equal(h.store.getState().studies.busy,false);assert.equal(h.store.getState().opened,undefined);
});

test("linking invalidates an unbound in-flight open and an outdated run page",async()=>{
  const h=harness();await choose(h);await allRuns(h);
  const opening=h.store.getState().openRun(a),oldOpen=h.take("open-run");assert.equal(oldOpen.input.studyId,undefined);
  const loading=h.store.getState().loadRuns("reset"),oldPage=h.take("runs");
  const linking=h.store.getState().link(a),link=h.take("link");assert.equal(link.input.expectedRevision,1);
  await h.store.getState().setRunMode("linked");assert.equal(h.store.getState().runMode,"all");
  link.resolve({study:study(projectA,[a],2)});assert.equal(await linking,true);
  oldOpen.resolve({run:opened(a)});oldPage.resolve(runPage([opened(b)]));assert.equal(await opening,undefined);await loading;
  assert.equal(h.store.getState().opened,undefined);assert.equal(h.store.getState().runs.changed,true);assert.deepEqual(h.store.getState().runs.rows,[]);
  const retry=h.store.getState().openRun(a),anchored=h.take("open-run");assert.equal(anchored.input.studyId,projectA);anchored.resolve({run:opened(a)});await retry;
});

test("unmounting the project view invalidates opens; remount can fetch the revised project",async()=>{
  const h=harness();await choose(h);
  const opening=h.store.getState().openRun(a),request=h.take("open-run");
  h.store.getState().suspend();request.resolve({run:opened(a)});assert.equal(await opening,undefined);assert.equal(h.store.getState().openBusy,false);
  await choose(h,study(projectA,[a],2));assert.equal(h.store.getState().study.revision,2);
});

test("damaged, missing and mismatched records never reopen; diagnostics remain visible",async()=>{
  for(const response of [{run:opened(a,{integrity:{...integrity,status:"damaged",message:"Anchor differs"},request:undefined,receipt:undefined})},{run:opened(a,{receipt:undefined})},{run:opened(b)},{}]){
    const h=harness(),opening=h.store.getState().openRun(a);h.take("open-run").resolve(response);
    assert.equal(await opening,undefined);assert.ok(h.store.getState().error);assert.equal(h.store.getState().openBusy,false);
  }
});

test("comparison selection changes and failed records cannot publish stale or partial comparisons",async()=>{
  const h=harness();h.store.getState().toggleCompare(a);h.store.getState().toggleCompare(b);
  const comparison=h.store.getState().compare(),left=h.take("open-run"),right=h.take("open-run");
  h.store.getState().toggleCompare(b);h.store.getState().toggleCompare(c);
  left.resolve({run:opened(a)});right.resolve({run:opened(b)});await comparison;
  assert.equal(h.store.getState().comparison,undefined);assert.equal(h.store.getState().openBusy,false);
  const retry=h.store.getState().compare();h.take("open-run").resolve({run:opened(a)});h.take("open-run").resolve({run:opened(c,{integrity:{...integrity,status:"unavailable",message:"Missing file"}})});await retry;
  assert.equal(h.store.getState().comparison,undefined);assert.match(h.store.getState().error,/Missing file/);
});

test("run windows remain bounded and changed generations retain the user's displayed page",async()=>{
  const h=harness();
  for(let page=0;page<4;page++){
    const pending=h.store.getState().loadRuns(page?"older":"reset"),request=h.take("runs");
    request.resolve(runPage(Array.from({length:30},(_,index)=>opened((page*30+index).toString(16).padStart(32,"0"))),"1",`cursor-${page}`));await pending;
  }
  assert.equal(h.store.getState().runs.rows.length,STUDY_RUN_WINDOW);
  await h.store.getState().loadRuns("older");assert.equal(h.queue.length,0);
  const refreshing=h.store.getState().loadRuns("refresh");h.take("runs").resolve(runPage([opened(a)],"2","new"));await refreshing;
  assert.equal(h.store.getState().runs.changed,true);assert.equal(h.store.getState().runs.rows.length,STUDY_RUN_WINDOW);
  await h.store.getState().loadRuns("next");assert.equal(h.queue.length,0);
  const reset=h.store.getState().loadRuns("reset");h.take("runs").resolve(runPage([opened(a)],"2","next"));await reset;
  const next=h.store.getState().loadRuns("next");h.take("runs").resolve(runPage([opened(b)],"2"));await next;
  assert.equal(h.store.getState().runs.offset,1);assert.deepEqual(h.store.getState().runs.rows.map(row=>row.runId),[b]);
  await h.store.getState().loadRuns("refresh");assert.equal(h.queue.length,0);
});

test("conflicts and wrong-project mutation responses retain the current project",async()=>{
  const h=harness();await choose(h);
  const updating=h.store.getState().update("Changed","Question",1);h.take("update").reject(new Error("Revision conflict"));
  assert.equal(await updating,false);assert.equal(h.store.getState().study.revision,1);assert.match(h.store.getState().error,/Revision conflict/);
  const retry=h.store.getState().update("Changed","Question",1);h.take("update").resolve({study:study(projectB)});
  assert.equal(await retry,false);assert.equal(h.store.getState().study.id,projectA);assert.match(h.store.getState().error,/different research project/);
});

test("successful editor saves acknowledge the submitted revision once in either response/effect order",()=>{
  const original=study(projectA,[],3);
  const submitted=reduceStudyEditorDraft(studyEditorDraft(original),{type:"edit",field:"question",value:"Updated question"});
  const saved={...original,question:submitted.question,revision:4};
  const record={type:"record",study:saved},accepted={type:"accepted",submitted};
  for(const actions of [[record,accepted],[accepted,record],[record,accepted,record]]){
    const result=actions.reduce(reduceStudyEditorDraft,reduceStudyEditorDraft(submitted,{type:"saving"}));
    assert.equal(result.baseline,saved.revision);assert.equal(result.saved,true);assert.equal(result.question,saved.question);
  }
});

test("save acknowledgements preserve edits made while saving and genuine conflicting saved text",()=>{
  const original=study(projectA,[],3);
  const submitted=reduceStudyEditorDraft(studyEditorDraft(original),{type:"edit",field:"question",value:"Submitted question"});
  let current=reduceStudyEditorDraft(submitted,{type:"edit",field:"question",value:"New unsaved question"});
  current=reduceStudyEditorDraft(current,{type:"record",study:{...original,question:submitted.question,revision:4}});
  current=reduceStudyEditorDraft(current,{type:"accepted",submitted});
  assert.equal(current.question,"New unsaved question");assert.equal(current.baseline,4);assert.equal(current.saved,false);
  const external={...original,question:"Another editor's question",revision:5};
  current=reduceStudyEditorDraft(current,{type:"record",study:external});
  assert.equal(current.baseline,4);assert.notEqual(current.baseline,external.revision);assert.equal(current.question,"New unsaved question");
  current=reduceStudyEditorDraft(current,{type:"reload",study:external});
  assert.equal(current.baseline,5);assert.equal(current.question,external.question);assert.equal(current.saved,false);
});
