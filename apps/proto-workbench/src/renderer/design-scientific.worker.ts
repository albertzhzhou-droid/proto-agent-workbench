import { computeScientific, type ScientificRequest, type ScientificResponse } from "./design-scientific.ts";

const scope = self as unknown as { onmessage: ((event: MessageEvent<ScientificRequest>) => void) | null; postMessage(message: ScientificResponse): void };
scope.onmessage = ({ data }) => {
  if (!Number.isSafeInteger(data.id) || typeof data.artifactIdentity !== "string") return;
  const binding = { id: data.id, artifactIdentity: data.artifactIdentity, kind: data.kind };
  try {
    scope.postMessage({ ...binding, result: computeScientific(data.kind, data.input) } as ScientificResponse);
  } catch (error) {
    scope.postMessage({ ...binding, error: error instanceof Error ? error.message : "Scientific computation failed." } as ScientificResponse);
  }
};
