import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createMcpClient } from "../scripts/verify-sidecars.mjs";
import {
  minimalEnvironment as packagedUiEnvironment,
  quizDecisionIsNoGo,
} from "../scripts/verify-packaged-ui.mjs";

const execFileAsync = promisify(execFile);
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const cases = [
  ["verify-inference.mjs", "REAL_MODEL_TEST_DISABLED", "PROTO_AGENT_ALLOW_REAL_MODEL_TESTS", "YES_START_OWNED_MODEL_PROCESSES"],
  ["verify-model-pool.mjs", "REAL_MODEL_TEST_DISABLED", "PROTO_AGENT_ALLOW_REAL_MODEL_TESTS", "YES_START_OWNED_MODEL_PROCESSES"],
  ["verify-agent-workflow.mjs", "REAL_MODEL_TEST_DISABLED", "PROTO_AGENT_ALLOW_REAL_MODEL_TESTS", "YES_START_OWNED_MODEL_PROCESSES"],
  ["verify-sidecars.mjs", "SIDECAR_TEST_DISABLED", "PROTO_AGENT_ALLOW_SIDECAR_TESTS", "YES_START_OWNED_SIDECARS"],
];

test("packaged UI minimal environment preserves NVML's Windows ProgramFiles dependency", () => {
  const environment = packagedUiEnvironment({
    SystemRoot: "C:\\Windows",
    ProgramFiles: "C:\\Program Files",
    PATH: "C:\\Windows\\System32",
    PROTO_PRIVATE_SENTINEL: "must-not-cross",
  });
  assert.equal(environment.ProgramFiles, "C:\\Program Files");
  assert.equal(environment.SystemRoot, "C:\\Windows");
  assert.equal(environment.PROTO_PRIVATE_SENTINEL, undefined);
});

test("packaged UI quiz gate accepts an explicit Chinese no but rejects decision conflation", () => {
  assert.equal(
    quizDecisionIsNoGo("结论：否。理由：软件流程通过不涵盖生物学可行性，科学设计必须独立验证。"),
    true,
  );
  assert.equal(quizDecisionIsNoGo("结论：是。软件流程通过就等同于科学设计 GO。"), false);
});

for (const [scriptName, expectedCode, environmentName, confirmation] of cases) {
  test(`${scriptName} fails closed without an explicit execution capability`, async () => {
    const env = gateEnvironment();
    delete env.PROTO_AGENT_ALLOW_REAL_MODEL_TESTS;
    delete env.PROTO_AGENT_ALLOW_SIDECAR_TESTS;

    await assert.rejects(
      execFileAsync(process.execPath, [join(appRoot, "scripts", scriptName)], {
        cwd: appRoot,
        env,
        timeout: 5_000,
        maxBuffer: 64 * 1024,
        windowsHide: true,
      }),
      (error) => {
        assert.equal(error.code, 2);
        const payload = JSON.parse(String(error.stderr).trim());
        assert.equal(payload.ok, false);
        assert.equal(payload.code, expectedCode);
        return true;
      },
    );
  });

  test(`${scriptName} does not treat an inherited environment value as approval`, async () => {
    const sentinel = "PROTO_GATE_PRIVATE_SENTINEL";
    const env = gateEnvironment({ [environmentName]: confirmation, PROTO_GATE_SECRET: sentinel });
    const error = await rejectedGate(scriptName, [], env);
    assert.equal(error.code, 2);
    const payload = JSON.parse(String(error.stderr).trim());
    assert.equal(payload.code, expectedCode);
    assert.equal(String(error.stderr).includes(sentinel), false);
  });

  test(`${scriptName} does not treat a command-line flag alone as approval`, async () => {
    const flag = `--confirm-owned-execution=${confirmation}`;
    const error = await rejectedGate(scriptName, [flag], gateEnvironment());
    assert.equal(error.code, 2);
    assert.equal(JSON.parse(String(error.stderr).trim()).code, expectedCode);
  });

  test(`${scriptName} checks explicit roots before loading runtime dependencies`, async () => {
    const flag = `--confirm-owned-execution=${confirmation}`;
    const error = await rejectedGate(
      scriptName,
      [flag],
      gateEnvironment({ [environmentName]: confirmation }),
    );
    assert.equal(error.code, 2);
    assert.equal(JSON.parse(String(error.stderr).trim()).code, "EXPLICIT_ROOTS_REQUIRED");
  });
}

test("verification modules are import-safe and do not execute their gates", async () => {
  for (const [scriptName] of cases) {
    const module = await import(new URL(`../scripts/${scriptName}`, import.meta.url));
    assert.equal(typeof module.main, "function");
  }
});

