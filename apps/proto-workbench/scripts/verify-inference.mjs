import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertDisposableWorkspace,
  ensureDisposableBuildRoot,
  revalidateDisposableWorkspace,
  runJsonOwned,
} from "./owned-process.mjs";

const REAL_MODEL_CONFIRMATION = "YES_START_OWNED_MODEL_PROCESSES";
const REAL_MODEL_CONFIRMATION_FLAG = `--confirm-owned-execution=${REAL_MODEL_CONFIRMATION}`;

if (isMainModule()) await runMain();

async function runMain() {
  try {
    await main();
  } catch {
    console.error(JSON.stringify({ ok: false, code: "INFERENCE_VERIFICATION_FAILED", message: "Verification failed; sensitive details were suppressed." }));
    process.exitCode = 1;
  }
}

export async function main() {
const invocationArgs = process.argv.slice(2);
if (
  process.env.PROTO_AGENT_ALLOW_REAL_MODEL_TESTS !== REAL_MODEL_CONFIRMATION ||
  invocationArgs.at(-1) !== REAL_MODEL_CONFIRMATION_FLAG ||
  invocationArgs.filter((value) => value === REAL_MODEL_CONFIRMATION_FLAG).length !== 1
) {
  console.error(JSON.stringify({
    ok: false,
    code: "REAL_MODEL_TEST_DISABLED",
    message: "Real-model verification requires matching environment and final command-line confirmations.",
    requiredEnvironment: `PROTO_AGENT_ALLOW_REAL_MODEL_TESTS=${REAL_MODEL_CONFIRMATION}`,
    requiredArgument: REAL_MODEL_CONFIRMATION_FLAG,
  }));
  process.exit(2);
}
const args = invocationArgs.slice(0, -1);

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const flavor = args[0] || "cpu";
if (flavor !== "cpu" && flavor !== "cuda") throw new Error("Runtime flavor must be cpu or cuda.");
if (!args[1] || !args[2]) {
  console.error(JSON.stringify({
    ok: false,
    code: "EXPLICIT_ROOTS_REQUIRED",
    message: "Pass explicit model and marked disposable workspace roots; implicit profile scans and source writes are forbidden.",
    usage: `verify-inference.mjs <cpu|cuda> <model-root> <disposable-workspace-root> ${REAL_MODEL_CONFIRMATION_FLAG}`,
  }));
  process.exit(2);
}
const modelRoot = requireAbsoluteArgument(args[1], "model root");
const repoRoot = resolve(appRoot, "..", "..");
const workspaceRoot = await assertDisposableWorkspace(args[2], [appRoot, repoRoot]);
await ensureDisposableBuildRoot(workspaceRoot);
await revalidateDisposableWorkspace(workspaceRoot);
const { LlamaServerManager } = await import("../src/main/services/llama-server.ts");
const { trustRuntimeExecutable } = await import("../src/main/services/path-security.ts");
const { estimateModelVram } = await import("../src/main/services/vram-estimator.ts");
const scannerPath = join(
  appRoot,
  "runtime",
  "proto-agent",
  "proto-workbench-sidecar",
  "proto-workbench-sidecar.exe",
);
const cachePath = join(workspaceRoot, "build", "inference-verification-catalog.json");
const catalog = await runJsonOwned(
  scannerPath,
  ["scan-models", modelRoot, "--cache", cachePath],
  {
    cwd: workspaceRoot,
    timeoutMs: 120_000,
    maxStdoutBytes: 4 * 1024 * 1024,
    maxStderrBytes: 128 * 1024,
  },
);
const models = Array.isArray(catalog.models) ? catalog.models : [];
if (!models.length) throw new Error("No GGUF model is available for inference verification.");
const selected = [...models].sort((left, right) => left.sizeBytes - right.sizeBytes)[0];
const textModel = selected;
const runtimePath = join(appRoot, "runtime", "llama.cpp", flavor, "llama-server.exe");
const runtimeTrust = await trustRuntimeExecutable(runtimePath);
const runtime = new LlamaServerManager({
  packaged: false,
  resourcesPath: appRoot,
  projectRoot: appRoot,
  overrideTrust: runtimeTrust,
});
const runtimeStatus = await runtime.runtimeStatus();
if (runtimeStatus.backend !== flavor) {
  throw new Error(`Requested ${flavor} runtime resolved to ${runtimeStatus.backend || "unavailable"}: ${runtimeStatus.detail}`);
}

const loadStartedAt = performance.now();
try {
  await runtime.load(textModel, {
    contextLength: 2_048,
    gpuLayers: flavor === "cuda" ? 999 : 0,
  });
  const estimatedVramBytes = flavor === "cuda"
    ? estimateModelVram(textModel, { contextLength: 2_048, gpuLayers: textModel.blockCount ? textModel.blockCount + 1 : 999, cacheType: "f16" }).totalBytes
    : 0;
  const measuredVramBytes = runtime.gpuAllocationBytes(textModel.id) ?? 0;
  const loadMilliseconds = Math.round(performance.now() - loadStartedAt);
  const chunks = [];
  const reasoningChunks = [];
  let streamedBytes = 0;
  const chatController = new AbortController();
  const chatDeadline = setTimeout(() => chatController.abort(), 60_000);
  const completionStartedAt = performance.now();
  try {
    await runtime.chat(
      textModel.id,
      {
        model: textModel.name,
        messages: [{ role: "user", content: "Reply with the single word READY." }],
        temperature: 0,
        max_tokens: 128,
      },
      (chunk) => {
        const delta = chunk.choices?.[0]?.delta;
        const contentPart = typeof delta?.content === "string" ? delta.content : "";
        const reasoningPart = typeof delta?.reasoning_content === "string"
          ? delta.reasoning_content
          : typeof delta?.reasoning === "string" ? delta.reasoning : "";
        streamedBytes += Buffer.byteLength(contentPart, "utf8") + Buffer.byteLength(reasoningPart, "utf8");
        if (streamedBytes > 16 * 1024) {
          chatController.abort();
          throw new Error("Model stream exceeded the verification output limit.");
        }
        chunks.push(contentPart);
        reasoningChunks.push(reasoningPart);
      },
      chatController.signal,
    );
  } finally {
    clearTimeout(chatDeadline);
  }
  const content = chunks.join("").trim();
  const reasoning = reasoningChunks.join("").trim();
  if (!content && !reasoning) throw new Error("The model returned an empty streamed completion.");
  console.log(JSON.stringify({
    ok: true,
    flavor,
    modelSelected: true,
    contextLength: 2_048,
    loadMilliseconds,
    completionMilliseconds: Math.round(performance.now() - completionStartedAt),
    estimatedVramBytes,
    measuredVramBytes,
    streamKind: content ? "content" : "reasoning",
    streamedBytes,
  }));
} finally {
  await runtime.unloadAll();
}
}

function isMainModule() {
  return Boolean(process.argv[1]) && samePath(fileURLToPath(import.meta.url), process.argv[1]);
}

function samePath(left, right) {
  const normalize = (value) => process.platform === "win32" ? resolve(value).toLowerCase() : resolve(value);
  return normalize(left) === normalize(right);
}

function requireAbsoluteArgument(value, label) {
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0") || /[\r\n]/.test(value)) {
    throw new Error(`${label} must be an absolute path.`);
  }
  return resolve(value);
}
