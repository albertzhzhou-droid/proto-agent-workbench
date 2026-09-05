import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import test from "node:test";
import {mkdir,mkdtemp,rm} from "node:fs/promises";
import {join,resolve,relative,isAbsolute} from "node:path";
import {fileURLToPath} from "node:url";

import { McpClient, parseCapabilities } from "../src/main/services/mcp-client.ts";

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

test("network capability is short-lived and bound to exact approved arguments", () => {
  const key = "42".repeat(32);
  const client = new McpClient({
    packaged: false,
    resourcesPath: "C:\\fixture",
    repoRoot: "C:\\fixture",
    workspacePath: "C:\\workspace",
    workspaceCapability: key,
    pythonExecutable: "unused",
  });
  const arguments_ = {
    query: "synthetic biology",
    offline: false,
    nested: { z: 2, a: "value" },
  };
  const before = Date.now();
  const capability = client.createNetworkCapability(
    "proto_pubmed_search",
    arguments_,
    {
      runId: "run-test",
      approvalId: "approval-test",
      expiresAt: new Date(before + 10 * 60_000).toISOString(),
    },
  );
  const { mac, ...unsigned } = capability;

  assert.equal(capability.version, "proto-workbench.network-capability.v1");
  assert.equal(capability.tool, "proto_pubmed_search");
  assert.equal(
    capability.argumentsSha256,
    createHash("sha256").update(stableJson(arguments_)).digest("hex"),
  );
  assert.ok(capability.issuedAtMs >= before);
  assert.ok(capability.expiresAtMs <= capability.issuedAtMs + 60_000);
  assert.match(capability.nonce, /^[a-f0-9]{32}$/);
  assert.equal(
    mac,
    createHmac("sha256", Buffer.from(key, "hex")).update(stableJson(unsigned)).digest("hex"),
  );
  assert.equal(JSON.stringify(capability).includes(key), false);
});

test("network capability refuses an expired approval", () => {
  const client = new McpClient({
    packaged: false,
    resourcesPath: "C:\\fixture",
    repoRoot: "C:\\fixture",
    workspacePath: "C:\\workspace",
    workspaceCapability: "24".repeat(32),
  });
  assert.throws(
    () => client.createNetworkCapability(
      "proto_pubmed_search",
      { query: "expired", offline: false },
      {
        runId: "run-test",
        approvalId: "approval-test",
        expiresAt: new Date(Date.now() - 1).toISOString(),
      },
    ),
    /expired/,
  );
});

test("actual Python sidecar capability policy is accepted without granting network or arbitrary execution",async()=>{
  const repo=fileURLToPath(new URL("../../../",import.meta.url));
  const owned=resolve("build/test-mcp-capabilities");await mkdir(owned,{recursive:true});
  const workspace=await mkdtemp(join(owned,"actual-"));
  const client=new McpClient({packaged:false,resourcesPath:"",repoRoot:repo,workspacePath:workspace,workspaceCapability:randomBytes(32).toString("hex"),
    materialsRoot:join(workspace,"isolated-materials"),pythonExecutable:process.env.PROTO_AGENT_PYTHON||join(repo,process.platform==="win32"?".venv/Scripts/python.exe":".venv/bin/python")});
  try {
    const capability=await client.capabilities();
    assert.equal(capability.networkEnabled,false);
    assert.equal(capability.networkAuthorization,"per-call-hmac-capability");
    assert.equal(capability.networkPathPolicy.fixtures,"workspace regular files only");
    assert.equal(capability.networkPathPolicy.ca,"custom CA selection is disabled for MCP requests");
    assert.ok(capability.networkPaths.some(path=>path.startsWith("cache: file:")));
    assert.equal(capability.filesystemSafety.relativePathsOnly,true);
    assert.throws(()=>parseCapabilities({...capability,networkPaths:{...capability.networkPathPolicy,arbitrary:true}}),/networkPaths/);
    assert.throws(()=>parseCapabilities({...capability,networkPaths:{...capability.networkPathPolicy,ca:false}}),/networkPaths.ca/);
  } finally {
    const process = client.child;let closed = !process;
    process?.once("close",()=>{closed=true;});
    await client.stop();
    if(process){assert.ok(process.exitCode!==null||process.signalCode!==null,"owned Python must have exited before stop resolves");assert.equal(closed,true,"owned Python stdio must close before workspace removal");}
    const child=relative(owned,workspace);assert.ok(child&&!child.startsWith("..")&&!isAbsolute(child));await rm(workspace,{recursive:true,force:true});
  }
});
