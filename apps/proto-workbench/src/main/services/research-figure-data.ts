import type { ComputeStudyOpenedRun } from "../../shared/compute-studies.ts";
import type { FigurePanelDraft, FigurePanelView, FigurePoint, FigureSelector, FigureSeries, ResearchFigure } from "../../shared/research-figures.ts";

/** Projection only: never coerce, omit, sort, aggregate, interpolate or infer units. */
export const FIGURE_DATA_LIMITS = { candidates: 256, depth: 8, discoveryNodes: 20000, panelPoints: 5000, boardPoints: 20000 } as const;
const forbidden = new Set(["__proto__", "prototype", "constructor"]);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const escapeSegment = (value: string) => value.replaceAll("~", "~0").replaceAll("/", "~1");
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

function pointerSegments(pointer: string): string[] {
  if (typeof pointer !== "string" || pointer.length > 512 || (pointer !== "" && !pointer.startsWith("/"))) throw new Error("Use a JSON pointer of at most 512 characters.");
  if (pointer === "") return [];
  return pointer.slice(1).split("/").map(segment => {
    if (/~(?:[^01]|$)/.test(segment)) throw new Error("JSON pointer escapes must be ~0 or ~1.");
    const decoded = segment.replaceAll("~1", "/").replaceAll("~0", "~");
    if (forbidden.has(decoded)) throw new Error("Prototype paths cannot be used as figure selectors.");
    return decoded;
  });
}

function own(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") throw new Error("The selected JSON pointer does not exist.");
  if (Array.isArray(value) && (!/^(?:0|[1-9]\d*)$/.test(key) || !Number.isSafeInteger(Number(key)) || Number(key) >= value.length)) throw new Error("JSON array pointers require an existing canonical index.");
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !("value" in descriptor)) throw new Error("The selected JSON pointer is missing or is not a JSON data property.");
  return descriptor.value;
}

function resolvePointer(root: unknown, segments: string[]): unknown {
  let value = root;
  for (const segment of segments) value = own(value, segment);
  return value;
}

function verified(run: ComputeStudyOpenedRun): void {
  if (run.integrity.status !== "verified" || !run.request || !run.receipt || run.receipt.ok !== true || run.receipt.preview === true || !record(run.receipt.result)) throw new Error("Figure data requires a verified retained Compute result.");
  if ((run.receipt.run_id !== undefined && run.receipt.run_id !== run.runId) || (run.receipt.tool !== undefined && run.receipt.tool !== run.request.tool)) throw new Error("The saved input and result identities do not correspond.");
}

function values(run: ComputeStudyOpenedRun, selector: FigureSelector): unknown[] {
  if (selector.from !== "input" && selector.from !== "result") throw new Error("Figure selectors must refer to saved input or result data.");
  const root = selector.from === "input" ? run.request!.arguments : run.receipt!.result;
  const selected = resolvePointer(root, pointerSegments(selector.pointer));
  if (!Array.isArray(selected)) {
    if (selector.field !== undefined) throw new Error("A column selector requires an array.");
    if (!finite(selected)) throw new Error("Select a numeric measurement or a non-empty data array.");
    return [selected];
  }
  if (selected.length < 1 || selected.length > FIGURE_DATA_LIMITS.panelPoints) throw new Error("A figure panel requires between 1 and 5,000 points; no points were omitted.");
  const field = selector.field === undefined ? undefined : pointerSegments(selector.field);
  return Array.from({ length: selected.length }, (_, index) => {
    const item = own(selected, String(index));
    return field === undefined ? item : resolvePointer(item, field);
  });
}

export function selectFigurePoints(run: ComputeStudyOpenedRun, panel: FigurePanelDraft): FigurePoint[] {
  verified(run);
  if (panel.runId !== run.runId) throw new Error("This panel selects a different saved run.");
  if (!["line", "scatter", "bar"].includes(panel.kind)) throw new Error("Unsupported figure plot kind.");
  const y = values(run, panel.y);
  if (!y.every(finite)) throw new Error("Y values must all be finite numbers; null, missing, string and non-finite values are not omitted or converted.");
  const x = panel.x ? values(run, panel.x) : y.map((_, index) => index + 1);
  if (x.length !== y.length) throw new Error("X and Y must have identical lengths; no points were omitted.");
  const numericX = x.every(finite), categoricalX = x.every(item => typeof item === "string");
  if (!numericX && !(panel.kind === "bar" && categoricalX)) throw new Error("Line and scatter plots require finite numeric X values; bar plots also accept a complete string category array.");
  return y.map((value, index) => ({ x: x[index] as number | string, y: value as number }));
}

