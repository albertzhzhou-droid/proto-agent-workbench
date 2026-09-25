import type { CoreModuleId, OptionalModuleId } from "./modules.ts";

/**
 * The single tool contract table (architecture review 2026-09-23, CS1).
 *
 * Before this table the same tool was described by six hand-maintained lists:
 * research-tool-registry (capability naming), tool-effects (read/write),
 * permissions (exposure and risk), harness-workspace (harness overrides),
 * modules (feature gating) and mcp_server.py (network gating). The lists drifted:
 * fourteen read-only MCP tools had no effect row and failed closed as writes, so a
 * literature lookup that timed out was journalled as `effect-unknown` and blocked
 * recovery. Every layer now derives from the rows below; a name without a row is
 * rejected instead of being guessed at.
 *
 * `effect` is the recovery contract, not a description of the implementation:
 *   read   - observes only; a receipt may be replayed after a crash.
 *   write  - may leave an effect outside this process; never replayed silently.
 * `access` reproduces the authorization each surface already applied; changing an
 * authorization is out of scope here and belongs to the shared PolicyDecision work.
 */

export type ToolSurface = "mcp" | "harness" | "workspace" | "chemistry";
export type ToolEffect = "read" | "write";
export type ToolRisk = "none" | "network" | "code-execution" | "write";
export interface ToolDeadline { defaultMs: number; timeoutArgument?: "timeout"; maximumSeconds?: number; overheadMs?: number }
export type ToolAccess = "auto" | "grant-network" | "grant-execution" | "grant-write" | "denied";
export type ToolPrecondition = "schema-validated" | "within-run-budget" | "material-binding";
/** Receipt categories, not promises that a particular invocation will succeed. */
export type ArtifactClass =
  | "catalog" | "result-page" | "workspace-read" | "workspace-write"
  | "design-source" | "design-validation" | "compiled-design" | "scientific-export"
  | "workflow-manifest" | "review-packet" | "provenance-verification"
  | "scientific-compute" | "structure" | "governed-materials" | "materialized-parts"
  | "protein-materialization" | "literature-evidence" | "runtime-status"
  | "rendered-binary" | "harness-plan" | "harness-verdict" | "harness-abstention";
export type ToolCostClass = "cheap" | "metered" | "external";

export interface ToolContract {
  /** Backend tool name as the surface dispatches it. */
  readonly name: string;
  readonly surface: ToolSurface;
  readonly effect: ToolEffect;
  /** True when the tool contacts a host outside this machine. */
  readonly network: boolean;
  readonly access: ToolAccess;
  readonly risk: ToolRisk;
  readonly module: CoreModuleId | OptionalModuleId;
  readonly deadline: ToolDeadline;
  readonly outputBudget: { maxBytes: number; projectedBytes: number };
  /** Method metadata reference; does not claim scientific validity. */
  readonly maturityRef: string;
  readonly supportsOffline: boolean;
  /** Stable capability id shared by the conversational and dedicated workspaces. */
  readonly capabilityId: string;
  /** Discovery aliases from upstream vocabularies; never separate implementations. */
  readonly aliases: readonly string[];
  readonly workflowFamilies: readonly string[];
  /** Evaluated from host state before dispatch; never accepted from model arguments. */
  readonly preconditions: readonly ToolPrecondition[];
  readonly produces: readonly ArtifactClass[];
  /** A read may be repeated only through existing recovery checks. This never permits replaying an unknown write. */
  readonly idempotent: boolean;
  /** Scheduling class, not a price or a claim about scientific quality. */
  readonly costClass: ToolCostClass;
  readonly maxCallsPerRun: number;
}

type Row = readonly [
  name: string,
  surface: ToolSurface,
  effect: ToolEffect,
  network: boolean,
  access: ToolAccess,
  capabilityId: string,
  module: CoreModuleId | OptionalModuleId,
  aliases: readonly string[],
  workflowFamilies: readonly string[],
  produces: readonly ArtifactClass[],
  preconditions?: readonly ToolPrecondition[],
];

