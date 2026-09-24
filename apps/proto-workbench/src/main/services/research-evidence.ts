import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { ResearchActivity, ResearchEvidence, ResearchFact, ResearchUnlocatableValue } from "../../shared/research-chat.ts";
import { resolveToolContract } from "../../shared/tool-contracts.ts";

const MAX_RECEIPT_BYTES = 1024 * 1024;
const MAX_FACTS = 128;
const SHA256 = /^[a-f0-9]{64}$/;
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const numeric = z.number().finite();
const identity = z.string().min(1).max(200).refine(value => !/[\x00-\x1f\x7f]/.test(value));
const sourcePath = z.string().min(1).max(4096).refine(value => !/[\x00-\x1f\x7f]/.test(value));
const jsonPointer = z.string().max(2048).refine(value => (!value || value.startsWith("/")) && !/~(?![01])/.test(value));
const capabilityId = (activity:ResearchActivity) => resolveToolContract(String(activity.input.name))?.capabilityId;

export function unreviewedResearchEvidence(reason: string): ResearchEvidence {
  return {schema: "proto-workbench.research-evidence.v1", status: "unreviewed",
    scope: "saved-tool-receipt-fields-only", interpretation: "unreviewed", facts: [], diagnostics: [reason]};
}

export function isResearchFactCandidate(activity: ResearchActivity): boolean {
  return activity.tool === "science_run" && ["chemistry.calculate_acid_base_speciation","compute.run","compute.value.read"].includes(capabilityId(activity)??"");
}

const acidInput = z.object({pka_values: z.array(numeric).min(1).max(12), ph_values: z.array(numeric).min(1).max(MAX_FACTS), fully_protonated_charge: z.number().int().default(0)});
const acidReceipt = z.object({ok: z.literal(true), data: z.object({
  operator: z.literal("calculate_acid_base_speciation"), status: z.literal("completed"), runId: identity,
  input: acidInput,
  result: z.object({rows: z.array(z.record(z.string(), numeric)).min(1).max(MAX_FACTS),
    species: z.array(z.object({id: identity, protons_lost: z.number().int(), formal_charge: z.number().int()})).min(2).max(13),
    visualization: z.object({y_unit: z.literal("dimensionless")})}),
})});
const qpcrReceipt = z.object({ok: z.literal(true), tool: z.literal("analyze_qpcr_relative_expression"), run_id: identity,
  source: z.object({path: sourcePath, sha256: z.string().regex(SHA256)}),
  result: z.object({control_group: identity, rows: z.array(z.object({id: identity, group: identity, relative_expression: numeric.nonnegative()})).min(1).max(MAX_FACTS)})});
const valueReadInput = z.object({path: sourcePath, pointer: jsonPointer, expected_result_sha256: z.string().regex(SHA256), expected_manifest_sha256: z.string().regex(SHA256)}).strict();
const valueReadReceipt = z.object({
  ok: z.literal(true), schema_version: z.literal("proto.compute-value-evidence.v1"),
  result_path: sourcePath, result_sha256: z.string().regex(SHA256), manifest_sha256: z.string().regex(SHA256),
  pointer: jsonPointer, json_type: z.enum(["integer", "number", "null"]),
  value: z.union([numeric, z.string().regex(/^-?(?:0|[1-9][0-9]*)$/), z.null()]),
  value_text: z.string().nullable(), value_encoding: z.enum(["json-number", "decimal-string", "json-null"]),
  value_sha256: z.string().regex(SHA256),
  quantity: z.object({schema_version: z.literal("proto-agent.quantity.v1"), unit: identity, quantity_kind: identity,
    entity_id: identity, dataset_id: identity, contract_validated: z.literal(true), missing_reason: z.string().max(500).optional()}).strict().nullable(),
  result_index_status: z.enum(["complete", "partial"]), scientific_validation: z.literal("not-established"),
  review_status: z.literal("human_review_required"),
  source_role: z.literal("saved-computation-output; integrity-bound, not an independent scientific validation"),
});

