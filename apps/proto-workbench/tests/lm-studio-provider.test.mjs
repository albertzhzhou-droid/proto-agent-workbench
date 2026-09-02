import assert from "node:assert/strict";
import test from "node:test";
import {
  LmStudioProvider,
  LM_STUDIO_BASE_URL,
  LM_STUDIO_CHAT_HEADER_TIMEOUT_MS,
  LM_STUDIO_DEFAULT_CHAT_DEADLINE_MS,
  LM_STUDIO_MAX_CHAT_DEADLINE_MS,
} from "../src/main/services/lm-studio-provider.ts";

function nativeModel(overrides = {}) {
  return {
    type: "llm",
    publisher: "fixture-publisher",
    key: "fixture/model@q4_k_m",
    display_name: "Fixture Model",
    architecture: "fixture",
    quantization: { name: "Q4_K_M", bits_per_weight: 4.5 },
    size_bytes: 4_000_000_000,
    params_string: "7B",
    loaded_instances: [],
    max_context_length: 131_072,
    format: "gguf",
    capabilities: {
      vision: true,
      trained_for_tool_use: true,
      reasoning: { allowed_options: ["off", "on"], default: "on" },
    },
    description: null,
    ...overrides,
  };
}

function loadedInstance(id = "fixture-instance", overrides = {}) {
  return {
    id,
    config: {
      context_length: 16_384,
      eval_batch_size: 512,
      parallel: 1,
      flash_attention: true,
      offload_kv_cache_to_gpu: true,
      ...overrides,
    },
  };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sseResponse(frames) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" } });
}

function endlessSseResponse(frame, delayMs = 1) {
  const encoder = new TextEncoder();
  let cancelled = false;
  const body = new ReadableStream({
    async pull(controller) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (!cancelled) controller.enqueue(encoder.encode(frame));
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    response: new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" },
    }),
    wasCancelled: () => cancelled,
  };
}

function scriptedFetch(responses, requests = []) {
  return async (url, init = {}) => {
    requests.push({ url: String(url), init, headers: new Headers(init.headers) });
    const next = responses.shift();
    if (!next) throw new Error(`Unexpected request: ${init.method ?? "GET"} ${url}`);
    return typeof next === "function" ? next(url, init) : next;
  };
}

test("uses independent bounded production deadlines for chat headers and total generation", () => {
  assert.equal(LM_STUDIO_CHAT_HEADER_TIMEOUT_MS, 15_000);
  assert.equal(LM_STUDIO_DEFAULT_CHAT_DEADLINE_MS, 10 * 60_000);
  assert.equal(LM_STUDIO_MAX_CHAT_DEADLINE_MS, 30 * 60_000);
  assert.throws(
    () => new LmStudioProvider({ chatDeadlineMs: LM_STUDIO_MAX_CHAT_DEADLINE_MS + 1 }),
    /chatDeadlineMs must be an integer from 1 to 1800000/,
  );
});

test("discovers rich native model metadata from the one fixed LM Studio endpoint", async () => {
  const requests = [];
  const provider = new LmStudioProvider({
    fetchImpl: scriptedFetch([
      jsonResponse({
        models: [
          nativeModel({ loaded_instances: [loadedInstance()] }),
          nativeModel({
            type: "embedding",
            key: "fixture/embed",
            display_name: "Fixture Embed",
            architecture: null,
            capabilities: undefined,
            max_context_length: 2_048,
          }),
        ],
      }),
    ], requests),
    environment: {},
  });

  const models = await provider.scan("C:\\ignored-model-directory");
  assert.equal(requests[0].url, `${LM_STUDIO_BASE_URL}/api/v1/models`);
  assert.equal(requests[0].init.method, "GET");
  assert.equal(requests[0].init.redirect, "error");
  assert.equal(requests[0].headers.has("authorization"), false);
  assert.equal(models.length, 2);
  assert.match(models[0].id, /^lmstudio:[a-f0-9]{24}$/);
  assert.equal(models[0].provider, "lmstudio");
  assert.equal(models[0].providerModelId, "fixture/model@q4_k_m");
  assert.equal(models[0].metadataSource, "lmstudio");
  assert.equal(models[0].loadState, "warm");
  assert.deepEqual(models[0].loadedInstances?.[0], {
    id: "fixture-instance",
    contextLength: 16_384,
    evalBatchSize: 512,
    parallel: 1,
    flashAttention: true,
    numExperts: undefined,
    offloadKvCacheToGpu: true,
  });
  assert.equal(models[1].modelKind, "embedding");
  assert.equal(provider.has(models[0].id), false, "discovery alone must not implicitly attach to an instance");
});

