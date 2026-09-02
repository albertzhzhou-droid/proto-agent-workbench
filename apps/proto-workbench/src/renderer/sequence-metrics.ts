export interface GcContentSeries {
  /** One-based positions for CGView plot input. */
  readonly positions: number[];
  readonly scores: number[];
  readonly baseline: number;
  readonly windowSize: number;
}

export interface GcSkewSeries {
  /** One-based positions for CGView plot input. */
  readonly positions: number[];
  /** Sliding-window (G-C)/(G+C), bounded to -1 through +1. */
  readonly scores: number[];
  readonly baseline: 0;
  readonly overallSkew: number;
  readonly windowSize: number;
}

interface WindowLayout {
  readonly centers: number[];
  readonly positions: number[];
  readonly radius: number;
  readonly windowSize: number;
}

function gcFraction(sequence: string): number {
  if (!sequence.length) return 0;
  let gc = 0;
  for (const base of sequence) {
    if (base === "G" || base === "C") gc += 1;
  }
  return gc / sequence.length;
}

/**
 * Produce a bounded sliding-window GC series for the CGView plot renderer.
 * Ambiguous IUPAC symbols stay in the denominator, matching the construct
 * summary metric and avoiding an implied base call.
 */
export function calculateGcContentSeries(sequence: string, circular: boolean, maxPoints = 96, requestedWindowSize?: number): GcContentSeries {
  if (!Number.isInteger(maxPoints) || maxPoints < 2) throw new RangeError("maxPoints must be an integer of at least 2.");
  if (!sequence.length) return { positions: [], scores: [], baseline: 0, windowSize: 0 };

  const normalized = sequence.toLocaleUpperCase();
  const layout = buildWindowLayout(normalized.length, maxPoints, requestedWindowSize);
  const scores: number[] = [];

  for (const center of layout.centers) {
    let gc = 0;
    let observed = 0;
    for (const sequenceIndex of windowIndexes(center, layout.radius, normalized.length, circular)) {
      observed += 1;
      const base = normalized[sequenceIndex];
      if (base === "G" || base === "C") gc += 1;
    }
    scores.push(observed ? gc / observed : 0);
  }

  return {
    positions: layout.positions,
    scores,
    baseline: gcFraction(normalized),
    windowSize: layout.windowSize,
  };
}

/**
 * Produce a bounded sliding-window GC-skew series. Only observed G/C bases are
 * included in the ratio denominator; windows without either base are neutral.
 */
export function calculateGcSkewSeries(sequence: string, circular: boolean, maxPoints = 96, requestedWindowSize?: number): GcSkewSeries {
  if (!Number.isInteger(maxPoints) || maxPoints < 2) throw new RangeError("maxPoints must be an integer of at least 2.");
  if (!sequence.length) return { positions: [], scores: [], baseline: 0, overallSkew: 0, windowSize: 0 };

  const normalized = sequence.toLocaleUpperCase();
  const layout = buildWindowLayout(normalized.length, maxPoints, requestedWindowSize);
  const scores: number[] = [];

  for (const center of layout.centers) {
    let guanine = 0;
    let cytosine = 0;
    for (const sequenceIndex of windowIndexes(center, layout.radius, normalized.length, circular)) {
      const base = normalized[sequenceIndex];
      if (base === "G") guanine += 1;
      if (base === "C") cytosine += 1;
    }
    const observedGc = guanine + cytosine;
    scores.push(observedGc ? (guanine - cytosine) / observedGc : 0);
  }

  let totalGuanine = 0;
  let totalCytosine = 0;
  for (const base of normalized) {
    if (base === "G") totalGuanine += 1;
    if (base === "C") totalCytosine += 1;
  }
  const observedGc = totalGuanine + totalCytosine;

  return {
    positions: layout.positions,
    scores,
    baseline: 0,
    overallSkew: observedGc ? (totalGuanine - totalCytosine) / observedGc : 0,
    windowSize: layout.windowSize,
  };
}

function buildWindowLayout(sequenceLength: number, maxPoints: number, requestedWindowSize?: number): WindowLayout {
  if (requestedWindowSize !== undefined && (!Number.isInteger(requestedWindowSize) || requestedWindowSize < 1 || requestedWindowSize % 2 === 0)) {
    throw new RangeError("requestedWindowSize must be a positive odd integer.");
  }
  const pointCount = Math.min(sequenceLength, maxPoints);
  let windowSize = requestedWindowSize ?? Math.min(101, Math.max(sequenceLength >= 3 ? 3 : 1, Math.floor(sequenceLength / 10)));
  if (windowSize % 2 === 0) windowSize += 1;
  windowSize = Math.min(windowSize, sequenceLength % 2 === 0 ? Math.max(1, sequenceLength - 1) : sequenceLength);
  const centers = Array.from({ length: pointCount }, (_, index) => pointCount === 1 ? 0 : Math.round(index * (sequenceLength - 1) / (pointCount - 1)));
  return {
    centers,
    positions: centers.map((center) => center + 1),
    radius: Math.floor(windowSize / 2),
    windowSize,
  };
}

function windowIndexes(center: number, radius: number, sequenceLength: number, circular: boolean): number[] {
  const indexes: number[] = [];
  for (let offset = -radius; offset <= radius; offset += 1) {
    let sequenceIndex = center + offset;
    if (circular) {
      sequenceIndex = (sequenceIndex + sequenceLength) % sequenceLength;
    } else if (sequenceIndex < 0 || sequenceIndex >= sequenceLength) {
      continue;
    }
    indexes.push(sequenceIndex);
  }
  return indexes;
}
