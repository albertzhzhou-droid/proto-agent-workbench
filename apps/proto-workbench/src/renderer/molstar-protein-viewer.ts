// Imported dynamically only after the user opens a real coordinate attachment.
import { PluginContext } from "molstar/lib/mol-plugin/context.js";
import { DefaultPluginSpec } from "molstar/lib/mol-plugin/spec.js";
import { PluginConfig } from "molstar/lib/mol-plugin/config.js";
import { StructureElement, StructureProperties, Unit, type Structure } from "molstar/lib/mol-model/structure.js";
import { OrderedSet } from "molstar/lib/mol-data/int.js";
import { MolScriptBuilder as MS } from "molstar/lib/mol-script/language/builder.js";
import { Color } from "molstar/lib/mol-util/color/index.js";
import type { ColorTheme } from "molstar/lib/mol-theme/color.js";
import type { ThemeDataContext } from "molstar/lib/mol-theme/theme.js";
import type { ProteinCameraSnapshot, ProteinStructureChain, ProteinStructureData, ProteinStructureImageRequest, ProteinStructureResidue } from "../shared/protein-structures.ts";
import { PROTEIN_STRUCTURE_LIMITS as LIMITS } from "../shared/protein-structures.ts";
import { validateProteinCamera } from "../shared/protein-view-state.ts";
import { Vec3 } from "molstar/lib/mol-math/linear-algebra.js";
import { extractProteinChains } from "../shared/protein-chain-data.ts";
export { extractProteinChains } from "../shared/protein-chain-data.ts";
import { sha256Text } from "./sha256.ts";

export interface ProteinViewport {
  chains: ProteinStructureChain[];
  modelCount: number;
  setView(chainId: string, representation: ProteinStructureImageRequest["view"]["representation"], color: ProteinStructureImageRequest["view"]["color"]): Promise<void>;
  select(chainId: string, residues: ProteinStructureResidue[], focus?: boolean): void;
  reset(): void;
  camera(): ProteinCameraSnapshot;
  restoreCamera(snapshot: ProteinCameraSnapshot): void;
  screenshot(): Promise<{ png: Uint8Array; width: number; height: number; camera: Record<string, unknown> }>;
  dispose(): void;
}

/** One context-loss notification per viewport; disposal removes the native listener. */
export function bindProteinContextLoss(canvas: EventTarget, onLost: () => void): () => void {
  let lost = false;
  const listener = (event: Event) => { event.preventDefault(); if (!lost) { lost = true; onLost(); } };
  canvas.addEventListener("webglcontextlost", listener);
  return () => canvas.removeEventListener("webglcontextlost", listener);
}

function confidenceTheme(_context: ThemeDataContext, props: {}): ColorTheme<{}> {
  return { factory: confidenceTheme, granularity: "group", props, description: "AlphaFold pLDDT; only for source-identified predictions.",
    color: (location) => {
      if (!StructureElement.Location.is(location) || !Unit.isAtomic(location.unit)) return Color(0x78858c);
      const value = location.unit.model.atomicConformation.B_iso_or_equiv.value(location.element);
      return Color(!Number.isFinite(value) || value < 0 || value > 100 ? 0x78858c : value >= 90 ? 0x0053d6 : value >= 70 ? 0x65cbf3 : value >= 50 ? 0xffdb13 : 0xff7d45);
    } };
}

