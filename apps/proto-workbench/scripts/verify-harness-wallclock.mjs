/** Bounded transport-fault evidence. No live model or scientific tool is used. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { LmStudioProvider, LM_STUDIO_CHAT_IDLE_TIMEOUT_MS } from "../src/main/services/lm-studio-provider.ts";
import { McpClient } from "../src/main/services/mcp-client.ts";
import { minimalChildEnvironment } from "../src/main/services/process-security.ts";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const root = join(repo, "build/upgrade-20260904/wallclock-faults", new Date().toISOString().replace(/[:.]/g, "-") + "-" + randomUUID().slice(0, 8));
await mkdir(root, {recursive: true});
const report = {schema: "proto-workbench.wallclock-faults.v1", startedAt: new Date().toISOString(), scope: "Controlled local HTTP and owned stdio fault fixtures; no live model, biological tool execution or external network", tests: [], code: {}};
for (const file of ["lm-studio-provider.ts", "mcp-client.ts", "runtime-control.ts", "process-security.ts"]) report.code[file] = createHash("sha256").update(await readFile(new URL(`../src/main/services/${file}`, import.meta.url))).digest("hex");
const writeReport = () => writeFile(join(root, "report.json"), JSON.stringify(report, null, 2));
await writeReport();
const model = {type: "llm", publisher: "controlled-fixture", key: "wallclock-fixture@q4", display_name: "Controlled transport fixture", architecture: "fixture", quantization: {name: "Q4", bits_per_weight: 4}, size_bytes: 1, params_string: "fixture", loaded_instances: [{id: "wallclock-instance", config: {context_length: 32768}}], max_context_length: 131072, format: "gguf", capabilities: {vision: false, trained_for_tool_use: true}, description: null};
const timers = new Set();
const server = createServer((request, response) => {
  request.resume();
  if (!request.url.startsWith("/v1/chat/completions")) {response.writeHead(200, {"content-type": "application/json"}); response.end(JSON.stringify({models: [model]})); return;}
  if (request.url.includes("prefill")) {
    const timer = setTimeout(() => {timers.delete(timer); response.writeHead(200, {"content-type": "text/event-stream"}); response.end('data: {"choices":[{"delta":{"content":"ready"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');}, 16_500);
    timers.add(timer); response.on("close", () => {clearTimeout(timer); timers.delete(timer);});
  } else {
    response.writeHead(200, {"content-type": "text/event-stream"});
    response.write('data: {"choices":[{"delta":{"content":"initial token"}}]}\n\n');
    const timer = setInterval(() => response.write(": transport heartbeat only\n\n"), 1000);
    timers.add(timer); response.on("close", () => {clearInterval(timer); timers.delete(timer);});
  }
});
server.listen(0, "127.0.0.1"); await once(server, "listening");
const port = server.address().port;
report.http = {host: "127.0.0.1", port};
const clients = [], providers = [];
const deadline = AbortSignal.timeout(240_000);
const fixture = join(root, "stdio-fixture.mjs");
await writeFile(fixture, `import {createInterface} from 'node:readline';
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
const timers=new Map();
createInterface({input:process.stdin}).on('line', line=>{const msg=JSON.parse(line);
 if(msg.method==='initialize') send({id:msg.id,result:{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'wallclock-fixture',version:'1'}}});
 else if(msg.method==='tools/call') {const timer=setTimeout(()=>{timers.delete(msg.id);send({id:msg.id,result:{structuredContent:{ok:true,fixture:true,delayMs:msg.params.arguments.delayMs,pid:process.pid}}});},msg.params.arguments.delayMs);timers.set(msg.id,timer);}
 // Deliberately withhold cancellation acknowledgement to exercise owned cleanup.
});
process.stdin.on('end',()=>process.exit(0));
`);
const makeClient = () => {
  const client = new McpClient({packaged: false, resourcesPath: root, repoRoot: repo, workspacePath: root, workspaceCapability: "a".repeat(64)});
  client.command = () => ({command: process.execPath, args: [fixture], env: minimalChildEnvironment()});
  clients.push(client); return client;
};
async function check(name, task) {
  const began = performance.now();
  try {const details = await task(); report.tests.push({name, status: "passed", elapsedMs: Math.round(performance.now() - began), details});}
  catch (error) {report.tests.push({name, status: "failed", elapsedMs: Math.round(performance.now() - began), error: String(error)}); process.exitCode = 1;}
  await writeReport(); console.log(JSON.stringify(report.tests.at(-1)));
}
async function providerFor(mode) {
  const provider = new LmStudioProvider({environment: {}, fetchImpl: (url, init) => {
    const original = new URL(url);
    assert.equal(original.hostname, "127.0.0.1");
    return fetch(`http://127.0.0.1:${port}${original.pathname}?${mode}`, {...init, signal: init?.signal ? AbortSignal.any([deadline, init.signal]) : deadline});
  }});
  providers.push(provider);
  const [descriptor] = await provider.scan(""); await provider.load(descriptor, {instanceId: "wallclock-instance"});
  return {provider, descriptor};
}
try {
  await Promise.all([
    check("real HTTP response headers arrive after the historical 15-second limit", async () => {
      const {provider, descriptor} = await providerFor("prefill"); const chunks = []; const began = performance.now();
      await provider.chat(descriptor.id, {messages: [{role: "user", content: "fixture"}], max_tokens: 16}, chunk => chunks.push(chunk), deadline);
      const elapsedMs = performance.now() - began;
      assert.ok(elapsedMs >= 16_000 && elapsedMs < 35_000); assert.equal(chunks[0].choices[0].delta.content, "ready");
      return {elapsedMs, firstIncrement: "ready", actualLoadedContext: (await provider.getExecutionBinding(descriptor.id)).contextLength};
    }),
    check("transport heartbeats cannot hide an actual 90-second generation stall", async () => {
      const {provider, descriptor} = await providerFor("stall"); const began = performance.now(); const chunks = [];
      await assert.rejects(provider.chat(descriptor.id, {messages: [{role: "user", content: "fixture"}], max_tokens: 16}, chunk => chunks.push(chunk), deadline), error => error.code === "STREAM_STALLED");
      const elapsedMs = performance.now() - began;
      assert.ok(elapsedMs >= LM_STUDIO_CHAT_IDLE_TIMEOUT_MS - 1000 && elapsedMs < LM_STUDIO_CHAT_IDLE_TIMEOUT_MS + 15_000);
      assert.equal(chunks.length, 1); return {elapsedMs, code: "STREAM_STALLED", configuredIdleMs: LM_STUDIO_CHAT_IDLE_TIMEOUT_MS};
    }),
    check("an actual 181-second MCP request survives while another owned session is cancelled", async () => {
      const a = makeClient(), b = makeClient(), cancelA = new AbortController(); const began = performance.now();
      const aResult = a.call("proto_workflow_run", {delayMs: 220_000}, AbortSignal.any([deadline, cancelA.signal]));
      const cancelledA = assert.rejects(aResult, error => error.code === "USER_CANCELLED");
      const bResult = b.call("proto_workflow_run", {delayMs: 181_500}, deadline);
      await delay(1500, undefined, {signal: deadline});
      const childA = a.child, childB = b.child;
      assert.ok(childA?.pid && childB?.pid && childA.pid !== childB.pid);
      report.ownedPids = [childA.pid, childB.pid]; await writeReport();
      cancelA.abort(); await cancelledA; await delay(12_000, undefined, {signal: deadline});
      assert.equal(a.child, undefined); assert.equal(b.child, childB); assert.equal(childB.exitCode, null);
      const output = await bResult; const elapsedMs = performance.now() - began;
      assert.ok(elapsedMs > 180_000); assert.equal(output.pid, childB.pid); assert.equal(output.fixture, true);
      return {elapsedMs, cancelledPid: childA.pid, survivingPid: childB.pid, survivingResult: output, outerDeadlineMs: 630_000};
    }),
  ]);
} finally {
  const cleanup = await Promise.allSettled(clients.map(client => client.stop()));
  for (const timer of timers) {clearTimeout(timer); clearInterval(timer);}
  server.closeAllConnections(); await new Promise(resolveClose => server.close(resolveClose));
  report.cleanup = cleanup.map(value => ({status: value.status, ...(value.status === "rejected" ? {error: String(value.reason)} : {})}));
  if (cleanup.some(value => value.status === "rejected")) process.exitCode = 1;
  report.finishedAt = new Date().toISOString(); report.status = process.exitCode ? "failed" : "passed"; await writeReport();
  console.log(JSON.stringify({root, status: report.status}));
}
