import type { MissionContract, MissionEvidenceRequirement, ToolResultEnvelope } from "../../shared/harness.ts";
import type { WorkspaceFiles } from "./workspace-files.ts";
import { deriveMaterialEvidence, materialEvidenceRecords } from "./mission-material-contract.ts";
import { verifyMaterialEvidence } from "./harness-material-evidence.ts";
import { positiveMissionClauses } from "./mission-intent.ts";
import { resolve } from "node:path";
import { deriveSourceFields, verifySourceField } from "./mission-source-field.ts";
import { deriveArtifactReport, artifactReportRecords } from "./mission-artifact-contract.ts";
import { verifyArtifactReport } from "./harness-artifact-report.ts";
import { deriveDnaEvidence, verifyDnaEvidence } from "./mission-dna-contract.ts";

const PROVIDERS = {pubmed: "proto_pubmed_search", crossref: "proto_crossref_search", "europe-pmc": "proto_europe_pmc_search"} as const;
const LITERATURE = /\b(?:pubmed|crossref|europe[ -]?pmc|literature|papers?|publications?|bibliograph\w*)\b|文献|论文/i;
const NUMBER_WORDS: Record<string, number> = {one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10};

/** Bind supported evidence obligations from user intent before model planning.
 * These criteria verify retrieval and artifact lineage, not scientific truth. */
export function deriveMissionEvidence(goal: string, workspacePath = "."): MissionEvidenceRequirement[] {
  const requirements: MissionEvidenceRequirement[] = [];
  // Negative clauses cannot introduce obligations that the user excluded.
  const intent = positiveMissionClauses(goal).join(". ");
  const materials = deriveMaterialEvidence(intent, workspacePath);
  if (materials) requirements.push(materials);
  const artifactReport = deriveArtifactReport(intent, workspacePath);
  if (artifactReport) requirements.push(artifactReport);
  requirements.push(...deriveSourceFields(intent, workspacePath));
  requirements.push(...deriveDnaEvidence(goal, workspacePath));
  if (LITERATURE.test(intent)) {
    const providers = (Object.keys(PROVIDERS) as Array<keyof typeof PROVIDERS>).filter(provider => new RegExp(provider === "europe-pmc" ? "europe[ -]?pmc" : provider, "i").test(intent));
    const counts = [...intent.matchAll(/(?:\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:(?:distinct|relevant|verified|live|online|current|latest|PubMed|Crossref|Europe PMC|scientific)\s+){0,3}(?:papers?|articles?|publications?|references?)\b|([一二两三四五六七八九十\d]+)\s*(?:篇|条|个)?\s*(?:PubMed\s*|Crossref\s*)?(?:文献|论文))/gi)].map(match => Number(match[1] ?? match[2]) || NUMBER_WORDS[(match[1] ?? match[2]).toLowerCase()] || 1);
    requirements.push({kind: "literature", providers, minimumRecords: Math.max(1, ...counts), live: /\b(?:live|online|current|latest)\b|实时|联网|最新/i.test(intent), ...(counts.length ? {countPublicationsOnly: true} : {})});
  }
  if (/proto_structure_(?:fetch|import_workspace)|\b(?:fetch|import|associate|attach|load|visuali[sz]e)\b[^.\n]{0,90}\b(?:structures?|coordinates?)\b|\bstructure\s+(?:association|attachment)\b|(?:关联|导入|抓取|加载|可视化)[^。\n]{0,30}(?:结构|坐标)/i.test(intent)) requirements.push({kind: "structure", official: /\b(?:official|pdb|alphafold)\b|官方/i.test(intent)});
  const workflow = /proto_workflow_run|\brun\b[^.\n]{0,35}\bworkflow\b|\bperform\b[^.\n]{0,50}\bworkflow\b|运行工作流/i.test(intent);
  const verification = /proto_provenance_verify|\bprovenance\s+(?:verification|verify)|\bverify\s+(?:the\s+)?provenance|workflow\s*\/\s*provenance|(?:验证|核验|检查)溯源|溯源(?:验证|核验)/i.test(intent);
  const review = /proto_review_packet|\breview\s+packet\b|provenance\s*\/\s*review|审查包|评审包/i.test(intent);
  if (workflow || verification || review) requirements.push({kind: "provenance", workflow, verification, review});
  return requirements;
}

