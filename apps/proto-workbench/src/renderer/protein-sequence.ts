import type { ProteinMetricsViewModel, ProteinViewModel } from "./design-visualization.ts";

export const PROTEIN_VISUALIZATION_LIMITS = Object.freeze({
  maxRenderedResidues: 1_200,
  maxSelectedResidues: 100_000,
  maxInteractiveRecords: 64,
  maxInteractiveTotalResidues: 100_000,
  maxSearchQueryCharacters: 256,
  maxSearchMatches: 500,
});

export interface ProteinRange {
  readonly start: number;
  readonly end: number;
}

export type ProteinSearchField = "id" | "name" | "source_record" | "sequence";

export interface ProteinSearchMatch {
  readonly proteinIndex: number;
  readonly field: ProteinSearchField;
  readonly value: string;
  readonly start?: number;
  readonly end?: number;
}

export interface ProteinSearchResult {
  readonly matches: ProteinSearchMatch[];
  readonly truncated: boolean;
}

const RESIDUE_MASS: Readonly<Record<string, number>> = Object.freeze({
  A: 71.08,
  C: 103.14,
  D: 115.09,
  E: 129.12,
  F: 147.17,
  G: 57.05,
  H: 137.14,
  I: 113.16,
  K: 128.17,
  L: 113.16,
  M: 131.2,
  N: 114.1,
  P: 97.12,
  Q: 128.13,
  R: 156.19,
  S: 87.08,
  T: 101.11,
  V: 99.13,
  W: 186.21,
  Y: 163.17,
});
const HYDROPHOBIC = new Set("AVILMFWY");
const CHARGED = new Set("DEKR");

/** Mirrors proto_agent.protein.protein_metrics for renderer verification. */
export function calculateProteinMetrics(sequence: string): ProteinMetricsViewModel {
  const composition: Record<string, number> = {};
  let knownMass = 0;
  let hydrophobic = 0;
  let charged = 0;
  let ambiguousOrSpecial = 0;
  for (const residue of sequence) {
    composition[residue] = (composition[residue] ?? 0) + 1;
    knownMass += RESIDUE_MASS[residue] ?? 110;
    if (HYDROPHOBIC.has(residue)) hydrophobic += 1;
    if (CHARGED.has(residue)) charged += 1;
    if (RESIDUE_MASS[residue] === undefined) ambiguousOrSpecial += 1;
  }
  const length = sequence.length;
  const rounded = (value: number, digits: number) => Number(value.toFixed(digits));
  return {
    lengthAa: length,
    molecularWeightDaApprox: rounded(Math.max(0, knownMass - (18.015 * Math.max(0, length - 1))), 3),
    composition: Object.fromEntries(Object.entries(composition).sort(([left], [right]) => left.localeCompare(right))),
    hydrophobicFraction: rounded(hydrophobic / length, 6),
    chargedFraction: rounded(charged / length, 6),
    ambiguousOrSpecialFraction: rounded(ambiguousOrSpecial / length, 6),
  };
}

export function validateProteinRange(
  startOneBased: number,
  endOneBasedInclusive: number,
  sequenceLength: number,
): { readonly ok: true; readonly range: ProteinRange } | { readonly ok: false; readonly message: string } {
  if (!Number.isSafeInteger(sequenceLength) || sequenceLength < 1) {
    return { ok: false, message: "The selected protein has no valid residue coordinate range." };
  }
  if (!Number.isSafeInteger(startOneBased) || !Number.isSafeInteger(endOneBasedInclusive)) {
    return { ok: false, message: "Start and end must be whole-number, 1-based residue coordinates." };
  }
  if (startOneBased < 1 || endOneBasedInclusive > sequenceLength || startOneBased > endOneBasedInclusive) {
    return { ok: false, message: `Choose a range from 1 to ${sequenceLength.toLocaleString("en-US")} with start no greater than end.` };
  }
  const selectedLength = endOneBasedInclusive - startOneBased + 1;
  if (selectedLength > PROTEIN_VISUALIZATION_LIMITS.maxSelectedResidues) {
    return {
      ok: false,
      message: `Selection exceeds the ${PROTEIN_VISUALIZATION_LIMITS.maxSelectedResidues.toLocaleString("en-US")}-residue processing limit. Choose a smaller range.`,
    };
  }
  return { ok: true, range: { start: startOneBased - 1, end: endOneBasedInclusive } };
}

export function extractProteinRange(sequence: string, range: ProteinRange): string | undefined {
  if (
    !Number.isSafeInteger(range.start)
    || !Number.isSafeInteger(range.end)
    || range.start < 0
    || range.end <= range.start
    || range.end > sequence.length
    || range.end - range.start > PROTEIN_VISUALIZATION_LIMITS.maxSelectedResidues
  ) return undefined;
  return sequence.slice(range.start, range.end);
}

export function searchProteins(proteins: readonly ProteinViewModel[], rawQuery: string): ProteinSearchResult {
  const query = rawQuery.trim();
  if (!query || query.length > PROTEIN_VISUALIZATION_LIMITS.maxSearchQueryCharacters) {
    return { matches: [], truncated: false };
  }
  const needle = query.toLocaleLowerCase();
  const sequenceNeedle = query.toUpperCase();
  const matches: ProteinSearchMatch[] = [];
  let truncated = false;
  const add = (match: ProteinSearchMatch): boolean => {
    if (matches.length >= PROTEIN_VISUALIZATION_LIMITS.maxSearchMatches) {
      truncated = true;
      return false;
    }
    matches.push(match);
    return true;
  };

  for (let proteinIndex = 0; proteinIndex < proteins.length; proteinIndex += 1) {
    const protein = proteins[proteinIndex];
    for (const [field, value] of [
      ["id", protein.id],
      ["name", protein.name ?? ""],
      ["source_record", protein.source.record_id ?? ""],
    ] as const) {
      if (value.toLocaleLowerCase().includes(needle) && !add({ proteinIndex, field, value })) {
        return { matches, truncated };
      }
    }
  }
  for (let proteinIndex = 0; proteinIndex < proteins.length; proteinIndex += 1) {
    const protein = proteins[proteinIndex];
    let start = protein.sequence.indexOf(sequenceNeedle);
    while (start >= 0) {
      if (!add({ proteinIndex, field: "sequence", value: sequenceNeedle, start, end: start + sequenceNeedle.length })) {
        return { matches, truncated };
      }
      start = protein.sequence.indexOf(sequenceNeedle, start + 1);
    }
  }
  return { matches, truncated };
}
