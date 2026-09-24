export type ComputeDomain = "statistics" | "biology" | "simulation" | "imaging" | "chemistry";
export interface ComputeSchema {
  type: string;
  properties?: Record<string, ComputeSchema>;
  required?: string[];
  items?: ComputeSchema;
  enum?: Array<string | number | boolean>;
  default?: unknown;
  description?: string;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
}
export interface ComputeFileInput { extensions: string[]; max_bytes: number; list?: boolean; max_files?: number; required?: boolean }
export type ComputeMethodStage = "method-implementation" | "numerical-reference-tested" | "demonstration" | "heuristic";
export interface ComputeMaturity {
  schema_version: "proto.compute-maturity.v1";
  method_stage: ComputeMethodStage;
  scientific_validation: "not-established";
  domain_validation: "not-established";
  applicability: string[];
  known_limitations: string[];
  evidence: Array<{
    kind: string;
    path: string;
    scope: string;
    execution_status: "not-evaluated-here";
    test_ids?: string[];
  }>;
  assessment_basis: string;
  availability_is_separate: true;
  automatic_promotion: false;
}
export interface ComputeTool {
  id: string;
  title: string;
  description: string;
  available: boolean;
  dependency: string[];
  implementation: string;
  upstream_functions: Array<string | {path:string;name:string}>;
  method_references?: string[];
  maturity?: ComputeMaturity;
  quantity_profile?: { status: "requires-dataset-binding" | "exempt"; reason: string };
  missing_dependencies: string[];
  category?: { id: string; title: string; section: ComputeDomain };
  file_inputs?: Record<string, ComputeFileInput>;
  input_schema?: ComputeSchema;
  example?: Record<string, unknown>;
}
export interface ComputeCatalog {
  ok: boolean;
  execution?: "local" | "recorded";
  workspace_path?: string;
  tools: ComputeTool[];
  upstream: Record<string, unknown>;
}
export interface ComputeRequest { tool: string; arguments: Record<string, unknown> }
export interface ComputeRun {
  evidence_standing?: import("./evidence-standing.ts").EvidenceStanding;
  ok: boolean;
  schema_version?: string;
  created_at?: string;
  tool?: string;
  run_id?: string;
  result?: Record<string, unknown>;
  artifacts?: Array<string | { path: string }>;
  manifest_path?: string;
  manifest_sha256?: string;
  result_sha256?: string;
  result_value_index?: { schema_version: "proto.compute-value-index.v1"; status: "complete" | "partial"; value_count: number; indexed_count: number; omitted_count: number; index_bytes: number };
  maturity?: ComputeMaturity;
  diagnostics?: Array<{ message: string }>;
  source?: Record<string, unknown>;
  inputs?: Record<string, unknown>;
  implementation?: string;
  implementation_version?: number;
  upstream_commit?: string | null;
  upstream_functions?: Array<string | {path:string;name:string}>;
  method_references?: string[];
  runtime?: Record<string, string>;
  review_status?: string;
  scope?: string;
  preview?: boolean;
  execution_fingerprint?: import('./research-workflows.ts').ComputeExecutionFingerprint;
}
export interface ComputeApi {
  catalog(tool?: string): Promise<ComputeCatalog>;
  run(request: ComputeRequest): Promise<ComputeRun>;
  studies(request: import("./compute-studies.ts").ComputeStudiesRequest): Promise<import("./compute-studies.ts").ComputeStudiesResponse>;
  figures(request: import("./research-figures.ts").ResearchFiguresRequest): Promise<import("./research-figures.ts").ResearchFiguresResponse>;
  workflows(request: import('./research-workflows.ts').ResearchWorkflowsRequest): Promise<import('./research-workflows.ts').ResearchWorkflowsResponse>;
}
