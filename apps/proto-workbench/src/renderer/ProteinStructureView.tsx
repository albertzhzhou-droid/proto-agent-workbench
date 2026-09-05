import { Box, ChevronDown, Crosshair, Download, FileUp, LoaderCircle, RotateCcw, Save, Search, Undo2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ProteinResidueMapping, ProteinStructureApi, ProteinStructureAttachment, ProteinStructureCandidate,
  ProteinCameraSnapshot, ProteinStructureChain, ProteinStructureData, ProteinStructureTarget, ProteinStructureViewState, StructureProvider } from "../shared/protein-structures.ts";
import { validateProteinViewState } from "../shared/protein-view-state.ts";
import type { ProteinViewModel } from "./design-visualization.ts";
import type { ProteinRange } from "./protein-sequence.ts";
import { chooseUnambiguousChain, mapProteinStructure } from "./protein-structure-mapping.ts";
import type { ProteinViewport } from "./molstar-protein-viewer.ts";
import type { ProteinTrackStructureContext } from "../shared/protein-track-export.ts";

export interface ProteinStructureViewProps {
  protein: ProteinViewModel;
  api?: ProteinStructureApi;
  artifact?: { path: string; sha256: string };
  selectedRange?: ProteinRange;
  onSelectRange(range: ProteinRange): void;
  onClearSelection?(): void;
  onMappingChange?(mapping: ProteinResidueMapping | undefined): void;
  onMappingContextChange?(context: ProteinTrackStructureContext | undefined): void;
}

