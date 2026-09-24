/** Actual Chat bridge -> canonical registry -> owned MCP -> WSL acceptance.
 * Run explicitly on a configured host. Missing/broken engines fail, never skip.
 */
import assert from "node:assert/strict";
import {createHash, randomBytes, randomUUID} from "node:crypto";
import {access, mkdir, readFile, readdir, writeFile} from "node:fs/promises";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {AppDatabase} from "../src/main/services/database.ts";
import {McpClient} from "../src/main/services/mcp-client.ts";
import {ResearchToolBridge} from "../src/main/services/research-tools.ts";
import {WorkspaceFiles} from "../src/main/services/workspace-files.ts";
import {harnessToolEffect} from "../src/main/services/harness-workspace.ts";
import {classifyTool, isToolExposedToModel} from "../src/main/services/permissions.ts";
import {OPTIONAL_MODULES} from "../src/shared/modules.ts";

const app = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(app, "../..");
const reportRoot = join(repo, "build/bioinformatics-chat-qa");
const workspace = join(reportRoot, `run-${Date.now()}`);
await mkdir(workspace, {recursive:true});
const database = new AppDatabase(join(workspace,"acceptance.sqlite"));
const files = new WorkspaceFiles(workspace,database);
const client = new McpClient({packaged:false,resourcesPath:"",repoRoot:repo,workspacePath:workspace,
  workspaceCapability:randomBytes(32).toString("hex"),pythonExecutable:join(repo,process.platform==="win32"?".venv/Scripts/python.exe":".venv/bin/python")});
let forkCount=0;
const fork=client.fork.bind(client);
client.fork=()=>{forkCount++;return fork();};
const enabled={profile:"custom",enabledOptional:["analysis.biomni"],enabledSkills:[]};
const disabled={profile:"custom",enabledOptional:[],enabledSkills:[]};
const bridge=new ResearchToolBridge(client,files,()=>enabled);
const session={id:randomUUID(),title:"WSL bridge acceptance",createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),messages:[],documents:[],status:"idle",plan:[],workflow:"analysis",moduleSettings:enabled};
const signal=new AbortController().signal;
const results=[];
const digest=bytes=>createHash("sha256").update(bytes).digest("hex");
async function check(name,action) {
  const started=Date.now();
  try {const evidence=await action();results.push({name,passed:true,milliseconds:Date.now()-started,...evidence});console.log(`${name}: PASS`);}
  catch(error){results.push({name,passed:false,milliseconds:Date.now()-started,error:error.stack??String(error)});throw error;}
}

