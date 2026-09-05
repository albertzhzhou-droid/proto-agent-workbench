import { resolve } from "node:path";
import type { MissionEvidenceRequirement, ToolResultEnvelope } from "../../shared/harness.ts";
import type { WorkspaceFiles } from "./workspace-files.ts";
import { deriveMissionTargets } from "./mission-contract.ts";
import { positiveMissionClauses } from "./mission-intent.ts";

type Requirement = Extract<MissionEvidenceRequirement, {kind: "source-field"}>;
const reportPath = (path: string) => /\.(?:md|txt|csv|tsv|json)$/i.test(path) && !/\.ir\.json$/i.test(path);
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const label = (value: string) => value.toLowerCase().replace(/[_\s-]+/g, " ").trim();

/** A user-named literal field, independent of any benchmark label or filename. */
export function deriveSourceFields(goal: string, workspacePath: string): Requirement[] {
  const intent = positiveMissionClauses(goal).join(". "), targets = deriveMissionTargets(intent, workspacePath);
  const patterns = [
    /\b(?:copy\s+(?:(?:its|their)\s+(?:exact\s+)?|(?:the\s+)?exact\s+)|(?:with|include)\s+(?:its|their|the)\s+exact\s+)(?:[`"']([^`"'\n]{1,80})[`"']|([A-Za-z][A-Za-z0-9_. -]{0,70}?))(?=\s+(?:into|to|from|and)\b|[,;!?]|\.(?=\s|$)|$)/gi,
    /\bcopy\s+(?:the\s+)?(?:[`"']([^`"'\n]{1,80})[`"']|([A-Za-z][A-Za-z0-9_. -]{0,70}?))\s+verbatim\b/gi,
  ];
  const matches = patterns.flatMap(pattern => [...intent.matchAll(pattern)]).sort((a, b) => a.index - b.index);
  return matches.map(match => {
    const preceding = deriveMissionTargets(intent.slice(0, match.index), workspacePath);
    const previous = preceding.deliverables.filter(item => reportPath(item.path)).at(-1);
    const suffix = intent.slice(match.index + match[0].length), explicitSource = /^\s+from\s+(.+)/i.exec(suffix);
    const source = explicitSource ? deriveMissionTargets(`Read ${positiveMissionClauses(explicitSource[1])[0] ?? ""}`, workspacePath).requiredReads[0] : preceding.requiredReads.at(-1);
    const paths = previous ? [previous.path] : targets.deliverables.filter(item => reportPath(item.path)).map(item => item.path);
    return {kind: "source-field", field: (match[1] ?? match[2]).trim(), sourcePaths: source ? [source] : [...targets.requiredReads], ...(paths.length ? {reportPaths: paths} : {})};
  });
}

function fieldValues(content: string, field: string): string[] | undefined {
  const values: string[] = [];
  const pattern = new RegExp(`^\\s*(?:[-*]\\s*)?[*_\x60]*${escape(field).replace(/[_\s-]+/g, "[_\\s-]+")}[*_\x60]*\\s*[:=]\\s*(.+?)\\s*$`, "gim");
  for (const match of content.matchAll(pattern)) values.push(match[1].replace(/^([`"'])(.*)\1$/, "$2"));
  try {
    const pending: Array<{value: unknown; path: string[]}> = [{value: JSON.parse(content), path: []}];
    for (let n = 0; pending.length && n < 10000; n++) {
      const {value, path} = pending.pop()!; if (!value || typeof value !== "object") continue;
      for (const [key, item] of Object.entries(value)) {
        if (item && typeof item === "object") pending.push({value: item, path: [...path, key]});
        else if ((label(key) === label(field) || label([...path, key].join(".")) === label(field)) && (typeof item === "string" || typeof item === "number")) values.push(String(item));
      }
    }
    if (pending.length) return undefined; // Never accept a prefix that may hide a conflicting value.
  } catch { /* Labelled text is the other supported representation. */ }
  return [...new Set(values.filter(value => value.length > 0 && value.length <= 4096))];
}

export async function verifySourceField(requirement: Requirement, results: ToolResultEnvelope[], workspace: WorkspaceFiles, workspacePath: string, documents: string[]): Promise<string[]> {
  const values: string[] = [];
  for (const path of requirement.sourcePaths) {
    const receipt = results.filter(result => result.ok && result.tool === "workspace_read" && typeof result.data.path === "string" && resolve(workspacePath, result.data.path).toLowerCase() === resolve(workspacePath, path).toLowerCase()).at(-1);
    if (!receipt || typeof receipt.data.content !== "string" || typeof receipt.data.sha256 !== "string") continue;
    const actual = await workspace.artifactFingerprint(path).catch(() => undefined);
    if (actual?.sha256 === receipt.data.sha256) {
      const found = fieldValues(receipt.data.content, requirement.field);
      if (!found) return ["SOURCE_FIELD_LIMIT: The source field traversal exceeded its bounded limit; completion was not accepted from a partial document."];
      values.push(...found);
    }
  }
  const unique = [...new Set(values)];
  if (unique.length !== 1) return [`SOURCE_FIELD_UNBOUND: The requested field '${requirement.field}' must have one unambiguous value in a current successful read of its required source file; ${unique.length} values are bound. Re-read the source or report the missing/ambiguous field.`];
  const claimed: string[] = [];
  for (const document of documents) {
    const found = fieldValues(document, requirement.field);
    if (!found) return ["SOURCE_FIELD_LIMIT: The report field traversal exceeded its bounded limit; completion was not accepted from a partial document."];
    claimed.push(...found);
  }
  if (claimed.some(value => value !== unique[0])) return [`SOURCE_FIELD_MISMATCH: The saved '${requirement.field}' field differs from its source value ${JSON.stringify(unique[0])}. A correct copy elsewhere in the document cannot override a conflicting labelled value.`];
  const exact = new RegExp(`(?<![\\p{L}\\p{N}_])${escape(unique[0])}(?![\\p{L}\\p{N}_])`, "u");
  return documents.some(document => exact.test(document)) ? [] : [`SOURCE_FIELD_MISSING: The saved report must copy the exact '${requirement.field}' value ${JSON.stringify(unique[0])} from the successful source read. Repair the saved output; a completion summary cannot substitute for it.`];
}
