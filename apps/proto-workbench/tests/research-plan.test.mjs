import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compileResearchPlan, deriveMethodContract, researchHash, verifyResearchPlanIdentity } from '../src/main/services/research-plan-compiler.ts';
import { canonicalResearchJson } from '../src/shared/research-plan.ts';
import { evaluateResearchCompletion, invalidateEvidenceGraph, scientificDiff, validateEvidenceGraph } from '../src/shared/research-evidence-graph.ts';

const sha = value => String(value).repeat(64), sourceHash = sha('a'), runtimeHash = sha('b');
const catalog = {ok:true,execution:'local',tools:[{id:'descriptive_statistics',title:'Descriptive statistics',description:'Bounded fixture catalog schema',available:true,dependency:[],implementation:'proto-native',upstream_functions:[],missing_dependencies:[],quantity_profile:{status:'requires-dataset-binding',reason:'Reviewed adapter requires declared quantities.'},input_schema:{type:'object',additionalProperties:false,required:['values'],properties:{values:{type:'array',items:{type:'number'},minItems:1},seed:{type:'integer'}}}}],upstream:{}};
const method = deriveMethodContract(catalog.tools[0]);
function study(){return {schemaVersion:'proto.study-spec.v1',studyId:'12345678-1234-4123-8123-123456789012',title:'Measured values',question:'What values are recorded?',datasets:[{id:'dataset-1',version:1,sourcePath:'data/measurements.json',sha256:sourceHash,entityIds:['sample:S1'],units:['mol/L'],referenceVersion:'reference-v1'}],steps:[{id:'stats',title:'Statistics',tool:'descriptive_statistics',arguments:{values:[2,4,6]},bindings:[],role:'required',datasetIds:['dataset-1'],methodIdentity:{contractSha256:method.contractSha256,runtimeSha256:runtimeHash},assumptions:['Measurements share the declared analytical context.']}],proofObligations:[]};}
const host = {runtimeFingerprints:{descriptive_statistics:runtimeHash},datasetFingerprints:{'dataset-1':sourceHash}};
function compile(spec=study(),facts=host){return compileResearchPlan(spec,catalog,facts);}
function node(id,kind,extra={}){return {id,kind,version:'1',sha256:sourceHash,integrity:'verified',freshness:'current',label:id,...extra};}
function completion(plan){return {planSha256:plan.planSha256,attempts:[{stepId:'stats',attemptId:'attempt-1',status:'succeeded',effect:'committed',artifactIntegrity:'verified'}],graph:{schemaVersion:'proto.evidence-graph.v1',nodes:[node('dataset-1','dataset'),node('result','artifact',{stepId:'stats',planSha256:plan.planSha256})],edges:[]},obligationResults:plan.obligations.map(item=>({id:item.id,status:'satisfied',evidenceIds:[item.kind==='source-current'?'dataset-1':'result']}))};}