const P: readonly string[] = ["Proto"];
const BP: readonly string[] = ["Biomni", "Proto"];
const OP: readonly string[] = ["OpenScience", "Proto"];
const CP: readonly string[] = ["Chem", "Proto"];

/** The 43 tools exposed by src/proto_agent/mcp_server.py, in its registration order. */
const MCP_ROWS: readonly Row[] = [
  ["proto_data_read", "mcp", "read", false, "auto", "research.data.read", "analysis.biomni", ["science.data.page", "dataset.read"], BP, ["result-page"]],
  ["proto_compute_catalog", "mcp", "read", false, "auto", "compute.catalog", "analysis.biomni", ["biomni.tool_registry", "science.compute.catalog"], BP, ["catalog"]],
  ["proto_bioinformatics_catalog", "mcp", "read", false, "auto", "bioinformatics.catalog", "analysis.biomni", ["wsl.catalog", "genomics.catalog"], BP, ["catalog"]],
  ["proto_bioinformatics_run", "mcp", "write", false, "grant-execution", "bioinformatics.run", "analysis.biomni", ["wsl.bioinformatics", "genomics.run"], BP, ["scientific-compute"]],
  ["proto_compute_run", "mcp", "write", false, "auto", "compute.run", "analysis.biomni", ["biomni.run", "science.compute.run"], BP, ["scientific-compute"]],
  ["proto_compute_fingerprint", "mcp", "read", false, "auto", "compute.fingerprint", "analysis.biomni", [], P, ["provenance-verification"]],
  ["proto_compute_value_read", "mcp", "read", false, "auto", "compute.value.read", "analysis.biomni", ["science.compute.value", "compute.pointer.read"], BP, ["result-page"]],
  ["proto_research_figure_render", "mcp", "write", false, "auto", "research.figure.render", "analysis.biomni", [], P, ["scientific-export"]],
  ["proto_remote_catalog", "mcp", "read", false, "denied", "remote.catalog", "analysis.biomni", [], P, ["catalog"]],
  ["proto_remote_run", "mcp", "write", true, "grant-network", "remote.run", "analysis.biomni", [], P, ["scientific-compute"]],
  ["proto_language_reference", "mcp", "read", false, "auto", "design.language_reference", "core.validation", [], P, ["catalog"]],
  ["proto_design_edit", "mcp", "write", false, "auto", "design.edit", "core.validation", [], P, ["design-source"], ["material-binding"]],
  ["proto_protein_validate", "mcp", "read", false, "auto", "design.protein_validate", "core.validation", [], P, ["design-validation"]],
  ["proto_check", "mcp", "read", false, "auto", "design.check", "core.validation", [], P, ["design-validation"], ["material-binding"]],
  ["proto_compile", "mcp", "write", false, "auto", "design.compile", "core.validation", [], P, ["compiled-design"], ["material-binding"]],
  ["proto_protein_compile", "mcp", "write", false, "auto", "design.protein_compile", "core.validation", [], P, ["compiled-design"]],
  ["proto_export", "mcp", "write", false, "auto", "design.export", "core.validation", [], P, ["scientific-export"]],
  ["proto_validate_sbol", "mcp", "read", false, "auto", "design.validate_sbol", "core.validation", [], P, ["design-validation"]],
  ["proto_score", "mcp", "read", false, "auto", "design.score", "core.validation", [], P, ["design-validation"], ["material-binding"]],
  ["proto_validate_sequences", "mcp", "read", false, "auto", "design.validate_sequences", "core.validation", [], P, ["design-validation"], ["material-binding"]],
  ["proto_optimize_sequences", "mcp", "write", false, "auto", "design.optimize_sequences", "core.validation", [], P, ["design-source"], ["material-binding"]],
  ["proto_search_parts", "mcp", "read", false, "auto", "design.search_parts", "core.validation", [], P, ["governed-materials"], ["material-binding"]],
  ["proto_materials_search", "mcp", "read", false, "auto", "materials.search", "core.validation", [], P, ["governed-materials"]],
  ["proto_materials_get", "mcp", "read", false, "auto", "materials.get", "core.validation", [], P, ["governed-materials"]],
  ["proto_materials_facets", "mcp", "read", false, "auto", "materials.facets", "core.validation", [], P, ["catalog"]],
  ["proto_materials_materialize", "mcp", "write", false, "auto", "materials.materialize", "core.validation", [], P, ["governed-materials", "materialized-parts"]],
  ["proto_materials_materialize_proteins", "mcp", "write", false, "auto", "materials.materialize_proteins", "core.validation", [], P, ["governed-materials", "protein-materialization"]],
  ["proto_workflow_run", "mcp", "write", false, "auto", "design.workflow_run", "core.validation", [], P, ["workflow-manifest", "compiled-design", "design-validation", "scientific-export"], ["material-binding"]],
  ["proto_review_packet", "mcp", "write", false, "auto", "design.review_packet", "core.review", [], P, ["review-packet"], ["material-binding"]],
  ["proto_provenance_verify", "mcp", "read", false, "auto", "design.provenance_verify", "core.validation", [], P, ["provenance-verification"]],
  ["proto_literature_search", "mcp", "read", false, "auto", "literature.local", "core.review", [], OP, ["literature-evidence"]],
  ["proto_pubmed_search", "mcp", "read", true, "grant-network", "literature.pubmed", "evidence.pubmed", ["literature.pubmed.search", "query_pubmed"], OP, ["literature-evidence"]],
  ["proto_europe_pmc_search", "mcp", "read", true, "grant-network", "literature.europe_pmc", "evidence.europe-pmc", ["literature.europe_pmc.search"], OP, ["literature-evidence"]],
  ["proto_crossref_search", "mcp", "read", true, "grant-network", "literature.crossref", "evidence.crossref", ["literature.crossref.search"], OP, ["literature-evidence"]],
  ["proto_uniprot_search", "mcp", "read", true, "grant-network", "database.uniprot", "evidence.uniprot", ["science_search.uniprot", "query_uniprot"], OP, ["literature-evidence"]],
  ["proto_rhea_search", "mcp", "read", true, "grant-network", "database.rhea", "evidence.rhea", ["science_search.rhea"], OP, ["literature-evidence"]],
  ["proto_run_analysis", "mcp", "write", false, "grant-execution", "code.python", "analysis.python", ["python", "pythonkernel"], OP, ["scientific-compute"]],
  ["proto_run_notebook", "mcp", "write", false, "grant-execution", "code.notebook", "analysis.notebook", ["notebook.execute"], OP, ["scientific-compute"]],
  ["proto_r_status", "mcp", "read", false, "auto", "code.r_status", "analysis.r", [], OP, ["runtime-status"]],
  ["proto_run_r", "mcp", "write", false, "grant-execution", "code.r", "analysis.r", ["rkernel"], OP, ["scientific-compute"]],
  ["proto_connectors_check", "mcp", "read", false, "auto", "connectors.check", "core.governance", [], P, ["runtime-status"]],
  ["proto_skills_list", "mcp", "read", false, "auto", "skills.catalog", "core.governance", ["skill.list"], OP, ["catalog"]],
  ["proto_skills_resolve", "mcp", "read", false, "denied", "skills.resolve", "core.governance", [], OP, ["catalog"]],
];

