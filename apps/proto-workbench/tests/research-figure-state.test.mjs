import assert from "node:assert/strict";
import test from "node:test";
import {createHash} from "node:crypto";
import {captureFigureDownloadScope,figureDownloadScopeCurrent,createResearchFigureStore,selectedFigure,figureScopeReady,moveFigurePanel,verifyFigureArtifact} from "../src/renderer/research-figure-state.ts";

const studyA="11111111-1111-4111-8111-111111111111",studyB="22222222-2222-4222-8222-222222222222",figureA="33333333-3333-4333-8333-333333333333",figureB="44444444-4444-4444-8444-444444444444",panelA="55555555-5555-4555-8555-555555555555",panelB="66666666-6666-4666-8666-666666666666",runId="a".repeat(32),at="2026-09-22T12:00:00.000Z";
const binding={tool:"compare_two_groups",createdAt:at,manifestSha256:"1".repeat(64),provenanceSha256:"2".repeat(64),inputSha256:"3".repeat(64),resultSha256:"4".repeat(64)};
const study=(id=studyA,revision=1)=>({id,revision,name:"Figure study",question:"A research question",createdAt:at,updatedAt:at,runCount:1,links:[{runId,linkedAt:at,binding}],history:[]});
const panel={id:panelA,runId,title:"Observed values",kind:"scatter",xLabel:"Observation",yLabel:"Recorded value",xUnit:"",yUnit:"mg",y:{from:"input",pointer:"/group_a"}};
const figure=(id=figureA,revision=1,change={})=>({id,studyId:studyA,revision,title:"Figure board",caption:"An authored caption",columns:1,panels:[{...panel,binding}],createdAt:at,updatedAt:at,change:revision===1?"create":"edit",...change});
const inspection=(record=figure(),change={})=>({figure:record,panels:[{id:panelA,status:"ready",message:"Saved data verified",points:[{x:1,y:1},{x:2,y:2}],sourceFreshness:{status:"current",checkedAt:at,details:[]}}],canExport:true,requiresSourceAcknowledgement:false,methodsMarkdown:"Saved method only",methods:{},...change});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function harness(){const queue=[];const store=createResearchFigureStore(input=>new Promise((resolve,reject)=>queue.push({input,resolve,reject})));store.getState().activate("workspace-A",study());return {store,queue,take(action){const index=queue.findIndex(item=>item.input.action===action);assert.notEqual(index,-1,`Pending ${action} request`);return queue.splice(index,1)[0];}};}
async function open(h,record=figure(),inspected=inspection(record)){const pending=h.store.getState().select(record.id);h.take("get").resolve({figure:record});await tick();h.take("inspect").resolve({inspection:inspected});await pending;}
const draftOf=record=>({title:record.title,caption:record.caption,columns:record.columns,panels:record.panels.map(({binding,...rest})=>rest)});
function newDraft(h){h.store.getState().create();h.store.getState().edit(draftOf(figure()));}

test("a saved board opens with exact host points and parameter selectors",async()=>{const h=harness();await open(h);assert.equal(selectedFigure(h.store.getState()).dirty,false);assert.deepEqual(h.store.getState().inspection.panels[0].points,[{x:1,y:1},{x:2,y:2}]);assert.deepEqual(selectedFigure(h.store.getState()).draft.panels[0].y,{from:"input",pointer:"/group_a"});});

test("project switches retain each unsaved draft and ignore old project requests",async()=>{
  const h=harness();newDraft(h);h.store.getState().edit({title:"Project A draft"});const keyA=h.store.getState().selectedKey;
  const listing=h.store.getState().list(),old=h.take("list");h.store.getState().activate("workspace-A",study(studyB));newDraft(h);h.store.getState().edit({title:"Project B draft"});
  old.resolve({figures:[{id:figureA,studyId:studyA,title:"Wrong scope"}]});await listing;assert.deepEqual(h.store.getState().figures,[]);
  h.store.getState().activate("workspace-A",study());assert.equal(h.store.getState().selectedKey,keyA);assert.equal(selectedFigure(h.store.getState()).draft.title,"Project A draft");
  h.store.getState().activate("workspace-A",study(studyB));assert.equal(selectedFigure(h.store.getState()).draft.title,"Project B draft");
});

