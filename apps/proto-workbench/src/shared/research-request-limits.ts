// A binary attachment is base64 encoded for the same Chat transport in desktop
// and source preview. Other actions keep their original small request budget.
export const CHAT_REQUEST_LIMIT = 512 * 1024;
export const CHAT_IMPORT_REQUEST_LIMIT = 4 * Math.ceil(20 * 1024 * 1024 / 3) + 16 * 1024;
export function chatRequestLimit(request: unknown): number {
  return request !== null && typeof request === "object" && "action" in request && request.action === "import"
    ? CHAT_IMPORT_REQUEST_LIMIT : CHAT_REQUEST_LIMIT;
}
