import type { MissionEvidenceRequirement, ToolResultEnvelope } from "../../shared/harness.ts";
import type { MaterialEvidenceRecord } from "./harness-material-evidence.ts";
import { positiveMissionClauses } from "./mission-intent.ts";
import { deriveMissionTargets } from "./mission-contract.ts";

type Requirement = Extract<MissionEvidenceRequirement, {kind: "materials"}>;
const NUMBERS: Record<string, number> = {one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10};
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const strings = (values: unknown[]) => [...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0))];
// Preserve exact, typed receipt metadata for verification of optional report
// claims. Nested data and coerced values cannot become a scalar claim.
const stringFields = (value: Record<string, unknown>): Record<string, string> => Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));

/** Reporting obligations are derived from the trusted request, never from a
 * fixture name, model plan, attachment, or untrusted catalogue description. */
export function deriveMaterialEvidence(intent: string, workspacePath = "."): Requirement | undefined {
  const domain = /\b(?:materials?|catalogue|catalog|resource[_ ]?ids?|protein[_ ]?ids?|part[_ ]?ids?)\b|材料|目录|资源|蛋白(?:质)?(?:标识|ID)/i.test(intent);
  const allClauses = positiveMissionClauses(intent);
  const isReporting = (clause: string) => /\b(?:create|write|save|include|contain|record|report|summari[sz]e|summary|table|mapping|list|cite|quote|copy|document)\b|创建|写入|保存|包含|记录|报告|汇总|总结|列表|列出|映射|引用|抄录/i.test(clause);
  const clauses = allClauses.filter(isReporting);
  const reporting = clauses.join("\n");
  if (!domain || !reporting) return undefined;
  const fields = reportedMaterialFields(reporting);
  // Merely using catalogue data to build a design does not create a new
  // metadata-report requirement. Explicit identity reporting does.
  const identities = /\b(?:resource[_ ]?ids?|protein[_ ]?ids?|part[_ ]?ids?|each\s+id)\b|资源(?:标识|ID)|蛋白(?:质)?(?:标识|ID)|精确标识/i.test(reporting);
  if (!fields.length && !identities) return undefined;
  const counts = [...reporting.matchAll(/\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:(?:distinct|exact|verified|eligible|material|resource|protein|part)\s+){0,4}(?:records?|resources?|proteins?|materials?|ids?|identifiers?)\b|([一二两三四五六七八九十\d]+)\s*(?:个|条|种)\s*(?:不同的?|精确的?)?\s*(?:材料|资源|蛋白|记录)/gi)]
    .map(match => Number(match[1] ?? match[2]) || NUMBERS[(match[1] ?? match[2]).toLowerCase()] || 1);
  const recordKind = /proto_protein_inspect|\bprotein\s+ir\b|蛋白(?:质)?\s*IR/i.test(intent) && !/\bmaterials?\s+(?:catalogue|catalog)\b/i.test(intent) ? "protein" : "catalogue";
  let latestReportPaths: string[] = [];
  const reports = allClauses.flatMap(clause => {
    const explicitPaths = deriveMissionTargets(clause, workspacePath).deliverables.filter(item => item.kind === "document" && /\.(?:md|txt|csv|tsv|json)$/i.test(item.path)).map(item => item.path);
    if (explicitPaths.length) latestReportPaths = explicitPaths;
    const fields = isReporting(clause) ? reportedMaterialFields(clause) : [];
    return fields.length && latestReportPaths.length ? [{paths: [...latestReportPaths], fields}] : [];
  });
  return {kind: "materials", minimumRecords: Math.max(1, ...counts), fields, recordKind,
    ...(reports.length ? {reports} : {}),
    ...(/\b(?:each|every|all)\s+(?:(?:exact|returned|verified|protein|resource|material|part)\s+){0,4}(?:ids?|identifiers?|records?|proteins?|resources?)\b|每个(?:资源|蛋白|记录)|所有(?:资源|蛋白|记录)/i.test(intent) ? {allReturnedRecords: true} : {})};
}

function reportedMaterialFields(reporting: string): Requirement["fields"] {
  const fields: Requirement["fields"] = [];
  if (/\bsequence[_ -]?(?:sha[_ -]?256|hash(?:es)?|digest(?:s)?)\b|序列(?:哈希|摘要)/i.test(reporting)) fields.push("sequence_sha256");
  if (/\bsource(?:s|[_ -]fields?)?\b|来源/i.test(reporting)) fields.push("source");
  if (/\b(?:licen[cs]e(?:s)?|rights)\b|许可|授权/i.test(reporting)) fields.push("license");
  if (/\b(?:sequence[_ -]length|lengths?)\b|序列长度|长度/i.test(reporting)) fields.push("length");
  return fields;
}

/** Only these typed successful receipts expose material identities. Arbitrary
 * workspace JSON or model messages cannot mint a trusted evidence record. */
export function materialEvidenceRecords(results: ToolResultEnvelope[], requirement: Requirement): MaterialEvidenceRecord[] {
  const values = results.filter(result => result.ok).flatMap(result => {
    if (requirement.recordKind === "protein") return result.tool === "proto_protein_inspect" && Array.isArray(result.data.proteins) ? result.data.proteins : [];
    if (result.tool === "proto_materials_search") return Array.isArray(result.data.matches) ? result.data.matches : [];
    if (result.tool === "proto_materials_get") return result.data.resource ? [result.data.resource] : [];
    return [];
  });
  return values.flatMap(value => {
    const row = object(value), source = object(row.source), license = object(row.license);
    const resourceId = requirement.recordKind === "protein" ? row.id : row.resource_id;
    if (typeof resourceId !== "string" || !resourceId) return [];
    const length = row.length ?? row.sequence_length;
    return [{resourceId, ...(typeof row.sequence_sha256 === "string" ? {sequenceSha256: row.sequence_sha256} : {}),
      ...(typeof length === "number" && Number.isSafeInteger(length) && length >= 0 ? {length} : {}),
      sourceFields: stringFields(source), licenseFields: stringFields(license),
      sourceReferences: strings([source.provider, source.record_id, source.url]), licenseIds: strings([license.id])}];
  });
}
