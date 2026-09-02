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
    console.error(JSON.stringify({ ok: false, code: "MODEL_POOL_VERIFICATION_FAILED", message: "Verification failed; sensitive details were suppressed." }));
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
    message: "Model-pool verification requires matching environment and final command-line confirmations.",
    requiredEnvironment: `PROTO_AGENT_ALLOW_REAL_MODEL_TESTS=${REAL_MODEL_CONFIRMATION}`,
    requiredArgument: REAL_MODEL_CONFIRMATION_FLAG,
  }));
  process.exit(2);
}
const args = invocationArgs.slice(0, -1);

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (!args[0] || !args[1]) {
  console.error(JSON.stringify({
    ok: false,
    code: "EXPLICIT_ROOTS_REQUIRED",
    message: "Pass explicit model and marked disposable workspace roots; implicit profile scans and source writes are forbidden.",
    usage: `verify-model-pool.mjs <model-root> <disposable-workspace-root> [runtime-path] [runtime-project-root] ${REAL_MODEL_CONFIRMATION_FLAG}`,
  }));
  process.exit(2);
}
const modelRoot = requireAbsoluteArgument(args[0], "model root");
const repoRoot = resolve(appRoot, "..", "..");
const workspaceRoot = await assertDisposableWorkspace(args[1], [appRoot, repoRoot]);
await ensureDisposableBuildRoot(workspaceRoot);
await revalidateDisposableWorkspace(workspaceRoot);
const { AppDatabase } = await import("../src/main/services/database.ts");
const { LlamaServerManager } = await import("../src/main/services/llama-server.ts");
const { ModelService } = await import("../src/main/services/model-service.ts");
const { trustRuntimeExecutable } = await import("../src/main/services/path-security.ts");
const { GIB } = await import("../src/main/services/residency.ts");
const runtimePath = args[2] ? requireAbsoluteArgument(args[2], "runtime path") : join(appRoot, "runtime", "llama.cpp", "cuda", "llama-server.exe");
const runtimeTrust = await trustRuntimeExecutable(runtimePath);
const runtimeProjectRoot = args[3] ? requireAbsoluteArgument(args[3], "runtime project root") : appRoot;
const scannerPath = join(
  appRoot,
  "runtime",
  "proto-agent",
  "proto-workbench-sidecar",
  "proto-workbench-sidecar.exe",
);
const catalog = await runJsonOwned(
  scannerPath,
  [
    "scan-models",
    modelRoot,
    "--cache",
    join(workspaceRoot, "build", "model-pool-verification-catalog.json"),
  ],
  {
    cwd: workspaceRoot,
    timeoutMs: 120_000,
    maxStdoutBytes: 4 * 1024 * 1024,
    maxStderrBytes: 128 * 1024,
  },
);
if (!Array.isArray(catalog.models) || catalog.models.length > 10_000) {
  throw new Error("Model catalog did not return a bounded model array.");
}
const selected = [...catalog.models].sort((left, right) => left.sizeBytes - right.sizeBytes)[0];
if (!selected) throw new Error("No GGUF model is available for pool verification.");

const database = new AppDatabase(":memory:");
database.saveModels([selected]);
const runtime = new LlamaServerManager({
  packaged: false,
  resourcesPath: appRoot,
  projectRoot: runtimeProjectRoot,
  overrideTrust: runtimeTrust,
});
const service = new ModelService(database, { scan: async () => [selected] }, runtime);

try {
  await service.setPolicy({
    mode: "auto-evict",
    budgetBytes: 2 * GIB,
    warmTtlMinutes: 30,
    pinnedModelIds: [],
  });
  const instance = await service.load(selected.id, {
    contextLength: 2_048,
    gpuLayers: (selected.blockCount ?? 998) + 1,
    cacheType: "f16",
  });
  console.log(JSON.stringify({
    ok: true,
    modelSelected: true,
    poolBudgetBytes: 2 * GIB,
    estimatedVramBytes: instance.estimatedVramBytes,
    measuredVramBytes: service.get(selected.id)?.measuredVramBytes,
    state: instance.state,
  }));
} finally {
  await service.shutdown();
  database.close();
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
