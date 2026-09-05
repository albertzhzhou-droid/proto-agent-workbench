import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Check, ChevronDown, FileDiff, GripVertical, Layers3, LoaderCircle, Plus, RotateCcw, Trash2, Undo2, Redo2 } from "lucide-react";
import { inverseDesignCommands } from "../shared/dna-edit-history.ts";
import type { DesignEditApi, DesignEditCommand, DesignEditRequest, DesignEditResult, DnaAnnotationAnchor, DnaSourceAnnotation } from "../shared/dna-edits.ts";
import type { DesignConstruct, DesignViewModel } from "./design-visualization.ts";
import "./dna-editor.css";

interface Props {
  design: DesignViewModel;
  construct: DesignConstruct;
  api?: DesignEditApi;
  binding: { sourcePath?: string; partsPath?: string; sourceSha256?: string; partsSha256?: string };
  readFile(path: string): Promise<{ content: string; sha256: string }>;
  onCommitted(result: DesignEditResult): Promise<void>;
  disabledReason?: string;
}

interface HistoryEntry { forward: DesignEditCommand[]; inverse: DesignEditCommand[]; expectedSha256: string }

export function DnaDesignEditor({ design, construct, api, binding, readFile, onCommitted, disabledReason }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [order, setOrder] = useState<string[]>([]);
  const [commands, setCommands] = useState<DesignEditCommand[]>([]);
  const [result, setResult] = useState<DesignEditResult>();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string>();
  const [bound, setBound] = useState(false);
  const [page, setPage] = useState(0);
  const [dragged, setDragged] = useState<string>();
  const [annotationId, setAnnotationId] = useState("note_01");
  const [annotationName, setAnnotationName] = useState("Review region");
  const [annotationType, setAnnotationType] = useState("misc_feature");
  const [anchors, setAnchors] = useState<DnaAnnotationAnchor[]>([]);
  const generation = useRef(0);
  const [undoStack, setUndoStack] = useState<HistoryEntry[]>([]);
  const [redoStack, setRedoStack] = useState<HistoryEntry[]>([]);
  const historyDocument = `${binding.sourcePath}:${construct.name}`;
  useEffect(() => {setUndoStack([]); setRedoStack([]);}, [historyDocument]);
  const identities = useMemo(() => occurrenceIdentities(construct), [construct]);
  const byId = useMemo(() => new Map(construct.parts.map((part, index) => [identities[index], part])), [construct, identities]);
  const bindingKey = `${binding.sourcePath}:${binding.partsPath}:${binding.sourceSha256}:${binding.partsSha256}:${construct.name}`;

  useEffect(() => {
    generation.current += 1;
    setOrder(identities); setCommands([]); setResult(undefined); setStatus(undefined); setBound(false); setBusy(false); setPage(0);
    setAnchors(identities[0] ? [{ instance_id: identities[0], start: 0, end: Math.min(30, construct.parts[0].length), direction: 0 }] : []);
  }, [bindingKey]);

  useEffect(() => {
    if (!expanded) return;
    const current = ++generation.current;
    if (disabledReason || !api || !binding.sourcePath || !binding.partsPath || !binding.sourceSha256 || !binding.partsSha256) {
      setStatus(disabledReason ?? "Open a source-bound workflow artifact to compose edits. A verified .proto source and its exact materialized parts library are required.");
      return;
    }
    setBusy(true); setBound(false);
    void Promise.all([readFile(binding.sourcePath), readFile(binding.partsPath)]).then(([source, parts]) => {
      if (generation.current !== current) return;
      if (source.sha256 !== binding.sourceSha256 || parts.sha256 !== binding.partsSha256) {
        setStatus("Source or materialized library changed after this artifact was compiled. Recompile and reopen the current artifact before rebasing edits.");
      } else { setBound(true); setStatus("Source and materialized library match this artifact. Changes are staged for review."); }
    }).catch((error: unknown) => { if (generation.current === current) setStatus(String(error).replace(/^Error:\s*/, "")); })
      .finally(() => { if (generation.current === current) setBusy(false); });
    return () => { generation.current += 1; };
  }, [expanded, bindingKey, api, disabledReason]);

  const request = (): DesignEditRequest => ({ sourcePath: binding.sourcePath!, partsPath: binding.partsPath!, expectedSourceSha256: binding.sourceSha256!, expectedPartsSha256: binding.partsSha256!, commands });
  const stage = (command: DesignEditCommand) => { setCommands((current) => [...current, command]); setResult(undefined); setStatus("Changes staged. Preview the source diff before applying."); };
  const move = (id: string, to: number) => {
    const from = order.indexOf(id);
    if (from < 0 || to < 0 || to >= order.length || from === to) return;
    const next = [...order]; next.splice(from, 1); next.splice(to, 0, id); setOrder(next);
    stage({ type: "reorder_occurrences", construct: construct.name, instance_ids: next });
  };
  const orientation = (id: string) => {
    const staged = [...commands].reverse().find((command) => command.type === "set_orientation" && command.instance_id === id);
    return staged?.type === "set_orientation" ? staged.orientation : byId.get(id)?.placement?.orientation ?? "forward";
  };
  const preview = async () => {
    if (!bound || !api || !commands.length || busy) return;
    const current = generation.current; setBusy(true); setResult(undefined);
    try { const prepared = await api.prepareEdit(request()); if (generation.current === current) { setResult(prepared); setStatus(prepared.ok ? "Candidate checks passed. Review the exact source diff, then apply." : "Candidate validation failed. Review the diagnostics and revise the staged edits."); } }
    catch (error) { if (generation.current === current) setStatus(String(error).replace(/^Error:\s*/, "")); }
    finally { if (generation.current === current) setBusy(false); }
  };
  const commit = async () => {
    if (!bound || !api || !result?.ok || !result.unified_diff || busy) return;
    const current = generation.current; setBusy(true);
    try {
      const inverse = inverseDesignCommands(commands, {construct: construct.name, order: identities, orientations: Object.fromEntries(identities.map(id => [id, byId.get(id)?.placement?.orientation ?? "forward"])), annotations: construct.sourceAnnotations ?? []});
      const applied = await api.commitEdit(request());
      if (generation.current !== current) return;
      if (!applied.ok) {
        setResult(applied);
        if (applied.source_written) setBound(false);
        setStatus(applied.source_written ? "Source saved; validation did not complete. This map shows the last valid artifact. The draft and exact diagnostics are retained below." : "Edit was not applied. Review the diagnostics before preparing a new preview.");
      }
      else {
        setUndoStack(current => [...current.slice(-19), {forward: structuredClone(commands), inverse, expectedSha256: applied.candidate_sha256}]);
        setRedoStack([]);
        setCommands([]); setResult(undefined); setBound(false); setStatus("Source edit applied and checked. Refreshing compiled artifacts."); await onCommitted(applied);
      }
    } catch (error) { if (generation.current === current) setStatus(String(error).replace(/^Error:\s*/, "")); }
    finally { if (generation.current === current) setBusy(false); }
  };
  const replayHistory = async (direction: "undo" | "redo") => {
    const entry = (direction === "undo" ? undoStack : redoStack).at(-1);
    if (!api || !bound || busy || commands.length || !entry) return;
    if (entry.expectedSha256 !== binding.sourceSha256) {setStatus("Source changed after this edit. Undo history cannot overwrite the newer source."); return;}
    const current = generation.current;
    const batch = direction === "undo" ? entry.inverse : entry.forward;
    const input = {...request(), commands: batch};
    setBusy(true); setResult(undefined);
    try {
      const candidate = await api.prepareEdit(input);
      if (generation.current !== current) return;
      if (!candidate.ok) {setResult(candidate); setStatus("History candidate needs correction; the current source is retained."); return;}
      const applied = await api.commitEdit(input);
      if (generation.current !== current) return;
      if (!applied.ok) {setResult(applied); if (applied.source_written) setBound(false); setStatus(applied.source_written ? "History source edit was saved; validation did not complete. This map remains the last valid artifact. Inspect the diagnostics." : "History edit was not applied. Inspect the diagnostics."); return;}
      const updated = {...entry, expectedSha256: applied.candidate_sha256};
      const remaining = (stack: HistoryEntry[]) => stack.slice(0, -1).map((item, index) => index === stack.length - 2 ? {...item, expectedSha256: applied.candidate_sha256} : item);
      if (direction === "undo") {setUndoStack(remaining); setRedoStack(stack => [...stack, updated]);}
      else {setRedoStack(remaining); setUndoStack(stack => [...stack, updated]);}
      setBound(false); setStatus(`${direction === "undo" ? "Undo" : "Redo"} applied, checked and reviewed. Refreshing the current artifact.`);
      await onCommitted(applied);
    } catch (error) {if (generation.current === current) setStatus(String(error).replace(/^Error:\s*/, ""));}
    finally {if (generation.current === current) setBusy(false);}
  };
  const editAnnotation = (annotation: DnaSourceAnnotation) => {
    setAnnotationId(annotation.id); setAnnotationName(annotation.name); setAnnotationType(annotation.type); setAnchors(annotation.anchors.map((anchor) => ({ ...anchor })));
  };
  const limitReached = commands.length >= 100;
  const writable = bound && !busy && !limitReached;
  const displayed = order.slice(page * 24, (page + 1) * 24);

  return <section className={`dna-composer ${expanded ? "is-expanded" : ""}`} aria-label="DNA source composer">
    <button type="button" className="dna-composer-heading" onClick={() => setExpanded((current) => !current)} aria-expanded={expanded}>
      <span className="dna-composer-icon"><Layers3 size={19} /></span>
      <span><strong>DNA composer</strong><small>Arrange occurrences · reverse placement · anchor annotations</small></span>
      <span className="dna-composer-count">{construct.parts.length} occurrences</span><ChevronDown size={18} />
    </button>
    {expanded && <div className="dna-composer-body">
      <div className="dna-composer-boundary"><span>{design.designId} / {construct.name}</span><span>Placement transforms sequence; biological direction stays independently declared.</span></div>
      <div className="dna-composer-grid">
        <div className="dna-occurrence-column">
          <div className="dna-editor-section-label"><strong>Occurrence order</strong><span>Drag or use the arrow buttons</span></div>
          <ol className="dna-occurrence-list">
            {displayed.map((id, index) => {
              const part = byId.get(id)!; const absoluteIndex = page * 24 + index; const reversed = orientation(id) === "reverse";
              return <li key={id} draggable={writable} onDragStart={() => setDragged(id)} onDragOver={(event) => { if (writable) event.preventDefault(); }} onDrop={(event) => { event.preventDefault(); if (writable && dragged) move(dragged, absoluteIndex); setDragged(undefined); }}>
                <GripVertical size={14} className="dna-grip" /><span className="dna-part-color" style={{ background: part.color }} />
                <span className="dna-occurrence-description"><strong>{part.name ?? part.id}</strong><small>{id} · {part.type} · {part.length.toLocaleString()} bp</small></span>
                <button type="button" className={`dna-orientation ${reversed ? "is-reverse" : ""}`} disabled={!writable} onClick={() => stage({ type: "set_orientation", construct: construct.name, instance_id: id, orientation: reversed ? "forward" : "reverse" })} aria-label={`Reverse placement of ${id}`} aria-pressed={reversed}>{reversed ? "← Reverse" : "Forward →"}</button>
                <button type="button" disabled={!writable || absoluteIndex === 0} onClick={() => move(id, absoluteIndex - 1)} aria-label={`Move ${id} earlier`}><ArrowUp size={14} /></button>
                <button type="button" disabled={!writable || absoluteIndex === order.length - 1} onClick={() => move(id, absoluteIndex + 1)} aria-label={`Move ${id} later`}><ArrowDown size={14} /></button>
              </li>;
            })}
          </ol>
          {order.length > 24 && <div className="dna-editor-pagination"><button type="button" disabled={page === 0} onClick={() => setPage((value) => value - 1)}>Previous</button><span>{page + 1} / {Math.ceil(order.length / 24)}</span><button type="button" disabled={(page + 1) * 24 >= order.length} onClick={() => setPage((value) => value + 1)}>Next</button></div>}
        </div>
        <div className="dna-annotation-column">
          <div className="dna-editor-section-label"><strong>Source-anchored annotation</strong><span>Coordinates follow the original part through every placement.</span></div>
          <div className="dna-annotation-fields"><label>Local annotation ID<input maxLength={64} value={annotationId} onChange={(event) => setAnnotationId(event.target.value)} /></label><label>Label<input maxLength={256} value={annotationName} onChange={(event) => setAnnotationName(event.target.value)} /></label><label>Feature type<input maxLength={64} value={annotationType} onChange={(event) => setAnnotationType(event.target.value)} /></label></div>
          <div className="dna-anchor-table">{anchors.map((anchor, index) => <div className="dna-anchor-row" key={index}>
            <label>Occurrence<select value={anchor.instance_id} onChange={(event) => setAnchors((current) => current.map((value, selected) => selected === index ? { ...value, instance_id: event.target.value, start: 0, end: Math.min(30, byId.get(event.target.value)?.length ?? 1) } : value))}>{identities.map((id) => <option key={id} value={id}>{id}</option>)}</select></label>
            <label>Start (1-based)<input type="number" min={1} value={anchor.start + 1} onChange={(event) => setAnchors((current) => current.map((value, selected) => selected === index ? { ...value, start: Number(event.target.value) - 1 } : value))} /></label>
            <label>End (inclusive)<input type="number" min={1} value={anchor.end} onChange={(event) => setAnchors((current) => current.map((value, selected) => selected === index ? { ...value, end: Number(event.target.value) } : value))} /></label>
            <label>Source direction<select value={anchor.direction} onChange={(event) => setAnchors((current) => current.map((value, selected) => selected === index ? { ...value, direction: Number(event.target.value) as -1 | 0 | 1 } : value))}><option value={0}>Unknown</option><option value={1}>Forward</option><option value={-1}>Reverse</option></select></label>
            <button type="button" aria-label={`Remove source span ${index + 1}`} disabled={anchors.length === 1} onClick={() => setAnchors((current) => current.filter((_, selected) => selected !== index))}><Trash2 size={13} /></button>
          </div>)}</div>
          <div className="dna-annotation-actions"><button type="button" disabled={!writable || anchors.length >= 64} onClick={() => setAnchors((current) => [...current, { instance_id: identities[0], start: 0, end: 1, direction: 0 }])}><Plus size={13} />Add span</button><button type="button" disabled={!writable} onClick={() => stage({ type: "upsert_annotation", construct: construct.name, annotation: { id: annotationId, name: annotationName, type: annotationType, origin: "user", anchors } })}>Stage annotation</button></div>
          {!!construct.sourceAnnotations?.length && <div className="dna-existing-annotations">{construct.sourceAnnotations.map((annotation) => <div key={annotation.id}><button type="button" onClick={() => editAnnotation(annotation)}>{annotation.name}<small>{annotation.id} · {annotation.anchors.length} spans</small></button><button type="button" disabled={!writable} aria-label={`Delete ${annotation.name}`} onClick={() => stage({ type: "delete_annotation", construct: construct.name, annotation_id: annotation.id })}><Trash2 size={14} /></button></div>)}</div>}
        </div>
      </div>
      <footer className="dna-composer-footer"><span role="status">{busy && <LoaderCircle size={14} className="spin" />}{status ?? "Expand the composer to verify its source binding."}</span><button type="button" disabled={!bound || busy || !!commands.length || !undoStack.length} onClick={() => void replayHistory("undo")} title="Undo the last source edit through check, compile and review"><Undo2 size={14} />Undo</button><button type="button" disabled={!bound || busy || !!commands.length || !redoStack.length} onClick={() => void replayHistory("redo")} title="Redo the last source edit through check, compile and review"><Redo2 size={14} />Redo</button><button type="button" disabled={busy || !commands.length} onClick={() => { setCommands([]); setOrder(identities); setResult(undefined); setStatus("Staged edits cleared."); }}><RotateCcw size={14} />Reset</button><button type="button" className="dna-preview-button" disabled={!bound || busy || !commands.length} onClick={() => void preview()}><FileDiff size={14} />Preview {commands.length || ""} edits</button></footer>
      {result && <div className="dna-edit-review"><div><strong>{result.ok ? "Checked source candidate" : "Candidate needs correction"}</strong><code>{result.candidate_sha256.slice(0, 16)}</code></div>{result.diagnostics.map((diagnostic, index) => <p className={`is-${diagnostic.severity}`} key={index}><strong>{diagnostic.code}</strong> {diagnostic.message}</p>)}{result.unified_diff && <pre aria-label="DNA source diff">{result.unified_diff}</pre>}<button type="button" className="dna-apply-button" disabled={!result.ok || !result.unified_diff || busy} onClick={() => void commit()}><Check size={15} />Apply reviewed source edit</button></div>}
    </div>}
  </section>;
}

export function occurrenceIdentities(construct: DesignConstruct): string[] {
  const reserved = new Set(construct.parts.flatMap((part) => part.instanceId ? [part.instanceId] : []));
  return construct.parts.map((part, index) => {
    if (part.instanceId) return part.instanceId;
    const base = `occurrence_${String(index + 1).padStart(4, "0")}`;
    let id = base; let suffix = 1;
    while (reserved.has(id)) id = `${base}_${suffix++}`;
    reserved.add(id); return id;
  });
}
