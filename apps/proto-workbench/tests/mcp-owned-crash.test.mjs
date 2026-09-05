import test from "node:test";
import assert from "node:assert/strict";
import {mkdir,mkdtemp,writeFile,readFile,rm} from "node:fs/promises";
import {join,resolve,relative,isAbsolute} from "node:path";
import {fileURLToPath} from "node:url";
import {randomBytes} from "node:crypto";
import {DatabaseSync} from "node:sqlite";
import {McpClient} from "../src/main/services/mcp-client.ts";
import {HarnessController} from "../src/main/services/harness-controller.ts";
import {HarnessStore} from "../src/main/services/harness-store.ts";

// Actual owned Python subprocesses and production MCP transport/controller;
// model frames and this tiny stdio peer are controlled fault fixtures.
const fixture=`import json, os, sys
from pathlib import Path
for line in sys.stdin:
    request=json.loads(line)
    if "id" not in request: continue
    method=request.get("method")
    if method=="initialize": result={"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"controlled-crash-fixture","version":"1"}}
    elif method=="tools/call":
        if request["params"]["name"]=="controlled_write_then_crash":
            marker=Path(os.environ["PROTO_WORKBENCH_WORKSPACE_ROOT"])/"build"/"crash-marker.txt"
            with marker.open("a",encoding="utf-8",newline="") as handle: handle.write("one controlled effect\\n")
            os._exit(23)
        result={"structuredContent":{"ok":True,"pid":os.getpid()}}
    else: result={"tools":[]}
    print(json.dumps({"jsonrpc":"2.0","id":request["id"],"result":result}),flush=True)
`;

test("unexpected actual owned MCP process exit preserves unknown write and does not terminate a sibling session",async()=>{
  const repo=fileURLToPath(new URL("../../../",import.meta.url));
  const owned=resolve("build/test-mcp-crash");await mkdir(owned,{recursive:true});const root=await mkdtemp(join(owned,"case-"));
  await mkdir(join(root,"src/proto_agent"),{recursive:true});await mkdir(join(root,"build"));
  await writeFile(join(root,"src/proto_agent/__init__.py"),"");await writeFile(join(root,"src/proto_agent/mcp_server.py"),fixture);
  const client=new McpClient({packaged:false,resourcesPath:"",repoRoot:root,workspacePath:root,workspaceCapability:randomBytes(32).toString("hex"),pythonExecutable:process.env.PROTO_AGENT_PYTHON||join(repo,process.platform==="win32"?".venv/Scripts/python.exe":".venv/bin/python")});
  const sibling=client.fork();let db=new DatabaseSync(join(root,"execution.sqlite"));
  try {
    const alive=await sibling.call("ping",{});let generations=0;
    const store=new HarnessStore(db), tool={type:"function",function:{name:"workspace_propose_patch",description:"Controlled test write",parameters:{type:"object",properties:{path:{type:"string"}},required:["path"],additionalProperties:false}}};
    const controller=new HarnessController(store,{tools:[tool],binding:async()=>({modelId:"qwen3.8-27b@q4_k_m",instanceId:"mock",contextLength:32768}),count:async()=>({tokens:1000,method:"exact"}),
      chat:async(_payload,chunk)=>{generations++;chunk({choices:[{finish_reason:"tool_calls",delta:{tool_calls:[{index:0,function:{name:"workspace_propose_patch",arguments:JSON.stringify({path:"build/crash-marker.txt"})}}]}}]});},
      execute:async()=>client.call("controlled_write_then_crash",{}),effect:()=>"write",verify:async()=>({ok:false,diagnostics:["No success receipt"],artifacts:[]}),publish(){},delta(){}});
    const checkpoint=controller.create({schema:"proto-workbench.mission.v1",runId:"crash",threadId:"crash-thread",workspacePath:root,goal:"Controlled fault fixture only",modelId:"qwen3.8-27b@q4_k_m",mode:"act",contextTokens:32768,scope:{writeRoots:["build"],network:false,execution:false},deliverables:[],budgets:{activeTimeMs:10000,maxRounds:4,maxGeneratedTokens:1000}},"Test fixture");
    await controller.run(checkpoint,new AbortController().signal);
    assert.equal(checkpoint.state,"effect-unknown");assert.equal(checkpoint.error.code,"TOOL_SESSION_INTERRUPTED");assert.equal(checkpoint.error.stage,"mcp-process");
    assert.equal((await sibling.call("ping",{})).pid,alive.pid);
    await controller.run(checkpoint,new AbortController().signal);
    assert.equal(checkpoint.state,"effect-unknown");assert.equal(generations,1);
    assert.equal(await readFile(join(root,"build/crash-marker.txt"),"utf8"),"one controlled effect\n");
    db.close();db=new DatabaseSync(join(root,"execution.sqlite"));assert.equal(new HarnessStore(db).get("crash").state,"effect-unknown");
    assert.equal(client.pending.size,0);
  } finally {
    await client.stop();await sibling.stop();db.close();const child=relative(owned,root);assert.ok(child&&!child.startsWith("..")&&!isAbsolute(child));await rm(root,{recursive:true,force:true});
  }
});
