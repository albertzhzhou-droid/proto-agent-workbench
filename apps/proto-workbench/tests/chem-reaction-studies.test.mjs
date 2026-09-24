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
const ids=['simulate_reversible_chain','simulate_catalytic_cycle','simulate_cstr','simulate_pfr','simulate_semibatch','analyze_reaction_sensitivity','analyze_reaction_flux','propagate_reaction_uncertainty'];

test('eight reaction studies execute through canonical Chat dispatch and reopen complete results',{timeout:180000},async t=>{
  const root=join(repo,'build/chem-reaction-qa');await mkdir(root,{recursive:true});
  const workspace=await mkdtemp(join(root,'integration-'));
  const service=new ChemScienceService({repoRoot:repo,workspacePath:workspace});t.after(()=>service.close());
  const catalog=await service.request({action:'catalog'});assert.equal(catalog.ok,true,JSON.stringify(catalog.error));
  const bridge=new ResearchToolBridge({tools:async()=>[],capabilities:async()=>({execution:{available:false}})},{canonicalRootPath:async()=>workspace},undefined,service);
  const ajv=new Ajv({strict:false}),signal=new AbortController().signal,session={id:randomUUID(),moduleSettings:{profile:"custom",enabledOptional:["analysis.chemistry"]}},receipts=[];
  for(const id of ids){
    const operator=catalog.data.operators.find(item=>item.id===id);assert.ok(operator);assert.equal(operator.category,'kinetics');assert.equal(operator.workspace,'analysis');
    assert.ok(reactionStudyFamily(operator));
    const validate=ajv.compile(operator.input_schema);assert.equal(validate(operator.example_input),true,JSON.stringify(validate.errors));
    assert.equal(validate({...operator.example_input,unexpected:1}),false);
    const tools=await bridge.execute('science_catalog',{query:id},session,signal);
    assert.equal(tools.tools.filter(tool=>tool.id==='chemistry.'+id).length,1);
    assert.equal(researchSignature('science_run',{name:'chem.'+id,arguments:operator.example_input}),researchSignature('science_run',{name:'chemistry.'+id,arguments:operator.example_input}));
    const run=await bridge.execute('science_run',{name:'chem.'+id,arguments:operator.example_input},session,signal);assert.equal(run.ok,true,JSON.stringify(run.error));
    const read=await service.request({action:'read',runId:run.data.runId});assert.equal(read.ok,true);
    assert.equal(isReactionStudy(read.data.result),true);assert.deepEqual(read.data.input,operator.example_input);
    assert.equal(read.data.result.rows.length,operator.example_input.points);
    assert.equal(read.data.provenance.source_files_sha256['chem_reactions.py'],createHash('sha256').update(await readFile(join(repo,'apps/proto-workbench/runtime/chem-integration/chem_reactions.py'))).digest('hex'));
    if(id==='propagate_reaction_uncertainty')assert.equal(read.data.result.rate_samples.length,operator.example_input.samples);
    if(id==='simulate_pfr')assert.equal(read.data.result.axis_label,'Residence time');
    receipts.push({id,runId:read.data.runId,family:reactionStudyFamily(operator),artifacts:read.data.artifacts,readback:true});
  }
  assert.equal((await service.request({action:'history',limit:100})).data.runs.length,8);
  await writeFile(join(root,'integration-acceptance.json'),JSON.stringify({passed:true,receipts},null,2)+'\n');
});

test('study display rejects incomplete or unordered chart axes',()=>{
  const example={kind:'reaction-study',axis_label:'Time',time_s:[0,1],network:{species:[],reactions:[]},charts:[{series:[{values:[1,2]}]}]};
  assert.equal(isReactionStudy(example),true);
  assert.equal(isReactionStudy({...example,axis_label:'Distance'}),false);
  assert.equal(isReactionStudy({...example,time_s:[1,0]}),false);
  assert.equal(isReactionStudy({...example,time_s:[0,Infinity]}),false);
  assert.equal(isReactionStudy({...example,charts:[{series:[{values:[1]}]}]}),false);
});

test('copying the network editor preserves drafts and maps residence time, feeds and analysis IDs',()=>{
  const network={species:[{id:'X',initial_concentration:2},{id:'Y',initial_concentration:0}],reactions:[{id:'xy',reactants:{X:1},products:{Y:1},rate_constant:.2}]};
  const source={example:'consecutive',reaction_ids:['stale'],target_species:'stale',feed_mol_l:{stale:3},duration_s:8};
  const copy=structuredClone(source),settings={duration_s:42,points:901,temperature_k:300};
  const result=reactionStudyInputFromNetwork('simulate_pfr',network,source,settings);
  assert.equal(result.example,undefined);assert.equal(result.duration_s,undefined);assert.equal(result.residence_time_s,42);
  assert.equal(result.points,501);assert.equal(result.temperature_k,300);assert.equal(result.target_species,'X');
  assert.deepEqual(result.reaction_ids,['xy']);assert.deepEqual(result.feed_mol_l,{X:2,Y:0});
  assert.deepEqual(source,copy);result.network.species[0].initial_concentration=9;assert.equal(network.species[0].initial_concentration,2);
  assert.equal(reactionStudyInputFromNetwork('analyze_reaction_flux',network,{},settings).duration_s,42);
});
