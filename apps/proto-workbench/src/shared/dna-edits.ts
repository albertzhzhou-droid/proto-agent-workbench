/** Source-edit requests. Biological IDs are never used as occurrence identities. */
export interface DnaAnnotationAnchor {
  instance_id: string;
  start: number;
  end: number;
  direction: -1 | 0 | 1;
}

export interface DnaSourceAnnotation {
  id: string;
  name: string;
  type: string;
  anchors: DnaAnnotationAnchor[];
  origin: "user";
}

export type DesignEditCommand =
  | { type: "reorder_occurrences"; construct: string; instance_ids: string[] }
  | { type: "set_orientation"; construct: string; instance_id: string; orientation: "forward" | "reverse" }
  | { type: "upsert_annotation"; construct: string; annotation: DnaSourceAnnotation }
  | { type: "delete_annotation"; construct: string; annotation_id: string };

export interface DesignEditRequest {
  sourcePath: string;
  commands: DesignEditCommand[];
  partsPath: string;
  expectedSourceSha256: string;
  expectedPartsSha256: string;
}

export interface DesignEditResult {
  ok: boolean;
  source_written?: boolean;
  validation_state?: "verified" | "failed" | "unknown";
  run_id?: string;
  artifact_paths?: string[];
  candidate_source: string;
  unified_diff: string;
  source_sha256: string;
  candidate_sha256: string;
  parts_sha256: string;
  diagnostics: Array<{ severity: string; code: string; message: string; file?: string; line?: number }>;
  affected_occurrences: Array<{ construct: string; instance_id: string }>;
  affected_annotations: Array<{ construct: string; annotation_id: string }>;
}

export interface DesignEditApi {
  prepareEdit(input: DesignEditRequest): Promise<DesignEditResult>;
  commitEdit(input: DesignEditRequest): Promise<DesignEditResult>;
}
