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
import {isChemDataVisualization,dataVisualizationCsv} from '../src/renderer/chem-analysis-input.ts';
const repo=fileURLToPath(new URL('../../../',import.meta.url));
const families={simulate_stochastic_network:'mechanisms',simulate_axial_dispersion:'reactors',
  analyze_tracer_rtd:'reaction-analysis',simulate_rtd_segregation:'reactors',analyze_network_structure:'reaction-analysis',scan_cstr_steady_states:'reactors'};

test('network and reactor operators share canonical Chat execution, complete result contracts and immutable readback',{timeout:180000},async t=>{
  const root=join(repo,'build/chem-network-reactor-qa');await mkdir(root,{recursive:true});
  const workspace=await mkdtemp(join(root,'integration-'));
  const service=new ChemScienceService({repoRoot:repo,workspacePath:workspace});t.after(()=>service.close());
  const catalog=await service.request({action:'catalog'});assert.equal(catalog.ok,true,JSON.stringify(catalog.error));
  const bridge=new ResearchToolBridge({tools:async()=>[],capabilities:async()=>({execution:{available:false}})},{canonicalRootPath:async()=>workspace},undefined,service);
  const ajv=new Ajv({strict:false}),signal=new AbortController().signal,session={id:randomUUID(),moduleSettings:{profile:"custom",enabledOptional:["analysis.chemistry"]}},receipts=[];
  assert.equal(catalog.data.operators.length,56);
  assert.equal(catalog.data.operators.filter(operator=>reactionStudyFamily(operator)).length,35);
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
    assert.deepEqual(read.data.input,operator.example_input);
    assert.equal(read.data.provenance.source_files_sha256['chem_network_reactors.py'],createHash('sha256').update(await readFile(join(repo,'apps/proto-workbench/runtime/chem-integration/chem_network_reactors.py'))).digest('hex'));
    if(id.startsWith('simulate_')){
      assert.equal(isReactionStudy(read.data.result),true);
      assert.equal(read.data.result.rows.length,operator.example_input.points);
    }else if(id!=='analyze_network_structure'){
      assert.equal(isChemDataVisualization(read.data.result.visualization),true);
      for(const plot of read.data.result.supplementary_visualizations){
        assert.equal(isChemDataVisualization(plot),true);
        assert.equal(dataVisualizationCsv(plot).split('\r\n').length,1+plot.series.reduce((sum,s)=>sum+s.x.length,0));
      }
    }
    if(id==='simulate_stochastic_network')assert.equal(read.data.result.sampled_trajectories.length,operator.example_input.replicates);
    if(id==='analyze_network_structure')assert.ok(read.data.result.tables.length>=3);
    receipts.push({id,family,runId:read.data.runId,artifacts:read.data.artifacts,readback:true});
  }
  const stochastic=catalog.data.operators.find(item=>item.id==='simulate_stochastic_network');
  const invalid={...stochastic.example_input,max_events:1};
  const failure=await bridge.execute('science_run',{name:'chemistry.simulate_stochastic_network',arguments:invalid},session,signal);
  assert.equal(failure.ok,false);
  const history=await service.request({action:'history',limit:100});assert.equal(history.data.runs.length,7);
  const failed=history.data.runs.find(run=>run.status==='error');assert.ok(failed);
  const read=await service.request({action:'read',runId:failed.runId});assert.deepEqual(read.data.input,invalid);assert.equal(read.data.result,undefined);
  const network={species:[{id:'A',initial_concentration:1},{id:'B',initial_concentration:0}],reactions:[{id:'step',reactants:{A:1},products:{B:1},rate_constant:.2}]};
  for(const id of Object.keys(families).filter(id=>id!=='analyze_tracer_rtd')){
    const op=catalog.data.operators.find(item=>item.id===id);
    const copied=reactionStudyInputFromNetwork(id,network,op.example_input,{duration_s:20,points:91,temperature_k:303});
    const validate=ajv.compile(op.input_schema);assert.equal(validate(copied),true,`${id}: ${JSON.stringify(validate.errors)}`);
    assert.deepEqual(copied.network,network);assert.notEqual(copied.network,network);
    assert.equal(copied.example,undefined);assert.equal(op.example_input.network,undefined);
  }
  await writeFile(join(root,'integration-acceptance.json'),JSON.stringify({passed:true,workspace,receipts,failedRun:failed.runId},null,2)+'\n');
});
