import type { DesignFeature } from "./design-visualization.ts";

export type FeatureInventorySource = "all" | DesignFeature["source"];
export type FeatureInventorySortKey = "coordinate" | "name" | "type" | "length";
export type FeatureInventorySortDirection = "asc" | "desc";

export interface FeatureInventoryOptions {
  query: string;
  type: string;
  source: FeatureInventorySource;
  sortKey: FeatureInventorySortKey;
  sortDirection: FeatureInventorySortDirection;
  hiddenFeatureIndexes?: ReadonlySet<number>;
}

export interface FeatureInventoryEntry {
  feature: DesignFeature;
  featureIndex: number;
  hidden: boolean;
}

export const MAX_FEATURE_FILTER_QUERY_CHARS = 128;

export function normalizeFeatureFilterQuery(value: string): string {
  return Array.from(value.trim()).slice(0, MAX_FEATURE_FILTER_QUERY_CHARS).join("");
}

export function featureInventoryTypes(features: readonly DesignFeature[]): string[] {
  return [...new Set(features.map((feature) => feature.type).filter(Boolean))]
    .sort((left, right) => compareText(left, right));
}

export function buildFeatureInventory(
  features: readonly DesignFeature[],
  options: FeatureInventoryOptions,
): FeatureInventoryEntry[] {
  const query = fold(normalizeFeatureFilterQuery(options.query));
  const type = options.type === "all" ? "all" : fold(options.type);

  const entries = features.flatMap((feature, featureIndex) => {
    if (type !== "all" && fold(feature.type) !== type) return [];
    if (options.source !== "all" && feature.source !== options.source) return [];
    if (query && !featureSearchText(feature).includes(query)) return [];
    return [{
      feature,
      featureIndex,
      hidden: options.hiddenFeatureIndexes?.has(featureIndex) ?? false,
    }];
  });

  return entries.sort((left, right) => {
    const primary = compareByKey(left.feature, right.feature, options.sortKey);
    const stable = primary
      || firstCoordinate(left.feature) - firstCoordinate(right.feature)
      || compareText(left.feature.id, right.feature.id)
      || left.featureIndex - right.featureIndex;
    return options.sortDirection === "desc" ? -stable : stable;
  });
}

function compareByKey(left: DesignFeature, right: DesignFeature, key: FeatureInventorySortKey): number {
  if (key === "name") return compareText(left.name || left.id, right.name || right.id);
  if (key === "type") return compareText(left.type, right.type);
  if (key === "length") return left.length - right.length;
  return firstCoordinate(left) - firstCoordinate(right);
}

function firstCoordinate(feature: DesignFeature): number {
  return feature.segments.reduce((minimum, segment) => Math.min(minimum, segment.start), Number.POSITIVE_INFINITY);
}

function featureSearchText(feature: DesignFeature): string {
  return fold([feature.id, feature.name ?? "", feature.type, feature.source].join("\n"));
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, "en", { numeric: true, sensitivity: "base" });
}

function fold(value: string): string {
  return value.toLocaleLowerCase("en-US");
}
