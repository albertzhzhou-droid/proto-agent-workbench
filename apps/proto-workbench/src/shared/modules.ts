import { TOOL_CONTRACTS, resolveToolContract } from "./tool-contracts.ts";
import { normalizeDesignSkills } from "./design-skills.ts";

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
  | "analysis.biomni"
  | "analysis.chemistry"
  | "analysis.notebook"
  | "analysis.r"
  | "media.vision";

export type ModuleProfile = "core-only" | "research" | "full" | "custom";

export interface ModuleSettings {
  profile: ModuleProfile;
  enabledOptional: OptionalModuleId[];
  enabledSkills?: string[];
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

const toolsForModule = (module: CoreModuleId | OptionalModuleId): string[] => [...TOOL_CONTRACTS.values()].filter(contract => contract.module === module).map(contract => contract.name);

export const CORE_MODULES: WorkbenchModuleDescriptor[] = [
  {
    id: "core.audit",
    version: 1,
    label: "Audit core",
    description: "Module identity, SHA-256 integrity verification, isolation, and startup blocking.",
    core: true,
    resourceTier: "required",
    tools: toolsForModule("core.audit"),
  },
  {
    id: "core.inference",
    version: 5,
    label: "Local inference",
    description: "LM Studio catalogue discovery, explicit instance lifecycle, ownership-safe unload, and streaming chat.",
    core: true,
    resourceTier: "required",
    tools: toolsForModule("core.inference"),
  },
  {
    id: "core.workspace",
    version: 1,
    label: "Workspace isolation",
    description: "Contained reads, searches, patch proposals, and approved writes.",
    core: true,
    resourceTier: "required",
    tools: toolsForModule("core.workspace"),
  },
  {
    id: "core.governance",
    version: 3,
    label: "Governance and run ledger",
    description: "Mission scope, provenance, recovery, cancellation, and event history.",
    core: true,
    resourceTier: "required",
    tools: toolsForModule("core.governance"),
  },
  {
    id: "core.validation",
    version: 1,
    label: "Proto validation",
    description: "Parts lookup, deterministic checks, compile, export, workflow, and sequence validation.",
    core: true,
    resourceTier: "required",
    tools: toolsForModule("core.validation"),
  },
  {
    id: "core.review",
    version: 1,
    label: "Evidence review",
    description: "Patch gates, claim traceability, review packets, and human checklists.",
    core: true,
    resourceTier: "required",
    tools: toolsForModule("core.review"),
  },
];

export const OPTIONAL_MODULES: WorkbenchModuleDescriptor[] = [
  {
    id: "analysis.chemistry", version: 1, label: "Chemistry scientific computing",
    description: "Chemistry operator catalog, saved calculations, and provenance through the shared execution contract.",
    core: false, resourceTier: "standard", tools: toolsForModule("analysis.chemistry"),
  },
  {
    id: "analysis.biomni",
    version: 2,
    label: "Biomni scientific computing",
    description: "127 statistical, biological, sequence, comparative-study, RNA-seq and structure-result methods plus nine WSL bioinformatics operations with live probes. Typed schemas and source-bound result artifacts share one tool workflow.",
    core: false,
    resourceTier: "standard",
    tools: toolsForModule("analysis.biomni"),
  },
  {
    id: "evidence.pubmed",
    version: 1,
    label: "PubMed",
    description: "NCBI literature metadata through mission-bound network capabilities.",
    core: false,
    resourceTier: "light",
    tools: toolsForModule("evidence.pubmed"),
  },
  {
    id: "evidence.europe-pmc",
    version: 1,
    label: "Europe PMC",
    description: "Articles, preprints, patents, and linked life-science metadata.",
    core: false,
    resourceTier: "light",
    tools: toolsForModule("evidence.europe-pmc"),
  },
  {
    id: "evidence.crossref",
    version: 1,
    label: "Crossref",
    description: "DOI and bibliographic identity corroboration.",
    core: false,
    resourceTier: "light",
    tools: toolsForModule("evidence.crossref"),
  },
  {
    id: "evidence.uniprot",
    version: 1,
    label: "UniProtKB",
    description: "Reviewed protein and catalytic-function annotations without sequences.",
    core: false,
    resourceTier: "light",
    tools: toolsForModule("evidence.uniprot"),
  },
  {
    id: "evidence.rhea",
    version: 1,
    label: "Rhea",
    description: "Curated reactions with ChEBI, EC, publication, and pathway links.",
    core: false,
    resourceTier: "light",
    tools: toolsForModule("evidence.rhea"),
  },
  {
    id: "analysis.python",
    version: 1,
    label: "Python analysis",
    description: "Approval-gated workspace Python scripts.",
    core: false,
    resourceTier: "standard",
    tools: toolsForModule("analysis.python"),
  },
  {
    id: "analysis.notebook",
    version: 1,
    label: "Notebook analysis",
    description: "Approval-gated workspace notebook execution.",
    core: false,
    resourceTier: "standard",
    tools: toolsForModule("analysis.notebook"),
  },
  {
    id: "analysis.r",
    version: 1,
    label: "R analysis",
    description: "R runtime detection and approval-gated workspace scripts.",
    core: false,
    resourceTier: "standard",
    tools: toolsForModule("analysis.r"),
  },
  {
    id: "media.vision",
    version: 1,
    label: "Vision attachments",
    description: "Image attachments when the selected local model supports vision.",
    core: false,
    resourceTier: "standard",
    tools: toolsForModule("media.vision"),
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
  return { profile, enabledOptional: [...new Set(enabled)],
    ...(value?.enabledSkills ? { enabledSkills: normalizeDesignSkills(value.enabledSkills) } : {}) };
}

export function isToolEnabledForModules(tool: string, settings: ModuleSettings): boolean {
  const contract = resolveToolContract(tool);
  if (!contract) return false;
  return contract.module.startsWith("core.") || settings.enabledOptional.includes(contract.module as OptionalModuleId);
}
