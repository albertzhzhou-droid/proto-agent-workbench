import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import Ajv from 'ajv';
import {ChemScienceService} from '../src/main/services/chem-science.ts';
import {ResearchToolBridge,researchSignature} from '../src/main/services/research-tools.ts';
import {isReactionStudy,reactionStudyFamily,reactionStudyInputFromNetwork} from '../src/renderer/chem-reaction-studies.ts';
const repo=fileURLToPath(new URL('../../../',import.meta.url));
const families={simulate_nonisothermal_batch:'reactors',simulate_nonisothermal_cstr:'reactors',simulate_tanks_in_series:'reactors',
  simulate_catalyst_deactivation:'mechanisms',simulate_gas_liquid_reaction:'interfaces',simulate_catalyst_pellet:'interfaces'};

test('six coupled operators execute through shared Chat dispatch, save source hashes and reopen',{timeout:180000},async t=>{
  const root=join(repo,'build/chem-coupled-reaction-qa');await mkdir(root,{recursive:true});
  const workspace=await mkdtemp(join(root,'integration-'));
  const service=new ChemScienceService({repoRoot:repo,workspacePath:workspace});t.after(()=>service.close());
  const catalog=await service.request({action:'catalog'});assert.equal(catalog.ok,true,JSON.stringify(catalog.error));
  const bridge=new ResearchToolBridge({tools:async()=>[],capabilities:async()=>({execution:{available:false}})},{canonicalRootPath:async()=>workspace},undefined,service);
  const ajv=new Ajv({strict:false}),signal=new AbortController().signal,session={id:randomUUID(),moduleSettings:{profile:"custom",enabledOptional:["analysis.chemistry"]}},receipts=[];
  for(const [id,family] of Object.entries(families)){
    const operator=catalog.data.operators.find(item=>item.id===id);assert.ok(operator);assert.equal(operator.workspace,'analysis');
    assert.equal(reactionStudyFamily(operator),family);
    const validate=ajv.compile(operator.input_schema);assert.equal(validate(operator.example_input),true,JSON.stringify(validate.errors));
    assert.equal(validate({...operator.example_input,unexpected:1}),false);
    const tools=await bridge.execute('science_catalog',{query:id},session,signal);
    assert.equal(tools.tools.filter(tool=>tool.id==='chemistry.'+id).length,1);
    assert.equal(researchSignature('science_run',{name:'chem.'+id,arguments:operator.example_input}),researchSignature('science_run',{name:'chemistry.'+id,arguments:operator.example_input}));
    const run=await bridge.execute('science_run',{name:'chem.'+id,arguments:operator.example_input},session,signal);
    assert.equal(run.ok,true,JSON.stringify(run.error));
    const read=await service.request({action:'read',runId:run.data.runId});assert.equal(read.ok,true);
    assert.equal(isReactionStudy(read.data.result),true);assert.deepEqual(read.data.input,operator.example_input);
    assert.equal(read.data.result.rows.length,operator.example_input.points);
    assert.equal(read.data.provenance.source_files_sha256['chem_coupled_reactions.py'],createHash('sha256').update(await readFile(join(repo,'apps/proto-workbench/runtime/chem-integration/chem_coupled_reactions.py'))).digest('hex'));
    receipts.push({id,runId:read.data.runId,family,artifacts:read.data.artifacts,readback:true});
  }
  const thermal=catalog.data.operators.find(item=>item.id==='simulate_nonisothermal_batch');
  const invalid={...thermal.example_input,reaction_enthalpy_j_mol:{missing:-5000}};
  const failure=await bridge.execute('science_run',{name:'chemistry.simulate_nonisothermal_batch',arguments:invalid},session,signal);
  assert.equal(failure.ok,false);
  const history=await service.request({action:'history',limit:100});assert.equal(history.data.runs.length,7);
  const failedRun=history.data.runs.find(run=>run.status==='error');assert.ok(failedRun);
  const failedRead=await service.request({action:'read',runId:failedRun.runId});assert.equal(failedRead.ok,true);
  assert.deepEqual(failedRead.data.input,invalid);assert.equal(failedRead.data.status,'error');assert.equal(failedRead.data.result,undefined);
  await writeFile(join(root,'integration-acceptance.json'),JSON.stringify({passed:true,receipts,failedRun:failedRun.runId},null,2)+'\n');
});

test('spatial profiles require finite increasing coordinates and one full frame per time sample',()=>{
  const base={kind:'reaction-study',axis_label:'Time',time_s:[0,1],network:{species:[],reactions:[]},charts:[{series:[{values:[1,2]}]}]};
  const profile={title:'Profile',x_label:'Radius',x_unit:'m',y_label:'C',y_unit:'mol/m³',x:[.1,.2],values:[[0,0],[1,2]]};
  assert.equal(isReactionStudy({...base,spatial_profile:profile}),true);
  assert.equal(isReactionStudy({...base,spatial_profile:{...profile,values:[[0,0]]}}),false);
  assert.equal(isReactionStudy({...base,spatial_profile:{...profile,values:[[0],[1,2]]}}),false);
  assert.equal(isReactionStudy({...base,spatial_profile:{...profile,x:[.2,.1]}}),false);
  assert.equal(isReactionStudy({...base,spatial_profile:{...profile,values:[[0,0],[Infinity,2]]}}),false);
  assert.equal(isReactionStudy({...base,spatial_profile:null}),false);
});

test('thermal network handoff never reuses example heats or adds an isothermal temperature',()=>{
  const network={species:[{id:'A',initial_concentration:1},{id:'B',initial_concentration:0}],reactions:[{id:'same_id',reactants:{A:1},products:{B:1},rate_constant:.2}]};
  const source={example:'consecutive',reaction_enthalpy_j_mol:{same_id:-40000,stale:-5000},feed_mol_l:{stale:1}};
  const result=reactionStudyInputFromNetwork('simulate_nonisothermal_cstr',network,source,{duration_s:50,points:151,temperature_k:310});
  assert.equal(result.example,undefined);assert.equal(result.temperature_k,undefined);assert.equal(result.initial_temperature_k,310);
  assert.deepEqual(result.reaction_enthalpy_j_mol,{same_id:null});assert.deepEqual(result.feed_mol_l,{A:1,B:0});
  assert.deepEqual(source.reaction_enthalpy_j_mol,{same_id:-40000,stale:-5000});
});
