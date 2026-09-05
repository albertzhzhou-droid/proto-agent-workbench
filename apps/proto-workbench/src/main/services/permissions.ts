import type { ToolApproval } from "../../shared/contracts.ts";

const NETWORK_TOOLS = new Set([
  "proto_structure_search",
  "proto_structure_fetch",
  "proto_pubmed_search",
  "proto_europe_pmc_search",
  "proto_crossref_search",
  "proto_uniprot_search",
  "proto_rhea_search",
]);
const CODE_EXECUTION_TOOLS = new Set(["proto_run_analysis", "proto_run_notebook", "proto_run_r"]);
const AUTO_TOOLS = new Set([
  "proto_protein_inspect",
  "proto_structure_list",
  "proto_structure_read",
  "proto_structure_import_workspace",
  "proto_language_reference",
  "proto_check",
  "proto_compile",
  "proto_export",
  "proto_validate_sbol",
  "proto_score",
  "proto_validate_sequences",
  "proto_optimize_sequences",
  "proto_search_parts",
  "proto_materials_search",
  "proto_materials_get",
  "proto_materials_facets",
  "proto_materials_materialize",
  "proto_materials_materialize_proteins",
  "proto_protein_compile",
  "proto_protein_validate",
  "proto_design_edit",
  "proto_workflow_run",
  "proto_provenance_verify",
  "proto_review_packet",
  "proto_literature_search",
  "proto_r_status",
  "proto_connectors_check",
  "workspace_read",
  "workspace_search",
  "workspace_propose_patch",
  "workspace_resume_validation",
]);

export type ToolPermission =
  | { allowed: true; risk: "none" }
  | { allowed: false; risk: ToolApproval["risk"]; reason: string };

export function classifyTool(tool: string): ToolPermission {
  if (AUTO_TOOLS.has(tool)) return { allowed: true, risk: "none" };
  if (NETWORK_TOOLS.has(tool)) {
    return {
      allowed: false,
      risk: "network",
      reason: "This tool sends a query to an external scientific database and requires a mission network grant or explicit approval.",
    };
  }
  if (CODE_EXECUTION_TOOLS.has(tool)) {
    return {
      allowed: false,
      risk: "code-execution",
      reason: "This tool executes workspace-local analysis code and requires a mission execution grant or explicit approval.",
    };
  }
  if (tool === "workspace_apply_patch") {
    return {
      allowed: false,
      risk: "write",
      reason: "Workspace changes require explicit review and approval.",
    };
  }
  return {
    allowed: false,
    risk: "code-execution",
    reason: "Unknown tools are denied by default.",
  };
}

export function classifyToolCall(tool: string, arguments_: Record<string, unknown>): ToolPermission {
  if (NETWORK_TOOLS.has(tool) && arguments_.offline === true) {
    return { allowed: true, risk: "none" };
  }
  return classifyTool(tool);
}

export function isToolExposedToModel(tool: string): boolean {
  return AUTO_TOOLS.has(tool) || NETWORK_TOOLS.has(tool) || CODE_EXECUTION_TOOLS.has(tool);
}

export function isNetworkTool(tool: string): boolean {
  return NETWORK_TOOLS.has(tool);
}
