import type { ModelDescriptor } from "../shared/contracts.ts";

/** Catalog maxima and memory telemetry are not the connected execution context. */
export function connectedContext(model: ModelDescriptor): number | undefined {
  const binding = model.workbenchInstance;
  if (!binding || !["active", "warm"].includes(model.loadState)) return undefined;
  const observed = binding.contextLength
    ?? model.loadedInstances?.find((instance) => instance.id === binding.id)?.contextLength;
  return Number.isSafeInteger(observed) && observed! > 0 ? observed : undefined;
}

export function modelContextLabel(model: ModelDescriptor): string {
  const actual = connectedContext(model);
  if (actual) return `${actual.toLocaleString("en-US")} loaded`;
  if (model.workbenchInstance) return "Loaded context awaiting refresh";
  return `${model.contextLength.toLocaleString("en-US")} max context`;
}

/** Only changes relevant to the selected launch binding invalidate a review. */
export function modelPreflightIdentity(models: ModelDescriptor[], modelId?: string): string {
  const model = models.find((candidate) => modelId ? candidate.id === modelId : candidate.loadState === "active");
  if (!model) return "missing";
  return JSON.stringify({
    id: model.id, fingerprint: model.fingerprint, loadState: model.loadState,
    toolCapability: model.toolCapability, vision: model.vision,
    instanceId: model.workbenchInstance?.id ?? null,
    owned: model.workbenchInstance?.ownedByWorkbench ?? null,
    context: connectedContext(model) ?? null,
  });
}