/** Bounded suggestions. Every offered column is checked in full, without filtering rows. */
export function discoverFigureSeries(run: ComputeStudyOpenedRun): { series: FigureSeries[]; truncated: boolean } {
  verified(run);
  const series: FigureSeries[] = [];
  let nodes = 0, truncated = false, exhausted = false;
  const tick = () => { if (++nodes > FIGURE_DATA_LIMITS.discoveryNodes) { truncated = true; exhausted = true; return false; } return true; };
  const add = (from: FigureSelector["from"], pointer: string, length: number, kind: FigureSeries["kind"], field?: string) => {
    if (pointer.length > 512 || (field?.length ?? 0) > 512 || series.length >= FIGURE_DATA_LIMITS.candidates) { truncated = true; return; }
    series.push({ selector: { from, pointer, ...(field === undefined ? {} : { field }) }, label: `${from === "input" ? "Saved input" : "Saved result"} ${pointer || "(root)"}${field === undefined ? "" : ` · column ${field || "(item)"}`}`, length, kind });
  };
  const read = (value: unknown, key: string): unknown => {
    if (!tick()) throw new Error("Discovery budget reached.");
    return own(value, key);
  };
  const column = (rows: unknown[], segments: string[]): FigureSeries["kind"] | undefined => {
    let kind: FigureSeries["kind"] | undefined;
    for (let index = 0; index < rows.length; index++) {
      let value: unknown;
      try { value = read(rows, String(index)); for (const key of segments) value = read(value, key); } catch { return undefined; }
      const next = finite(value) ? "numeric" : typeof value === "string" ? "categorical" : undefined;
      if (!next || (kind !== undefined && kind !== next)) return undefined;
      kind = next;
    }
    return kind;
  };
  const visitColumns = (rows: unknown[], first: unknown, from: FigureSelector["from"], pointer: string, field: string, segments: string[], depth: number): void => {
    if (exhausted) return;
    if (finite(first) || typeof first === "string") {
      const kind = column(rows, segments);
      if (kind) add(from, pointer, rows.length, kind, field);
      return;
    }
    if (!record(first)) return;
    const keys = Object.keys(first);
    if (depth >= FIGURE_DATA_LIMITS.depth) { if (keys.length) truncated = true; return; }
    for (const key of keys) {
      if (forbidden.has(key)) continue;
      let child: unknown;
      try { child = read(first, key); } catch { if (exhausted) return; continue; }
      visitColumns(rows, child, from, pointer, `${field}/${escapeSegment(key)}`, [...segments, key], depth + 1);
      if (exhausted || series.length >= FIGURE_DATA_LIMITS.candidates) { truncated = true; return; }
    }
  };
  const visit = (value: unknown, from: FigureSelector["from"], pointer: string, depth: number): void => {
    if (exhausted || !tick()) return;
    if (finite(value)) { add(from, pointer, 1, "numeric"); return; }
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      if (value.length === 0) return;
      if (value.length > FIGURE_DATA_LIMITS.panelPoints) { truncated = true; return; }
      const direct = column(value, []);
      if (direct) { add(from, pointer, value.length, direct); return; }
      if (exhausted) return;
      let first: unknown;
      try { first = read(value, "0"); } catch { return; }
      if (record(first)) { visitColumns(value, first, from, pointer, "", [], depth + 1); return; }
      // A matrix can offer each complete row; a mixed invalid scalar array must
      // never turn into a filtered sequence of individual scalar candidates.
      if (Array.isArray(first)) {
        if (depth >= FIGURE_DATA_LIMITS.depth) { truncated = true; return; }
        for (let index = 0; index < value.length; index++) {
          let row: unknown;
          try { row = read(value, String(index)); } catch { if (exhausted) return; continue; }
          if (Array.isArray(row)) visit(row, from, `${pointer}/${index}`, depth + 1);
          if (exhausted || series.length >= FIGURE_DATA_LIMITS.candidates) { truncated = true; return; }
        }
      }
      return;
    }
    const keys = Object.keys(value);
    if (depth >= FIGURE_DATA_LIMITS.depth) { if (keys.length) truncated = true; return; }
    for (const key of keys) {
      if (forbidden.has(key)) continue;
      let child: unknown;
      try { child = read(value, key); } catch { if (exhausted) return; continue; }
      visit(child, from, `${pointer}/${escapeSegment(key)}`, depth + 1);
      if (exhausted || series.length >= FIGURE_DATA_LIMITS.candidates) { truncated = true; return; }
    }
  };
  visit(run.request!.arguments, "input", "", 0);
  if (!exhausted && series.length < FIGURE_DATA_LIMITS.candidates) visit(run.receipt!.result, "result", "", 0);
  else truncated = true;
  return { series, truncated };
}

