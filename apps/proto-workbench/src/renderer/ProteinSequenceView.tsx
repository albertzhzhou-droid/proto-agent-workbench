import { CircleAlert, ExternalLink, Search } from "lucide-react";
import { useMemo, useState } from "react";
import type { DesignViewModel, ProteinViewModel } from "./design-visualization.ts";

const MAX_RENDERED_RESIDUES = 12_000;
const MAX_SEARCH_MATCHES = 200;
const HYDROPHOBIC = new Set(["A", "V", "I", "L", "M", "F", "W", "Y"]);
const BASIC = new Set(["K", "R", "H"]);
const ACIDIC = new Set(["D", "E"]);
const POLAR = new Set(["S", "T", "N", "Q", "C"]);

export function ProteinSequenceView({ design }: { design: DesignViewModel }) {
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toUpperCase();
  const matches = useMemo(
    () => normalizedQuery.length < 2
      ? []
      : design.proteins.flatMap((protein, proteinIndex) => findMatches(protein.sequence, normalizedQuery, proteinIndex)),
    [design.proteins, normalizedQuery],
  );
  const totalResidues = design.proteins.reduce((sum, protein) => sum + protein.length, 0);

  return (
    <section className="protein-sequence-view" data-testid="protein-sequence-viewer" aria-label="Protein sequence visualization">
      <div className="protein-view-heading">
        <div>
          <span className="eyebrow">Protein design domain</span>
          <h2>Amino-acid sequence workspace</h2>
          <p>Residue-level browsing, provenance, and bounded composition metrics. This view does not translate, optimize, or imply experimental readiness.</p>
        </div>
        <div className="protein-review-callout"><CircleAlert size={16} /><span>Human scientific review required</span></div>
      </div>

      <div className="protein-summary-grid" aria-label="Protein selection summary">
        <div><span className="eyebrow">Sequences</span><strong>{design.proteins.length.toLocaleString()}</strong><small>selected records</small></div>
        <div><span className="eyebrow">Residues</span><strong>{totalResidues.toLocaleString()}</strong><small>amino acids</small></div>
        <div><span className="eyebrow">Snapshot</span><strong>{String(design.proteins[0]?.source.release ?? "local")}</strong><small>{design.chassis}</small></div>
      </div>

      <label className="protein-sequence-search">
        <Search size={15} />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a residue motif or protein ID" aria-label="Find a protein residue motif or protein ID" />
        <span role="status" aria-live="polite">{query ? `${matches.length}${matches.length >= MAX_SEARCH_MATCHES ? "+" : ""} matches` : "Search"}</span>
      </label>

      <div className="protein-record-list">
        {design.proteins.map((protein, index) => (
          <ProteinRecord key={`${protein.id}-${index}`} protein={protein} proteinIndex={index} query={normalizedQuery} />
        ))}
      </div>
    </section>
  );
}
function ProteinRecord({ protein, proteinIndex, query }: { protein: ProteinViewModel; proteinIndex: number; query: string }) {
  const sequence = protein.sequence.slice(0, MAX_RENDERED_RESIDUES);
  const truncated = protein.sequence.length > sequence.length;
  const metrics = protein.metrics;
  const composition = metrics.composition ?? countResidues(protein.sequence);
  const topComposition = Object.entries(composition).sort((left, right) => right[1] - left[1]).slice(0, 8);
  const sourceProvider = protein.source.provider || "Source not declared";
  const licenseId = protein.license.id || "License not declared";

  return (
    <article className="protein-record" aria-label={`${protein.name ?? protein.id} protein sequence`}>
      <header className="protein-record-header">
        <div>
          <span className="protein-record-number">Protein {proteinIndex + 1}</span>
          <h3>{protein.name ?? protein.id}</h3>
          <code>{protein.id}</code>
        </div>
        <dl className="protein-record-metrics">
          <div><dt>Length</dt><dd>{protein.length.toLocaleString()} aa</dd></div>
          <div><dt>Approx. mass</dt><dd>{formatMass(metrics.molecularWeightDaApprox)}</dd></div>
          <div><dt>Hydrophobic</dt><dd>{formatFraction(metrics.hydrophobicFraction)}</dd></div>
          <div><dt>Charged</dt><dd>{formatFraction(metrics.chargedFraction)}</dd></div>
        </dl>
      </header>

      <div className="protein-record-copy">
        {protein.description && <p>{protein.description}</p>}
        {protein.descriptionZh && <p lang="zh-CN">{protein.descriptionZh}</p>}
      </div>

      <div className="protein-sequence-panel">
        <div className="protein-sequence-panel-heading"><span>Residue map</span><small>{truncated ? `First ${MAX_RENDERED_RESIDUES.toLocaleString()} of ${protein.length.toLocaleString()} residues` : `${protein.length.toLocaleString()} residues`}</small></div>
        <div className="protein-ruler" aria-hidden="true">{ruler(sequence.length)}</div>
        <div className="protein-residue-grid" role="list" aria-label={`${protein.id} amino-acid residues`}>
          {[...sequence].map((residue, index) => (
            <span className={`protein-residue residue-${residueClass(residue)}${query && protein.sequence.slice(index, index + query.length).toUpperCase() === query ? " is-match" : ""}`} role="listitem" key={`${protein.id}-${index}`} title={`${residue} residue ${index + 1}`} aria-label={`${residue} residue ${index + 1}`}>{residue}</span>
          ))}
        </div>
        {truncated && <p className="protein-sequence-limit">The visual layer is bounded to protect the workbench. The compiled IR retains the complete sequence and digest.</p>}
      </div>

      <div className="protein-record-lower-grid">
        <section className="protein-composition" aria-label={`${protein.id} residue composition`}>
          <div className="inspector-section-title"><span>Composition</span><small>top residues</small></div>
          <div className="protein-composition-list">
            {topComposition.map(([residue, count]) => <div key={residue}><span className={`protein-composition-swatch residue-${residueClass(residue)}`} /> <strong>{residue}</strong><span>{count.toLocaleString()}</span><small>{((count / protein.length) * 100).toFixed(1)}%</small></div>)}
          </div>
        </section>
        <section className="protein-provenance" aria-label={`${protein.id} source and license`}>
          <div className="inspector-section-title"><span>Evidence & rights</span></div>
          <dl>
            <div><dt>Source</dt><dd>{sourceProvider} · {protein.source.record_id || "record unavailable"}</dd></div>
            <div><dt>Release</dt><dd>{protein.source.release || protein.source.revision || "not declared"}</dd></div>
            <div><dt>License</dt><dd>{licenseId} · {protein.license.attribution || "attribution unavailable"}</dd></div>
            <div><dt>Sequence SHA-256</dt><dd><code>{protein.sequenceSha256}</code></dd></div>
          </dl>
          {protein.source.url && <a href={protein.source.url} target="_blank" rel="noreferrer"><ExternalLink size={12} />Open source record</a>}
        </section>
      </div>
    </article>
  );
}

function findMatches(sequence: string, query: string, proteinIndex: number): Array<{ proteinIndex: number; start: number }> {
  const matches: Array<{ proteinIndex: number; start: number }> = [];
  let start = sequence.indexOf(query);
  while (start >= 0 && matches.length < MAX_SEARCH_MATCHES) {
    matches.push({ proteinIndex, start });
    start = sequence.indexOf(query, start + 1);
  }
  return matches;
}

function countResidues(sequence: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const residue of sequence) counts[residue] = (counts[residue] ?? 0) + 1;
  return counts;
}

function residueClass(residue: string): string {
  if (HYDROPHOBIC.has(residue)) return "hydrophobic";
  if (BASIC.has(residue)) return "basic";
  if (ACIDIC.has(residue)) return "acidic";
  if (POLAR.has(residue)) return "polar";
  return "special";
}

function ruler(length: number): string {
  const marks: string[] = [];
  for (let position = 10; position <= length; position += 10) marks.push(position % 50 === 0 ? `${position}` : "·");
  return marks.join(" ");
}

function formatMass(value?: number): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  return value >= 1000 ? `${(value / 1000).toFixed(2)} kDa` : `${value.toFixed(1)} Da`;
}

function formatFraction(value?: number): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(1)}%`;
}
