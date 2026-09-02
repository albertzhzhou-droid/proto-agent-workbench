import {
  Archive,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  FileCheck2,
  FileKey2,
  Fingerprint,
  History,
  ListTree,
  LoaderCircle,
  MessageSquareText,
  Search,
  ShieldAlert,
  ShieldCheck,
  X,
} from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type {
  AgentStage,
  GlobalEvidenceHit,
  GlobalEvidenceKind,
  GlobalEvidenceSearchRequest,
  GlobalEvidenceSearchResult,
  RunLifecycleState,
} from "../shared/contracts.ts";
import { workbenchApi } from "./mock-api.ts";
import { useWorkbenchStore } from "./store.ts";

type StateFilter = "all" | "decisions" | "recovery" | "active" | "complete";

const KIND_FILTERS: Array<{ id: "all" | GlobalEvidenceKind; label: string }> = [
  { id: "all", label: "All evidence" },
  { id: "run", label: "Runs" },
  { id: "event", label: "Events" },
  { id: "artifact", label: "Artifacts" },
  { id: "claim", label: "Claims" },
  { id: "checkpoint", label: "Checkpoints" },
  { id: "approval", label: "Approvals" },
  { id: "comment", label: "Comments" },
];

const STATE_FILTERS: Array<{ id: StateFilter; label: string; states: RunLifecycleState[] }> = [
  { id: "all", label: "Every state", states: [] },
  { id: "decisions", label: "Needs decision", states: ["waiting-tool-approval", "waiting-patch-review", "review-required", "ready-for-approval"] },
  { id: "recovery", label: "Recovery", states: ["failed", "interrupted", "effect-unknown"] },
  { id: "active", label: "Active", states: ["pending", "running", "applying-patch", "validating"] },
  { id: "complete", label: "Complete", states: ["approved", "completed", "cancelled"] },
];

const KIND_ICONS = {
  run: History,
  event: ListTree,
  artifact: FileKey2,
  claim: FileCheck2,
  checkpoint: Fingerprint,
  approval: ShieldAlert,
  comment: MessageSquareText,
} satisfies Record<GlobalEvidenceKind, typeof Search>;

