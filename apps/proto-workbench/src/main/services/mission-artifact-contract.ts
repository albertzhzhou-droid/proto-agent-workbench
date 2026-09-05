import { isAbsolute, relative, resolve } from "node:path";
import type { MissionEvidenceRequirement, ToolResultEnvelope } from "../../shared/harness.ts";
import type { WorkspaceFiles } from "./workspace-files.ts";
import { positiveMissionClauses } from "./mission-intent.ts";
import { deriveMissionTargets } from "./mission-contract.ts";

type Requirement = Extract<MissionEvidenceRequirement, {kind: "artifact-report"}>;
export function deriveArtifactReport(goal: string, workspacePath: string): Requirement | undefined {
  const clauses = positiveMissionClauses(goal).filter(clause => /\b(?:report|record|table|list|document|quote)\b|记录|报告|列出|汇总/i.test(clause) && /\b(?:sha[ _-]?256|hash(?:es)?|digests?)\b|哈希|摘要/i.test(clause) && /\b(?:paths?|files?|artifacts?|manifests?|provenance)\b|路径|文件|产物|清单|溯源/i.test(clause));
  if (!clauses.length) return undefined;
  const reportPaths = clauses.flatMap(clause => deriveMissionTargets(clause, workspacePath).deliverables.filter(item => item.kind === "document").map(item => item.path));
  return {kind: "artifact-report", minimumRecords: 1, category: /\b(?:manifests?|provenance)\b|清单|溯源/i.test(clauses.join(" ")) ? "metadata" : "artifacts", ...(reportPaths.length ? {reportPaths: [...new Set(reportPaths)]} : {}),
    ...(/\b(?:every|each|all)\b|每个|所有|全部/i.test(clauses.join(" ")) ? {allRecords: true} : {}),
    ...(/\b(?:generated|produced|exported|created)\s+(?:(?:output|scientific)\s+)?(?:artifacts?|files?|outputs?)\b|生成的?(?:产物|文件)|导出的?(?:产物|文件)/i.test(clauses.join(" ")) ? {generatedOnly: true} : {})};
}

export async function artifactReportRecords(results: ToolResultEnvelope[], workspace: WorkspaceFiles, workspacePath: string, requirement: Requirement): Promise<Array<{path: string; sha256: string; aliases: string[]}>> {
  const rows = new Map<string, {path: string; sha256: string; aliases: string[]}>();
  const metadata = /(?:^|[/\\])(?:[^/\\]*[.-])?(?:manifest|provenance)(?:[.-][^/\\]+)?\.json$/i;
  for (const result of results.filter(result => result.ok)) {
    const artifacts = Array.isArray(result.data._harnessArtifacts) ? [...result.data._harnessArtifacts] : [];
    if (!requirement.generatedOnly && result.tool === "workspace_read") artifacts.push({path: result.data.path, sha256: result.data.sha256});
    for (const value of artifacts) {
      if (!value || typeof value !== "object" || typeof value.path !== "string" || typeof value.sha256 !== "string") continue;
      const absolute = resolve(workspacePath, value.path), path = relative(workspacePath, absolute).replaceAll("\\", "/");
      if (!path || path === ".." || path.startsWith("../") || isAbsolute(path) || requirement.category === "metadata" && !metadata.test(path)) continue;
      rows.set(path.toLowerCase(), {path, sha256: value.sha256, aliases: [...new Set([value.path, absolute, absolute.replaceAll("\\", "/")].filter(alias => alias !== path))]});
    }
  }
  const current = await Promise.all([...rows.values()].map(async record => (await workspace.artifactFingerprint(record.path).catch(() => undefined))?.sha256 === record.sha256 ? record : undefined));
  return current.filter((value): value is NonNullable<typeof value> => Boolean(value));
}
