import type { ProteinCameraSnapshot, ProteinStructureViewState } from "./protein-structures.ts";

/** Accept only finite camera fields understood by the viewport, never plugin state. */
export function validateProteinCamera(input: unknown): ProteinCameraSnapshot {
  if (!input || typeof input !== "object") throw new Error("Invalid protein camera snapshot.");
  const value = input as Record<string, unknown>;
  const vector = (name: string): [number, number, number] => {
    const item = value[name];
    if (!Array.isArray(item) || item.length !== 3 || item.some((n) => typeof n !== "number" || !Number.isFinite(n) || Math.abs(n) > 10_000_000)) throw new Error("Invalid protein camera vector.");
    return [...item] as [number, number, number];
  };
  const scalar = (name: string, min: number, max: number) => {
    const item = value[name];
    if (typeof item !== "number" || !Number.isFinite(item) || item < min || item > max) throw new Error(`Invalid protein camera ${name}.`);
    return item;
  };
  if (value.mode !== "perspective" && value.mode !== "orthographic" || typeof value.clipFar !== "boolean") throw new Error("Invalid protein camera mode.");
  const position = vector("position"), target = vector("target"), up = vector("up");
  const direction = position.map((n, index) => n - target[index]);
  const cross = [direction[1] * up[2] - direction[2] * up[1], direction[2] * up[0] - direction[0] * up[2], direction[0] * up[1] - direction[1] * up[0]];
  if (Math.hypot(...direction) < 1e-8 || Math.hypot(...up) < 1e-8 || Math.hypot(...cross) < 1e-8) throw new Error("Degenerate protein camera orientation.");
  const radius = scalar("radius", 0, 10_000_000), radiusMax = scalar("radiusMax", 0, 10_000_000);
  if (radiusMax < radius) throw new Error("Invalid protein camera radius bounds.");
  return { mode: value.mode, clipFar: value.clipFar, position, target, up, radius, radiusMax,
    fov: scalar("fov", 0.001, Math.PI - 0.001), fog: scalar("fog", 0, 100), minNear: scalar("minNear", 0, 1_000_000), minFar: scalar("minFar", 0, 1_000_000) };
}

export function validateProteinViewState(input: unknown, sequenceLength: number, predicted: boolean): ProteinStructureViewState {
  if (!input || typeof input !== "object" || JSON.stringify(input).length > 16_384) throw new Error("Invalid or oversized protein view state.");
  const value = input as ProteinStructureViewState;
  if (!Number.isSafeInteger(value.modelIndex) || value.modelIndex < 0 || value.modelIndex >= 64
    || typeof value.chainId !== "string" || value.chainId.length > 256 || /[\x00-\x1f]/.test(value.chainId)
    || !["cartoon", "ball-and-stick", "molecular-surface"].includes(value.representation)
    || !["chain", "residue", "confidence"].includes(value.color) || (value.color === "confidence" && !predicted)) throw new Error("Invalid protein view options.");
  const range = value.selectedRange;
  if (range !== null && (!range || !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < 0 || range.end <= range.start || range.end > sequenceLength)) throw new Error("Protein view selection exceeds the bound sequence.");
  if (value.explicitStartOneBased !== null && (!Number.isSafeInteger(value.explicitStartOneBased) || value.explicitStartOneBased < 1 || value.explicitStartOneBased > sequenceLength)) throw new Error("Invalid explicit protein fragment position.");
  return { modelIndex: value.modelIndex, chainId: value.chainId, representation: value.representation, color: value.color,
    selectedRange: range ? { start: range.start, end: range.end } : null, explicitStartOneBased: value.explicitStartOneBased, camera: validateProteinCamera(value.camera) };
}
