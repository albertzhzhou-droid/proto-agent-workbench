import type { ModelDescriptor, RuntimeStatus } from "./contracts.ts";

export const MODEL_REFRESH_MS = 5_000;
export const MODEL_ENDPOINT = "http://127.0.0.1:1234";

/** A saved selection or binding alone cannot prove an instance is still loaded. */
export function isModelConnected(model: ModelDescriptor): boolean {
  return Boolean(model.workbenchInstance && ["active", "warm"].includes(model.loadState)
    && model.loadedInstances?.some(instance => instance.id === model.workbenchInstance?.id));
}

export function modelCatalogStatus(models: ModelDescriptor[], checkedAt = new Date().toISOString()): RuntimeStatus {
  const loadedModelCount = models.reduce((count, model) => count + (model.loadedInstances?.length ?? 0), 0);
  return { available: true, provider: "lmstudio", endpoint: MODEL_ENDPOINT, checkedAt,
    modelCount: models.length, loadedModelCount,
    detail: `LM Studio Server is reachable; ${models.length} catalog models and ${loadedModelCount} loaded instances.` };
}

export function modelCatalogUnavailable(detail: string): RuntimeStatus {
  return { available: false, provider: "lmstudio", endpoint: MODEL_ENDPOINT,
    checkedAt: new Date().toISOString(), modelCount: 0, loadedModelCount: 0, detail };
}

/** One response supplies inventory and status; failures never retain an old catalog. */
export async function readModelSnapshot(scan: () => Promise<ModelDescriptor[]>): Promise<{ models: ModelDescriptor[]; runtime: RuntimeStatus }> {
  try {
    const models = await scan();
    return { models, runtime: modelCatalogStatus(models) };
  } catch (error) {
    return { models: [], runtime: modelCatalogUnavailable(error instanceof Error ? error.message : String(error)) };
  }
}