/**
 * Structure and protein tools implemented in the Electron main process
 * (harness-structure-tools.ts), not by the Python MCP server. The earlier lists
 * did not record the surface, so a cross-check of permissions against the MCP
 * tool list reported these six as phantom entries.
 */
const HARNESS_ROWS: readonly Row[] = [
  ["proto_protein_inspect", "harness", "read", false, "auto", "protein.inspect", "core.validation", [], P, ["workspace-read"]],
  ["proto_structure_list", "harness", "read", false, "auto", "structure.list", "core.validation", [], P, ["catalog"]],
  ["proto_structure_read", "harness", "read", false, "auto", "structure.read", "core.validation", [], P, ["structure"]],
  ["proto_structure_search", "harness", "read", true, "grant-network", "structure.search", "core.validation", [], P, ["catalog"]],
  ["proto_structure_fetch", "harness", "write", true, "grant-network", "structure.fetch", "core.validation", [], P, ["structure"]],
  ["proto_structure_import_workspace", "harness", "write", false, "auto", "structure.import_workspace", "core.validation", [], P, ["structure"]],
  ["harness_discover_tools", "harness", "read", false, "denied", "harness.discover_tools", "core.governance", [], P, ["catalog"]],
  ["harness_read_result", "harness", "read", false, "denied", "harness.read_result", "core.governance", [], P, ["result-page"]],
  ["harness_plan", "harness", "read", false, "denied", "harness.plan", "core.governance", [], P, ["harness-plan"]],
  ["harness_finish", "harness", "read", false, "denied", "harness.finish", "core.governance", [], P, ["harness-verdict"]],
  ["harness_report_blocked", "harness", "read", false, "denied", "harness.report_blocked", "core.governance", [], P, ["harness-abstention"]],
];

