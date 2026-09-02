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

/** Normalize either drag direction into the canonical [start, end) interval. */
export function normalizeSequenceSelection(selection: RawSequenceSelection, sequenceLength: number): NormalizedSequenceSelection | undefined {
  if (!Number.isSafeInteger(sequenceLength) || sequenceLength < 1) return undefined;
  if (!Number.isSafeInteger(selection.start) || !Number.isSafeInteger(selection.end)) return undefined;
  const start = Math.min(selection.start!, selection.end!);
  const end = Math.max(selection.start!, selection.end!);
  if (start < 0 || end <= start || end > sequenceLength) return undefined;
  return { start, end, viewer: selection.viewer };
}