test("leaving and returning to a workspace cannot accept an older response",async()=>{
  const h=harness(),opening=h.store.getState().select(figureA),old=h.take("get");h.store.getState().activate("workspace-B",study());h.store.getState().activate("workspace-A",study());old.resolve({figure:figure()});await opening;assert.equal(selectedFigure(h.store.getState()),undefined);assert.equal(h.queue.length,0);
});

test("result-view suspension preserves drafts but cancels live callbacks",async()=>{
  const h=harness();await open(h);h.store.getState().edit({caption:"Retained text"});const saving=h.store.getState().save(),old=h.take("save");h.store.getState().suspend();old.resolve({figure:figure(figureA,2,{caption:"Retained text"})});assert.equal(await saving,false);assert.equal(selectedFigure(h.store.getState()).baseline.revision,1);assert.equal(selectedFigure(h.store.getState()).draft.caption,"Retained text");assert.equal(h.store.getState().busy,undefined);
});

test("late open and finalizer cannot overwrite a newer selected board",async()=>{
  const h=harness(),first=h.store.getState().select(figureA),old=h.take("get"),second=h.store.getState().select(figureB),fresh=h.take("get");old.resolve({figure:figure()});await first;assert.equal(h.store.getState().opening,true);assert.equal(selectedFigure(h.store.getState()),undefined);fresh.resolve({figure:figure(figureB)});await tick();h.take("inspect").resolve({inspection:inspection(figure(figureB))});await second;assert.equal(selectedFigure(h.store.getState()).key,figureB);
});

test("save uses both current project and exact figure revisions; annotations do not include binding replacements",async()=>{
  const h=harness();await open(h);h.store.getState().activate("workspace-A",study(studyA,4));h.store.getState().edit({caption:"New caption"});const saving=h.store.getState().save(),request=h.take("save");assert.equal(request.input.expectedStudyRevision,4);assert.equal(request.input.expectedRevision,1);assert.equal(request.input.figureId,figureA);assert.equal("binding" in request.input.draft.panels[0],false);
  request.resolve({figure:figure(figureA,2,{caption:"New caption"})});await tick();h.take("inspect").resolve({inspection:inspection(figure(figureA,2,{caption:"New caption"}))});assert.equal(await saving,true);assert.equal(selectedFigure(h.store.getState()).dirty,false);
});

test("edits during a save remain dirty against its returned baseline",async()=>{
  const h=harness();newDraft(h);const saving=h.store.getState().save(),request=h.take("save");h.store.getState().edit({caption:"Typed after submission"});request.resolve({figure:figure()});assert.equal(await saving,true);const editor=selectedFigure(h.store.getState());assert.equal(editor.key,figureA);assert.equal(editor.draft.caption,"Typed after submission");assert.equal(editor.baseline.caption,"An authored caption");assert.equal(editor.dirty,true);assert.equal(h.queue.length,0);assert.equal(h.store.getState().inspection,undefined);
});

test("CAS failures retain draft and saved baseline",async()=>{const h=harness();await open(h);h.store.getState().edit({caption:"Do not lose me"});const saving=h.store.getState().save();h.take("save").reject(Error("Figure revision conflict"));assert.equal(await saving,false);assert.equal(selectedFigure(h.store.getState()).draft.caption,"Do not lose me");assert.equal(selectedFigure(h.store.getState()).baseline.revision,1);assert.match(h.store.getState().error,/revision conflict/);});

test("inspection for an older draft cannot appear beneath newer edits",async()=>{const h=harness();await open(h);const checking=h.store.getState().inspect(),request=h.take("inspect");h.store.getState().edit({caption:"New caption"});request.resolve({inspection:inspection()});await checking;assert.equal(h.store.getState().inspection,undefined);assert.equal(h.store.getState().inspectionBusy,false);});

test("newer host revision is reported without silently replacing the draft",async()=>{const h=harness();await open(h);const checking=h.store.getState().inspect();h.take("inspect").resolve({inspection:inspection(figure(figureA,2,{title:"Changed elsewhere"}))});await checking;assert.equal(selectedFigure(h.store.getState()).draft.title,"Figure board");assert.equal(selectedFigure(h.store.getState()).remoteRevision,2);assert.equal(h.store.getState().inspection,undefined);});

