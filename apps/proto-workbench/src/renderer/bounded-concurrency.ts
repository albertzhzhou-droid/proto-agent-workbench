export class BoundedConcurrencyCancelledError extends Error {
  constructor() {
    super("The bounded operation was cancelled.");
    this.name = "BoundedConcurrencyCancelledError";
  }
}

/** Run ordered work with a shared concurrency ceiling and cooperative dispatch cancellation. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  task: (item: T, index: number) => Promise<R>,
  shouldContinue: () => boolean = () => true,
): Promise<R[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new RangeError("Concurrency must be a positive integer.");
  }

  const results = new Array<R>(items.length);
  let cursor = 0;
  let stopped = false;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (!stopped) {
      if (!shouldContinue()) {
        stopped = true;
        return;
      }
      const index = cursor;
      if (index >= items.length) return;
      cursor += 1;
      try {
        results[index] = await task(items[index], index);
      } catch (error) {
        stopped = true;
        throw error;
      }
    }
  });
  await Promise.all(workers);
  if (stopped || !shouldContinue()) throw new BoundedConcurrencyCancelledError();
  return results;
}
