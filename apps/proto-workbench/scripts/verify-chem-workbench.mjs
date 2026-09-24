import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ChemWorkbenchService } from "../src/main/services/chem-workbench.ts";

const repoRoot=resolve("../.."), service=new ChemWorkbenchService({repoRoot,workspacePath:repoRoot,uiRoot:resolve("src/chem-ui")});
const report={version:"chem-workbench-integration-acceptance/v1",startedAt:new Date().toISOString(),checks:[]};
function check(name,value){assert.ok(value,name);report.checks.push({name,passed:true});}
try{
  const status=await service.start("http://127.0.0.1:5187");report.status=status;check("Real Chem backend launched",status.available);
  const origin=new URL(status.url).origin;
  const get=path=>fetch(status.url+path);
  const post=(path,data,headers={})=>fetch(status.url+path,{method:"POST",headers:{"Content-Type":"application/json",Origin:origin,...headers},body:JSON.stringify(data)});
  const html=await get("");const body=await html.text();
  check("Original 3D and refinement scripts retained",body.includes("viewer.js")&&body.includes("refinement-lab.js")&&body.includes("interface-workbench.js"));
  check("Theme and font overlays injected",body.includes("paper-chem.css")&&body.includes("paper-chem.js")&&body.includes("fonts.css"));
  check("Embedding limited to Workbench origin",html.headers.get("content-security-policy").includes("frame-ancestors http://127.0.0.1:5187"));
  check("No token root access",(await fetch(origin+"/api/workspace")).status===404);
  check("Wrong origin rejected",(await post("api/compile",{source:"chem 0.1"},{Origin:"http://malicious.invalid"})).status===403);
  check("Arbitrary upstream route rejected",(await get("api/arbitrary")).status===404);
  const workspace=await(await get("api/workspace")).json();check("All 8 existing source examples retained",workspace.examples.length===8);
  const sources=[];
  for(const example of workspace.examples){const response=await post("api/compile",{source:example.source,attachments:example.attachments});const result=await response.json();sources.push({path:example.path,http:response.status,success:result.success,diagnostics:result.diagnostics?.map(row=>row.code)});}
  report.compilation=sources;check("Existing sources reach original compiler",sources.every(row=>row.http===200)&&sources.some(row=>row.success));
  const invalid=await(await post("api/compile",{source:"not a chem document"})).json();check("Invalid source preserves structured diagnostics",invalid.success===false&&invalid.diagnostics.length>0);
  const catalog=await(await get("api/design/catalog")).json();check("All five design workflows retained",catalog.workflows.length===5);report.workflows=catalog.workflows;
  const history=await(await get("api/design/history")).json();check("Existing studies migrated without errors",history.records.length>=9&&history.errors.length===0);
  const projects=await(await get("api/projects")).json();check("Existing project revision migrated",projects.length>=1);
  const request={prompt:"",study:catalog.study,mode:"direct",decision:catalog.direct_decision};
  const designResponse=await post("api/design/run",request);const design=await designResponse.json();report.design={http:designResponse.status,state:design.state,recordHash:design.record_hash,organic:design.organic?.candidates?.length,inorganic:design.inorganic?.candidates?.length,interfaces:design.interfaces?.map(item=>({profile:item.profile,success:item.success}))};
  check("Actual combined design workflow succeeds",designResponse.ok&&design.state==="completed");
  check("Organic and inorganic candidates and three interfaces present",design.organic?.candidates?.length>0&&design.inorganic?.candidates?.length>0&&design.interfaces?.length===3);
  const exported=await(await post("api/design/export",{reference:design.record_hash})).json();
  const exportedText=await readFile(exported.path,"utf8");
  const reopened=await(await post("api/design/import",{document:exportedText})).json();check("Study export reopens with exact identity",reopened.record_hash===design.record_hash);
  const xdlStatus=await(await get("api/xdl/status")).json();report.xdlStatus=xdlStatus;check("Standalone XDL runtime really imports",xdlStatus.ok===true);
  const xdl=await(await post("api/xdl/inspect",{format:"xml",source:'<Synthesis><Hardware/><Reagents/><Procedure><Wait time="1 s"/></Procedure></Synthesis>'})).json();
  check("XDL parses and round-trips without compiling or executing",xdl.ok===true&&xdl.compiled===false&&xdl.executed===false&&xdl.roundtrip.xml.ok&&xdl.roundtrip.json.ok);
}catch(error){report.error=String(error);process.exitCode=1;}
finally{await service.close();report.completedAt=new Date().toISOString();await mkdir(resolve(repoRoot,"build/chem-integration-qa"),{recursive:true});await writeFile(resolve(repoRoot,"build/chem-integration-qa/acceptance.json"),JSON.stringify(report,null,2)+"\n");console.log(JSON.stringify(report,null,2));}
