export type CoreModuleId =
  | "core.audit"
  | "core.inference"
  | "core.workspace"
  | "core.governance"
  | "core.validation"
  | "core.review";

export type OptionalModuleId =
  | "evidence.pubmed"
  | "evidence.europe-pmc"
  | "evidence.crossref"
  | "evidence.uniprot"
  | "evidence.rhea"
  | "analysis.python"
  | "analysis.notebook"
  | "analysis.r"
  | "media.vision";

export type ModuleProfile = "core-only" | "research" | "full" | "custom";

export interface ModuleSettings {
  profile: ModuleProfile;
  enabledOptional: OptionalModuleId[];
}

export interface WorkbenchModuleDescriptor {
  id: CoreModuleId | OptionalModuleId;
  version: number;
  label: string;
  description: string;
  core: boolean;
  resourceTier: "required" | "light" | "standard";
  tools: string[];
}

export interface ModuleArtifactHash {
  scope: "app" | "resource";
  path: string;
  sizeBytes: number;
  sha256: string;
}

export interface ModuleManifestEntry {
  moduleId: CoreModuleId | OptionalModuleId;
  version: number;
  core: boolean;
  moduleSha256: string;
  artifacts: ModuleArtifactHash[];
}

export interface ModuleIntegrityManifest {
  schemaVersion: "proto-workbench.modules.v1";
  appVersion: string;
  generatedAt: string;
  hashAlgorithm: "SHA-256";
  modules: ModuleManifestEntry[];
}

export interface ModuleIntegrityResult {
  moduleId: CoreModuleId | OptionalModuleId;
  version: number;
  core: boolean;
  status: "verified" | "missing" | "tampered" | "not-audited";
  disposition: "loaded" | "available" | "quarantined" | "blocked-startup" | "not-audited";
  moduleSha256?: string;
  checkedArtifacts: number;
  diagnostics: string[];
}

export interface ModuleIntegrityReport {
  auditId?: string;
  ok: boolean;
  enforced: boolean;
  manifestPath: string;
  checkedAt: string;
  manifestSha256?: string;
  manifestAppVersion?: string;
  manifestGeneratedAt?: string;
  modules: ModuleIntegrityResult[];
}

export const CORE_MODULES: WorkbenchModuleDescriptor[] = [
  {
    id: "core.audit",
    version: 1,
    label: "Audit core",
    description: "Module identity, SHA-256 integrity verification, isolation, and startup blocking.",
    core: true,
    resourceTier: "required",
    tools: [],
  },
  {
    id: "core.inference",
    version: 5,
    label: "Local inference",
    description: "LM Studio catalogue discovery, explicit instance lifecycle, ownership-safe unload, and streaming chat.",
    core: true,
    resourceTier: "required",
    tools: [],
  },
  {
    id: "core.workspace",
    version: 1,
    label: "Workspace isolation",
    description: "Contained reads, searches, patch proposals, and approved writes.",
    core: true,
    resourceTier: "required",
    tools: ["workspace_read", "workspace_search", "workspace_propose_patch", "workspace_resume_validation"],
  },
  {
    id: "core.governance",
    version: 3,
    label: "Governance and run ledger",
    description: "Mission scope, provenance, recovery, cancellation, and event history.",
    core: true,
    resourceTier: "required",
    tools: ["proto_connectors_check"],
  },
  {
    id: "core.validation",
    version: 1,
    label: "Proto validation",
    description: "Parts lookup, deterministic checks, compile, export, workflow, and sequence validation.",
    core: true,
    resourceTier: "required",
    tools: [
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
      "proto_protein_inspect",
      "proto_structure_list",
      "proto_structure_read",
      "proto_structure_import_workspace",
      "proto_structure_search",
      "proto_structure_fetch",
      "proto_language_reference",
      "proto_protein_validate",
      "proto_design_edit",
      "proto_workflow_run",
      "proto_provenance_verify",
    ],
  },
  {
    id: "core.review",
    version: 1,
    label: "Evidence review",
    description: "Patch gates, claim traceability, review packets, and human checklists.",
    core: true,
    resourceTier: "required",
    tools: ["proto_review_packet", "proto_literature_search"],
  },
];