test("uses optional named environment credentials with deterministic priority and redacts echoed secrets", async () => {
  const requests = [];
  const secret = "top-secret-lmstudio-token";
  const provider = new LmStudioProvider({
    fetchImpl: scriptedFetch([
      jsonResponse({ error: `bad credential ${secret}` }, 401),
    ], requests),
    environment: { LMSTUDIO_API_KEY: secret, LM_API_TOKEN: "lower-priority-token" },
  });

  await assert.rejects(provider.scan("ignored"), (error) => {
    assert.doesNotMatch(error.message, new RegExp(secret));
    assert.match(error.message, /\[REDACTED\]/);
    return true;
  });
  assert.equal(requests[0].headers.get("authorization"), `Bearer ${secret}`);
});

test("loads explicitly, verifies the native instance, and unloads only that owned instance", async () => {
  const requests = [];
  const unloadedCatalog = { models: [nativeModel()] };
  const loadedCatalog = { models: [nativeModel({ loaded_instances: [loadedInstance("owned-instance")] })] };
  const provider = new LmStudioProvider({
    fetchImpl: scriptedFetch([
      jsonResponse(unloadedCatalog),
      jsonResponse(unloadedCatalog),
      jsonResponse({
        type: "llm",
        instance_id: "owned-instance",
        status: "loaded",
        load_time_seconds: 1,
        load_config: loadedInstance().config,
      }),
      jsonResponse(loadedCatalog),
      jsonResponse(loadedCatalog),
      jsonResponse({ instance_id: "owned-instance" }),
      jsonResponse(unloadedCatalog),
    ], requests),
    environment: {},
  });
  const [model] = await provider.scan("ignored");
  const instance = await provider.load(model, {
    contextLength: 16_384,
    gpuLayers: 0,
    evalBatchSize: 512,
    flashAttention: true,
    numExperts: 4,
    kvCachePlacement: "cpu",
  });

  assert.equal(instance.instanceId, "owned-instance");
  assert.equal(instance.ownedByWorkbench, true);
  assert.equal(provider.has(model.id), true);
  const loadRequest = requests.find((request) => request.url.endsWith("/api/v1/models/load"));
  assert.deepEqual(JSON.parse(loadRequest.init.body), {
    model: "fixture/model@q4_k_m",
    echo_load_config: true,
    context_length: 16_384,
    eval_batch_size: 512,
    flash_attention: true,
    num_experts: 4,
    offload_kv_cache_to_gpu: false,
  });

  await provider.unload(model.id);
  const unloadRequest = requests.find((request) => request.url.endsWith("/api/v1/models/unload"));
  assert.deepEqual(JSON.parse(unloadRequest.init.body), { instance_id: "owned-instance" });
  assert.equal(provider.has(model.id), false);
});

test("cleans up the exact owned instance when post-load catalogue reconciliation fails", async () => {
  const requests = [];
  const unloadedCatalog = { models: [nativeModel()] };
  const provider = new LmStudioProvider({
    fetchImpl: scriptedFetch([
      jsonResponse(unloadedCatalog),
      jsonResponse(unloadedCatalog),
      jsonResponse({
        type: "llm",
        instance_id: "orphan-candidate",
        status: "loaded",
        load_config: loadedInstance().config,
      }),
      jsonResponse({ models: "invalid" }),
      jsonResponse({ instance_id: "orphan-candidate" }),
    ], requests),
    environment: {},
  });
  const [model] = await provider.scan("ignored");

  await assert.rejects(provider.load(model, { contextLength: 16_384 }), /at most 10000 models/);
  const unloadRequest = requests.find((request) => request.url.endsWith("/api/v1/models/unload"));
  assert.deepEqual(JSON.parse(unloadRequest.init.body), { instance_id: "orphan-candidate" });
  assert.equal(provider.has(model.id), false, "a failed load verification must clear the local ownership binding");
});

