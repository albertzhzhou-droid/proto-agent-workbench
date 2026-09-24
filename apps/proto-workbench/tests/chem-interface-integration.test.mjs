import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import Ajv from 'ajv';
import {ChemScienceService} from '../src/main/services/chem-science.ts';
import {ResearchToolBridge,researchSignature} from '../src/main/services/research-tools.ts';
import {isInterfaceResult,surfaceSiteOccupants} from '../src/renderer/chem-interface-view.ts';
const repo=fileURLToPath(new URL('../../../',import.meta.url));
const ids=['simulate_competitive_adsorption','simulate_langmuir_hinshelwood','simulate_eley_rideal','simulate_electrode_step','simulate_diffusion_film'];

test('interface operators share schemas, canonical Chat dispatch, complete time series and persisted evidence',{timeout:120000},async t=>{
  const root=join(repo,'build/chem-interface-qa');await mkdir(root,{recursive:true});
  const workspace=await mkdtemp(join(root,'integration-'));
  const service=new ChemScienceService({repoRoot:repo,workspacePath:workspace});t.after(()=>service.close());
  const catalog=await service.request({action:'catalog'});assert.equal(catalog.ok,true,JSON.stringify(catalog.error));
  const bridge=new ResearchToolBridge({tools:async()=>[],capabilities:async()=>({execution:{available:false}})},{canonicalRootPath:async()=>workspace},undefined,service);
  const ajv=new Ajv({strict:false}),signal=new AbortController().signal,session={id:randomUUID(),moduleSettings:{profile:"custom",enabledOptional:["analysis.chemistry"]}},receipts=[];
  for(const id of ids){
    const operator=catalog.data.operators.find(item=>item.id===id);assert.ok(operator);assert.equal(operator.category,'interfaces');assert.equal(operator.workspace,'analysis');
    const validate=ajv.compile(operator.input_schema);assert.equal(validate(operator.example_input),true,JSON.stringify(validate.errors));
    const tools=await bridge.execute('science_catalog',{query:id},session,signal);
    assert.equal(tools.tools.filter(tool=>tool.id==='chemistry.'+id).length,1);
    assert.equal(researchSignature('science_run',{name:'chem.'+id,arguments:operator.example_input}),researchSignature('science_run',{name:'chemistry.'+id,arguments:operator.example_input}));
    const run=await bridge.execute('science_run',{name:'chem.'+id,arguments:operator.example_input},session,signal);assert.equal(run.ok,true,JSON.stringify(run.error));
    const read=await service.request({action:'read',runId:run.data.runId});assert.equal(read.ok,true);
    assert.equal(isInterfaceResult(read.data.result),true);assert.deepEqual(read.data.input,operator.example_input);
    assert.equal(read.data.result.rows.length,operator.example_input.points);
    assert.equal(read.data.provenance.source_files_sha256['chem_interfaces.py'],createHash('sha256').update(await readFile(join(repo,'apps/proto-workbench/runtime/chem-integration/chem_interfaces.py'))).digest('hex'));
    if(read.data.result.surface_scene){for(const index of [0,50,150])assert.equal(surfaceSiteOccupants(read.data.result.surface_scene,index).length,100);}
    receipts.push({id,runId:read.data.runId,artifacts:read.data.artifacts,readback:true});
  }
  assert.equal((await service.request({action:'history',limit:100})).data.runs.length,5);
  await writeFile(join(root,'integration-acceptance.json'),JSON.stringify({passed:true,receipts},null,2)+'\n');
});

test('occupancy display preserves 100 sites, vacancy and rounded coverage without relabeling data',()=>{
  const surface={kind:'surface-coverage',description:'test',species:[{id:'A',coverage:[0,.335,1]},{id:'B',coverage:[0,.335,0]}]};
  const empty=surfaceSiteOccupants(surface,0);assert.equal(empty.filter(value=>value===-1).length,100);
  const mixed=surfaceSiteOccupants(surface,1);assert.equal(mixed.length,100);assert.equal(mixed.filter(value=>value===0).length,34);assert.equal(mixed.filter(value=>value===1).length,33);assert.equal(mixed.filter(value=>value===-1).length,33);
  assert.equal(surfaceSiteOccupants(surface,2).filter(value=>value===0).length,100);
  assert.deepEqual(surface.species[0].coverage,[0,.335,1]);
  assert.equal(isInterfaceResult({kind:'interface-simulation',time_s:[0,1],charts:[{series:[{values:[1]}]}]}),false);
  assert.equal(isInterfaceResult({kind:'interface-simulation',time_s:[0,Infinity],charts:[]}),false);
});