type Digest = {path: string; sha256: string};
const input = (result: ToolResultEnvelope) => result.data._harnessInputs as Digest | undefined;
const outputs = (result: ToolResultEnvelope) => (result.data._harnessArtifacts as Digest[] | undefined) ?? [];
const canonicalDoi = (value: string) => {
  let doi = value.replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/i, "").replace(/[.,;:]+$/, "").toLowerCase();
  while (doi.endsWith(")") && (doi.match(/\)/g)?.length ?? 0) > (doi.match(/\(/g)?.length ?? 0)) doi = doi.slice(0, -1);
  return doi;
};
const sameFile = (a: Digest | undefined, b: Digest | undefined) => Boolean(a?.path && b?.path && a.path.toLowerCase() === b.path.toLowerCase() && a.sha256 === b.sha256);
const doiExpression = /10\.\d{4,9}\/[A-Za-z0-9._;()/:+-]+/gi;
type Publication = {key: string; identifiers: string[]; publication: boolean};
function publications(result: ToolResultEnvelope): Publication[] {
  const matches = result.data.matches;
  if (!Array.isArray(matches)) return [];
  return matches.flatMap((value): Publication[] => {
    if (!value || typeof value !== "object") return [];
    const record = value as Record<string, unknown>;
    const identifiers = [record.source_id, record.doi, record.pmid, record.pmcid, ...(Array.isArray(record.identifiers) ? record.identifiers : [])].filter((item): item is string => typeof item === "string" && Boolean(item.trim()));
    const doi = canonicalDoi(String(record.doi ?? identifiers.find(item => /^(?:DOI:|10\.)/i.test(item)) ?? ""));
    const pmid = String(record.pmid ?? identifiers.find(item => /^PMID:\d+$/i.test(item))?.slice(5) ?? "");
    const pmcid = String(record.pmcid ?? identifiers.find(item => /^PMC\d+$/i.test(item)) ?? "").toUpperCase();
    const ids = [/^10\.\d{4,9}\/\S+$/i.test(doi) ? `doi:${doi}` : "", /^\d{1,16}$/.test(pmid) ? `pmid:${pmid}` : "", /^PMC\d+$/.test(pmcid) ? `pmcid:${pmcid}` : ""].filter(Boolean);
    const publication = result.tool !== "proto_crossref_search" || ["journal-article", "proceedings-article", "posted-content", "book-chapter", "report", "dissertation"].includes(String(record.work_type));
    return ids.length ? [{key: ids[0], identifiers: ids, publication}] : [];
  });
}

