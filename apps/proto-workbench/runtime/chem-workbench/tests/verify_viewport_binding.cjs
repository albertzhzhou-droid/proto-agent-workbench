// Synthetic UI contracts only: no inference, scientific calculation or acceptance scores.
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'..'),elements=new Map(),listeners=new Map(),routes=new Map(),calls=[];
class Element {
 constructor(tag='div'){this.tagName=tag;this.value='';this.children=[];this._text='';this.disabled=false;this.hidden=false;this.attributes={};this.dataset={};this.subnodes=new Map();this.classList={add(){},remove(){},toggle(){}};}
 set textContent(value){this._text=String(value);this.children=[];}
 get textContent(){return this._text+this.children.map(child=>child.textContent||'').join(' ');}
 append(...children){this.children.push(...children);}
 replaceChildren(...children){this._text='';this.children=children;}
 setAttribute(key,value){this.attributes[key]=value;}
 querySelectorAll(){return [];}
 querySelector(selector){if(!this.subnodes.has(selector))this.subnodes.set(selector,new Element());return this.subnodes.get(selector);}
 addEventListener(){}
 after(){}
 prepend(node){this.children.unshift(node);}
 click(){return this.onclick?.();}
}
const get=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
let displayed=null,context;
const hash=n=>'sha256:'+String(n).repeat(64);
function shape(id,n){return {version:'display-geometry/v1',object_id:id,kind:'Molecule',units:'angstrom',geometry_hash:hash(n),source_hash:hash(1),subject_hash:hash(n),provenance:'tool_generated',description:'Synthetic interaction fixture; no chemistry claim',method:'Synthetic fixture',cell:null,bonds:[],atoms:Array.from({length:14},(_,i)=>({id:'atom-'+i,element:i%5===0?'N':'C',position:[i*0.1234567890123,n*0.02,i===0?0:i*-0.3123456789012]}))};}
const first=shape('complex_a',2),second=shape('complex_b',3),source='synthetic UI source';
const snapshot={success:true,diagnostics:[],review:{},source_sha256:hash(1),semantic_hash:hash(4),document:{objects:[{id:first.object_id,kind:'Molecule'},{id:second.object_id,kind:'Molecule'}]},scene:{structures:[first,second],unavailable:[]}};
function proposal(geometry){return {version:'molecular-proposal/v1',object_id:geometry.object_id,subject_ref:geometry.object_id,geometry_hash:hash(8),execution_authorized:false,geometry:{units:'angstrom',charge:0,multiplicity:1,atoms:geometry.atoms.map(atom=>[atom.element,...atom.position.map(String)])}};}
function record(geometry=first,state='approved'){return {reference:hash(6),source,attachments:{},state,plan:{version:'resolved-plan/v1',kind:'molecular_hf_sto3g',method:'hf',basis:'sto-3g',subject:{subject_ref:geometry.object_id,geometry_hash:hash(8),proposal:proposal(geometry)}},result:{evidence_eligible:true,energy_hartree:'-455.123456789012',convergence:'converged',execution:{duration_ms:3875},scientific_scope:'Synthetic result for UI verification'}};}
function defer(url){let resolve;const promise=new Promise(done=>{resolve=done;});routes.set(url,()=>promise);return value=>resolve(value);}
const settle=()=>new Promise(resolve=>setImmediate(resolve));
context=vm.createContext({console,document:{body:{dataset:{studio:'structure'}},getElementById:get,createElement:tag=>new Element(tag),createElementNS:(_,tag)=>new Element(tag),querySelector:selector=>get('selector:'+selector),querySelectorAll:()=>[],addEventListener(type,fn){if(!listeners.has(type))listeners.set(type,[]);listeners.get(type).push(fn);},dispatchEvent(event){for(const fn of listeners.get(event.type)||[])fn(event);}},window:{addEventListener(){},getDisplayedGeometry:()=>displayed},Event:function(type){this.type=type;},CustomEvent:function(type,options){this.type=type;this.detail=options?.detail;},Option:function(label,value){const option=new Element('option');option.textContent=label;option.value=value;return option;},confirm:()=>true,performance:require('node:perf_hooks').performance,setInterval:()=>1,clearInterval(){},setTimeout:()=>1,clearTimeout(){},displayGeometry(geometry,scale=1){displayed={geometry,scale};context.document.dispatchEvent({type:'geometry-display-changed',detail:displayed});},clearGeometry(){displayed=null;context.document.dispatchEvent({type:'geometry-display-changed',detail:null});},fetch:async(url,options)=>{const body=options.body?JSON.parse(options.body):null;calls.push({url,body});const route=routes.get(url);if(route){routes.delete(url);return {ok:true,json:async()=>route(body)};}const values={'/api/workspace':{examples:[],registry:{}},'/api/compile':snapshot,'/api/model/status':{available:true,display_name:'Synthetic local provider'},'/api/profiles':{water_geometry:{}},'/api/workflows':[],'/api/projects':[],'/api/design/catalog':{study:{name:'Synthetic UI study'}}};assert.ok(url in values,'Unexpected endpoint '+url);return {ok:true,json:async()=>values[url]};}});
for(const name of ['app.js','workflow.js','structure-lab.js','design-studio.js'])vm.runInContext(fs.readFileSync(path.join(root,'src/chem_workbench/web_assets',name),'utf8'),context,{filename:name});
function run(code,value){context.fixture=value;return vm.runInContext(code,context);}
function reset(){context.document.body.dataset.studio='structure';get('source').value=source;run('invalidate();result=fixture;',snapshot);get('compute-profile').value='molecular';get('structure-select').value=first.object_id;context.displayGeometry(first);get('water-geometry').value='{}';}
function show(value){run('showWorkflow(fixture)',value);}
const count=url=>calls.filter(item=>item.url===url).length;
let passed=0;
async function check(name,fn){try{reset();await fn();passed++;}catch(error){error.message=name+': '+error.message;throw error;}}
(async()=>{
 await settle();
 await check('Preview updates the actual second structure, not metadata alone',async()=>{
  const finish=defer('/api/orchestrate'),pending=run('propose(true)');await settle();
  finish({state:'REPORTED',trace:[{action:{action:'structure_preview'},output:{status:'succeeded',data:{object_id:second.object_id,geometry_hash:second.geometry_hash}}}],execution_authorized:false});await pending;
  assert.equal(displayed.geometry.geometry_hash,second.geometry_hash);assert.equal(get('structure-select').value,second.object_id);
 });
 await check('Preview hash mismatch clears unrelated coordinates',async()=>{run('showPreviewGeometry(fixture)',{object_id:second.object_id,geometry_hash:hash(9)});assert.equal(displayed,null);});
 const edited=structuredClone(first);edited.geometry_hash=hash(5);edited.parent_geometry_hash=first.geometry_hash;edited.provenance='user_edited';edited.atoms[7].position[1]+=0.875;
 await check('Lab revision is selected explicitly and cannot silently prepare compiled source',async()=>{
  run('showLabGeometry(fixture)',edited);assert.equal(get('structure-select').value,'geometry-revision:'+edited.geometry_hash);
  const before=count('/api/workflow/prepare'),tools=count('/api/tool');await get('prepare-compute').click();assert.equal(count('/api/workflow/prepare'),before);assert.equal(count('/api/tool'),tools);assert.match(get('execution-message').textContent,/Lab revision/);
 });
 await check('Late model response remains invalid after moving away and back',async()=>{
  const finish=defer('/api/orchestrate'),pending=run('propose(true)');await settle();context.displayGeometry(edited);context.displayGeometry(first);
  finish({state:'REPORTED',trace:[],execution_authorized:false});await pending;assert.equal(run('agentRecord'),null);assert.match(get('agent-progress').textContent,/discarded/);
 });
 await check('Same object with a different coordinate revision cannot approve or run',async()=>{
  context.displayGeometry(edited);show(record());assert.equal(get('approve-compute').disabled,true);assert.equal(get('run-compute').disabled,true);assert.match(get('computed-results').textContent,/HISTORICAL RESULT/);
  const before=calls.length;await get('approve-compute').click();await get('run-compute').click();assert.equal(calls.length,before);
 });
 await check('Showing recorded input restores exact coordinates for explicit review',async()=>{
  context.displayGeometry(edited);show(record());const button=get('execution-message').children.find(item=>item.textContent==='Show recorded input');assert.ok(button);await button.click();assert.deepEqual(displayed.geometry.atoms,first.atoms);assert.equal(get('run-compute').disabled,false);
 });
 await check('Scale mismatch invalidates a single point even on the same object',async()=>{context.displayGeometry(first,1.02);show(record());assert.equal(get('run-compute').disabled,true);});
 await check('Late approval cannot resurrect geometry invalidated in flight',async()=>{
  const prepared=record(first,'prepared');show(prepared);const finish=defer('/api/workflow/approve'),pending=get('approve-compute').click();await settle();context.displayGeometry(edited);context.displayGeometry(first);finish({...prepared,state:'approved'});await pending;assert.equal(run('activeWorkflow'),null);assert.equal(get('run-compute').disabled,true);
 });
 await check('New plan displays its recorded input before enabling approval',async()=>{
  const input=structuredClone(first);input.atoms[2].position[0]+=0.0625;
  routes.set('/api/tool',()=>({data:proposal(first)}));routes.set('/api/workflow/prepare',()=>record(input,'prepared'));
  await get('prepare-compute').click();assert.equal(JSON.stringify(displayed.geometry.atoms.map(atom=>atom.position)),JSON.stringify(input.atoms.map(atom=>atom.position)));assert.equal(displayed.geometry.geometry_hash,null);assert.equal(displayed.geometry.provenance,'calculation_input');assert.equal(get('approve-compute').disabled,false);
 });
 await check('Late Lab edits cannot overwrite a subsequently selected structure',async()=>{
  run('showLabGeometry(fixture)',edited);const finish=defer('/api/structure/edit'),pending=get('apply-coordinates').click();await settle();get('structure-select').value=second.object_id;get('structure-select').onchange();finish({...edited,geometry_hash:hash(7)});await pending;assert.equal(displayed.geometry.object_id,second.object_id);
 });
 await check('Single point workbench keeps full numeric precision and actual diagnostics',async()=>{
  show(record());const text=get('computed-results').textContent;assert.match(text,/-455\.123456789012/);assert.match(text,/3875/);assert.match(text,/converged/);assert.ok(get('computed-results').children.some(item=>item.tagName==='dl'));assert.ok(get('computed-results').children.some(item=>item.tagName==='details'));
 });
 await check('Revision comparison includes every matched atom and exact Cartesian shifts',async()=>{
  run('showLabGeometry(fixture)',first);run('showLabGeometry(fixture)',edited);run('renderStructureComparison(fixture)',{left:first.geometry_hash,right:edited.geometry_hash,rms_displacement_angstrom:0.875/Math.sqrt(14),maximum_displacement_angstrom:0.875,scope:'Atom-ID Cartesian correspondence; no alignment',comparison_hash:hash(7)});
  const table=get('structure-comparison').children.find(item=>item.tagName==='table');assert.ok(table);const tbody=table.children.find(item=>item.tagName==='tbody');assert.equal(tbody.children.length,14);assert.match(tbody.children[7].textContent,/0\.875/);assert.ok(get('structure-comparison').children.some(item=>item.tagName==='svg'));
 });

 await check('Unrecorded coordinates remain fail closed',async()=>{const value=record();value.plan.subject={subject_ref:first.object_id};show(value);assert.equal(get('run-compute').disabled,true);assert.equal(get('approve-compute').disabled,true);});
 await check('Excluded candidates retain reasons and expose their actual input cell',async()=>{
  const candidates=[1,1.02].map((scale,index)=>({candidate_hash:hash(index+7),scale:String(scale),lattice_angstrom:[[String(4*scale),'0','0'],['0',String(4*scale),'0'],['0','0',String(4*scale)]],fractional_sites:[{id:'s1',element:'Cu',coordinates:['0','0','0'],occupancy:1},{id:'s2',element:'Cu',coordinates:['0.5','0.5','0'],occupancy:1}]}));
  const value={reference:hash(6),source,attachments:{},state:'succeeded',plan:{kind:'cu_lattice_scan',subject:{subject_ref:first.object_id},candidates},result:{evidence_eligible:true,ranking:[{rank:1,scale:'1',energy_eV_per_atom:'-0.123456789012345',candidate_hash:hash(7)}],excluded:[{scale:'1.02',candidate_hash:hash(8),reason:'NOT_CONVERGED',error:'Synthetic failure'}]}};
  run('withRecordedGeometry(inputGeometry(fixture.plan))',value);show(value);
  const table=get('computed-results').children.find(item=>item.tagName==='table'),tbody=table.children.find(item=>item.tagName==='tbody');assert.equal(tbody.children.length,2);assert.match(tbody.children[1].textContent,/NOT_CONVERGED/);
  const button=tbody.children[1].children.at(-1).children[0];assert.ok(button);await button.click();assert.equal(displayed.geometry.cell[0][0],4.08);assert.equal(displayed.geometry.atoms[1].position[0],2.04);assert.equal(displayed.geometry.display_repeats,1);assert.equal(displayed.scale,1);assert.equal(displayed.geometry.input_record_hash,hash(8));
 });
 await check('Pending Lab coordinate edits do not overwrite later text',async()=>{
  run('showLabGeometry(fixture)',edited);const finish=defer('/api/structure/edit'),pending=get('apply-coordinates').click();await settle();get('coordinate-edit').value='[[10,20,30]]';finish({...edited,geometry_hash:hash(7)});await pending;assert.equal(get('coordinate-edit').value,'[[10,20,30]]');assert.equal(displayed.geometry.geometry_hash,edited.geometry_hash);
 });
 await check('Changing the selected compiled subject detaches the earlier planner',async()=>{
  run('agentRecord=fixture;currentPlan={subject_ref:"complex_a"}',{state:'REPORTED'});get('structure-select').value=second.object_id;get('structure-select').onchange();assert.equal(run('agentRecord'),null);assert.equal(run('currentPlan'),null);
 });

 await check('Selecting an older Lab revision updates the editor and edit parent',async()=>{
  run('showLabGeometry(fixture)',first);run('showLabGeometry(fixture)',edited);
  get('structure-select').value='geometry-revision:'+first.geometry_hash;get('structure-select').onchange();
  assert.equal(displayed.geometry.geometry_hash,first.geometry_hash);assert.equal(run('labGeometry.geometry_hash'),first.geometry_hash);assert.equal(get('coordinate-edit').value,JSON.stringify(first.atoms.map(atom=>atom.position),null,2));
  const positions=first.atoms.map(atom=>[...atom.position]);positions[0][0]=1.25;get('coordinate-edit').value=JSON.stringify(positions);const finish=defer('/api/structure/edit'),pending=get('apply-coordinates').click();await settle();
  assert.equal(calls.at(-1).url,'/api/structure/edit');assert.equal(calls.at(-1).body.reference,first.geometry_hash);assert.deepEqual(calls.at(-1).body.positions,positions);
  const saved={...first,geometry_hash:hash(9),parent_geometry_hash:first.geometry_hash,atoms:first.atoms.map((atom,index)=>({...atom,position:positions[index]}))};finish(saved);await pending;assert.equal(displayed.geometry.geometry_hash,saved.geometry_hash);
 });
 await check('Design to Structure roundtrip restores the selected Lab revision and unsaved draft',async()=>{
  run('showLabGeometry(fixture)',first);run('showLabGeometry(fixture)',edited);get('structure-select').value='geometry-revision:'+first.geometry_hash;get('structure-select').onchange();
  const draft=first.atoms.map(atom=>[...atom.position]);draft[4][0]=3.141592653589793;const text=JSON.stringify(draft);get('coordinate-edit').value=text;
  await get('open-design-studio').click();assert.equal(context.document.body.dataset.studio,'design');context.displayGeometry(second);assert.equal(get('apply-coordinates').disabled,true);
  await get('open-structure-studio').click();assert.equal(context.document.body.dataset.studio,'structure');assert.equal(displayed.geometry.geometry_hash,first.geometry_hash);assert.equal(run('labGeometry.geometry_hash'),first.geometry_hash);assert.equal(get('coordinate-edit').value,text);assert.equal(get('apply-coordinates').disabled,false);
 });
 await check('Unknown Structure selection clears the Design viewport on mode return',async()=>{
  await get('open-design-studio').click();context.displayGeometry(second);get('structure-select').value='geometry-revision:'+hash(0);await get('open-structure-studio').click();assert.equal(displayed,null);assert.equal(get('apply-coordinates').disabled,true);
 });
 await check('Compiled selection detaches the Lab editor and cannot save against its previous parent',async()=>{
  run('showLabGeometry(fixture)',edited);get('structure-select').value=first.object_id;get('structure-select').onchange();assert.equal(run('labGeometry'),null);assert.equal(get('coordinate-edit').value,'');assert.equal(get('apply-coordinates').disabled,true);
  const before=count('/api/structure/edit');await get('apply-coordinates').click();assert.equal(count('/api/structure/edit'),before);assert.match(get('structure-lab-message').textContent,/matching Lab revision/);
 });
 await check('Recompilation cannot leave a Lab editor attached behind compiled coordinates',async()=>{
  run('showLabGeometry(fixture)',edited);run('populateScene()');assert.equal(displayed.geometry.geometry_hash,first.geometry_hash);assert.equal(run('labGeometry'),null);assert.equal(get('coordinate-edit').disabled,true);
 });
 assert.equal(routes.size,0,'All deferred operations must be observed');
 console.log(`Viewport binding: ${passed} scenarios passed; synthetic UI contracts only, no inference or scientific execution.`);
})().catch(error=>{console.error(error);process.exitCode=1;});
