import assert from "node:assert/strict";
import { access, lstat, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  buildLlamaServerArgs,
  createEphemeralLlamaCredential,
  formatLlamaServerError,
  hasLlamaServerStartedModelLoad,
  isLlamaLoopbackBindConflict,
  LlamaServerManager,
  parseCudaBufferBytes,
} from "../src/main/services/llama-server.ts";
import { nvidiaSmiExecutable } from "../src/main/services/nvidia-smi.ts";

const llamaFixture = {
  id: "fixture",
  name: "Fixture",
  path: "C:\\models\\fixture.gguf",
  files: ["C:\\models\\fixture.gguf"],
  sizeBytes: 1,
  architecture: "qwen35",
  quantization: "Q4_K_M",
  contextLength: 1_048_576,
  vision: false,
  toolCapability: "agent-ready",
  fingerprint: "fixture",
  estimatedVramBytes: 0,
  loadState: "unloaded",
  pinned: false,
  metadataSource: "gguf",
};

test("llama CUDA allocation logs provide a live VRAM fallback", () => {
  const stderr = [
    "load_tensors: CUDA0 model buffer size =  5400.00 MiB",
    "llama_kv_cache: CUDA0 KV buffer size =  512.50 MiB",
    "llama_context: CUDA0 compute buffer size =  256.00 MiB",
    "llama_context: CPU compute buffer size =  128.00 MiB",
  ].join("\n");
  assert.equal(parseCudaBufferBytes(stderr), Math.round(6168.5 * 1024 ** 2));
});

test("Windows NVIDIA probes resolve only through an absolute system path", () => {
  assert.equal(
    nvidiaSmiExecutable({ SystemRoot: "C:\\Windows", PATH: "C:\\untrusted" }, "win32"),
    "C:\\Windows\\System32\\nvidia-smi.exe",
  );
  assert.throws(
    () => nvidiaSmiExecutable({ SystemRoot: "relative-root" }, "win32"),
    /trusted absolute Windows system root/i,
  );
  assert.equal(nvidiaSmiExecutable({}, "linux"), "/usr/bin/nvidia-smi");
});

test("llama tool-call parse failures are concise and actionable", () => {
  const detail = JSON.stringify({
    error: {
      message: `Failed to parse tool call arguments as JSON: ${"malformed".repeat(5_000)}`,
    },
  });
  const message = formatLlamaServerError(500, detail);
  assert.match(message, /malformed tool-call JSON/i);
  assert.match(message, /Chat-only/i);
  assert.ok(message.length < 240);
});

test("long-context launch arguments preserve exact context and place quantized KV in host RAM", () => {
  const apiKeyFile = "C:\\Users\\fixture\\AppData\\Local\\Temp\\proto-workbench-llama-test\\api-key";
  const args = buildLlamaServerArgs(llamaFixture, {
    contextLength: 524_288,
    gpuLayers: 24,
    cacheType: "q4_0",
    kvCachePlacement: "cpu",
    port: 12_345,
    apiKeyFile,
  });

  assert.deepEqual(args.slice(args.indexOf("--port"), args.indexOf("--port") + 2), ["--port", "12345"]);
  assert.deepEqual(args.slice(args.indexOf("--api-key-file"), args.indexOf("--api-key-file") + 2), ["--api-key-file", apiKeyFile]);
  assert.equal(args.includes("--api-key"), false);
  assert.equal(args.includes("--reuse-port"), false);
  assert.deepEqual(args.slice(args.indexOf("--ctx-size"), args.indexOf("--ctx-size") + 2), ["--ctx-size", "524288"]);
  assert.deepEqual(args.slice(args.indexOf("--n-gpu-layers"), args.indexOf("--n-gpu-layers") + 2), ["--n-gpu-layers", "24"]);
  assert.deepEqual(args.slice(args.indexOf("--cache-type-k"), args.indexOf("--cache-type-k") + 2), ["--cache-type-k", "q4_0"]);
  assert.ok(args.includes("--no-kv-offload"));
  assert.deepEqual(args.slice(args.indexOf("--fit"), args.indexOf("--fit") + 2), ["--fit", "off"]);
  assert.deepEqual(args.slice(args.indexOf("--parallel"), args.indexOf("--parallel") + 2), ["--parallel", "1"]);
  assert.deepEqual(args.slice(args.indexOf("--flash-attn"), args.indexOf("--flash-attn") + 2), ["--flash-attn", "on"]);
  assert.ok(args.includes("--offline"));
  assert.ok(args.includes("--no-webui"));
  assert.deepEqual(args.slice(args.indexOf("--log-verbosity"), args.indexOf("--log-verbosity") + 2), ["--log-verbosity", "3"]);
});

