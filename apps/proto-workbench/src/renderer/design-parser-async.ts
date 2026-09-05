import { parseDesignIr, type DesignParseResult } from "./design-visualization.ts";

let worker: Worker | undefined;
let nextId = 0;
const requests = new Map<number, { resolve(result: DesignParseResult): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();

/** One local worker serializes bounded parses and keeps megabase IR off the UI thread. */
export function parseDesignIrAsync(content: string): Promise<DesignParseResult> {
  if (content.length <= 200_000 || typeof Worker === "undefined") return Promise.resolve(parseDesignIr(content));
  if (content.length > 8 * 1024 * 1024) return Promise.resolve({ ok: false, diagnostics: [{ severity: "error", code: "IR_JSON_TOO_LARGE", path: "$", message: "IR exceeds the 8 MiB renderer text limit." }] });
  if (requests.size >= 16) return Promise.reject(new Error("The bounded design parser queue is full."));
  return new Promise((resolve, reject) => {
    if (!worker) {
      worker = new Worker(new URL("./design-parser.worker.ts", import.meta.url), { type: "module" });
      worker.onmessage = (event: MessageEvent<{ id: number; result: DesignParseResult }>) => {
        const request = requests.get(event.data.id);
        if (!request) return;
        clearTimeout(request.timer); requests.delete(event.data.id); request.resolve(event.data.result);
      };
      worker.onerror = () => disposeDesignParserWorker("The local design parser worker failed. Refresh the artifact inventory.");
    }
    const id = ++nextId;
    const timer = setTimeout(() => { const request = requests.get(id); requests.delete(id); request?.reject(new Error("Design parsing exceeded its 20-second deadline.")); if (!requests.size) { worker?.terminate(); worker = undefined; } }, 20_000);
    requests.set(id, { resolve, reject, timer });
    worker.postMessage({ id, content });
  });
}

export function disposeDesignParserWorker(reason = "The design inventory changed; obsolete parses were cancelled."): void {
  worker?.terminate(); worker = undefined;
  for (const request of requests.values()) { clearTimeout(request.timer); request.reject(new Error(reason)); }
  requests.clear();
}
