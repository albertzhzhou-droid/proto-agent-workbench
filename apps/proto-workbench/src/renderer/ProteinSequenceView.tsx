import { ChevronLeft, ChevronRight, CircleAlert, Search } from "lucide-react";
import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import type { DesignViewModel, ProteinViewModel } from "./design-visualization.ts";
import {
  calculateProteinMetrics,
  extractProteinRange,
  PROTEIN_VISUALIZATION_LIMITS,
  searchProteins,
  validateProteinRange,
  type ProteinRange,
  type ProteinSearchMatch,
} from "./protein-sequence.ts";

const HYDROPHOBIC = new Set(["A", "V", "I", "L", "M", "F", "W", "Y"]);
const BASIC = new Set(["K", "R", "H"]);
const ACIDIC = new Set(["D", "E"]);
const POLAR = new Set(["S", "T", "N", "Q", "C"]);

export function ProteinSequenceView({ design }: { design: DesignViewModel }) {
  const firstProtein = design.proteins[0];
  const [selectedProteinIndex, setSelectedProteinIndex] = useState(0);
  const [windowStart, setWindowStart] = useState(0);
  const [query, setQuery] = useState("");
  const [activeMatchIndex, setActiveMatchIndex] = useState(0);
  const [rangeStart, setRangeStart] = useState("1");
  const [rangeEnd, setRangeEnd] = useState(String(Math.min(firstProtein?.length ?? 1, PROTEIN_VISUALIZATION_LIMITS.maxSelectedResidues)));
  const [selectedRange, setSelectedRange] = useState<ProteinRange | undefined>(firstProtein
    ? { start: 0, end: Math.min(firstProtein.length, PROTEIN_VISUALIZATION_LIMITS.maxSelectedResidues) }
    : undefined);
  const [rangeError, setRangeError] = useState<string>();

  useEffect(() => {
    const protein = design.proteins[0];
    setSelectedProteinIndex(0);
    setWindowStart(0);
    setQuery("");
    setActiveMatchIndex(0);
    setRangeStart("1");
    setRangeEnd(String(Math.min(protein?.length ?? 1, PROTEIN_VISUALIZATION_LIMITS.maxSelectedResidues)));
    setSelectedRange(protein ? { start: 0, end: Math.min(protein.length, PROTEIN_VISUALIZATION_LIMITS.maxSelectedResidues) } : undefined);
    setRangeError(undefined);
  }, [design]);

  const boundedProteinIndex = Math.min(selectedProteinIndex, Math.max(0, design.proteins.length - 1));
  const protein = design.proteins[boundedProteinIndex];
  const totalResidues = design.proteins.reduce((sum, item) => sum + item.length, 0);
  const summaryMode = totalResidues > PROTEIN_VISUALIZATION_LIMITS.maxInteractiveTotalResidues
    || design.proteins.length > PROTEIN_VISUALIZATION_LIMITS.maxInteractiveRecords;
  const maxWindowStart = Math.max(0, (protein?.length ?? 0) - PROTEIN_VISUALIZATION_LIMITS.maxRenderedResidues);
  const boundedWindowStart = Math.min(windowStart, maxWindowStart);
  const windowEnd = Math.min(protein?.length ?? 0, boundedWindowStart + PROTEIN_VISUALIZATION_LIMITS.maxRenderedResidues);
  const visibleSequence = protein?.sequence.slice(boundedWindowStart, windowEnd) ?? "";
  const searchResult = useMemo(() => searchProteins(design.proteins, query), [design.proteins, query]);
  const activeMatch = searchResult.matches[activeMatchIndex] ?? searchResult.matches[0];
  const selectedSequence = protein && selectedRange ? extractProteinRange(protein.sequence, selectedRange) : undefined;
  const selectedMetrics = useMemo(
    () => selectedSequence ? calculateProteinMetrics(selectedSequence) : undefined,
    [selectedSequence],
  );
  const visibleMatchResidues = useMemo(() => {
    const indexes = new Set<number>();
    for (const match of searchResult.matches) {
      if (match.proteinIndex !== boundedProteinIndex || match.field !== "sequence" || match.start === undefined || match.end === undefined) continue;
      const start = Math.max(match.start, boundedWindowStart);
      const end = Math.min(match.end, windowEnd);
      for (let index = start; index < end; index += 1) indexes.add(index);
    }
    return indexes;
  }, [boundedProteinIndex, boundedWindowStart, searchResult.matches, windowEnd]);
  const selectedComposition = Object.entries(selectedMetrics?.composition ?? {})
    .sort((left, right) => right[1] - left[1])
    .slice(0, 8);

  const chooseProtein = (index: number, focus?: ProteinSearchMatch) => {
    const target = design.proteins[index];
    if (!target) return;
    const focusStart = focus?.start ?? 0;
    const focusEnd = focus?.end ?? Math.min(target.length, PROTEIN_VISUALIZATION_LIMITS.maxSelectedResidues);
    const nextWindowStart = Math.min(
      Math.max(0, focusStart),
      Math.max(0, target.length - PROTEIN_VISUALIZATION_LIMITS.maxRenderedResidues),
    );
    setSelectedProteinIndex(index);
    setWindowStart(nextWindowStart);
    setRangeStart(String(focusStart + 1));
    setRangeEnd(String(Math.max(focusStart + 1, focusEnd)));
    setSelectedRange({ start: focusStart, end: Math.max(focusStart + 1, focusEnd) });
    setRangeError(undefined);
  };

  const showMatch = (index: number) => {
    const match = searchResult.matches[index];
    if (!match) return;
    setActiveMatchIndex(index);
    chooseProtein(match.proteinIndex, match);
  };

  const moveMatch = (direction: -1 | 1) => {
    if (!searchResult.matches.length) return;
    const current = searchResult.matches[activeMatchIndex] ? activeMatchIndex : 0;
    showMatch((current + direction + searchResult.matches.length) % searchResult.matches.length);
  };

  const applyRange = () => {
    if (!protein) return;
    const validation = validateProteinRange(Number(rangeStart), Number(rangeEnd), protein.length);
    if (!validation.ok) {
      setRangeError(validation.message);
      setSelectedRange(undefined);
      return;
    }
    setRangeError(undefined);
    setSelectedRange(validation.range);
    setWindowStart(Math.min(validation.range.start, maxWindowStart));
  };

  const moveWindow = (direction: -1 | 1) => {
    setWindowStart((current) => Math.min(maxWindowStart, Math.max(0, current + (direction * PROTEIN_VISUALIZATION_LIMITS.maxRenderedResidues))));
  };

  const handleWindowKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "PageUp") {
      event.preventDefault();
      moveWindow(-1);
    } else if (event.key === "PageDown") {
      event.preventDefault();
      moveWindow(1);
    } else if (event.key === "Home") {
      event.preventDefault();
      setWindowStart(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setWindowStart(maxWindowStart);
    }
  };

  const searchStatus = !query.trim()
    ? "Search ID, name, source record, or sequence motif"
    : query.trim().length > PROTEIN_VISUALIZATION_LIMITS.maxSearchQueryCharacters
      ? `Query exceeds ${PROTEIN_VISUALIZATION_LIMITS.maxSearchQueryCharacters} characters`
      : searchResult.matches.length === 0
        ? "No ID, name, source-record, or sequence matches"
        : searchResult.truncated
          ? `${searchResult.matches.length.toLocaleString()}+ bounded matches`
          : `${searchResult.matches.length.toLocaleString()} matches`;

  if (!protein) return null;
  return (
    <section className="protein-sequence-view" data-testid="protein-sequence-viewer" aria-label="Protein sequence visualization">
      <div className="protein-view-heading">
        <div>
          <span className="eyebrow">Protein design domain</span>
          <h2>Amino-acid sequence workspace</h2>
          <p>Integrity-checked residue browsing and bounded, software-derived processing. This view does not translate, optimize, or imply experimental readiness.</p>
        </div>
        <div className="protein-review-callout"><CircleAlert size={16} /><span>Human scientific review required</span></div>
      </div>

      <div className="protein-summary-grid" aria-label="Protein selection summary">
        <div><span className="eyebrow">Sequences</span><strong>{design.proteins.length.toLocaleString()}</strong><small>governed records verified on read</small></div>
        <div><span className="eyebrow">Residues</span><strong>{totalResidues.toLocaleString()}</strong><small>amino acids</small></div>
        <div><span className="eyebrow">Rendering</span><strong>{summaryMode ? "Summary" : "Bounded"}</strong><small>≤ {PROTEIN_VISUALIZATION_LIMITS.maxRenderedResidues.toLocaleString()} residues in DOM</small></div>
      </div>
      {summaryMode && <p className="protein-sequence-limit" role="status">Bounded summary mode is active for this large design. Metadata remains searchable; only the selected record and residue window are rendered.</p>}

      <div className="protein-workbench-controls">
        <label>
          <span>Active protein</span>
          <select value={boundedProteinIndex} onChange={(event) => chooseProtein(Number(event.target.value))}>
            {design.proteins.map((item, index) => <option key={`${item.id}-${index}`} value={index}>{index + 1}. {item.name ?? item.id} · {item.length.toLocaleString()} aa</option>)}
          </select>
        </label>
        <label className="protein-sequence-search">
          <span className="sr-only">Search proteins</span>
          <Search size={15} aria-hidden="true" />
          <input
            value={query}
            maxLength={PROTEIN_VISUALIZATION_LIMITS.maxSearchQueryCharacters + 1}
            onChange={(event) => { setQuery(event.target.value); setActiveMatchIndex(0); }}
            placeholder="ID, name, source record, or motif"
            aria-label="Search protein ID, name, source record, or sequence motif"
          />
          <span role="status" aria-live="polite">{searchStatus}</span>
        </label>
        <div className="protein-match-navigation" aria-label="Protein search result navigation">
          <button type="button" onClick={() => moveMatch(-1)} disabled={!searchResult.matches.length} aria-label="Previous protein search match"><ChevronLeft size={15} />Previous</button>
          <span>{activeMatch ? `${Math.min(activeMatchIndex + 1, searchResult.matches.length)}/${searchResult.matches.length} · ${searchFieldLabel(activeMatch.field)}` : "No active match"}</span>
          <button type="button" onClick={() => moveMatch(1)} disabled={!searchResult.matches.length} aria-label="Next protein search match">Next<ChevronRight size={15} /></button>
        </div>
      </div>

      <ProteinRecord
        protein={protein}
        proteinIndex={boundedProteinIndex}
        visibleSequence={visibleSequence}
        windowStart={boundedWindowStart}
        windowEnd={windowEnd}
        selectedRange={selectedRange}
        activeMatch={activeMatch}
        visibleMatchResidues={visibleMatchResidues}
        rangeStart={rangeStart}
        rangeEnd={rangeEnd}
        rangeError={rangeError}
        selectedSequence={selectedSequence}
        selectedMetrics={selectedMetrics}
        selectedComposition={selectedComposition}
        onRangeStart={setRangeStart}
        onRangeEnd={setRangeEnd}
        onApplyRange={applyRange}
        onMoveWindow={moveWindow}
        onWindowKeyDown={handleWindowKeys}
        canMovePrevious={boundedWindowStart > 0}
        canMoveNext={windowEnd < protein.length}
      />
    </section>
  );
}