test("preserves the verification failure and surfaces an exact-instance cleanup failure", async () => {
  const unloadedCatalog = { models: [nativeModel()] };
  const provider = new LmStudioProvider({
    fetchImpl: scriptedFetch([
      jsonResponse(unloadedCatalog),
      jsonResponse(unloadedCatalog),
      jsonResponse({
        type: "llm",
        instance_id: "orphan-candidate",
        status: "loaded",
        load_config: loadedInstance().config,
      }),
      jsonResponse({ models: "invalid" }),
      jsonResponse({ instance_id: "different-instance" }),
    ]),
    environment: {},
  });
  const [model] = await provider.scan("ignored");

  await assert.rejects(provider.load(model, {}), (error) => {
    assert.equal(error instanceof AggregateError, true);
    assert.equal(error.errors.length, 2);
    assert.match(error.errors[0].message, /at most 10000 models/);
    assert.match(error.errors[1].message, /exact Workbench-owned instance/);
    assert.match(error.message, /load verification failed.*also failed/i);
    return true;
  });
  assert.equal(provider.has(model.id), false);
});

test("cleans up an owned instance when the caller aborts post-load reconciliation", async () => {
  const requests = [];
  const controller = new AbortController();
  const unloadedCatalog = { models: [nativeModel()] };
  const abortDuringReconciliation = (_url, init) => new Promise((_resolve, reject) => {
    const rejectAbort = () => reject(new DOMException("fixture abort", "AbortError"));
    if (init.signal.aborted) rejectAbort();
    else init.signal.addEventListener("abort", rejectAbort, { once: true });
    queueMicrotask(() => controller.abort());
  });
  const provider = new LmStudioProvider({
    fetchImpl: scriptedFetch([
      jsonResponse(unloadedCatalog),
      jsonResponse(unloadedCatalog),
      jsonResponse({
        type: "llm",
        instance_id: "aborted-owned-instance",
        status: "loaded",
        load_config: loadedInstance().config,
      }),
      abortDuringReconciliation,
      jsonResponse({ instance_id: "aborted-owned-instance" }),
    ], requests),
    environment: {},
  });
  const [model] = await provider.scan("ignored");

  await assert.rejects(provider.load(model, {}, controller.signal), { name: "AbortError" });
  const unloadRequest = requests.find((request) => request.url.endsWith("/api/v1/models/unload"));
  assert.deepEqual(JSON.parse(unloadRequest.init.body), { instance_id: "aborted-owned-instance" });
  assert.equal(provider.has(model.id), false);
});

test("explicitly adopts but never unloads an externally owned LM Studio instance", async () => {
  const requests = [];
  const catalog = { models: [nativeModel({ loaded_instances: [loadedInstance("external-instance")] })] };
  const provider = new LmStudioProvider({
    fetchImpl: scriptedFetch([jsonResponse(catalog), jsonResponse(catalog), jsonResponse(catalog)], requests),
    environment: {},
  });
  const [model] = await provider.scan("ignored");
  const instance = await provider.load(model, { contextLength: 16_384, gpuLayers: 0 });
  assert.equal(instance.instanceId, "external-instance");
  assert.equal(instance.ownedByWorkbench, false);

  await provider.unload(model.id);
  assert.equal(requests.some((request) => request.init.method === "POST"), false);
  assert.equal(provider.has(model.id), false);
});

