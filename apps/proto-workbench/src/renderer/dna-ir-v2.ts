import type { DnaSourceAnnotation } from "../shared/dna-edits.ts";
import { sha256Text } from "./sha256.ts";

const LOCAL_ID = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const DNA = /^[ACGTRYSWKMBDHVN]+$/;
const COMPLEMENT: Record<string, string> = { A: "T", C: "G", G: "C", T: "A", R: "Y", Y: "R", S: "S", W: "W", K: "M", M: "K", B: "V", D: "H", H: "D", V: "B", N: "N" };

export interface DnaPlacement {
  orientation: "forward" | "reverse";
  transform: "identity" | "reverse_complement";
  algorithm: "iupac-dna.v1";
}

export function reverseComplementDna(sequence: string): string {
  if (!DNA.test(sequence)) throw new Error("DNA placement requires uppercase IUPAC DNA.");
  return Array.from(sequence, (base) => COMPLEMENT[base]).reverse().join("");
}

export function normalizeDnaV2Construct(input: Record<string, unknown>): {
  annotations: Array<Record<string, unknown>>;
  sourceAnnotations: DnaSourceAnnotation[];
} {
  if (!Array.isArray(input.parts) || !input.parts.length || input.parts.length > 10_000) throw new Error("DNA v2 requires bounded occurrence parts.");
  const parts = new Map<string, Record<string, unknown>>();
  const sequences: string[] = [];
  let position = 0;
  for (const part of input.parts) {
    if (!record(part) || typeof part.instance_id !== "string" || !LOCAL_ID.test(part.instance_id) || parts.has(part.instance_id)) throw new Error("DNA v2 occurrence IDs must be valid and unique.");
    if (typeof part.sequence !== "string" || !DNA.test(part.sequence)) throw new Error("DNA v2 requires canonical IUPAC sequence bytes.");
    const placement = part.placement;
    if (!record(placement) || !exactKeys(placement, ["orientation", "transform", "algorithm"]) || !["forward", "reverse"].includes(String(placement.orientation)) || placement.algorithm !== "iupac-dna.v1" || placement.transform !== (placement.orientation === "reverse" ? "reverse_complement" : "identity")) throw new Error("DNA v2 placement transform is inconsistent.");
    const source = placement.orientation === "reverse" ? reverseComplementDna(part.sequence) : part.sequence;
    if (part.source_sequence_sha256 !== sha256Text(source) || part.sequence_sha256 !== sha256Text(part.sequence)) throw new Error("DNA v2 source/transformed sequence hash mismatch.");
    if (!Number.isSafeInteger(part.start) || !Number.isSafeInteger(part.end) || part.start !== position || part.end !== position + part.sequence.length) throw new Error("DNA v2 occurrence geometry mismatch.");
    if (![-1, 0, 1].includes(part.source_direction as number) || part.direction !== (part.source_direction as number) * (placement.orientation === "reverse" ? -1 : 1)) throw new Error("DNA v2 biological direction must derive from an explicit source direction, never placement alone.");
    position += part.sequence.length;
    if (position > 2_000_000) throw new Error("DNA v2 sequence exceeds the renderer limit.");
    parts.set(part.instance_id, part);
    sequences.push(part.sequence);
  }
  const sequence = sequences.join("");
  if (input.sequence !== sequence || input.length !== sequence.length || input.sequence_sha256 !== sha256Text(sequence)) throw new Error("DNA v2 assembled sequence or hash mismatch.");
  if (!Array.isArray(input.annotations) || input.annotations.length > 1000) throw new Error("DNA v2 source annotations exceed their bound.");
  const seen = new Set<string>();
  const sourceAnnotations: DnaSourceAnnotation[] = [];
  const annotations = input.annotations.map((annotation) => {
    if (!record(annotation) || !exactKeys(annotation, ["id", "name", "type", "anchors", "origin", "locations"]) || typeof annotation.id !== "string" || !LOCAL_ID.test(annotation.id) || seen.has(annotation.id)) throw new Error("DNA v2 annotation identity is invalid.");
    seen.add(annotation.id);
    if (typeof annotation.name !== "string" || !annotation.name.trim() || annotation.name.length > 256 || /[\u0000-\u001f\u007f]/.test(annotation.name) || typeof annotation.type !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(annotation.type) || annotation.origin !== "user") throw new Error("DNA v2 annotation metadata is invalid.");
    if (!Array.isArray(annotation.anchors) || !annotation.anchors.length || annotation.anchors.length > 64 || !Array.isArray(annotation.locations) || annotation.locations.length !== annotation.anchors.length) throw new Error("DNA v2 annotation anchors/locations are invalid.");
    const seenAnchors = new Set<string>();
    const locations = annotation.anchors.map((anchor, index) => {
      if (!record(anchor) || !exactKeys(anchor, ["instance_id", "start", "end", "direction"]) || typeof anchor.instance_id !== "string" || !parts.has(anchor.instance_id) || !Number.isSafeInteger(anchor.start) || !Number.isSafeInteger(anchor.end) || (anchor.start as number) < 0 || (anchor.end as number) <= (anchor.start as number) || ![-1, 0, 1].includes(anchor.direction as number)) throw new Error("DNA v2 source anchor is invalid.");
      const key = `${anchor.instance_id}:${anchor.start}:${anchor.end}:${anchor.direction}`;
      if (seenAnchors.has(key)) throw new Error("DNA v2 source anchor is duplicated.");
      seenAnchors.add(key);
      const part = parts.get(anchor.instance_id)!;
      const length = (part.sequence as string).length;
      if ((anchor.end as number) > length) throw new Error("DNA v2 source anchor exceeds its occurrence.");
      const reverse = (part.placement as unknown as DnaPlacement).orientation === "reverse";
      const location = { instance_id: anchor.instance_id, start: (part.start as number) + (reverse ? length - (anchor.end as number) : anchor.start as number), end: (part.start as number) + (reverse ? length - (anchor.start as number) : anchor.end as number), direction: (anchor.direction as number) * (reverse ? -1 : 1) };
      const declared = (annotation.locations as unknown[])[index];
      if (!record(declared) || !exactKeys(declared, ["instance_id", "start", "end", "direction"]) || Object.entries(location).some(([key, value]) => declared[key] !== value)) throw new Error("DNA v2 annotation locations disagree with source anchors.");
      return location;
    });
    sourceAnnotations.push({ id: annotation.id, name: annotation.name, type: annotation.type, origin: "user", anchors: annotation.anchors as DnaSourceAnnotation["anchors"] });
    const directions = new Set(locations.map((location) => location.direction));
    const coordinateOrder = [...locations].sort((left, right) => left.start - right.start || left.end - right.end);
    if (coordinateOrder.some((location, index) => index > 0 && location.start < coordinateOrder[index - 1].end)) throw new Error("DNA v2 source annotation spans overlap.");
    const wraps = locations.reduce((count, location, index) => count + (index > 0 && location.start < locations[index - 1].start ? 1 : 0), 0);
    const displayLocations = input.topology === "circular" && wraps <= 1 ? locations : coordinateOrder;
    return { id: annotation.id, name: annotation.name, type: annotation.type, direction: directions.size === 1 ? locations[0].direction : 0, segments: displayLocations.map(({ start, end }) => ({ start, end })) };
  });
  return { annotations, sourceAnnotations };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
