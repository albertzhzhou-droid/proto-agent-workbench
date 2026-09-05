/** Shared across mission sessions and manual source edits in this process. */
interface Waiter { start(): void; cancel(): void }
interface Lane { active: number; waiting: Waiter[] }
const writes = new Map<string, Lane>();
const reads: Lane = {active: 0, waiting: []};
export type WorkspaceQueueState = (state: "queued" | "active") => void;

async function acquire(lane: Lane, capacity: number, signal?: AbortSignal): Promise<() => void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const pump = () => {
      while (lane.active < capacity && lane.waiting.length) lane.waiting.shift()!.start();
    };
    const waiter: Waiter = {
      start() {
        signal?.removeEventListener("abort", waiter.cancel);
        lane.active += 1;
        let released = false;
        resolve(() => {if (released) return; released = true; lane.active -= 1; pump();});
      },
      cancel() {
        const index = lane.waiting.indexOf(waiter);
        if (index < 0) return;
        lane.waiting.splice(index, 1);
        signal?.removeEventListener("abort", waiter.cancel);
        reject(signal?.reason ?? new Error("Queued operation cancelled."));
      },
    };
    signal?.addEventListener("abort", waiter.cancel, {once: true});
    lane.waiting.push(waiter); pump();
  });
}

export async function withWorkspaceWrite<T>(canonicalWorkspace: string, signal: AbortSignal | undefined, operation: () => Promise<T>, queueState?: WorkspaceQueueState): Promise<T> {
  const key = process.platform === "win32" ? canonicalWorkspace.toLocaleLowerCase() : canonicalWorkspace;
  const lane = writes.get(key) ?? {active: 0, waiting: []};
  writes.set(key, lane);
  queueState?.("queued");
  const release = await acquire(lane, 1, signal);
  try {queueState?.("active"); signal?.throwIfAborted(); return await operation();}
  finally {release(); if (!lane.active && !lane.waiting.length) writes.delete(key);}
}

export async function withReadSlot<T>(signal: AbortSignal | undefined, operation: () => Promise<T>, queueState?: WorkspaceQueueState): Promise<T> {
  queueState?.("queued");
  const release = await acquire(reads, 3, signal);
  try {queueState?.("active"); signal?.throwIfAborted(); return await operation();}
  finally {release();}
}
