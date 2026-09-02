export interface RawSequenceSelection {
  readonly start?: number;
  readonly end?: number;
  readonly viewer?: "LINEAR" | "CIRCULAR";
}

export interface NormalizedSequenceSelection {
  readonly start: number;
  readonly end: number;
  readonly viewer?: "LINEAR" | "CIRCULAR";
}

export interface NormalizedSegmentedSequenceSelection extends NormalizedSequenceSelection {
  readonly segments: Array<{ readonly start: number; readonly end: number }>;
  readonly sourceSegments?: Array<{ readonly start: number; readonly end: number }>;
}

/** Normalize either drag direction into the canonical [start, end) interval. */
export function normalizeSequenceSelection(selection: RawSequenceSelection, sequenceLength: number): NormalizedSequenceSelection | undefined {
  if (!Number.isSafeInteger(sequenceLength) || sequenceLength < 1) return undefined;
  if (!Number.isSafeInteger(selection.start) || !Number.isSafeInteger(selection.end)) return undefined;
  const start = Math.min(selection.start!, selection.end!);
  const end = Math.max(selection.start!, selection.end!);
  if (start < 0 || end <= start || end > sequenceLength) return undefined;
  return { start, end, viewer: selection.viewer };
}

/** Preserve a complete logical hit when a circular search crosses the displayed or source origin. */
export function normalizeSegmentedSequenceSelection(
  segments: ReadonlyArray<{ readonly start: number; readonly end: number }>,
  sequenceLength: number,
  sourceSegments?: ReadonlyArray<{ readonly start: number; readonly end: number }>,
): NormalizedSegmentedSequenceSelection | undefined {
  if (!Array.isArray(segments) || segments.length < 1 || segments.length > 2) return undefined;
  const normalized = segments.map((segment) => normalizeSequenceSelection(segment, sequenceLength));
  if (normalized.some((segment) => segment === undefined)) return undefined;
  const viewSegments = normalized as NormalizedSequenceSelection[];
  const selectedLength = viewSegments.reduce((sum, segment) => sum + segment.end - segment.start, 0);
  if (selectedLength < 1 || selectedLength > sequenceLength) return undefined;
  let canonicalSourceSegments: NormalizedSequenceSelection[] | undefined;
  if (sourceSegments !== undefined) {
    if (!Array.isArray(sourceSegments) || sourceSegments.length < 1 || sourceSegments.length > 2) return undefined;
    const checked = sourceSegments.map((segment) => normalizeSequenceSelection(segment, sequenceLength));
    if (checked.some((segment) => segment === undefined)) return undefined;
    canonicalSourceSegments = checked as NormalizedSequenceSelection[];
    const sourceLength = canonicalSourceSegments.reduce((sum, segment) => sum + segment.end - segment.start, 0);
    if (sourceLength !== selectedLength) return undefined;
  }
  return {
    start: viewSegments[0].start,
    end: viewSegments[0].end,
    segments: viewSegments.map(({ start, end }) => ({ start, end })),
    sourceSegments: canonicalSourceSegments?.map(({ start, end }) => ({ start, end })),
  };
}
