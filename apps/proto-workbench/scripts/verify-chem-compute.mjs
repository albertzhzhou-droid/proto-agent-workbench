import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ChemWorkbenchService } from "../src/main/services/chem-workbench.ts";
const repoRoot=resolve("../.."), service=new ChemWorkbenchService({repoRoot,workspacePath:repoRoot});
const report={version:"chem-compute-port-acceptance/v1",startedAt:new Date().toISOString(),checks:[]};
try {
  const status=await service.start("http://127.0.0.1:5187");assert.ok(status.available,status.error);
  const origin=new URL(status.url).origin;
  async function post(path,data){const res=await fetch(status.url+path,{method:"POST",headers:{"Content-Type":"application/json",Origin:origin},body:JSON.stringify(data)});const value=await res.json();if(!res.ok)throw new Error(JSON.stringify(value));return value;}
  const workspace=await(await fetch(status.url+"api/workspace")).json();
  const profiles=await(await fetch(status.url+"api/profiles")).json();
  for(const profile of ["copper","water"]){
    const example=workspace.examples.find(row=>row.name===(profile==="copper"?"fcc-copper":"water"));
    const data={source:example.source+`\n# Integration acceptance ${report.startedAt}\n`,attachments:example.attachments,profile,object_id:profile==="copper"?"fcc_copper":"water",...(profile==="copper"?{scales:[0.98,1,1.02]}:{geometry:profiles.water_geometry})};
    const prepared=await post("api/workflow/prepare",data);
    const unapproved=await fetch(status.url+"api/workflow/submit",{method:"POST",headers:{"Content-Type":"application/json",Origin:origin},body:JSON.stringify({reference:prepared.reference})});
    assert.equal(unapproved.status,400,"Unapproved workflow must be rejected");
    await post("api/workflow/approve",{reference:prepared.reference,source:data.source,attachments:data.attachments});
    await post("api/workflow/submit",{reference:prepared.reference});
    const started=Date.now();let value;
    do{await new Promise(r=>setTimeout(r,500));value=await post("api/workflow/read",{reference:prepared.reference});}while(["running","queued","approved"].includes(value.state)&&Date.now()-started<180000);
    report.checks.push({profile,state:value.state,reference:value.reference,result:value.result,job:value.job});
    assert.equal(value.state,"succeeded",JSON.stringify(value));
  }
}catch(error){report.error=String(error);process.exitCode=1;}
finally{await service.close();report.completedAt=new Date().toISOString();await mkdir(resolve(repoRoot,"build/chem-integration-qa"),{recursive:true});await writeFile(resolve(repoRoot,"build/chem-integration-qa/compute-acceptance.json"),JSON.stringify(report,null,2)+"\n");console.log(JSON.stringify({...report,checks:report.checks.map(row=>({profile:row.profile,state:row.state,reference:row.reference,jobId:row.job.job_id}))},null,2));}
