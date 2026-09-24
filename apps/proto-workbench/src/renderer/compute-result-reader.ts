import type { ComputeRun } from "../shared/compute.ts";
import { sha256Text } from "./sha256.ts";
import { computeResultByteLimit } from "../shared/compute-limits.ts";

/** Reopen the authoritative bytes, including results omitted from MCP previews. */
export async function readVerifiedComputeResult(receipt: ComputeRun,
  read: (path: string) => Promise<{content: string; sha256: string}>,
  expectedTool?: string,
): Promise<Record<string, unknown>> {
  if (receipt.ok !== true) throw new Error("Only completed computations have readable results.");
  if (expectedTool !== undefined && receipt.tool !== expectedTool) throw new Error("The computation receipt does not match the requested tool.");
  if (receipt.preview === true) {
    if (!receipt.result || typeof receipt.result !== "object" || Array.isArray(receipt.result)) throw new Error("The recorded example has no result object.");
    if (receipt.run_id !== undefined || receipt.result_sha256 !== undefined) throw new Error("A recorded example cannot also claim a live execution identity.");
    return receipt.result;
  }
  if (!/^[a-f0-9]{32}$/.test(receipt.run_id ?? "") || !/^[a-f0-9]{64}$/.test(receipt.result_sha256 ?? "")) {
    throw new Error("The computation receipt is missing a result identity.");
  }
  const file = await read(`build/compute/${receipt.run_id}/result.json`);
  if (typeof file.content !== "string" || new TextEncoder().encode(file.content).byteLength > computeResultByteLimit(receipt.tool)
    || sha256Text(file.content) !== receipt.result_sha256 || file.sha256 !== receipt.result_sha256) {
    throw new Error("Saved computation bytes no longer match their execution receipt.");
  }
  const result: unknown = JSON.parse(file.content);
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Saved computation must be a result object.");
  return result as Record<string, unknown>;
}