const savedMetadataKeys = ["schema_version", "created_at", "tool", "run_id", "implementation", "implementation_version", "upstream_commit", "upstream_functions", "method_references", "runtime", "review_status", "scope", "maturity"] as const;
const jsonCopy = <T>(value: T): T => structuredClone(value);
// Values are code spans/blocks: no supplied HTML or reference URL becomes an
// executable HTML fragment or an uncontrolled Markdown link.
function code(value: unknown): string {
  const text = JSON.stringify(value) ?? "not recorded";
  const length = Math.max(0, ...Array.from(text.matchAll(/`+/g), match => match[0].length));
  const fence = "`".repeat(length + 1);
  return `${fence} ${text} ${fence}`;
}
function jsonBlock(value: unknown): string {
  const text = JSON.stringify(value, null, 2);
  const length = Math.max(2, ...Array.from(text.matchAll(/`+/g), match => match[0].length));
  const fence = "`".repeat(length + 1);
  return `${fence}json\n${text}\n${fence}`;
}

export function buildFigureMethods(figure: ResearchFigure, study: { id: string; name: string; question: string; revision: number }, runs: ComputeStudyOpenedRun[], views: FigurePanelView[]): { methodsMarkdown: string; methods: Record<string, unknown> } {
  if (figure.studyId !== study.id) throw new Error("The figure belongs to a different research project.");
  if (new Set(runs.map(run => run.runId)).size !== runs.length || new Set(views.map(view => view.id)).size !== views.length) throw new Error("Duplicate saved run or panel inspection identities.");
  if (figure.panels.length > 6 || new Set(figure.panels.map(panel => panel.id)).size !== figure.panels.length) throw new Error("A figure requires at most six distinct panels.");
  const runMap = new Map(runs.map(run => [run.runId, run])), viewMap = new Map(views.map(view => [view.id, view]));
  let pointCount = 0;
  for (const panel of figure.panels) {
    const points = viewMap.get(panel.id)?.points;
    if (!points) continue;
    if (points.length > FIGURE_DATA_LIMITS.panelPoints || points.some(point => !finite(point.y) || (!finite(point.x) && typeof point.x !== "string"))) throw new Error("Panel inspection contains invalid or excessive points.");
    pointCount += points.length;
  }
  if (pointCount > FIGURE_DATA_LIMITS.boardPoints) throw new Error("A figure supports at most 20,000 total points; no points were omitted.");
  const selectedRunIds = [...new Set(figure.panels.map(panel => panel.runId))];
  const runMethods = selectedRunIds.map(runId => {
    const run = runMap.get(runId);
    const usable = run && run.integrity.status === "verified" && run.receipt?.ok === true && run.receipt.preview !== true && run.request !== undefined;
    const metadata: Record<string, unknown> = {};
    if (usable) for (const key of savedMetadataKeys) if (Object.hasOwn(run.receipt!, key)) metadata[key] = jsonCopy(run.receipt![key]);
    return {
      runId, availability: usable ? "verified-retained-artifacts" : "unavailable-for-methods",
      inputSnapshot: usable ? jsonCopy(run.request!) : null,
      savedMethodMetadata: metadata,
      maturityRecorded: usable && Object.hasOwn(run.receipt!, "maturity"),
      originalInputReferences: usable ? { source: jsonCopy(run.receipt!.source ?? null), inputs: jsonCopy(run.receipt!.inputs ?? null) } : null,
      artifactIntegrity: run ? jsonCopy(run.integrity) : null,
      currentSourceFreshness: run ? jsonCopy(run.sourceFreshness) : null,
    };
  });
  const panelMethods = figure.panels.map((panel, index) => {
    const view = viewMap.get(panel.id);
    return {
      id: panel.id, order: index + 1, runId: panel.runId, title: panel.title, kind: panel.kind,
      binding: jsonCopy(panel.binding), selection: { y: jsonCopy(panel.y), x: panel.x ? jsonCopy(panel.x) : null },
      axes: { x: { label: panel.xLabel, unit: panel.xUnit }, y: { label: panel.yLabel, unit: panel.yUnit }, provenance: "user-authored; units are labels and no unit conversion is performed" },
      semantics: { order: "saved array order", x: panel.x ? "selected saved values" : "one-based point index", line: panel.kind === "line" ? "straight connections in saved array order; no resampling or fitted model" : null, bar: panel.kind === "bar" ? "one positional bar per saved point in original order; X values are tick labels, not numeric distances; repeated labels remain distinct" : null, missingValues: "reject entire selection; never drop or impute", transformation: "none", aggregation: "none", errorBars: "none", statisticalInference: "none" },
      inspection: view ? { status: view.status, message: view.message, pointCount: view.points?.length ?? null, sourceFreshness: jsonCopy(view.sourceFreshness ?? null) } : { status: "unavailable", message: "No panel inspection was supplied.", pointCount: null, sourceFreshness: null },
    };
  });
  const methods = {
    schemaVersion: "proto.research-figure-methods.v1", basis: "saved original Compute inputs and method metadata; no current catalog lookup",
    authority: "Unsigned local artifact integrity does not establish independent execution, scientific validation or correctness of user-authored labels.",
    study: jsonCopy(study), figure: { id: figure.id, studyId: figure.studyId, revision: figure.revision, createdAt: figure.createdAt, updatedAt: figure.updatedAt, change: figure.change, title: figure.title, caption: figure.caption, columns: figure.columns, textProvenance: "user-authored" },
    pointCount, panels: panelMethods, runs: runMethods,
  };
  const lines = ["# Figure methods", "", "This draft describes retained inputs, saved method metadata and explicit plot selections. Review it before publication. Matching unsigned local artifact bytes does not establish independent execution or scientific validity.", "",
    `- Project: ${code(study.name)}; revision ${study.revision}; ID ${code(study.id)}.`,
    `- Research question (user-authored): ${code(study.question)}.`,
    `- Figure title (user-authored): ${code(figure.title)}.`,
    `- Caption (user-authored): ${code(figure.caption)}.`,
    `- Figure ID: ${code(figure.id)}; revision ${figure.revision}; columns ${figure.columns}.`,
    "", "Labels and units are user-authored annotations. No unit conversion, row filtering, aggregation, fitting, error bars or statistical inference is performed. Array order is preserved; a missing X selector uses the one-based point index. Lines connect points in that order and do not represent a fitted model. Bar plots use one positional bar per saved point: X values label ticks rather than numeric distances, and repeated labels remain distinct."];
  panelMethods.forEach((panel, index) => {
    lines.push("", `## Panel ${index + 1}`, "", `- Title (user-authored): ${code(panel.title)}.`, `- Plot: ${code(panel.kind)}; saved run ${code(panel.runId)}.`, `- X selection: ${panel.selection.x ? code(panel.selection.x) : "one-based point index"}.`, `- Y selection: ${code(panel.selection.y)}.`, `- X label / unit (user-authored): ${code(panel.axes.x)}.`, `- Y label / unit (user-authored): ${code(panel.axes.y)}.`, `- Inspection: ${code(panel.inspection.status)}; ${code(panel.inspection.message)}; point count ${code(panel.inspection.pointCount)}.`, "- Original artifact binding:", "", jsonBlock(panel.binding));
  });
  runMethods.forEach((run, index) => {
    lines.push("", `## Saved run ${index + 1}`, "", `- Run ID: ${code(run.runId)}.`, `- Availability: ${code(run.availability)}.`, `- Saved maturity: ${run.maturityRecorded ? "recorded exactly below; no promotion is inferred from plotting or artifact integrity" : "not recorded; no method or scientific maturity is inferred"}.`, `- Current original-source freshness: ${code(run.currentSourceFreshness?.status ?? "not checked")}.`);
    const sections: Array<[string, unknown, string]> = [["Saved method metadata", run.savedMethodMetadata, "savedMethodMetadata"], ["Full original saved input", run.inputSnapshot, "inputSnapshot"], ["Original input references and consumed-file hashes", run.originalInputReferences, "originalInputReferences"], ["Artifact integrity check", run.artifactIntegrity, "artifactIntegrity"], ["Current original-source checks", run.currentSourceFreshness, "currentSourceFreshness"]];
    for (const [title, value, key] of sections) {
      const serialized = JSON.stringify(value, null, 2);
      lines.push("", `### ${title}`, "");
      if (serialized.length <= 6000) lines.push(jsonBlock(value));
      else lines.push(`The complete value (${serialized.length} JSON characters) is retained in methods.json at ${code(`/runs/${index}/${key}`)}. It is not abbreviated in that structured file; this Markdown section does not reproduce it.`);
    }
    const references = run.savedMethodMetadata.method_references;
    if (Array.isArray(references) && references.length) {
      lines.push("", "### References recorded by the original method", "", "These reference strings are copied from the saved run. They were not fetched or independently reviewed for this figure.", "");
      references.forEach((reference, referenceIndex) => lines.push(`${referenceIndex + 1}. ${code(reference)}`));
    }
  });
  return { methodsMarkdown: `${lines.join("\n")}\n`, methods };
}
