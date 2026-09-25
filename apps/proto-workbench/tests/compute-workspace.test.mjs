import { ManagedMcpTestClient } from "./helpers/managed-mcp.mjs";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, symlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runWorkspaceComputation, writeWorkspaceComputeRequest } from "../src/main/services/compute-workspace.ts";
import { McpClient } from "../src/main/services/mcp-client.ts";
import { validateIpcArguments } from "../src/main/ipc-security.ts";
import { IPC } from "../src/shared/ipc.ts";
import { previewCompute } from "../src/renderer/compute-preview.ts";
import { fieldsFor, requestArguments } from "../src/renderer/compute-presentation.ts";

test("compute IPC accepts bounded data and rejects code, paths, nonfinite values and oversized payloads", () => {
  assert.doesNotThrow(() => validateIpcArguments(IPC.computeRun,[{tool:"descriptive_statistics",arguments:{values:[1,2,3]}}]));
  for(const request of [
    {tool:"../../shell",arguments:{}}, {tool:"descriptive_statistics",arguments:{},path:"outside.json"},
    {tool:"descriptive_statistics",arguments:{values:[Infinity]}},
    {tool:"descriptive_statistics",arguments:{value:"x".repeat(1_000_001)}},
  ]) assert.throws(()=>validateIpcArguments(IPC.computeRun,[request]));
});

test("the UI computation service preserves submitted input and returns real source-bound statistics", {timeout:30_000}, async () => {
  const repo=fileURLToPath(new URL("../../../",import.meta.url));
  const parent=resolve("build/test-compute-workspace"); await mkdir(parent,{recursive:true});
  const workspace=await mkdtemp(join(parent,"run-"));
  const client=new ManagedMcpTestClient({packaged:false,resourcesPath:"",repoRoot:repo,workspacePath:workspace,
    workspaceCapability:randomBytes(32).toString("hex"),materialsRoot:join(workspace,"materials"),pythonExecutable:join(repo,".venv/Scripts/python.exe")});
  try {
    const request={tool:"compare_two_groups",arguments:{group_a:[1,1,1],group_b:[1,2,3],method:"welch_t"}};
    const result=await runWorkspaceComputation(workspace,request,(name,input)=>client.call(name,input));
    assert.equal(result.ok,true); assert.ok(Math.abs(result.result.statistic+Math.sqrt(3))<1e-12);
    assert.equal(result.result.degrees_of_freedom,2);
    const manifest=JSON.parse(await readFile(join(workspace,result.manifest_path),"utf8"));
    assert.deepEqual(JSON.parse(await readFile(join(workspace,manifest.source.path),"utf8")),request);
    assert.deepEqual(JSON.parse(await readFile(join(workspace,manifest.inputs.request_snapshot),"utf8")),request);
    assert.equal(manifest.review_status,"human_review_required");
  } finally {await client.stop();}
});

test("compute service rejects a linked artifact root before writing or calling the runtime", async () => {
  const parent=resolve("build/test-compute-workspace");await mkdir(parent,{recursive:true});
  const workspace=await mkdtemp(join(parent,"linked-")),outside=await mkdtemp(join(parent,"outside-"));
  await symlink(outside,join(workspace,"build"),process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(runWorkspaceComputation(workspace,{tool:"descriptive_statistics",arguments:{values:[1]}},async()=>{throw new Error("Runtime must not be reached");}),/without links or junctions/);
});

test("all 127 static examples replay honestly and edited data is refused outside the live dev server", async () => {
  const catalog=await previewCompute.catalog(); assert.equal(catalog.tools.length,127);
  for(const tool of catalog.tools){const result=await previewCompute.run({tool:tool.id,arguments:tool.example});assert.equal(result.ok,true);assert.equal(result.preview,true);assert.equal(result.run_id,undefined);}
  await assert.rejects(previewCompute.run({tool:"descriptive_statistics",arguments:{values:[9,9]}}),/supplied example only/);
});

test("compute request snapshots are stable per operation ID and reject changed request bytes", async () => {
  const parent=resolve("build/test-compute-workspace");await mkdir(parent,{recursive:true});
  const workspace=await mkdtemp(join(parent,"stable-request-")),operationId="2c4e1b20-9f6c-4eed-bc96-dfbc4f685a6b";
  const request={tool:"descriptive_statistics",arguments:{values:[1,2,3]}};
  const first=await writeWorkspaceComputeRequest(workspace,request,operationId);
  const reopened=await writeWorkspaceComputeRequest(workspace,request,operationId);
  assert.equal(reopened,first);
  await assert.rejects(writeWorkspaceComputeRequest(workspace,{tool:request.tool,arguments:{values:[1,2,4]}},operationId),/COMPUTE_REQUEST_IDENTITY_CONFLICT/);
});

test("new digit-bearing methods and ordered file lists execute through the real UI service and MCP", {timeout:30_000}, async () => {
  const repo=fileURLToPath(new URL("../../../",import.meta.url));
  const parent=resolve("build/test-compute-workspace"); await mkdir(parent,{recursive:true});
  const workspace=await mkdtemp(join(parent,"new-methods-"));
  const python=join(repo,".venv/Scripts/python.exe");
  const client=new ManagedMcpTestClient({packaged:false,resourcesPath:"",repoRoot:repo,workspacePath:workspace,
    workspaceCapability:randomBytes(32).toString("hex"),materialsRoot:join(workspace,"materials"),pythonExecutable:python});
  try {
    const tool=(await client.call("proto_compute_catalog",{tool:"analyze_abr_waveform_p1_metrics"})).tools[0];
    validateIpcArguments(IPC.computeCatalog,[tool.id]);
    const request={tool:tool.id, arguments:requestArguments(tool,fieldsFor(tool))};
    validateIpcArguments(IPC.computeRun,[request]);
    const result=await runWorkspaceComputation(workspace,request,(name,input)=>client.call(name,input));
    assert.equal(result.ok,true); assert.equal(result.result.p1.latency_ms,2); assert.equal(result.result.p1.amplitude_uv,1.6);
    execFileSync(python,["-c", `import cv2, numpy as np, sys
from pathlib import Path
root=Path(sys.argv[1])
for i in range(6):
 image=np.zeros((100,100),dtype=np.uint8)
 cv2.circle(image,(20+4*i,20),6,255,-1)
 (root/f'frame-{i}.png').write_bytes(cv2.imencode('.png',image)[1].tobytes())`,workspace],{cwd:repo,windowsHide:true});
    const paths=Array.from({length:6},(_,i)=>`frame-${i}.png`);
    const fileTool=(await client.call("proto_compute_catalog",{tool:"analyze_cell_migration_metrics"})).tools[0];
    const fileRequest={tool:fileTool.id,arguments:requestArguments(fileTool,{frame_paths:paths.join("\n"),pixel_size_um:"0.5",time_interval_min:"2",min_track_length:"4"})};
    validateIpcArguments(IPC.computeRun,[fileRequest]);
    const fileRun=await runWorkspaceComputation(workspace,fileRequest,(name,input)=>client.call(name,input));
    assert.equal(fileRun.ok,true); assert.equal(fileRun.result.tracks[0].net_displacement,10);
    const manifest=JSON.parse(await readFile(join(workspace,fileRun.manifest_path),"utf8"));
    const claims=paths.map((_,index)=>manifest.inputs[`file:frame_paths[${index}]`]);
    assert.deepEqual(claims.map(entry=>entry.path),paths);
    assert.ok(claims.every(entry=>/^[a-f0-9]{64}$/.test(entry.sha256)));
  } finally {await client.stop();}
});