test("llama startup waits for the pinned post-bind, pre-metadata marker", () => {
  assert.equal(hasLlamaServerStartedModelLoad("srv    load_model: loading model 'fixture.gguf'\r\n"), true);
  assert.equal(
    hasLlamaServerStartedModelLoad("0.00.109.346 I srv    load_model: loading model 'Qwen3.6-35B-A3B-Q4_K_M.gguf'\r\n"),
    true,
  );
  assert.equal(hasLlamaServerStartedModelLoad("prefix I srv    load_model: loading model 'fixture.gguf'\r\n"), false);
  assert.equal(hasLlamaServerStartedModelLoad("[DEBUG] 0.00.109.346 I srv    load_model: loading model 'fixture.gguf'\r\n"), false);
  assert.equal(hasLlamaServerStartedModelLoad("model metadata: loading model 'fixture.gguf'"), false);
  assert.equal(hasLlamaServerStartedModelLoad("srv  load_model: loading model 'fixture.gguf'"), false);
  assert.equal(hasLlamaServerStartedModelLoad("srv    load_model: loading model fixture.gguf"), false);
  assert.equal(
    isLlamaLoopbackBindConflict(
      new Error("srv  start: couldn't bind HTTP server socket, hostname: 127.0.0.1, port: 49152"),
    ),
    true,
  );
  assert.equal(isLlamaLoopbackBindConflict(new Error("exiting due to model loading error")), false);

  assert.throws(
    () => buildLlamaServerArgs(
      { ...llamaFixture, path: "C:\\models\\fixture.gguf\nspoof" },
      { contextLength: 2_048, gpuLayers: 0, port: 49_152, apiKeyFile: "C:\\safe\\api-key" },
    ),
    /control-line characters/,
  );
  assert.throws(
    () => buildLlamaServerArgs(
      llamaFixture,
      { contextLength: 2_048, gpuLayers: 0, port: 0, apiKeyFile: "C:\\safe\\api-key" },
    ),
    /port must be an integer/,
  );
});

test("llama bearer credential uses a short-lived file and never enters launch argv", async (context) => {
  const token = "a".repeat(48);
  const credential = await createEphemeralLlamaCredential(token);
  context.after(() => credential.dispose());

  assert.equal(credential.path.includes(token), false);
  assert.equal(await readFile(credential.path, "utf8"), `${token}\n`);
  if (process.platform !== "win32") {
    assert.equal((await lstat(credential.path)).mode & 0o077, 0);
  }

  const args = buildLlamaServerArgs(llamaFixture, {
    contextLength: 2_048,
    gpuLayers: 0,
    port: 49_152,
    apiKeyFile: credential.path,
  });
  assert.equal(args.includes(token), false);

  const directory = dirname(credential.path);
  await credential.dispose();
  await assert.rejects(access(credential.path), { code: "ENOENT" });
  await assert.rejects(access(directory), { code: "ENOENT" });
});

test("llama spawn failures reject cleanly instead of becoming uncaught main-process errors", async () => {
  const runtime = new LlamaServerManager({
    packaged: false,
    resourcesPath: "",
    projectRoot: join(tmpdir(), `proto-missing-runtime-${crypto.randomUUID()}`),
  });
  await assert.rejects(
    runtime.load(
      { ...llamaFixture, id: "missing-runtime", name: "Missing runtime fixture", contextLength: 2_048 },
      { contextLength: 2_048, gpuLayers: 0 },
    ),
    /llama-server\.exe is not installed/,
  );
});

test("llama runtime streams authenticated OpenAI-compatible SSE chunks", async (context) => {
  let authorization = "";
  let requestBody = "";
  const server = createServer((request, response) => {
    authorization = request.headers.authorization || "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => (requestBody += chunk));
    request.on("end", () => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write('data: {"choices":[{"delta":{"content":"Hel');
      response.write('lo"}}]}\r\n\r\n');
      response.write('data: {"choices":[{"delta":{"content":" world"}}]}\r\n\r\n');
      response.end("data: [DONE]\r\n");
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  context.after(() => server.close());

  const address = server.address();
  assert.equal(typeof address, "object");
  const runtime = new LlamaServerManager({
    packaged: false,
    resourcesPath: "",
    projectRoot: ".",
  });
  runtime.servers.set("model-1", {
    instance: {
      modelId: "model-1",
      state: "active",
      port: address.port,
      contextLength: 32768,
      gpuLayers: 999,
    },
    process: {},
    token: "session-token",
    stderr: "",
  });

  const chunks = [];
  await runtime.chat(
    "model-1",
    { model: "local", messages: [{ role: "user", content: "hello" }] },
    (chunk) => chunks.push(chunk),
  );

  assert.equal(authorization, "Bearer session-token");
  assert.equal(JSON.parse(requestBody).stream, true);
  assert.equal(chunks.map((chunk) => chunk.choices?.[0]?.delta?.content || "").join(""), "Hello world");
});

test("llama runtime stops at the SSE done frame even when the connection stays open", async (context) => {
  const server = createServer((request, response) => {
    request.resume();
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"workspace_read","arguments":"{}"}}]}}]}\r\n\r\n');
    response.write("data: [DONE]\r\n\r\n");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  context.after(() => {
    server.closeAllConnections?.();
    server.close();
  });

  const address = server.address();
  assert.equal(typeof address, "object");
  const runtime = new LlamaServerManager({ packaged: false, resourcesPath: "", projectRoot: "." });
  runtime.servers.set("model-done", {
    instance: {
      modelId: "model-done",
      state: "active",
      port: address.port,
      contextLength: 32768,
      gpuLayers: 0,
    },
    process: {},
    token: "session-token",
    stderr: "",
  });

  const chunks = [];
  await Promise.race([
    runtime.chat("model-done", { model: "local", messages: [] }, (chunk) => chunks.push(chunk)),
    new Promise((_, reject) => setTimeout(() => reject(new Error("SSE done frame did not terminate the request.")), 1_000)),
  ]);

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].choices?.[0]?.delta?.tool_calls?.[0]?.function?.name, "workspace_read");
});
