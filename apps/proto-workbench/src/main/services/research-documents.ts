import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, realpath, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { createRequire } from "node:module";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { fromBuffer, type Entry } from "yauzl";
import * as pdf from "pdfjs-dist/legacy/build/pdf.mjs";
import type { ResearchDocument, ResearchDocumentPage, ResearchDocumentUnit } from "../../shared/research-chat.ts";

export const DOCUMENT_INPUT_LIMIT = 20 * 1024 * 1024;
export const DOCUMENT_BASE64_LIMIT = 4 * Math.ceil(DOCUMENT_INPUT_LIMIT / 3);
const EXPANDED_LIMIT = 64 * 1024 * 1024;
const XML_LIMIT = 24 * 1024 * 1024;
const TEXT_LIMIT = 8 * 1024 * 1024;
const ARTIFACT_LIMIT = 24 * 1024 * 1024;
const UNIT_TEXT_LIMIT = 12_000;
const FORMAT_EXTENSIONS = new Set([".pdf", ".docx", ".xlsx"]);
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
type Parsed = { units: ResearchDocumentUnit[]; warnings: string[] };
type XmlNode = Record<string, unknown>;

export function isResearchDocument(path: string): boolean { return FORMAT_EXTENSIONS.has(extname(path).toLowerCase()); }
function contained(root: string, path: string): void {
  const rel = relative(root, path);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Document path must stay inside the current workspace.");
}
function sameFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}
export async function readContained(workspace: string, inputPath: string, limit: number): Promise<Buffer> {
  const root = await realpath(workspace);
  const path = resolve(root, inputPath);
  contained(root, path);
  // Reject linked ancestors as well as the final file, including Windows junctions.
  let current = root;
  for (const part of relative(root, path).split(sep).filter(Boolean)) {
    current = join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new Error("Document paths cannot follow symbolic links or junctions.");
  }
  const before = await lstat(path);
  if (!before.isFile() || before.nlink !== 1 || before.size > limit) throw new Error(`Document must be a regular file no larger than ${Math.floor(limit / 1024 / 1024)} MiB.`);
  const canonical = await realpath(path); contained(root, canonical);
  const handle = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!sameFile(before, opened) || opened.nlink !== 1) throw new Error("Document changed before it could be read.");
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (!sameFile(opened, after) || after.nlink !== 1 || bytes.length !== opened.size || bytes.length > limit) throw new Error("Document changed while it was being read.");
    return bytes;
  } finally { await handle.close(); }
}
async function outputDirectory(workspace: string, sessionId: string, documentId: string): Promise<string> {
  if (![sessionId, documentId].every(value => /^[a-f0-9-]{36}$/i.test(value))) throw new Error("Invalid document storage identifier.");
  const root = await realpath(workspace); let directory = root;
  for (const part of ["build", "chat", sessionId, "documents", documentId]) {
    directory = join(directory, part);
    await mkdir(directory).catch(error => { if (error.code !== "EEXIST") throw error; });
    const info = await lstat(directory); contained(root, await realpath(directory));
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Document output must be a regular workspace directory.");
  }
  return directory;
}
function validatedName(name: string): string {
  if (!name || name.length > 120 || /[\\/\x00-\x1f]/.test(name) || !isResearchDocument(name)) throw new Error("Choose a PDF, DOCX or XLSX document.");
  return name;
}
export async function importResearchDocument(input: { workspace: string; sessionId: string; name?: string; base64?: string; path?: string }): Promise<ResearchDocument> {
  const name = validatedName(input.path ? basename(input.path) : input.name ?? "");
  let bytes: Buffer;
  if (input.path) bytes = await readContained(input.workspace, input.path, DOCUMENT_INPUT_LIMIT);
  else {
    const encoded = input.base64 ?? "";
    if (!encoded.length || encoded.length > DOCUMENT_BASE64_LIMIT || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error("Invalid base64 attachment or oversized document; maximum file size is 20 MiB.");
    bytes = Buffer.from(encoded, "base64");
    if (bytes.toString("base64") !== encoded) throw new Error("Attachment is not canonical base64 data.");
  }
  if (!bytes.length || bytes.length > DOCUMENT_INPUT_LIMIT) throw new Error("Document size must be between 1 byte and 20 MiB.");
  const format = extname(name).slice(1).toLowerCase() as "pdf" | "docx" | "xlsx";
  const parsed = await parseResearchDocument(bytes, format);
  const id = randomUUID();
  const directory = await outputDirectory(input.workspace, input.sessionId, id);
  const sourceName = `source.${format}`;
  const sourceSha256 = hash(bytes);
  const text = parsed.units.map(unit => `[${unit.locator}]\n${unit.text}`).join("\n\n");
  const record = JSON.stringify({ schema: "proto-research-document-v1", format, sourceName: name, sourceSha256, sourceBytes: bytes.length, complete: true, warnings: parsed.warnings, units: parsed.units }, null, 2);
  if (Buffer.byteLength(record) > ARTIFACT_LIMIT) throw new Error("Structured extraction exceeds 24 MiB. Split the document into smaller files.");
  await writeFile(join(directory, sourceName), bytes, { flag: "wx" });
  await writeFile(join(directory, "extraction.json"), record, { flag: "wx", encoding: "utf8" });
  await writeFile(join(directory, "extracted.txt"), text, { flag: "wx", encoding: "utf8" });
  const rel = (file: string) => relative(input.workspace, join(directory, file)).replaceAll("\\", "/");
  const preview = text.slice(0, UNIT_TEXT_LIMIT);
  return { id, name, content: preview, revision: 1, source: input.path ?? rel(sourceName), sourceSha256,
    extraction: { format, sourceName: name, sourceBytes: bytes.length, sourcePath: rel(sourceName), extractionPath: rel("extraction.json"), extractionSha256: hash(record), textPath: rel("extracted.txt"), unitCount: parsed.units.length, totalCharacters: text.length, previewCharacters: preview.length, complete: true, warnings: parsed.warnings } };
}

export async function readResearchDocument(workspace: string, document: ResearchDocument, startUnit = 0, limit = 5): Promise<ResearchDocumentPage> {
  if (!document.extraction) throw new Error("This is an editable text document, not a parsed source document.");
  if (!Number.isInteger(startUnit) || startUnit < 0 || !Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error("Use a nonnegative unit offset and a limit between 1 and 20.");
  const bytes = await readContained(workspace, document.extraction.extractionPath, ARTIFACT_LIMIT);
  if (hash(bytes) !== document.extraction.extractionSha256) throw new Error("The saved extraction changed. Import the source again to create a new verified extraction.");
  const parsed = JSON.parse(bytes.toString("utf8")) as { sourceSha256: string; units: ResearchDocumentUnit[] };
  if (parsed.sourceSha256 !== document.sourceSha256 || !Array.isArray(parsed.units)) throw new Error("Document extraction provenance does not match its source.");
  const units: ResearchDocumentUnit[] = []; let size = 0;
  for (const unit of parsed.units.slice(startUnit, startUnit + limit)) {
    const length = JSON.stringify(unit).length;
    if (units.length && size + length > 32_000) break;
    units.push(unit); size += length;
  }
  const next = startUnit + units.length;
  return { documentId: document.id, sourceName: document.name, sourceSha256: parsed.sourceSha256, totalUnits: parsed.units.length, startUnit, nextUnit: next < parsed.units.length ? next : null, units, warnings: document.extraction.warnings };
}

export async function parseResearchDocument(bytes: Buffer, format: "pdf" | "docx" | "xlsx"): Promise<Parsed> {
  if (bytes.length > DOCUMENT_INPUT_LIMIT) throw new Error("Document exceeds the 20 MiB input limit.");
  const parsed = format === "pdf" ? await parsePdf(bytes) : await parseOffice(bytes, format);
  if (!parsed.units.length) parsed.warnings.push("No readable text was found in this document.");
  return parsed;
}
function unitWriter(units: ResearchDocumentUnit[]) {
  let total = 0;
  return (value: Omit<ResearchDocumentUnit, "index">) => {
    total += Buffer.byteLength(JSON.stringify(value));
    if (total > TEXT_LIMIT || units.length >= 50_000) throw new Error("Extraction exceeds the 8 MiB text or 50,000 section limit. Split the source document; nothing was silently truncated.");
    // Split large pages/paragraphs while preserving the exact text and locator.
    const chunks = Math.max(1, Math.ceil(value.text.length / UNIT_TEXT_LIMIT));
    for (let offset = 0; offset < chunks; offset++) units.push({ ...value, index: units.length, locator: value.locator + (chunks > 1 ? ` · part ${offset + 1}/${chunks}` : ""), text: value.text.slice(offset * UNIT_TEXT_LIMIT, (offset + 1) * UNIT_TEXT_LIMIT) });
  };
}
async function parsePdf(bytes: Buffer): Promise<Parsed> {
  if (bytes.subarray(0, 1024).indexOf("%PDF-") < 0) throw new Error("The attached file is not a PDF document.");
  // Keep the library import at module initialization. The source preview's
  // Vite config runner closes after evaluation; a deferred runner import would
  // fail here even though the HTTP service itself is still alive.
  const require = createRequire(import.meta.url);
  const packageRoot = resolve(require.resolve("pdfjs-dist/package.json"), "..");
  const task = pdf.getDocument({ data: new Uint8Array(bytes), useWorkerFetch: false, useWasm: false, enableXfa: false, disableFontFace: true, standardFontDataUrl: join(packageRoot, "standard_fonts").replaceAll("\\", "/") + "/", cMapUrl: join(packageRoot, "cmaps").replaceAll("\\", "/") + "/", cMapPacked: true, verbosity: 0, stopAtErrors: true });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; void task.destroy(); }, 45_000);
  const units: ResearchDocumentUnit[] = []; const warnings: string[] = []; const add = unitWriter(units);
  try {
    const document = await task.promise;
    if (document.numPages > 1000) throw new Error("PDF exceeds the 1,000 page limit. Import a smaller page range.");
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      if (timedOut) throw new Error("PDF extraction exceeded its 45 second time limit.");
      const page = await document.getPage(pageNumber); const content = await page.getTextContent();
      const text = content.items.map(item => "str" in item ? item.str + (item.hasEOL ? "\n" : " ") : "").join("").trim();
      add({ kind: "page", locator: `Page ${pageNumber}`, page: pageNumber, text });
      if (!text) warnings.push(`Page ${pageNumber} has no selectable text; scanned images require OCR.`);
      page.cleanup();
    }
    warnings.push("PDF text follows the file's text order; complex columns and mathematical layout may require checking the original.");
    return { units, warnings };
  } catch (error) {
    if (timedOut) throw new Error("PDF extraction exceeded its 45 second time limit.");
    if (error instanceof Error && error.name === "PasswordException") throw new Error("This PDF is password protected. Attach an unlocked copy.");
    throw error;
  } finally { clearTimeout(timer); await task.destroy(); }
}

