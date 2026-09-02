import type {
  FeatureInventorySortDirection,
  FeatureInventorySortKey,
  FeatureInventorySource,
} from "./design-feature-inventory.ts";

export const DESIGN_VIEW_PREFERENCES_SCHEMA = "proto-workbench.design-view-preferences.v1" as const;
export const DESIGN_VIEW_PREFERENCES_STORAGE_KEY = DESIGN_VIEW_PREFERENCES_SCHEMA;
export const MAX_SAVED_DESIGN_VIEW_PREFERENCES = 32;

export type DesignViewerMode = "both" | "circular" | "linear";
export type DesignLabelDensity = "auto" | "hidden" | "balanced" | "dense";

export interface PersistedDesignLayerState {
  annotations: boolean;
  complement: boolean;
  discoveredOrfs: boolean;
  gcContent: boolean;
  gcSkew: boolean;
  index: boolean;
  primers: boolean;
  restrictionSites: boolean;
  translations: boolean;
}

export interface PersistedDesignViewPreferences {
  viewerMode: DesignViewerMode;
  selectedConstructIndex: number;
  layers: PersistedDesignLayerState;
  labelDensity: DesignLabelDensity;
  linearZoom: number;
  gcWindowSize: 0 | 11 | 21 | 51 | 101;
  orfMinimumAminoAcids: 4 | 10 | 30 | 100;
  viewOrigins: Record<number, number>;
  hiddenFeatureIndexesByConstruct: Record<number, number[]>;
  inventory: {
    query: string;
    type: string;
    source: FeatureInventorySource;
    sortKey: FeatureInventorySortKey;
    sortDirection: FeatureInventorySortDirection;
  };
}

interface StoredPreferenceEntry {
  artifactSha256: string;
  savedAt: string;
  preferences: PersistedDesignViewPreferences;
}

interface StoredPreferenceEnvelope {
  schema: typeof DESIGN_VIEW_PREFERENCES_SCHEMA;
  entries: StoredPreferenceEntry[];
}

export interface DesignPreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const ARTIFACT_SHA256 = /^[a-f0-9]{64}$/i;
const VIEWER_MODES = new Set<DesignViewerMode>(["both", "circular", "linear"]);
const LABEL_DENSITIES = new Set<DesignLabelDensity>(["auto", "hidden", "balanced", "dense"]);
const GC_WINDOWS = new Set([0, 11, 21, 51, 101]);
const ORF_MINIMUMS = new Set([4, 10, 30, 100]);
const INVENTORY_SOURCES = new Set<FeatureInventorySource>(["all", "part", "annotation", "software"]);
const INVENTORY_SORT_KEYS = new Set<FeatureInventorySortKey>(["coordinate", "name", "type", "length"]);
const INVENTORY_SORT_DIRECTIONS = new Set<FeatureInventorySortDirection>(["asc", "desc"]);
const LAYER_KEYS = ["annotations", "complement", "discoveredOrfs", "gcContent", "gcSkew", "index", "primers", "restrictionSites", "translations"] as const;

export function readDesignViewPreferences(
  storage: DesignPreferenceStorage,
  artifactSha256: string,
): PersistedDesignViewPreferences | undefined {
  if (!ARTIFACT_SHA256.test(artifactSha256)) return undefined;
  try {
    const envelope = parseEnvelope(storage.getItem(DESIGN_VIEW_PREFERENCES_STORAGE_KEY));
    return envelope?.entries.find((entry) => entry.artifactSha256.toLocaleLowerCase() === artifactSha256.toLocaleLowerCase())?.preferences;
  } catch {
    return undefined;
  }
}

export function writeDesignViewPreferences(
  storage: DesignPreferenceStorage,
  artifactSha256: string,
  preferences: PersistedDesignViewPreferences,
  now = new Date(),
): boolean {
  if (!ARTIFACT_SHA256.test(artifactSha256) || !validPreferences(preferences) || !Number.isFinite(now.getTime())) return false;
  try {
    const existing = parseEnvelope(storage.getItem(DESIGN_VIEW_PREFERENCES_STORAGE_KEY));
    const normalizedSha = artifactSha256.toLocaleLowerCase();
    const entries = [
      { artifactSha256: normalizedSha, savedAt: now.toISOString(), preferences },
      ...(existing?.entries ?? []).filter((entry) => entry.artifactSha256.toLocaleLowerCase() !== normalizedSha),
    ].slice(0, MAX_SAVED_DESIGN_VIEW_PREFERENCES);
    storage.setItem(DESIGN_VIEW_PREFERENCES_STORAGE_KEY, JSON.stringify({ schema: DESIGN_VIEW_PREFERENCES_SCHEMA, entries }));
    return true;
  } catch {
    return false;
  }
}