/** Literal projections from two explicit operator contracts; no prose parsing,
 * biological identity inference, unit guessing, or citation entailment. */
export function extractResearchFacts(activity: ResearchActivity, payload: unknown): ResearchFact[] {
  if (!isResearchFactCandidate(activity) || activity.status !== "complete" || !activity.artifactPath || !SHA256.test(activity.artifactSha256 ?? "")) return [];
  const common = {activityId: activity.id, artifactPath: activity.artifactPath, artifactSha256: activity.artifactSha256!};
  const fact = (value: Omit<ResearchFact, keyof typeof common | "id">): ResearchFact => ({...common, ...value,
    id: hash(JSON.stringify([common.activityId, common.artifactSha256, value.valuePointer, value.subjectId]))});
  if (capabilityId(activity)==="chemistry.calculate_acid_base_speciation") {
    const parsed = acidReceipt.safeParse(payload), requested = acidInput.safeParse(activity.input.arguments);
    if (!parsed.success || !requested.success) throw new Error("UNSUPPORTED_RESULT_CONTRACT");
    const {data} = parsed.data, {result, input} = data;
    if (JSON.stringify(input) !== JSON.stringify(requested.data) || result.species.length !== input.pka_values.length + 1 || result.rows.length !== input.ph_values.length) throw new Error("RECEIPT_INPUT_MISMATCH");
    if (result.rows.length * result.species.length > MAX_FACTS) throw new Error("FACT_LIMIT_EXCEEDED");
    for (const [index, species] of result.species.entries()) {
      if (species.id !== `alpha_${index}` || species.protons_lost !== index || species.formal_charge !== input.fully_protonated_charge - index) throw new Error("SPECIES_CONTRACT_MISMATCH");
    }
    return result.rows.flatMap((row, rowIndex) => {
      if (row.ph !== input.ph_values[rowIndex]) throw new Error("RECEIPT_INPUT_MISMATCH");
      return result.species.map((species, speciesIndex) => {
        const value = row[species.id];
        if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error("UNSUPPORTED_RESULT_CONTRACT");
        return fact({operator: data.operator, subjectId: species.id, quantity: "Species fraction", value, unit: "dimensionless",
          context: {pH: row.ph, protons_lost: species.protons_lost, formal_charge: species.formal_charge},
          valuePointer: `/data/result/rows/${rowIndex}/${species.id}`, identityPointer: `/data/result/species/${speciesIndex}/id`, unitSource: "/data/result/visualization/y_unit"});
      });
    });
  }
  if (capabilityId(activity)==="compute.value.read") {
    const parsed = valueReadReceipt.safeParse(payload), requested = valueReadInput.safeParse(activity.input.arguments);
    if (!parsed.success || !requested.success) throw new Error("UNSUPPORTED_RESULT_CONTRACT");
    const receipt = parsed.data;
    if (requested.data.path !== receipt.result_path || requested.data.pointer !== receipt.pointer
        || requested.data.expected_result_sha256 !== receipt.result_sha256
        || requested.data.expected_manifest_sha256 !== receipt.manifest_sha256) throw new Error("RECEIPT_INPUT_MISMATCH");
    if (receipt.quantity === null || typeof receipt.value !== "number" || !Number.isFinite(receipt.value)
        || receipt.json_type === "null" || receipt.value_encoding !== "json-number") return [];
    if (receipt.json_type === "integer" && !Number.isSafeInteger(receipt.value)) return [];
    return [fact({operator: "proto_compute_value_read", subjectId: receipt.quantity.entity_id,
      quantity: `Compute result quantity (${receipt.quantity.quantity_kind})`, value: receipt.value, unit: receipt.quantity.unit,
      context: {dataset_id: receipt.quantity.dataset_id, result_path: receipt.result_path,
        result_sha256: receipt.result_sha256, manifest_sha256: receipt.manifest_sha256,
        result_pointer: receipt.pointer, scientific_validation: receipt.scientific_validation},
      valuePointer: "/value", identityPointer: "/quantity/entity_id", unitSource: "/quantity/unit"})];
  }
  const parsed = qpcrReceipt.safeParse(payload);
  if (!parsed.success) {
    if (typeof payload === "object" && payload !== null && "tool" in payload && payload.tool === "analyze_qpcr_relative_expression") throw new Error("UNSUPPORTED_RESULT_CONTRACT");
    return []; // Other compute operators remain unreviewed.
  }
  const requested = z.object({path: sourcePath}).strict().safeParse(activity.input.arguments);
  // Require exact request-to-receipt path association; no guessed basename,
  // relative-path resolution or comparison with the current mutable input file.
  if (!requested.success || requested.data.path !== parsed.data.source.path) throw new Error("RECEIPT_INPUT_MISMATCH");
  const {result} = parsed.data;
  if (new Set(result.rows.map(row => row.id)).size !== result.rows.length) throw new Error("AMBIGUOUS_SAMPLE_IDENTITY");
  return result.rows.map((row, index) => fact({operator: parsed.data.tool, subjectId: row.id, quantity: "Relative expression", value: row.relative_expression,
    unit: "dimensionless", context: {group: row.group, control_group: result.control_group},
    valuePointer: `/result/rows/${index}/relative_expression`, identityPointer: `/result/rows/${index}/id`, unitSource: "operator-contract:qpcr-relative-expression/v1"}));
}

