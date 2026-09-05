import type { PreparedProteinTracks, ProteinTrackExportReceipt, ProteinTrackExportRequest, ProteinTrackRequest } from "./protein-track-export.ts";
/** Structure attachments are read-only evidence, separate from compiled protein IR. */
export const PROTEIN_STRUCTURE_LIMITS = Object.freeze({
  maxBytes: 24 * 1024 * 1024,
  maxAtoms: 150_000,
  maxResidues: 20_000,
  maxChains: 128,
  maxAttachments: 24,
  maxSearchResults: 12,
  networkTimeoutMs: 25_000,
});

export interface ProteinStructureTarget {
  artifactPath: string;
  artifactSha256: string;
  proteinId: string;
  sequenceSha256: string;
}

export type StructureProvider = "pdb" | "alphafold";
export interface ProteinStructureCandidate {
  provider: StructureProvider;
  accession: string;
  title: string;
  sourceUrl: string;
}

export interface ProteinStructureAttachment {
  schema: "proto-workbench.protein-structure.v1";
  id: string;
  proteinId: string;
  sequenceSha256: string;
  contentSha256: string;
  format: "mmcif" | "pdb";
  bytes: number;
  label: string;
  source: {
    provider: StructureProvider | "local";
    accession: string;
    url: string | null;
    retrievedAt: string;
    classification: "experimental" | "predicted" | "unknown";
    license: "CC0-1.0" | "CC-BY-4.0" | "NOASSERTION";
    attribution: string;
  };
  /** The attachment has not been promoted into the governed materials catalogue. */
  reviewStatus: "human_review_required";
}

export interface ProteinStructureData {
  attachment: ProteinStructureAttachment;
  text: string;
}

export interface ProteinStructureApi {
  list(target: ProteinStructureTarget): Promise<ProteinStructureAttachment[]>;
  search(input: { provider: StructureProvider; query: string }): Promise<ProteinStructureCandidate[]>;
  fetch(input: { target: ProteinStructureTarget; provider: StructureProvider; accession: string }): Promise<ProteinStructureData>;
  /** Main-process native file picker supplies the path; renderer cannot name it. */
  importFile(target: ProteinStructureTarget): Promise<ProteinStructureData | null>;
  read(input: { target: ProteinStructureTarget; attachmentId: string }): Promise<ProteinStructureData>;
  exportImage?(input: ProteinStructureImageRequest): Promise<{ relativePath: string; metadataRelativePath: string }>;
  saveView?(input: { target: ProteinStructureTarget; attachmentId: string; view: ProteinStructureViewState }): Promise<ProteinStructureSavedView>;
  readView?(input: { target: ProteinStructureTarget; attachmentId: string }): Promise<ProteinStructureSavedView | null>;
  prepareTracks?(input: ProteinTrackRequest): Promise<PreparedProteinTracks>;
  exportTracks?(input: ProteinTrackExportRequest): Promise<ProteinTrackExportReceipt>;
}

export interface ProteinCameraSnapshot {
  mode: "perspective" | "orthographic";
  fov: number;
  position: [number, number, number];
  up: [number, number, number];
  target: [number, number, number];
  radius: number;
  radiusMax: number;
  fog: number;
  clipFar: boolean;
  minNear: number;
  minFar: number;
}

export interface ProteinStructureViewState {
  modelIndex: number;
  chainId: string;
  representation: "cartoon" | "ball-and-stick" | "molecular-surface";
  color: "chain" | "residue" | "confidence";
  selectedRange: { start: number; end: number } | null;
  explicitStartOneBased: number | null;
  camera: ProteinCameraSnapshot;
}

export interface ProteinStructureSavedView {
  schema: "proto-workbench.protein-view.v1";
  artifactSha256: string;
  attachmentId: string;
  contentSha256: string;
  sequenceSha256: string;
  proteinId: string;
  savedAt: string;
  view: ProteinStructureViewState;
}

export interface ProteinStructureImageRequest {
  target: ProteinStructureTarget;
  attachmentId: string;
  png: Uint8Array;
  width: number;
  height: number;
  view: {
    chainId: string;
    representation: "cartoon" | "ball-and-stick" | "molecular-surface";
    color: "chain" | "residue" | "confidence";
    selectedRange: { start: number; end: number } | null;
    mappingStatus: string;
    camera: Record<string, unknown>;
  };
}

export interface ProteinStructureResidue {
  key: string;
  labelSeqId: number;
  authSeqId: number;
  insertionCode: string;
  oneLetter: string;
  /** Index in the complete deposited polymer sequence, if declared. */
  polymerIndex: number;
  confidence: number | null;
}

export interface ProteinStructureChain {
  id: string;
  modelIndex: number;
  labelAsymId: string;
  authAsymId: string;
  sequence: string;
  residues: ProteinStructureResidue[];
}

export interface ProteinResidueMapping {
  status: "exact" | "explicit-partial" | "unmapped";
  reason: string;
  coverage: number;
  /** Sparse mapping: missing/unobserved residues are never filled with geometry. */
  positions: Array<{ proteinIndex: number; residue: ProteinStructureResidue }>;
}