export async function verifyMissionEvidence(contract: MissionContract, results: ToolResultEnvelope[], workspace: WorkspaceFiles, summary = ""): Promise<string[]> {
  const requirements = contract.evidenceRequirements ?? deriveMissionEvidence(contract.goal, contract.workspacePath);
  if (!requirements.length) return [];
  const diagnostics: string[] = [], successful = results.filter(result => result.ok);
  const current = async (fingerprint: Digest | undefined) => Boolean(fingerprint?.path && fingerprint.sha256 && (await workspace.artifactFingerprint(fingerprint.path).catch(() => undefined))?.sha256 === fingerprint.sha256);
  const savedDocuments: string[] = [], savedFiles: Array<{path: string; content: string}> = [];
  const reportDeliverables = contract.deliverables.filter(deliverable => /\.(?:md|txt|csv|tsv|json)$/i.test(deliverable.path) && !/\.ir\.json$/i.test(deliverable.path));
  for (const deliverable of reportDeliverables) {
    const file = await workspace.read(deliverable.path).catch(() => undefined);
    if (file && successful.some(result => outputs(result).some(item => sameFile(item, file)))) {savedDocuments.push(file.content); savedFiles.push({path: deliverable.path, content: file.content});}
  }
  const artifactReportRequired = reportDeliverables.length > 0 || Boolean(contract.requiresArtifacts);
  const evidenceDocuments = artifactReportRequired ? savedDocuments : [summary];
  const report = evidenceDocuments.join("\n"), reportLabel = artifactReportRequired ? "saved report" : "completion summary";
  const documentsAt = (path: string) => savedFiles.filter(file => resolve(contract.workspacePath ?? ".", file.path).toLowerCase() === resolve(contract.workspacePath ?? ".", path).toLowerCase()).map(file => file.content);
  for (const requirement of requirements) {
    if (requirement.kind === "materials") {
      const boundResults = requirement.recordKind === "protein" ? (await Promise.all(successful.map(async result => result.tool !== "proto_protein_inspect" || await current(input(result)) ? result : undefined))).filter((result): result is ToolResultEnvelope => Boolean(result)) : successful;
      const records = materialEvidenceRecords(boundResults, requirement);
      const minimumRecords = requirement.allReturnedRecords ? Math.max(requirement.minimumRecords, new Set(records.map(record => record.resourceId)).size) : requirement.minimumRecords;
      if (!evidenceDocuments.length) diagnostics.push("MATERIAL_REPORT_REQUIRED: Save a current digest-bound report containing the requested material identities and metadata before finishing. A completion summary cannot substitute for a requested saved report.");
      diagnostics.push(...verifyMaterialEvidence(records, evidenceDocuments, {...requirement, minimumRecords}).map(item => `${item.code}: ${item.message}`));
      for (const binding of requirement.reports ?? []) for (const path of binding.paths) {
        diagnostics.push(...verifyMaterialEvidence(records, documentsAt(path), {minimumRecords, fields: binding.fields}).map(item => `${item.code}: ${path}: ${item.message}`));
      }
    } else if (requirement.kind === "dna-edit") {
      diagnostics.push(...await verifyDnaEvidence(requirement, results, workspace, contract.workspacePath ?? "."));
    } else if (requirement.kind === "source-field") {
      if (requirement.reportPaths?.length) for (const path of requirement.reportPaths) diagnostics.push(...(await verifySourceField(requirement, successful, workspace, contract.workspacePath ?? ".", documentsAt(path))).map(message => `${path}: ${message}`));
      else diagnostics.push(...await verifySourceField(requirement, successful, workspace, contract.workspacePath ?? ".", evidenceDocuments));
    } else if (requirement.kind === "artifact-report") {
      const records = (await artifactReportRecords(successful, workspace, contract.workspacePath ?? ".", requirement)).filter(record => !reportDeliverables.some(item => resolve(contract.workspacePath ?? ".", item.path).toLowerCase() === resolve(contract.workspacePath ?? ".", record.path).toLowerCase()));
      const criteria = {minimumRecords: requirement.minimumRecords, ...(requirement.category === "metadata" || requirement.allRecords ? {requiredPaths: records.map(record => record.path)} : {})};
      if (requirement.reportPaths?.length) for (const path of requirement.reportPaths) diagnostics.push(...verifyArtifactReport(records, documentsAt(path), criteria).map(item => `${item.code}: ${path}: ${item.message}`));
      else diagnostics.push(...verifyArtifactReport(records, evidenceDocuments, criteria).map(item => `${item.code}: ${item.message}`));
    } else if (requirement.kind === "literature") {
      const accepted = successful.filter(result => Object.values(PROVIDERS).includes(result.tool as typeof PROVIDERS[keyof typeof PROVIDERS]) && (!requirement.live || result.data.mode === "network"));
      const records = accepted.flatMap(publications), unique = new Map(records.filter(record => !requirement.countPublicationsOnly || record.publication).map(record => [record.key, record]));
      for (const provider of requirement.providers) if (!accepted.some(result => result.tool === PROVIDERS[provider] && publications(result).length)) diagnostics.push(`Literature evidence requires nonempty verified identifiers returned by ${provider}${requirement.live ? " through a live network request" : ""}.`);
      if (unique.size < requirement.minimumRecords) diagnostics.push(`Literature evidence requires ${requirement.minimumRecords} distinct retrieved publications; ${unique.size} are available.`);
      const known = new Set(records.flatMap(record => record.identifiers));
      const cited = new Set<string>();
      for (const match of report.matchAll(doiExpression)) cited.add(`doi:${canonicalDoi(match[0])}`);
      for (const match of report.matchAll(/(?:\bPMID\s*[:#]?\s*|pubmed\.ncbi\.nlm\.nih\.gov\/)(\d{1,16})/gi)) cited.add(`pmid:${match[1]}`);
      for (const match of report.matchAll(/\bPMC\d+\b/gi)) cited.add(`pmcid:${match[0].toUpperCase()}`);
      // A plain exact PMID is also a valid table cell when it came from a receipt.
      for (const id of known) if (id.startsWith("pmid:") && new RegExp(`\\b${id.slice(5)}\\b`).test(report)) cited.add(id);
      for (const id of cited) if (!known.has(id)) diagnostics.push(`Literature citation was not returned by a successful permitted provider receipt: ${id}`);
      for (const provider of requirement.providers) if (!accepted.filter(result => result.tool === PROVIDERS[provider]).flatMap(publications).some(record => record.identifiers.some(id => cited.has(id)))) diagnostics.push(`The ${reportLabel} must cite at least one identifier retrieved from ${provider}.`);
      const citedRecords = [...unique.values()].filter(record => record.identifiers.some(id => cited.has(id))).length;
      if (citedRecords < requirement.minimumRecords) diagnostics.push(`The ${reportLabel} must cite at least ${requirement.minimumRecords} retrieved publication identities; ${citedRecords} are bound.`);
    } else if (requirement.kind === "structure") {
      let bound = false;
      for (const result of successful.filter(item => ["proto_structure_fetch", "proto_structure_import_workspace"].includes(item.tool))) {
        const attachment = result.data.attachment as {id?: string; contentSha256?: string; source?: {provider?: string}} | undefined;
        if (!attachment?.id || !attachment.contentSha256 || (requirement.official && !["pdb", "alphafold"].includes(attachment.source?.provider ?? ""))) continue;
        if (!(await current(input(result))) || outputs(result).length < 2 || !outputs(result).some(item => /\.(?:pdb|cif|mmcif|ent)$/i.test(item.path) && item.sha256 === attachment.contentSha256) || !(await Promise.all(outputs(result).map(current))).every(Boolean)) continue;
        const reopened = successful.some(read => read.tool === "proto_structure_read" && sameFile(input(read), input(result)) && (read.data.attachment as typeof attachment)?.id === attachment.id && (read.data.attachment as typeof attachment)?.contentSha256 === attachment.contentSha256);
        if (reopened) {bound = true; break;}
      }
      if (!bound) diagnostics.push("Structure evidence requires a current protein artifact, digest-bound coordinate and provenance attachment, and a successful readback of that exact attachment.");
    } else {
      const requested = [requirement.workflow ? "proto_workflow_run" : "", requirement.verification ? "proto_provenance_verify" : "", requirement.review ? "proto_review_packet" : ""].filter(Boolean);
      for (const name of requested) {
        let verified = false;
        for (const result of successful) {
          if (result.tool === name && await current(input(result)) && (name === "proto_provenance_verify" || outputs(result).length > 0) && (await Promise.all(outputs(result).map(current))).every(Boolean)) {verified = true; break;}
          const validation = result.data.validation as {source?: string; sha256?: string; ok?: boolean; steps?: Array<{tool?: string; status?: string}>} | undefined;
          const recoveredProvenance = result.data._harnessRecoveredProvenance as Digest | undefined;
          const boundValidation = outputs(result).length > 1 || (recoveredProvenance && await current(recoveredProvenance));
          if (["workspace_propose_patch", "workspace_resume_validation"].includes(result.tool) && validation?.ok && validation.steps?.some(step => step.tool === name && step.status === "completed") && await current({path: validation.source ?? "", sha256: validation.sha256 ?? ""}) && boundValidation && (await Promise.all(outputs(result).map(current))).every(Boolean)) {verified = true; break;}
        }
        if (!verified) diagnostics.push(`Mission evidence requires current source-bound ${name} receipts. Bibliographic or review readiness is not implied by an arbitrary report.`);
      }
    }
  }
  return diagnostics;
}