/** Retain exact read values even when identity, units or numeric representation
 * cannot support a locatable scientific fact. No unit or entity is guessed. */
export function extractUnlocatableResearchValues(activity:ResearchActivity,payload:unknown):ResearchUnlocatableValue[] {
  if(activity.tool!=="science_run"||capabilityId(activity)!=="compute.value.read"||activity.status!=="complete"
    ||!activity.artifactPath||!SHA256.test(activity.artifactSha256??""))return [];
  const parsed=valueReadReceipt.safeParse(payload),requested=valueReadInput.safeParse(activity.input.arguments);
  if(!parsed.success||!requested.success)throw new Error("UNSUPPORTED_RESULT_CONTRACT");
  const receipt=parsed.data;
  if(requested.data.path!==receipt.result_path||requested.data.pointer!==receipt.pointer
    ||requested.data.expected_result_sha256!==receipt.result_sha256||requested.data.expected_manifest_sha256!==receipt.manifest_sha256)throw new Error("RECEIPT_INPUT_MISMATCH");
  const reason:ResearchUnlocatableValue["reason"]|undefined=receipt.json_type==="null"?"MISSING_VALUE"
    :receipt.quantity===null?"QUANTITY_CONTRACT_MISSING"
    :typeof receipt.value!=="number"||receipt.value_encoding!=="json-number"?"NON_NUMERIC_QUANTITY"
    :receipt.json_type==="integer"&&!Number.isSafeInteger(receipt.value)?"UNSAFE_NUMERIC_VALUE":undefined;
  if(!reason)return [];
  return [{activityId:activity.id,artifactPath:activity.artifactPath,artifactSha256:activity.artifactSha256!,
    resultPath:receipt.result_path,resultPointer:receipt.pointer,valueText:receipt.value_text,reason,
    ...(receipt.quantity?.missing_reason?{missingReason:receipt.quantity.missing_reason}:{})}];
}

/** Read only host-authored receipt paths in this session. The same byte string is
 * hashed and parsed; persisted projections and model previews are never trusted. */
