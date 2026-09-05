import { useEffect, useMemo, useRef, useState } from "react";
import type { ProteinResidueMapping, ProteinStructureApi, ProteinStructureTarget } from "../shared/protein-structures.ts";
import type { PreparedProteinTracks, ProteinTrackExportReceipt, ProteinTrackStructureContext } from "../shared/protein-track-export.ts";
import { proteinLandscapeRows } from "../shared/protein-landscape.ts";
import type { ProteinRange } from "./protein-sequence.ts";

export function ProteinSequenceTracks({ sequence, mapping, selectedRange, onSelectRange, api, target, structureContext }: {
  sequence: string; mapping?: ProteinResidueMapping; selectedRange?: ProteinRange; onSelectRange(range: ProteinRange): void;
  api?: ProteinStructureApi; target?: ProteinStructureTarget; structureContext?: ProteinTrackStructureContext;
}) {
  const landscape = useMemo(() => proteinLandscapeRows(sequence, mapping), [sequence, mapping]);
  const bins = landscape.bins;
  const rows = landscape.rows.map((row) => ({ ...row, name: row.label, className: row.kind }));
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [receipt, setReceipt] = useState<ProteinTrackExportReceipt>();
  const generation = useRef(0);
  const requestKey = JSON.stringify({ target, selectedRange, structureContext });
  useEffect(() => {
    generation.current += 1; setBusy(false); setError(""); setReceipt(undefined);
    return () => { generation.current += 1; };
  }, [requestKey]);
  const exportTracks = async (format: "svg" | "png") => {
    if (busy || !target || !api?.prepareTracks || !api.exportTracks) return;
    const current = generation.current;
    setBusy(true); setError(""); setReceipt(undefined);
    const request = { target, selectedRange: selectedRange ?? null, structure: structureContext ?? null };
    try {
      const prepared = await api.prepareTracks(request);
      if (current !== generation.current) return;
      const png = format === "png" ? await rasterizeTracks(prepared) : undefined;
      if (current !== generation.current) return;
      const result = await api.exportTracks({ request, format, svgSha256: prepared.svgSha256, ...(png ? { png } : {}) });
      if (current === generation.current) setReceipt(result);
    } catch (cause) { if (current === generation.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (current === generation.current) setBusy(false); }
  };
  return <section className="protein-sequence-tracks" aria-label="Linked protein sequence tracks">
    <header><span className="eyebrow">Sequence landscape</span><span>1 <i /> {sequence.length.toLocaleString()} aa</span>
      <div className="protein-track-export-actions"><button type="button" disabled={busy || !target || !api?.prepareTracks || !api.exportTracks} onClick={() => void exportTracks("svg")}>Export tracks SVG</button>
        <button type="button" disabled={busy || !target || !api?.prepareTracks || !api.exportTracks} onClick={() => void exportTracks("png")}>Export tracks PNG</button></div>
    </header>
    {rows.map((row) => <div className={`protein-track-row track-${row.className}`} key={row.className}><span>{row.name}</span>
      {row.available ? <div className="protein-track-bins" role="group" aria-label={row.name}>
        {bins.map((bin, index) => <button type="button" key={index} tabIndex={index === 0 ? 0 : -1}
          className={selectedRange && selectedRange.start < bin.end && selectedRange.end > bin.start ? "is-selected" : ""}
          title={`${row.name} · ${bin.start + 1}–${bin.end} · ${row.values[index] === null ? "unavailable" : `${Math.round(row.values[index]! * 100)}${row.className === "confidence" ? " / 100" : "%"}`}`}
          aria-label={`${row.name}, residues ${bin.start + 1} through ${bin.end}, ${row.values[index] === null ? "unavailable" : `${Math.round(row.values[index]! * 100)} ${row.className === "confidence" ? "out of 100" : "percent"}`}`}
          onClick={() => onSelectRange({ start: bin.start, end: bin.end })}
          onKeyDown={(event) => {
            const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
            if (step) { event.preventDefault(); const siblings = event.currentTarget.parentElement?.querySelectorAll("button"); siblings?.[Math.min(bins.length - 1, Math.max(0, index + step))]?.focus(); }
          }}><i style={{ height: `${(row.values[index] ?? 0) * 100}%` }} /></button>)}
      </div> : <div className="protein-track-unavailable">{row.className === "coverage" ? "Associate and map a structure to reveal coverage" : "No source-identified prediction confidence"}</div>}
    </div>)}
    <p>Property tracks are sequence-derived fractions per displayed bin. Gaps in structure coverage remain explicit.</p>
    {busy && <p role="status">Preparing and independently reopening the sequence landscape…</p>}
    {error && <p role="alert">{error}</p>}
    {receipt && <div className="protein-track-export-receipt" role="status" aria-label="Protein track export verification"><strong>{receipt.format.toUpperCase()} independently reopened</strong>
      <span>{receipt.width} × {receipt.height} · source and selection recorded · human review required</span><code>{receipt.relativePath}</code></div>}
  </section>;
}

/** Rasterize only the main-generated, digest-bound vector figure at its fixed export size. */
async function rasterizeTracks(prepared: PreparedProteinTracks): Promise<Uint8Array> {
  if (prepared.width !== 1600 || prepared.height !== 620 || prepared.svg.length > 256 * 1024) throw new Error("Unsupported sequence landscape dimensions.");
  const url = URL.createObjectURL(new Blob([prepared.svg], { type: "image/svg+xml" }));
  try {
    const image = new Image(); image.src = url; await image.decode();
    const canvas = document.createElement("canvas"); canvas.width = prepared.width; canvas.height = prepared.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("PNG rendering is unavailable; the SVG figure remains available.");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("PNG rendering failed.")), "image/png"));
    return new Uint8Array(await blob.arrayBuffer());
  } finally { URL.revokeObjectURL(url); }
}