test("explicit rebind addresses only selected panels and preserves edits made during its request",async()=>{
  const h=harness();await open(h);const rebinding=h.store.getState().rebind([panelA]),request=h.take("rebind");assert.deepEqual(request.input,{action:"rebind",studyId:studyA,figureId:figureA,expectedRevision:1,expectedStudyRevision:1,panelIds:[panelA]});h.store.getState().edit({caption:"Still my edit"});request.resolve({figure:figure(figureA,2,{change:"rebind",panels:[{...panel,binding:{...binding,resultSha256:"5".repeat(64)}}]})});assert.equal(await rebinding,true);assert.equal(selectedFigure(h.store.getState()).draft.caption,"Still my edit");assert.equal(selectedFigure(h.store.getState()).dirty,true);assert.equal(selectedFigure(h.store.getState()).baseline.panels[0].binding.resultSha256,"5".repeat(64));
});

test("changed original sources require explicit acknowledgement; changed bindings cannot export",async()=>{
  const h=harness();await open(h,figure(),inspection(figure(),{requiresSourceAcknowledgement:true}));assert.equal(await h.store.getState().export(false),false);assert.equal(h.queue.length,0);assert.match(h.store.getState().error,/Acknowledge/);
  const exporting=h.store.getState().export(true),request=h.take("export");assert.equal(request.input.acknowledgeChangedSources,true);request.reject(Error("A source changed again"));assert.equal(await exporting,false);
  const check=h.store.getState().inspect();h.take("inspect").resolve({inspection:inspection(figure(),{canExport:false,panels:[{id:panelA,status:"binding-changed",message:"Different result hash"}]})});await check;assert.equal(await h.store.getState().export(true),false);assert.equal(h.queue.length,0);
});

test("export receipt is discarded after edits or project navigation",async()=>{
  const h=harness();await open(h);const exporting=h.store.getState().export(false),request=h.take("export");h.store.getState().edit({title:"New draft"});request.resolve({export:{figureId:figureA,figureRevision:1,files:[]}});assert.equal(await exporting,false);assert.equal(h.store.getState().exported,undefined);assert.equal(h.store.getState().busy,undefined);
});

test("series descriptors are restricted to linked runs and stale descriptors cannot cross projects",async()=>{
  const h=harness();await h.store.getState().loadSeries("b".repeat(32));assert.equal(h.queue.length,0);const loading=h.store.getState().loadSeries(runId),request=h.take("series");h.store.getState().activate("workspace-A",study(studyB));request.resolve({series:[{selector:panel.y,label:"Group A",kind:"numeric",length:3}]});await loading;assert.deepEqual(h.store.getState().series,{});
});

test("a list started before a save cannot erase the newly saved board",async()=>{
  const h=harness();newDraft(h);const listing=h.store.getState().list(),list=h.take("list"),saving=h.store.getState().save();h.take("save").resolve({figure:figure()});await tick();h.take("inspect").resolve({inspection:inspection()});await saving;list.resolve({figures:[]});await listing;assert.equal(h.store.getState().figures[0].id,figureA);assert.equal(h.store.getState().listBusy,false);
});

test("panel reordering does not modify data selectors or generate observations",()=>{const second={...panel,id:panelB,y:{from:"result",pointer:"/values",field:"/mean"}},panels=[panel,second],moved=moveFigurePanel(panels,panelB,-1);assert.deepEqual(moved,[second,panel]);assert.equal(moved[0],second);assert.equal(moveFigurePanel(panels,panelA,-1),panels);});

function artifactFixture(){const bytes=Buffer.from("x,y\n1,3.141592653589793\n"),sha256=createHash("sha256").update(bytes).digest("hex"),file={format:"csv",path:"build/figures/points.csv",sha256,bytes:bytes.length,mimeType:"text/csv"},artifact={name:"points.csv",mimeType:file.mimeType,base64:bytes.toString("base64"),sha256};return {bytes,file,artifact};}
test("download bytes are independently hash-checked against the selected export receipt",async()=>{const {file,artifact,bytes}=artifactFixture(),verified=await verifyFigureArtifact(artifact,file);assert.deepEqual(Buffer.from(verified.bytes),bytes);assert.equal(verified.name,"points.csv");await assert.rejects(verifyFigureArtifact({...artifact,sha256:"f".repeat(64)},file),/receipt/);await assert.rejects(verifyFigureArtifact({...artifact,base64:Buffer.from("x,y\n1,3.141592653589794\n").toString("base64")},file),/SHA-256/);await assert.rejects(verifyFigureArtifact({...artifact,name:"../points.csv"},file),/identity/);await assert.rejects(verifyFigureArtifact(artifact,{...file,bytes:file.bytes+1}),/size|malformed/);});

