import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RETIRED_CODE = "LEGACY_MODEL_VERIFIER_RETIRED";
const REPLACEMENT = Object.freeze({
  script: "verify-inference.mjs",
  environment: "PROTO_AGENT_ALLOW_REAL_MODEL_TESTS=YES_LOAD_CHAT_UNLOAD_LM_STUDIO",
  confirmation: "--confirm-owned-execution=YES_LOAD_CHAT_UNLOAD_LM_STUDIO",
  usage: "pnpm verify:inference -- <exact-lm-studio-model-key> --confirm-owned-execution=YES_LOAD_CHAT_UNLOAD_LM_STUDIO",
});

if (isMainModule()) await runMain();

async function runMain() {
  console.error(JSON.stringify(await main()));
  process.exitCode = 2;
}

/**
 * Permanently fail closed. End-to-end model execution must start from the live
 * LM Studio catalog and its explicit load/chat/owned-unload lifecycle; the
 * former independent-runtime workflow is not a product or release entry point.
 */
export async function main() {
  return {
    ok: false,
    code: RETIRED_CODE,
    message: "This legacy verifier is retired. Use the fixed LM Studio load/chat/owned-unload verifier with one exact catalog key.",
    replacement: REPLACEMENT,
  };
}

function isMainModule() {
  if (!process.argv[1]) return false;
  const normalize = (value) => process.platform === "win32" ? resolve(value).toLowerCase() : resolve(value);
  return normalize(fileURLToPath(import.meta.url)) === normalize(process.argv[1]);
}