test("requires an exact selection when multiple external instances are loaded", async () => {
  const requests = [];
  const catalog = {
    models: [nativeModel({ loaded_instances: [loadedInstance("instance-a"), loadedInstance("instance-b")] })],
  };
  const provider = new LmStudioProvider({
    fetchImpl: scriptedFetch([jsonResponse(catalog), jsonResponse(catalog), jsonResponse(catalog)], requests),
    environment: {},
  });
  const [model] = await provider.scan("ignored");
  await assert.rejects(
    provider.load(model, { contextLength: 16_384, gpuLayers: 0 }),
    /Select an exact instance/i,
  );
  const selected = await provider.load(model, {
    instanceId: "instance-b",
    contextLength: 16_384,
    gpuLayers: 0,
  });
  assert.equal(selected.instanceId, "instance-b");
  assert.equal(selected.ownedByWorkbench, false);
  assert.equal(requests.some((request) => request.init.method === "POST"), false);
});

test("refuses implicit JIT chat even when discovery sees an external loaded instance", async () => {
  const requests = [];
  const catalog = { models: [nativeModel({ loaded_instances: [loadedInstance("external-instance")] })] };
  const provider = new LmStudioProvider({
    fetchImpl: scriptedFetch([jsonResponse(catalog), jsonResponse(catalog)], requests),
    environment: {},
  });
  const [model] = await provider.scan("ignored");
  await assert.rejects(
    provider.chat(model.id, { messages: [] }, () => undefined),
    /explicitly connected and loaded/,
  );
  assert.equal(requests.some((request) => request.url.endsWith("/v1/chat/completions")), false);
});

test("resynchronizes before chat and parses fragmented OpenAI-compatible SSE", async () => {
  const requests = [];
  const catalog = { models: [nativeModel({ loaded_instances: [loadedInstance("external-instance")] })] };
  const provider = new LmStudioProvider({
    fetchImpl: scriptedFetch([
      jsonResponse(catalog),
      jsonResponse(catalog),
      jsonResponse(catalog),
      sseResponse([
        "data: {\"choices\":[{\"delta\":{\"content\":\"hel",
        "lo\",\"reasoning_content\":\"r\"}}]}\n\n",
        "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call-1\",\"type\":\"function\",\"function\":{\"name\":\"proto_check\",\"arguments\":\"{}\"}}]}}]}\n\n",
        "data: [DONE]\n\n",
      ]),
    ], requests),
    environment: {},
  });
  const [model] = await provider.scan("ignored");
  await provider.load(model, { contextLength: 16_384, gpuLayers: 0 });
  const chunks = [];
  await provider.chat(
    model.id,
    { model: "attacker-controlled", stream: false, messages: [{ role: "user", content: "fixture" }] },
    (chunk) => chunks.push(chunk),
  );

  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].choices[0].delta.content, "hello");
  assert.equal(chunks[1].choices[0].delta.tool_calls[0].function.name, "proto_check");
  const chatRequest = requests.find((request) => request.url.endsWith("/v1/chat/completions"));
  assert.deepEqual(JSON.parse(chatRequest.init.body), {
    model: "external-instance",
    stream: true,
    messages: [{ role: "user", content: "fixture" }],
  });
});

test("fails closed when an LM Studio SSE response ends without the required terminator", async () => {
  const catalog = { models: [nativeModel({ loaded_instances: [loadedInstance("external-instance")] })] };
  const provider = new LmStudioProvider({
    fetchImpl: scriptedFetch([
      jsonResponse(catalog),
      jsonResponse(catalog),
      jsonResponse(catalog),
      sseResponse([
        "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n",
      ]),
    ]),
    environment: {},
  });
  const [model] = await provider.scan("ignored");
  await provider.load(model, { contextLength: 16_384, gpuLayers: 0 });
  const chunks = [];

  await assert.rejects(
    provider.chat(model.id, { messages: [{ role: "user", content: "fixture" }] }, (chunk) => chunks.push(chunk)),
    /required \[DONE\] terminator/,
  );
  assert.equal(chunks.length, 1, "partial data may be displayed but must never complete the run successfully");
});