test('compiler lowers a deterministic frozen spec into the existing unmodified WorkflowDraft',()=>{
  const input=study(),before=structuredClone(input),a=compile(input),b=compile(input);
  assert.equal(a.ok,true);assert.deepEqual(a,b);assert.deepEqual(input,before);
  assert.deepEqual(a.workflow,{name:input.title,description:input.question,steps:[{id:'stats',title:'Statistics',tool:'descriptive_statistics',arguments:{values:[2,4,6]},bindings:[]}]});
  assert.equal(verifyResearchPlanIdentity(a.plan),true);assert.equal(a.plan.obligations.length,2);
  const changed=structuredClone(a.plan);changed.workflow.steps[0].arguments.values=[0];assert.equal(verifyResearchPlanIdentity(changed),false);
  assert.equal(a.plan.methods[0].outputSchema,null);assert.equal(a.plan.methods[0].scientificValidation,'not-established');
});
test('strict compiler never returns executable output for missing identities, units or method/runtime drift',()=>{
  for(const mutate of [s=>{s.datasets=[]},s=>{s.datasets[0].units=[]},s=>{s.datasets[0].units=['invented']},s=>{s.datasets[0].entityIds=[]},s=>{s.datasets[0].entityIds=['sample:S1','sample:S1']},s=>{s.datasets[0].referenceVersion=''},s=>{s.steps[0].methodIdentity.contractSha256=sha('d')},s=>{s.steps[0].methodIdentity.runtimeSha256=sha('d')},s=>{s.steps[0].arguments.values=['wrong']},s=>{s.datasets[0].sourcePath='../outside.json'},s=>{s.steps[0].unexpected='model authority'}]){
    const spec=study();mutate(spec);const result=compile(spec);assert.equal(result.ok,false,JSON.stringify(spec));assert.equal(Object.hasOwn(result,'workflow'),false);assert.equal(Object.hasOwn(result,'plan'),false);
  }
  assert.equal(compile(study(),{runtimeFingerprints:{},datasetFingerprints:{}}).ok,false);
  const stale=structuredClone(catalog);stale.execution='recorded';assert.equal(compileResearchPlan(study(),stale,host).ok,false);
});
test('catalog semantics change method identity but host availability is not a fake semantic version',()=>{
  const changed=structuredClone(catalog.tools[0]);changed.input_schema.properties.values.minItems=2;
  assert.notEqual(deriveMethodContract(changed).contractSha256,method.contractSha256);
  changed.input_schema=structuredClone(catalog.tools[0].input_schema);changed.available=false;
  assert.equal(deriveMethodContract(changed).contractSha256,method.contractSha256);
});
test('quantity adapter claims cannot be silently dropped while lowering to legacy workflow inputs',()=>{
  const spec=study();spec.proofObligations=[{id:'numerical-binding',stepId:'stats',kind:'quantity-bound',description:'Every quantity has identity and units.',required:true}];
  const result=compile(spec);assert.equal(result.ok,false);assert.ok(result.diagnostics.some(item=>item.code==='QUANTITY_WORKFLOW_UNSUPPORTED'));
});
test('required evidence cannot depend on optional or superseded work; cycles and type conflicts reject',()=>{
  for(const mode of ['optional','superseded','cycle','type']){
    const spec=study(),other={...structuredClone(spec.steps[0]),id:'other'};spec.steps.push(other);
    if(mode==='optional')other.role='optional-exploration';
    if(mode==='superseded'){other.role='superseded-with-reason';other.supersededReason='A reviewed newer source replaced this exploration.';}
    spec.steps[0].arguments={};spec.steps[0].bindings=[{argument:'values',fromStep:'other',pointer:'/values',type:mode==='type'?'number':'array'}];
    if(mode==='cycle'){other.arguments={};other.bindings=[{argument:'values',fromStep:'stats',pointer:'/values',type:'array'}];}
    assert.equal(compile(spec).ok,false,mode);
  }
  const spec=study();spec.steps.push({...structuredClone(spec.steps[0]),id:'old',role:'superseded-with-reason',supersededReason:'Superseded after review.'});
  const result=compile(spec);assert.equal(result.ok,true);assert.equal(result.workflow.steps.length,1);assert.equal(result.plan.spec.steps.length,2);
});
test('proof completion retains optional known failures but blocks every unknown effect including earlier attempts',()=>{
  const spec=study();spec.steps.push({...structuredClone(spec.steps[0]),id:'explore',role:'optional-exploration'});
  const {plan}=compile(spec),facts=completion(plan);facts.attempts.push({stepId:'explore',attemptId:'optional-1',status:'failed',effect:'none',artifactIntegrity:'unavailable'});
  let result=evaluateResearchCompletion(plan,facts);assert.equal(result.complete,true);assert.deepEqual(result.optionalFailures,['explore']);
  facts.attempts[1].effect='unknown';result=evaluateResearchCompletion(plan,facts);assert.equal(result.complete,false);assert.ok(result.blockers.some(item=>item.code==='UNKNOWN_EFFECT'));
  facts.attempts.push({stepId:'explore',attemptId:'optional-2',status:'succeeded',effect:'committed',artifactIntegrity:'verified'});
  assert.equal(evaluateResearchCompletion(plan,facts).complete,false,'later success must not erase unknown previous effects');
});
test('proof completion rejects missing, wrong-plan, unrelated, stale and corrupt evidence',()=>{
  const {plan}=compile();
  for(const mutate of [f=>{f.attempts=[]},f=>{f.obligationResults=[]},f=>{f.planSha256=sha('d')},f=>{f.graph.nodes[1].planSha256=sha('d')},f=>{f.graph.nodes[0].sha256=sha('d')},f=>{f.graph.nodes[1].integrity='damaged'},f=>{f.graph.nodes[0].freshness='stale'},f=>{f.attempts[0].effect='unknown'}]){
    const facts=completion(plan);mutate(facts);assert.equal(evaluateResearchCompletion(plan,facts).complete,false);
  }
});
test('human review requires an accepted review bound to the exact plan and step',()=>{
  const spec=study();spec.proofObligations=[{id:'review',stepId:'stats',kind:'human-review',description:'Review applicability.',required:true}];const {plan}=compile(spec),facts=completion(plan);
  facts.graph.nodes.push(node('review-1','review',{stepId:'stats',planSha256:plan.planSha256,reviewDecision:'rejected'}));facts.obligationResults.find(item=>item.id==='review').evidenceIds=['review-1'];
  assert.equal(evaluateResearchCompletion(plan,facts).complete,false);facts.graph.nodes.at(-1).reviewDecision='accepted-in-scope';assert.equal(evaluateResearchCompletion(plan,facts).complete,true);
});
test('invalidation follows computational and claim dependence without changing historical integrity',()=>{
  const graph={schemaVersion:'proto.evidence-graph.v1',nodes:[node('data','dataset'),node('run','run'),node('result','artifact'),node('figure','artifact'),node('claim','claim'),node('other','artifact')],edges:[{from:'data',to:'run',type:'consumes'},{from:'run',to:'result',type:'produces'},{from:'result',to:'figure',type:'derived_from'},{from:'figure',to:'claim',type:'supports'}]};
  assert.equal(validateEvidenceGraph(graph).ok,true);const output=invalidateEvidenceGraph(graph,['data']);assert.deepEqual(output.affectedIds,['claim','data','figure','result','run']);
  assert.ok(graph.nodes.every(node=>node.freshness==='current'));assert.ok(output.graph.nodes.every(node=>node.integrity==='verified'));assert.equal(output.graph.nodes.find(node=>node.id==='other').freshness,'current');
});
test('only computational provenance must be acyclic; unknown links and invalid edge kinds reject',()=>{
  const graph={schemaVersion:'proto.evidence-graph.v1',nodes:[node('a','claim'),node('b','claim')],edges:[{from:'a',to:'b',type:'supports'},{from:'b',to:'a',type:'contradicts'}]};assert.equal(validateEvidenceGraph(graph).ok,true);
  graph.nodes=graph.nodes.map(node=>({...node,kind:'artifact'}));graph.edges=graph.edges.map(edge=>({...edge,type:'derived_from'}));assert.ok(validateEvidenceGraph(graph).diagnostics.some(item=>item.code==='EVIDENCE_COMPUTATION_CYCLE'));
  graph.edges=[{from:'a',to:'unknown',type:'produces'}];assert.equal(validateEvidenceGraph(graph).ok,false);
});
test('scientific diff labels independent changes and refuses single-factor attribution',()=>{
  const left=study(),right=study();right.datasets[0].units=['mmol/L'];right.datasets[0].entityIds.push('sample:S2');right.steps[0].arguments.seed=42;right.steps[0].methodIdentity.runtimeSha256=sha('d');
  const result=scientificDiff(left,right,{left:{claim:'Before'},right:{claim:'After'}});assert.deepEqual(new Set(result.changes.map(item=>item.category)),new Set(['sample-inclusion','units','seed','runtime','claims']));assert.equal(result.attribution,'descriptive-only');assert.ok(result.warnings.some(item=>item.includes('Multiple categories')));
});
test('canonical identity rejects executable or lossy non-JSON values',()=>{
  for(const value of [Infinity,undefined,NaN,Number.MAX_SAFE_INTEGER+1,new Date()])assert.throws(()=>canonicalResearchJson(value));
  const getter={};Object.defineProperty(getter,'value',{enumerable:true,get(){throw new Error('must not execute')}});assert.throws(()=>canonicalResearchJson(getter),/accessors/);
  assert.equal(researchHash({a:1,b:2}),researchHash({b:2,a:1}));
});
test('generated unit metadata matches the existing Python scientific contract authority',()=>{
  execFileSync('python',[fileURLToPath(new URL('../scripts/generate-scientific-units.py',import.meta.url)),'--check'],{stdio:'pipe'});
});
test('method contract is derived from a real canonical Python catalog entry without raising its maturity',()=>{
  const root=fileURLToPath(new URL('../../../',import.meta.url));
  const actual=JSON.parse(execFileSync('python',['-c','import json; from proto_agent.compute import compute_catalog; print(json.dumps(compute_catalog("descriptive_statistics")))'],{cwd:root,env:{...process.env,PYTHONPATH:fileURLToPath(new URL('../../../src',import.meta.url))},encoding:'utf8'}));
  const tool=actual.tools[0],contract=deriveMethodContract(tool);
  assert.deepEqual(contract.inputSchema,tool.input_schema);assert.equal(contract.maturity,tool.maturity.method_stage);
  assert.deepEqual(contract.quantityProfile,tool.quantity_profile);assert.equal(contract.scientificValidation,'not-established');
});
test('a method file input must bind the actual declared source; dynamic filenames cannot borrow unrelated evidence',()=>{
  const actual=structuredClone(catalog);actual.tools[0].file_inputs={path:{extensions:['.json'],max_bytes:1024,required:true}};
  actual.tools[0].input_schema={type:'object',required:['path'],properties:{path:{type:'string'}}};
  const spec=study();spec.steps[0].methodIdentity.contractSha256=deriveMethodContract(actual.tools[0]).contractSha256;spec.steps[0].arguments={path:'unrelated.json'};
  let output=compileResearchPlan(spec,actual,host);assert.equal(output.ok,false);assert.ok(output.diagnostics.some(item=>item.code==='FILE_DATASET_BINDING_MISSING'));
  spec.steps[0].arguments.path=spec.datasets[0].sourcePath;output=compileResearchPlan(spec,actual,host);assert.equal(output.ok,true);
});
