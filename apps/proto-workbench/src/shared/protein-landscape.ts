import type { ProteinResidueMapping } from "./protein-structures.ts";
import type { ProteinTrackMetadata, ProteinTrackRow } from "./protein-track-export.ts";
import { proteinPropertyBins } from "../renderer/protein-sequence.ts";

export function proteinLandscapeRows(sequence: string, mapping?: ProteinResidueMapping): { bins: Array<{ start: number; end: number }>; rows: ProteinTrackRow[] } {
  const bins = proteinPropertyBins(sequence, 80);
  const mapped = new Map(mapping?.positions.map((item) => [item.proteinIndex, item.residue]) ?? []);
  const values = bins.map((bin) => {
    let observed = 0, confidence = 0, scores = 0;
    for (let index = bin.start; index < bin.end; index += 1) {
      const residue = mapped.get(index);
      if (residue) observed += 1;
      if (residue?.confidence !== null && residue?.confidence !== undefined) { confidence += residue.confidence; scores += 1; }
    }
    return { coverage: observed / (bin.end - bin.start), confidence: scores ? confidence / scores / 100 : null };
  });
  return { bins: bins.map(({ start, end }) => ({ start, end })), rows: [
    { label: "Hydrophobic residues", kind: "hydrophobic", color: "#7da379", values: bins.map((bin) => bin.hydrophobic), available: true },
    { label: "Charged residues", kind: "charged", color: "#a3a0c9", values: bins.map((bin) => bin.charged), available: true },
    { label: "Observed structure", kind: "coverage", color: "#70a9a6", values: values.map((bin) => bin.coverage), available: !!mapping && mapping.status !== "unmapped" },
    { label: "Prediction pLDDT", kind: "confidence", color: "#77a1d5", values: values.map((bin) => bin.confidence), available: values.some((bin) => bin.confidence !== null) },
  ] };
}

const escaped = (value: string) => value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]!);

/** Fixed-size vector figure constructed from verified numbers and escaped text only. */
export function renderProteinLandscapeSvg(metadata: ProteinTrackMetadata): { svg: string; width: number; height: number } {
  const width = 1600, height = 620, left = 280, plotWidth = 1260;
  const pieces = [`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Protein sequence landscape">`,
    `<metadata id="proto-protein-track-metadata">${escaped(JSON.stringify(metadata))}</metadata>`,
    `<rect width="1600" height="620" fill="#f8fbf8"/>`,
    `<g font-family="Arial, sans-serif" fill="#203e33"><text x="48" y="55" font-size="28" font-weight="600">Protein sequence landscape</text>`,
    `<text x="48" y="87" font-size="18">${escaped(metadata.proteinName.slice(0, 100))} · ${escaped(metadata.proteinId)} · ${metadata.length} aa</text>`,
    `<text x="48" y="115" font-size="14" fill="#526c5d">${metadata.selectedRange ? `Selected residues ${metadata.selectedRange.start + 1}–${metadata.selectedRange.end}` : "No active residue selection"} · Software-derived properties · scientific review required</text>`];
  metadata.rows.forEach((row, rowIndex) => {
    const top = 155 + rowIndex * 80;
    pieces.push(`<text x="48" y="${top + 25}" font-size="18">${escaped(row.label)}</text>`, `<text x="48" y="${top + 45}" font-size="12" fill="#617567">${row.kind === "confidence" ? "Mean source-identified score / 100" : "Fraction of residues per interval"}</text>`);
    if (!row.available) {
      pieces.push(`<rect x="${left}" y="${top}" width="${plotWidth}" height="48" fill="#e8ede7" rx="3"/><text x="${left + 16}" y="${top + 29}" font-size="14" fill="#5d6d62">${row.kind === "coverage" ? "No verified residue mapping associated" : "No source-identified prediction confidence"}</text>`);
      return;
    }
    metadata.bins.forEach((bin, index) => {
      const x = left + bin.start / metadata.length * plotWidth;
      const binWidth = Math.max(.5, (bin.end - bin.start) / metadata.length * plotWidth - 1);
      const value = row.values[index];
      pieces.push(`<rect x="${x.toFixed(3)}" y="${top}" width="${binWidth.toFixed(3)}" height="48" fill="#e5ece1"/>`);
      if (value !== null && value > 0) pieces.push(`<rect x="${x.toFixed(3)}" y="${(top + 48 - value * 48).toFixed(3)}" width="${binWidth.toFixed(3)}" height="${(value * 48).toFixed(3)}" fill="${row.color}"/>`);
      if (metadata.selectedRange && metadata.selectedRange.start < bin.end && metadata.selectedRange.end > bin.start) pieces.push(`<rect x="${x.toFixed(3)}" y="${top}" width="${binWidth.toFixed(3)}" height="48" fill="none" stroke="#334f3c" stroke-width="1"/>`);
    });
  });
  pieces.push(`<text x="${left}" y="486" font-size="13">1</text><text x="1540" y="486" font-size="13" text-anchor="end">${metadata.length} aa</text>`,
    `<text x="48" y="526" font-size="13">${escaped(metadata.structure ? `${metadata.structure.attachment.label} · ${metadata.structure.attachment.source.classification} · ${metadata.structure.mappingStatus} · ${metadata.structure.observedResidues} observed residues` : "Sequence-only figure · no structure attachment is required")}</text>`,
    `<text x="48" y="552" font-size="12" fill="#617567">${escaped(metadata.structure?.mappingReason ?? "Property tracks are sequence-derived; missing structural evidence remains explicit.").slice(0, 185)}</text>`,
    `<text x="48" y="578" font-family="monospace" font-size="11">Protein SHA-256 ${metadata.sequenceSha256}</text><text x="48" y="600" font-family="monospace" font-size="11">Artifact SHA-256 ${metadata.artifactSha256}</text></g></svg>`);
  return { svg: pieces.join(""), width, height };
}