test("enforces one total deadline across the complete SSE stream and cancels an endless reader", async () => {
  const catalog = { models: [nativeModel({ loaded_instances: [loadedInstance("external-instance")] })] };
  const endless = endlessSseResponse(
    "data: {\"choices\":[{\"delta\":{\"content\":\"x\"}}]}\n\n",
    2,
  );
  const provider = new LmStudioProvider({
    fetchImpl: scriptedFetch([
      jsonResponse(catalog),
      jsonResponse(catalog),
      jsonResponse(catalog),
      endless.response,
    ]),
    environment: {},
    chatDeadlineMs: 30,
  });
  const [model] = await provider.scan("ignored");
  await provider.load(model, { contextLength: 16_384 });

  await assert.rejects(
    provider.chat(model.id, { messages: [] }, () => undefined),
    /30-millisecond total deadline/,
  );
  assert.equal(endless.wasCancelled(), true);
});

test("bounds aggregate SSE bytes even when every individual frame is valid", async () => {
  const catalog = { models: [nativeModel({ loaded_instances: [loadedInstance("external-instance")] })] };
  const frame = "data: {\"choices\":[{\"delta\":{\"content\":\"bounded\"}}]}\n\n";
  const provider = new LmStudioProvider({
    fetchImpl: scriptedFetch([
      jsonResponse(catalog),
      jsonResponse(catalog),
      jsonResponse(catalog),
      sseResponse([frame, frame, "data: [DONE]\n\n"]),
    ]),
    environment: {},
    maxSseStreamBytes: new TextEncoder().encode(frame).byteLength + 1,
  });
  const [model] = await provider.scan("ignored");
  await provider.load(model, {});

  await assert.rejects(provider.chat(model.id, { messages: [] }, () => undefined), /byte safety limit/);
});

test("bounds valid small SSE chunks so an endless frame sequence cannot run forever", async () => {
  const catalog = { models: [nativeModel({ loaded_instances: [loadedInstance("external-instance")] })] };
  const frame = "data: {\"choices\":[{\"delta\":{\"content\":\"x\"}}]}\n\n";
  const chunks = [];
  const provider = new LmStudioProvider({
    fetchImpl: scriptedFetch([
      jsonResponse(catalog),
      jsonResponse(catalog),
      jsonResponse(catalog),
      sseResponse([frame, frame, frame, "data: [DONE]\n\n"]),
    ]),
    environment: {},
    maxSseChunks: 2,
  });
  const [model] = await provider.scan("ignored");
  await provider.load(model, {});

  await assert.rejects(
    provider.chat(model.id, { messages: [] }, (chunk) => chunks.push(chunk)),
    /2-chunk safety limit/,
  );
  assert.equal(chunks.length, 2);
});

test("drops a stale binding during the mandatory pre-chat synchronization", async () => {
  const requests = [];
  const loadedCatalog = { models: [nativeModel({ loaded_instances: [loadedInstance("gone-instance")] })] };
  const unloadedCatalog = { models: [nativeModel()] };
  const provider = new LmStudioProvider({
    fetchImpl: scriptedFetch([
      jsonResponse(loadedCatalog),
      jsonResponse(loadedCatalog),
      jsonResponse(unloadedCatalog),
    ], requests),
    environment: {},
  });
  const [model] = await provider.scan("ignored");
  await provider.load(model, { contextLength: 16_384, gpuLayers: 0 });
  await assert.rejects(provider.chat(model.id, { messages: [] }, () => undefined), /not explicitly connected/);
  assert.equal(requests.some((request) => request.url.endsWith("/v1/chat/completions")), false);
});

test("rejects oversized catalogs and duplicate model keys", async () => {
  const oversized = "x".repeat(4 * 1024 * 1024 + 1);
  const oversizedProvider = new LmStudioProvider({
    fetchImpl: scriptedFetch([new Response(oversized, { status: 200 })]),
    environment: {},
  });
  await assert.rejects(oversizedProvider.scan("ignored"), /safety limit/);

  const duplicateProvider = new LmStudioProvider({
    fetchImpl: scriptedFetch([jsonResponse({ models: [nativeModel(), nativeModel()] })]),
    environment: {},
  });
  await assert.rejects(duplicateProvider.scan("ignored"), /duplicate key/);
});
