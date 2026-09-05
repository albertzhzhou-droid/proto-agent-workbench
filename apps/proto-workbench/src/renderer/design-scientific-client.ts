import type { ScientificInputs, ScientificKind, ScientificOutputs, ScientificRequest, ScientificResponse } from "./design-scientific.ts";

export interface ScientificWorkerTransport {
  onmessage: ((event: MessageEvent<ScientificResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: ScientificRequest): void;
  terminate(): void;
}
export class ScientificComputationCancelled extends Error {
  constructor() { super("Obsolete scientific computation cancelled."); this.name = "AbortError"; }
}

/** One latest request per computation channel, no unbounded worker queue. */
export class ScientificWorkerClient {
  private worker?: ScientificWorkerTransport;
  private generation = 0;
  private pending?: { reject(error: Error): void; timer: ReturnType<typeof setTimeout>; removeAbort(): void };
  private readonly createWorker: () => ScientificWorkerTransport;
  private readonly deadlineMs: number;
  constructor(createWorker: () => ScientificWorkerTransport = () => new Worker(new URL("./design-scientific.worker.ts", import.meta.url), { type: "module" }) as unknown as ScientificWorkerTransport, deadlineMs = 20_000) {
    this.createWorker = createWorker;
    this.deadlineMs = deadlineMs;
  }

  run<K extends ScientificKind>(kind: K, artifactIdentity: string, input: ScientificInputs[K], signal?: AbortSignal): Promise<ScientificOutputs[K]> {
    this.cancel();
    if (signal?.aborted) return Promise.reject(new ScientificComputationCancelled());
    const id = ++this.generation;
    return new Promise((resolve, reject) => {
      try { this.worker ??= this.createWorker(); } catch (error) { reject(error); return; }
      const worker = this.worker;
      const abort = () => { if (id === this.generation) this.cancel(); };
      const timer = setTimeout(() => this.fail(new Error("Scientific computation exceeded its 20-second deadline.")), this.deadlineMs);
      this.pending = { reject, timer, removeAbort: () => signal?.removeEventListener("abort", abort) };
      signal?.addEventListener("abort", abort, { once: true });
      worker.onmessage = ({ data }) => {
        if (worker !== this.worker || id !== this.generation || data.id !== id || data.artifactIdentity !== artifactIdentity || data.kind !== kind || !this.pending) return;
        this.clearPending();
        if ("error" in data) reject(new Error(data.error));
        else resolve(data.result as ScientificOutputs[K]);
      };
      worker.onerror = () => { if (worker === this.worker && id === this.generation) this.fail(new Error("The local scientific worker failed. Refresh the artifact to retry.")); };
      try { worker.postMessage({ id, artifactIdentity, kind, input } as ScientificRequest); } catch (error) { this.fail(error instanceof Error ? error : new Error("Scientific worker dispatch failed.")); }
    });
  }
  cancel(): void {
    if (this.pending) this.fail(new ScientificComputationCancelled());
  }
  dispose(): void {
    this.cancel();
    this.worker?.terminate(); this.worker = undefined;
    this.generation++;
  }
  private clearPending(): void {
    if (!this.pending) return;
    clearTimeout(this.pending.timer); this.pending.removeAbort(); this.pending = undefined;
  }
  private fail(error: Error): void {
    const pending = this.pending;
    this.clearPending();
    this.worker?.terminate(); this.worker = undefined;
    this.generation++;
    pending?.reject(error);
  }
}

export interface ScientificSettlement<K extends ScientificKind> {
  input: ScientificInputs[K]; artifactIdentity: string; result?: ScientificOutputs[K]; error?: string;
}
export function currentScientificSettlement<K extends ScientificKind>(settled: ScientificSettlement<K> | undefined, input: ScientificInputs[K] | undefined, artifactIdentity: string): ScientificSettlement<K> | undefined {
  return settled && settled.input === input && settled.artifactIdentity === artifactIdentity ? settled : undefined;
}
