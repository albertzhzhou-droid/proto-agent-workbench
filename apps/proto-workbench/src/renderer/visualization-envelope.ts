export const VISUALIZATION_INTERACTIVE_LIMITS = Object.freeze({
  maxBases: 10_000,
  maxFeatures: 750,
  maxAccessibleRows: 500,
});

export interface VisualizationEnvelopeResult {
  readonly mode: "interactive" | "summary";
  readonly reasons: string[];
}

export function classifyVisualizationEnvelope(length: number, featureCount: number): VisualizationEnvelopeResult {
  const reasons: string[] = [];
  if (!Number.isSafeInteger(length) || length < 0) reasons.push("Sequence length is invalid.");
  else if (length > VISUALIZATION_INTERACTIVE_LIMITS.maxBases) {
    reasons.push(`Sequence length exceeds the ${VISUALIZATION_INTERACTIVE_LIMITS.maxBases.toLocaleString("en-US")} bp interactive limit.`);
  }
  if (!Number.isSafeInteger(featureCount) || featureCount < 0) reasons.push("Feature count is invalid.");
  else if (featureCount > VISUALIZATION_INTERACTIVE_LIMITS.maxFeatures) {
    reasons.push(`Feature count exceeds the ${VISUALIZATION_INTERACTIVE_LIMITS.maxFeatures.toLocaleString("en-US")} interactive limit.`);
  }
  return { mode: reasons.length ? "summary" : "interactive", reasons };
}
