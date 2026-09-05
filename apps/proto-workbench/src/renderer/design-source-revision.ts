import type {DesignEditResult} from "../shared/dna-edits.ts";
import {designArtifactHasPath} from "./design-inventory.ts";

interface SourceBoundArtifact {
  path: string;
  relativePath: string;
  artifactPaths?: readonly string[];
  status: "ready" | "invalid";
  design?: {sourceSha256?: string; partsSha256?: string; constructs: Array<{name: string}>};
  digestBinding?: {status: "match" | "mismatch"};
}

/** A refresh after an edit follows its committed output, not an older open path. */
export function committedDesignArtifact<T extends SourceBoundArtifact>(artifacts: readonly T[], receipt: DesignEditResult, constructName: string): T | undefined {
  if (!receipt.ok || !receipt.artifact_paths?.length) return undefined;
  return artifacts.find(artifact => artifact.status === "ready"
    && artifact.digestBinding?.status !== "mismatch"
    && receipt.artifact_paths!.some(path => designArtifactHasPath(artifact, path))
    && artifact.design?.sourceSha256 === receipt.candidate_sha256
    && artifact.design.partsSha256 === receipt.parts_sha256
    && artifact.design.constructs.some(construct => construct.name === constructName));
}
