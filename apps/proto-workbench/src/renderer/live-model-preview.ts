import type { ModelDescriptor } from "../shared/contracts.ts";
import { modelCatalogUnavailable, readModelSnapshot } from "../shared/model-status.ts";

// This same-origin route exists only in the loopback development server.
// It has no model load, unload, inference, or arbitrary proxy capability.
let pending: ReturnType<typeof readModelSnapshot> | undefined;
export function readPreviewModels(): ReturnType<typeof readModelSnapshot> {
  if (pending) return pending;
  pending = (async () => {
    try {
      const response = await fetch("/__proto/lm-studio/models", { cache: "no-store", signal: AbortSignal.timeout(7_000) });
      if (!response.ok) throw new Error(`LM Studio discovery failed (${response.status}).`);
      const snapshot = await response.json();
      if (!Array.isArray(snapshot.models) || typeof snapshot.runtime?.available !== "boolean") throw new Error("Invalid LM Studio discovery response.");
      return { models: snapshot.runtime.available ? snapshot.models as ModelDescriptor[] : [], runtime: snapshot.runtime };
    } catch (error) {
      return { models: [], runtime: modelCatalogUnavailable(error instanceof Error ? error.message : String(error)) };
    }
  })().finally(() => { pending = undefined; });
  return pending;
}