let failed;
try {
  await check("canonical discovery, permission and write classification",async()=>{
    const available=await bridge.execute("science_catalog",{query:"bioinformatics"},session,signal);
    const names=available.tools.filter(tool=>tool.id.startsWith("bioinformatics.")).map(tool=>tool.id).sort();
    assert.deepEqual(names,["bioinformatics.catalog","bioinformatics.run"]);
    assert.equal(new Set(available.tools.map(tool=>tool.id)).size,available.tools.length);
    assert.equal(classifyTool("proto_bioinformatics_catalog").allowed,true);
    assert.equal(classifyTool("proto_bioinformatics_run").risk,"code-execution");
    assert.equal(isToolExposedToModel("proto_bioinformatics_run"),true);
    assert.equal(harnessToolEffect("proto_bioinformatics_run"),"write");
    const declared=OPTIONAL_MODULES.find(module=>module.id==="analysis.biomni");
    const packaged=JSON.parse(await readFile(join(app,"runtime/modules/analysis.biomni.json"),"utf8"));
    assert.deepEqual([...packaged.tools].sort(),[...declared.tools].sort());
    assert.equal(packaged.version,declared.version);
    return {capabilities:names};
  });
  await check("live WSL availability and exact typed schema",async()=>{
    const catalog=await bridge.execute("science_run",{name:"bioinformatics.catalog",arguments:{operation:"nucmer_align",probe:true}},session,signal);
    await writeFile(join(workspace,"live-catalog.json"),JSON.stringify(catalog,null,2));
    assert.equal(catalog.ok,true,JSON.stringify(catalog));
    assert.equal(catalog.count,1);
    const operation=catalog.operations[0];
    assert.equal(operation.id,"nucmer_align");
    assert.equal(operation.available,true,JSON.stringify(operation.runtime));
    assert.equal(operation.runtime.checked,true);
    assert.equal(operation.runtime.package.name,"mummer4");
    assert.match(operation.runtime.version,/\d+\.\d+/);
    assert.deepEqual(operation.input_schema.required,["reference","query"]);
    return {package:operation.runtime.package,executableVersion:operation.runtime.version};
  });
  let state=418;
  const sequence=Array.from({length:3000},()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return "ACGT"[state>>>30];}).join("");
  await writeFile(join(workspace,"reference.fa"),`>reference\n${sequence}\n`);
  await writeFile(join(workspace,"query.fa"),`>query\n${sequence.slice(200,2200)}\n`);
  const request=JSON.stringify({operation:"nucmer_align",arguments:{reference:"reference.fa",query:"query.fa"}},null,2);
  await writeFile(join(workspace,"request.json"),request);
  await check("actual nucmer execution through canonical Chat tool with verified artifacts",async()=>{
    const result=await bridge.execute("science_run",{name:"bioinformatics.run",arguments:{path:"request.json"}},session,signal);
    assert.equal(result.ok,true,JSON.stringify(result));
    assert.equal(result.status,"completed");
    assert.equal(result.operation,"nucmer_align");
    assert.equal(result.source.sha256,digest(request));
    assert.match(result.manifest_path,/^build\/bioinformatics\/[a-f0-9]{32}\/manifest\.json$/);
    assert.ok(result.artifacts.length>=4);
    for(const artifact of result.artifacts) {
      assert.match(artifact.path,/^build\/bioinformatics\/[a-f0-9]{32}\/outputs\//);
      const bytes=await readFile(join(workspace,artifact.path));
      assert.equal(digest(bytes),artifact.sha256);
      assert.equal(bytes.byteLength,artifact.bytes);
    }
    const coords=result.artifacts.find(artifact=>artifact.path.endsWith("alignment-coordinates.txt"));
    const text=await readFile(join(workspace,coords.path),"utf8");
    assert.match(text,/100\.00/);
    assert.match(text,/2000/);
    assert.ok(result.steps.every(step=>step.exit_code===0));
    assert.equal(await readFile(join(workspace,"reference.fa"),"utf8"),`>reference\n${sequence}\n`);
    assert.equal(await readFile(join(workspace,"query.fa"),"utf8"),`>query\n${sequence.slice(200,2200)}\n`);
    await writeFile(join(workspace,"live-receipt.json"),JSON.stringify(result,null,2));
    return {manifestPath:result.manifest_path,artifactCount:result.artifacts.length,expectedAlignmentBases:2000};
  });
  await check("disabled scientific module hides and rejects canonical, backend and alias calls",async()=>{
    const off={...session,moduleSettings:disabled};
    const before=forkCount;
    const beforeRuns=await readdir(join(workspace,"build/bioinformatics"));
    const catalog=await bridge.execute("science_catalog",{query:"bioinformatics"},off,signal);
    assert.equal(catalog.tools.some(tool=>tool.id.startsWith("bioinformatics.")),false);
    for(const name of ["bioinformatics.run","proto_bioinformatics_run","wsl.bioinformatics","genomics.run"])
      await assert.rejects(bridge.execute("science_run",{name,arguments:{path:"request.json"}},off,signal),/disabled in module settings/);
    await assert.rejects(bridge.execute("science_run",{name:"bioinformatics.catalog",arguments:{probe:true}},off,signal),/disabled in module settings/);
    assert.equal(forkCount,before,"disabled calls never create an execution worker");
    assert.deepEqual(await readdir(join(workspace,"build/bioinformatics")),beforeRuns,"disabled calls never create run artifacts");
    return {rejectedCalls:5};
  });
  await check("Chat cancellation lets the WSL worker publish a cancelled receipt before shutdown",async()=>{
    const counts=["gene,s0,s1,s2,s3,s4,s5"];
    for(let gene=0;gene<1000;gene++) counts.push(`gene${gene},${Array.from({length:6},(_,sample)=>20+((gene*13+sample*17+gene*sample*7)%100)).join(",")}`);
    await writeFile(join(workspace,"counts.csv"),counts.join("\n")+"\n");
    await writeFile(join(workspace,"samples.csv"),"sample,condition\ns0,control\ns1,control\ns2,control\ns3,treated\ns4,treated\ns5,treated\n");
    await writeFile(join(workspace,"cancel-request.json"),JSON.stringify({operation:"deseq2_fit",arguments:{counts:"counts.csv",samples:"samples.csv",reference_level:"control",comparison_level:"treated"}}));
    const prior=new Set(await readdir(join(workspace,"build/bioinformatics")));
    const controller=new AbortController();
    const execution=bridge.execute("science_run",{name:"bioinformatics.run",arguments:{path:"cancel-request.json"}},session,controller.signal)
      .then(value=>({value}),error=>({error}));
    let directory;
    for(let i=0;i<400;i++) {
      const fresh=(await readdir(join(workspace,"build/bioinformatics"))).find(name=>!prior.has(name));
      if(fresh) {
        const candidate=join(workspace,"build/bioinformatics",fresh);
        if(await access(join(candidate,"worker.log")).then(()=>true,()=>false)){directory=candidate;break;}
      }
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    controller.abort(new Error("Controlled Chat cancellation acceptance"));
    const settled=await execution;
    assert.ok(directory,"The actual WSL invocation must start before this cancellation check");
    assert.ok(settled.error || settled.value?.ok===false,"Cancelled Chat calls cannot report success");
    let manifest;
    for(let i=0;i<150;i++) {
      try {manifest=JSON.parse(await readFile(join(directory,"manifest.json"),"utf8"));break;}catch{await new Promise(resolve=>setTimeout(resolve,100));}
    }
    assert.ok(manifest,"Chat shutdown must allow the Python adapter to save its cancellation manifest");
    assert.equal(manifest.ok,false);
    assert.equal(manifest.status,"cancelled");
    return {manifestPath:join(directory,"manifest.json"),status:manifest.status};
  });
} catch(error) {failed=error;}
finally {
  try {await client.stop();} catch(error) {failed??=error;results.push({name:"owned MCP cleanup",passed:false,error:String(error)});}
  database.close();
  const report={passed:!failed,checks:results.length,workspace,scope:"Actual ResearchToolBridge, canonical registry, owned MCP and installed WSL execution; synthetic software fixture",results};
  await writeFile(join(workspace,"report.json"),JSON.stringify(report,null,2));
  await writeFile(join(reportRoot,"latest.json"),JSON.stringify(report,null,2));
  console.log(JSON.stringify({passed:report.passed,checks:report.checks,report:join(workspace,"report.json")}));
}
if(failed) throw failed;
