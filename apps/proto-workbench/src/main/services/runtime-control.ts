export type RuntimeFailureCode =
  | "MODEL_UNAVAILABLE" | "MODEL_LEASED" | "MODEL_CONTEXT_EXCEEDED"
  | "PREFILL_TIMEOUT" | "STREAM_STALLED" | "GENERATION_TIMEOUT" | "STREAM_TRUNCATED"
  | "PROVIDER_TIMEOUT" | "USER_CANCELLED" | "TOOL_TIMEOUT" | "TOOL_SESSION_INTERRUPTED";

export class RuntimeFailure extends Error {
  readonly code: RuntimeFailureCode;
  readonly stage: string;
  readonly retryable: boolean;
  readonly effectState: "none" | "unknown";
  readonly budgetMs?: number;

  constructor(code: RuntimeFailureCode, stage: string, message: string, options: {
    retryable?: boolean; effectState?: "none" | "unknown"; budgetMs?: number;
  } = {}) {
    super(message);
    this.name = code === "USER_CANCELLED" ? "AbortError" : "RuntimeFailure";
    this.code = code;
    this.stage = stage;
    this.retryable = options.retryable ?? false;
    this.effectState = options.effectState ?? "none";
    this.budgetMs = options.budgetMs;
  }
}

/** FIFO with immediate removal of cancelled waiters; clocks start only after acquire. */
export class GenerationQueue {
  private active?: { modelId: string; release: () => void };
  private readonly waiting: Array<{
    modelId: string; resolve: (release: () => void) => void; reject: (error: Error) => void;
    signal?: AbortSignal; abort?: () => void;
  }> = [];

  isLeased(modelId?: string): boolean {
    return Boolean(this.active && (!modelId || this.active.modelId === modelId))
      || this.waiting.some((entry) => !modelId || entry.modelId === modelId);
  }

  acquire(modelId: string, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(cancelled());
    return new Promise((resolve, reject) => {
      const entry = { modelId, resolve, reject, signal, abort: undefined as (() => void) | undefined };
      entry.abort = () => {
        const index = this.waiting.indexOf(entry);
        if (index < 0) return;
        this.waiting.splice(index, 1);
        signal?.removeEventListener("abort", entry.abort!);
        reject(cancelled());
      };
      signal?.addEventListener("abort", entry.abort, { once: true });
      this.waiting.push(entry);
      this.pump();
    });
  }

  private pump(): void {
    if (this.active) return;
    const entry = this.waiting.shift();
    if (!entry) return;
    if (entry.abort) entry.signal?.removeEventListener("abort", entry.abort);
    if (entry.signal?.aborted) { entry.reject(cancelled()); this.pump(); return; }
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.active = undefined;
      this.pump();
    };
    this.active = { modelId: entry.modelId, release };
    entry.resolve(release);
  }
}

export function cancelled(): RuntimeFailure {
  return new RuntimeFailure("USER_CANCELLED", "cancel", "Cancelled by the caller.");
}