export async function reopenResearchEvidence(workspace: string, sessionId: string, activity: ResearchActivity): Promise<ResearchEvidence> {
  if (!isResearchFactCandidate(activity)) return unreviewedResearchEvidence("OPERATOR_NOT_PROJECTED");
  if (activity.status !== "complete") return unreviewedResearchEvidence("EXECUTION_NOT_COMPLETE");
  if (!activity.artifactSha256 || !SHA256.test(activity.artifactSha256)) return unreviewedResearchEvidence("NO_HOST_RECEIPT_DIGEST");
  let handle;
  try {
    if (!z.string().uuid().safeParse(sessionId).success) throw new Error("RECEIPT_PATH_MISMATCH");
    const root = await realpath(workspace);
    const prefix = `build/chat/${sessionId}/tool-results/`;
    if (!activity.artifactPath?.startsWith(prefix) || !/^[a-f0-9-]{36}\.json$/.test(activity.artifactPath.slice(prefix.length))) throw new Error("RECEIPT_PATH_MISMATCH");
    let directory = root;
    for (const part of ["build", "chat", sessionId, "tool-results"]) {
      directory = join(directory, part);
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink() || resolve(await realpath(directory)) !== resolve(directory)) throw new Error("RECEIPT_PATH_MISMATCH");
    }
    const path = join(root, activity.artifactPath), before = await lstat(path, {bigint: true});
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(MAX_RECEIPT_BYTES)) throw new Error("RECEIPT_FILE_UNSAFE");
    handle = await open(path, "r");
    const opened = await handle.stat({bigint: true});
    if (before.dev !== opened.dev || before.ino !== opened.ino || before.size !== opened.size || before.mtimeNs !== opened.mtimeNs || before.ctimeNs !== opened.ctimeNs) throw new Error("RECEIPT_CHANGED");
    const buffer = Buffer.alloc(Number(opened.size) + 1);
    const {bytesRead} = await handle.read(buffer, 0, buffer.length, 0);
    const bytes = buffer.subarray(0, bytesRead), after = await handle.stat({bigint: true});
    if (BigInt(bytes.length) !== opened.size || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs || hash(bytes) !== activity.artifactSha256) throw new Error("RECEIPT_DIGEST_MISMATCH");
    const payload=JSON.parse(bytes.toString("utf8"));
    const facts = extractResearchFacts(activity, payload),unlocatableValues=extractUnlocatableResearchValues(activity,payload);
    if(unlocatableValues.length)return {...unreviewedResearchEvidence("VALUE_NOT_SCIENTIFICALLY_LOCATABLE"),status:"unlocatable",unlocatableValues};
    if (!facts.length) return unreviewedResearchEvidence("OPERATOR_NOT_PROJECTED");
    return {schema: "proto-workbench.research-evidence.v1", status: "bound-facts", scope: "saved-tool-receipt-fields-only", interpretation: "unreviewed", facts, diagnostics: []};
  } catch (error) {
    const code = error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : "RECEIPT_UNAVAILABLE";
    const evidence = unreviewedResearchEvidence(code);
    if (!new Set(["OPERATOR_NOT_PROJECTED", "UNSUPPORTED_RESULT_CONTRACT", "FACT_LIMIT_EXCEEDED"]).has(code)) evidence.status = "mismatch";
    return evidence;
  } finally { await handle?.close(); }
}

const claimSchema = z.discriminatedUnion("kind", [
  z.object({kind: z.literal("fact"), factId: z.string(), subjectId: identity, quantity: identity, value: numeric, unit: identity}).strict(),
  z.object({kind: z.literal("inference"), text: z.string().max(32000)}).strict(),
]);

/** For explicit structured claims only. No report tool or automatic semantic
 * extraction is enabled in this increment; ordinary prose never becomes bound. */
export function verifyStructuredResearchClaim(evidence: ResearchEvidence, input: unknown): {status: "bound" | "mismatch" | "unreviewed"; diagnostics: string[]} {
  const parsed = claimSchema.safeParse(input);
  if (!parsed.success) return {status: "mismatch", diagnostics: ["INVALID_STRUCTURED_CLAIM"]};
  if (parsed.data.kind === "inference" || evidence.status !== "bound-facts") return {status: "unreviewed", diagnostics: ["CLAIM_NOT_CHECKED"]};
  const claim = parsed.data, fact = evidence.facts.find(item => item.id === claim.factId);
  if (!fact) return {status: "mismatch", diagnostics: ["UNKNOWN_FACT"]};
  const diagnostics = (["subjectId", "quantity", "value", "unit"] as const).filter(key => claim[key] !== fact[key]).map(key => `${key.toUpperCase()}_MISMATCH`);
  return {status: diagnostics.length ? "mismatch" : "bound", diagnostics};
}