async function officeXml(bytes: Buffer, format: "docx" | "xlsx"): Promise<Map<string, string>> {
  return new Promise((resolveResult, reject) => {
    fromBuffer(bytes, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error, archive) => {
      if (error || !archive) { reject(new Error(`Cannot open the ${format.toUpperCase()} archive: ${error?.message ?? "invalid file"}`)); return; }
      const files = new Map<string, string>(); const names = new Set<string>(); let expanded = 0; let extracted = 0; let count = 0; let finished = false;
      const timer = setTimeout(() => fail(new Error("Office extraction exceeded its 30 second time limit.")), 30_000);
      function fail(error: Error) { if (finished) return; finished = true; clearTimeout(timer); archive!.close(); reject(error); }
      archive.on("error", fail);
      archive.on("end", () => { if (!finished) { finished = true; clearTimeout(timer); resolveResult(files); } });
      archive.on("entry", (entry: Entry) => {
        if (finished) return;
        count++; expanded += entry.uncompressedSize;
        if (count > 10_000 || expanded > EXPANDED_LIMIT || entry.uncompressedSize > XML_LIMIT) { fail(new Error("Office archive exceeds the bounded expansion limit (64 MiB total, 24 MiB per entry, 10,000 entries).")); return; }
        if (names.has(entry.fileName) || entry.fileName.startsWith("/") || entry.fileName.split("/").includes("..") || entry.isEncrypted()) { fail(new Error("Office archive contains duplicate, unsafe or encrypted entries.")); return; }
        names.add(entry.fileName);
        const wanted = format === "docx" ? /^word\/(?:document|header\d+|footer\d+|footnotes|endnotes|comments)\.xml$/.test(entry.fileName) : /^xl\/(?:workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|styles\.xml|worksheets\/sheet\d+\.xml)$/.test(entry.fileName);
        if (!wanted) { archive.readEntry(); return; }
        archive.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) { fail(streamError ?? new Error("Cannot read Office archive entry.")); return; }
          const chunks: Buffer[] = []; let length = 0;
          stream.on("error", fail);
          stream.on("data", (chunk: Buffer) => {
            length += chunk.length; extracted += chunk.length;
            if (length > XML_LIMIT || extracted > EXPANDED_LIMIT) { stream.destroy(); fail(new Error("Office data exceeded its declared decompression budget.")); return; }
            chunks.push(chunk);
          });
          stream.on("end", () => { if (!finished) { files.set(entry.fileName, Buffer.concat(chunks).toString("utf8")); archive.readEntry(); } });
        });
      });
      archive.readEntry();
    });
  });
}
function xml(source: string, ordered = false): any {
  // Only predefined XML character entities are accepted. No DTD, external
  // resource loading, macro execution or spreadsheet formula evaluation.
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) throw new Error("Document XML cannot contain DTD or entity declarations.");
  let depth = 0;
  for (const token of source.matchAll(/<\/?[^>]+>/g)) {
    if (/^<\//.test(token[0])) depth--;
    else if (!/^<[!?]/.test(token[0]) && !/\/>$/.test(token[0])) depth++;
    if (depth > 128) throw new Error("Document XML nesting exceeds the supported limit.");
  }
  const validation = XMLValidator.validate(source);
  if (validation !== true) throw new Error("Document contains malformed XML.");
  return new XMLParser({ preserveOrder: ordered, ignoreAttributes: false, attributeNamePrefix: "@_", parseTagValue: false, parseAttributeValue: false, trimValues: false, processEntities: true }).parse(source);
}
const list = <T>(value: T | T[] | undefined): T[] => value === undefined ? [] : Array.isArray(value) ? value : [value];
function plain(value: any): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "object") return String(value);
  return String(value["#text"] ?? "");
}
function richText(value: any): string { return value ? plain(value.t) + list(value.r).map((run: any) => plain(run.t)).join("") : ""; }
function orderedText(nodes: XmlNode[]): string {
  let result = "";
  for (const node of nodes) {
    for (const [tag, value] of Object.entries(node)) {
      if (tag === "#text") result += value;
      else if (tag === "w:tab") result += "\t";
      else if (tag === "w:br" || tag === "w:cr") result += "\n";
      else if (tag === "w:p" && Array.isArray(value)) result += orderedText(value) + "\n";
      else if (["w:del", "w:instrText", "w:delText", ":@"].includes(tag)) continue;
      else if (Array.isArray(value)) result += orderedText(value);
    }
  }
  return result;
}
async function parseOffice(bytes: Buffer, format: "docx" | "xlsx"): Promise<Parsed> {
  const files = await officeXml(bytes, format);
  const units: ResearchDocumentUnit[] = []; const warnings: string[] = []; const add = unitWriter(units);
  if (format === "docx") {
    if (!files.has("word/document.xml")) throw new Error("DOCX is missing its main document part.");
    let paragraph = 0; let table = 0;
    function walk(nodes: XmlNode[], part: string) {
      for (const node of nodes) for (const [tag, children] of Object.entries(node)) {
        if (!Array.isArray(children)) continue;
        if (tag === "w:p") { paragraph++; const text = orderedText(children); if (text.trim()) add({ kind: "paragraph", locator: `${part} · paragraph ${paragraph}`, paragraph, text }); }
        else if (tag === "w:tbl") {
          table++; let row = 0;
          for (const item of children) if (Array.isArray(item["w:tr"])) {
            row++; const cells = item["w:tr"].filter((cell: XmlNode) => Array.isArray(cell["w:tc"])).map((cell: XmlNode) => orderedText(cell["w:tc"] as XmlNode[]).trimEnd());
            add({ kind: "table-row", locator: `${part} · table ${table}, row ${row}`, text: cells.join("\t") });
          }
        } else if (tag !== "w:del") walk(children, part);
      }
    }
    const parts = ["word/document.xml", ...[...files.keys()].filter(part => part !== "word/document.xml").sort()];
    for (const part of parts) walk(xml(files.get(part)!, true), part);
    warnings.push("Paragraphs and table rows retain source-part locators. Images, embedded objects and original page layout are not rendered; tracked deletions are omitted.");
  } else {
    const workbookSource = files.get("xl/workbook.xml"); const relationSource = files.get("xl/_rels/workbook.xml.rels");
    if (!workbookSource || !relationSource) throw new Error("XLSX is missing its workbook or worksheet relationships.");
    const workbook = xml(workbookSource).workbook;
    const relationships = list<any>(xml(relationSource).Relationships?.Relationship);
    const strings = files.has("xl/sharedStrings.xml") ? list<any>(xml(files.get("xl/sharedStrings.xml")!).sst?.si).map(richText) : [];
    const sheets = list<any>(workbook?.sheets?.sheet);
    if (sheets.length > 256 || strings.length > 200_000) throw new Error("Workbook exceeds 256 sheets or 200,000 shared strings.");
    let count = 0; let formulaCount = 0;
    for (const sheet of sheets) {
      const relation = relationships.find(item => item["@_Id"] === sheet["@_r:id"]);
      if (!relation || relation["@_TargetMode"] === "External") throw new Error("Workbook worksheet relationship must reference an internal XML part.");
      const target = String(relation["@_Target"] ?? "");
      const part = target.startsWith("/") ? target.slice(1) : posix.normalize(posix.join("xl", target));
      if (!/^xl\/worksheets\/sheet\d+\.xml$/.test(part) || !files.has(part)) throw new Error("Workbook worksheet path is unsupported or missing.");
      const name = String(sheet["@_name"] ?? "Unnamed sheet");
      if (sheet["@_state"] && sheet["@_state"] !== "visible") warnings.push(`Sheet ${name} is ${sheet["@_state"]}; its cells are included and labelled.`);
      const data = xml(files.get(part)!).worksheet;
      let cells: NonNullable<ResearchDocumentUnit["cells"]> = []; let lines: string[] = [];
      function flush() {
        if (!cells.length) return;
        // Worksheet XML lists cells by row. The last populated cell can be
        // left of an earlier cell, so first/last addresses are not a rectangle.
        const positions = cells.map(cell => {
          const match = /^([A-Z]+)(\d+)$/.exec(cell.address)!;
          return { column: [...match[1]].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0), row: Number(match[2]) };
        });
        const columnName = (value: number) => {
          let name = "";
          while (value > 0) { value--; name = String.fromCharCode(65 + value % 26) + name; value = Math.floor(value / 26); }
          return name;
        };
        const range = `${columnName(Math.min(...positions.map(cell => cell.column)))}${Math.min(...positions.map(cell => cell.row))}:${columnName(Math.max(...positions.map(cell => cell.column)))}${Math.max(...positions.map(cell => cell.row))}`;
        add({ kind: "sheet-rows", locator: `Sheet ${name} · ${range}`, sheet: name, range, text: lines.join("\n"), cells });
        cells = []; lines = [];
      }
      for (const row of list<any>(data?.sheetData?.row)) for (const cell of list<any>(row.c)) {
        if (++count > 100_000) throw new Error("Workbook exceeds 100,000 populated cells. Import selected sheets or a smaller range.");
        const address = String(cell["@_r"] ?? "");
        if (!/^[A-Z]{1,3}[1-9]\d{0,6}$/.test(address)) throw new Error("Workbook contains a missing or invalid cell address.");
        const type = String(cell["@_t"] ?? "n");
        const raw = plain(cell.v);
        let value = type === "s" ? strings[Number(raw)] : type === "inlineStr" ? richText(cell.is) : type === "b" ? raw === "1" ? "TRUE" : "FALSE" : raw;
        if (value === undefined) throw new Error("Workbook shared-string index is invalid.");
        const formula = cell.f !== undefined ? plain(cell.f) : undefined;
        if (formula !== undefined) formulaCount++;
        const line = `${address}\t${value}${formula !== undefined ? `\t[formula: ${formula}; cached value only]` : ""}`;
        if (line.length > UNIT_TEXT_LIMIT) throw new Error("Workbook contains a cell larger than 12,000 characters. Extract that cell separately.");
        if (cells.length >= 50 || lines.join("\n").length + line.length > 8_000) flush();
        cells.push({ address, value, type, ...(formula !== undefined ? { formula } : {}) }); lines.push(line);
      }
      flush();
      if (!list(data?.sheetData?.row).length) add({ kind: "sheet-rows", locator: `Sheet ${name} · empty`, sheet: name, text: "This sheet has no populated rows.", cells: [] });
    }
    warnings.push(`Read cell values from ${sheets.length} sheet(s); ${formulaCount} formula(s) retain cached values and were not recalculated. Numeric dates retain their spreadsheet serial values. Charts, formatting and external links are not evaluated.`);
  }
  return { units, warnings };
}