function parseEnvelope(value: string | null): StoredPreferenceEnvelope | undefined {
  if (!value || value.length > 512_000) return undefined;
  const parsed: unknown = JSON.parse(value);
  if (!isRecord(parsed) || parsed.schema !== DESIGN_VIEW_PREFERENCES_SCHEMA || !Array.isArray(parsed.entries) || parsed.entries.length > MAX_SAVED_DESIGN_VIEW_PREFERENCES) return undefined;
  const entries: StoredPreferenceEntry[] = [];
  for (const candidate of parsed.entries) {
    if (!isRecord(candidate)
      || typeof candidate.artifactSha256 !== "string"
      || !ARTIFACT_SHA256.test(candidate.artifactSha256)
      || typeof candidate.savedAt !== "string"
      || !Number.isFinite(Date.parse(candidate.savedAt))
      || !validPreferences(candidate.preferences)) return undefined;
    entries.push({
      artifactSha256: candidate.artifactSha256.toLocaleLowerCase(),
      savedAt: candidate.savedAt,
      preferences: candidate.preferences,
    });
  }
  return { schema: DESIGN_VIEW_PREFERENCES_SCHEMA, entries };
}

function validPreferences(value: unknown): value is PersistedDesignViewPreferences {
  if (!isRecord(value)
    || typeof value.viewerMode !== "string" || !VIEWER_MODES.has(value.viewerMode as DesignViewerMode)
    || !boundedInteger(value.selectedConstructIndex, 0, 63)
    || typeof value.labelDensity !== "string" || !LABEL_DENSITIES.has(value.labelDensity as DesignLabelDensity)
    || !boundedInteger(value.linearZoom, 20, 100)
    || !boundedInteger(value.gcWindowSize, 0, 101) || !GC_WINDOWS.has(value.gcWindowSize)
    || !boundedInteger(value.orfMinimumAminoAcids, 4, 100) || !ORF_MINIMUMS.has(value.orfMinimumAminoAcids)
    || !validLayers(value.layers)
    || !validNumericRecord(value.viewOrigins, 64, 1_999_999)
    || !validIndexLists(value.hiddenFeatureIndexesByConstruct)
    || !validInventory(value.inventory)) return false;
  return true;
}

function validLayers(value: unknown): value is PersistedDesignLayerState {
  return isRecord(value) && LAYER_KEYS.every((key) => typeof value[key] === "boolean");
}

function validInventory(value: unknown): boolean {
  return isRecord(value)
    && typeof value.query === "string" && Array.from(value.query).length <= 128
    && typeof value.type === "string" && Array.from(value.type).length <= 64
    && typeof value.source === "string" && INVENTORY_SOURCES.has(value.source as FeatureInventorySource)
    && typeof value.sortKey === "string" && INVENTORY_SORT_KEYS.has(value.sortKey as FeatureInventorySortKey)
    && typeof value.sortDirection === "string" && INVENTORY_SORT_DIRECTIONS.has(value.sortDirection as FeatureInventorySortDirection);
}

function validNumericRecord(value: unknown, maxEntries: number, maxValue: number): value is Record<number, number> {
  if (!isRecord(value) || Object.keys(value).length > maxEntries) return false;
  return Object.entries(value).every(([key, item]) => /^\d{1,2}$/.test(key) && boundedInteger(Number(key), 0, 63) && boundedInteger(item, 0, maxValue));
}

function validIndexLists(value: unknown): value is Record<number, number[]> {
  if (!isRecord(value) || Object.keys(value).length > 64) return false;
  return Object.entries(value).every(([key, items]) => /^\d{1,2}$/.test(key)
    && boundedInteger(Number(key), 0, 63)
    && Array.isArray(items)
    && items.length <= 750
    && new Set(items).size === items.length
    && items.every((item) => boundedInteger(item, 0, 749)));
}

function boundedInteger(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
