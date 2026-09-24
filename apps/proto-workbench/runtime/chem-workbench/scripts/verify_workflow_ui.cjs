'use strict';
// Exercise the shipped browser event handlers without inference or scientific execution.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const sourceHash = 'sha256:' + '1'.repeat(64);
const semanticHash = 'sha256:' + '2'.repeat(64);
const recordHash = 'sha256:' + '3'.repeat(64);
const elements = new Map();
const documentListeners = new Map();
const dispatchedEvents = [];
class Element {
  constructor() { this.value = ''; this.textContent = ''; this.children = []; this.classList = {add(){}, remove(){}, toggle(){}}; }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = items; this.textContent = ''; }
  setAttribute() {}
  querySelectorAll() { return []; }
  addEventListener() {}
  click() { return this.onclick?.(); }
}
const get = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
const requests = [];
const endpointCalls = [];
const geometryCalls = [];
let displayedGeometry=null;
const deferredRoutes = new Map();
const timers = new Map();
let nextTimer = 0;
const response = value => ({ok:true,json:async()=>value});
function deferEndpoint(url) {
  let resolve;
  const promise = new Promise(done=>{resolve=done;});
  const pending = {body:null,requested:false,finish:value=>resolve(response(value)),fail:message=>resolve({ok:false,json:async()=>({error:message})}),promise};
  if(!deferredRoutes.has(url))deferredRoutes.set(url,[]);
  deferredRoutes.get(url).push(pending);
  return pending;
}
function workflowRecord(request, overrides={}) {
  const target=request.object_id||'water_second';
  const subject={subject_ref:target,...(request.profile==='copper'?{}:request.profile==='molecular'?{proposal:request.proposal||{...molecular,object_id:target,subject_ref:target}}:{geometry:request.geometry||geometry})};
  const plan={kind:{water:'water_hf_sto3g',molecular:'molecular_hf_sto3g',copper:'cu_lattice_scan'}[request.profile||'water'],object_id:target,subject,...(request.profile==='copper'?{candidates:(request.scales||[.98,1,1.02]).map(candidate)}:{})};
  const merged={...overrides};if(overrides.plan)merged.plan={...plan,...overrides.plan,subject:{...subject,...overrides.plan.subject}};
  return {state:'prepared',reference:recordHash,source:request.source,attachments:structuredClone(request.attachments||{}),source_hash:sourceHash,
    plan,...merged};
}
const molecular = {version:'molecular-proposal/v1',object_id:'complex_selected',subject_ref:'complex_selected',geometry:{units:'angstrom',charge:0,multiplicity:1,atoms:[['O','0','0','0'],['H','0','0','.9572'],['H','.92','0','-.24']]},execution_authorized:false};
let pendingModel = null;
const snapshot = {
  success: true, diagnostics: [], review: {}, source_sha256: sourceHash, semantic_hash: semanticHash,
  document: {objects: [{id:'first', kind:'Molecule'}, {id:'water_second', kind:'Molecule'}, {id:'copper_first',kind:'PeriodicStructure'}, {id:'copper_second',kind:'PeriodicStructure'}]},
  scene: {structures: [], unavailable: []},
};
const context = vm.createContext({
  document: {getElementById:get, createElement:()=>new Element(), createElementNS:()=>new Element(),
    addEventListener(type,listener){if(!documentListeners.has(type))documentListeners.set(type,[]);documentListeners.get(type).push(listener);},
    dispatchEvent(event){dispatchedEvents.push(event.type);for(const listener of documentListeners.get(event.type)||[])listener(event);},querySelectorAll:()=>[]},
  window: {addEventListener(){},getDisplayedGeometry:()=>displayedGeometry}, Option: function(label,value){return {textContent:label,value};},
  Event: function(type){this.type=type;}, CustomEvent: function(type,options){this.type=type;this.detail=options?.detail;},
  clearGeometry(message){displayedGeometry=null;geometryCalls.push({kind:'clear',message});context.document.dispatchEvent({type:'geometry-display-changed',detail:null});}, displayGeometry(geometry,scale=1){displayedGeometry={geometry,scale};geometryCalls.push({kind:'display',geometry,scale});context.document.dispatchEvent({type:'geometry-display-changed',detail:displayedGeometry});},
  clearTimeout:id=>timers.delete(id), setTimeout:(callback,delay)=>{const id=++nextTimer;timers.set(id,{callback,delay});return id;}, confirm:()=>true, console,
  fetch: async (url, options) => {
    const body = options.body ? JSON.parse(options.body) : null;
    endpointCalls.push({url,body});
    if(url==='/api/workflow/prepare')requests.push(body);
    const pending=deferredRoutes.get(url)?.shift();
    if(pending){pending.body=body;pending.requested=true;return pending.promise;}
    if (url === '/api/tool') return response({data:{...molecular,object_id:body.arguments.object_id,subject_ref:body.arguments.object_id}});
    if (url === '/api/orchestrate') return new Promise(resolve => { pendingModel = resolve; });
    if (url === '/api/workflow/prepare') return response(workflowRecord(body));
    const values = {
      '/api/workspace': {examples:[],registry:{}}, '/api/compile':snapshot,
      '/api/profiles':{water_geometry:{}}, '/api/workflows':[], '/api/projects':[],
      '/api/model/status':{available:true,display_name:'Gemma 4 E4B',quantization:{name:'Q4_K_M'}},
    };
    assert.ok(url in values, `Unexpected UI endpoint ${url}`);
    return response(values[url]);
  },
});
// Hold both startup requests so compilation can finish while saved history is pending.
const startupCompile=deferEndpoint('/api/compile');
const startupHistory=deferEndpoint('/api/workflows');
for (const name of ['app.js','workflow.js']) {
  vm.runInContext(fs.readFileSync(path.join(root,'src/chem_workbench/web_assets',name),'utf8'), context, {filename:name});
}
const geometry = {charge:0,multiplicity:1,atoms:[['O','0','0','0'],['H','0','0','.9572'],['H','.92','0','-.24']]};
function candidate(scale){return {scale:String(scale),candidate_hash:'synthetic-candidate-'+scale,lattice_angstrom:[[String(3.6*Number(scale)),'0','0'],['0',String(3.6*Number(scale)),'0'],['0','0',String(3.6*Number(scale))]],fractional_sites:[{id:'Cu1',element:'Cu',occupancy:1,coordinates:['0','0','0']}]};}
function sceneGeometry(object){return {object_id:object.id,kind:object.kind,units:'angstrom',provenance:'source_imported',method:'Synthetic UI fixture',description:'Synthetic UI fixture; not scientific acceptance',atoms:object.kind==='PeriodicStructure'?[{id:'Cu1',element:'Cu',position:[0,0,0]}]:geometry.atoms.map((atom,index)=>({id:'atom-'+index,element:atom[0],position:atom.slice(1).map(Number)})),cell:object.kind==='PeriodicStructure'?[[3.6,0,0],[0,3.6,0],[0,0,3.6]]:null,bonds:[],geometry_hash:'synthetic-'+object.id};}
snapshot.scene.structures=snapshot.document.objects.map(sceneGeometry);
const copper = {version:'cu-scan-proposal/v1', subject_ref:'copper_second', execution_authorized:false, candidates:[.98,1,1.02].map(candidate)};
function record(profile) {
  const name = profile === 'water' ? 'plan_water_single_point' : 'plan_cu_lattice_scan';
  const data = profile === 'water' ? {version:'water-proposal/v1',object_id:'water_second',geometry,execution_authorized:false} : structuredClone(copper);
  return {state:'REPORTED',record_hash:recordHash,source_hash:sourceHash,source_semantic_hash:semanticHash,execution_authorized:false,trace:[{
    action:{action:name,object_id:profile==='water'?'water_second':'copper_second',scale_factors:profile==='water'?[]:[.98,1,1.02]},
    output:{tool_name:name,status:'succeeded',authority:'host_read_and_derive_only',source_hash:sourceHash,data},
  }]};
}
async function prepare(profile, modelRecord, plan, suppliedGeometry=geometry, selected='first') {
  context.fixture = {snapshot,modelRecord,plan};
  vm.runInContext('result=fixture.snapshot;agentRecord=fixture.modelRecord;currentPlan=fixture.plan;',context);
  get('compute-profile').value = profile;
  get('source').value = 'test source';
  get('structure-select').value = selected;
  get('water-geometry').value = JSON.stringify(suppliedGeometry);
  const target=plan?.subject_ref||modelRecord?.trace?.[0]?.output?.data?.subject_ref||modelRecord?.trace?.[0]?.output?.data?.object_id;
  const selectedObject=snapshot.document.objects.find(object=>object.id===(target||selected)&&object.kind===(profile==='copper'?'PeriodicStructure':'Molecule'))||snapshot.document.objects.find(object=>object.kind===(profile==='copper'?'PeriodicStructure':'Molecule'));
  context.displayGeometry(sceneGeometry(selectedObject));
  const before = requests.length;
  await get('prepare-compute').onclick();
  assert.equal(requests.length,before+1,'Prepare must issue one workflow request');
  return requests.at(-1);
}
const settle = () => new Promise(resolve=>setImmediate(resolve));
const addedScenarios = [];
async function scenario(name, check) {
  try { await check(); addedScenarios.push(name); }
  catch(error){error.message=name+': '+error.message;throw error;}
}
function setWorkspace({source='test source',attachments={},profile='water'}={}) {
  context.workspaceFixture={source,attachments,snapshot};
  vm.runInContext("invalidate();$('source').value=workspaceFixture.source;attachments=workspaceFixture.attachments;result=workspaceFixture.snapshot;agentRecord=null;currentPlan=null;",context);
  get('compute-profile').value=profile;
  get('structure-select').value=profile==='copper'?'copper_second':'water_second';
  get('water-geometry').value=JSON.stringify(geometry);
  context.displayGeometry(sceneGeometry(snapshot.document.objects.find(object=>object.id===get('structure-select').value)));
}
function displayWorkflow(value) {context.workflowFixture=value;vm.runInContext('showWorkflow(workflowFixture)',context);}
function currentWorkflow() {return vm.runInContext('activeWorkflow',context);}
function currentRecord(overrides={}) {
  return workflowRecord({source:get('source').value,attachments:vm.runInContext('attachments',context),profile:get('compute-profile').value,object_id:get('structure-select').value},overrides);
}
function invalidateSource() {get('source').value+=' changed';get('source').oninput();}
function assertInvalidated() {
  assert.equal(currentWorkflow(),null,'Invalidated workflow must stay detached');
  assert.equal(get('resolved-plan').textContent,'');
  assert.equal(get('computed-results').textContent,'No computed evidence yet.');
  for(const id of ['approve-compute','run-compute','cancel-compute','download-evidence'])assert.equal(get(id).disabled,true,id);
  assert.equal(timers.size,0,'Invalidated workflow must not reschedule polling');
}
function endpointCount(url) {return endpointCalls.filter(call=>call.url===url).length;}
const evidence = {evidence_eligible:true,energy_hartree:-74.9};
(async()=>{
  await settle();
  assert.equal(startupCompile.requested,true,'The real app startup must request compilation');
  assert.equal(startupHistory.requested,true,'Execution startup must request saved history');
  assert.equal(displayedGeometry,null,'Compilation is still pending');
  const beforeCompile=vm.runInContext('executionSnapshot()',context);
  startupCompile.finish(snapshot);await settle();
  context.beforeCompile=beforeCompile;
  assert.equal(vm.runInContext('executionCurrent(beforeCompile)',context),false,'Startup compilation must change the execution binding');
  assert.equal(displayedGeometry.geometry.object_id,'first');
  const archived=workflowRecord({source:'archived source',profile:'copper',object_id:'copper_second'},{state:'succeeded',result:evidence});
  startupHistory.finish([archived]);await settle();
  assert.deepEqual(get('job-history').children.map(item=>item.value),['',archived.reference],'Saved history must survive startup compilation');
  assert.equal(get('job-history').value,'','Listing history must not select a calculation');
  assertInvalidated();
  assert.equal(endpointCount('/api/workflow/read'),0,'Listing history must not load or execute a calculation');

  // The newest global list wins even when a source change invalidates selected execution.
  setWorkspace();displayWorkflow(currentRecord({state:'approved',result:evidence}));
  const staleList=deferEndpoint('/api/workflows');
  const earlierList=vm.runInContext('refreshHistory()',context);await settle();
  assert.equal(staleList.requested,true);
  invalidateSource();
  const currentList=deferEndpoint('/api/workflows');
  const laterList=vm.runInContext('refreshHistory()',context);await settle();
  assert.equal(currentList.requested,true);
  const newest=currentRecord({reference:'sha256:'+'7'.repeat(64),state:'succeeded',result:evidence});
  currentList.finish([newest]);await laterList;
  assert.deepEqual(get('job-history').children.map(item=>item.value),['',newest.reference]);
  staleList.finish([archived]);await earlierList;
  assert.deepEqual(get('job-history').children.map(item=>item.value),['',newest.reference],'An older list must not replace the newest response');
  assertInvalidated();

  // A list response must preserve a selection made through the real detail handler while pending.
  setWorkspace();
  const oldSelection=currentRecord({state:'succeeded',result:evidence});displayWorkflow(oldSelection);
  get('job-history').value=oldSelection.reference;
  const selectionList=deferEndpoint('/api/workflows');
  const refreshingList=vm.runInContext('refreshHistory()',context);await settle();
  const selected=currentRecord({source:'earlier source',reference:'sha256:'+'8'.repeat(64),state:'succeeded',result:{...evidence,energy_hartree:-75.2}});
  const selectionRead=deferEndpoint('/api/workflow/read');
  get('job-history').value=selected.reference;
  const selecting=get('job-history').onchange();await settle();
  assert.equal(selectionRead.body.reference,selected.reference);
  selectionRead.finish(selected);await selecting;
  selectionList.finish([oldSelection,selected]);await refreshingList;
  assert.deepEqual(get('job-history').children.map(item=>item.value),['',oldSelection.reference,selected.reference]);
  assert.equal(get('job-history').value,selected.reference,'A late list must preserve the latest selected calculation');
  assert.equal(currentWorkflow().reference,selected.reference);
  assert.match(get('computed-results').textContent,/-75\.2/);
  assert.equal(get('approve-compute').disabled,true);
  assert.equal(get('run-compute').disabled,true);
  assert.equal(endpointCount('/api/workflow/approve'),0);
  assert.equal(endpointCount('/api/workflow/submit'),0);

  let value = await prepare('copper',null,null,geometry,'copper_second');
  assert.equal(value.object_id,'copper_second');
  assert.equal(value.orchestration_ref,undefined);
  assert.match(get('execution-message').textContent,/Direct preparation/);

  // Complete this direct interaction, then dispatch the same event as a geometry revision.
  // A historical FCC result must not stay visible as evidence for a newly constructed slab.
  context.completed={state:'succeeded',reference:recordHash,source:'test source',attachments:{},plan:{kind:'copper'},result:{evidence_eligible:true,
    ranking:[{rank:1,scale:'1',energy_eV_per_atom:'-.00495'},{rank:2,scale:'.98',energy_eV_per_atom:'.018'}]}};
  context.pollFired=false;
  vm.runInContext('showWorkflow(completed);workflowTimer=setTimeout(()=>{pollFired=true;},20);',context);
  const savedHistory=get('job-history').children.slice();
  assert.ok(get('energy-chart').children.length>0);
  assert.ok(get('computed-results').children.length>0);
  assert.equal(get('download-evidence').disabled,false);
  assert.notEqual(get('resolved-plan').textContent,'');
  context.document.dispatchEvent({type:'workspace-changed'});
  assert.equal(get('energy-chart').children.length,0);
  assert.equal(get('computed-results').children.length,0);
  assert.equal(get('computed-results').textContent,'No computed evidence yet.');
  assert.equal(get('resolved-plan').textContent,'');
  assert.match(get('execution-message').textContent,/Source or geometry changed/);
  for(const id of ['approve-compute','run-compute','cancel-compute','download-evidence'])assert.equal(get(id).disabled,true,id);
  assert.equal(vm.runInContext('activeWorkflow===null&&workflowTimer===null',context),true);
  assert.deepEqual(get('job-history').children,savedHistory,'Completed runs remain available in history');
  for(const timer of timers.values())timer.callback();
  timers.clear();
  assert.equal(context.pollFired,false,'Invalidated workflow polling must stop');

  const reordered = {atoms:geometry.atoms,multiplicity:1,charge:0};
  value = await prepare('water',record('water'),null,reordered);
  assert.equal(value.object_id,'water_second','Planner target must win over the first Molecule');
  assert.equal(value.orchestration_ref,recordHash,'JSON object-key order must not break provenance');

  const edited = structuredClone(geometry); edited.atoms[1][3]='.96';
  value = await prepare('water',record('water'),null,edited);
  assert.equal(value.object_id,'water_second');
  assert.equal(value.orchestration_ref,undefined,'Edited coordinates are direct, not fixture provenance');
  assert.match(get('execution-message').textContent,/Direct preparation/);

  value = await prepare('copper',record('copper'),structuredClone(copper));
  assert.equal(value.object_id,'copper_second','Planner target must win over the first PeriodicStructure');
  assert.equal(value.orchestration_ref,recordHash);
  assert.deepEqual(value.scales,[.98,1,1.02]);

  const changedPlan=structuredClone(copper); changedPlan.candidates[0].scale='0.99';
  value = await prepare('copper',record('copper'),changedPlan);
  assert.equal(value.orchestration_ref,undefined);
  assert.deepEqual(value.scales,[.99,1,1.02]);

  for (const mutation of ['inspection','refusal','source','imports','target','profile']) {
    const modelRecord = record('water');
    if(mutation==='inspection')modelRecord.trace[0].action.action='object_inspect';
    if(mutation==='refusal'){modelRecord.state='NEEDS_INPUT';modelRecord.trace=[];}
    if(mutation==='source')modelRecord.source_hash='sha256:'+'4'.repeat(64);
    if(mutation==='imports')modelRecord.source_semantic_hash='sha256:'+'4'.repeat(64);
    if(mutation==='target')modelRecord.trace[0].action.object_id='first';
    value = await prepare(mutation==='profile'?'copper':'water',modelRecord,null);
    assert.equal(value.orchestration_ref,undefined,`${mutation} must not become calculation provenance`);
    assert.match(get('execution-message').textContent,/Direct preparation/);
  }

  snapshot.document.objects.push({id:'complex_selected',kind:'Molecule'});snapshot.scene.structures=snapshot.document.objects.map(sceneGeometry);
  const complexRecord={state:'REPORTED',record_hash:recordHash,source_hash:sourceHash,source_semantic_hash:semanticHash,execution_authorized:false,trace:[{action:{action:'plan_molecular_single_point',object_id:'complex_selected',scale_factors:[]},output:{tool_name:'plan_molecular_single_point',status:'succeeded',authority:'host_read_and_derive_only',source_hash:sourceHash,data:molecular}}]};
  value=await prepare('molecular',complexRecord,null);
  assert.equal(value.object_id,'complex_selected');
  assert.equal(value.orchestration_ref,recordHash);
  assert.deepEqual(value.proposal,molecular);
  const staleComplex=structuredClone(complexRecord);staleComplex.source_hash='sha256:'+'8'.repeat(64);
  value=await prepare('molecular',staleComplex,null,geometry,'complex_selected');
  assert.equal(value.orchestration_ref,undefined);
  assert.deepEqual(value.proposal,molecular);

  for(const name of ['Gemma 4 E4B','Gemma 4 E2B','Gemma 4 26B A4B candidate']){
    get('model-name').textContent=name;
    const proposing=vm.runInContext('propose(true)',context);
    assert.match(get('agent-progress').textContent,new RegExp(`Waiting for ${name}`));
    assert.ok(pendingModel,'Expected one model HTTP request');
    pendingModel({ok:true,json:async()=>({state:'NEEDS_INPUT',trace:[],execution_authorized:false})});
    await proposing;
  }
  await scenario('Pending preparation cannot restore invalidated source',async()=>{
    setWorkspace();
    const pending=deferEndpoint('/api/workflow/prepare');
    const work=get('prepare-compute').onclick();await settle();
    assert.equal(pending.requested,true);
    invalidateSource();
    pending.finish(workflowRecord(pending.body));await work;
    assertInvalidated();
  });

  for(const changed of ['source','attachments'])await scenario(`Workspace fingerprint rejects ${changed} changes without an invalidation event`,async()=>{
    setWorkspace({attachments:{'input.cif':'original'}});
    const pending=deferEndpoint('/api/workflow/prepare');
    const work=get('prepare-compute').onclick();await settle();
    assert.equal(pending.requested,true);
    if(changed==='source')get('source').value='changed without an input event';
    else vm.runInContext("attachments['input.cif']='changed without an input event'",context);
    pending.finish(workflowRecord(pending.body));await work;
    assertInvalidated();
  });

  await scenario('Invalidated molecular tool response cannot start preparation',async()=>{
    setWorkspace({profile:'molecular'});
    const pending=deferEndpoint('/api/tool'),before=requests.length;
    const work=get('prepare-compute').onclick();await settle();
    assert.equal(pending.requested,true);
    invalidateSource();
    pending.finish({data:molecular});await work;
    assert.equal(requests.length,before,'Stale molecular proposal must never reach workflow preparation');
    assertInvalidated();
  });

  await scenario('Pending approval cannot restore invalidated source or Run',async()=>{
    setWorkspace();
    const prepared=currentRecord();displayWorkflow(prepared);
    const pending=deferEndpoint('/api/workflow/approve');
    const work=get('approve-compute').onclick();await settle();
    assert.equal(pending.requested,true);
    invalidateSource();
    pending.finish({...prepared,state:'approved'});await work;
    assertInvalidated();
    const before=endpointCount('/api/workflow/submit');
    await get('run-compute').onclick();
    assert.equal(endpointCount('/api/workflow/submit'),before,'Detached workflow cannot submit through direct handler invocation');
  });

  await scenario('Starting preparation immediately clears previous approval',async()=>{
    setWorkspace();displayWorkflow(currentRecord({state:'approved',result:evidence}));
    assert.equal(get('run-compute').disabled,false);
    const pending=deferEndpoint('/api/workflow/prepare');
    const work=get('prepare-compute').onclick();await settle();
    assert.equal(pending.requested,true);
    assertInvalidated();
    pending.finish(workflowRecord(pending.body));await work;
    assert.equal(currentWorkflow().state,'prepared');
    assert.equal(get('approve-compute').disabled,false);
    assert.equal(get('run-compute').disabled,true);
  });

  for(const profile of ['water','molecular','copper'])await scenario(`${profile} proposal clears previous approval and evidence`,async()=>{
    setWorkspace();displayWorkflow(currentRecord({state:'approved',result:evidence}));
    const details={water:{geometry},molecular,copper};
    context.document.dispatchEvent({type:profile+'-proposed',detail:details[profile]});
    assert.equal(get('compute-profile').value,profile);
    assertInvalidated();
  });

  for(const outcome of ['running','error'])await scenario(`Late poll ${outcome} cannot repaint or reschedule after invalidation`,async()=>{
    setWorkspace();
    const running=currentRecord({state:'running'});displayWorkflow(running);
    const pending=deferEndpoint('/api/workflow/read');
    const work=vm.runInContext('pollWorkflow(activeWorkflow.reference)',context);await settle();
    assert.equal(pending.requested,true);
    invalidateSource();
    const message=get('execution-message').textContent;
    if(outcome==='error')pending.fail('Old polling failure');else pending.finish(running);
    await work;
    assertInvalidated();
    assert.equal(get('execution-message').textContent,message,'Late poll errors must not overwrite current guidance');
  });

  await scenario('Out-of-order history responses preserve the later selection',async()=>{
    setWorkspace();
    const first=currentRecord({reference:'sha256:'+'5'.repeat(64),state:'succeeded',result:evidence});
    const second=currentRecord({reference:'sha256:'+'6'.repeat(64),state:'succeeded',result:{...evidence,energy_hartree:-75.1}});
    const firstRead=deferEndpoint('/api/workflow/read'),secondRead=deferEndpoint('/api/workflow/read');
    get('job-history').value=first.reference;
    const earlier=get('job-history').onchange();await settle();
    get('job-history').value=second.reference;
    const later=get('job-history').onchange();await settle();
    assert.equal(firstRead.body.reference,first.reference);
    assert.equal(secondRead.body.reference,second.reference);
    secondRead.finish(second);await later;
    const message=get('execution-message').textContent;
    firstRead.finish(first);await earlier;
    assert.equal(currentWorkflow().reference,second.reference);
    assert.match(get('computed-results').textContent,/-75\.1/);
    assert.equal(get('execution-message').textContent,message);
    assert.equal(timers.size,0);
  });

  for(const mismatch of ['source','attachments'])await scenario(`Historical ${mismatch} mismatch remains viewable but cannot approve or run`,async()=>{
    setWorkspace({attachments:{'input.cif':'current attachment'}});
    const historical=currentRecord({state:'approved',result:evidence});
    if(mismatch==='source')historical.source='earlier source';else historical.attachments={'input.cif':'earlier attachment'};
    const pending=deferEndpoint('/api/workflow/read');
    get('job-history').value=historical.reference;
    const reading=get('job-history').onchange();await settle();
    pending.finish(historical);await reading;
    assert.match(get('computed-results').textContent,/-74\.9/);
    assert.notEqual(get('resolved-plan').textContent,'');
    assert.equal(get('download-evidence').disabled,false);
    assert.equal(get('approve-compute').disabled,true);
    assert.equal(get('run-compute').disabled,true);
    const approvedBefore=endpointCount('/api/workflow/approve'),runBefore=endpointCount('/api/workflow/submit');
    await get('approve-compute').onclick();await get('run-compute').onclick();
    assert.equal(endpointCount('/api/workflow/approve'),approvedBefore,'Mismatched history must be guarded in the handler, not just its button');
    assert.equal(endpointCount('/api/workflow/submit'),runBefore,'Mismatched history must never submit');
    assert.equal(get('download-evidence').disabled,false);
  });

  await scenario('Attachment key order does not invalidate a matching historical workflow',async()=>{
    setWorkspace({attachments:{'a.cif':'a','b.cif':'b'}});
    const matching=currentRecord({state:'approved',attachments:{'b.cif':'b','a.cif':'a'}});
    displayWorkflow(matching);
    assert.equal(get('approve-compute').disabled,false);
    assert.equal(get('run-compute').disabled,false);
    const pending=deferEndpoint('/api/workflow/approve');
    const approving=get('approve-compute').onclick();await settle();
    assert.equal(pending.requested,true);
    assert.deepEqual(pending.body.attachments,{'a.cif':'a','b.cif':'b'});
    pending.finish(matching);await approving;
    assert.equal(get('run-compute').disabled,false);
  });

  for(const outcome of ['running','error'])await scenario(`Late submit ${outcome} cannot restore a workflow or begin polling`,async()=>{
    setWorkspace();
    const approved=currentRecord({state:'approved'});displayWorkflow(approved);
    const pending=deferEndpoint('/api/workflow/submit');
    const work=get('run-compute').onclick();await settle();
    assert.equal(pending.requested,true);
    invalidateSource();
    const message=get('execution-message').textContent,readsBefore=endpointCount('/api/workflow/read');
    if(outcome==='error')pending.fail('Old submission failure');else pending.finish({...approved,state:'running'});
    await work;await settle();
    assertInvalidated();
    assert.equal(get('execution-message').textContent,message);
    assert.equal(endpointCount('/api/workflow/read'),readsBefore,'Late submission must not start polling');
  });

  for(const outcome of ['success','error'])await scenario(`Late cancellation ${outcome} cannot change a replacement workflow`,async()=>{
    setWorkspace();
    const old=currentRecord({state:'running'});displayWorkflow(old);
    const pending=deferEndpoint('/api/workflow/cancel');
    const work=get('cancel-compute').onclick();await settle();
    assert.equal(pending.requested,true);
    setWorkspace();
    const replacement=currentRecord({reference:'sha256:'+'7'.repeat(64),state:'prepared'});displayWorkflow(replacement);
    const message=get('execution-message').textContent,readsBefore=endpointCount('/api/workflow/read');
    if(outcome==='error')pending.fail('Old cancellation failure');else pending.finish({...old,state:'cancelled'});
    await work;await settle();
    assert.equal(currentWorkflow().reference,replacement.reference);
    assert.equal(get('execution-message').textContent,message);
    assert.equal(get('run-state').textContent,'PREPARED');
    assert.equal(endpointCount('/api/workflow/read'),readsBefore);
    assert.equal(timers.size,0);
  });

  await scenario('Current submission follows running polls through completed evidence',async()=>{
    setWorkspace();
    const approved=currentRecord({state:'approved'}),running={...approved,state:'running'};displayWorkflow(approved);
    const submission=deferEndpoint('/api/workflow/submit'),firstPoll=deferEndpoint('/api/workflow/read');
    const work=get('run-compute').onclick();await settle();
    assert.equal(submission.requested,true);
    submission.finish(running);await work;await settle();
    assert.equal(firstPoll.requested,true,'Current submission must still begin polling');
    firstPoll.finish(running);await settle();
    assert.equal(currentWorkflow().state,'running');
    assert.equal(timers.size,1,'Current running result must schedule the next poll');
    const finalPoll=deferEndpoint('/api/workflow/read');
    const [timerId,timer]=timers.entries().next().value;timers.delete(timerId);timer.callback();await settle();
    assert.equal(finalPoll.requested,true);
    finalPoll.finish({...approved,state:'succeeded',result:evidence});await settle();
    assert.equal(currentWorkflow().state,'succeeded');
    assert.match(get('computed-results').textContent,/-74\.9/);
    assert.equal(get('download-evidence').disabled,false);
    assert.equal(timers.size,0);
  });

  await scenario('Current cancellation follows teardown to cancelled state',async()=>{
    setWorkspace();
    const running=currentRecord({state:'running'});displayWorkflow(running);
    const cancellation=deferEndpoint('/api/workflow/cancel'),poll=deferEndpoint('/api/workflow/read');
    const work=get('cancel-compute').onclick();await settle();
    assert.equal(cancellation.requested,true);
    cancellation.finish({state:'cancelling'});await work;await settle();
    assert.equal(poll.requested,true,'Current cancellation must still monitor teardown');
    poll.finish({...running,state:'cancelled'});await settle();
    assert.equal(currentWorkflow().state,'cancelled');
    assert.equal(get('cancel-compute').disabled,true);
    assert.equal(timers.size,0);
  });

  snapshot.scene={structures:snapshot.document.objects.map(sceneGeometry),unavailable:[]};

  await scenario('Changing the displayed object clears approval and evidence while retaining history',async()=>{
    setWorkspace();
    const approved=currentRecord({state:'approved',result:evidence});displayWorkflow(approved);
    get('job-history').append(new context.Option('Earlier completed calculation',recordHash));
    const history=get('job-history').children.slice();
    geometryCalls.length=0;
    get('structure-select').value='complex_selected';get('structure-select').onchange();
    assertInvalidated();
    assert.deepEqual(get('job-history').children,history,'Target changes must keep earlier evidence discoverable');
    assert.equal(geometryCalls.at(-1).kind,'display');
    assert.equal(geometryCalls.at(-1).geometry.object_id,'complex_selected');
  });

  for(const profile of ['water','molecular','copper'])await scenario(`${profile} proposal displays its exact object from a multi-object scene`,async()=>{
    setWorkspace({profile});
    get('structure-select').value=profile==='copper'?'copper_first':'first';
    const details={water:{object_id:'water_second',geometry},molecular,copper};
    const target=profile==='water'?'water_second':details[profile].subject_ref;
    displayWorkflow(currentRecord({state:'approved',result:evidence}));
    geometryCalls.length=0;
    if(profile==='copper'){
      context.copperFixture=copper;vm.runInContext('currentPlan=copperFixture',context);
      context.document.dispatchEvent({type:'copper-proposed'});
    }else context.document.dispatchEvent({type:profile+'-proposed',detail:details[profile]});
    assertInvalidated();
    assert.equal(get('structure-select').value,target);
    assert.equal(geometryCalls.at(-1).kind,'display');
    assert.equal(geometryCalls.at(-1).geometry.object_id,target);
    assert.deepEqual(geometryCalls.filter(call=>call.kind==='display').map(call=>call.geometry.object_id),[target],'Proposal must never display the first unrelated object');
  });

  await scenario('Unavailable proposal target clears the previous geometry without substitution',async()=>{
    setWorkspace({profile:'molecular'});
    displayWorkflow(currentRecord({state:'approved',result:evidence}));
    geometryCalls.length=0;
    context.document.dispatchEvent({type:'molecular-proposed',detail:{...molecular,object_id:'missing_molecule',subject_ref:'missing_molecule'}});
    assertInvalidated();
    assert.equal(get('structure-select').value,'');
    assert.equal(geometryCalls.at(-1).kind,'clear');
    assert.equal(geometryCalls.filter(call=>call.kind==='display').length,0);
    assert.match(get('execution-message').textContent,/missing_molecule/);
    assert.match(get('execution-message').textContent,/unavailable|not available|no.*geometry|not.*admitted/i);
  });

  await scenario('Historical target mismatch remains reviewable and cannot approve or run',async()=>{
    setWorkspace({profile:'molecular'});
    const historical=currentRecord({state:'approved',result:evidence,plan:{kind:'molecular_hf_sto3g',subject:{subject_ref:'complex_selected'}}});
    get('structure-select').value='first';
    const pending=deferEndpoint('/api/workflow/read');get('job-history').value=historical.reference;
    const reading=get('job-history').onchange();await settle();pending.finish(historical);await reading;
    assert.match(get('computed-results').textContent,/-74\.9/);
    assert.equal(get('download-evidence').disabled,false);
    assert.equal(get('approve-compute').disabled,true);
    assert.equal(get('run-compute').disabled,true);
    const approvalCount=endpointCount('/api/workflow/approve'),submissionCount=endpointCount('/api/workflow/submit');
    await get('approve-compute').onclick();await get('run-compute').onclick();
    assert.equal(endpointCount('/api/workflow/approve'),approvalCount);
    assert.equal(endpointCount('/api/workflow/submit'),submissionCount);
    get('structure-select').value='complex_selected';get('structure-select').onchange();
    const matching=deferEndpoint('/api/workflow/read');get('job-history').value=historical.reference;
    const reopened=get('job-history').onchange();await settle();matching.finish(historical);await reopened;
    assert.equal(get('approve-compute').disabled,false,'Matching displayed target must remain eligible for approval');
    assert.equal(get('run-compute').disabled,false,'Matching displayed target must remain eligible to run');
  });

  await scenario('Recompiling the same scene preserves the selected second object and current evidence',async()=>{
    for(const state of ['approved','succeeded']){
      setWorkspace();
      assert.equal(snapshot.scene.structures[1].object_id,'water_second');
      get('structure-select').value='water_second';
      const workflow=currentRecord({state,result:evidence});displayWorkflow(workflow);
      const history=get('job-history').children.slice();
      const before=dispatchedEvents.filter(type=>type==='structure-selection-changed').length;
      geometryCalls.length=0;
      vm.runInContext('populateScene()',context);
      assert.equal(get('structure-select').value,'water_second');
      assert.equal(geometryCalls.at(-1).geometry.object_id,'water_second');
      assert.equal(dispatchedEvents.filter(type=>type==='structure-selection-changed').length,before,'Unchanged effective selection must not invalidate current evidence');
      assert.equal(currentWorkflow().state,state);
      assert.match(get('computed-results').textContent,/-74\.9/);
      assert.equal(get('download-evidence').disabled,false);
      assert.equal(get('run-compute').disabled,state!=='approved');
      assert.deepEqual(get('job-history').children,history);
    }
  });

  await scenario('A disappearing selected object falls back once and clears previous approval',async()=>{
    setWorkspace();displayWorkflow(currentRecord({state:'approved',result:evidence}));
    const history=get('job-history').children.slice(),scene=snapshot.scene;
    const before=dispatchedEvents.filter(type=>type==='structure-selection-changed').length;
    geometryCalls.length=0;
    try{
      snapshot.scene={...scene,structures:scene.structures.filter(structure=>structure.object_id!=='water_second')};
      vm.runInContext('populateScene()',context);
      assert.equal(get('structure-select').value,'first');
      assert.equal(geometryCalls.at(-1).kind,'display');
      assert.equal(geometryCalls.at(-1).geometry.object_id,'first');
      assert.equal(dispatchedEvents.filter(type=>type==='structure-selection-changed').length,before+1,'Fallback must emit exactly one effective selection change');
      assertInvalidated();
      assert.deepEqual(get('job-history').children,history);
    }finally{snapshot.scene=scene;}
  });

  await scenario('An empty replacement scene clears selection, viewport and execution once',async()=>{
    setWorkspace();displayWorkflow(currentRecord({state:'approved',result:evidence}));
    const history=get('job-history').children.slice(),scene=snapshot.scene;
    const before=dispatchedEvents.filter(type=>type==='structure-selection-changed').length;
    geometryCalls.length=0;
    try{
      snapshot.scene={structures:[],unavailable:[{object_id:'water_second',reason:'No admitted coordinates'}]};
      vm.runInContext('populateScene()',context);
      assert.equal(get('structure-select').value,'');
      assert.equal(get('structure-select').children.length,0);
      assert.equal(geometryCalls.at(-1).kind,'clear');
      assert.equal(geometryCalls.filter(call=>call.kind==='display').length,0);
      assert.equal(dispatchedEvents.filter(type=>type==='structure-selection-changed').length,before+1,'Empty scene must emit exactly one effective selection change');
      assertInvalidated();
      assert.deepEqual(get('job-history').children,history);
    }finally{snapshot.scene=scene;}
  });

  assert.equal([...deferredRoutes.values()].flat().length,0,'Every deferred route must have been exercised');
  console.log('Workflow UI: provenance, model status, and execution lifecycle regressions passed; no inference or calculation executed.');
  console.log(`Execution lifecycle: ${addedScenarios.length} scenarios passed.`);
  console.log('Saved-history list: 3 asynchronous startup, ordering and selection scenarios passed.');
  console.log('Completed-result invalidation: chart, table, plan, actions and polling cleared; history retained.');
})().catch(error=>{console.error(error);process.exitCode=1;});
