import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  LmStudioProvider,
  LM_STUDIO_BASE_URL,
} from "../src/main/services/lm-studio-provider.ts";

const REAL_MODEL_CONFIRMATION = "YES_LOAD_CHAT_UNLOAD_LM_STUDIO";
const REAL_MODEL_CONFIRMATION_FLAG = `--confirm-owned-execution=${REAL_MODEL_CONFIRMATION}`;
const MAX_MODEL_BYTES = 8 * 1024 ** 3;
const MAX_STREAM_BYTES = 4 * 1024;
const MAX_STREAM_CHUNKS = 2_048;
const CHAT_TIMEOUT_MS = 120_000;

if (isMainModule()) await runMain();

async function runMain() {
  try {
    await main();
  } catch {
    console.error(JSON.stringify({
      ok: false,
      code: "INFERENCE_VERIFICATION_FAILED",
      message: "LM Studio verification failed; model output and sensitive details were suppressed.",
    }));
    process.exitCode = 1;
  }
}

export async function main() {
  const invocationArgs = process.argv.slice(2);
  if (
    process.env.PROTO_AGENT_ALLOW_REAL_MODEL_TESTS !== REAL_MODEL_CONFIRMATION
    || invocationArgs.at(-1) !== REAL_MODEL_CONFIRMATION_FLAG
    || invocationArgs.filter((value) => value === REAL_MODEL_CONFIRMATION_FLAG).length !== 1
  ) {
    console.error(JSON.stringify({
      ok: false,
      code: "REAL_MODEL_TEST_DISABLED",
      message: "LM Studio load/chat/unload verification requires matching environment and final command-line confirmations.",
      requiredEnvironment: `PROTO_AGENT_ALLOW_REAL_MODEL_TESTS=${REAL_MODEL_CONFIRMATION}`,
      requiredArgument: REAL_MODEL_CONFIRMATION_FLAG,
    }));
    process.exit(2);
  }

  const args = invocationArgs.slice(0, -1);
  if (args.length !== 1) {
    console.error(JSON.stringify({
      ok: false,
      code: "EXPLICIT_MODEL_REQUIRED",
      message: "Pass exactly one explicit LM Studio model key. Automatic model selection is forbidden.",
      usage: `verify-inference.mjs <exact-lm-studio-model-key> ${REAL_MODEL_CONFIRMATION_FLAG}`,
      endpoint: LM_STUDIO_BASE_URL,
      maximumModelBytes: MAX_MODEL_BYTES,
    }));
    process.exit(2);
  }
  const modelKey = requireModelKey(args[0]);

  const provider = new LmStudioProvider();
  const discovered = await provider.scan(LM_STUDIO_BASE_URL);
  const selected = discovered.find((model) => model.providerModelId === modelKey);
  if (!selected) throw new Error("The explicit model key was not found in the LM Studio native catalog.");
  if (selected.modelKind !== "llm") throw new Error("The explicit model key is not a chat model.");
  if (selected.sizeBytes > MAX_MODEL_BYTES) {
    throw new Error("The explicit model exceeds the verification model-size safety limit.");
  }
  if (selected.loadedInstances?.length) {
    throw new Error("The explicit model already has a loaded instance; verification will not claim or unload it.");
  }
  if (selected.contextLength < 256) throw new Error("The explicit model has no supported bounded chat context.");

  const contextLength = Math.min(2_048, selected.contextLength);
  const loadStartedAt = performance.now();
  let instanceId;
  let owned = false;
  let loadMilliseconds = 0;
  let completionMilliseconds = 0;
  let streamedBytes = 0;
  let streamedChunks = 0;
  let outputDigest;
  try {
    const instance = await provider.load(selected, {
      contextLength,
      evalBatchSize: 128,
      flashAttention: true,
      kvCachePlacement: "cpu",
    });
    instanceId = instance.instanceId;
    owned = instance.ownedByWorkbench === true;
    loadMilliseconds = Math.round(performance.now() - loadStartedAt);
    if (!instanceId || !owned) {
      throw new Error("Verification did not create a uniquely Workbench-owned LM Studio instance.");
    }

    const completionStartedAt = performance.now();
    const content = [];
    const reasoning = [];
    const chatController = new AbortController();
    const chatDeadline = setTimeout(() => chatController.abort(), CHAT_TIMEOUT_MS);
    try {
      await provider.chat(
        selected.id,
        {
          messages: [{ role: "user", content: "Reply with exactly the single word READY." }],
          temperature: 0,
          max_tokens: 16,
        },
        (chunk) => {
          streamedChunks += 1;
          const delta = chunk.choices?.[0]?.delta;
          const contentPart = typeof delta?.content === "string" ? delta.content : "";
          const reasoningPart = typeof delta?.reasoning_content === "string"
            ? delta.reasoning_content
            : typeof delta?.reasoning === "string" ? delta.reasoning : "";
          streamedBytes += Buffer.byteLength(contentPart, "utf8") + Buffer.byteLength(reasoningPart, "utf8");
          if (streamedBytes > MAX_STREAM_BYTES || streamedChunks > MAX_STREAM_CHUNKS) {
            chatController.abort();
            throw new Error("LM Studio stream exceeded the verification output limit.");
          }
          content.push(contentPart);
          reasoning.push(reasoningPart);
        },
        chatController.signal,
      );
    } finally {
      clearTimeout(chatDeadline);
    }
    completionMilliseconds = Math.round(performance.now() - completionStartedAt);
    const output = `${content.join("")}\n${reasoning.join("")}`.trim();
    if (!output) throw new Error("LM Studio returned an empty streamed completion.");
    outputDigest = createHash("sha256").update(output).digest("hex");
  } finally {
    // The provider sends /unload only when this exact instance was created by
    // this Workbench process. An external instance is disconnected locally.
    await provider.unload(selected.id);
  }

  const refreshed = await provider.scan(LM_STUDIO_BASE_URL);
  const lingering = refreshed
    .find((model) => model.id === selected.id)
    ?.loadedInstances?.some((instance) => instance.id === instanceId);
  if (lingering) throw new Error("The Workbench-owned LM Studio instance remained loaded after verification.");

  console.log(JSON.stringify({
    ok: true,
    provider: "lmstudio",
    endpoint: LM_STUDIO_BASE_URL,
    modelKey,
    modelFingerprint: selected.fingerprint,
    modelFingerprintSource: selected.fingerprintSource,
    modelSizeBytes: selected.sizeBytes,
    contextLength,
    ownedInstanceCreated: owned,
    ownedInstanceUnloaded: true,
    loadMilliseconds,
    completionMilliseconds,
    streamedBytes,
    streamedChunks,
    outputSha256: outputDigest,
  }));
}

function requireModelKey(value) {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 1_024
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error("The LM Studio model key must be a bounded single-line identifier.");
  }
  return value;
}

function isMainModule() {
  return Boolean(process.argv[1]) && samePath(fileURLToPath(import.meta.url), process.argv[1]);
}

function samePath(left, right) {
  const normalize = (value) => process.platform === "win32" ? resolve(value).toLowerCase() : resolve(value);
  return normalize(left) === normalize(right);
}
