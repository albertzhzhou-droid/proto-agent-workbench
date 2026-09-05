import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { SeqViz } from "seqviz";
import type { DesignConstruct } from "./design-visualization.ts";
import { DNA_SEQUENCE_WINDOW_BASES } from "./dna-window.ts";
import { useScientificComputation } from "./use-scientific-computation.ts";
import "./dna-window.css";

export function DnaSequenceWindow({ artifactIdentity, construct, selectedStart, onSelect }: { artifactIdentity: string; construct: DesignConstruct; selectedStart?: number; onSelect(start: number, end: number): void }) {
  const [start, setStart] = useState(0);
  useEffect(() => setStart(0), [artifactIdentity, construct.name, construct.sequence]);
  useEffect(() => {
    if (selectedStart !== undefined) setStart(Math.max(0, Math.min(construct.length - DNA_SEQUENCE_WINDOW_BASES, selectedStart - Math.floor(DNA_SEQUENCE_WINDOW_BASES / 3))));
  }, [selectedStart, construct.length]);
  const input = useMemo(() => ({ construct, start }), [construct, start]);
  const computation = useScientificComputation("window", artifactIdentity, input);
  const boundedStart = Math.max(0, Math.min(start, Math.max(0, construct.length - DNA_SEQUENCE_WINDOW_BASES)));
  const window = computation.result?.projection ?? { start: boundedStart, end: Math.min(construct.length, boundedStart + DNA_SEQUENCE_WINDOW_BASES), annotations: [], truncated: false, sequence: "" };
  const density = computation.result?.density ?? [];
  return <section className="dna-sequence-window" aria-label="Windowed DNA sequence review">
    <header><div><strong>Sequence focus</strong><small>Construct positions {window.start + 1}–{window.end} · {construct.length.toLocaleString()} bp total</small></div><span>{window.annotations.length} visible intervals{window.truncated ? " · bounded at 400" : ""}</span></header>
    <div className="dna-window-overview"><svg viewBox="0 0 1000 48" role="img" aria-label="Feature density overview"><line x1="0" x2="1000" y1="44" y2="44" stroke="#c9e0d4" />{density.map((value, index) => <rect key={index} x={index * 5} y={44 - value * 33} width="4" height={Math.max(1, value * 33)} fill="#6faaa0" />)}<rect x={window.start / construct.length * 1000} y="3" width={Math.max(3, (window.end - window.start) / construct.length * 1000)} height="43" fill="#bbebde55" stroke="#147d61" /></svg><input aria-label="DNA sequence window start" type="range" min={0} max={Math.max(0, construct.length - DNA_SEQUENCE_WINDOW_BASES)} value={window.start} onChange={(event) => setStart(Number(event.target.value))} /></div>
    <div className="dna-window-navigation"><button type="button" disabled={window.start === 0} onClick={() => setStart(Math.max(0, window.start - DNA_SEQUENCE_WINDOW_BASES))}><ChevronLeft size={14} />Previous</button><span>Window-local base labels are hidden. Selections report full construct coordinates.</span><button type="button" disabled={window.end === construct.length} onClick={() => setStart(window.end)} >Next<ChevronRight size={14} /></button></div>
    <div className="dna-window-seqviz">{computation.pending ? <p role="status">Preparing sequence window…</p> : computation.error ? <p role="alert">{computation.error}</p> : <SeqViz key={`${construct.name}:${window.start}`} name={`${construct.name} ${window.start + 1}–${window.end}`} seq={window.sequence} seqType="dna" viewer="linear" annotations={window.annotations} showIndex={false} disableExternalFonts showComplement zoom={{ linear: 60 }} onSelection={(selection) => { if (typeof selection.start === "number" && typeof selection.end === "number" && Number.isInteger(selection.start) && Number.isInteger(selection.end) && selection.end > selection.start) onSelect(window.start + selection.start, window.start + selection.end); }} style={{ width: "100%", height: "100%" }} />}</div>
  </section>;
}
