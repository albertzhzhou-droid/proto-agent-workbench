import type { BlockingClass, HarnessDiagnostic, ToolResultEnvelope } from "../../shared/harness.ts";
import type { WorkspaceFiles } from "./workspace-files.ts";
import { parseDesignIr } from "../../renderer/design-visualization.ts";
import { artifactReaders } from "./artifact-reader-registry.ts";
import { harnessDiagnostic } from "./harness-diagnostics.ts";

type Fingerprint = {path: string; sha256: string};
const recorded = (result: ToolResultEnvelope, file: Fingerprint) => (result.data._harnessArtifacts as Fingerprint[] | undefined)?.some(item => item.path.toLowerCase() === file.path.toLowerCase() && item.sha256 === file.sha256);
const checkedDnaPatch = (result: ToolResultEnvelope) => {
  const validation = result.data.validation as {ok?: boolean; steps?: Array<{tool?: string; status?: string}>} | undefined;
  return ["workspace_propose_patch", "workspace_resume_validation"].includes(result.tool) && validation?.ok === true && ["proto_check", "proto_workflow_run", "proto_provenance_verify", "proto_review_packet"].every(tool => validation.steps?.some(step => step.tool === tool && step.status === "completed"));
};
const compiledByHost = (result: ToolResultEnvelope) => ["proto_compile", "proto_protein_compile"].includes(result.tool) || checkedDnaPatch(result);

