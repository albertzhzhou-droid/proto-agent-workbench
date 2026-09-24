import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import Ajv from 'ajv';
import {ChemScienceService} from '../src/main/services/chem-science.ts';
import {ResearchToolBridge,researchSignature} from '../src/main/services/research-tools.ts';
import {isReactionStudy,reactionStudyFamily} from '../src/renderer/chem-reaction-studies.ts';
import {isChemDataVisualization,dataVisualizationCsv} from '../src/renderer/chem-analysis-input.ts';
const repo=fileURLToPath(new URL('../../../',import.meta.url));
const families={simulate_photochemical_isomerization:'mechanisms',simulate_excited_state_quenching:'mechanisms',
  simulate_cyclic_voltammetry:'interfaces',simulate_chronoamperometry:'interfaces',fit_arrhenius_eyring:'reaction-analysis',compare_integrated_rate_laws:'reaction-analysis'};

test('six driven-reaction tools share Chat aliases, schemas, complete charts and immutable readback',{timeout:180000},async t=>{
  const root=join(repo,'build/chem-driven-reaction-qa');await mkdir(root,{recursive:true});
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
    assert.equal(read.data.provenance.source_files_sha256['chem_driven_reactions.py'],createHash('sha256').update(await readFile(join(repo,'apps/proto-workbench/runtime/chem-integration/chem_driven_reactions.py'))).digest('hex'));
    if(id.startsWith('simulate_')){
      assert.equal(isReactionStudy(read.data.result),true);
      assert.equal(read.data.result.rows.length,operator.example_input.points);
    }else{
      assert.equal(isChemDataVisualization(read.data.result.visualization),true);
      assert.equal(isChemDataVisualization(read.data.result.residual_visualization),true);
    }
    if(id==='simulate_cyclic_voltammetry'){
      const plot=read.data.result.phase_plot;
      assert.equal(plot.series[0].x[0],plot.series[0].x.at(-1));
      assert.equal(dataVisualizationCsv(plot).split('\r\n').length,1+2*operator.example_input.points);
    }
    receipts.push({id,family,runId:read.data.runId,artifacts:read.data.artifacts,readback:true});
  }
  const cv=catalog.data.operators.find(item=>item.id==='simulate_cyclic_voltammetry');
  const invalid={...cv.example_input,points:300};
  const failure=await bridge.execute('science_run',{name:'chemistry.simulate_cyclic_voltammetry',arguments:invalid},session,signal);
  assert.equal(failure.ok,false);
  const history=await service.request({action:'history',limit:100});assert.equal(history.data.runs.length,7);
  const failed=history.data.runs.find(run=>run.status==='error');assert.ok(failed);
  const read=await service.request({action:'read',runId:failed.runId});assert.deepEqual(read.data.input,invalid);assert.equal(read.data.result,undefined);
  await writeFile(join(root,'integration-acceptance.json'),JSON.stringify({passed:true,workspace,receipts,failedRun:failed.runId},null,2)+'\n');
});

test('a synchronized phase plot allows a reversed x axis but rejects missing or null samples',()=>{
  const base={kind:'reaction-study',axis_label:'Time',time_s:[0,1,2],network:{species:[],reactions:[]},charts:[{series:[{values:[0,1,2]}]}]};
  const phase={title:'CV',x_label:'Potential',y_label:'Current',series:[{id:'i',x:[1,0,1],y:[0,-1,1]}]};
  assert.equal(isReactionStudy({...base,phase_plot:phase}),true);
  assert.equal(isReactionStudy({...base,phase_plot:{...phase,series:[{id:'i',x:[1,0],y:[0,-1]}]}}),false);
  assert.equal(isReactionStudy({...base,phase_plot:{...phase,series:[{id:'i',x:[1,0,1],y:[0,null,1]}]}}),false);
  assert.equal(isReactionStudy({...base,phase_plot:{...phase,series:[]}}),false);
  assert.equal(isReactionStudy({...base,phase_plot:null}),false);
});
