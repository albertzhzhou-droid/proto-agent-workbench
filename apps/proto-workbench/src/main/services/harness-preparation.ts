import type {HarnessCheckpoint} from "../../shared/harness.ts";
import type {HarnessStore} from "./harness-store.ts";

/** Discovery is active work. Save it before awaiting the sidecar, and keep its
 * budget/heartbeat separate from the controller's later generation loop. */
export async function prepareHarnessExecution<T>(checkpoint: HarnessCheckpoint, store: HarnessStore, signal: AbortSignal,
  publish: () => void, work: (signal: AbortSignal) => Promise<T>, intervalMs = 5000): Promise<T> {
  const abort = new AbortController(), combined = AbortSignal.any([signal, abort.signal]);
  let lastTick = Date.now(), stoppedAt: number | undefined, persistenceError: unknown;
  const stopClock = () => {stoppedAt ??= Date.now();};
  combined.addEventListener("abort", stopClock, {once: true});
  const save = () => {
    const now = stoppedAt ?? Date.now();
    checkpoint.activeTimeMs += Math.max(0, now - lastTick);lastTick = now;
    store.save(checkpoint);publish();
  };
  checkpoint.state = "preparing";
  save();
  const budgetTimer = setTimeout(() => abort.abort(Object.assign(new Error("Active execution time exhausted during preparation."), {code: "TASK_BUDGET_EXHAUSTED"})), Math.max(1, checkpoint.contract.budgets.activeTimeMs - checkpoint.activeTimeMs));
  const heartbeat = setInterval(() => {try {save();} catch(error) {persistenceError = error;abort.abort(error);}}, intervalMs);
  try {combined.throwIfAborted();return await work(combined);}
  finally {
    clearTimeout(budgetTimer);clearInterval(heartbeat);combined.removeEventListener("abort", stopClock);
    if (persistenceError) throw persistenceError;
    save();
  }
}
