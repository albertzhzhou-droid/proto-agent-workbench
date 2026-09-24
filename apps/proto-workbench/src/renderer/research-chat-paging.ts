import type { ResearchChatSummary } from "../shared/research-chat.ts";

export const SESSION_PAGE_SIZE = 30;
export const SESSION_WINDOW_LIMIT = 200;
export function researchActivityPresentation(status: "running" | "complete" | "error", executionStatus?: string, cached = false) {
  const live = executionStatus === "owned" || executionStatus === "live-elsewhere";
  return { spinning: status === "running" && live, unconfirmed: status === "running" && !live,
    label: status === "running" ? live ? "running" : "Completion unconfirmed" : status === "error" ? "error" : cached ? "Reused result" : "Executed" };
}
export interface SessionListPage {
  nextCursor: string | null; generation: string; indexingPending: number; resetRequired?: boolean;
}
export type SessionListMode = "poll" | "reset" | "older" | "window";
export interface SessionListState {
  sessions: ResearchChatSummary[];
  listGeneration?: string; listNextCursor: string | null;
  listIndexingPending: number; listChanged: boolean; listWindowOffset: number;
}
export function emptySessionList(): SessionListState {
  return { sessions: [], listGeneration: undefined, listNextCursor: null, listIndexingPending: 0, listChanged: false, listWindowOffset: 0 };
}

/** Only explicit reset/window actions may remove already loaded summaries. */
export function applySessionListPage(current: SessionListState, response: {
  sessions?: ResearchChatSummary[]; sessionPage?: SessionListPage;
}, mode: SessionListMode): SessionListState {
  if (!Array.isArray(response.sessions)) throw new Error("The conversation list response is missing its summaries.");
  const page = response.sessionPage;
  // Older fixture/API producers have no cursor. Their bounded response is one complete page.
  if (!page) {
    if (mode === "older" || mode === "window") throw new Error("This runtime does not support conversation pagination.");
    if (current.listGeneration && current.listGeneration !== "legacy") throw new Error("The conversation paging contract changed. Refresh the list after reconnecting.");
    return { ...emptySessionList(), sessions: [...new Map(response.sessions.map(item => [item.id, item])).values()].slice(0, SESSION_WINDOW_LIMIT), listGeneration: "legacy" };
  }
  if (typeof page.generation !== "string" || !page.generation || !Number.isSafeInteger(page.indexingPending) || page.indexingPending < 0
      || !(page.nextCursor === null || typeof page.nextCursor === "string" && !!page.nextCursor)
      || response.sessions.length > 50) throw new Error("The conversation page metadata is invalid.");
  if (page.resetRequired || mode !== "reset" && current.listGeneration !== undefined && page.generation !== current.listGeneration) {
    return { ...current, listChanged: true, listIndexingPending: page.indexingPending };
  }
  const incoming = [...new Map(response.sessions.map(item => [item.id, item])).values()];
  if (mode === "reset" || current.listGeneration === undefined || mode === "window") {
    return { sessions: incoming, listGeneration: page.generation, listNextCursor: page.nextCursor,
      listIndexingPending: page.indexingPending, listChanged: false,
      listWindowOffset: mode === "window" ? current.listWindowOffset + current.sessions.length : 0 };
  }
  if (mode === "poll") {
    // A later window must not acquire newer entries from the head-page poll.
    const updates = new Map(incoming.map(item => [item.id, item]));
    return { ...current, sessions: current.listWindowOffset ? current.sessions : current.sessions.map(item => updates.get(item.id) ?? item),
      listIndexingPending: page.indexingPending };
  }
  const merged = new Map(current.sessions.map(item => [item.id, item]));
  for (const item of incoming) merged.set(item.id, item);
  if (merged.size > SESSION_WINDOW_LIMIT) throw new Error("The conversation page exceeds this list window. Open the next older group.");
  return { ...current, sessions: [...merged.values()], listNextCursor: page.nextCursor, listIndexingPending: page.indexingPending };
}
