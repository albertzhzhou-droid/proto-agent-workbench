import { forwardRef, useEffect, useId, useImperativeHandle, useRef, useState } from "react";
import { Viewer, type CGViewEvent } from "cgview";
import { Context as SVGContext } from "svgcanvas";
import "cgview/dist/cgview.css";
import type { MapExportRequest } from "../shared/contracts.ts";
import type { DesignConstruct } from "./design-visualization.ts";
import { CGVIEW_POPOVERS_ENABLED, toCgviewFeatureCoordinates, toCgviewFeatureGeometry } from "./cgview-adapter.ts";
import { embedSvgMetadata, type MapExportMetadata } from "./map-export.ts";
import type { ScientificOutputs } from "./design-scientific.ts";
import type { DesignLabelDensity } from "./design-view-preferences.ts";

export const CGVIEW_RENDERER_VERSION = "1.8.2";

export interface ProductMapHandle {
  exportSvg(filename: string, metadata: MapExportMetadata): Promise<MapExportRequest | undefined>;
  exportPng(filename: string, metadata: MapExportMetadata): Promise<MapExportRequest | undefined>;
  reset(): void;
}

interface ProductMapProps {
  construct: DesignConstruct;
  selectedFeatureIndex?: number;
  selectedRanges?: ReadonlyArray<{ readonly start: number; readonly end: number }>;
  hiddenFeatureIndexes?: ReadonlySet<number>;
  showAnnotations: boolean;
  labelDensity: Exclude<DesignLabelDensity, "auto">;
  showPrimers: boolean;
  showIndex: boolean;
  showGcContent: boolean;
  showGcSkew: boolean;
  sequenceTracks?: ScientificOutputs["tracks"];
  onSelectFeature(index: number): void;
  onHoverBase(base?: number): void;
}

interface CapturedDocumentListener {
  type: string;
  listener: EventListenerOrEventListenerObject;
  options?: boolean | AddEventListenerOptions;
}

