import { useEffect, useId, useRef, useState } from "react";
import { Viewer, type CGViewEvent } from "cgview";
import { Context as SVGContext } from "svgcanvas";
import type { DesignConstruct } from "./design-visualization.ts";
import { CGVIEW_POPOVERS_ENABLED, toCgviewFeatureCoordinates, toCgviewFeatureGeometry } from "./cgview-adapter.ts";

interface SequenceNavigatorProps {
  construct: DesignConstruct;
  selectedFeatureIndex?: number;
  selectedRange?: { readonly start: number; readonly end: number };
  hiddenFeatureIndexes?: ReadonlySet<number>;
  showAnnotations: boolean;
  showPrimers: boolean;
  onSelectFeature(index: number): void;
  onNavigate(base: number): void;
}

interface CapturedDocumentListener {
  type: string;
  listener: EventListenerOrEventListenerObject;
  options?: boolean | AddEventListenerOptions;
}

export function SequenceNavigator({
  construct,
  selectedFeatureIndex,
  selectedRange,
  hiddenFeatureIndexes,
  showAnnotations,
  showPrimers,
  onSelectFeature,
  onNavigate,
}: SequenceNavigatorProps) {
  const generatedId = useId().replace(/[^a-z0-9_-]/gi, "");
  const containerId = `proto-sequence-navigator-${generatedId}`;
  const hostRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<Viewer | undefined>(undefined);
  const onSelectFeatureRef = useRef(onSelectFeature);
  const onNavigateRef = useRef(onNavigate);
  const [renderError, setRenderError] = useState<string>();
  onSelectFeatureRef.current = onSelectFeature;
  onNavigateRef.current = onNavigate;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    setRenderError(undefined);
    const width = Math.max(280, Math.floor(host.clientWidth));
    const height = Math.max(96, Math.floor(host.clientHeight));
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
        // CGView 1.8.2 initializes its linear bp scale before Sequence when
        // format is supplied in the constructor. Initialize safely, then
        // switch after Sequence and Backbone exist.
        format: "circular",
        allowDragAndDrop: false,
        SVGContext,
        sequence: { length: construct.length, name: construct.name },
        settings: { backgroundColor: "#fbfdfc", showShading: true, arrowHeadLength: 0.18 },
        backbone: { color: "#7d8d88", thickness: 3 },
        ruler: { visible: construct.length >= 80, color: "#8a9994", font: "Segoe UI, plain, 7" },
        annotation: { visible: false },
        legend: { visible: false },
        highlighter: {
          showMetaData: false,
          feature: { highlighting: true, popovers: CGVIEW_POPOVERS_ENABLED },
          plot: { highlighting: false, popovers: CGVIEW_POPOVERS_ENABLED },
          contig: { highlighting: false, popovers: CGVIEW_POPOVERS_ENABLED },
          backbone: { highlighting: true, popovers: CGVIEW_POPOVERS_ENABLED },
        },
        features: construct.features.flatMap((feature, featureIndex) => {
          if (hiddenFeatureIndexes?.has(featureIndex)) return [];
          if (!(feature.type.toLocaleLowerCase() === "primer" ? showPrimers : showAnnotations)) return [];
          const geometry = toCgviewFeatureGeometry(feature.segments, feature.direction, construct.length);
          if (!geometry) return [];
          return [{
            name: feature.id,
            type: feature.type,
            source: "proto-navigator",
            legend: feature.type,
            favorite: true,
            ...geometry,
            meta: { featureIndex, featureSource: feature.source },
          }];
        }),
      });
      (viewer as Viewer & { format: string }).format = "linear";
    } catch (error) {
      for (const item of documentListeners) document.removeEventListener(item.type, item.listener, item.options);
      host.replaceChildren();
      viewerRef.current = undefined;
      setRenderError(String(error).replace(/^Error:\s*/i, "") || "Navigator unavailable");
    } finally {
      document.addEventListener = originalAddEventListener;
    }
    if (!viewer) return;

    try {
      viewer.addTracks([{
        name: "Sequence navigator",
        dataType: "feature",
        dataMethod: "source",
        dataKeys: "proto-navigator",
        position: "outside",
        separateFeaturesBy: "none",
        thicknessRatio: 0.72,
      }]);
      viewer.on("click.proto-navigator", (event: CGViewEvent) => {
        if (event.elementType === "feature") {
          const featureIndex = event.element?.meta?.featureIndex;
          if (typeof featureIndex === "number") {
            onSelectFeatureRef.current(featureIndex);
            return;
          }
        }
        if (typeof event.bp !== "number") return;
        const base = Math.max(0, Math.min(construct.length - 1, Math.round(event.bp) - 1));
        onNavigateRef.current(base);
      });
      viewer.drawFull();
      viewerRef.current = viewer;
    } catch (error) {
      viewer.off(".proto-navigator");
      viewer.off(".cgv-highlighter");
      viewer.stopAnimate();
      for (const item of documentListeners) document.removeEventListener(item.type, item.listener, item.options);
      host.replaceChildren();
      viewerRef.current = undefined;
      setRenderError(String(error).replace(/^Error:\s*/i, "") || "Navigator unavailable");
      return;
    }

    const resizeObserver = new ResizeObserver(([entry]) => {
      if (!entry || !viewerRef.current) return;
      viewerRef.current.resize(
        Math.max(280, Math.floor(entry.contentRect.width)),
        Math.max(96, Math.floor(entry.contentRect.height)),
        false,
        true,
      );
      viewerRef.current.drawFull();
    });
    resizeObserver.observe(host);

    return () => {
      resizeObserver.disconnect();
      viewer.off(".proto-navigator");
      viewer.off(".cgv-highlighter");
      viewer.stopAnimate();
      const wrapper = host.querySelector<HTMLElement>(".cgv-wrapper");
      wrapper?.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
      for (const item of documentListeners) document.removeEventListener(item.type, item.listener, item.options);
      viewerRef.current = undefined;
      host.replaceChildren();
    };
  }, [construct, containerId, hiddenFeatureIndexes, showAnnotations, showPrimers]);

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
    if (!selectedRange) return;
    const coordinates = toCgviewFeatureCoordinates({ ...selectedRange, direction: 0 }, construct.length);
    if (!coordinates) return;
    viewer.canvas.drawElement(
      "ui",
      coordinates.start,
      coordinates.stop,
      viewer.backbone.adjustedCenterOffset,
      "rgba(5, 121, 108, 0.68)",
      Math.max(7, viewer.backbone.adjustedThickness + 4),
      "arc",
    );
  }, [construct.length, selectedFeatureIndex, selectedRange]);

  return (
    <div className="sequence-navigator" role="group" aria-label={`Linear sequence navigator for ${construct.name}`}>
      <div className="sequence-navigator-host" id={containerId} ref={hostRef} aria-hidden="true" />
      {renderError && <span className="sequence-navigator-error" role="alert">{renderError}</span>}
      <span className="sr-only">Clickable whole-construct overview with {construct.features.length - (hiddenFeatureIndexes?.size ?? 0)} visible of {construct.features.length} logical features.{construct.viewOrigin ? ` View position one displays source base ${construct.viewOrigin + 1}; the source artifact is unchanged.` : ""} Select a feature or base position to synchronize the sequence view.</span>
    </div>
  );
}
