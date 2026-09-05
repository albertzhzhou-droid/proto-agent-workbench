import { expandJsonReportBlocks } from "./harness-report-documents.ts";

/** Exact identity fields from successful, run-bound material tool receipts. */
export interface MaterialEvidenceRecord {
  resourceId: string; sequenceSha256?: string; length?: number;
  sourceReferences: string[]; sourceFields?: Record<string, string>; licenseIds: string[]; licenseFields?: Record<string, string>;
}
export interface MaterialEvidenceRequirement {minimumRecords: number; fields: Array<"sequence_sha256" | "source" | "license" | "length">}
export interface MaterialEvidenceDiagnostic {
  code: "MATERIAL_RECORD_COUNT" | "MATERIAL_FIELD_MISSING" | "MATERIAL_HASH_MISMATCH" | "MATERIAL_FIELD_MISMATCH" | "MATERIAL_ID_UNKNOWN" | "MATERIAL_RECEIPT_CONFLICT" | "MATERIAL_REPORT_LIMIT";
  resourceId?: string; field?: "sequence_sha256" | "source" | "license" | "length"; message: string;
}
interface Claims {resourceId: string; hashes: unknown[]; lengths: unknown[]; sources: Array<{field?: string; value: unknown}>; licenses: unknown[]; licenseDetails: Array<{field: string; value: unknown}>}
interface Scan {claims: Claims[]; ids: string[]; limited: boolean; duplicateFields: string[]; identityErrors: string[]}
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const keyOf = (value: string) => value.replace(/[*`"']/g, "").trim().toLowerCase().replace(/[ -]+/g, "_");
const identityField = (key: string) => /^(?:(?:resource|protein|material|part)_)?id$/.test(keyOf(key));
const hashField = (key: string) => /^(?:sequence_(?:sha_?256|hash|digest)|sha_?256)$/.test(keyOf(key));
const lengthField = (key: string) => /^(?:sequence_)?length(?:_?\((?:aa|bp|residues)\))?$/.test(keyOf(key));
const sourceField = (key: string) => /^(?:source|provenance|source_[a-z_]+)$/.test(keyOf(key));
const licenseField = (key: string) => /^(?:licen[cs]e(?:_\(rights\))?|license_id|rights)$/.test(keyOf(key));
const exactToken = (text: string, value: string) => Boolean(value) && new RegExp(`(?<![A-Za-z0-9_.:-])${escape(value)}(?![A-Za-z0-9_.:-])`).test(text);
const newClaims = (resourceId: string): Claims => ({resourceId, hashes: [], lengths: [], sources: [], licenses: [], licenseDetails: []});
const plain = (text: string) => text.trim().replace(/^[*`"']+|[*`"']+$/g, "");
const scalar = (text: string): unknown => {
  // Markdown cells are strings. In particular an all-numeric SHA or source ID
  // must not be rounded through JavaScript's numeric JSON representation.
  const value = plain(text);
  if (/^[{\["]/.test(text.trim())) {try {return JSON.parse(text.trim());} catch { /* Preserve invalid text for a diagnostic. */ }}
  return value;
};

/** Bounded metadata labels in prose; quoted values may contain spaces. Every
 * consumed role remains separate, including a combined release/revision. */
function labeledMetadata(text: string): Array<{field: string; value: string}> | undefined {
  if (!/^\s*(?:provider|record_id|release|revision|url|id|redistribution_status)(?:\s|[:=/])/i.test(text)) return undefined;
  const pairs: Array<{field: string; value: string}> = [];
  let remaining = text;
  for (let count = 0; remaining.trim() && count < 64; count += 1) {
    const match = /^\s*([A-Za-z][A-Za-z0-9_]*(?:\/[A-Za-z][A-Za-z0-9_]*)*)(?:\s*[:=]\s*|\s+)(?:"((?:\\.|[^"\\])*)"|`([^`]*)`|'([^']*)'|([^,;]+?))\s*(?:[,;]\s*|$)/.exec(remaining);
    if (!match) return undefined;
    let value: string;
    try {value = match[2] === undefined ? match[3] ?? match[4] ?? plain(match[5]) : JSON.parse(`"${match[2]}"`) as string;} catch {return undefined;}
    for (const field of match[1].toLowerCase().split("/")) pairs.push({field, value});
    remaining = remaining.slice(match[0].length);
  }
  return remaining.trim() ? undefined : pairs;
}

function addClaim(claims: Claims, key: string, value: unknown): void {
  const normalized = keyOf(key);
  if (hashField(key)) claims.hashes.push(value);
  else if (lengthField(key)) claims.lengths.push(value);
  else if (licenseField(key)) {
    const fields = value && typeof value === "object" && !Array.isArray(value) ? Object.entries(value).map(([field, value]) => ({field, value})) : typeof value === "string" ? labeledMetadata(value) : undefined;
    if (fields?.length) {
      for (const item of fields) if (item.field === "id") claims.licenses.push(item.value); else claims.licenseDetails.push(item);
    } else claims.licenses.push(value);
  }
  else if (sourceField(key)) {
    const field = normalized.startsWith("source_") ? normalized.slice(7) : undefined;
    if (field && field !== "reference") claims.sources.push({field, value});
    else if (value && typeof value === "object" && !Array.isArray(value)) {
      const entries = Object.entries(value);
      for (const [field, value] of entries) claims.sources.push({field, value});
      if (!entries.length) claims.sources.push({value});
    } else {
      const fields = typeof value === "string" ? labeledMetadata(value) : undefined;
      if (fields?.length) claims.sources.push(...fields); else claims.sources.push({value});
    }
  }
}

function scanReport(document: string, records: MaterialEvidenceRecord[]): Scan {
  const result: Scan = {claims: [], ids: [], limited: false, duplicateFields: [], identityErrors: []};
  let parsed: unknown;
  const fenced = /^\s*```(?:json)?\s*\n([\s\S]*)\n```\s*$/i.exec(document);
  try {parsed = JSON.parse(fenced?.[1] ?? document);} catch { /* Explicit text fields below. */ }
  if (parsed && typeof parsed === "object") {
    // A syntactically valid JSON object can repeat a key. JSON.parse alone
    // would erase its earlier incorrect claim when a correct copy follows it.
    const stack: Array<{keys?: Set<string>; expectsKey: boolean}> = [];
    for (const token of (fenced?.[1] ?? document).matchAll(/"(?:\\.|[^"\\])*"|[{}\[\],:]/g)) {
      const value = token[0], frame = stack.at(-1);
      if (value === "{") stack.push({keys: new Set(), expectsKey: true});
      else if (value === "[") stack.push({expectsKey: false});
      else if (value === "}" || value === "]") stack.pop();
      else if (value === ":" && frame) frame.expectsKey = false;
      else if (value === "," && frame?.keys) frame.expectsKey = true;
      else if (value.startsWith('"') && frame?.keys && frame.expectsKey) {
        const key = JSON.parse(value) as string;
        if (frame.keys.has(key)) result.duplicateFields.push(key);
        frame.keys.add(key);
      }
    }
    const pending: unknown[] = [parsed];
    for (let visited = 0; pending.length && visited < 20_000; visited += 1) {
      const value = pending.pop();
      if (!value || typeof value !== "object") continue;
      if (Array.isArray(value)) {for (const item of value) pending.push(item); continue;}
      const object = value as Record<string, unknown>;
      for (const item of Object.values(object)) if (item && typeof item === "object") pending.push(item);
      const metadata = Object.keys(object).some(key => hashField(key) || lengthField(key) || sourceField(key) || licenseField(key));
      const identityEntries = Object.entries(object).filter(([key]) => identityField(key) && (keyOf(key) !== "id" || metadata));
      const identities = identityEntries.flatMap(([, item]) => typeof item === "string" ? [item] : []);
      result.ids.push(...identities);
      if (identityEntries.some(([, item]) => typeof item !== "string" || !item.trim())) result.identityErrors.push("A material identity field must contain one nonempty exact string from its receipt.");
      if (new Set(identities).size > 1) result.identityErrors.push(`One material record contains conflicting identities: ${identities.map(id => JSON.stringify(id)).join(", ")}. Use one unambiguous resource identity per record.`);
      if (new Set(identities).size !== 1) continue;
      const id = identities[0];
      if (!records.some(record => record.resourceId === id)) continue;
      const claims = newClaims(id);
      for (const [key, item] of Object.entries(object)) addClaim(claims, key, item);
      result.claims.push(claims);
    }
    result.limited = pending.length > 0;
    return result;
  }

  const lines = document.split(/\r?\n/);
  let headers: string[] | undefined, section: Claims | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index], table = line.trim().startsWith("|");
    if (table) {
      const cells = line.trim().replace(/^\||\|$/g, "").split("|").map(cell => cell.trim());
      if (cells.every(cell => /^:?-+:?$/.test(cell)) && index > 0) {
        headers = lines[index - 1].trim().replace(/^\||\|$/g, "").split("|").map(cell => cell.trim());
        section = undefined;
      } else if (headers) {
        const idColumn = headers.findIndex(identityField);
        if (idColumn >= 0) {
          const id = plain(cells[idColumn] ?? "");
          result.ids.push(id);
          if (records.some(record => record.resourceId === id)) {
            const claims = newClaims(id);
            headers.forEach((header, column) => addClaim(claims, header, scalar(cells[column] ?? "")));
            result.claims.push(claims);
          }
        }
      }
      continue;
    }
    headers = undefined;
    const ids = records.filter(record => exactToken(line, record.resourceId)).map(record => record.resourceId);
    if (ids.length) {
      section = ids.length === 1 ? newClaims(ids[0]) : undefined;
      if (section) {result.claims.push(section); result.ids.push(section.resourceId);}
    }
    const labeled = /^\s*(?:[-*]\s+)?[*`"']*([^:=\n]+?)[*`"']*\s*[:=]\s*(.*)$/.exec(line);
    if (labeled) {
      if (identityField(labeled[1])) {
        const id = plain(labeled[2]); result.ids.push(id);
        if (!records.some(record => record.resourceId === id)) section = undefined;
      }
      if (section) addClaim(section, labeled[1], scalar(labeled[2]));
    }
  }
  const namespaces = [...new Set(records.flatMap(record => /^([A-Za-z][A-Za-z0-9_.-]*):/.exec(record.resourceId)?.slice(1) ?? []))];
  for (const namespace of namespaces) for (const match of document.matchAll(new RegExp(`(?<![A-Za-z0-9_.-])${escape(namespace)}:[A-Za-z0-9][A-Za-z0-9_.-]*`, "gi"))) result.ids.push(match[0].replace(/[.,]+$/, ""));
  return result;
}

function parsedLength(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  if (typeof value !== "string") return undefined;
  const match = /^(\d+|\d{1,3}(?:,\d{3})+)\s*(?:aa|bp|nt|residues)?$/i.exec(plain(value));
  const length = match ? Number(match[1].replaceAll(",", "")) : NaN;
  return Number.isSafeInteger(length) ? length : undefined;
}
function licenseIdentity(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return /^\[([^\]]+)\]\([^\s)]+\)$/.exec(value.trim())?.[1] ?? plain(value);
}
function sourceTextIsBound(value: string, references: string[]): boolean {
  if (!references.some(reference => value.includes(reference))) return false;
  // Joining literal references with labels or Markdown is supported; notes do
  // not donate values to a different typed source field.
  let remainder = value;
  for (const reference of [...references].sort((a, b) => b.length - a.length)) remainder = remainder.replaceAll(reference, "");
  remainder = remainder.replace(/\b(?:provider|source|record(?:_id)?|url|reference|and)\b|来源|提供者|编号|链接|和/gi, "");
  return !/[^\s|,;:()[\]{}<>*_`'"./\\&+·，；：、（）【】]/u.test(remainder);
}

/** Validate typed report fields, not incidental strings in notes or examples.
 * The caller supplies current saved documents, never a substitute summary. */
export function verifyMaterialEvidence(records: MaterialEvidenceRecord[], documents: string[], requirement: MaterialEvidenceRequirement): MaterialEvidenceDiagnostic[] {
  const diagnostics: MaterialEvidenceDiagnostic[] = [], unique = new Map<string, MaterialEvidenceRecord>();
  for (const record of records) {
    const previous = unique.get(record.resourceId);
    const signature = (item: MaterialEvidenceRecord) => JSON.stringify([item.sequenceSha256?.toLowerCase(), item.length, [...item.sourceReferences].sort(), item.sourceFields, [...item.licenseIds].sort(), item.licenseFields]);
    if (previous && signature(previous) !== signature(record)) diagnostics.push({code: "MATERIAL_RECEIPT_CONFLICT", resourceId: record.resourceId, message: `Conflicting snapshot-bound receipts for ${record.resourceId}; retrieve an unambiguous record before completion.`});
    else unique.set(record.resourceId, record);
  }
  const expanded = expandJsonReportBlocks(documents);
  for (const message of expanded.errors) diagnostics.push({code: "MATERIAL_FIELD_MISMATCH", message});
  const known = [...unique.values()], scans = expanded.documents.map(document => scanReport(document, known));
  if (scans.some(scan => scan.limited)) diagnostics.push({code: "MATERIAL_REPORT_LIMIT", message: "Material report exceeds the bounded structured-record limit; use a smaller report before completing."});
  for (const key of new Set(scans.flatMap(scan => scan.duplicateFields))) diagnostics.push({code: "MATERIAL_FIELD_MISMATCH", message: `Duplicate material field ${JSON.stringify(key)} is ambiguous. Keep one explicit value per JSON key; a later value cannot erase an earlier claim.`});
  for (const message of new Set(scans.flatMap(scan => scan.identityErrors))) diagnostics.push({code: "MATERIAL_FIELD_MISMATCH", message});
  for (const id of new Set(scans.flatMap(scan => scan.ids))) if (!unique.has(id)) diagnostics.push({code: "MATERIAL_ID_UNKNOWN", resourceId: id, message: `Reported identity ${id} was not returned by a successful receipt in this task.`});
  const claims = scans.filter(scan => !scan.limited).flatMap(scan => scan.claims);
  let complete = 0;
  for (const record of known) {
    const relevant = claims.filter(claim => claim.resourceId === record.resourceId);
    if (!relevant.length) continue;
    const start = diagnostics.length, hash = record.sequenceSha256?.toLowerCase();
    const hashes = relevant.flatMap(claim => claim.hashes), lengths = relevant.flatMap(claim => claim.lengths), licenses = relevant.flatMap(claim => claim.licenses), sources = relevant.flatMap(claim => claim.sources);
    for (const value of hashes) if (typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value) || value.toLowerCase() !== hash) diagnostics.push({code: "MATERIAL_HASH_MISMATCH", resourceId: record.resourceId, field: "sequence_sha256", message: `Sequence SHA-256 for ${record.resourceId}: expected ${hash ?? "an available receipt"}; reported ${JSON.stringify(value)}. Preserve all 64 characters.`});
    for (const value of lengths) if (record.length === undefined || parsedLength(value) !== record.length) diagnostics.push({code: "MATERIAL_FIELD_MISMATCH", resourceId: record.resourceId, field: "length", message: `Length for ${record.resourceId}: expected ${record.length ?? "an available receipt"}; reported ${JSON.stringify(value)}.`});
    for (const value of licenses) if (!record.licenseIds.includes(licenseIdentity(value) ?? "")) diagnostics.push({code: "MATERIAL_FIELD_MISMATCH", resourceId: record.resourceId, field: "license", message: `License for ${record.resourceId} must be the exact receipt identity ${record.licenseIds.join(" or ")}; reported ${JSON.stringify(value)}.`});
    for (const claim of relevant.flatMap(item => item.licenseDetails)) if (typeof claim.value !== "string" || record.licenseFields?.[claim.field] !== claim.value) diagnostics.push({code: "MATERIAL_FIELD_MISMATCH", resourceId: record.resourceId, field: "license", message: `License ${claim.field} for ${record.resourceId} must match its receipt: expected ${JSON.stringify(record.licenseFields?.[claim.field])}; reported ${JSON.stringify(claim.value)}.`});
    for (const source of sources) {
      const expected = source.field ? record.sourceFields?.[source.field] : undefined;
      const bound = typeof source.value === "string" && (source.field ? record.sourceFields ? expected !== undefined && source.value === expected : ["provider", "record_id", "url"].includes(source.field) && record.sourceReferences.includes(source.value) : sourceTextIsBound(source.value, record.sourceReferences));
      if (!bound) diagnostics.push({code: "MATERIAL_FIELD_MISMATCH", resourceId: record.resourceId, field: "source", message: `Source ${source.field ?? "reference"} for ${record.resourceId} does not match its receipt: ${JSON.stringify(source.value)}. Expected ${expected ?? record.sourceReferences.join("; ")}.`});
    }
    for (const field of requirement.fields) {
      const present = field === "sequence_sha256" ? hashes.some(value => typeof value === "string" && /^[a-f0-9]{64}$/i.test(value) && value.toLowerCase() === hash)
        : field === "length" ? lengths.some(value => record.length !== undefined && parsedLength(value) === record.length)
        : field === "license" ? licenses.some(value => record.licenseIds.includes(licenseIdentity(value) ?? ""))
        : record.sourceReferences.length > 0 && record.sourceReferences.every(reference => sources.some(source => typeof source.value === "string" && (source.field ? source.value === reference : exactToken(source.value, reference))));
      if (!present) diagnostics.push({code: "MATERIAL_FIELD_MISSING", resourceId: record.resourceId, field, message: `The saved report must associate ${record.resourceId} with a typed ${field} field from its receipt: ${field === "sequence_sha256" ? hash : field === "length" ? record.length : field === "source" ? record.sourceReferences.join("; ") : record.licenseIds.join(" or ")}. Use one resource per table row or JSON object.`});
    }
    if (start === diagnostics.length) complete += 1;
  }
  if (complete < requirement.minimumRecords) diagnostics.push({code: "MATERIAL_RECORD_COUNT", message: `The saved report requires ${requirement.minimumRecords} distinct material records with their requested fields; ${complete} are currently verified.`});
  return [...new Map(diagnostics.map(diagnostic => [JSON.stringify(diagnostic), diagnostic])).values()];
}