export const CgviewMap = forwardRef<ProductMapHandle, ProductMapProps>(function CgviewMap({
  construct,
  selectedFeatureIndex,
  selectedRanges,
  hiddenFeatureIndexes,
  showAnnotations,
  labelDensity,
  showPrimers,
  showIndex,
  showGcContent: requestedGcContent,
  showGcSkew: requestedGcSkew,
  sequenceTracks,
  onSelectFeature,
  onHoverBase,
}, ref) {
  const generatedId = useId().replace(/[^a-z0-9_-]/gi, "");
  const containerId = `proto-cgview-${generatedId}`;
  const hostRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<Viewer | undefined>(undefined);
  const [renderError, setRenderError] = useState<string>();
  const onSelectFeatureRef = useRef(onSelectFeature);
  const onHoverBaseRef = useRef(onHoverBase);
  const mapFormat = construct.topology === "linear" ? "linear" : "circular";
  const topologyCaption = construct.topology === "unknown"
    ? "Topology unknown · circular projection"
    : `${construct.topology === "circular" ? "Circular" : "Linear"} topology · ${construct.topology} map`;
  const showGcContent = requestedGcContent && Boolean(sequenceTracks);
  const showGcSkew = requestedGcSkew && Boolean(sequenceTracks);
  const gcSkewSummary = showGcSkew ? sequenceTracks?.gcSkew : undefined;
  onSelectFeatureRef.current = onSelectFeature;
  onHoverBaseRef.current = onHoverBase;

  useImperativeHandle(ref, () => ({
    async exportSvg(filename, metadata) {
      try {
        const viewer = viewerRef.current;
        const svg = viewer?.io.getSVG();
        if (!svg) return undefined;
        const exportSvg = embedSvgMetadata(svg, metadata);
        if (!exportSvg || !viewer) return undefined;
        return {
          format: "svg",
          filename,
          bytes: new TextEncoder().encode(exportSvg),
          width: viewer.width,
          height: viewer.height,
          metadata,
        };
      } catch {
        return undefined;
      }
    },
    async exportPng(filename, metadata) {
      try {
        const viewer = viewerRef.current;
        if (!viewer) return undefined;
        const bytes = await captureViewerPng(viewer, filename);
        if (!bytes) return undefined;
        return {
          format: "png",
          filename,
          bytes,
          width: viewer.width,
          height: viewer.height,
          metadata,
        };
      } catch {
        return undefined;
      }
    },
    reset() {
      viewerRef.current?.reset(0);
    },
  }), []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    setRenderError(undefined);
    const width = Math.max(180, Math.floor(host.clientWidth));
    const height = Math.max(180, Math.floor(host.clientHeight));
    const documentListeners: CapturedDocumentListener[] = [];
    const originalAddEventListener = document.addEventListener;
    document.addEventListener = function captureDocumentListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) {
      if (type === "keypress") documentListeners.push({ type, listener, options });
      originalAddEventListener.call(document, type, listener, options);
    } as typeof document.addEventListener;

    let viewer: Viewer | undefined;
    try {
      viewer = new Viewer(`#${containerId}`, {
        width,
        height,
        // CGView 1.8.2 initializes the linear bp scale before Sequence when
        // format is supplied in the constructor. Switch to linear only after
        // the sequence-backed viewer exists.
        format: "circular",
        allowDragAndDrop: false,
        SVGContext,
        sequence: { seq: construct.sequence, name: construct.name },
        settings: { backgroundColor: "#ffffff", showShading: true, arrowHeadLength: 0.22 },
        backbone: { color: "#63736f", thickness: 4 },
        ruler: { visible: showIndex && construct.length >= 200, color: "#667970", font: "Segoe UI, plain, 9", tickCount: rulerTickCount(width, height, mapFormat), rulerPadding: 6 },
        annotation: {
          visible: showAnnotations && labelDensity !== "hidden",
          font: "Segoe UI, plain, 9",
          fontColor: "#26332f",
          labelLineLength: labelDensity === "dense" ? 14 : 10,
          labelPlacement: labelDensity === "dense" ? "angled" : "default",
          priorityMax: labelDensity === "dense" ? 160 : 48,
        },
        highlighter: {
          showMetaData: false,
          feature: { highlighting: true, popovers: CGVIEW_POPOVERS_ENABLED },
          plot: { highlighting: false, popovers: CGVIEW_POPOVERS_ENABLED },
          contig: { highlighting: false, popovers: CGVIEW_POPOVERS_ENABLED },
          backbone: { highlighting: false, popovers: CGVIEW_POPOVERS_ENABLED },
        },
        legend: {
          visible: false,
          items: uniqueLegendItems(construct, showGcContent, showGcSkew, showAnnotations, showPrimers),
        },
        features: construct.features.flatMap((feature, index) => {
          if (hiddenFeatureIndexes?.has(index)) return [];
          if (!(feature.type.toLocaleLowerCase() === "primer" ? showPrimers : showAnnotations)) return [];
          const geometry = toCgviewFeatureGeometry(feature.segments, feature.direction, construct.length);
          if (!geometry) return [];
          return [{
            name: boundedMapLabel(feature.id),
            type: feature.type,
            source: "proto-ir",
            ...geometry,
            legend: feature.type,
            favorite: true,
            meta: { featureIndex: index, featureSource: feature.source, segmentCount: feature.segments.length, wrapsOrigin: feature.wrapsOrigin },
          }];
        }),
      });
      if (mapFormat === "linear") (viewer as Viewer & { format: string }).format = "linear";
    } catch (error) {
      for (const item of documentListeners) document.removeEventListener(item.type, item.listener, item.options);
      host.replaceChildren();
      viewerRef.current = undefined;
      setRenderError(String(error).replace(/^Error:\s*/i, "") || "The map renderer could not initialize.");
    } finally {
      document.addEventListener = originalAddEventListener;
    }

    if (!viewer) return;
    try {
      if (showGcContent && sequenceTracks) {
        const series = sequenceTracks.gcContent;
        viewer.addPlots([{
          name: "GC content",
          source: "proto-gc-content",
          positions: series.positions,
          scores: series.scores,
          baseline: series.baseline,
          axisMin: 0,
          axisMax: 1,
          legendPositive: "GC above construct mean",
          legendNegative: "GC below construct mean",
          meta: { windowSize: series.windowSize, derived: true },
        }]);
        viewer.addTracks([{
          name: "GC content",
          dataType: "plot",
          dataMethod: "source",
          dataKeys: "proto-gc-content",
          position: "inside",
          thicknessRatio: showGcSkew ? 0.38 : 0.55,
        }]);
      }
      if (showGcSkew && sequenceTracks) {
        const series = sequenceTracks.gcSkew;
        viewer.addPlots([{
          name: "GC skew",
          source: "proto-gc-skew",
          positions: series.positions,
          scores: series.scores,
          baseline: series.baseline,
          axisMin: -1,
          axisMax: 1,
          legendPositive: "G-rich GC skew",
          legendNegative: "C-rich GC skew",
          meta: { windowSize: series.windowSize, overallSkew: series.overallSkew, formula: "(G-C)/(G+C)", derived: true },
        }]);
        viewer.addTracks([{
          name: "GC skew",
          dataType: "plot",
          dataMethod: "source",
          dataKeys: "proto-gc-skew",
          position: "inside",
          thicknessRatio: showGcContent ? 0.38 : 0.55,
        }]);
      }
      viewer.addTracks([{
        name: "Feature architecture",
        dataType: "feature",
        dataMethod: "source",
        dataKeys: "proto-ir",
        position: "outside",
        separateFeaturesBy: "none",
        thicknessRatio: 1.35,
      }]);
      viewer.addCaptions([{
        name: `${boundedMapLabel(construct.name)}\n${construct.length} bp${construct.viewOrigin ? `\nView +1 = source ${construct.viewOrigin + 1}` : ""}`,
        position: "top-left",
        anchor: "top-left",
        font: "Segoe UI, bold, 9",
        fontColor: "#33443f",
        textAlignment: "left",
        backgroundColor: "rgba(255, 255, 255, 0.94)",
      }, {
        name: `${topologyCaption}\nSoftware-level view · review required`,
        position: "bottom-left",
        anchor: "bottom-left",
        font: "Segoe UI, plain, 7",
        fontColor: "#6b5541",
        textAlignment: "left",
        backgroundColor: "rgba(255, 250, 239, 0.94)",
      }]);
      viewer.on("click.proto-selection", (event: CGViewEvent) => {
        if (event.elementType !== "feature") return;
        const featureIndex = event.element?.meta?.featureIndex;
        if (typeof featureIndex === "number") onSelectFeatureRef.current(featureIndex);
      });
      viewer.on("mousemove.proto-position", (event: CGViewEvent) => {
        onHoverBaseRef.current(typeof event.bp === "number" ? Math.round(event.bp) : undefined);
      });
      viewer.drawFull();
      viewerRef.current = viewer;
    } catch (error) {
      viewer.off(".proto-selection");
      viewer.off(".proto-position");
      viewer.off(".cgv-highlighter");
      viewer.stopAnimate();
      for (const item of documentListeners) document.removeEventListener(item.type, item.listener, item.options);
      host.replaceChildren();
      viewerRef.current = undefined;
      setRenderError(String(error).replace(/^Error:\s*/i, "") || "The map renderer could not draw this construct.");
      return;
    }

    const resizeObserver = new ResizeObserver(([entry]) => {
      if (!entry || !viewerRef.current) return;
      const nextWidth = Math.max(180, Math.floor(entry.contentRect.width));
      const nextHeight = Math.max(180, Math.floor(entry.contentRect.height));
      viewerRef.current.ruler.tickCount = rulerTickCount(nextWidth, nextHeight, mapFormat);
      viewerRef.current.resize(nextWidth, nextHeight, false, true);
      viewerRef.current.drawFull();
    });
    resizeObserver.observe(host);

    return () => {
      resizeObserver.disconnect();
      viewer.off(".proto-selection");
      viewer.off(".proto-position");
      viewer.off(".cgv-highlighter");
      viewer.stopAnimate();
      const wrapper = host.querySelector<HTMLElement>(".cgv-wrapper");
      wrapper?.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
      for (const item of documentListeners) document.removeEventListener(item.type, item.listener, item.options);
      viewerRef.current = undefined;
      host.replaceChildren();
      onHoverBaseRef.current(undefined);
    };
  }, [construct, containerId, sequenceTracks, hiddenFeatureIndexes, labelDensity, mapFormat, showAnnotations, showGcContent, showGcSkew, showIndex, showPrimers, topologyCaption]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    viewer.canvas.clear("ui");
    const selectedFeature = selectedFeatureIndex === undefined
      ? undefined
      : viewer.features().find((feature) => feature.meta?.featureIndex === selectedFeatureIndex);
    if (selectedFeature) {
      selectedFeature.highlight();
      return;
    }
    for (const selectedRange of selectedRanges ?? []) {
      const coordinates = toCgviewFeatureCoordinates({ ...selectedRange, direction: 0 }, construct.length);
      if (!coordinates) continue;
      viewer.canvas.drawElement(
        "ui",
        coordinates.start,
        coordinates.stop,
        viewer.backbone.adjustedCenterOffset,
        "rgba(5, 121, 108, 0.58)",
        Math.max(8, viewer.backbone.adjustedThickness + 5),
        "arc",
      );
    }
  }, [construct.length, selectedFeatureIndex, selectedRanges]);

  return (
    <div className="cgview-map" data-testid="cgview-map" role="group" aria-label={`Interactive ${mapFormat} product map for ${construct.name}`} aria-describedby={`${containerId}-summary`}>
      <div className="cgview-canvas-host" id={containerId} ref={hostRef} aria-hidden="true" />
      {(showGcContent || showGcSkew) && (
        <div className="cgview-metric-legend" aria-label={`Sequence metric plots using a ${sequenceTracks?.gcContent.windowSize ?? 0} base sliding window`}>
          {showGcContent && <section aria-label={`GC content relative to the construct mean of ${(construct.gcFraction * 100).toFixed(1)} percent`}>
            <strong>GC content</strong>
            <span><i className="is-content-above" />Above mean</span>
            <span><i className="is-content-below" />Below mean</span>
          </section>}
          {showGcSkew && <section aria-label={`GC skew using G minus C over G plus C; overall skew ${gcSkewSummary?.overallSkew.toFixed(3) ?? "0.000"}`}>
            <strong>GC skew</strong>
            <span><i className="is-skew-positive" />G-rich</span>
            <span><i className="is-skew-negative" />C-rich</span>
          </section>}
        </div>
      )}
      {renderError && <div className="cgview-map-error" role="alert"><strong>Map unavailable</strong><span>{renderError}</span><small>Use the synchronized sequence view and feature table while the map is unavailable.</small></div>}
      <span className="sr-only" id={`${containerId}-summary`}>{construct.topology === "unknown" ? "Circular overview projection with source topology unknown" : `${construct.topology} map`} with {construct.features.length - (hiddenFeatureIndexes?.size ?? 0)} visible of {construct.features.length} logical features across {construct.length} bases.{construct.viewOrigin ? ` View position one displays source base ${construct.viewOrigin + 1}; the source artifact is unchanged.` : ""}{showAnnotations && labelDensity === "hidden" ? " Feature labels are hidden on the canvas and remain available in the feature inventory." : ""}{showGcContent ? ` A bounded sliding-window GC plot is shown relative to the ${(construct.gcFraction * 100).toFixed(1)} percent construct mean.` : ""}{showGcSkew ? ` A GC-skew plot shows G-rich and C-rich windows using the formula G minus C over G plus C; the construct-wide skew is ${gcSkewSummary?.overallSkew.toFixed(3) ?? "0.000"}.` : ""} Use the feature table below for a keyboard-accessible ordered list and selection controls.</span>
    </div>
  );
});

