import type { ModelDescriptor, ModelInstance, ResidencyPolicy } from "../../shared/contracts.ts";

export const GIB = 1024 ** 3;

export function defaultVramBudget(totalBytes: number): number {
  return Math.max(0, Math.min(totalBytes * 0.9, totalBytes - 2 * GIB));
}

export function selectEvictions(
  models: ModelDescriptor[],
  instances: ModelInstance[],
  policy: ResidencyPolicy,
  requiredBytes: number,
  targetModelId: string,
): string[] {
  const modelById = new Map(models.map((model) => [model.id, model]));
  const residents = instances.filter(
    (instance) => instance.state === "active" || instance.state === "warm" || instance.state === "loading",
  );
  const used = residents.reduce(
    (sum, instance) => {
      const model = modelById.get(instance.modelId);
      return sum + (model?.measuredVramBytes ?? model?.estimatedVramBytes ?? 0);
    },
    0,
  );
  let needed = Math.max(0, used + requiredBytes - policy.budgetBytes);
  if (needed === 0) return [];

  const candidates = residents
    .filter(
      (instance) =>
        instance.modelId !== targetModelId &&
        !policy.pinnedModelIds.includes(instance.modelId) &&
        !modelById.get(instance.modelId)?.pinned,
    )
    .sort((left, right) => {
      if (left.state !== right.state) return left.state === "warm" ? -1 : 1;
      const leftTime = Date.parse(left.lastUsedAt || left.startedAt || "1970-01-01");
      const rightTime = Date.parse(right.lastUsedAt || right.startedAt || "1970-01-01");
      return leftTime - rightTime;
    });

  const evictions: string[] = [];
  for (const candidate of candidates) {
    evictions.push(candidate.modelId);
    const model = modelById.get(candidate.modelId);
    needed -= model?.measuredVramBytes ?? model?.estimatedVramBytes ?? 0;
    if (needed <= 0) break;
  }
  // Return every eligible candidate even when the target alone is larger than
  // the pool budget. The caller can then distinguish an oversized target from
  // a genuinely pinned resident that blocks the load.
  return evictions;
}

export function expiredWarmModels(
  instances: ModelInstance[],
  policy: ResidencyPolicy,
  now = Date.now(),
): string[] {
  const ttl = policy.warmTtlMinutes * 60_000;
  return instances
    .filter((instance) => instance.state === "warm" && instance.lastUsedAt)
    .filter((instance) => now - Date.parse(instance.lastUsedAt as string) >= ttl)
    .filter((instance) => !policy.pinnedModelIds.includes(instance.modelId))
    .map((instance) => instance.modelId);
}

export function retryContext(contextLength: number): number {
  return Math.max(2_048, Math.floor(contextLength / 2 / 1024) * 1024);
}

export function initialContext(modelMaximum: number): number {
  return Math.max(2_048, Math.min(modelMaximum || 32_768, 32_768));
}
