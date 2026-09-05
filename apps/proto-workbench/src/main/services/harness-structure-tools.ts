import { join, relative } from "node:path";
import type { McpTool } from "./mcp-client.ts";
import type { WorkspaceFiles } from "./workspace-files.ts";
import type { ProteinStructureAttachment, ProteinStructureTarget, StructureProvider } from "../../shared/protein-structures.ts";
import { ProteinStructureService } from "./protein-structures.ts";
import { parseDesignIr } from "../../renderer/design-visualization.ts";

const pathField = {type: "string", minLength: 1, maxLength: 2048};
const hashField = {type: "string", pattern: "^[a-f0-9]{64}$"};
const targetFields = {ir_path: pathField, protein_id: {type: "string", minLength: 1, maxLength: 256}, expected_artifact_sha256: hashField};
const providerField = {type: "string", enum: ["pdb", "alphafold"]};
const tool = (name: string, description: string, properties: Record<string, unknown>, required = Object.keys(properties)): McpTool => ({name, description, inputSchema: {type: "object", properties, required, additionalProperties: false}});
export const HARNESS_STRUCTURE_TOOLS: McpTool[] = [
  tool("proto_protein_inspect", "Inspect an integrity-checked protein IR and return its exact artifact digest, protein IDs, sequence digests and provenance. Structure attachment does not prove sequence alignment.", {ir_path: pathField}),
  tool("proto_structure_list", "List existing digest-verified structure attachments for an exact protein IR target. Does not create directories or fetch coordinates.", targetFields),
  tool("proto_structure_read", "Read an existing coordinate attachment and its provenance by exact attachment ID. Follow next_offset to page bounded text. The stored target identity is not a claim of residue mapping or physical equivalence.", {...targetFields, attachment_id: hashField, offset: {type: "integer", minimum: 0}, limit: {type: "integer", minimum: 1, maximum: 24000}}, [...Object.keys(targetFields), "attachment_id"]),
  tool("proto_structure_search", "Search only official PDB or AlphaFold metadata. Requires the mission network grant. For AlphaFold use a tool-returned UniProt accession.", {provider: providerField, query: {type: "string", minLength: 1, maxLength: 160}}),
  tool("proto_structure_fetch", "Fetch official PDB/AlphaFold coordinates into build/protein-structures with source, rights and content digests. Requires mission network scope; preserves experimental/predicted classification and human review. Does not claim sequence alignment.", {...targetFields, provider: providerField, accession: {type: "string", minLength: 1, maxLength: 160}}),
  tool("proto_structure_import_workspace", "Import a root-contained PDB/mmCIF coordinate file after workspace_read. Bind its returned digest; local source, rights and confidence remain unverified. Never accepts external file paths.", {...targetFields, path: pathField, expected_source_sha256: hashField}),
];
export const HARNESS_STRUCTURE_TOOL_NAMES = new Set(HARNESS_STRUCTURE_TOOLS.map(item => item.name));
export const HARNESS_STRUCTURE_WRITE_TOOLS = new Set(["proto_structure_fetch", "proto_structure_import_workspace"]);

/** Generic scientific artifact bridge; all identities are derived from verified IR. */
export async function executeHarnessStructureTool(name: string, args: Record<string, unknown>, workspace: WorkspaceFiles, workspaceRoot: string, signal: AbortSignal): Promise<Record<string, unknown>> {
  signal.throwIfAborted();
  const service = new ProteinStructureService(workspaceRoot, {signal});
  if (name === "proto_structure_search") return {ok: true, matches: await service.search({provider: args.provider as StructureProvider, query: String(args.query)})};
  const artifact = await workspace.read(String(args.ir_path));
  const parsed = parseDesignIr(artifact.content);
  if (!parsed.ok || parsed.design?.domain !== "protein") return {ok: false, code: "PROTEIN_IR_REQUIRED", diagnostics: parsed.diagnostics, effect_state: "none"};
  const inputs = {path: artifact.path, sha256: artifact.sha256};
  if (name === "proto_protein_inspect") return {ok: true, ir_path: relative(workspaceRoot, artifact.path).replaceAll("\\", "/"), artifact_sha256: artifact.sha256,
    proteins: parsed.design.proteins.map(p => ({id: p.id, resource_id: p.resourceId, name: p.name, sequence_sha256: p.sequenceSha256, length: p.length, metrics: p.metrics, source: p.source, license: p.license, evidence_refs: p.evidenceRefs})), _harnessInputs: inputs};
  if (args.expected_artifact_sha256 !== artifact.sha256) return {ok: false, code: "PROTEIN_IR_CHANGED", message: "Inspect the current protein IR and rebind its exact artifact digest before continuing.", effect_state: "none"};
  const protein = parsed.design.proteins.find(p => p.id === args.protein_id);
  if (!protein) return {ok: false, code: "PROTEIN_ID_NOT_FOUND", message: "Use a protein ID returned by proto_protein_inspect for this exact artifact.", effect_state: "none"};
  const target: ProteinStructureTarget = {artifactPath: artifact.path, artifactSha256: artifact.sha256, proteinId: protein.id, sequenceSha256: protein.sequenceSha256};
  const binding = {protein_id: target.proteinId, sequence_sha256: target.sequenceSha256, artifact_sha256: target.artifactSha256, mapping_status: "unverified", _harnessInputs: inputs};
  if (name === "proto_structure_list") return {ok: true, ...binding, attachments: await service.list(target)};
  if (name === "proto_structure_read") {
    const result = await service.read({target, attachmentId: String(args.attachment_id)});
    const offset = Number(args.offset ?? 0), limit = Number(args.limit ?? 12000);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > result.text.length || !Number.isSafeInteger(limit) || limit < 1 || limit > 24000) return {ok: false, code: "STRUCTURE_PAGE_RANGE_INVALID", effect_state: "none"};
    return {ok: true, ...binding, attachment: result.attachment, offset, content: result.text.slice(offset, offset + limit), total_characters: result.text.length, next_offset: offset + limit < result.text.length ? offset + limit : null};
  }
  const result = name === "proto_structure_fetch"
    ? await service.fetch({target, provider: args.provider as StructureProvider, accession: String(args.accession)})
    : await service.importWorkspace(target, String(args.path), String(args.expected_source_sha256));
  signal.throwIfAborted();
  return {ok: true, effect_state: "committed", ...binding, attachment: result.attachment, artifacts: attachmentPaths(result.attachment),
    message: "Coordinates and provenance are saved. Use the structure viewer to verify chain/residue mapping before interpreting or exporting a figure."};
}

function attachmentPaths(attachment: ProteinStructureAttachment): string[] {
  const base = join("build", "protein-structures", attachment.sequenceSha256, attachment.id);
  return [`${base}.${attachment.format === "pdb" ? "pdb" : "cif"}`, `${base}.json`].map(path => path.replaceAll("\\", "/"));
}