function uniqueLegendItems(construct: DesignConstruct, showGcContent: boolean, showGcSkew: boolean, showAnnotations: boolean, showPrimers: boolean) {
  const seen = new Set<string>();
  const items = construct.features.filter((feature) => feature.type.toLocaleLowerCase() === "primer" ? showPrimers : showAnnotations).flatMap((feature) => {
    if (seen.has(feature.type)) return [];
    seen.add(feature.type);
    return [{ name: feature.type, swatchColor: feature.color, decoration: "arc" }];
  });
  if (showGcContent) {
    items.push(
      { name: "GC above construct mean", swatchColor: "#188977", decoration: "arc" },
      { name: "GC below construct mean", swatchColor: "#c99a45", decoration: "arc" },
    );
  }
  if (showGcSkew) {
    items.push(
      { name: "G-rich GC skew", swatchColor: "#6b5bc7", decoration: "arc" },
      { name: "C-rich GC skew", swatchColor: "#d46b88", decoration: "arc" },
    );
  }
  return items;
}

function boundedMapLabel(value: string) {
  const characters = Array.from(value);
  return characters.length <= 18 ? value : `${characters.slice(0, 16).join("")}…`;
}

function rulerTickCount(width: number, height: number, format: "linear" | "circular") {
  // The circular ruler labels sit inside the innermost track. Leave enough
  // circumference for a full number and unit instead of crowding the center.
  const available = format === "circular" ? Math.min(width, height) : width;
  return Math.max(2, Math.min(10, Math.floor(available / (format === "circular" ? 120 : 90))));
}

function captureViewerPng(viewer: Viewer, filename: string): Promise<Uint8Array | undefined> {
  return new Promise((resolve) => {
    const originalDownload = viewer.io.download;
    let settled = false;
    const finish = (bytes?: Uint8Array) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      viewer.io.download = originalDownload;
      resolve(bytes);
    };
    const timeout = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      viewer.io.download = () => {
        viewer.io.download = originalDownload;
      };
      window.setTimeout(() => {
        if (viewer.io.download !== originalDownload) viewer.io.download = originalDownload;
      }, 30_000);
      resolve(undefined);
    }, 15_000);
    viewer.io.download = (data, _downloadFilename, mediaType) => {
      if (mediaType && mediaType !== "image/png") {
        finish(undefined);
        return;
      }
      const blob = data instanceof Blob ? data : new Blob([data], { type: "image/png" });
      void blob.arrayBuffer()
        .then((buffer) => finish(new Uint8Array(buffer)))
        .catch(() => finish(undefined));
    };
    try {
      viewer.io.downloadImage(viewer.width, viewer.height, filename);
    } catch {
      finish(undefined);
    }
  });
}