export function ProteinStructureView({ protein, api, artifact, selectedRange, onSelectRange, onClearSelection, onMappingChange, onMappingContextChange }: ProteinStructureViewProps) {
  const target = useMemo<ProteinStructureTarget | undefined>(() => artifact ? { artifactPath: artifact.path, artifactSha256: artifact.sha256,
    proteinId: protein.id, sequenceSha256: protein.sequenceSha256 } : undefined, [artifact?.path, artifact?.sha256, protein.id, protein.sequenceSha256]);
  const [provider, setProvider] = useState<StructureProvider>("pdb");
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<ProteinStructureCandidate[]>([]);
  const [attachments, setAttachments] = useState<ProteinStructureAttachment[]>([]);
  const [data, setData] = useState<ProteinStructureData>();
  const [chains, setChains] = useState<ProteinStructureChain[]>([]);
  const [chainId, setChainId] = useState("");
  const [modelIndex, setModelIndex] = useState(0);
  const [modelCount, setModelCount] = useState(1);
  const [fragmentInput, setFragmentInput] = useState("");
  const [fragmentStart, setFragmentStart] = useState<number>();
  const [representation, setRepresentation] = useState<"cartoon" | "ball-and-stick" | "molecular-surface">("cartoon");
  const [color, setColor] = useState<"chain" | "residue" | "confidence">("chain");
  const [busy, setBusy] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [ready, setReady] = useState(false);
  const [message, setMessage] = useState("");
  const [renderError, setRenderError] = useState("");
  const [sourceOpen, setSourceOpen] = useState(true);
  const hostRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<ProteinViewport | undefined>(undefined);
  const requestGeneration = useRef(0);
  const pendingRestoreRef = useRef<ProteinStructureViewState | undefined>(undefined);
  const pendingCameraRef = useRef<ProteinCameraSnapshot | undefined>(undefined);
  const selectionRef = useRef({ chainId, chains, fragmentStart, protein, onSelectRange });
  selectionRef.current = { chainId, chains, fragmentStart, protein, onSelectRange };
  const chain = chains.find((item) => item.id === chainId);
  const mapping = useMemo(() => chain ? mapProteinStructure(protein.sequence, chain, fragmentStart) : undefined, [protein.sequence, chain, fragmentStart]);
  const selectedResidues = useMemo(() => mapping?.positions.filter((item) => selectedRange && item.proteinIndex >= selectedRange.start && item.proteinIndex < selectedRange.end).map((item) => item.residue) ?? [], [mapping, selectedRange]);

  useEffect(() => { onMappingChange?.(mapping); }, [mapping, onMappingChange]);
  useEffect(() => {
    onMappingContextChange?.(data && ready ? { attachmentId: data.attachment.id, modelIndex, chainId, explicitStartOneBased: fragmentStart ?? null } : undefined);
    return () => onMappingContextChange?.(undefined);
  }, [data, ready, modelIndex, chainId, fragmentStart, onMappingContextChange]);
  useEffect(() => {
    const generation = ++requestGeneration.current;
    pendingRestoreRef.current = undefined; pendingCameraRef.current = undefined;
    setData(undefined); setChains([]); setChainId(""); setCandidates([]); setAttachments([]); setMessage("");
    setFragmentInput(""); setFragmentStart(undefined); setModelIndex(0); setColor("chain"); setRepresentation("cartoon");
    setQuery(protein.source.record_id ?? ""); setBusy(false);
    if (api && target) void api.list(target).then((items) => { if (requestGeneration.current === generation) setAttachments(items); },
      (error) => { if (requestGeneration.current === generation) setMessage(errorMessage(error)); });
    return () => { requestGeneration.current += 1; };
  }, [api, target]);

  useEffect(() => {
    setReady(false); setRenderError(""); setChains([]);
    if (!data || !hostRef.current) return;
    const controller = new AbortController();
    const host = hostRef.current;
    // The viewport owns this node so its input observers are disposed before
    // removal, and a destroyed WebGL context is never reused by React.
    const canvas = document.createElement("canvas");
    canvas.setAttribute("aria-label", "Interactive protein structure. Drag to rotate, scroll to zoom. Equivalent residue selection is available below.");
    host.prepend(canvas);
    let viewport: ProteinViewport | undefined;
    setRendering(true);
    void import("./molstar-protein-viewer.ts").then(({ createProteinViewport }) => {
      if (controller.signal.aborted) throw new Error("Structure loading was cancelled.");
      return createProteinViewport(canvas, host, data, {
      modelIndex, signal: controller.signal,
      onContextLost() { setReady(false); setRendering(false); setRenderError("WebGL context was lost. Reload the attachment to restore the structure; sequence browsing remains available."); },
      onResidue(clickedChain, residueKey) {
        const current = selectionRef.current;
        const clicked = current.chains.find((item) => item.id === clickedChain);
        if (!clicked) return;
        const linked = mapProteinStructure(current.protein.sequence, clicked, clickedChain === current.chainId ? current.fragmentStart : undefined);
        const position = linked.positions.find((item) => item.residue.key === residueKey);
        setChainId(clickedChain);
        if (clickedChain !== current.chainId) { setFragmentStart(undefined); setFragmentInput(""); }
        if (position) current.onSelectRange({ start: position.proteinIndex, end: position.proteinIndex + 1 });
        else setMessage("This structure residue is not mapped to the selected protein. No sequence position was inferred.");
      },
      });
    }).then((result) => {
      viewport = result;
      if (controller.signal.aborted) { result.dispose(); return; }
      const restored = pendingRestoreRef.current;
      pendingRestoreRef.current = undefined;
      if (restored) {
        const restoredChain = result.chains.find((item) => item.id === restored.chainId);
        if (restored.modelIndex >= result.modelCount || (restored.chainId && !restoredChain)) { result.dispose(); throw new Error("Saved model or chain is absent from these coordinates."); }
        if (restored.explicitStartOneBased !== null && (!restoredChain || mapProteinStructure(protein.sequence, restoredChain, restored.explicitStartOneBased).status === "unmapped")) { result.dispose(); throw new Error("Saved explicit residue mapping no longer verifies."); }
        setChainId(restored.chainId); setFragmentStart(restored.explicitStartOneBased ?? undefined);
        setFragmentInput(restored.explicitStartOneBased?.toString() ?? ""); setRepresentation(restored.representation); setColor(restored.color);
        pendingCameraRef.current = restored.camera;
        if (restored.selectedRange) onSelectRange(restored.selectedRange); else onClearSelection?.();
      } else setChainId(chooseUnambiguousChain(protein.sequence, result.chains));
      viewportRef.current = result; setChains(result.chains); setModelCount(result.modelCount);
      setReady(true); setRendering(false);
    }).catch((error) => { if (!controller.signal.aborted) { setRenderError(errorMessage(error)); setRendering(false); } });
    return () => { controller.abort(); viewport?.dispose(); viewportRef.current = undefined; canvas.remove(); };
  }, [data, modelIndex, protein.sequence]);

  useEffect(() => {
    if (!ready || !viewportRef.current) return;
    let active = true; setRendering(true);
    const viewport = viewportRef.current;
    void viewport.setView(chainId, representation, color).then(() => {
      if (active) {
        viewport.select(chainId, selectedResidues);
        if (pendingCameraRef.current) { viewport.restoreCamera(pendingCameraRef.current); pendingCameraRef.current = undefined; }
        setRendering(false);
      }
    }).catch((error) => { if (active) { setMessage(errorMessage(error)); setRendering(false); } });
    return () => { active = false; };
  }, [ready, chainId, representation, color]);
  useEffect(() => { if (ready) viewportRef.current?.select(chainId, selectedResidues); }, [ready, chainId, selectedResidues]);

  const request = async (operation: () => Promise<void>) => {
    if (busy) return;
    const generation = requestGeneration.current;
    setBusy(true); setMessage("");
    try { await operation(); } catch (error) { if (generation === requestGeneration.current) setMessage(errorMessage(error)); }
    finally { if (generation === requestGeneration.current) setBusy(false); }
  };
  const acceptData = (next: ProteinStructureData, generation: number) => {
    if (generation !== requestGeneration.current) return;
    pendingRestoreRef.current = undefined; pendingCameraRef.current = undefined;
    setData(next); setSourceOpen(false); setModelIndex(0); setFragmentStart(undefined); setFragmentInput(""); setColor("chain");
    setAttachments((current) => [next.attachment, ...current.filter((item) => item.id !== next.attachment.id)]);
  };
  const loadCandidate = (candidate: ProteinStructureCandidate) => void request(async () => {
    if (!api || !target) return;
    const generation = requestGeneration.current;
    acceptData(await api.fetch({ target, provider: candidate.provider, accession: candidate.accession }), generation);
  });

  return <section className="protein-structure-workspace" aria-label="Protein structure workspace">
    <header className="protein-structure-header">
      <div><span className="eyebrow">Structure / sequence</span><h3>Molecular canvas</h3></div>
      <button className="protein-structure-source-toggle" type="button" onClick={() => setSourceOpen((value) => !value)} aria-expanded={sourceOpen}><Box size={14} />{data ? data.attachment.label : "Associate a structure"}<ChevronDown size={13} /></button>
    </header>
    {sourceOpen && <div className="protein-structure-sources">
      <div className="protein-structure-search">
        <label><span className="sr-only">Structure source</span><select value={provider} onChange={(event) => { setProvider(event.target.value as StructureProvider); setCandidates([]); }}><option value="pdb">PDB · experimental</option><option value="alphafold">AlphaFold DB · predicted</option></select></label>
        <label className="protein-source-query"><span className="sr-only">Structure query</span><input value={query} maxLength={160} placeholder={provider === "pdb" ? "PDB ID or protein name" : "UniProt accession"} onChange={(event) => setQuery(event.target.value)} /></label>
        <button type="button" disabled={!api || !target || busy || !query.trim()} onClick={() => void request(async () => {
          const generation = requestGeneration.current;
          const result = await api!.search({ provider, query });
          if (generation === requestGeneration.current) { setCandidates(result); if (!result.length) setMessage("No matching structure records were returned."); }
        })}><Search size={14} />Search</button>
        <button type="button" disabled={!api || !target || busy} onClick={() => void request(async () => {
          const generation = requestGeneration.current; const result = await api!.importFile(target!);
          if (result) acceptData(result, generation);
        })}><FileUp size={14} />Local file</button>
      </div>
      {!api || !target ? <p className="protein-structure-note">Coordinate import requires a desktop protein artifact. The sequence workspace remains fully available.</p> : null}
      {candidates.length > 0 && <div className="protein-structure-results" aria-label="Public structure search results">{candidates.map((candidate) => <button key={`${candidate.provider}:${candidate.accession}`} type="button" disabled={busy} onClick={() => loadCandidate(candidate)}><strong>{candidate.accession}</strong><span>{candidate.title}</span><small>{candidate.provider === "pdb" ? "Deposited coordinates" : "Predicted coordinates"}</small></button>)}</div>}
      {attachments.length > 0 && <label className="protein-saved-structures">Saved attachments<select value={data?.attachment.id ?? ""} disabled={busy} onChange={(event) => {
        const attachmentId = event.target.value;
        if (attachmentId) void request(async () => { const generation = requestGeneration.current; acceptData(await api!.read({ target: target!, attachmentId }), generation); });
      }}><option value="">Choose a verified local attachment</option>{attachments.map((item) => <option key={item.id} value={item.id}>{item.label} · {item.source.classification}</option>)}</select></label>}
      <p className="protein-structure-note">PDB and AlphaFold are separate evidence sources. Linking requires an identical sequence or an explicitly positioned identical fragment.</p>
    </div>}

    <div className={`protein-molecular-stage${data ? " has-data" : ""}`} ref={hostRef}>
      {!data && <div className="protein-structure-empty"><Box size={46} strokeWidth={1} /><h4>A real structure belongs here.</h4><p>Open deposited or predicted coordinates to explore this sequence in three dimensions.</p><span>No coordinates associated · sequence evidence retained</span></div>}
      {(busy || rendering) && <div className="protein-structure-loading" role="status"><LoaderCircle size={18} className="is-spinning" />{busy ? "Reading structure evidence…" : "Rendering atomic coordinates…"}</div>}
      {renderError && <div className="protein-structure-fallback" role="alert"><strong>Structure view unavailable</strong><p>{renderError}</p>{data && <button type="button" onClick={() => setData({ ...data })}>Reload structure</button>}</div>}
      {data && <div className="protein-structure-caption"><span className={`protein-evidence-kind is-${data.attachment.source.classification}`}>{data.attachment.source.classification}</span><span>{data.attachment.label}</span><span>{ready ? `${chains.length} protein chains · model ${modelIndex + 1}` : "Coordinates supplied"}</span></div>}
    </div>

    {data && <>
      <div className="protein-structure-controls">
        <label>Chain<select value={chainId} disabled={!ready || rendering} onChange={(event) => { setChainId(event.target.value); setFragmentStart(undefined); setFragmentInput(""); }}><option value="">All chains · choose to link</option>{chains.map((item) => <option value={item.id} key={item.id}>{item.authAsymId || item.labelAsymId} · {item.sequence.length} aa</option>)}</select></label>
        {modelCount > 1 && <label>Model<select value={modelIndex} disabled={rendering} onChange={(event) => setModelIndex(Number(event.target.value))}>{Array.from({ length: modelCount }, (_, index) => <option key={index} value={index}>{index + 1}</option>)}</select></label>}
        <label>Display<select value={representation} disabled={!ready || rendering} onChange={(event) => setRepresentation(event.target.value as typeof representation)}><option value="cartoon">Cartoon</option><option value="ball-and-stick">Atoms & bonds</option><option value="molecular-surface">Molecular surface</option></select></label>
        <label>Color<select value={color} disabled={!ready || rendering} onChange={(event) => setColor(event.target.value as typeof color)}><option value="chain">By chain</option><option value="residue">By residue</option>{data.attachment.source.provider === "alphafold" && <option value="confidence">pLDDT confidence</option>}</select></label>
        <button type="button" disabled={!ready || !selectedResidues.length || rendering} onClick={() => viewportRef.current?.select(chainId, selectedResidues, true)}><Crosshair size={14} />Focus selection</button>
        <button type="button" disabled={!ready || rendering} onClick={() => viewportRef.current?.reset()}><RotateCcw size={14} />Reset</button>
        <button type="button" disabled={!ready || rendering || busy || !api?.saveView} onClick={() => void request(async () => {
          const generation = requestGeneration.current;
          await api!.saveView!({ target: target!, attachmentId: data.attachment.id, view: { modelIndex, chainId, representation, color,
            selectedRange: selectedRange ?? null, explicitStartOneBased: mapping?.status === "explicit-partial" ? fragmentStart ?? null : null, camera: viewportRef.current!.camera() } });
          if (generation === requestGeneration.current) setMessage("View saved with camera, display settings, residue selection and content bindings.");
        })}><Save size={14} />Save view</button>
        <button type="button" disabled={!ready || rendering || busy || !api?.readView} onClick={() => void request(async () => {
          const generation = requestGeneration.current;
          const saved = await api!.readView!({ target: target!, attachmentId: data.attachment.id });
          if (generation !== requestGeneration.current) return;
          if (!saved) { setMessage("No saved view exists for these exact artifact and coordinate bytes."); return; }
          pendingRestoreRef.current = validateProteinViewState(saved.view, protein.length, data.attachment.source.provider === "alphafold");
          setModelIndex(saved.view.modelIndex); setData({ ...data }); setMessage("Restoring the saved view and rechecking its residue mapping…");
        })}><Undo2 size={14} />Restore view</button>
        <button type="button" disabled={!ready || !api?.exportImage || busy || rendering} onClick={() => void request(async () => {
          const capture = await viewportRef.current!.screenshot();
          const result = await api!.exportImage!({ target: target!, attachmentId: data.attachment.id, png: capture.png, width: capture.width, height: capture.height,
            view: { chainId, representation, color, selectedRange: selectedRange ?? null, mappingStatus: mapping?.status ?? "unmapped", camera: capture.camera } });
          setMessage(`Figure and evidence saved: ${result.relativePath}`);
        })}><Download size={14} />Capture figure</button>
      </div>
      <div className={`protein-mapping-status is-${mapping?.status ?? "unmapped"}`} role="status"><strong>{mapping && mapping.status !== "unmapped" ? `${Math.round(mapping.coverage * 100)}% observed coverage` : "Sequence linking withheld"}</strong><span>{mapping?.reason ?? "Choose a chain. Identical chains require an explicit selection."}</span></div>
      {mapping?.status === "unmapped" && chain && <div className="protein-fragment-mapping"><label>Position this chain fragment at protein residue<input type="number" min={1} max={protein.length} value={fragmentInput} onChange={(event) => setFragmentInput(event.target.value)} /></label><button type="button" onClick={() => setFragmentStart(Number(fragmentInput))}>Verify explicit mapping</button></div>}
      {color === "confidence" && <div className="protein-confidence-legend"><span>pLDDT · 0–100</span><i className="confidence-high" />90–100<i className="confidence-good" />70–90<i className="confidence-low" />50–70<i className="confidence-very-low" />0–50<small>Local prediction confidence; experimental B-factors are not confidence.</small></div>}
      <details className="protein-structure-provenance"><summary>Structure source & content binding</summary><dl><div><dt>Source</dt><dd>{data.attachment.source.url ?? "Local coordinate file; provenance unasserted"}</dd></div><div><dt>Rights</dt><dd>{data.attachment.source.license} · {data.attachment.source.attribution}</dd></div><div><dt>Coordinate SHA-256</dt><dd><code>{data.attachment.contentSha256}</code></dd></div><div><dt>Protein SHA-256</dt><dd><code>{data.attachment.sequenceSha256}</code></dd></div></dl><p>Attaching a structure does not promote it to DESIGN_ELIGIBLE or establish protein function.</p></details>
    </>}
    {message && <p className="protein-structure-message" role="status">{message}</p>}
  </section>;
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : "The structure operation could not be completed."; }
