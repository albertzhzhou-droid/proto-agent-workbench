import { discoverOpenReadingFrames, rotateCircularConstructView, searchDesign, type DesignConstruct, type DesignFeature, type DesignSearchHit, type DesignViewModel, type OrfDiscoveryResult } from "./design-visualization.ts";
import { buildFeatureInventory, featureInventoryTypes, type FeatureInventoryEntry, type FeatureInventoryOptions } from "./design-feature-inventory.ts";
import { calculateGcContentSeries, calculateGcSkewSeries, type GcContentSeries, type GcSkewSeries } from "./sequence-metrics.ts";
import { dnaWindowProjection } from "./dna-window.ts";
import { VISUALIZATION_INTERACTIVE_LIMITS } from "./visualization-envelope.ts";

export interface ScientificInputs {
  view: { design: DesignViewModel; discoverOrfs: boolean; minimumAminoAcids: number; viewOrigins: Record<number, number> };
  search: { design: DesignViewModel; query: string };
  inventory: { features: DesignFeature[]; options: Omit<FeatureInventoryOptions, "hiddenFeatureIndexes"> & { hiddenIndexes: number[] } };
  tracks: { sequence: string; circular: boolean; windowSize?: number };
  window: { construct: DesignConstruct; start: number };
}
export interface ScientificOutputs {
  view: { design: DesignViewModel; discoveredOrfs: OrfDiscoveryResult[] };
  search: DesignSearchHit[];
  inventory: { entries: FeatureInventoryEntry[]; types: string[] };
  tracks: { gcContent: GcContentSeries; gcSkew: GcSkewSeries };
  window: { projection: ReturnType<typeof dnaWindowProjection>; density: number[] };
}
export type ScientificKind = keyof ScientificInputs;
export type ScientificRequest<K extends ScientificKind = ScientificKind> = K extends ScientificKind ? { id: number; artifactIdentity: string; kind: K; input: ScientificInputs[K] } : never;
export type ScientificResponse<K extends ScientificKind = ScientificKind> = K extends ScientificKind ? { id: number; artifactIdentity: string; kind: K } & ({ result: ScientificOutputs[K] } | { error: string }) : never;

/** Pure, deterministic computations shared by the local worker and parity tests. */
export function computeScientific<K extends ScientificKind>(kind: K, input: ScientificInputs[K]): ScientificOutputs[K] {
  // The discriminated worker request is checked before dispatch; each branch keeps
  // the public input/output map precise for callers.
  if (kind === "view") {
    const request = input as ScientificInputs["view"];
    const discoveredOrfs = request.design.constructs.map((construct) => {
      const available = VISUALIZATION_INTERACTIVE_LIMITS.maxFeatures - construct.features.length;
      if (!request.discoverOrfs || construct.length > VISUALIZATION_INTERACTIVE_LIMITS.maxBases || available < 1) return { features: [], truncated: false };
      return discoverOpenReadingFrames(construct.sequence, { topology: construct.topology, constructStart: construct.start, minimumAminoAcids: request.minimumAminoAcids, maximumFeatures: available });
    });
    const design = { ...request.design, constructs: request.design.constructs.map((construct, index) => rotateCircularConstructView({ ...construct, features: [...construct.features, ...discoveredOrfs[index].features] }, request.viewOrigins[index] ?? 0)) };
    return { design, discoveredOrfs } as ScientificOutputs[K];
  }
  if (kind === "search") {
    const request = input as ScientificInputs["search"];
    return searchDesign(request.design, request.query) as ScientificOutputs[K];
  }
  if (kind === "inventory") {
    const request = input as ScientificInputs["inventory"];
    return { entries: buildFeatureInventory(request.features, { ...request.options, hiddenFeatureIndexes: new Set(request.options.hiddenIndexes) }), types: featureInventoryTypes(request.features) } as ScientificOutputs[K];
  }
  if (kind === "tracks") {
    const request = input as ScientificInputs["tracks"];
    return { gcContent: calculateGcContentSeries(request.sequence, request.circular, 96, request.windowSize), gcSkew: calculateGcSkewSeries(request.sequence, request.circular, 96, request.windowSize) } as ScientificOutputs[K];
  }
  if (kind === "window") {
    const { construct, start } = input as ScientificInputs["window"];
    if (construct.length > VISUALIZATION_INTERACTIVE_LIMITS.maxWindowedBases || construct.features.length > 20_000) throw new RangeError("Sequence window exceeds the bounded review envelope.");
    const bins = new Uint16Array(200);
    for (const feature of construct.features) for (const segment of feature.segments) {
      const first = Math.floor(segment.start / construct.length * bins.length);
      const last = Math.min(bins.length - 1, Math.floor((segment.end - 1) / construct.length * bins.length));
      for (let bin = first; bin <= last; bin++) bins[bin] = Math.min(65535, bins[bin] + 1);
    }
    const max = Math.max(1, ...bins);
    return { projection: dnaWindowProjection(construct, start), density: Array.from(bins, (value) => value / max) } as ScientificOutputs[K];
  }
  throw new Error("Unknown scientific computation.");
}