/** Scientific extension/schema gates are independent of model-chosen kinds. */
export async function verifyScientificArtifact(workspace: WorkspaceFiles, file: Fingerprint, results: ToolResultEnvelope[]): Promise<HarnessDiagnostic[]> {
  const diagnostics: HarnessDiagnostic[] = [];
  const producers = results.filter(result => result.ok && recorded(result, file));
  const push = (code: string, message: string, blockingClass: BlockingClass = "repairable") => diagnostics.push(harnessDiagnostic(code, file.path, message, blockingClass, producers));
  let staleInput = false;
  const currentInput = async (input: Fingerprint) => {
    const current = await workspace.artifactFingerprint(input.path).catch(() => undefined);
    if (current?.sha256 === input.sha256) return true;
    staleInput = true;
    return false;
  };
  const currentCompilation = async (result: ToolResultEnvelope) => {
    if (!result.ok || !compiledByHost(result)) return false;
    const validation = result.data.validation as {source?: string; sha256?: string; materialBinding?: {partsPath?: string; partsSha256?: string}} | undefined;
    const input = result.data._harnessInputs as (Fingerprint & {materialBinding?: {partsPath?: string; partsSha256?: string}}) | undefined;
    const source = checkedDnaPatch(result) ? {path: validation?.source, sha256: validation?.sha256} : input;
    if (!source?.path || !source.sha256 || !(await currentInput({path: source.path, sha256: source.sha256}))) return false;
    const material = validation?.materialBinding ?? input?.materialBinding;
    return !material || Boolean(material.partsPath && material.partsSha256 && await currentInput({path: material.partsPath, sha256: material.partsSha256}));
  };
  if (/\.(pdb|cif|mmcif|ent)$/i.test(file.path)) {
    if (!producers.some(result => ["proto_structure_fetch", "proto_structure_import_workspace"].includes(result.tool))) push("STRUCTURE_RECEIPT_MISSING", `Coordinate artifact lacks a verified structure import/fetch receipt: ${file.path}`);
    return diagnostics;
  }
  if (!/\.(json|fasta|fa|fas|gb|gbk|genbank|ttl|sbol)$/i.test(file.path)) return diagnostics;
  let text: string;
  try { text = (await workspace.read(file.path)).content; }
  catch (error) { return [harnessDiagnostic("DELIVERABLE_UNREADABLE", file.path, `Cannot reopen ${file.path}: ${String(error)}`, "stale", producers)]; }
  let json: Record<string, unknown> | undefined;
  if (/\.json$/i.test(file.path)) {try {json = JSON.parse(text);} catch { /* IR-named files still fail the strict parser below. */ }}
  const reader=artifactReaders.inspect(json);
  if(reader?.readOnly)return [harnessDiagnostic(reader.code, file.path, `${reader.code}: ${reader.message} (${file.path})`, "unsupported", producers)];
  const isIr = /\.ir\.json$/i.test(file.path) || /^proto-agent\.ir\.v[12]$/.test(String(json?.schema_version));
  if (isIr) {
    const parsed = parseDesignIr(text);
    if (!parsed.ok) push("SCIENTIFIC_IR_INVALID", `Scientific IR failed schema, sequence or digest validation: ${file.path}`);
    if (!(await Promise.all(producers.map(currentCompilation))).some(Boolean)) push("SCIENTIFIC_COMPILATION_MISSING", `Scientific IR lacks a matching current-source compiler/workflow receipt: ${file.path}`, staleInput ? "stale" : "repairable");
    return diagnostics;
  }
  if (String(json?.schema_version).startsWith("proto-agent.protein-selection.")) {
    if (!producers.some(result => result.tool === "proto_materials_materialize_proteins")) push("PROTEIN_MATERIALIZATION_MISSING", `Protein selection lacks a governed materialization receipt: ${file.path}`);
    if (!results.some(result => result.tool === "proto_protein_compile" && result.ok && (result.data._harnessInputs as Fingerprint | undefined)?.sha256 === file.sha256)) push("PROTEIN_COMPILE_MISSING", `Protein selection lacks a matching compile receipt: ${file.path}`);
    return diagnostics;
  }
  const format = /\.(fasta|fa|fas)$/i.test(file.path) ? "fasta" : /\.(gb|gbk|genbank)$/i.test(file.path) ? "genbank" : /\.(ttl|sbol)$/i.test(file.path) ? "sbol" : undefined;
  if (!format) return diagnostics;
  const exports = producers.filter(result => result.tool === "proto_export" && (result.data._harnessArguments as {format?: string} | undefined)?.format === format);
  let verified = false;
  for (const exported of exports) {
    const input = exported.data._harnessInputs as Fingerprint | undefined;
    if (!input?.path || !input.sha256 || !(await Promise.all(results.filter(result => recorded(result, input)).map(currentCompilation))).some(Boolean)) continue;
    if (!(await currentInput(input))) continue;
    const parsed = parseDesignIr((await workspace.read(input.path)).content);
    if (!parsed.ok || !parsed.design) continue;
    const expected = parsed.design.domain === "protein" ? parsed.design.proteins.map(protein => protein.sequence).join("") : parsed.design.sequence;
    if (format === "fasta") {
      const sequence = text.split(/\r?\n/).filter(line => !line.startsWith(">")).join("").replace(/\s/g, "").toUpperCase();
      verified = text.startsWith(">") && Boolean(expected) && sequence === expected.toUpperCase();
    } else if (format === "genbank") {
      const sequence = [...text.matchAll(/\bORIGIN\b([\s\S]*?)\/\//g)].map(match => match[1].replace(/[^A-Za-z]/g, "")).join("").toUpperCase();
      verified = text.startsWith("LOCUS") && Boolean(expected) && sequence === expected.toUpperCase();
    } else verified = results.some(result => result.ok && result.tool === "proto_validate_sbol" && (result.data._harnessInputs as Fingerprint | undefined)?.sha256 === file.sha256);
    if (verified) break;
  }
  // The governed DNA workflow itself emits compiler-derived FASTA/GenBank.
  // Its checked patch receipt binds source, library, IR and exported bytes.
  if (!verified && format !== "sbol") for (const producer of producers.filter(checkedDnaPatch)) {
    if (!(await currentCompilation(producer))) continue;
    const candidates = (producer.data._harnessArtifacts as Fingerprint[] | undefined)?.filter(item => /\.ir\.json$/i.test(item.path)) ?? [];
    for (const candidate of candidates) {
      if (!(await currentInput(candidate))) continue;
      const parsed = parseDesignIr((await workspace.read(candidate.path)).content);
      if (!parsed.ok || parsed.design?.domain !== "dna" || !parsed.design.sequence) continue;
      const actual = format === "fasta" ? text.split(/\r?\n/).filter(line => !line.startsWith(">")).join("").replace(/\s/g, "") : [...text.matchAll(/\bORIGIN\b([\s\S]*?)\/\//g)].map(match => match[1].replace(/[^A-Za-z]/g, "")).join("");
      verified = (format === "fasta" ? text.startsWith(">") : text.startsWith("LOCUS")) && actual.toUpperCase() === parsed.design.sequence.toUpperCase();
      if (verified) break;
    }
    if (verified) break;
  }
  if (!verified) push("SCIENTIFIC_EXPORT_LINEAGE_MISSING", `Scientific ${format.toUpperCase()} artifact lacks a current compiler/export lineage and matching sequence validation: ${file.path}`, staleInput ? "stale" : "repairable");
  return diagnostics;
}