interface ProteinRecordProps {
  protein: ProteinViewModel;
  proteinIndex: number;
  visibleSequence: string;
  windowStart: number;
  windowEnd: number;
  selectedRange?: ProteinRange;
  activeMatch?: ProteinSearchMatch;
  visibleMatchResidues: ReadonlySet<number>;
  rangeStart: string;
  rangeEnd: string;
  rangeError?: string;
  selectedSequence?: string;
  selectedMetrics?: ReturnType<typeof calculateProteinMetrics>;
  selectedComposition: Array<[string, number]>;
  onRangeStart(value: string): void;
  onRangeEnd(value: string): void;
  onApplyRange(): void;
  onMoveWindow(direction: -1 | 1): void;
  onWindowKeyDown(event: KeyboardEvent<HTMLDivElement>): void;
  canMovePrevious: boolean;
  canMoveNext: boolean;
}

function ProteinRecord(props: ProteinRecordProps) {
  const {
    protein,
    proteinIndex,
    visibleSequence,
    windowStart,
    windowEnd,
    selectedRange,
    activeMatch,
    visibleMatchResidues,
    rangeStart,
    rangeEnd,
    rangeError,
    selectedSequence,
    selectedMetrics,
    selectedComposition,
    onRangeStart,
    onRangeEnd,
    onApplyRange,
    onMoveWindow,
    onWindowKeyDown,
    canMovePrevious,
    canMoveNext,
  } = props;
  const metrics = protein.metrics;
  const activeStart = activeMatch?.proteinIndex === proteinIndex && activeMatch.field === "sequence" ? activeMatch.start : undefined;
  const activeEnd = activeMatch?.proteinIndex === proteinIndex && activeMatch.field === "sequence" ? activeMatch.end : undefined;

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

      <section className="protein-range-tools" aria-label="Protein residue range processing">
        <div className="inspector-section-title"><span>Residue range</span><small>1-based inclusive · software-derived</small></div>
        <div className="protein-range-form">
          <label><span>Start</span><input type="number" min={1} max={protein.length} step={1} value={rangeStart} onChange={(event) => onRangeStart(event.target.value)} /></label>
          <label><span>End</span><input type="number" min={1} max={protein.length} step={1} value={rangeEnd} onChange={(event) => onRangeEnd(event.target.value)} /></label>
          <button type="button" onClick={onApplyRange}>Validate and apply</button>
        </div>
        {rangeError
          ? <p className="protein-range-error" role="alert">{rangeError}</p>
          : selectedRange && <p className="protein-range-status" role="status">Selected residues {(selectedRange.start + 1).toLocaleString()}–{selectedRange.end.toLocaleString()} ({(selectedRange.end - selectedRange.start).toLocaleString()} aa).</p>}
      </section>

      <div className="protein-sequence-panel">
        <div className="protein-sequence-panel-heading">
          <span>Residue map · software rendering</span>
          <small>{windowStart + 1}–{windowEnd} of {protein.length.toLocaleString()} residues</small>
        </div>
        <div className="protein-window-navigation" aria-label="Residue window navigation">
          <button type="button" onClick={() => onMoveWindow(-1)} disabled={!canMovePrevious}><ChevronLeft size={14} />Previous window</button>
          <span>Window is bounded to {PROTEIN_VISUALIZATION_LIMITS.maxRenderedResidues.toLocaleString()} residues</span>
          <button type="button" onClick={() => onMoveWindow(1)} disabled={!canMoveNext}>Next window<ChevronRight size={14} /></button>
        </div>
        <div
          className="protein-residue-grid"
          role="region"
          tabIndex={0}
          aria-keyshortcuts="Home End PageUp PageDown"
          aria-label={`${protein.id} residues ${windowStart + 1} through ${windowEnd}. Use Page Up, Page Down, Home, or End to move the bounded window.`}
          onKeyDown={onWindowKeyDown}
        >
          {[...visibleSequence].map((residue, localIndex) => {
            const index = windowStart + localIndex;
            const inSelection = Boolean(selectedRange && index >= selectedRange.start && index < selectedRange.end);
            const active = activeStart !== undefined && activeEnd !== undefined && index >= activeStart && index < activeEnd;
            return (
              <span
                className={`protein-residue residue-${residueClass(residue)}${visibleMatchResidues.has(index) ? " is-match" : ""}${active ? " is-active-match" : ""}${inSelection ? " is-selected-range" : ""}`}
                key={`${protein.id}-${index}`}
                title={`${residue} residue ${index + 1}`}
                aria-hidden="true"
              >{residue}</span>
            );
          })}
        </div>
        {(canMovePrevious || canMoveNext) && <p className="protein-sequence-limit">Only this bounded residue window is in the document. The verified IR retains the complete sequence and digest.</p>}
      </div>

      <div className="protein-record-lower-grid">
        <section className="protein-composition" aria-label={`${protein.id} selected-range residue composition`}>
          <div className="inspector-section-title"><span>Selected-range metrics</span><small>software-derived</small></div>
          {selectedMetrics && selectedSequence ? (
            <>
              <dl className="protein-selection-metrics">
                <div><dt>Length</dt><dd>{selectedMetrics.lengthAa.toLocaleString()} aa</dd></div>
                <div><dt>Approx. mass</dt><dd>{formatMass(selectedMetrics.molecularWeightDaApprox)}</dd></div>
                <div><dt>Hydrophobic</dt><dd>{formatFraction(selectedMetrics.hydrophobicFraction)}</dd></div>
                <div><dt>Charged</dt><dd>{formatFraction(selectedMetrics.chargedFraction)}</dd></div>
              </dl>
              <div className="protein-composition-list">
                {selectedComposition.map(([residue, count]) => <div key={residue}><span className={`protein-composition-swatch residue-${residueClass(residue)}`} /> <strong>{residue}</strong><span>{count.toLocaleString()}</span><small>{((count / selectedSequence.length) * 100).toFixed(1)}%</small></div>)}
              </div>
              <label className="protein-extract"><span>Selected sequence extract</span><textarea readOnly rows={4} value={selectedSequence} spellCheck={false} aria-label="Selected protein sequence extract" /></label>
            </>
          ) : <p>Apply a valid range to compute and extract a bounded selection.</p>}
        </section>
        <section className="protein-provenance" aria-label={`${protein.id} source and license`}>
          <div className="inspector-section-title"><span>Evidence & rights</span><small>validated on read</small></div>
          <dl>
            <div><dt>Resource</dt><dd>{protein.resourceId}</dd></div>
            <div><dt>Source</dt><dd>{protein.source.provider} · {protein.source.record_id}</dd></div>
            <div><dt>Release</dt><dd>{protein.source.release} · {protein.source.revision}</dd></div>
            <div><dt>Retrieved</dt><dd>{protein.source.retrieved_at}</dd></div>
            <div><dt>Source URL</dt><dd><code>{protein.source.url}</code></dd></div>
            <div><dt>License</dt><dd>{protein.license.id} · REDISTRIBUTABLE</dd></div>
            <div><dt>Attribution</dt><dd>{protein.license.attribution}</dd></div>
            <div><dt>Safety</dt><dd>{protein.safetyStatus} · {protein.safetyFlags.length} flags</dd></div>
            <div><dt>Evidence</dt><dd>{protein.evidenceRefs.length} retained references</dd></div>
            <div><dt>Organism</dt><dd>{String(protein.organism.name)}{protein.organism.tax_id === undefined ? "" : ` · tax ${String(protein.organism.tax_id)}`}</dd></div>
            <div><dt>Roles</dt><dd>{protein.roleTerms.join(", ")}</dd></div>
            <div><dt>Sequence SHA-256</dt><dd><code>{protein.sequenceSha256}</code></dd></div>
          </dl>
        </section>
      </div>
    </article>
  );
}

function searchFieldLabel(field: ProteinSearchMatch["field"]): string {
  if (field === "source_record") return "source record";
  if (field === "sequence") return "overlapping motif";
  return field;
}

function residueClass(residue: string): string {
  if (HYDROPHOBIC.has(residue)) return "hydrophobic";
  if (BASIC.has(residue)) return "basic";
  if (ACIDIC.has(residue)) return "acidic";
  if (POLAR.has(residue)) return "polar";
  return "special";
}

function formatMass(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(2)} kDa` : `${value.toFixed(1)} Da`;
}

function formatFraction(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}
