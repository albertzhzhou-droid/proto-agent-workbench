import type { DesignDirection } from "./design-visualization.ts";

export const CGVIEW_POPOVERS_ENABLED = false as const;

export interface SeqVizFeatureInterval {
  readonly start: number;
  readonly end: number;
  readonly direction: DesignDirection;
}

export interface CgviewFeatureCoordinates {
  readonly start: number;
  readonly stop: number;
  readonly strand?: -1 | 1;
}

export interface CgviewFeatureGeometry {
  readonly locations: ReadonlyArray<readonly [number, number]>;
  readonly strand?: -1 | 1;
}

/**
 * Convert a construct-local SeqViz interval ([start, end), zero-based) into
 * CGView coordinates (start/stop, one-based and inclusive).
 *
 * CGView only accepts direct or reverse strand values. An unknown direction
 * therefore remains absent instead of being presented as a known direction.
 */
export function toCgviewFeatureCoordinates(
  interval: SeqVizFeatureInterval,
  constructLength: number,
): CgviewFeatureCoordinates | undefined {
  if (!Number.isSafeInteger(constructLength) || constructLength < 1) return undefined;
  if (!Number.isSafeInteger(interval.start) || !Number.isSafeInteger(interval.end)) return undefined;
  if (interval.start < 0 || interval.end <= interval.start || interval.end > constructLength) return undefined;
  if (interval.direction !== -1 && interval.direction !== 0 && interval.direction !== 1) return undefined;

  const coordinates = { start: interval.start + 1, stop: interval.end };
  return interval.direction === 0
    ? coordinates
    : { ...coordinates, strand: interval.direction };
}

/**
 * Convert one logical feature with one or more canonical zero-based,
 * end-exclusive segments into CGView's one-based, inclusive multi-location
 * geometry. Segment order is preserved so circular origin-spanning features
 * retain their biological traversal order without reversed canonical ranges.
 */
export function toCgviewFeatureGeometry(
  segments: ReadonlyArray<Pick<SeqVizFeatureInterval, "start" | "end">>,
  direction: DesignDirection,
  constructLength: number,
): CgviewFeatureGeometry | undefined {
  if (!Array.isArray(segments) || segments.length === 0) return undefined;
  if (direction !== -1 && direction !== 0 && direction !== 1) return undefined;
  const locations: Array<readonly [number, number]> = [];
  for (const segment of segments) {
    const coordinates = toCgviewFeatureCoordinates({ ...segment, direction: 0 }, constructLength);
    if (!coordinates) return undefined;
    locations.push([coordinates.start, coordinates.stop]);
  }
  const geometry = { locations };
  return direction === 0 ? geometry : { ...geometry, strand: direction };
}