const WORKSPACE_ROWS: readonly Row[] = [
  ["workspace_read", "workspace", "read", false, "auto", "workspace.read", "core.workspace", [], P, ["workspace-read"]],
  ["workspace_search", "workspace", "read", false, "auto", "workspace.search", "core.workspace", [], P, ["catalog"]],
  ["workspace_list", "workspace", "read", false, "denied", "workspace.list", "core.workspace", [], P, ["catalog"]],
  ["workspace_propose_patch", "workspace", "write", false, "auto", "workspace.propose_patch", "core.workspace", [], P, ["workspace-write", "design-validation", "compiled-design"]],
  ["workspace_resume_validation", "workspace", "write", false, "auto", "workspace.resume_validation", "core.workspace", [], P, ["design-validation", "compiled-design"]],
  ["workspace_apply_patch", "workspace", "write", false, "grant-write", "workspace.apply_patch", "core.workspace", [], P, ["workspace-write"]],
];

/**
 * Chemistry operators run in their own sidecar process. They are listed here so
 * that a single table can answer "what is this name" for every surface, but the
 * chemistry backend does not yet share the execution journal; that is CS2.
 */
const CHEMISTRY_READ_OPERATORS = ["catalog", "read", "history", "guidance"] as const;
const CHEMISTRY_WRITE_OPERATORS = [
  "fit_adsorption_isotherm", "analyze_vanthoff_equilibrium", "calculate_acid_base_speciation",
  "fit_electrochemical_impedance", "summarize_replicates", "compare_assay_groups",
  "fit_calibration_curve", "analyze_spectrum", "chemical_pca", "prepare_molecular_dataset",
  "search_substructures", "cluster_molecules", "formula_properties", "balance_equation",
  "solution_calculator", "simulate_reaction_network", "scan_reaction_temperature",
  "fit_reaction_rates", "analyze_molecule", "compare_molecules", "inspect_reaction_smiles",
  "parse_xyz_trajectory", "organic_candidates", "inorganic_candidates",
  "simulate_competitive_adsorption", "simulate_langmuir_hinshelwood", "simulate_eley_rideal",
  "simulate_electrode_step", "simulate_diffusion_film", "simulate_reversible_chain",
  "simulate_catalytic_cycle", "simulate_cstr", "simulate_pfr", "simulate_semibatch",
  "simulate_nonisothermal_batch", "simulate_nonisothermal_cstr", "simulate_tanks_in_series",
  "simulate_catalyst_deactivation", "simulate_gas_liquid_reaction", "simulate_catalyst_pellet",
  "simulate_photochemical_isomerization", "simulate_excited_state_quenching",
  "simulate_cyclic_voltammetry", "simulate_chronoamperometry", "fit_arrhenius_eyring",
  "compare_integrated_rate_laws", "simulate_stochastic_network", "simulate_axial_dispersion",
  "analyze_tracer_rtd", "simulate_rtd_segregation", "analyze_network_structure",
  "scan_cstr_steady_states", "analyze_reaction_sensitivity", "analyze_reaction_flux",
  "propagate_reaction_uncertainty", "simulate_interface",
] as const;

