import test from "node:test";
import assert from "node:assert/strict";
import {mkdir,mkdtemp,readFile,rm} from "node:fs/promises";
import {resolve,join,relative,isAbsolute} from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";
import {randomBytes} from "node:crypto";
import {AgentService} from "../src/main/services/agent-service.ts";
import {AppDatabase} from "../src/main/services/database.ts";
import {WorkspaceFiles} from "../src/main/services/workspace-files.ts";
import {McpClient} from "../src/main/services/mcp-client.ts";
import {buildMissionPreflight} from "../src/main/services/mission-preflight.ts";
import {defaultModuleSettings} from "../src/shared/modules.ts";

test("real Python capabilities and effective AgentService registry permit the actual Act write path",async()=>{
  const repo=fileURLToPath(new URL("../../../",import.meta.url)),owned=resolve("build/test-native-preflight");await mkdir(owned,{recursive:true});const root=await mkdtemp(join(owned,"case-"));
  const db=new AppDatabase(join(root,"execution.sqlite")),files=new WorkspaceFiles(root,db);
  const mcp=new McpClient({packaged:false,resourcesPath:"",repoRoot:repo,workspacePath:root,workspaceCapability:randomBytes(32).toString("hex"),materialsRoot:join(root,"isolated-materials"),pythonExecutable:process.env.PROTO_AGENT_PYTHON||join(repo,process.platform==="win32"?".venv/Scripts/python.exe":".venv/bin/python")});
  const model={id:"fixture",name:"Mock model for preflight integration",fingerprint:"f".repeat(64),loadState:"active",toolCapability:"agent-ready",vision:false,workbenchInstance:{id:"fixture-instance",ownedByWorkbench:true,contextLength:32768}};
  const turns=[["harness_plan",{deliverables:[{path:"build/result.md",kind:"document"}]}],["workspace_propose_patch",{path:"build/result.md",content:"# Verified fixture output\n",rationale:"Fulfill the authorized fixture mission"}],["harness_finish",{summary:"Saved and verified the requested fixture document."}]];
  const payloads=[],models={get:()=>model,getActiveModel:()=>model,getExecutionBinding:async()=>({modelId:model.id,instanceId:"fixture-instance",contextLength:32768}),countExecutionTokens:async()=>({tokens:1000,method:"exact"}),chat:async(_id,payload,chunk)=>{payloads.push(payload);const turn=turns.shift();if(!turn)throw new Error("Unexpected extra model generation");chunk({usage:{completion_tokens:10},choices:[{finish_reason:"tool_calls",delta:{tool_calls:[{index:0,function:{name:turn[0],arguments:JSON.stringify(turn[1])}}]}}]});}};
  let settings=defaultModuleSettings(),terminal;const complete=new Promise(done=>{terminal=done;});
  const agent=new AgentService(db,models,files,mcp,event=>{if(["message-complete","error"].includes(event.type))terminal(event);},()=>settings,root);
  try {
    const thread=agent.createThread({workspacePath:root,title:"Native preflight fixture",mode:"act",modelId:model.id});
    const [capabilities,mcpTools]=await Promise.all([mcp.capabilities(),mcp.tools()]);
    assert.ok(!mcpTools.some(tool=>tool.name==="workspace_propose_patch"));
    const tools=agent.executionTools(thread.id,mcpTools),patch=tools.find(tool=>tool.name==="workspace_propose_patch");
    assert.deepEqual(patch.inputSchema.required,["path","content","rationale"]);assert.match(patch.description,/atomically apply/);
    assert.ok(tools.some(tool=>tool.name==="proto_structure_fetch"));
    const input={thread,content:"Create build/result.md with the verified fixture output.",attachments:[],model,runtime:{available:true,backend:"fixture",detail:"No live inference in this integration test"},moduleIntegrity:{ok:true,enforced:true,modules:[]},visionModuleEnabled:false,workspaceUri:pathToFileURL(root).href,capabilities,toolNames:tools.map(tool=>tool.name)};
    assert.equal(buildMissionPreflight({...input,toolNames:mcpTools.map(tool=>tool.name)}).launchable,false);
    const preflight=buildMissionPreflight(input);assert.equal(preflight.launchable,true,JSON.stringify(preflight.requirements));
    assert.equal(preflight.intent.execution,false);assert.equal(preflight.intent.network,false);assert.equal(preflight.requirements.find(item=>item.id==="writes").state,"approval-required");
    settings={profile:"core-only",enabledOptional:[]};assert.ok(!agent.executionTools(thread.id,mcpTools).some(tool=>tool.name==="proto_pubmed_search"));settings=defaultModuleSettings();
    agent.updateThread(thread.id,{mode:"plan"});assert.ok(!agent.executionTools(thread.id,mcpTools).some(tool=>tool.name==="workspace_propose_patch"));agent.updateThread(thread.id,{mode:"act"});
    await agent.send(thread.id,input.content,[],preflight);let timer;
    const result=await Promise.race([complete,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error("Actual fixture mission timed out")),10000);})]).finally(()=>clearTimeout(timer));
    assert.notEqual(result.type,"error",result.error);assert.equal(await readFile(join(root,"build/result.md"),"utf8"),"# Verified fixture output\n");
    const executionPatch=payloads.flatMap(payload=>payload.tools).find(tool=>tool.function.name==="workspace_propose_patch");
    assert.deepEqual(executionPatch.function.parameters,patch.inputSchema);assert.equal(executionPatch.function.description,patch.description);
  } finally {
    await agent.cancelAll();await mcp.stop();db.close();const child=relative(owned,root);assert.ok(child&&!child.startsWith("..")&&!isAbsolute(child));await rm(root,{recursive:true,force:true});
  }
});