export const OPTIONAL_MODULES: WorkbenchModuleDescriptor[] = [
  {
    id: "evidence.pubmed",
    version: 1,
    label: "PubMed",
    description: "NCBI literature metadata through mission-bound network capabilities.",
    core: false,
    resourceTier: "light",
    tools: ["proto_pubmed_search"],
  },
  {
    id: "evidence.europe-pmc",
    version: 1,
    label: "Europe PMC",
    description: "Articles, preprints, patents, and linked life-science metadata.",
    core: false,
    resourceTier: "light",
    tools: ["proto_europe_pmc_search"],
  },
  {
    id: "evidence.crossref",
    version: 1,
    label: "Crossref",
    description: "DOI and bibliographic identity corroboration.",
    core: false,
    resourceTier: "light",
    tools: ["proto_crossref_search"],
  },
  {
    id: "evidence.uniprot",
    version: 1,
    label: "UniProtKB",
    description: "Reviewed protein and catalytic-function annotations without sequences.",
    core: false,
    resourceTier: "light",
    tools: ["proto_uniprot_search"],
  },
  {
    id: "evidence.rhea",
    version: 1,
    label: "Rhea",
    description: "Curated reactions with ChEBI, EC, publication, and pathway links.",
    core: false,
    resourceTier: "light",
    tools: ["proto_rhea_search"],
  },
  {
    id: "analysis.python",
    version: 1,
    label: "Python analysis",
    description: "Approval-gated workspace Python scripts.",
    core: false,
    resourceTier: "standard",
    tools: ["proto_run_analysis"],
  },
  {
    id: "analysis.notebook",
    version: 1,
    label: "Notebook analysis",
    description: "Approval-gated workspace notebook execution.",
    core: false,
    resourceTier: "standard",
    tools: ["proto_run_notebook"],
  },
  {
    id: "analysis.r",
    version: 1,
    label: "R analysis",
    description: "R runtime detection and approval-gated workspace scripts.",
    core: false,
    resourceTier: "standard",
    tools: ["proto_r_status", "proto_run_r"],
  },
  {
    id: "media.vision",
    version: 1,
    label: "Vision attachments",
    description: "Image attachments when the selected local model supports vision.",
    core: false,
    resourceTier: "standard",
    tools: [],
  },
];

const RESEARCH_MODULES = OPTIONAL_MODULES
  .filter((module) => module.id.startsWith("evidence."))
  .map((module) => module.id as OptionalModuleId);
const FULL_MODULES = OPTIONAL_MODULES.map((module) => module.id as OptionalModuleId);

export function modulesForProfile(profile: Exclude<ModuleProfile, "custom">): OptionalModuleId[] {
  if (profile === "core-only") return [];
  if (profile === "research") return [...RESEARCH_MODULES];
  return [...FULL_MODULES];
}

export function defaultModuleSettings(): ModuleSettings {
  return { profile: "research", enabledOptional: modulesForProfile("research") };
}

export function normalizeModuleSettings(value?: Partial<ModuleSettings>): ModuleSettings {
  const profile = value?.profile ?? "research";
  const known = new Set(OPTIONAL_MODULES.map((module) => module.id));
  const enabled = (value?.enabledOptional ?? (profile === "custom" ? [] : modulesForProfile(profile)))
    .filter((id): id is OptionalModuleId => known.has(id));
  return { profile, enabledOptional: [...new Set(enabled)] };
}

export function isToolEnabledForModules(tool: string, settings: ModuleSettings): boolean {
  const optional = OPTIONAL_MODULES.find((module) => module.tools.includes(tool));
  return !optional || settings.enabledOptional.includes(optional.id as OptionalModuleId);
}
