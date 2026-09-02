import {
  ArrowDown,
  ArrowUp,
  Atom,
  BadgeCheck,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Dna,
  Download,
  Eye,
  EyeOff,
  ExternalLink,
  FileJson2,
  FolderOpen,
  History,
  Layers3,
  LocateFixed,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  Search,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { SeqViz, type SeqVizProps } from "seqviz";
import type { MapExportVerificationReceipt, WorkspaceEntry } from "../shared/contracts.ts";
import {
  digestBindingForArtifact,
  parseDesignRunManifest,
  parseDesignProvenanceStatement,
  provenanceForArtifact,
  summarizeDesignProvenanceInventory,
  type DesignArtifactDigestBinding,
  type DesignProvenanceInventoryCandidate,
  type DesignProvenanceInventoryDiagnostic,
  type DesignRunProvenance,
} from "./design-artifacts.ts";
import {
  discoverOpenReadingFrames,
  parseDesignIr,
  rotateCircularConstructView,
  searchDesign,
  viewBaseToSourceBase,
  viewIntervalToSourceSegments,
  type DesignConstruct,
  type DesignDiagnostic,
  type DesignFeature,
  type DesignSearchHit,
  type DesignViewModel,
} from "./design-visualization.ts";
import { groupDesignArtifacts } from "./design-inventory.ts";
import { normalizeSequenceSelection } from "./design-selection.ts";
import { mapWithConcurrency } from "./bounded-concurrency.ts";
import { CGVIEW_RENDERER_VERSION, CgviewMap, type ProductMapHandle } from "./CgviewMap.tsx";
import { SequenceNavigator } from "./SequenceNavigator.tsx";
import { ProteinSequenceView } from "./ProteinSequenceView.tsx";
import type { MapExportMetadata } from "./map-export.ts";
import { calculateGcContentSeries } from "./sequence-metrics.ts";
import { workbenchApi, workbenchDataMode } from "./mock-api.ts";
import { useWorkbenchStore } from "./store.ts";
import { VisualizationErrorBoundary } from "./VisualizationErrorBoundary.tsx";
import { classifyVisualizationEnvelope, VISUALIZATION_INTERACTIVE_LIMITS } from "./visualization-envelope.ts";
import {
  buildFeatureInventory,
  featureInventoryTypes,
  normalizeFeatureFilterQuery,
  type FeatureInventorySortDirection,
  type FeatureInventorySortKey,
  type FeatureInventorySource,
} from "./design-feature-inventory.ts";
import {
  readDesignViewPreferences,
  writeDesignViewPreferences,
  type DesignLabelDensity,
  type PersistedDesignViewPreferences,
} from "./design-view-preferences.ts";

type ViewerMode = NonNullable<SeqVizProps["viewer"]>;
type SeqVizSelection = Parameters<NonNullable<SeqVizProps["onSelection"]>>[0];

interface LoadedDesign {
  path: string;
  relativePath: string;
  name: string;
  modifiedAt: string;
  sizeBytes: number;
  status: "ready" | "invalid";
  sha256?: string;
  design?: DesignViewModel;
  diagnostics: DesignDiagnostic[];
  error?: string;
  provenance?: DesignRunProvenance;
  digestBinding?: DesignArtifactDigestBinding;
  copyCount?: number;
}

interface LoadedManifest {
  entry: WorkspaceEntry;
  provenance?: DesignRunProvenance;
  error?: string;
}

interface ProvenanceInventoryState {
  status: "loading" | "complete" | "incomplete";
  diagnostics: DesignProvenanceInventoryDiagnostic[];
}

type InventoryCandidate =
  | { kind: "manifest"; entry: WorkspaceEntry }
  | { kind: "provenance"; entry: WorkspaceEntry };

type LoadedInventoryCandidate =
  | { kind: "manifest"; result: LoadedManifest }
  | { kind: "provenance"; result: DesignProvenanceInventoryCandidate };

interface RangeSelection {
  start: number;
  end: number;
  viewer?: "LINEAR" | "CIRCULAR";
}

interface LayerState {
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

const DEFAULT_LAYERS: LayerState = {
  annotations: true,
  complement: true,
  discoveredOrfs: false,
  gcContent: true,
  gcSkew: false,
  index: true,
  primers: true,
  restrictionSites: true,
  translations: true,
};

export function DesignsPage() {
  const entries = useWorkbenchStore((state) => state.workspaceEntries);
  const refreshWorkspaceEntries = useWorkbenchStore((state) => state.refreshWorkspaceEntries);
  const [documents, setDocuments] = useState<LoadedDesign[]>([]);
  const [selectedPath, setSelectedPath] = useState<string>();
  const [constructIndex, setConstructIndex] = useState(0);
  const [featurePage, setFeaturePage] = useState(0);
  const [selectedFeatureIndex, setSelectedFeatureIndex] = useState<number>();
  const [rangeSelection, setRangeSelection] = useState<RangeSelection>();
  const [viewerMode, setViewerMode] = useState<ViewerMode>("both");
  const [layers, setLayers] = useState<LayerState>(DEFAULT_LAYERS);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchCursor, setSearchCursor] = useState(0);
  const [linearZoom, setLinearZoom] = useState(62);
  const [gcWindowSize, setGcWindowSize] = useState(0);
  const [orfMinimumAminoAcids, setOrfMinimumAminoAcids] = useState(30);
  const [viewOrigins, setViewOrigins] = useState<Record<number, number>>({});
  const [labelDensity, setLabelDensity] = useState<DesignLabelDensity>("auto");
  const [featureFilterQuery, setFeatureFilterQuery] = useState("");
  const [featureTypeFilter, setFeatureTypeFilter] = useState("all");
  const [featureSourceFilter, setFeatureSourceFilter] = useState<FeatureInventorySource>("all");
  const [featureSortKey, setFeatureSortKey] = useState<FeatureInventorySortKey>("coordinate");
  const [featureSortDirection, setFeatureSortDirection] = useState<FeatureInventorySortDirection>("asc");
  const [hiddenFeatureIndexesByConstruct, setHiddenFeatureIndexesByConstruct] = useState<Record<number, number[]>>({});
  const [preferenceArtifactKey, setPreferenceArtifactKey] = useState<string>();
  const [viewerRevision, setViewerRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string>();
  const [provenanceInventory, setProvenanceInventory] = useState<ProvenanceInventoryState>({ status: "loading", diagnostics: [] });
  const [notice, setNotice] = useState<string>();
  const [exportingFormat, setExportingFormat] = useState<"svg" | "png">();
  const [exportReceipt, setExportReceipt] = useState<MapExportVerificationReceipt>();
  const [exportFailure, setExportFailure] = useState<{ format: "svg" | "png"; message: string }>();
  const [mapHoverBase, setMapHoverBase] = useState<number>();
  const mapRef = useRef<ProductMapHandle>(null);
  const loadGeneration = useRef(0);
  const dataMode = workbenchDataMode();

  useEffect(() => {
    const generation = ++loadGeneration.current;
    const candidates = entries
      .filter((entry) => /(^|[\\/])build[\\/].+\.ir\.json$/i.test(entry.relativePath))
      .sort((left, right) => Date.parse(right.modifiedAt) - Date.parse(left.modifiedAt));
    const manifestCandidates = entries
      .filter((entry) => /(^|[\\/])build[\\/]runs[\\/].+[\\/]manifest\.json$/i.test(entry.relativePath))
      .sort((left, right) => Date.parse(right.modifiedAt) - Date.parse(left.modifiedAt));
    const provenanceCandidates = entries
      .filter((entry) => /(^|[\\/])build[\\/]runs[\\/].+[\\/]provenance\.json$/i.test(entry.relativePath))
      .sort((left, right) => Date.parse(right.modifiedAt) - Date.parse(left.modifiedAt));
    const inventoryCandidates: InventoryCandidate[] = [
      ...manifestCandidates.map((entry) => ({ kind: "manifest" as const, entry })),
      ...provenanceCandidates.map((entry) => ({ kind: "provenance" as const, entry })),
    ];
    const isCurrentGeneration = () => generation === loadGeneration.current;
    setLoading(true);
    setLoadError(undefined);
    setProvenanceInventory({ status: "loading", diagnostics: [] });

    const loadManifest = async (entry: WorkspaceEntry): Promise<LoadedManifest> => {
      try {
        const file = await workbenchApi().files.read(entry.path);
        const parsed = parseDesignRunManifest(JSON.parse(file.content) as unknown, entry.path);
        return parsed.ok ? { entry, provenance: parsed.manifest } : { entry, error: parsed.error };
      } catch (error) {
        return { entry, error: String(error).replace(/^Error:\s*/i, "") };
      }
    };

    const loadProvenance = async (entry: WorkspaceEntry): Promise<DesignProvenanceInventoryCandidate> => {
      try {
        const file = await workbenchApi().files.read(entry.path);
        const parsed = parseDesignProvenanceStatement(JSON.parse(file.content) as unknown, entry.path);
        return parsed.ok
          ? { path: entry.relativePath, statement: parsed.statement }
          : { path: entry.relativePath, error: parsed.error };
      } catch (error) {
        return {
          path: entry.relativePath,
          error: String(error).replace(/^Error:\s*/i, "") || "The provenance statement could not be read.",
        };
      }
    };

    void mapWithConcurrency<InventoryCandidate, LoadedInventoryCandidate>(inventoryCandidates, 8, async (candidate) => candidate.kind === "manifest"
      ? { kind: "manifest", result: await loadManifest(candidate.entry) }
      : { kind: "provenance", result: await loadProvenance(candidate.entry) }, isCurrentGeneration).then(async (inventoryResults) => {
      const manifestResults = inventoryResults.flatMap((item) => item.kind === "manifest" ? [item.result] : []);
      const provenanceResults = inventoryResults.flatMap((item) => item.kind === "provenance" ? [item.result] : []);
      const manifests = manifestResults.flatMap((item) => item.provenance ? [item.provenance] : []);
      const inventory = summarizeDesignProvenanceInventory(provenanceResults);
      const provenanceStatements = inventory.statements;
      const loaded = await mapWithConcurrency(candidates, 8, async (entry): Promise<LoadedDesign> => {
        try {
          const file = await workbenchApi().files.read(entry.path);
          const parsedJson: unknown = JSON.parse(file.content);
          const parsed = parseDesignIr(parsedJson);
          const provenance = provenanceForArtifact(entry.relativePath, manifests);
          const digestBinding = digestBindingForArtifact(entry.relativePath, file.sha256, entry.sizeBytes, provenanceStatements);
          if (!parsed.ok || !parsed.design) {
            const primary = parsed.diagnostics.find((item) => item.severity === "error");
            return {
              path: entry.path,
              relativePath: entry.relativePath,
              name: entry.name,
              modifiedAt: entry.modifiedAt,
              sizeBytes: entry.sizeBytes,
              status: "invalid",
              sha256: file.sha256,
              diagnostics: parsed.diagnostics,
              error: primary?.message ?? "The artifact did not pass the Proto IR visualization contract.",
              provenance,
              digestBinding,
            };
          }
          return {
            path: entry.path,
            relativePath: entry.relativePath,
            name: entry.name,
            modifiedAt: entry.modifiedAt,
            sizeBytes: entry.sizeBytes,
            status: "ready",
            sha256: file.sha256,
            design: parsed.design,
            diagnostics: parsed.diagnostics,
            provenance,
            digestBinding,
          };
        } catch (error) {
          return {
            path: entry.path,
            relativePath: entry.relativePath,
            name: entry.name,
            modifiedAt: entry.modifiedAt,
            sizeBytes: entry.sizeBytes,
            status: "invalid",
            diagnostics: [],
            error: String(error).replace(/^Error:\s*/i, ""),
          };
        }
      }, isCurrentGeneration);
      return { inventory, loaded };
    }).then(({ inventory, loaded }) => {
      if (generation !== loadGeneration.current) return;
      const grouped = groupDesignArtifacts(loaded);
      const firstReady = grouped.find((item) => item.status === "ready");
      setProvenanceInventory({
        status: inventory.complete ? "complete" : "incomplete",
        diagnostics: inventory.diagnostics,
      });
      setDocuments(grouped);
      setSelectedPath((current) => grouped.some((item) => item.path === current) ? current : firstReady?.path ?? grouped[0]?.path);
      setConstructIndex(0);
      setFeaturePage(0);
      setSelectedFeatureIndex(undefined);
      setRangeSelection(undefined);
      setViewOrigins({});
      if (candidates.length > 0 && !firstReady) {
        setLoadError("Build artifacts were found, but none passed the Proto IR visualization contract. Select an artifact to inspect its diagnostics.");
      }
    }).catch((error: unknown) => {
      if (generation !== loadGeneration.current) return;
      const message = String(error).replace(/^Error:\s*/i, "") || "The design inventory could not be loaded.";
      setProvenanceInventory({
        status: "incomplete",
        diagnostics: [{ path: "build/", message }],
      });
      setLoadError(message);
    }).finally(() => {
      if (generation === loadGeneration.current) setLoading(false);
    });

    return () => {
      loadGeneration.current += 1;
    };
  }, [entries]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(undefined), 3200);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const selectedDocument = documents.find((item) => item.path === selectedPath) ?? documents[0];
  const design = selectedDocument?.status === "ready" ? selectedDocument.design : undefined;

  useEffect(() => {
    const artifactSha256 = selectedDocument?.sha256;
    setPreferenceArtifactKey(undefined);
    setFeaturePage(0);
    setSelectedFeatureIndex(undefined);
    setRangeSelection(undefined);
    if (!artifactSha256 || !design) return;

    const saved = readDesignViewPreferences(window.localStorage, artifactSha256);
    const nextConstructIndex = Math.min(saved?.selectedConstructIndex ?? 0, Math.max(0, design.constructs.length - 1));
    const nextViewOrigins = saved
      ? Object.fromEntries(Object.entries(saved.viewOrigins).filter(([index, origin]) => {
        const target = design.constructs[Number(index)];
        return target?.topology === "circular" && origin < target.length;
      }))
      : {};
    const nextHiddenFeatureIndexes = saved
      ? Object.fromEntries(Object.entries(saved.hiddenFeatureIndexesByConstruct).flatMap(([index, featureIndexes]) => {
        const target = design.constructs[Number(index)];
        if (!target) return [];
        return [[index, featureIndexes.filter((featureIndex) => featureIndex < target.features.length)]];
      }))
      : {};

    setViewerMode((saved?.viewerMode ?? "both") as ViewerMode);
    setConstructIndex(nextConstructIndex);
    setLayers(saved?.layers ?? DEFAULT_LAYERS);
    setLabelDensity(saved?.labelDensity ?? "auto");
    setLinearZoom(saved?.linearZoom ?? 62);
    setGcWindowSize(saved?.gcWindowSize ?? 0);
    setOrfMinimumAminoAcids(saved?.orfMinimumAminoAcids ?? 30);
    setViewOrigins(nextViewOrigins);
    setHiddenFeatureIndexesByConstruct(nextHiddenFeatureIndexes);
    setFeatureFilterQuery(saved?.inventory.query ?? "");
    setFeatureTypeFilter(saved?.inventory.type ?? "all");
    setFeatureSourceFilter(saved?.inventory.source ?? "all");
    setFeatureSortKey(saved?.inventory.sortKey ?? "coordinate");
    setFeatureSortDirection(saved?.inventory.sortDirection ?? "asc");
    setPreferenceArtifactKey(artifactSha256);
  }, [design, selectedDocument?.sha256]);

  useEffect(() => {
    if (!preferenceArtifactKey || preferenceArtifactKey !== selectedDocument?.sha256) return;
    const preferences: PersistedDesignViewPreferences = {
      viewerMode: viewerMode as PersistedDesignViewPreferences["viewerMode"],
      selectedConstructIndex: constructIndex,
      layers,
      labelDensity,
      linearZoom,
      gcWindowSize: gcWindowSize as PersistedDesignViewPreferences["gcWindowSize"],
      orfMinimumAminoAcids: orfMinimumAminoAcids as PersistedDesignViewPreferences["orfMinimumAminoAcids"],
      viewOrigins,
      hiddenFeatureIndexesByConstruct,
      inventory: {
        query: featureFilterQuery,
        type: featureTypeFilter,
        source: featureSourceFilter,
        sortKey: featureSortKey,
        sortDirection: featureSortDirection,
      },
    };
    const timer = window.setTimeout(() => {
      writeDesignViewPreferences(window.localStorage, preferenceArtifactKey, preferences);
    }, 160);
    return () => window.clearTimeout(timer);
  }, [constructIndex, featureFilterQuery, featureSortDirection, featureSortKey, featureSourceFilter, featureTypeFilter, gcWindowSize, hiddenFeatureIndexesByConstruct, labelDensity, layers, linearZoom, orfMinimumAminoAcids, preferenceArtifactKey, selectedDocument?.sha256, viewOrigins, viewerMode]);

  const sourceConstruct = design?.constructs[constructIndex] ?? design?.constructs[0];
  const discoveredOrfsByConstruct = useMemo(() => design?.constructs.map((item) => {
    if (!layers.discoveredOrfs || item.length > VISUALIZATION_INTERACTIVE_LIMITS.maxBases) {
      return { features: [], truncated: false };
    }
    const availableFeatureSlots = VISUALIZATION_INTERACTIVE_LIMITS.maxFeatures - item.features.length;
    if (availableFeatureSlots < 1) return { features: [], truncated: false };
    return discoverOpenReadingFrames(item.sequence, {
      topology: item.topology,
      constructStart: item.start,
      minimumAminoAcids: orfMinimumAminoAcids,
      maximumFeatures: availableFeatureSlots,
    });
  }) ?? [], [design, layers.discoveredOrfs, orfMinimumAminoAcids]);
  const visualDesign = useMemo(() => design ? {
    ...design,
    constructs: design.constructs.map((item, index) => {
      const enriched = layers.discoveredOrfs
        ? { ...item, features: [...item.features, ...(discoveredOrfsByConstruct[index]?.features ?? [])] }
        : item;
      return rotateCircularConstructView(enriched, viewOrigins[index] ?? 0);
    }),
  } : undefined, [design, discoveredOrfsByConstruct, layers.discoveredOrfs, viewOrigins]);
  const construct = visualDesign?.constructs[constructIndex] ?? visualDesign?.constructs[0];
  const activeViewOrigin = construct?.viewOrigin ?? 0;
  const orfDiscovery = discoveredOrfsByConstruct[constructIndex] ?? discoveredOrfsByConstruct[0] ?? { features: [], truncated: false };
  const selectedFeature = selectedFeatureIndex === undefined ? undefined : construct?.features[selectedFeatureIndex];
  const artifactIntegrityBlocked = selectedDocument?.digestBinding?.status === "mismatch";
  const provenanceInventoryBlocked = provenanceInventory.status !== "complete";
  const visualizationEnvelope = construct
    ? classifyVisualizationEnvelope(construct.length, construct.features.length)
    : { mode: "summary" as const, reasons: ["No renderable construct is selected."] };
  const interactiveVisualizationBlocked = visualizationEnvelope.mode === "summary";
  const selectionAnnouncement = selectedFeature
    ? `${selectedFeature.id}, ${selectedFeature.type}, ${formatFeatureIntervals(selectedFeature)}, selected in ${construct?.name ?? "the active construct"}.`
    : rangeSelection
      ? `Bases ${rangeSelection.start + 1} to ${rangeSelection.end}, ${rangeSelection.end - rangeSelection.start} base pairs, selected in ${construct?.name ?? "the active construct"}.`
      : `No feature or sequence range is selected in ${construct?.name ?? "the active construct"}.`;

  const searchHits = useMemo(() => visualDesign ? searchDesign(visualDesign, searchQuery) : [], [searchQuery, visualDesign]);
  const activeSearchHit = searchHits[searchCursor] ?? searchHits[0];
  const searchStatus = !searchQuery
    ? ""
    : searchHits.length === 0
      ? "No results"
      : `${Math.min(searchCursor + 1, searchHits.length)}/${searchHits.length} · ${activeSearchHit?.field ?? "match"}`;

  const showSearchHit = (hit?: DesignSearchHit) => {
    if (!visualDesign || !hit) return;
    if (hit.constructIndex === undefined) {
      setSelectedFeatureIndex(undefined);
      setRangeSelection(undefined);
      return;
    }
    const targetConstruct = visualDesign.constructs[hit.constructIndex];
    if (!targetConstruct) return;
    if (hit.constructIndex !== constructIndex) {
      setConstructIndex(hit.constructIndex);
      setViewerRevision((value) => value + 1);
    }
    const targetFeature = hit.featureIndex === undefined ? undefined : targetConstruct.features[hit.featureIndex];
    const selectsWholeFeature = Boolean(targetFeature && hit.field !== "sequence");
    setSelectedFeatureIndex(selectsWholeFeature ? hit.featureIndex : undefined);
    if (hit.featureIndex !== undefined) setFeaturePage(Math.floor(hit.featureIndex / VISUALIZATION_INTERACTIVE_LIMITS.maxAccessibleRows));
    setRangeSelection({ start: hit.start, end: hit.end });
  };

  useEffect(() => {
    setSearchCursor(0);
    showSearchHit(searchHits[0]);
  }, [searchHits, visualDesign]);

  useEffect(() => {
    if (selectedFeatureIndex === undefined || construct?.features[selectedFeatureIndex]) return;
    setSelectedFeatureIndex(undefined);
    setRangeSelection(undefined);
    setFeaturePage(0);
  }, [construct, selectedFeatureIndex]);

  const selectConstruct = (index: number) => {
    setConstructIndex(index);
    setFeaturePage(0);
    setSelectedFeatureIndex(undefined);
    setRangeSelection(undefined);
    setSearchQuery("");
    setSearchCursor(0);
    setViewerRevision((value) => value + 1);
  };

  const selectFeature = (index: number) => {
    const feature = construct?.features[index];
    const firstSegment = feature?.segments[0];
    if (!feature || !firstSegment) return;
    setSelectedFeatureIndex(index);
    setRangeSelection({ start: firstSegment.start, end: firstSegment.end });
  };

  const navigateToBase = (base: number) => {
    if (!construct || !Number.isSafeInteger(base) || base < 0 || base >= construct.length) return;
    setSelectedFeatureIndex(undefined);
    setRangeSelection({ start: base, end: base + 1, viewer: "LINEAR" });
  };

  const applyViewOrigin = (sourceOrigin: number) => {
    if (!sourceConstruct || sourceConstruct.topology !== "circular" || !Number.isSafeInteger(sourceOrigin) || sourceOrigin < 0 || sourceOrigin >= sourceConstruct.length) return;
    setViewOrigins((current) => sourceOrigin === 0
      ? Object.fromEntries(Object.entries(current).filter(([key]) => Number(key) !== constructIndex))
      : { ...current, [constructIndex]: sourceOrigin });
    setRangeSelection(undefined);
    setMapHoverBase(undefined);
    mapRef.current?.reset();
    setViewerRevision((value) => value + 1);
    setNotice(sourceOrigin === 0
      ? "Source origin restored; the IR and digest were never modified."
      : `View +1 now maps to source base ${sourceOrigin + 1}; this is a display-only transform.`);
  };

  const setViewOriginFromSelection = () => {
    if (!construct || !sourceConstruct || sourceConstruct.topology !== "circular") return;
    const viewBase = selectedFeature?.segments[0]?.start ?? rangeSelection?.start;
    if (viewBase === undefined) return;
    const sourceBase = viewBaseToSourceBase(viewBase, activeViewOrigin, construct.length);
    if (sourceBase !== undefined) applyViewOrigin(sourceBase);
  };

  const moveSearch = (direction: -1 | 1) => {
    if (searchHits.length === 0) return;
    const next = (searchCursor + direction + searchHits.length) % searchHits.length;
    setSearchCursor(next);
    showSearchHit(searchHits[next]);
  };

  const handleSelection = (selection: SeqVizSelection) => {
    if (!construct) return;
    const normalized = normalizeSequenceSelection(selection, construct.length);
    if (!normalized) return;
    setRangeSelection(normalized);
    const featureIndex = construct.features.findIndex((feature) => feature.segments.some(
      (segment) => segment.start === normalized.start && segment.end === normalized.end,
    ));
    setSelectedFeatureIndex(featureIndex >= 0 ? featureIndex : undefined);
    if (featureIndex >= 0) setFeaturePage(Math.floor(featureIndex / VISUALIZATION_INTERACTIVE_LIMITS.maxAccessibleRows));
  };

  const resetView = () => {
    setSelectedFeatureIndex(undefined);
    setRangeSelection(undefined);
    setSearchQuery("");
    setSearchCursor(0);
    setLinearZoom(62);
    setGcWindowSize(0);
    setOrfMinimumAminoAcids(30);
    setViewOrigins({});
    setLayers(DEFAULT_LAYERS);
    setViewerMode("both");
    setLabelDensity("auto");
    setFeatureFilterQuery("");
    setFeatureTypeFilter("all");
    setFeatureSourceFilter("all");
    setFeatureSortKey("coordinate");
    setFeatureSortDirection("asc");
    setHiddenFeatureIndexesByConstruct({});
    setFeaturePage(0);
    mapRef.current?.reset();
    setViewerRevision((value) => value + 1);
  };

  const mapExportMetadata = (format: "svg" | "png"): MapExportMetadata | undefined => {
    if (!design || !construct) return undefined;
    const effectiveGcWindowSize = calculateGcContentSeries(construct.sequence, construct.topology === "circular", 96, gcWindowSize || undefined).windowSize;
    return {
      schema: "proto-workbench.map-export.v1",
      exportedAt: new Date().toISOString(),
      format,
      designId: design.designId,
      construct: construct.name,
      artifactPath: selectedDocument?.relativePath,
      artifactSha256: selectedDocument?.sha256,
      digestStatus: selectedDocument?.digestBinding?.status ?? "unverified",
      renderer: { name: "CGView.js", version: CGVIEW_RENDERER_VERSION },
      topology: {
        source: construct.topology,
        rendered: construct.topology === "linear" ? "linear" : "circular",
        projection: construct.topology === "unknown",
      },
      viewOrigin: {
        applied: activeViewOrigin !== 0,
        sourceBaseOneBased: activeViewOrigin + 1,
        mutatesSource: false,
      },
      coordinates: "internal 0-based end-exclusive; display 1-based inclusive",
      renderedMapLayers: {
        partAnnotations: layers.annotations,
        softwareOrfDiscovery: layers.annotations && layers.discoveredOrfs && orfDiscovery.features.length > 0,
        softwareOrfMinimumAminoAcids: layers.discoveredOrfs ? orfMinimumAminoAcids : null,
        coordinateRuler: layers.index && construct.length >= 200,
        gcContentPlot: layers.gcContent,
        gcSkewPlot: layers.gcSkew,
        gcWindowSize: effectiveGcWindowSize,
        featureLabelDensity: effectiveLabelDensity,
        hiddenFeatureCount,
        selectionOverlay: false,
      },
      excludedUiOverlays: ["selection"],
      excludedSequenceLayers: ["complement", "restriction_sites", "translations"],
      reviewStatus: "human_review_required",
      dataMode,
    };
  };

  const exportMap = async (format: "svg" | "png") => {
    if (artifactIntegrityBlocked) {
      setNotice("Map export is blocked because the artifact does not match its recorded digest.");
      return;
    }
    if (provenanceInventoryBlocked) {
      setNotice(provenanceInventory.status === "loading"
        ? "Map export is blocked while the provenance inventory is being verified."
        : "Map export is blocked because the provenance inventory contains unreadable or invalid statements.");
      return;
    }
    if (interactiveVisualizationBlocked) {
      setNotice("Map export is unavailable while this construct is in bounded summary mode.");
      return;
    }
    if (!construct || !design || viewerMode === "linear") {
      setNotice("Switch to Map or Split view before exporting the map.");
      return;
    }
    const metadata = mapExportMetadata(format);
    if (!metadata || !mapRef.current || exportingFormat) return;
    setExportingFormat(format);
    setExportReceipt(undefined);
    setExportFailure(undefined);
    setNotice(`Rendering and independently reopening the map ${format.toUpperCase()}…`);
    try {
      const filename = `${safeFilename(design.designId)}-${safeFilename(construct.name)}-map.${format}`;
      const payload = format === "svg"
        ? await mapRef.current.exportSvg(filename, metadata)
        : await mapRef.current.exportPng(filename, metadata);
      if (!payload) throw new Error(`CGView did not return a ${format.toUpperCase()} payload.`);
      const receipt = await workbenchApi().visualization.exportMap(payload);
      setExportReceipt(receipt);
      setNotice(receipt.status === "passed"
        ? `Map ${format.toUpperCase()} exported and independently reopened at ${receipt.width}×${receipt.height}.`
        : `Preview ${format.toUpperCase()} downloaded; independent desktop reopen is unavailable in preview mode.`);
    } catch (error) {
      const message = String(error).replace(/^Error:\s*/i, "");
      setExportFailure({ format, message });
      setNotice(`Map ${format.toUpperCase()} export failed closed: ${message}`);
    } finally {
      setExportingFormat(undefined);
    }
  };

  const exportMapSvg = () => void exportMap("svg");
  const exportMapPng = () => void exportMap("png");

  const refresh = async () => {
    setLoading(true);
    try {
      await refreshWorkspaceEntries();
    } finally {
      setLoading(false);
    }
  };

  const openWorkspacePath = async (path?: string) => {
    if (!path) return;
    try {
      await workbenchApi().files.open(path);
    } catch (error) {
      setNotice(`Could not open the artifact: ${String(error).replace(/^Error:\s*/i, "")}`);
    }
  };

  const revealWorkspacePath = async (path?: string) => {
    if (!path) return;
    try {
      await workbenchApi().files.reveal(path);
    } catch (error) {
      setNotice(`Could not reveal the artifact: ${String(error).replace(/^Error:\s*/i, "")}`);
    }
  };

  const chooseDocument = (path: string) => {
    setSelectedPath(path);
  };

  if (loading && documents.length === 0) {
    return (
      <div className="designs-page designs-loading" role="status" aria-live="polite">
        <RefreshCw className="spin" size={22} />
        <div><strong>Indexing compiled designs</strong><span>Reading build/*.ir.json through the workspace-safe file bridge.</span></div>
      </div>
    );
  }

  if (documents.length === 0) {
    return (
      <div className="designs-page">
        <DesignsHeader dataMode={dataMode} subtitle="No Proto IR artifact is available in build/." loading={loading} onRefresh={() => void refresh()} onExportSvg={exportMapSvg} onExportPng={exportMapPng} exportDisabled exportDisabledReason="Compile a valid Proto IR artifact before exporting." />
        <section className="design-empty" role={loadError ? "alert" : "status"}>
          <span><FileJson2 size={26} /></span>
          <div>
            <h2>{loadError ? "Design visualization is blocked" : "Compile a design to open its product view"}</h2>
            <p>{loadError ?? "The explorer reads validated proto-agent.ir.v1 artifacts from build/. Source .proto files remain unchanged and all views are read-only."}</p>
          </div>
          <button className="primary-button" type="button" onClick={() => void refresh()}><RefreshCw size={14} />Scan build artifacts</button>
        </section>
      </div>
    );
  }

  if (design?.domain === "protein") {
    return (
      <ProteinDesignPage
        dataMode={dataMode}
        design={design}
        documents={documents}
        selectedDocument={selectedDocument}
        loading={loading}
        onRefresh={() => void refresh()}
        onExportSvg={exportMapSvg}
        onExportPng={exportMapPng}
        onSelectDocument={chooseDocument}
        onOpen={openWorkspacePath}
        onReveal={revealWorkspacePath}
        notice={notice}
      />
    );
  }

  if (!design || !construct) {
    return (
      <div className="designs-page has-invalid-artifact" data-testid="designs-page">
        <DesignsHeader
          dataMode={dataMode}
          subtitle={`${selectedDocument?.relativePath ?? "Unreadable build artifact"} · diagnostics available`}
          loading={loading}
          onRefresh={() => void refresh()}
          onExportSvg={exportMapSvg}
          onExportPng={exportMapPng}
          exportDisabled
          exportDisabledReason="This artifact did not pass the visualization contract."
        />
        <div className="design-invalid-grid">
          <aside className="design-browser" aria-label="Design artifact inventory">
            <div className="design-panel-heading"><span><FileJson2 size={14} />Unique artifacts</span><strong title={`${documents.reduce((sum, item) => sum + (item.copyCount ?? 1), 0)} indexed artifacts`}>{documents.length}</strong></div>
            <ArtifactList documents={documents} selectedPath={selectedDocument?.path} onSelect={chooseDocument} />
          </aside>
          <section className="design-artifact-error" role="alert">
            <span className="design-artifact-error-icon"><CircleAlert size={24} /></span>
            <div>
              <span className="eyebrow">Artifact unavailable</span>
              <h2>{selectedDocument?.name ?? "Invalid Proto IR"}</h2>
              <p>{selectedDocument?.error ?? loadError ?? "The artifact could not be rendered safely."}</p>
              <dl>
                <div><dt>Path</dt><dd>{selectedDocument?.relativePath}</dd></div>
                <div><dt>SHA-256</dt><dd><code>{shortHash(selectedDocument?.sha256)}</code></dd></div>
                <div><dt>Modified</dt><dd>{formatTimestamp(selectedDocument?.modifiedAt)}</dd></div>
              </dl>
              {selectedDocument?.diagnostics.length ? (
                <div className="artifact-diagnostics">
                  {selectedDocument.diagnostics.slice(0, 6).map((diagnostic, index) => (
                    <p key={`${diagnostic.code}-${index}`}><strong>{diagnostic.code}</strong><span>{diagnostic.path}</span>{diagnostic.message}</p>
                  ))}
                </div>
              ) : null}
              <div className="artifact-error-actions">
                <button className="secondary-button" type="button" onClick={() => void openWorkspacePath(selectedDocument?.path)}><ExternalLink size={14} />Open JSON</button>
                <button className="secondary-button" type="button" onClick={() => void revealWorkspacePath(selectedDocument?.path)}><FolderOpen size={14} />Show in folder</button>
              </div>
            </div>
          </section>
        </div>
        {notice && <div className="design-notice" role="status">{notice}</div>}
      </div>
    );
  }

  const nucleotideSearch = /^[ACGTUN]+$/i.test(searchQuery.trim()) && searchQuery.trim().length > 1
    ? searchQuery.trim().toUpperCase()
    : undefined;
  const hiddenFeatureIndexes = new Set(hiddenFeatureIndexesByConstruct[constructIndex] ?? []);
  const hiddenFeatureCount = hiddenFeatureIndexes.size;
  const renderableFeatures = construct.features.filter((_, featureIndex) => !hiddenFeatureIndexes.has(featureIndex));
  const annotations = layers.annotations
    ? renderableFeatures.filter((feature) => feature.type.toLocaleLowerCase() !== "primer").flatMap((feature) => feature.segments.map((segment, segmentIndex) => ({
      start: segment.start,
      end: segment.end,
      name: feature.segments.length > 1
        ? `${feature.id} · ${feature.type} · segment ${segmentIndex + 1}/${feature.segments.length}`
        : `${feature.id} · ${feature.type}`,
      direction: feature.direction,
      color: feature.color,
    })))
    : [];
  const primerFeatures = renderableFeatures.filter((feature) => feature.type.toLocaleLowerCase() === "primer");
  const renderablePrimerFeatures = primerFeatures.filter((feature) => feature.direction !== 0);
  const unknownDirectionPrimerCount = primerFeatures.length - renderablePrimerFeatures.length;
  const primers = layers.primers
    ? renderablePrimerFeatures.flatMap((feature) => feature.segments.map((segment, segmentIndex) => ({
      id: `${feature.id}:${segmentIndex}`,
      start: segment.start,
      end: segment.end,
      name: feature.segments.length > 1
        ? `${feature.id} · segment ${segmentIndex + 1}/${feature.segments.length}`
        : feature.id,
      direction: feature.direction as -1 | 1,
      color: feature.color,
    })))
    : [];
  const codingFeatures = renderableFeatures.filter((feature) => feature.type.toLocaleLowerCase() === "cds");
  const translatableCodingFeatures = codingFeatures.filter((feature) => feature.direction !== 0 && feature.segments.length === 1);
  const unknownDirectionCodingFeatureCount = codingFeatures.filter((feature) => feature.direction === 0).length;
  const segmentedCodingFeatureCount = codingFeatures.filter((feature) => feature.direction !== 0 && feature.segments.length > 1).length;
  const orfFeatures = renderableFeatures.filter((feature) => feature.type.toLocaleLowerCase() === "orf");
  const softwareOrfFeatures = orfFeatures.filter((feature) => feature.source === "software");
  const translatableOrfFeatures = orfFeatures.filter((feature) => feature.direction !== 0 && feature.segments.length === 1);
  const unknownDirectionOrfFeatureCount = orfFeatures.filter((feature) => feature.direction === 0).length;
  const segmentedOrfFeatureCount = orfFeatures.filter((feature) => feature.direction !== 0 && feature.segments.length > 1).length;
  const translatableFeatures = [...translatableCodingFeatures, ...translatableOrfFeatures];
  const uniqueTranslatableFeatures = translatableFeatures.filter((feature, index, list) => {
    const segment = feature.segments[0];
    return list.findIndex((candidate) => {
      const candidateSegment = candidate.segments[0];
      return candidate.direction === feature.direction
        && candidateSegment.start === segment.start
        && candidateSegment.end === segment.end;
    }) === index;
  });
  const translations = layers.translations
    ? uniqueTranslatableFeatures.map((feature) => ({
      start: feature.segments[0].start,
      end: feature.segments[0].end,
      name: feature.id,
      direction: feature.direction,
      color: feature.color,
    }))
    : [];
  const selectedFeatureHighlights = selectedFeature
    ? selectedFeature.segments.map((segment) => ({ start: segment.start, end: segment.end, color: "rgba(5, 121, 108, 0.2)" }))
    : [];
  const enzymes = layers.restrictionSites ? restrictionEnzymes(design.constraints) : [];
  const visibleDiagnostics = selectedDocument?.diagnostics.filter((item) => item.severity !== "info") ?? [];
  const hiddenDiagnosticCount = Math.max(0, visibleDiagnostics.length - 8);
  const effectiveLabelDensity: Exclude<DesignLabelDensity, "auto"> = labelDensity === "auto"
    ? viewerMode === "circular" ? "balanced" : "hidden"
    : labelDensity;
  const denseMapLabels = renderableFeatures.length > (effectiveLabelDensity === "dense" ? 160 : 48) && effectiveLabelDensity !== "hidden";
  const orfDiscoveryUnavailable = !sourceConstruct
    || sourceConstruct.length > VISUALIZATION_INTERACTIVE_LIMITS.maxBases
    || sourceConstruct.features.length >= VISUALIZATION_INTERACTIVE_LIMITS.maxFeatures;
  const featureTypes = featureInventoryTypes(construct.features);
  const featureInventory = buildFeatureInventory(construct.features, {
    query: featureFilterQuery,
    type: featureTypeFilter,
    source: featureSourceFilter,
    sortKey: featureSortKey,
    sortDirection: featureSortDirection,
    hiddenFeatureIndexes,
  });
  const featurePageCount = Math.max(1, Math.ceil(featureInventory.length / VISUALIZATION_INTERACTIVE_LIMITS.maxAccessibleRows));
  const boundedFeaturePage = Math.min(featurePage, featurePageCount - 1);
  const featurePageStart = boundedFeaturePage * VISUALIZATION_INTERACTIVE_LIMITS.maxAccessibleRows;
  const visibleFeatureEntries = featureInventory.slice(featurePageStart, featurePageStart + VISUALIZATION_INTERACTIVE_LIMITS.maxAccessibleRows);
  const selectedFeatureInInventory = selectedFeatureIndex === undefined
    ? true
    : featureInventory.some((entry) => entry.featureIndex === selectedFeatureIndex);
  const mapDisplayLabel = construct.topology === "linear" ? "linear map" : construct.topology === "circular" ? "circular map" : "circular overview projection";
  const topologyDisclosure = construct.topology === "unknown" ? "unknown · circular view is a projection" : `${construct.topology} · rendered as declared`;
  const viewOriginAvailable = sourceConstruct?.topology === "circular";
  const viewOriginSelectionAvailable = viewOriginAvailable && Boolean(selectedFeature?.segments[0] ?? rangeSelection);
  const hoverSourceBase = mapHoverBase
    ? viewBaseToSourceBase(mapHoverBase - 1, activeViewOrigin, construct.length)
    : undefined;
  const selectedSourceSegments = rangeSelection && activeViewOrigin !== 0
    ? viewIntervalToSourceSegments(rangeSelection.start, rangeSelection.end, activeViewOrigin, construct.length)
    : [];

  const setFeatureHidden = (featureIndex: number, hidden: boolean) => {
    if (!Number.isSafeInteger(featureIndex) || featureIndex < 0 || featureIndex >= construct.features.length) return;
    if (hidden && selectedFeatureIndex === featureIndex) {
      setSelectedFeatureIndex(undefined);
      setRangeSelection(undefined);
    }
    setHiddenFeatureIndexesByConstruct((current) => {
      const nextIndexes = new Set(current[constructIndex] ?? []);
      if (hidden) nextIndexes.add(featureIndex);
      else nextIndexes.delete(featureIndex);
      const next = { ...current };
      if (nextIndexes.size > 0) next[constructIndex] = [...nextIndexes].sort((left, right) => left - right);
      else delete next[constructIndex];
      return next;
    });
  };

  const setFilteredFeaturesHidden = (hidden: boolean) => {
    const featureIndexes = featureInventory.map((entry) => entry.featureIndex);
    if (hidden && selectedFeatureIndex !== undefined && featureIndexes.includes(selectedFeatureIndex)) {
      setSelectedFeatureIndex(undefined);
      setRangeSelection(undefined);
    }
    setHiddenFeatureIndexesByConstruct((current) => {
      const nextIndexes = new Set(current[constructIndex] ?? []);
      for (const featureIndex of featureIndexes) {
        if (hidden) nextIndexes.add(featureIndex);
        else nextIndexes.delete(featureIndex);
      }
      const next = { ...current };
      if (nextIndexes.size > 0) next[constructIndex] = [...nextIndexes].sort((left, right) => left - right);
      else delete next[constructIndex];
      return next;
    });
  };

  const updateFeatureSort = (sortKey: FeatureInventorySortKey) => {
    setFeaturePage(0);
    if (featureSortKey === sortKey) {
      setFeatureSortDirection((direction) => direction === "asc" ? "desc" : "asc");
      return;
    }
    setFeatureSortKey(sortKey);
    setFeatureSortDirection("asc");
  };

  return (
    <div className="designs-page" data-testid="designs-page">
      <DesignsHeader
        dataMode={dataMode}
        subtitle={`${design.source || selectedDocument?.path || "Compiled IR"} · ${design.schemaVersion}`}
        loading={loading}
        onRefresh={() => void refresh()}
        onExportSvg={exportMapSvg}
        onExportPng={exportMapPng}
        exportingFormat={exportingFormat}
        exportDisabled={Boolean(exportingFormat) || viewerMode === "linear" || artifactIntegrityBlocked || provenanceInventoryBlocked || interactiveVisualizationBlocked}
        exportDisabledReason={artifactIntegrityBlocked
          ? "Export is blocked because the artifact digest does not match its provenance record."
          : provenanceInventoryBlocked
            ? provenanceInventory.status === "loading"
              ? "Export is blocked while the provenance inventory is being verified."
              : "Export is blocked because the provenance inventory contains unreadable or invalid statements."
          : interactiveVisualizationBlocked
            ? "Export is unavailable while the construct is in bounded summary mode."
            : "Open Map or Split view to export the map."}
      />

      <div className="design-product-bar">
        <div className="design-product-title">
          <span className={`design-status-icon ${selectedDocument?.digestBinding?.status === "mismatch" ? "has-mismatch" : ""}`}>
            {selectedDocument?.digestBinding?.status === "mismatch" ? <CircleAlert size={16} /> : <FileJson2 size={16} />}
          </span>
          <div><span className="eyebrow">Renderable IR</span><h2>{design.designId}</h2></div>
        </div>
        <dl>
          <div><dt>Construct</dt><dd>{construct.name}</dd></div>
          <div><dt>Length</dt><dd>{construct.length.toLocaleString()} bp</dd></div>
          <div><dt>GC</dt><dd>{formatPercent(construct.gcFraction)}</dd></div>
          <div><dt>Chassis</dt><dd>{design.chassis}</dd></div>
        </dl>
        <div className="design-product-badges">
          {dataMode === "preview" && <span className="design-mode-badge">Development fixture</span>}
          {selectedDocument?.digestBinding?.status === "match" && <span className="design-digest-badge is-match">Digest matched</span>}
          {selectedDocument?.digestBinding?.status === "mismatch" && <span className="design-digest-badge is-mismatch">Digest mismatch</span>}
          <span className="design-review-badge"><CircleAlert size={13} />Software-level view · review required</span>
        </div>
      </div>

      <div className="design-explorer-grid">
        <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{selectionAnnouncement}</span>
        <aside className="design-browser" aria-label="Design browser">
          <div className="design-panel-heading"><span><FileJson2 size={14} />Unique artifacts</span><strong title={`${documents.reduce((sum, item) => sum + (item.copyCount ?? 1), 0)} indexed artifacts`}>{documents.length}</strong></div>
          <ArtifactList documents={documents} selectedPath={selectedDocument?.path} onSelect={chooseDocument} />
          <div className="design-panel-heading is-sub"><span>Constructs</span><strong>{design.constructs.length}</strong></div>
          <div className="construct-list">
            {design.constructs.map((item, index) => (
              <button className={`construct-item ${index === constructIndex ? "is-selected" : ""}`} type="button" key={`${item.name}-${index}`} onClick={() => selectConstruct(index)} aria-current={index === constructIndex ? "true" : undefined}>
                <span className="construct-glyph"><Dna size={13} /></span>
                <span><strong>{item.name}</strong><small>{item.length} bp · {item.parts.length} parts</small></span>
              </button>
            ))}
          </div>
          <div className="design-source-card">
            <span className="eyebrow">Provenance</span>
            <strong>{design.source || "Source not declared"}</strong>
            <small>IR SHA-256</small>
            <code title={selectedDocument?.sha256}>{shortHash(selectedDocument?.sha256)}</code>
            <div className="design-source-actions">
              <button type="button" onClick={() => void openWorkspacePath(selectedDocument?.path)}><ExternalLink size={12} />Open</button>
              <button type="button" onClick={() => void revealWorkspacePath(selectedDocument?.path)}><FolderOpen size={12} />Reveal</button>
            </div>
          </div>
        </aside>

        <main className="design-stage">
          <div className="design-toolbar">
            <div className="view-segment" aria-label="Viewer layout">
              {(["both", "circular", "linear"] as ViewerMode[]).map((mode) => (
                <button className={viewerMode === mode ? "is-active" : ""} type="button" key={mode} onClick={() => setViewerMode(mode)} aria-pressed={viewerMode === mode} disabled={interactiveVisualizationBlocked} title={interactiveVisualizationBlocked ? "Interactive renderers are paused in bounded summary mode." : undefined}>
                  {mode === "both" ? "Split" : mode === "circular" ? "Map" : "Sequence"}
                </button>
              ))}
            </div>
            <label className="design-search">
              <Search size={14} />
              <input value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="Find feature, type, or bases" aria-label="Find feature, type, or bases" />
              <span role="status" aria-live="polite">{searchStatus}</span>
            </label>
            <button className="icon-button" type="button" onClick={() => moveSearch(-1)} disabled={searchHits.length === 0} title="Previous match" aria-label="Previous match"><ChevronLeft size={14} /></button>
            <button className="icon-button" type="button" onClick={() => moveSearch(1)} disabled={searchHits.length === 0} title="Next match" aria-label="Next match"><ChevronRight size={14} /></button>
            <button className="secondary-button compact-command" type="button" onClick={resetView}><RotateCcw size={13} />Reset view</button>
          </div>

          <div className="design-canvas-meta">
            <span><LocateFixed size={13} />{viewerMode === "circular" ? `CGView ${mapDisplayLabel}` : viewerMode === "linear" ? "SeqViz base-level linear sequence" : "CGView + SeqViz synchronized product view"}</span>
            <span>{mapHoverBase ? <>View position <strong>{mapHoverBase} bp</strong>{activeViewOrigin !== 0 && hoverSourceBase !== undefined ? <> · source <strong>{hoverSourceBase + 1} bp</strong></> : null} · </> : null}Source topology: <strong>{topologyDisclosure}</strong>{activeViewOrigin !== 0 ? <> · view +1 = source <strong>{activeViewOrigin + 1}</strong></> : null} · labels <strong>{labelDensity === "auto" ? `auto (${effectiveLabelDensity})` : effectiveLabelDensity}</strong>{hiddenFeatureCount > 0 ? <> · <strong>{hiddenFeatureCount}</strong> hidden</> : null}</span>
          </div>

          <div className={`design-viewer is-${viewerMode}`} data-testid="design-sequence-viewer">
            {interactiveVisualizationBlocked && (
              <section className="visualization-summary-mode" role="status" aria-label="Bounded visualization summary mode">
                <CircleAlert size={22} />
                <div><span className="eyebrow">Bounded summary mode</span><h3>Interactive renderers are paused for this construct</h3></div>
                {visualizationEnvelope.reasons.map((reason) => <p key={reason}>{reason}</p>)}
                <dl><div><dt>Bases</dt><dd>{construct.length.toLocaleString()}</dd></div><div><dt>Features</dt><dd>{construct.features.length.toLocaleString()}</dd></div></dl>
                <small>Search, provenance, diagnostics, and the paginated feature inventory remain available. Narrow the input or use a future genome-scale renderer before enabling map export.</small>
              </section>
            )}
            {!interactiveVisualizationBlocked && viewerMode !== "linear" && (
              <section className="visual-engine-pane map-engine-pane" aria-label={`Interactive ${mapDisplayLabel}`}>
                <span className="visual-engine-label">CGView.js · overview</span>
                <CgviewMap
                  ref={mapRef}
                  construct={construct}
                  selectedFeatureIndex={selectedFeatureIndex}
                  selectedRange={rangeSelection}
                  hiddenFeatureIndexes={hiddenFeatureIndexes}
                  showAnnotations={layers.annotations}
                  labelDensity={effectiveLabelDensity}
                  showPrimers={layers.primers}
                  showGcContent={layers.gcContent}
                  showGcSkew={layers.gcSkew}
                  gcWindowSize={gcWindowSize || undefined}
                  showIndex={layers.index}
                  onSelectFeature={selectFeature}
                  onHoverBase={setMapHoverBase}
                />
              </section>
            )}
            {!interactiveVisualizationBlocked && viewerMode !== "circular" && (
              <section className="visual-engine-pane sequence-engine-pane" aria-label="Interactive base-level sequence">
                <div className="sequence-navigator-shell">
                  <span className="visual-engine-label">CGView.js · navigator</span>
                  <SequenceNavigator
                    construct={construct}
                    selectedFeatureIndex={selectedFeatureIndex}
                    selectedRange={rangeSelection}
                    hiddenFeatureIndexes={hiddenFeatureIndexes}
                    showAnnotations={layers.annotations}
                    showPrimers={layers.primers}
                    onSelectFeature={selectFeature}
                    onNavigate={navigateToBase}
                  />
                </div>
                <div className="sequence-engine-main">
                  <span className="visual-engine-label">SeqViz · sequence</span>
                  <VisualizationErrorBoundary
                    resetKey={`${construct.name}-${viewerRevision}`}
                    fallback={<div className="sequence-render-error" role="alert"><strong>Sequence view unavailable</strong><code>SEQVIZ_RENDER_FAILED</code><span>Reset the view or choose another construct. The map and feature table remain available.</span></div>}
                  >
                    <SeqViz
                      key={`${construct.name}-${viewerRevision}`}
                      name={construct.name}
                      seq={construct.sequence}
                      seqType="dna"
                      annotations={annotations}
                      highlights={selectedFeatureHighlights}
                      translations={translations}
                      primers={primers}
                      enzymes={enzymes}
                      search={nucleotideSearch ? { query: nucleotideSearch, mismatch: 0 } : undefined}
                      selection={rangeSelection ? { start: rangeSelection.start, end: rangeSelection.end } : undefined}
                      onSelection={handleSelection}
                      onSearch={() => undefined}
                      viewer="linear"
                      showComplement={layers.complement}
                      showIndex={layers.index}
                      rotateOnScroll={false}
                      disableExternalFonts
                      zoom={{ linear: linearZoom }}
                      style={{ height: "100%", width: "100%" }}
                    />
                  </VisualizationErrorBoundary>
                </div>
              </section>
            )}
          </div>

          <section className="parts-table-section" aria-label="Construct features">
            <div className="parts-table-heading"><div><h3>Feature architecture</h3><span>Display coordinates are 1-based inclusive; internal segments remain 0-based end-exclusive.{activeViewOrigin !== 0 ? ` View +1 maps to source base ${activeViewOrigin + 1}; source intervals remain available in the inspector.` : ""}</span></div><strong>{featureInventory.length} of {construct.features.length}{hiddenFeatureCount ? ` · ${hiddenFeatureCount} hidden` : ""}</strong></div>
            <div className="feature-inventory-controls" role="group" aria-label="Filter and control feature inventory">
              <label className="feature-filter-search"><Search size={13} /><span className="sr-only">Filter feature names and types</span><input value={featureFilterQuery} onChange={(event) => { setFeatureFilterQuery(normalizeFeatureFilterQuery(event.target.value)); setFeaturePage(0); }} placeholder="Filter name or type" /></label>
              <label><span className="sr-only">Feature type</span><select value={featureTypeFilter} onChange={(event) => { setFeatureTypeFilter(event.target.value); setFeaturePage(0); }} aria-label="Filter feature type"><option value="all">All types</option>{featureTypes.map((type) => <option value={type} key={type}>{type}</option>)}</select></label>
              <label><span className="sr-only">Feature source</span><select value={featureSourceFilter} onChange={(event) => { setFeatureSourceFilter(event.target.value as FeatureInventorySource); setFeaturePage(0); }} aria-label="Filter feature source"><option value="all">All sources</option><option value="part">Parts</option><option value="annotation">Annotations</option><option value="software">Software</option></select></label>
              <button type="button" className="feature-visibility-command" disabled={featureInventory.length === 0 || featureInventory.every((entry) => entry.hidden)} onClick={() => setFilteredFeaturesHidden(true)}><EyeOff size={13} />Hide filtered</button>
              <button type="button" className="feature-visibility-command" disabled={featureInventory.length === 0 || featureInventory.every((entry) => !entry.hidden)} onClick={() => setFilteredFeaturesHidden(false)}><Eye size={13} />Show filtered</button>
            </div>
            {!selectedFeatureInInventory && <p className="feature-inventory-note" role="status">The selected feature is outside the current inventory filter. Its inspector and linked selection remain active.</p>}
            <div className="parts-table" role="table" aria-label={`${construct.name} features`}>
              <div className="parts-table-row is-header" role="row">
                <span role="columnheader"><button type="button" onClick={() => updateFeatureSort("name")} aria-pressed={featureSortKey === "name"}>Feature{featureSortKey === "name" ? featureSortDirection === "asc" ? <ArrowUp size={12} /> : <ArrowDown size={12} /> : null}</button></span>
                <span role="columnheader"><button type="button" onClick={() => updateFeatureSort("type")} aria-pressed={featureSortKey === "type"}>Type{featureSortKey === "type" ? featureSortDirection === "asc" ? <ArrowUp size={12} /> : <ArrowDown size={12} /> : null}</button></span>
                <span role="columnheader"><button type="button" onClick={() => updateFeatureSort("coordinate")} aria-pressed={featureSortKey === "coordinate"}>Interval{featureSortKey === "coordinate" ? featureSortDirection === "asc" ? <ArrowUp size={12} /> : <ArrowDown size={12} /> : null}</button></span>
                <span role="columnheader"><button type="button" onClick={() => updateFeatureSort("length")} aria-pressed={featureSortKey === "length"}>Length{featureSortKey === "length" ? featureSortDirection === "asc" ? <ArrowUp size={12} /> : <ArrowDown size={12} /> : null}</button></span>
                <span role="columnheader">Visible</span>
              </div>
              {visibleFeatureEntries.map(({ feature, featureIndex, hidden }) => {
                return (
                <div className={`parts-table-row ${selectedFeatureIndex === featureIndex ? "is-selected" : ""} ${hidden ? "is-hidden" : ""}`} role="row" key={`${feature.source}-${feature.id}-${featureIndex}`}>
                  <span role="cell"><button className="part-row-select" type="button" onClick={() => selectFeature(featureIndex)} aria-pressed={selectedFeatureIndex === featureIndex} aria-label={`Select ${feature.id}, ${feature.type}, ${formatFeatureIntervals(feature)}`}><i style={{ background: feature.color }} /><strong>{feature.id}</strong><small>{feature.name || featureSourceLabel(feature)}</small></button></span>
                  <span role="cell" className="part-type-pill">{feature.type}</span>
                  <span role="cell"><code>{formatFeatureIntervals(feature)}</code></span>
                  <span role="cell">{feature.length} bp</span>
                  <span role="cell"><button className="feature-row-visibility" type="button" aria-pressed={!hidden} aria-label={`${hidden ? "Show" : "Hide"} ${feature.id} in visualizations`} title={`${hidden ? "Show" : "Hide"} in map and sequence views`} onClick={() => setFeatureHidden(featureIndex, !hidden)}>{hidden ? <EyeOff size={14} /> : <Eye size={14} />}</button></span>
                </div>
                );
              })}
              {visibleFeatureEntries.length === 0 && <div className="parts-table-empty" role="row"><span role="cell">No features match the current filters.</span></div>}
              {featurePageCount > 1 && (
                <div className="parts-table-pagination" role="group" aria-label="Feature inventory pages">
                  <button type="button" disabled={boundedFeaturePage === 0} onClick={() => setFeaturePage((page) => Math.max(0, page - 1))}>Previous</button>
                  <span role="status">Page {boundedFeaturePage + 1} of {featurePageCount}</span>
                  <button type="button" disabled={boundedFeaturePage >= featurePageCount - 1} onClick={() => setFeaturePage((page) => Math.min(featurePageCount - 1, page + 1))}>Next</button>
                </div>
              )}
            </div>
          </section>
        </main>

        <aside className="design-inspector" aria-label="Design inspector">
          <div className="inspector-heading"><span><LocateFixed size={14} />Inspector</span>{rangeSelection && <em>{rangeSelection.viewer ? rangeSelection.viewer.toLocaleLowerCase() : "linked"}</em>}</div>
          <section className="selection-card">
            {selectedFeature ? <SelectedFeatureInspector feature={selectedFeature} construct={construct} /> : rangeSelection ? (
              <>
                <span className="eyebrow">Sequence selection</span>
                <h3>{rangeSelection.end - rangeSelection.start} bp selected</h3>
                <dl><div><dt>{activeViewOrigin !== 0 ? "View from" : "From"}</dt><dd>{rangeSelection.start + 1}</dd></div><div><dt>{activeViewOrigin !== 0 ? "View to" : "To"}</dt><dd>{rangeSelection.end}</dd></div>{activeViewOrigin !== 0 && <div><dt>Source interval</dt><dd>{formatCoordinateSegments(selectedSourceSegments)}</dd></div>}</dl>
                <p>Select a named annotation to inspect its identity and artifact context.</p>
              </>
            ) : (
              <div className="inspector-empty"><LocateFixed size={20} /><strong>Nothing selected</strong><span>Click a map feature, sequence interval, or row below the viewer.</span></div>
            )}
          </section>

          <RunProvenancePanel provenance={selectedDocument?.provenance} digestBinding={selectedDocument?.digestBinding} onOpen={(path) => void openWorkspacePath(path)} />

          <section className="layer-panel">
            <div className="inspector-section-title"><span><Layers3 size={14} />Layers</span></div>
            <div className={`view-origin-control ${!viewOriginAvailable || interactiveVisualizationBlocked ? "is-disabled" : ""}`}>
              <div className="view-origin-copy"><strong>Circular view origin</strong><small>{viewOriginAvailable ? `View +1 maps to source base ${activeViewOrigin + 1} · display only` : "Available only for declared circular constructs"}</small></div>
              <label><span>Source base at +1</span><input type="number" min={1} max={construct.length} step={1} value={activeViewOrigin + 1} disabled={!viewOriginAvailable || interactiveVisualizationBlocked} onChange={(event) => { const value = Number(event.target.value); if (Number.isSafeInteger(value) && value >= 1 && value <= construct.length) applyViewOrigin(value - 1); }} aria-label="Source base displayed as view position plus one" /></label>
              <div className="view-origin-actions"><button type="button" disabled={!viewOriginSelectionAvailable || interactiveVisualizationBlocked} onClick={setViewOriginFromSelection}>Use selection</button><button type="button" disabled={activeViewOrigin === 0 || interactiveVisualizationBlocked} onClick={() => applyViewOrigin(0)}>Restore source</button></div>
              <p>Rotates map, navigator, sequence, search coordinates, and export rendering without changing the IR or provenance digest.</p>
            </div>
            <LayerToggle label="Feature annotations" detail={`${construct.features.length} logical features · ${construct.features.reduce((sum, feature) => sum + feature.segments.length, 0)} rendered segments`} checked={layers.annotations} disabled={interactiveVisualizationBlocked} onChange={(checked) => setLayers((state) => ({ ...state, annotations: checked }))} />
            <label className={`feature-label-density-control ${!layers.annotations || interactiveVisualizationBlocked ? "is-disabled" : ""}`}>
              <span><strong>Feature label density</strong><small>{labelDensity === "auto" ? `Auto resolves to ${effectiveLabelDensity} in this layout` : `${effectiveLabelDensity} map labels`}</small></span>
              <select value={labelDensity} disabled={!layers.annotations || interactiveVisualizationBlocked} onChange={(event) => setLabelDensity(event.target.value as DesignLabelDensity)} aria-label="Feature label density">
                <option value="auto">Auto by layout</option><option value="hidden">Hidden</option><option value="balanced">Balanced</option><option value="dense">Dense</option>
              </select>
            </label>
            <LayerToggle label="Complement strand" detail="Paired base sequence" checked={layers.complement} disabled={interactiveVisualizationBlocked} onChange={(checked) => setLayers((state) => ({ ...state, complement: checked }))} />
            <LayerToggle label="Coordinate index" detail="Base position ticks" checked={layers.index} disabled={interactiveVisualizationBlocked} onChange={(checked) => setLayers((state) => ({ ...state, index: checked }))} />
            <LayerToggle label="GC content plot" detail="Bounded sliding-window sequence metric" checked={layers.gcContent} disabled={interactiveVisualizationBlocked} onChange={(checked) => setLayers((state) => ({ ...state, gcContent: checked }))} />
            <LayerToggle label="GC skew plot" detail="(G-C)/(G+C) · G-rich versus C-rich windows" checked={layers.gcSkew} disabled={interactiveVisualizationBlocked} onChange={(checked) => setLayers((state) => ({ ...state, gcSkew: checked }))} />
            <label className={`metric-window-control ${(!layers.gcContent && !layers.gcSkew) || interactiveVisualizationBlocked ? "is-disabled" : ""}`}>
              <span><strong>Sequence metric window</strong><small>Odd bases · clamped to construct length</small></span>
              <select value={gcWindowSize} disabled={(!layers.gcContent && !layers.gcSkew) || interactiveVisualizationBlocked} onChange={(event) => setGcWindowSize(Number(event.target.value))} aria-label="GC content and GC skew sliding-window size">
                <option value={0}>Auto</option><option value={11}>11 bp</option><option value={21}>21 bp</option><option value={51}>51 bp</option><option value={101}>101 bp</option>
              </select>
            </label>
            <LayerToggle label="Primer bindings" detail={`${primers.length} rendered segment${primers.length === 1 ? "" : "s"}${unknownDirectionPrimerCount ? ` · ${unknownDirectionPrimerCount} withheld (direction unknown)` : ""}`} checked={layers.primers} disabled={interactiveVisualizationBlocked} onChange={(checked) => setLayers((state) => ({ ...state, primers: checked }))} />
            <LayerToggle label="Restriction-site scan" detail={enzymes.length ? `Constraint targets · ${enzymes.join(", ")}` : "No enzyme target declared"} checked={layers.restrictionSites} disabled={interactiveVisualizationBlocked} onChange={(checked) => setLayers((state) => ({ ...state, restrictionSites: checked }))} />
            <LayerToggle label="Software ORF discovery" detail={orfDiscoveryUnavailable ? "Unavailable outside the interactive support envelope" : `${softwareOrfFeatures.length} inferred · six frames · ATG to standard stop · software only`} checked={layers.discoveredOrfs} disabled={orfDiscoveryUnavailable} onChange={(checked) => setLayers((state) => ({ ...state, discoveredOrfs: checked }))} />
            <label className={`orf-threshold-control ${!layers.discoveredOrfs || orfDiscoveryUnavailable ? "is-disabled" : ""}`}>
              <span><strong>Minimum inferred ORF</strong><small>Excludes the stop codon</small></span>
              <select value={orfMinimumAminoAcids} disabled={!layers.discoveredOrfs || orfDiscoveryUnavailable} onChange={(event) => setOrfMinimumAminoAcids(Number(event.target.value))} aria-label="Minimum software-inferred ORF length">
                <option value={4}>4 aa</option><option value={10}>10 aa</option><option value={30}>30 aa</option><option value={100}>100 aa</option>
              </select>
            </label>
            <LayerToggle label="CDS / ORF translation" detail={`Sequence layer · ${uniqueTranslatableFeatures.length} unique interval${uniqueTranslatableFeatures.length === 1 ? "" : "s"} shown${translatableFeatures.length > uniqueTranslatableFeatures.length ? ` · ${translatableFeatures.length - uniqueTranslatableFeatures.length} overlapping source entr${translatableFeatures.length - uniqueTranslatableFeatures.length === 1 ? "y" : "ies"} merged` : ""}${unknownDirectionCodingFeatureCount + unknownDirectionOrfFeatureCount ? ` · ${unknownDirectionCodingFeatureCount + unknownDirectionOrfFeatureCount} withheld (direction unknown)` : ""}${segmentedCodingFeatureCount + segmentedOrfFeatureCount ? ` · ${segmentedCodingFeatureCount + segmentedOrfFeatureCount} withheld (segmented)` : ""}`} checked={layers.translations} disabled={interactiveVisualizationBlocked} onChange={(checked) => setLayers((state) => ({ ...state, translations: checked }))} />
            <label className={`zoom-control ${interactiveVisualizationBlocked ? "is-disabled" : ""}`}><span><strong>Sequence zoom</strong><small>{linearZoom}%</small></span><input type="range" min="20" max="100" step="2" value={linearZoom} disabled={interactiveVisualizationBlocked} onChange={(event) => setLinearZoom(Number(event.target.value))} /></label>
          </section>

          <section className="constraint-panel">
            <div className="inspector-section-title"><span>Design constraints</span><strong>{design.constraints.length}</strong></div>
            {design.constraints.length === 0 && <p>No constraints were declared in this IR.</p>}
            {design.constraints.map((constraint, index) => <ConstraintRow key={`${String(constraint.type)}-${index}`} constraint={constraint} />)}
          </section>

          {(visibleDiagnostics.length > 0 || provenanceInventory.diagnostics.length > 0 || design.constraints.length === 0 || denseMapLabels || orfDiscovery.truncated || unknownDirectionPrimerCount > 0 || unknownDirectionCodingFeatureCount > 0 || segmentedCodingFeatureCount > 0 || unknownDirectionOrfFeatureCount > 0 || segmentedOrfFeatureCount > 0) && (
            <section className="diagnostic-panel" aria-label="Visualization diagnostics">
              <div className="inspector-section-title"><span><CircleAlert size={14} />Needs attention</span></div>
              {visibleDiagnostics.slice(0, 8).map((diagnostic, index) => <p key={`${diagnostic.code}-${index}`}><strong>{diagnostic.code}</strong>{diagnostic.message}</p>)}
              {hiddenDiagnosticCount > 0 && <p><strong>MORE_DIAGNOSTICS</strong>{hiddenDiagnosticCount} additional diagnostics are retained in the artifact report.</p>}
              {provenanceInventory.diagnostics.slice(0, 8).map((diagnostic, index) => <p key={`provenance-${diagnostic.path}-${index}`}><strong>PROVENANCE_INVENTORY_INCOMPLETE</strong><code>{diagnostic.path}</code>{diagnostic.message}</p>)}
              {provenanceInventory.diagnostics.length > 8 && <p><strong>MORE_PROVENANCE_DIAGNOSTICS</strong>{provenanceInventory.diagnostics.length - 8} additional provenance inventory diagnostics are retained.</p>}
              {unknownDirectionCodingFeatureCount > 0 && <p><strong>CDS_DIRECTION_UNKNOWN</strong>{unknownDirectionCodingFeatureCount} CDS translation layer entr{unknownDirectionCodingFeatureCount === 1 ? "y was" : "ies were"} withheld because the IR does not declare a direction.</p>}
              {segmentedCodingFeatureCount > 0 && <p><strong>SEGMENTED_CDS_TRANSLATION_UNSUPPORTED</strong>{segmentedCodingFeatureCount} segmented CDS translation layer entr{segmentedCodingFeatureCount === 1 ? "y was" : "ies were"} withheld because SeqViz accepts a contiguous translation interval. The annotation remains visible and linked.</p>}
              {unknownDirectionPrimerCount > 0 && <p><strong>PRIMER_DIRECTION_UNKNOWN</strong>{unknownDirectionPrimerCount} primer binding entr{unknownDirectionPrimerCount === 1 ? "y was" : "ies were"} withheld from the primer layer because direction is required. The logical annotation remains available in the table and map.</p>}
              {unknownDirectionOrfFeatureCount > 0 && <p><strong>ORF_DIRECTION_UNKNOWN</strong>{unknownDirectionOrfFeatureCount} ORF translation entr{unknownDirectionOrfFeatureCount === 1 ? "y was" : "ies were"} withheld because direction is required.</p>}
              {segmentedOrfFeatureCount > 0 && <p><strong>SEGMENTED_ORF_TRANSLATION_UNSUPPORTED</strong>{segmentedOrfFeatureCount} segmented ORF translation entr{segmentedOrfFeatureCount === 1 ? "y was" : "ies were"} withheld because SeqViz accepts a contiguous translation interval. The annotation remains visible and linked.</p>}
              {orfDiscovery.truncated && <p><strong>ORF_DISCOVERY_TRUNCATED</strong>Software ORF discovery reached the remaining interactive feature budget. Narrow the source features or raise the minimum amino-acid threshold; undisplayed candidates were not silently promoted.</p>}
              {denseMapLabels && <p><strong>DENSE_MAP_LABELS</strong>Some canvas labels may be hidden to avoid collisions; all {construct.features.length} logical features remain available in the keyboard-accessible table.</p>}
              {design.constraints.length === 0 && <p><strong>NO_CONSTRAINTS</strong>This artifact declares no visualizable design constraints.</p>}
            </section>
          )}
        </aside>
      </div>

      {exportReceipt ? (
        <section className={`map-export-receipt ${exportReceipt.status === "passed" ? "is-verified" : "is-preview"}`} aria-label="Latest map export verification" aria-live="polite">
          <span className="map-export-receipt-icon">{exportReceipt.status === "passed" ? <BadgeCheck size={18} /> : <CircleAlert size={18} />}</span>
          <div className="map-export-receipt-copy">
            <span className="eyebrow">Latest map export</span>
            <strong>{exportReceipt.status === "passed" ? "Independently reopened" : "Preview download · not independently verified"}</strong>
            <small>{exportReceipt.filename} · {exportReceipt.width}×{exportReceipt.height} · {formatBytes(exportReceipt.bytes)}</small>
          </div>
          <dl>
            <div><dt>Format</dt><dd>{exportReceipt.format.toUpperCase()}</dd></div>
            <div><dt>Decoder</dt><dd>{exportReceipt.decoder === "chromium-isolated-image" ? "Isolated Chromium" : exportReceipt.decoder === "electron-native-image" ? "Electron native image" : "Browser preview"}</dd></div>
            <div><dt>SHA-256</dt><dd title={exportReceipt.sha256}>{exportReceipt.sha256.slice(0, 12)}…</dd></div>
          </dl>
          {exportReceipt.relativePath && <button className="secondary-button compact-command" type="button" onClick={() => void revealWorkspacePath(exportReceipt.relativePath)}><FolderOpen size={13} />Reveal</button>}
        </section>
      ) : exportFailure ? (
        <section className="map-export-receipt is-failed" aria-label="Latest map export failure" aria-live="assertive">
          <span className="map-export-receipt-icon"><CircleAlert size={18} /></span>
          <div className="map-export-receipt-copy">
            <span className="eyebrow">Latest map export</span>
            <strong>Failed closed · no unverified image was published</strong>
            <small>{exportFailure.format.toUpperCase()} · {exportFailure.message}</small>
          </div>
        </section>
      ) : (
        <section className="map-export-receipt is-idle" aria-label="Map export verification status">
          <span className="map-export-receipt-icon"><Download size={18} /></span>
          <div className="map-export-receipt-copy">
            <span className="eyebrow">Map export status</span>
            <strong>No map exported in this session</strong>
            <small>SVG and PNG receive a success receipt only after an independent reopen check.</small>
          </div>
          <dl>
            <div><dt>Formats</dt><dd>SVG / PNG</dd></div>
            <div><dt>Verification</dt><dd>Fail closed</dd></div>
          </dl>
        </section>
      )}
      {notice && <div className="design-notice" role="status">{notice}</div>}
    </div>
  );
}

function ProteinDesignPage({
  dataMode,
  design,
  documents,
  selectedDocument,
  loading,
  onRefresh,
  onExportSvg,
  onExportPng,
  onSelectDocument,
  onOpen,
  onReveal,
  notice,
}: {
  dataMode: ReturnType<typeof workbenchDataMode>;
  design: DesignViewModel;
  documents: LoadedDesign[];
  selectedDocument?: LoadedDesign;
  loading: boolean;
  onRefresh: () => void;
  onExportSvg: () => void;
  onExportPng: () => void;
  onSelectDocument: (path: string) => void;
  onOpen: (path?: string) => Promise<void>;
  onReveal: (path?: string) => Promise<void>;
  notice?: string;
}) {
  const totalResidues = design.proteins.reduce((sum, protein) => sum + protein.length, 0);
  const firstProtein = design.proteins[0];
  return (
    <div className="designs-page protein-design-page" data-testid="protein-design-page">
      <DesignsHeader
        dataMode={dataMode}
        subtitle={`${design.source || selectedDocument?.path || "Compiled protein IR"} · ${design.schemaVersion}`}
        loading={loading}
        onRefresh={onRefresh}
        onExportSvg={onExportSvg}
        onExportPng={onExportPng}
        exportDisabled
        exportDisabledReason="Map export is DNA-specific; use the protein residue view and FASTA export for protein artifacts."
      />

      <div className="design-product-bar protein-product-bar">
        <div className="design-product-title">
          <span className="design-status-icon"><Atom size={16} /></span>
          <div><span className="eyebrow">Renderable protein IR</span><h2>{design.designId}</h2></div>
        </div>
        <dl>
          <div><dt>Sequences</dt><dd>{design.proteins.length.toLocaleString()}</dd></div>
          <div><dt>Residues</dt><dd>{totalResidues.toLocaleString()} aa</dd></div>
          <div><dt>First record</dt><dd>{firstProtein?.name ?? "—"}</dd></div>
          <div><dt>Chassis</dt><dd>{design.chassis}</dd></div>
        </dl>
        <div className="design-product-badges"><span className="design-review-badge"><CircleAlert size={13} />Software-level view · review required</span></div>
      </div>

      <div className="design-explorer-grid protein-explorer-grid">
        <aside className="design-browser" aria-label="Protein design browser">
          <div className="design-panel-heading"><span><FileJson2 size={14} />Unique artifacts</span><strong>{documents.length}</strong></div>
          <ArtifactList documents={documents} selectedPath={selectedDocument?.path} onSelect={onSelectDocument} />
          <div className="design-panel-heading is-sub"><span>Protein records</span><strong>{design.proteins.length}</strong></div>
          <div className="construct-list protein-record-nav">
            {design.proteins.map((protein, index) => <div className="construct-item protein-record-nav-item" key={`${protein.id}-${index}`}><span className="construct-glyph"><Atom size={13} /></span><span><strong>{protein.name ?? protein.id}</strong><small>{protein.length.toLocaleString()} aa · {protein.source.provider || "source pending"}</small></span></div>)}
          </div>
          <div className="design-source-card">
            <span className="eyebrow">Provenance</span>
            <strong>{design.source || "Source not declared"}</strong>
            <small>IR SHA-256</small>
            <code title={selectedDocument?.sha256}>{shortHash(selectedDocument?.sha256)}</code>
            <div className="design-source-actions">
              <button type="button" onClick={() => void onOpen(selectedDocument?.path)}><ExternalLink size={12} />Open</button>
              <button type="button" onClick={() => void onReveal(selectedDocument?.path)}><FolderOpen size={12} />Reveal</button>
            </div>
          </div>
        </aside>

        <main className="design-stage protein-design-stage">
          <ProteinSequenceView design={design} />
        </main>

        <aside className="design-inspector protein-inspector" aria-label="Protein design inspector">
          <div className="inspector-heading"><span><LocateFixed size={14} />Inspector</span><em>protein</em></div>
          <RunProvenancePanel provenance={selectedDocument?.provenance} digestBinding={selectedDocument?.digestBinding} onOpen={(path) => void onOpen(path)} />
          <section className="constraint-panel">
            <div className="inspector-section-title"><span>Design constraints</span><strong>{design.constraints.length}</strong></div>
            <p>Protein constraints are retained as software metadata; residue-level visual checks are shown in the sequence workspace.</p>
          </section>
          <section className="diagnostic-panel" aria-label="Protein visualization boundary">
            <div className="inspector-section-title"><span><CircleAlert size={14} />Needs attention</span></div>
            <p><strong>PROTEIN_HUMAN_REVIEW_REQUIRED</strong>Eligibility and sequence hashes passed local checks. Scientific review remains mandatory.</p>
            <p><strong>NO_WET_LAB_CLAIM</strong>This artifact is a sequence/design representation only; it does not establish function, orderability, biosafety, or regulatory compliance.</p>
          </section>
        </aside>
      </div>
      {notice && <div className="design-notice" role="status">{notice}</div>}
    </div>
  );
}

function DesignsHeader({ dataMode, subtitle, loading, onRefresh, onExportSvg, onExportPng, exportingFormat, exportDisabled, exportDisabledReason }: {
  dataMode: ReturnType<typeof workbenchDataMode>;
  subtitle: string;
  loading: boolean;
  onRefresh: () => void;
  onExportSvg: () => void;
  onExportPng: () => void;
  exportingFormat?: "svg" | "png";
  exportDisabled: boolean;
  exportDisabledReason?: string;
}) {
  return (
    <header className="page-header designs-header">
      <span className="page-header-icon"><Dna size={19} /></span>
      <div><div className="designs-title-row"><h1>Design Explorer</h1>{dataMode === "preview" && <span>Preview data</span>}</div><p>{subtitle}</p></div>
      <div className="page-header-actions">
        <button className="secondary-button" type="button" onClick={onRefresh} disabled={loading}><RefreshCw className={loading ? "spin" : undefined} size={14} />Refresh artifacts</button>
        <div className="design-export-actions" role="group" aria-label="Export active map">
          <button className="secondary-button" type="button" onClick={onExportPng} disabled={exportDisabled} title={exportDisabled ? exportDisabledReason : "Export, reopen, and verify the rendered map as PNG"}>{exportingFormat === "png" ? <LoaderCircle className="spin" size={14} /> : <Download size={14} />}PNG</button>
          <button className="primary-button" type="button" onClick={onExportSvg} disabled={exportDisabled} title={exportDisabled ? exportDisabledReason : "Export, reopen, and verify the rendered map as SVG"}>{exportingFormat === "svg" ? <LoaderCircle className="spin" size={14} /> : <Download size={14} />}SVG</button>
        </div>
      </div>
    </header>
  );
}

function ArtifactList({ documents, selectedPath, onSelect }: {
  documents: LoadedDesign[];
  selectedPath?: string;
  onSelect: (path: string) => void;
}) {
  return (
    <div className="design-document-list">
      {documents.map((document) => {
        const ready = document.status === "ready" && Boolean(document.design);
        const integrityLabel = !ready
          ? "Blocked"
          : document.digestBinding?.status === "match"
            ? "Digest"
            : document.digestBinding?.status === "mismatch"
              ? "Mismatch"
              : document.provenance
                ? "Path only"
                : "Unlinked";
        return (
          <button
            className={`design-document ${document.path === selectedPath ? "is-selected" : ""} ${ready ? "" : "is-invalid"}`}
            type="button"
            key={document.path}
            onClick={() => onSelect(document.path)}
            aria-current={document.path === selectedPath ? "true" : undefined}
          >
            {ready ? <Dna size={15} /> : <CircleAlert size={15} />}
            <span>
              <strong>{document.design?.designId ?? document.name}</strong>
              <small>{ready ? `${document.design!.constructs.length} constructs · ${document.design!.chassis}${(document.copyCount ?? 1) > 1 ? ` · ×${document.copyCount} copies` : ""}` : "Invalid or unreadable IR"}</small>
            </span>
            <em className={document.digestBinding?.status === "mismatch" ? "is-mismatch" : undefined} title={ready ? integrityLabel : document.error}>{integrityLabel}</em>
          </button>
        );
      })}
    </div>
  );
}

function RunProvenancePanel({ provenance, digestBinding, onOpen }: {
  provenance?: DesignRunProvenance;
  digestBinding?: DesignArtifactDigestBinding;
  onOpen: (path: string) => void;
}) {
  if (!provenance && !digestBinding) {
    return (
      <section className="run-provenance-panel is-unlinked">
        <div className="inspector-section-title"><span><History size={14} />Run provenance</span></div>
        <p><strong>No linked run manifest</strong>This artifact remains readable, but its producing workflow and validation journal cannot be proven from the current inventory.</p>
      </section>
    );
  }
  const completed = provenance?.steps.filter((step) => step.ok || step.skipped).length ?? 0;
  const statusLabel = digestBinding?.status === "match" ? "Digest matched" : digestBinding?.status === "mismatch" ? "Mismatch" : "Path linked";
  return (
    <section className={`run-provenance-panel ${digestBinding?.status === "mismatch" ? "has-mismatch" : ""}`}>
      <div className="inspector-section-title"><span><History size={14} />Run provenance</span><strong>{statusLabel}</strong></div>
      <dl>
        <div><dt>Run</dt><dd title={provenance?.runId ?? digestBinding?.statement.runId}>{provenance?.runId ?? digestBinding?.statement.runId}</dd></div>
        <div><dt>Steps</dt><dd>{provenance ? `${completed}/${provenance.steps.length}` : "Manifest unavailable"}</dd></div>
        <div><dt>Review</dt><dd>{provenance ? humanize(provenance.reviewStatus) : "Not declared"}</dd></div>
      </dl>
      {provenance && <div className="provenance-step-list" aria-label="Recorded workflow steps">
        {provenance.steps.map((step) => <span className={step.ok ? "is-complete" : step.skipped ? "is-skipped" : "is-failed"} key={step.id}>{step.id}</span>)}
      </div>}
      <div className="provenance-actions">
        {provenance && <button className="secondary-button compact-command" type="button" onClick={() => onOpen(provenance.manifestPath)}><ExternalLink size={12} />Manifest</button>}
        {digestBinding && <button className="secondary-button compact-command" type="button" onClick={() => onOpen(digestBinding.statement.statementPath)}><ExternalLink size={12} />Provenance</button>}
      </div>
      <p>{provenance?.summary ?? "The workflow manifest is not currently available."}<strong>{digestBinding?.status === "match" ? "Digest matched at scan time" : digestBinding?.status === "mismatch" ? "Artifact content differs" : "Digest unverified"}</strong>{digestBinding?.status === "match" ? "The current artifact SHA-256 and byte size match its provenance.v1 digest record. This is not a signature or a full live provenance verification." : digestBinding?.status === "mismatch" ? "The current file does not match the recorded SHA-256 or size. Do not rely on this artifact until it is rebuilt or reconciled." : "The v1 manifest inventories this artifact path but does not bind its current SHA-256. Treat the link as context only."}</p>
    </section>
  );
}

function SelectedFeatureInspector({ feature, construct }: { feature: DesignFeature; construct: DesignConstruct }) {
  const firstSegment = feature.segments[0];
  const sourceSegments = feature.sourceSegments ?? feature.segments;
  const firstSourceSegment = sourceSegments[0];
  const normalizedType = feature.type.toLocaleLowerCase();
  const selectedKind = feature.source === "software"
    ? "software-inferred ORF"
    : normalizedType === "primer"
      ? "primer"
      : normalizedType === "orf"
        ? "ORF"
        : feature.source === "part"
          ? "part"
          : "annotation";
  return (
    <>
      <span className="eyebrow">Selected {selectedKind}</span>
      <div className="selected-part-title"><i style={{ background: feature.color }} /><div><h3>{feature.id}</h3><span>{feature.type}</span></div></div>
      <p>{feature.name || (feature.source === "software" ? "Derived by the bounded six-frame viewer scan; not declared in the IR." : "No descriptive name declared in the IR.")}</p>
      <dl><div><dt>{construct.viewOrigin ? "View interval" : "Interval"}</dt><dd>{formatFeatureIntervals(feature)}</dd></div>{construct.viewOrigin ? <div><dt>Source interval</dt><dd>{formatCoordinateSegments(sourceSegments, segmentsWrapOrigin(sourceSegments))}</dd></div> : null}<div><dt>Length</dt><dd>{feature.length} bp</dd></div><div><dt>Segments</dt><dd>{feature.segments.length}{feature.wrapsOrigin ? " · view-origin wrap" : ""}</dd></div><div><dt>Direction</dt><dd>{feature.direction === -1 ? "Reverse" : feature.direction === 1 ? "Forward" : "Unknown"}</dd></div><div><dt>GC</dt><dd>{formatPercent(feature.gcFraction)}</dd></div></dl>
      <div className="sequence-preview"><span>Concatenated reference sequence</span><code>{feature.sequence || "No sequence"}</code></div>
      <small className="selection-context">{construct.name} · {firstSegment ? `view position ${firstSegment.start + 1}` : "position unavailable"}{construct.viewOrigin && firstSourceSegment ? ` · source position ${firstSourceSegment.start + 1}` : ""} of {construct.length}</small>
    </>
  );
}

function featureSourceLabel(feature: DesignFeature) {
  if (feature.source === "part") return "IR part";
  if (feature.source === "annotation") return "IR annotation";
  return "Software-derived view feature";
}

function formatFeatureIntervals(feature: DesignFeature) {
  return formatCoordinateSegments(feature.segments, feature.wrapsOrigin);
}

function formatCoordinateSegments(segments: ReadonlyArray<{ start: number; end: number }>, wrapsOrigin = false) {
  const intervals = segments.map((segment) => `${segment.start + 1}–${segment.end}`).join(", ");
  return wrapsOrigin ? `bases ${intervals} (origin wrap)` : `bases ${intervals || "unavailable"}`;
}

function segmentsWrapOrigin(segments: ReadonlyArray<{ start: number; end: number }>) {
  return segments.some((segment, index) => index > 0 && segment.start < segments[index - 1].start);
}

function LayerToggle({ label, detail, checked, disabled = false, onChange }: { label: string; detail: string; checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className={`layer-toggle ${disabled ? "is-disabled" : ""}`}>
      <span><strong>{label}</strong><small>{detail}</small></span>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      <i aria-hidden="true" />
    </label>
  );
}

function ConstraintRow({ constraint }: { constraint: Record<string, unknown> }) {
  const details = Object.entries(constraint).filter(([key]) => key !== "type").map(([key, value]) => `${key} ${String(value)}`).join(" · ");
  return <div className="constraint-row"><CircleAlert size={13} /><span><strong>{humanize(String(constraint.type ?? "constraint"))}</strong><small>Declared requirement · {details || "no validation status in this IR"}</small></span></div>;
}

function restrictionEnzymes(constraints: ReadonlyArray<Record<string, unknown>>) {
  return constraints.flatMap((constraint) => constraint.type === "avoid_restriction_site" && typeof constraint.enzyme === "string" ? [constraint.enzyme] : []);
}

function safeFilename(value: string) {
  return value.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || "design";
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 ** 2).toFixed(1)} MB`;
}

function shortHash(value?: string) {
  if (!value) return "not available";
  if (value.length <= 18) return value;
  return `${value.slice(0, 10)}…${value.slice(-8)}`;
}

function formatPercent(value: number) {
  return `${(value * 100).toFixed(1)}%`;
}

function formatTimestamp(value?: string) {
  if (!value) return "Not available";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function humanize(value: string) {
  return value.replace(/_/g, " ").replace(/\b\w/g, (match) => match.toUpperCase());
}
