import { parseDesignIr } from "./design-visualization.ts";

const scope = self as unknown as { onmessage: ((event: MessageEvent<{ id: number; content: string }>) => void) | null; postMessage(message: unknown): void };
scope.onmessage = (event) => {
  const { id, content } = event.data;
  if (!Number.isSafeInteger(id) || typeof content !== "string") return;
  scope.postMessage({ id, result: parseDesignIr(content) });
};
