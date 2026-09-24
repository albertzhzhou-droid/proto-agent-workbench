import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ChemScienceService} from '../src/main/services/chem-science.ts';
const repo=fileURLToPath(new URL('../../../',import.meta.url));
const workspace=resolve(repo,'build/chem-science-qa/operator-workspace');
await mkdir(workspace,{recursive:true});
const service=new ChemScienceService({repoRoot:repo,workspacePath:workspace});
const report={version:'chem-science-bridge-acceptance/v1',createdAt:new Date().toISOString(),workspace,operators:[]};
try {
  const catalog=await service.request({action:'catalog'});
  if(!catalog.ok)throw new Error(JSON.stringify(catalog.error));
  for(const operator of catalog.data.operators){
    const result=await service.request({action:'run',operator:operator.id,input:operator.example_input,timeoutMs:120000});
    let readback=false;
    if(result.ok){const read=await service.request({action:'read',runId:result.data.runId});readback=read.ok&&JSON.stringify(read.data.result)===JSON.stringify(result.data.result);}
    report.operators.push({id:operator.id,ok:result.ok,readback,runId:result.data?.runId,status:result.data?.status,error:result.error,artifacts:result.data?.artifacts,hashes:result.data?.hashes,provenance:result.data?.provenance});
    console.log(`${operator.id}: ${result.ok&&readback?'PASS':'FAIL'} ${result.error?.message??''}`);
  }
  report.passed=report.operators.every(item=>item.ok&&item.readback);
} finally {await service.close();await writeFile(join(repo,'build/chem-science-qa/bridge-acceptance.json'),JSON.stringify(report,null,2)+'\n');}
if(!report.passed)process.exitCode=1;
