import type { ProteinStructureAttachment, ProteinStructureTarget } from "./protein-structures.ts";

export interface ProteinTrackStructureContext {
  attachmentId: string;
  modelIndex: number;
  chainId: string;
  explicitStartOneBased: number | null;
}
export interface ProteinTrackRequest {
  target: ProteinStructureTarget;
  selectedRange: { start: number; end: number } | null;
  structure: ProteinTrackStructureContext | null;
}
export interface ProteinTrackRow {
  label: string;
  kind: "hydrophobic" | "charged" | "coverage" | "confidence";
  color: string;
  available: boolean;
  values: Array<number | null>;
}
export interface ProteinTrackMetadata {
  schema: "proto-workbench.protein-landscape.v1";
  artifactSha256: string;
  proteinId: string;
  proteinName: string;
  sequenceSha256: string;
  length: number;
  selectedRange: { start: number; end: number } | null;
  coordinates: "0-based half-open metadata; 1-based inclusive figure labels";
  algorithm: "proto.protein-landscape.v1";
  bins: Array<{ start: number; end: number }>;
  rows: ProteinTrackRow[];
  structure: null | { attachment: ProteinStructureAttachment; context: ProteinTrackStructureContext; mappingStatus: string; mappingReason: string; observedResidues: number };
  reviewStatus: "human_review_required";
}
export interface PreparedProteinTracks { svg: string; svgSha256: string; width: number; height: number; metadata: ProteinTrackMetadata }
export interface ProteinTrackExportRequest { request: ProteinTrackRequest; format: "svg" | "png"; svgSha256: string; png?: Uint8Array }
export interface ProteinTrackExportReceipt {
  schema: "proto-workbench.protein-landscape-verification.v1";
  status: "passed";
  format: "svg" | "png";
  relativePath: string;
  metadataRelativePath: string;
  verificationRelativePath: string;
  sha256: string;
  svgSha256: string;
  artifactSha256: string;
  sequenceSha256: string;
  width: number;
  height: number;
  bytes: number;
  decoder: string;
  pixelSha256: string;
  sampledColorCount: number;
  verifiedAt: string;
}
