import test from "node:test";
import assert from "node:assert/strict";
import {randomBytes} from "node:crypto";
import {mkdir,mkdtemp,writeFile} from "node:fs/promises";
import {join,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {ResearchToolBridge} from "../src/main/services/research-tools.ts";
import {McpClient,sandboxEnvironment} from "../src/main/services/mcp-client.ts";
import {normalizeModuleSettings} from "../src/shared/modules.ts";

test("sandbox configuration never inherits unsafe execution or unrelated secrets",()=>{
  assert.deepEqual(sandboxEnvironment({PROTO_AGENT_UNSAFE_HOST:"1",SECRET:"hidden"}),{});
  assert.throws(()=>sandboxEnvironment({PROTO_AGENT_SANDBOX_PROVIDER:"docker",PROTO_AGENT_SANDBOX_IMAGE:"python:latest"}),/digest-pinned/);
  const env={PROTO_AGENT_SANDBOX_PROVIDER:"docker",PROTO_AGENT_SANDBOX_IMAGE:`python@sha256:${"a".repeat(64)}`};
  assert.deepEqual(sandboxEnvironment({...env,SECRET:"hidden"}),env);
});

test("unified bridge runs the real computation backend and respects frozen module selection",{timeout:45000},async t=>{
  const repo=fileURLToPath(new URL("../../../",import.meta.url));
  const root=resolve(repo,"build/chat-qa/bridge");await mkdir(root,{recursive:true});
  const workspace=await mkdtemp(join(root,"run-"));
  const mcp=new McpClient({packaged:false,resourcesPath:"",repoRoot:repo,workspacePath:workspace,workspaceCapability:randomBytes(32).toString("hex"),pythonExecutable:join(repo,process.platform==="win32"?".venv/Scripts/python.exe":".venv/bin/python")});
  t.after(()=>mcp.stop());
  const bridge=new ResearchToolBridge(mcp,{canonicalRootPath:async()=>workspace},()=>normalizeModuleSettings({profile:"core-only"}));
  const session={id:"619f7278-0693-49da-a497-4c7a3fc56b11",moduleSettings:normalizeModuleSettings({profile:"full"})};
  const signal=new AbortController().signal;
  const catalog=await bridge.execute("science_catalog",{query:"compute"},session,signal);
  assert.equal(catalog.tools.filter(tool=>tool.id==="compute.run").length,1);
  const detail=await bridge.execute("science_run",{name:"compute.catalog",arguments:{tool:"compare_two_groups"}},session,signal);
  assert.equal(detail.tools[0].id,"compare_two_groups");
  await writeFile(join(workspace,"input.json"),JSON.stringify({tool:"compare_two_groups",arguments:{group_a:[1,1,1],group_b:[1,2,3],method:"welch_t"}}));
  const result=await bridge.execute("science_run",{name:"biomni.run",arguments:{path:"input.json"}},session,signal);
  assert.equal(result.ok,true);assert.ok(Math.abs(result.result.statistic+Math.sqrt(3))<1e-12);
  const disabled={...session,moduleSettings:normalizeModuleSettings({profile:"core-only"})};
  await assert.rejects(bridge.execute("science_run",{name:"biomni.run",arguments:{path:"input.json"}},disabled,signal),/disabled/);
  const after=await mcp.tools();assert.ok(after.length>0,"per-call worker cleanup preserves the shared registry client");
});
