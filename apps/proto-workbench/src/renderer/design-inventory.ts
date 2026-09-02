export interface GroupableDesignArtifact {
  path: string;
  modifiedAt: string;
  status: "ready" | "invalid";
  sha256?: string;
  provenance?: unknown;
  digestBinding?: { status: "match" | "mismatch" };
}

export type GroupedDesignArtifact<T> = T & { copyCount: number };

function representativeRank(document: GroupableDesignArtifact): number {
  if (document.digestBinding?.status === "match") return 3;
  if (document.provenance) return 2;
  return 1;
}

function modifiedTime(document: GroupableDesignArtifact): number {
  const parsed = Date.parse(document.modifiedAt);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function shouldReplaceRepresentative(left: GroupableDesignArtifact, right: GroupableDesignArtifact): boolean {
  const rankDifference = representativeRank(right) - representativeRank(left);
  if (rankDifference !== 0) return rankDifference > 0;
  const leftTime = modifiedTime(left);
  const rightTime = modifiedTime(right);
  if (rightTime !== leftTime) return rightTime > leftTime;
  return right.path < left.path;
}

/**
 * Collapse byte-identical, renderable artifacts while keeping the strongest
 * provenance representative. Digest mismatches and invalid artifacts remain
 * individually visible so the inventory cannot hide an integrity diagnostic.
 */
export function groupDesignArtifacts<T extends GroupableDesignArtifact>(documents: readonly T[]): GroupedDesignArtifact<T>[] {
  const grouped: GroupedDesignArtifact<T>[] = [];
  const groupIndexBySha = new Map<string, number>();

  for (const document of documents) {
    const canGroup = document.status === "ready"
      && Boolean(document.sha256)
      && document.digestBinding?.status !== "mismatch";
    if (!canGroup) {
      grouped.push({ ...document, copyCount: 1 });
      continue;
    }

    const key = document.sha256!.toLocaleLowerCase();
    const existingIndex = groupIndexBySha.get(key);
    if (existingIndex === undefined) {
      groupIndexBySha.set(key, grouped.length);
      grouped.push({ ...document, copyCount: 1 });
      continue;
    }

    const existing = grouped[existingIndex];
    const copyCount = existing.copyCount + 1;
    grouped[existingIndex] = shouldReplaceRepresentative(existing, document)
      ? { ...document, copyCount }
      : { ...existing, copyCount };
  }

  return grouped;
}
