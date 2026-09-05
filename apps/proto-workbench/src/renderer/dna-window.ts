import type { DesignConstruct, DesignDirection } from "./design-visualization.ts";

export const DNA_SEQUENCE_WINDOW_BASES = 8_000;
export const DNA_WINDOW_MAX_INTERVALS = 400;

/** Window-local presentation coordinates; the immutable full construct is retained. */
export function dnaWindowProjection(construct: DesignConstruct, requestedStart: number) {
  if (!Number.isSafeInteger(requestedStart) || requestedStart < 0) throw new Error("Window start must be a non-negative integer.");
  const start = Math.min(requestedStart, Math.max(0, construct.length - DNA_SEQUENCE_WINDOW_BASES));
  const end = Math.min(construct.length, start + DNA_SEQUENCE_WINDOW_BASES);
  const annotations: Array<{ start: number; end: number; name: string; direction: DesignDirection; color: string }> = [];
  let total = 0;
  for (const feature of construct.features) for (const segment of feature.segments) {
    if (segment.end <= start || segment.start >= end) continue;
    total++;
    if (annotations.length >= DNA_WINDOW_MAX_INTERVALS) continue;
    const clipped = segment.start < start || segment.end > end;
    annotations.push({ start: Math.max(segment.start, start) - start, end: Math.min(segment.end, end) - start, name: `${feature.name ?? feature.id}${clipped ? " · clipped to window" : ""}`, direction: feature.direction, color: feature.color });
  }
  return { start, end, sequence: construct.sequence.slice(start, end), annotations, truncated: total > annotations.length };
}
