import type { EvidenceStanding } from "../shared/evidence-standing.ts";

/** Display independent recorded axes without converting completion to approval. */
export function EvidenceStandingView({ standing }: { standing?: EvidenceStanding }) {
  if (!standing) return <section aria-label="Evidence standing"><h3>Evidence standing</h3><p>No evidence standing was recorded for this artifact.</p></section>;
  const axes = [
    ["dataOrigin", "Data origin", standing.dataOrigin],
    ...(standing.eligibility ? [["eligibility", "Materials eligibility", standing.eligibility]] : []),
    ["methodMaturity", "Method maturity", standing.methodMaturity],
    ["executionStatus", "Execution", standing.executionStatus],
    ["humanReview", "Human review", standing.humanReview],
  ];
  return <section aria-label="Evidence standing"><h3>Evidence standing</h3>
    <dl style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: "0.3rem 0.8rem", overflowWrap: "anywhere" }}>
      {axes.map(([axis, label, value]) => <div key={axis} data-evidence-axis={axis} style={{ display: "contents" }}><dt>{label}</dt><dd style={{ margin: 0 }}>{value}</dd></div>)}
    </dl>
    <p className="analysis-footnote">Execution, material eligibility and scientific review are assessed separately.</p>
  </section>;
}