const CHEMISTRY_EXTRA_ALIASES: Record<string, readonly string[]> = {
  "chemistry.guidance": ["openscience.chemistry"],
  "chemistry.analyze_molecule": ["chem.analyze_molecule", "rdkit.analyze"],
};

const chemistryRow = (operator: string, effect: ToolEffect): Row => {
  const id = `chemistry.${operator}`;
  return [id, "chemistry", effect, false, "auto", id, "analysis.chemistry",
    CHEMISTRY_EXTRA_ALIASES[id] ?? [`chem.${operator}`],
    id === "chemistry.guidance" ? ["OpenScience", "Chem"] : id === "chemistry.compare_molecules" ? ["Chem", "OpenScience"] : CP,
    effect === "write" ? ["scientific-compute"] : operator === "catalog" || operator === "guidance" ? ["catalog"] : ["result-page"]];
};

const CHEMISTRY_ROWS: readonly Row[] = [
  ...CHEMISTRY_READ_OPERATORS.map((operator) => chemistryRow(operator, "read")),
  ...CHEMISTRY_WRITE_OPERATORS.map((operator) => chemistryRow(operator, "write")),
];

/** Deadline policy lives with the contract, including execution timeout semantics. */
function deadlineFor(name: string): ToolDeadline {
  if (["proto_bioinformatics_run", "proto_compute_run", "proto_workflow_run", "proto_review_packet"].includes(name)) return {defaultMs: 630_000};
  if (["proto_run_analysis", "proto_run_notebook", "proto_run_r"].includes(name)) return {
    defaultMs: name === "proto_run_analysis" ? 90_000 : 150_000,
    timeoutArgument: "timeout", maximumSeconds: 600, overheadMs: 30_000,
  };
  if (name === "proto_bioinformatics_catalog" || /search/.test(name)) return {defaultMs: 150_000};
  if (/materialize|compile/.test(name)) return {defaultMs: 210_000};
  if (name.startsWith("chemistry.")) return {defaultMs: 630_000};
  return {defaultMs: 90_000};
}

const toContract = (row: Row): ToolContract => ({
  name: row[0], surface: row[1], effect: row[2], network: row[3], access: row[4],
  capabilityId: row[5], module: row[6], aliases: row[7] ?? [], workflowFamilies: row[8] ?? P,
  risk: row[4] === "grant-network" ? "network" : row[4] === "grant-execution" || row[4] === "denied" ? "code-execution" : row[4] === "grant-write" ? "write" : "none",
  deadline: deadlineFor(row[0]), outputBudget: {maxBytes: 8 * 1024 * 1024, projectedBytes: 48 * 1024},
  maturityRef: row[1] === "chemistry" ? "chem-science.operator-provenance" : row[5].startsWith("compute.") ? "proto-agent.compute.v1#/maturity" : "not-established",
  supportsOffline: row[3] && row[1] === "mcp" && row[0] !== "proto_remote_run",
  preconditions: ["schema-validated", "within-run-budget", ...(row[10] ?? [])],
  produces: row[9],
  idempotent: row[2] === "read",
  costClass: row[3] ? "external" : row[2] === "write" ? "metered" : "cheap",
  // Terminal controls must remain reachable. Their finite bound cannot be
  // reached within any practical checkpoint, and does not constrain a task exit.
  maxCallsPerRun: row[0] === "harness_finish" || row[0] === "harness_report_blocked"
    ? Number.MAX_SAFE_INTEGER : row[3] ? 12 : row[2] === "write" ? 24 : 64,
});

export const TOOL_CONTRACTS: ReadonlyMap<string, ToolContract> = new Map(
  [...MCP_ROWS, ...HARNESS_ROWS, ...WORKSPACE_ROWS, ...CHEMISTRY_ROWS]
    .map(toContract)
    .map((contract) => [contract.name, contract] as const),
);

const BY_CAPABILITY: ReadonlyMap<string, ToolContract> = new Map(
  [...TOOL_CONTRACTS.values()].flatMap((contract) =>
    [contract.capabilityId, ...contract.aliases].map((key) => [key, contract] as const)),
);