export async function createProteinViewport(
  canvas: HTMLCanvasElement,
  container: HTMLDivElement,
  data: ProteinStructureData,
  options: { modelIndex?: number; onResidue: (chainId: string, residueKey: string) => void; onContextLost: () => void; signal?: AbortSignal },
): Promise<ProteinViewport> {
  if (data.text.length > LIMITS.maxBytes || sha256Text(data.text) !== data.attachment.contentSha256) throw new Error("Structure bytes failed the renderer digest check.");
  const spec = DefaultPluginSpec();
  const plugin = new PluginContext({ ...spec, actions: [], animations: [], config: [[PluginConfig.VolumeStreaming.Enabled, false]],
    canvas3d: { renderer: { backgroundColor: Color(0x111b20) }, camera: { mode: "perspective" },
      cameraFog: { name: "off", params: {} }, trackball: { animate: { name: "off", params: {} } } } });
  // initViewerAsync also rejects this separate lifecycle promise on failure.
  // The awaited initialization below remains the source of the visible error.
  void plugin.canvas3dInitialized.catch(() => undefined);
  let disposed = false;
  let observer: ResizeObserver | undefined;
  let subscription: { unsubscribe(): void } | undefined;
  let unbindContextLost: (() => void) | undefined;
  const check = () => { if (disposed || options.signal?.aborted) throw new Error("Structure loading was cancelled."); };
  const dispose = () => {
    if (disposed) return;
    disposed = true; observer?.disconnect(); subscription?.unsubscribe();
    options.signal?.removeEventListener("abort", dispose);
    unbindContextLost?.(); plugin.dispose();
  };
  options.signal?.addEventListener("abort", dispose, { once: true });
  try {
    await plugin.init(); check();
    if (!(await plugin.initViewerAsync(canvas, container))) throw new Error("WebGL is unavailable. Sequence and residue tables remain accessible.");
    check();
    unbindContextLost = bindProteinContextLoss(canvas, options.onContextLost);
    plugin.managers.interactivity.setProps({ granularity: "residue" });
    plugin.representation.structure.themes.colorThemeRegistry.add({ name: "proto-plddt", label: "AlphaFold pLDDT", category: "Validation",
      factory: confidenceTheme, getParams: () => ({}), defaultValues: {}, isApplicable: () => data.attachment.source.provider === "alphafold" });
    const raw = await plugin.builders.data.rawData({ data: data.text, label: data.attachment.label }); check();
    const trajectory = await plugin.builders.structure.parseTrajectory(raw, data.attachment.format); check();
    const modelCount = trajectory.obj?.data.frameCount ?? 0;
    const modelIndex = options.modelIndex ?? 0;
    if (!modelCount || modelCount > 64 || modelIndex < 0 || modelIndex >= modelCount) throw new Error("Unsupported structure model count or selected model.");
    const modelRef = await plugin.builders.structure.createModel(trajectory, { modelIndex }); check();
    if (!modelRef.obj) throw new Error("The coordinate file has no readable atomic model.");
    const chains = extractProteinChains(modelRef.obj.data, data.attachment.source.provider === "alphafold", modelIndex);
    if (!chains.length) throw new Error("No supported protein polymer chains were found in this coordinate file.");
    const structureRef = await plugin.builders.structure.createStructure(modelRef, { name: "model", params: {} }); check();
    const structure: Structure | undefined = structureRef.obj?.data;
    if (!structure) throw new Error("No structure geometry was produced.");
    let componentRef: string | undefined;
    let queue = Promise.resolve();
    let generation = 0;
    const setView: ProteinViewport["setView"] = (chainId, representation, color) => {
      const requested = ++generation;
      queue = queue.catch(() => undefined).then(async () => {
        check(); if (requested !== generation) return;
        if (color === "confidence" && data.attachment.source.provider !== "alphafold") throw new Error("Confidence colors require a source-identified AlphaFold prediction.");
        if (representation === "molecular-surface" && structure.elementCount > 50_000) throw new Error("Surface rendering is limited to 50,000 atoms; choose cartoon.");
        if (componentRef) await plugin.state.data.build().delete(componentRef).commit(); check();
        const chain = chains.find((entry) => entry.id === chainId);
        const component = chain ? await plugin.builders.structure.tryCreateComponentFromExpression(structureRef,
          MS.struct.generator.atomGroups({ "chain-test": MS.core.rel.eq([MS.struct.atomProperty.macromolecular.label_asym_id(), chain.labelAsymId]) }), "proto-chain")
          : await plugin.builders.structure.tryCreateComponentStatic(structureRef, "polymer");
        check(); if (!component) throw new Error("Selected chain has no renderable protein atoms.");
        componentRef = component.ref;
        await plugin.builders.structure.representation.addRepresentation(component, { type: plugin.representation.structure.registry.get(representation),
          color: plugin.representation.structure.themes.colorThemeRegistry.get(color === "confidence" ? "proto-plddt" : color === "residue" ? "residue-name" : "chain-id"),
          typeParams: { quality: "medium", ignoreHydrogens: true } });
        check();
      });
      return queue;
    };
    subscription = plugin.behaviors.interaction.click.subscribe((event) => {
      if (!StructureElement.Loci.is(event.current.loci)) return;
      const loci = event.current.loci;
      const element = loci.elements[0];
      if (!element || !Unit.isAtomic(element.unit) || OrderedSet.size(element.indices) === 0) return;
      const atom = element.unit.elements[OrderedSet.getAt(element.indices, 0)];
      const location = StructureElement.Location.create(loci.structure, element.unit, atom);
      const label = StructureProperties.chain.label_asym_id(location);
      const labelSeqId = StructureProperties.residue.label_seq_id(location);
      const authSeqId = StructureProperties.residue.auth_seq_id(location);
      const insertion = StructureProperties.residue.pdbx_PDB_ins_code(location);
      options.onResidue(`${modelIndex}:${label}`, `${modelIndex}:${label}:${labelSeqId}:${authSeqId}:${insertion}`);
    });
    observer = new ResizeObserver(() => plugin.handleResize()); observer.observe(container);
    await setView("", "cartoon", "chain");
    plugin.managers.camera.reset(undefined, 0);
    return { chains, modelCount, setView,
      select(chainId, residues, focus = false) {
        if (disposed) return;
        const chain = chains.find((entry) => entry.id === chainId);
        plugin.managers.interactivity.lociSelects.deselectAll();
        if (!chain || !residues.length) return;
        // Compress consecutive deposited label IDs; full-protein selection should
        // not build thousands of equivalent OR clauses in the query engine.
        const sorted = [...residues].sort((a, b) => a.labelSeqId - b.labelSeqId);
        const spans: Array<{ label_asym_id: string; beg_label_seq_id: number; end_label_seq_id: number }> = [];
        for (const residue of sorted) {
          const previous = spans.at(-1);
          if (previous && residue.labelSeqId === previous.end_label_seq_id + 1) previous.end_label_seq_id = residue.labelSeqId;
          else spans.push({ label_asym_id: chain.labelAsymId, beg_label_seq_id: residue.labelSeqId, end_label_seq_id: residue.labelSeqId });
        }
        const loci = StructureElement.Loci.fromSchema(structure, { items: spans });
        plugin.managers.interactivity.lociSelects.selectOnly({ loci });
        if (focus) plugin.managers.camera.focusLoci(loci, { durationMs: 0, minRadius: 5 });
      },
      reset() { if (!disposed) plugin.managers.camera.reset(undefined, 0); },
      camera() { check(); return validateProteinCamera(plugin.canvas3d?.camera.getSnapshot()); },
      restoreCamera(snapshot) {
        check(); const camera = validateProteinCamera(snapshot);
        plugin.managers.camera.setSnapshot({ ...camera, position: Vec3.create(...camera.position), up: Vec3.create(...camera.up), target: Vec3.create(...camera.target) }, 0);
      },
      async screenshot() {
        check(); await queue; check();
        const helper = plugin.helpers.viewportScreenshot;
        if (!helper) throw new Error("Structure capture is unavailable.");
        helper.behaviors.values.next({ ...helper.values, resolution: { name: "custom", params: { width: 1920, height: 1080 } }, format: { name: "png", params: {} }, transparent: false });
        const uri = await helper.getImageDataUri(); check();
        const decoded = atob(uri.split(",")[1]);
        const png = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
        return { png, width: 1920, height: 1080, camera: JSON.parse(JSON.stringify(plugin.canvas3d?.camera.getSnapshot() ?? {})) };
      }, dispose };
  } catch (error) { dispose(); throw error; }
}