test("bounded MCP client handles a split JSON-RPC frame", async () => {
  const workspace = await mkdtemp(resolve(tmpdir(), "proto-mcp-frame-"));
  const serverCode = [
    "let b='';",
    "process.stdin.on('data',c=>{b+=c;let i;while((i=b.indexOf('\\n'))>=0){",
    "const line=b.slice(0,i);b=b.slice(i+1);if(!line)continue;const m=JSON.parse(line);",
    "if(m.id){const out=JSON.stringify({jsonrpc:'2.0',id:m.id,result:{ok:true,value:7}})+'\\n';",
    "process.stdout.write(out.slice(0,5));setTimeout(()=>process.stdout.write(out.slice(5)),5);}}});",
    "setTimeout(()=>process.exit(0),5000);",
  ].join("");
  const client = await createMcpClient(process.execPath, workspace, {
    args: ["-e", serverCode],
    requestTimeoutMs: 1_000,
    writeTimeoutMs: 500,
  });
  try {
    assert.deepEqual(await client.request("tools/list", {}), { ok: true, value: 7 });
  } finally {
    await client.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("MCP request timeout wins over a late frame and closes the owned child", async () => {
  const workspace = await mkdtemp(resolve(tmpdir(), "proto-mcp-timeout-"));
  const serverCode = [
    "let b='';process.stdin.on('data',c=>{b+=c;const i=b.indexOf('\\n');if(i<0)return;",
    "const m=JSON.parse(b.slice(0,i));setTimeout(()=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{late:true}})+'\\n'),250);});",
    "setTimeout(()=>process.exit(0),5000);",
  ].join("");
  const client = await createMcpClient(process.execPath, workspace, {
    args: ["-e", serverCode],
    requestTimeoutMs: 100,
    writeTimeoutMs: 500,
  });
  try {
    await assert.rejects(
      client.request("tools/list", {}),
      (error) => error?.code === "MCP_REQUEST_TIMEOUT",
    );
  } finally {
    await client.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("MCP frame and queued-stdin budgets close the owned child", async () => {
  const frameWorkspace = await mkdtemp(resolve(tmpdir(), "proto-mcp-limit-"));
  const frameClient = await createMcpClient(process.execPath, frameWorkspace, {
    args: ["-e", "setTimeout(()=>process.stdout.write('x'.repeat(129)),20);setTimeout(()=>process.exit(0),5000)"],
    maxFrameBytes: 128,
    maxStdoutBytes: 256,
    requestTimeoutMs: 1_000,
  });
  try {
    await assert.rejects(
      frameClient.request("tools/list", {}),
      (error) => error?.code === "MCP_FRAME_LIMIT",
    );
  } finally {
    await frameClient.close();
    await rm(frameWorkspace, { recursive: true, force: true });
  }

  const stdinWorkspace = await mkdtemp(resolve(tmpdir(), "proto-mcp-stdin-"));
  const stdinClient = await createMcpClient(process.execPath, stdinWorkspace, {
    args: ["-e", "process.stdin.resume();setTimeout(()=>process.exit(0),5000)"],
    maxQueuedStdinBytes: 64,
    writeTimeoutMs: 100,
  });
  try {
    await assert.rejects(
      stdinClient.notify("notifications/initialized", { payload: "x".repeat(128) }),
      (error) => error?.code === "MCP_STDIN_LIMIT",
    );
  } finally {
    await stdinClient.close();
    await rm(stdinWorkspace, { recursive: true, force: true });
  }
});

test("MCP process failures suppress child stderr", async () => {
  const workspace = await mkdtemp(resolve(tmpdir(), "proto-mcp-stderr-"));
  const sentinel = "PROTO_MCP_PRIVATE_STDERR_SENTINEL";
  const client = await createMcpClient(process.execPath, workspace, {
    args: ["-e", `setTimeout(()=>{process.stderr.write(${JSON.stringify(sentinel)});process.exit(9)},25)`],
    requestTimeoutMs: 1_000,
  });
  try {
    await assert.rejects(client.request("tools/list", {}), (error) => {
      assert.equal(error?.code, "MCP_EXITED");
      assert.equal(error.message.includes(sentinel), false);
      assert.equal(JSON.stringify(error.details).includes(sentinel), false);
      return true;
    });
  } finally {
    await client.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

function gateEnvironment(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.NODE_OPTIONS;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.PROTO_AGENT_ALLOW_REAL_MODEL_TESTS;
  delete env.PROTO_AGENT_ALLOW_SIDECAR_TESTS;
  Object.assign(env, extra);
  return env;
}

async function rejectedGate(scriptName, args, env) {
  try {
    await execFileAsync(process.execPath, [join(appRoot, "scripts", scriptName), ...args], {
      cwd: appRoot,
      env,
      timeout: 3_000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    });
  } catch (error) {
    return error;
  }
  throw new Error(`${scriptName} unexpectedly succeeded.`);
}