/** Contract for a backend tool name. Undefined means the name is unregistered. */
export function toolContract(name: string): ToolContract | undefined {
  return TOOL_CONTRACTS.get(name);
}

/** Contract for a backend name, a capability id, or a discovery alias. */
export function resolveToolContract(name: string): ToolContract | undefined {
  return TOOL_CONTRACTS.get(name) ?? BY_CAPABILITY.get(name);
}

export function toolNamesForSurface(surface: ToolSurface): string[] {
  return [...TOOL_CONTRACTS.values()].filter((contract) => contract.surface === surface).map((contract) => contract.name);
}

/** Resolve before dispatch; an unknown name must never inherit a guessed effect. */
export function requireToolContract(name: string): ToolContract {
  const contract = resolveToolContract(name);
  if (!contract) throw Object.assign(new Error(`UNKNOWN_CAPABILITY: ${name}`), {code: "UNKNOWN_CAPABILITY", effectState: "none"});
  return contract;
}

export type ToolDispatchDecision =
  | {allowed: true; tool: string}
  | {allowed: false; tool: string; code: "TOOL_CALL_LIMIT_EXCEEDED" | "TOOL_PRECONDITION_FAILED" | "UNKNOWN_CAPABILITY";
      message: string; missing?: ToolPrecondition[]; effect_state: "none"};

/**
 * A second, narrower gate after argument validation and before durable intent.
 * `calls` is the persisted canonical tool count, including failed dispatched
 * attempts; callers must reserve it durably before execution and reuse an
 * existing operation reservation on resume. Facts come only from host state.
 * This gate never substitutes for policy, path, lineage, CAS or digest checks.
 */
export function evaluateToolDispatch(name: string, context: {
  calls: number; facts: Partial<Record<ToolPrecondition, boolean>>;
}): ToolDispatchDecision {
  const contract = resolveToolContract(name);
  if (!contract) return {allowed: false, tool: name, code: "UNKNOWN_CAPABILITY", message: `Unknown tool contract: ${name}.`, effect_state: "none"};
  if (!Number.isSafeInteger(context.calls) || context.calls < 0 || context.calls >= contract.maxCallsPerRun) {
    return {allowed: false, tool: contract.name, code: "TOOL_CALL_LIMIT_EXCEEDED",
      message: `The run has no remaining calls for ${contract.name} (host limit ${contract.maxCallsPerRun}).`, effect_state: "none"};
  }
  const missing = contract.preconditions.filter(condition => context.facts[condition] !== true);
  if (missing.length) return {allowed: false, tool: contract.name, code: "TOOL_PRECONDITION_FAILED", missing,
    message: `Host preconditions are not satisfied for ${contract.name}: ${missing.join(", ")}.`, effect_state: "none"};
  return {allowed: true, tool: contract.name};
}

/** Only capabilities already available to this host may be offered as remedies. */
export function toolsProducing(artifactClass: ArtifactClass, availableNames: Iterable<string>): ToolContract[] {
  const seen = new Set<string>();
  const result: ToolContract[] = [];
  for (const name of availableNames) {
    const contract = resolveToolContract(name);
    if (!contract || seen.has(contract.name) || contract.access === "denied" || !contract.produces.includes(artifactClass)) continue;
    seen.add(contract.name);
    result.push(contract);
  }
  return result;
}

export function contractDeadlineMs(name: string, args: Record<string, unknown>): number {
  const deadline = requireToolContract(name).deadline;
  if (!deadline.timeoutArgument || args[deadline.timeoutArgument] === undefined) return deadline.defaultMs;
  const seconds = args[deadline.timeoutArgument];
  if (typeof seconds !== "number" || !Number.isSafeInteger(seconds) || seconds < 1 || seconds > deadline.maximumSeconds!) {
    throw new Error(`Execution timeout must be between 1 and ${deadline.maximumSeconds} seconds.`);
  }
  return seconds * 1000 + (deadline.overheadMs ?? 0);
}