export function GlobalEvidenceSearch({ onClose }: { onClose: () => void }) {
  const openHit = useWorkbenchStore((state) => state.openGlobalEvidenceHit);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<"all" | GlobalEvidenceKind>("all");
  const [stateFilter, setStateFilter] = useState<StateFilter>("all");
  const [stage, setStage] = useState<"all" | AgentStage>("all");
  const [includeArchived, setIncludeArchived] = useState(false);
  const [result, setResult] = useState<GlobalEvidenceSearchResult>();
  const [hits, setHits] = useState<GlobalEvidenceHit[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string>();
  const [activeIndex, setActiveIndex] = useState(0);
  const [filtersOpen, setFiltersOpen] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const requestGeneration = useRef(0);

  const buildRequest = (cursor?: string): GlobalEvidenceSearchRequest => ({
    query,
    kinds: kind === "all" ? undefined : [kind],
    lifecycleStates: STATE_FILTERS.find((item) => item.id === stateFilter)?.states,
    stages: stage === "all" ? undefined : [stage],
    includeArchived,
    limit: 24,
    cursor,
  });

  const runSearch = async (cursor?: string) => {
    const generation = ++requestGeneration.current;
    if (cursor) setLoadingMore(true);
    else setLoading(true);
    setError(undefined);
    try {
      const next = await workbenchApi().runs.searchEvidence(buildRequest(cursor));
      if (generation !== requestGeneration.current) return;
      setResult(next);
      setHits((current) => cursor ? dedupeHits([...current, ...next.hits]) : next.hits);
      if (!cursor) setActiveIndex(0);
    } catch (searchError) {
      if (generation !== requestGeneration.current) return;
      setError(friendlyError(searchError));
      if (!cursor) setHits([]);
    } finally {
      if (generation === requestGeneration.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  };

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void runSearch(), 140);
    return () => window.clearTimeout(timer);
  // runSearch intentionally captures the current bounded filter state.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, kind, stateFilter, stage, includeArchived]);

  const openSelectedHit = async (hit: GlobalEvidenceHit | undefined) => {
    if (!hit) return;
    await openHit(hit);
    onClose();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === "ArrowDown" && hits.length) {
      event.preventDefault();
      setActiveIndex((index) => (index + 1) % hits.length);
      return;
    }
    if (event.key === "ArrowUp" && hits.length) {
      event.preventDefault();
      setActiveIndex((index) => (index - 1 + hits.length) % hits.length);
      return;
    }
    if (event.key === "Enter" && document.activeElement === inputRef.current && hits[activeIndex]) {
      event.preventDefault();
      void openSelectedHit(hits[activeIndex]);
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), select:not([disabled])") ?? [])];
    if (!focusable.length) return;
    const first = focusable[0]!;
    const last = focusable.at(-1)!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="global-evidence-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section ref={dialogRef} className="global-evidence-dialog" role="dialog" aria-modal="true" aria-labelledby="global-evidence-title" onKeyDown={handleKeyDown}>
        <header className="global-evidence-heading">
          <span className="global-evidence-mark" aria-hidden="true"><Search size={17} /></span>
          <div><span className="eyebrow">Trusted visibility</span><h2 id="global-evidence-title">Global evidence</h2><p>Search redacted metadata across accessible run revisions. Results navigate only.</p></div>
          <div className="global-evidence-heading-meta">
            <code title={result?.catalogDigest}>{result ? shortHash(result.catalogDigest) : "Indexing"}</code>
            <button className="icon-button" type="button" onClick={onClose} aria-label="Close Global Evidence"><X size={15} /></button>
          </div>
        </header>

        <div className="global-evidence-searchbar">
          <Search size={16} aria-hidden="true" />
          <input ref={inputRef} value={query} maxLength={160} onChange={(event) => setQuery(event.target.value)} placeholder="Search runs, events, artifacts, claims, digests…" aria-label="Search global evidence" />
          {query && <button type="button" aria-label="Clear evidence search" onClick={() => setQuery("")}><X size={13} /></button>}
          <kbd>Ctrl ⇧ F</kbd>
        </div>

        <div className="global-evidence-filterbar">
          <div className="evidence-kind-filters" role="group" aria-label="Filter evidence type">
            {KIND_FILTERS.map((item) => (
              <button key={item.id} type="button" className={kind === item.id ? "is-active" : ""} aria-pressed={kind === item.id} onClick={() => setKind(item.id)}>
                {item.label}{item.id !== "all" && result ? <span>{result.facets.kinds[item.id]}</span> : null}
              </button>
            ))}
          </div>
          <button className={`evidence-filter-toggle ${filtersOpen ? "is-open" : ""}`} type="button" aria-expanded={filtersOpen} onClick={() => setFiltersOpen((open) => !open)}><ChevronDown size={13} />More filters</button>
        </div>

        {filtersOpen && <div className="global-evidence-secondary-filters">
          <label><span>Run state</span><select value={stateFilter} onChange={(event) => setStateFilter(event.target.value as StateFilter)}>{STATE_FILTERS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
          <label><span>Stage</span><select value={stage} onChange={(event) => setStage(event.target.value as "all" | AgentStage)}><option value="all">Every stage</option><option value="goal">Goal</option><option value="plan">Plan</option><option value="design">Design</option><option value="validate">Validate</option><option value="review">Review</option></select></label>
          <label className="evidence-archive-filter"><input type="checkbox" checked={includeArchived} onChange={(event) => setIncludeArchived(event.target.checked)} /><span><Archive size={13} />Include archived runs</span></label>
          <span className="global-evidence-query-mode">All search words must match · exact IDs rank first</span>
        </div>}

        <div className="global-evidence-summary" role="status" aria-live="polite">
          <span><strong>{result?.totalHits ?? 0}</strong> matches from <strong>{result?.sourceRunCount ?? 0}</strong> runs</span>
          <span>{result ? `${result.indexedItemCount} redacted records indexed` : "Building bounded index…"}</span>
        </div>

        <div className="global-evidence-results" role="listbox" aria-label="Global evidence results">
          {loading && <div className="global-evidence-loading"><LoaderCircle className="spin" size={18} /><strong>Indexing accessible run evidence</strong><span>No files, model, or connector is being opened.</span></div>}
          {!loading && error && <div className="global-evidence-error" role="alert"><CircleAlert size={17} /><div><strong>Search needs a refresh</strong><span>{error}</span></div><button type="button" onClick={() => void runSearch()}>Retry</button></div>}
          {!loading && !error && hits.length === 0 && <div className="global-evidence-empty"><Search size={20} /><strong>No recorded evidence matches</strong><span>Try fewer words or widen the run-state and evidence-type filters.</span></div>}
          {!loading && !error && hits.map((hit, index) => {
            const Icon = KIND_ICONS[hit.kind];
            return (
              <button
                className={`global-evidence-result is-${hit.kind} ${activeIndex === index ? "is-active" : ""}`}
                type="button"
                role="option"
                aria-selected={activeIndex === index}
                key={hit.id}
                onMouseEnter={() => setActiveIndex(index)}
                onFocus={() => setActiveIndex(index)}
                onClick={() => void openSelectedHit(hit)}
              >
                <span className="global-evidence-result-icon" aria-hidden="true"><Icon size={15} /></span>
                <span className="global-evidence-result-copy">
                  <span className="global-evidence-result-title"><strong>{hit.title}</strong><em>{kindLabel(hit.kind)}</em><em className={`binding-${hit.binding}`}>{bindingLabel(hit.binding)}</em></span>
                  <span className="global-evidence-result-summary">{hit.summary}</span>
                  <span className="global-evidence-result-context"><b>{hit.runTitle}</b><span>{hit.stage ?? "run"}</span><span>{hit.status.replaceAll("-", " ")}</span><time>{formatEvidenceTime(hit.occurredAt)}</time>{hit.locator && <code title={hit.locator}>{shortLocator(hit.locator)}</code>}{hit.evidenceDigest && <code title={hit.evidenceDigest}>{shortHash(hit.evidenceDigest)}</code>}</span>
                </span>
                <ChevronRight size={15} />
              </button>
            );
          })}
          {!loading && !error && result?.nextCursor && <button className="global-evidence-load-more" type="button" disabled={loadingMore} onClick={() => void runSearch(result.nextCursor)}>{loadingMore ? <LoaderCircle className="spin" size={13} /> : null}{loadingMore ? "Loading next snapshot page…" : `Load more · ${Math.max(0, result.totalHits - hits.length)} remaining`}</button>}
        </div>

        <footer className="global-evidence-footer">
          <ShieldCheck size={13} /><span>Read-only visibility · approval arguments stay redacted · recorded locators do not claim current file identity.</span>
          <span><kbd>↑↓</kbd> select <kbd>Enter</kbd> open <kbd>Esc</kbd> close</span>
        </footer>
      </section>
    </div>
  );
}

function dedupeHits(hits: GlobalEvidenceHit[]): GlobalEvidenceHit[] {
  return [...new Map(hits.map((hit) => [hit.id, hit])).values()];
}

function friendlyError(error: unknown): string {
  return String(error).replace(/^Error:\s+Error invoking remote method '[^']+':\s*/i, "").replace(/^Error:\s*/i, "").trim();
}

function kindLabel(kind: GlobalEvidenceKind): string {
  return { run: "Run", event: "Event", artifact: "Artifact", claim: "Claim", checkpoint: "Checkpoint", approval: "Approval", comment: "Comment" }[kind];
}

function bindingLabel(binding: GlobalEvidenceHit["binding"]): string {
  return { "content-addressed": "Digest bound", "revision-bound": "Revision bound", "recorded-locator": "Recorded locator" }[binding];
}

function shortHash(value: string): string {
  return value.length > 14 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}

function shortLocator(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : normalized;
}

function formatEvidenceTime(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "Recorded";
}