test("a stale artifact response never starts a download in another project",async()=>{
  const h=harness();await open(h);const {file,artifact}=artifactFixture(),exporting=h.store.getState().export(false);h.take("export").resolve({export:{exportId:"e".repeat(32),figureId:figureA,figureRevision:1,createdAt:at,files:[file],manifestPath:"build/manifest.json",manifestSha256:"f".repeat(64)}});assert.equal(await exporting,true);
  const downloading=h.store.getState().download(file),request=h.take("artifact");assert.deepEqual(request.input,{action:"artifact",studyId:studyA,figureId:figureA,exportId:"e".repeat(32),format:"csv"});h.store.getState().activate("workspace-A",study(studyB));request.resolve({artifact});assert.equal(await downloading,undefined);assert.equal(h.store.getState().downloadBusy,undefined);
});

test("initial and changing project scopes cannot expose enabled figure controls before activation",()=>{
  const store=createResearchFigureStore(async()=>({}));assert.equal(figureScopeReady(store.getState(),"workspace-A",study()),false);
  store.getState().activate("workspace-A",study());assert.equal(figureScopeReady(store.getState(),"workspace-A",study()),true);
  assert.equal(figureScopeReady(store.getState(),"workspace-A",study(studyB)),false);assert.equal(figureScopeReady(store.getState(),"workspace-B",study()),false);assert.equal(figureScopeReady(store.getState(),"workspace-A",study(studyA,2)),false);
  store.getState().activate("workspace-A",study(studyB));assert.equal(figureScopeReady(store.getState(),"workspace-A",study(studyB)),true);store.getState().create();assert.ok(selectedFigure(store.getState()));
});

test("restart-style get discovers older export receipts and permits hash-checked historical downloads",async()=>{
  const h=harness(),{file,artifact,bytes}=artifactFixture(),record=figure(figureA,3),historical={exportId:"e".repeat(32),figureId:figureA,figureRevision:1,createdAt:at,files:[file],manifestPath:"build/manifest.json",manifestSha256:"f".repeat(64)};
  const opening=h.store.getState().select(figureA);h.take("get").resolve({figure:record,exports:[historical]});await tick();h.take("inspect").resolve({inspection:inspection(record)});await opening;
  assert.equal(h.store.getState().exported,undefined);h.store.getState().showExport(historical.exportId);assert.equal(h.store.getState().exported.figureRevision,1);assert.equal(selectedFigure(h.store.getState()).baseline.revision,3);
  const downloading=h.store.getState().download(file);h.take("artifact").resolve({artifact});assert.deepEqual(Buffer.from((await downloading).bytes),bytes);
});

test("cached saved-board reopening refreshes export history without discarding local edits",async()=>{
  const h=harness();await open(h);h.store.getState().edit({caption:"Preserve my draft"});const reopening=h.store.getState().select(figureA),request=h.take("get");request.resolve({figure:figure(figureA,2,{caption:"Someone else's edit"}),exports:[]});await reopening;
  assert.equal(selectedFigure(h.store.getState()).draft.caption,"Preserve my draft");assert.equal(selectedFigure(h.store.getState()).baseline.revision,1);assert.equal(selectedFigure(h.store.getState()).remoteRevision,2);assert.equal(h.queue.length,0);
});

test("verified download links stay bound to the exact editor, project, workspace and export",async()=>{
  const h=harness();await open(h);const state=h.store.getState(),scope=captureFigureDownloadScope(state);assert.equal(figureDownloadScopeCurrent(scope,state),true);
  for(const changes of [{workspace:"workspace-B"},{study:study(studyB)},{study:study(studyA,2)},{selectedKey:figureB},{exported:{exportId:"new-export"}},{editors:state.editors.map(editor=>({...editor,draft:{...editor.draft,caption:"New draft"}}))},{editors:state.editors.map(editor=>({...editor,baseline:{...editor.baseline,revision:2}}))}])assert.equal(figureDownloadScopeCurrent(scope,{...state,...changes}),false);
  h.store.getState().edit({caption:"An edit invalidates prepared bytes"});assert.equal(figureDownloadScopeCurrent(scope,h.store.getState()),false);
});
