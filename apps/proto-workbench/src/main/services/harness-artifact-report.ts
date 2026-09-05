import { expandJsonReportBlocks } from "./harness-report-documents.ts";

export interface ArtifactReportRecord {path: string; sha256: string; aliases?: string[]}
export interface ArtifactReportRequirement {minimumRecords: number; requiredPaths?: string[]}
export interface ArtifactReportDiagnostic {code: "ARTIFACT_REPORT_MISSING" | "ARTIFACT_REPORT_HASH_MISMATCH" | "ARTIFACT_REPORT_PATH_UNKNOWN" | "ARTIFACT_REPORT_CONFLICT" | "ARTIFACT_REPORT_LIMIT"; path?: string; message: string}
const normalize = (path: string) => path.replaceAll("\\", "/").replace(/^\.\//, "").toLowerCase();
const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
type Role = "" | "artifact" | "manifest" | "provenance";
type Field = {kind: "path" | "hash"; role: Role; value: unknown};
const field = (key: string, value: unknown): Field | undefined => {
  const match = key.replace(/[ _-]+/g, "").toLowerCase().match(/^(artifact|manifest|provenance)?(path|sha256|hash|digest)$/);
  return match ? {kind: match[2] === "path" ? "path" : "hash", role: (match[1] ?? "") as Role, value} : undefined;
};
// Formatting is permitted around the entire value; its contents are never
// searched for a usable prefix, nested example, or unrelated valid digest.
const formatted = (value: string) => {
  let result = value.trim();
  for (let n = 0; n < 3; n++) {
    const match = result.match(/^(`+|\*\*|__|\*|_|"|')([\s\S]*)\1$/);
    if (!match) break;
    result = match[2].trim();
  }
  return result;
};
const cells = (line: string) => line.trim().replace(/^\||\|$/g, "").split("|").map(formatted);
const display = (value: unknown) => {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
};

/** Reopen/receipt validation belongs to the caller. Each claim here must pair
 * a typed path with a typed SHA-256 in the same JSON object, table row, or
 * one-artifact prose section. Unrelated text never supplies an identity. */
export function verifyArtifactReport(records: ArtifactReportRecord[], documents: string[], requirement: ArtifactReportRequirement): ArtifactReportDiagnostic[] {
  const diagnostics: ArtifactReportDiagnostic[] = [], known = new Map<string, ArtifactReportRecord>();
  for (const record of records) {
    const key = normalize(record.path), previous = known.get(key);
    if (!/^[a-f0-9]{64}$/i.test(record.sha256) || (previous && previous.sha256.toLowerCase() !== record.sha256.toLowerCase())) diagnostics.push({code: "ARTIFACT_REPORT_CONFLICT", path: record.path, message: `Artifact ${record.path} has no unambiguous current SHA-256 receipt.`});
    else known.set(key, {...record, path: key, sha256: record.sha256.toLowerCase()});
  }
  const aliases = new Map<string, string>();
  for (const [key, record] of known) for (const alias of [record.path, ...(record.aliases ?? [])]) {
    const normalized = normalize(alias), previous = aliases.get(normalized);
    if (previous && previous !== key) diagnostics.push({code: "ARTIFACT_REPORT_CONFLICT", path: alias, message: `Artifact path alias ${alias} refers to multiple current artifacts.`});
    else aliases.set(normalized, key);
  }
  const replacePaths = (text: string) => {
    let value = text.replaceAll("\\", "/");
    for (const [alias, key] of [...aliases].sort((a, b) => b[0].length - a[0].length)) value = value.replace(new RegExp(`(?<![A-Za-z0-9_./:-])${escaped(alias)}(?![A-Za-z0-9_./:-])`, "gi"), () => key);
    return value;
  };
  const inText = (text: string) => [...known.keys()].filter(path => new RegExp(`(?<![A-Za-z0-9_./:-])${escaped(path)}(?![A-Za-z0-9_./:-])`).test(text));
  const matched = new Set<string>(), invalid = new Set<string>();
  const addClaim = (fields: Field[]) => {
    const paths = fields.filter(item => item.kind === "path"), hashes = fields.filter(item => item.kind === "hash");
    if (!paths.length) return;
    const assigned = new Map<Field, Field[]>();
    for (const hash of hashes) {
      let targets = paths.filter(path => path.role === hash.role);
      if (!targets.length && paths.length === 1 && (!hash.role || !paths[0].role || paths[0].role === "artifact")) targets = paths;
      if (targets.length === 1) assigned.set(targets[0], [...(assigned.get(targets[0]) ?? []), hash]);
      else diagnostics.push({code: "ARTIFACT_REPORT_CONFLICT", message: `A ${hash.role || "artifact"} SHA-256 claim has no unique corresponding path in its record. Use matching path/hash fields for each artifact.`});
    }
    for (const claim of paths) {
      const path = typeof claim.value === "string" ? aliases.get(normalize(claim.value)) : undefined;
      if (!path) {
        diagnostics.push({code: "ARTIFACT_REPORT_PATH_UNKNOWN", ...(typeof claim.value === "string" ? {path: normalize(claim.value)} : {}), message: `Reported artifact path ${display(claim.value)} has no current successful tool receipt in this task.`});
        continue;
      }
      const claims = assigned.get(claim) ?? [], record = known.get(path)!;
      if (!claims.length) {
        invalid.add(path);
        diagnostics.push({code: "ARTIFACT_REPORT_MISSING", path, message: `Associate ${path} with an explicit SHA-256 field in the same record; nested examples or unlabelled text cannot supply its digest.`});
        continue;
      }
      let valid = true;
      for (const hash of claims) if (typeof hash.value !== "string" || !/^[a-f0-9]{64}$/i.test(hash.value) || hash.value.toLowerCase() !== record.sha256) {
        valid = false; invalid.add(path);
        diagnostics.push({code: "ARTIFACT_REPORT_HASH_MISMATCH", path, message: `Reported SHA-256 ${display(hash.value)} for ${path} differs from its current tool receipt. Preserve the exact path and all 64 digest characters as a string.`});
      }
      if (valid) matched.add(path);
    }
  };
  const expanded = expandJsonReportBlocks(documents);
  for (const message of expanded.errors) diagnostics.push({code: "ARTIFACT_REPORT_CONFLICT", message});
  for (const document of expanded.documents) {
    let parsed: unknown;
    const jsonText = document;
    try { parsed = JSON.parse(jsonText); } catch { /* Markdown below. */ }
    if (parsed && typeof parsed === "object") {
      // JSON.parse keeps only the final duplicate key. Inspect the valid JSON
      // token stream first so a later correct value cannot erase a prior claim.
      const stack: Array<{keys?: Set<string>; expectsKey: boolean}> = [];
      for (const token of jsonText.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\],:]/g)) {
        const value = token[0], frame = stack.at(-1);
        if (value === "{") stack.push({keys: new Set(), expectsKey: true});
        else if (value === "[") stack.push({expectsKey: false});
        else if (value === "}" || value === "]") stack.pop();
        else if (value === ":" && frame) frame.expectsKey = false;
        else if (value === "," && frame?.keys) frame.expectsKey = true;
        else if (value.startsWith('"') && frame?.keys && frame.expectsKey) {
          const key = JSON.parse(value) as string;
          if (frame.keys.has(key) && field(key, undefined)) diagnostics.push({code: "ARTIFACT_REPORT_CONFLICT", message: `Duplicate artifact field ${display(key)} is ambiguous; preserve one explicit path/hash claim per key.`});
          frame.keys.add(key);
        }
      }
      const pending: unknown[] = [parsed];
      for (let visited = 0; pending.length && visited < 20_000; visited += 1) {
        const value = pending.pop();
        if (!value || typeof value !== "object") continue;
        if (Array.isArray(value)) {for (const item of value) pending.push(item); continue;}
        const entries = Object.entries(value);
        pending.push(...entries.map(([, item]) => item).filter(item => item && typeof item === "object"));
        addClaim(entries.flatMap(([key, item]) => {const claim = field(key, item); return claim ? [claim] : [];}));
      }
      if (pending.length) diagnostics.push({code: "ARTIFACT_REPORT_LIMIT", message: "Artifact metadata report exceeds the bounded structured-record limit; use a smaller report before completing."});
      continue;
    }
    const lines = replacePaths(document).split(/\r?\n/), tableLines = new Set<number>();
    let headers: string[] | undefined;
    lines.forEach((line, index) => {
      if (!line.includes("|")) {headers = undefined; return;}
      const row = cells(line);
      if (row.length > 1 && row.every(cell => /^:?-+:?$/.test(cell)) && index > 0 && lines[index - 1].includes("|")) {
        headers = cells(lines[index - 1]); tableLines.add(index - 1); tableLines.add(index); return;
      }
      if (!headers) return;
      tableLines.add(index);
      addClaim(headers.flatMap((header, column) => {const claim = field(header, row[column] ?? ""); return claim ? [claim] : [];}));
    });
    // A heading or explicit path line starts a new section. A table ends any
    // preceding section so its correctly typed claims cannot leak backwards.
    let sectionPaths: string[] = [], sectionHashes: Field[] = [];
    const flush = () => {
      if (sectionPaths.length === 1 && sectionHashes.length) addClaim([{kind: "path", role: "", value: sectionPaths[0]}, ...sectionHashes]);
      else if (sectionPaths.length > 1 && sectionHashes.length) diagnostics.push({code: "ARTIFACT_REPORT_CONFLICT", message: "A prose SHA-256 claim has multiple artifact paths; use one artifact per section or typed path/hash pairs."});
      sectionPaths = []; sectionHashes = [];
    };
    lines.forEach((line, index) => {
      if (tableLines.has(index)) {flush(); return;}
      const assignmentLine = line.replace(/^(\s*(?:[-*]\s+)?)(\*\*|__|`)([A-Za-z][A-Za-z0-9 _-]*?)([:=])\2/, "$1$2$3$2$4");
      const assignment = assignmentLine.match(/^\s*(?:[-*]\s+)?(?:\*\*|__|`)?([A-Za-z][A-Za-z0-9 _-]*?)(?:\*\*|__|`)?\s*[:=]\s*(.*)$/);
      const claim = assignment ? field(assignment[1].trim(), formatted(assignment[2])) : undefined;
      const paths = inText(line);
      if (claim?.kind === "path") {flush(); sectionPaths = [String(claim.value)];}
      else if (paths.length || /^\s*#{1,6}\s/.test(line)) {flush(); sectionPaths = paths;}
      if (claim?.kind === "hash") sectionHashes.push(claim);
    });
    flush();
  }
  for (const path of invalid) matched.delete(path);
  for (const required of requirement.requiredPaths ?? []) {
    const path = aliases.get(normalize(required)) ?? normalize(required);
    if (!matched.has(path)) diagnostics.push({code: "ARTIFACT_REPORT_MISSING", path: required, message: `Required artifact ${required} lacks a current exact path/SHA-256 association in the saved report.`});
  }
  if (matched.size < requirement.minimumRecords) diagnostics.push({code: "ARTIFACT_REPORT_MISSING", message: `The saved report requires ${requirement.minimumRecords} current artifact path/SHA-256 associations; ${matched.size} are verified.`});
  return [...new Map(diagnostics.map(item => [JSON.stringify(item), item])).values()];
}
