import { useEffect, useMemo, useRef } from "react";
import { Check, CircleAlert, LoaderCircle, MoveHorizontal } from "lucide-react";
import type { RunStepView, RunTopologyEdge } from "../shared/run-execution.ts";

/** Layout uses recorded causal edges; chronology alone never supplies a connector. */
export function RunDependencyGraph({steps, edges, selectedStepId, onSelect}: {
  steps: RunStepView[]; edges: RunTopologyEdge[]; selectedStepId?: string; onSelect(id: string): void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const graph = useMemo(() => {
    const nodes = steps.filter(step => step.actor === "tool");
    const selectedEdges = edges.filter(edge => edge.kind === "execution");
    const ranks = new Map<string, number>();
    const rows = new Map<number, number>();
    const positions = new Map<string, {x: number; y: number}>();
    for (const step of nodes) {
      const parents = selectedEdges.filter(edge => edge.targetStepId === step.id);
      const rank = parents.length ? Math.max(...parents.map(edge => (ranks.get(edge.sourceStepId) ?? -1) + 1)) : 0;
      const row = rows.get(rank) ?? 0;
      ranks.set(step.id, rank); rows.set(rank, row + 1);
      positions.set(step.id, {x: 28 + rank * 252, y: 46 + row * 112});
    }
    return {nodes, edges: selectedEdges, positions,
      width: Math.max(720, 56 + (Math.max(0, ...ranks.values()) + 1) * 252),
      height: Math.max(242, 70 + Math.max(0, ...rows.values()) * 112)};
  }, [steps, edges]);
  useEffect(() => {
    const position = selectedStepId ? graph.positions.get(selectedStepId) : undefined;
    if (position && scroller.current) scroller.current.scrollTo({left: Math.max(0, position.x - scroller.current.clientWidth / 2 + 110), top: Math.max(0, position.y - 70)});
  }, [selectedStepId, graph.positions]);
  return <div className="run-dependency-graph">
    <header><div><span className="eyebrow">EXECUTION GRAPH</span><strong>{graph.nodes.length} recorded operations <span>· {graph.edges.length} observed-result dependencies</span></strong></div><small><MoveHorizontal size={14}/>Scroll to explore · select a step to inspect</small></header>
    <div ref={scroller} className="run-dependency-scroll" tabIndex={0} aria-label="Recorded tool dependency graph, scroll horizontally to explore">
      <div className="run-dependency-canvas" style={{width: graph.width, height: graph.height}}>
        <svg width={graph.width} height={graph.height} aria-hidden="true">
          <defs><marker id="observed-result-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M 0 0 L 8 4 L 0 8 z" fill="currentColor"/></marker></defs>
          {graph.edges.map(edge => {
            const from = graph.positions.get(edge.sourceStepId), to = graph.positions.get(edge.targetStepId);
            if (!from || !to) return null;
            const selected = edge.sourceStepId === selectedStepId || edge.targetStepId === selectedStepId;
            return <path key={edge.id} className={selected ? "is-selected" : ""} d={`M ${from.x + 214} ${from.y + 40} C ${from.x + 236} ${from.y + 40}, ${to.x - 22} ${to.y + 40}, ${to.x - 2} ${to.y + 40}`} markerEnd="url(#observed-result-arrow)"/>;
          })}
        </svg>
        {graph.nodes.map(step => {
          const position = graph.positions.get(step.id)!;
          return <button key={step.id} type="button" style={{left: position.x, top: position.y}} className={`run-dependency-node is-${step.status}${selectedStepId === step.id ? " is-selected" : ""}`} aria-pressed={selectedStepId === step.id} onClick={() => onSelect(step.id)} title={`${step.title}\n${step.summary}`}>
            <span className="dependency-node-state">{step.status === "completed" ? <Check size={13}/> : step.status === "running" ? <LoaderCircle size={13} className="spin"/> : <CircleAlert size={13}/>}<small>{step.ordinal + 1} · {step.stage}</small></span>
            <strong>{step.title.replace(/^proto_/, "").replaceAll("_", " ")}</strong><span>{step.status.replaceAll("-", " ")}</span>
          </button>;
        })}
      </div>
    </div>
    <p>Arrows identify earlier tool results available to the model when it chose the next operation. They do not assert biological relationships.</p>
  </div>;
}
