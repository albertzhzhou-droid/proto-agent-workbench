import type { ResearchChatSession } from "../shared/research-chat.ts";
import { RESEARCH_SESSION_SCHEMA } from "../shared/research-session-state.ts";

type Version = {kind:"legacy"} | {kind:"versioned";revision:number} | {kind:"invalid"};

function version(session:ResearchChatSession):Version {
  if(session.payloadSchema===undefined&&session.revision===undefined&&session.researchState===undefined)return {kind:"legacy"};
  if(session.payloadSchema!==RESEARCH_SESSION_SCHEMA||!Number.isSafeInteger(session.revision)||session.revision!<=0)return {kind:"invalid"};
  return {kind:"versioned",revision:session.revision!};
}

/**
 * Cache freshness only; the host remains responsible for decoding and validating
 * the full session. A rejected response can still be returned to its original
 * request caller (for example, a successfully committed state save).
 *
 * Different session IDs never replace one another here. For an intentional
 * selection, first check its selection token, then pass only a cached session
 * with the same ID, or undefined. Repeated reads at an equal revision are valid.
 */
export function canAcceptResearchSession(current:ResearchChatSession|undefined,incoming:ResearchChatSession):boolean {
  if(!incoming||typeof incoming.id!=="string"||!incoming.id.trim())return false;
  const next=version(incoming);
  if(next.kind==="invalid")return false;
  if(!current)return true;
  if(current.id!==incoming.id)return false;
  const previous=version(current);
  if(previous.kind==="invalid")return false;
  if(previous.kind==="versioned")return next.kind==="versioned"&&next.revision>=previous.revision;
  if(next.kind==="versioned")return true;
  // Legacy producers have no revision clock. Retain the later timestamp while
  // they remain legacy; a validated versioned response can migrate the cache.
  const before=Date.parse(current.updatedAt),after=Date.parse(incoming.updatedAt);
  return Number.isFinite(before)&&Number.isFinite(after)&&after>=before;
}

export interface ResearchSelectionToken {
  workspaceGeneration:number;
  selectionGeneration:number;
  sessionId:string;
}

/** Latest selection wins, even for A -> B -> A or reused IDs in another workspace. */
export function isCurrentResearchSelection(requested:ResearchSelectionToken,current:ResearchSelectionToken,
  returnedSessionId?:string):boolean {
  if(!requested||!current)return false;
  for(const token of [requested,current]){
    if(!Number.isSafeInteger(token.workspaceGeneration)||token.workspaceGeneration<0
      ||!Number.isSafeInteger(token.selectionGeneration)||token.selectionGeneration<0
      ||typeof token.sessionId!=="string"||!token.sessionId.trim())return false;
  }
  return requested.workspaceGeneration===current.workspaceGeneration
    &&requested.selectionGeneration===current.selectionGeneration&&requested.sessionId===current.sessionId
    &&(returnedSessionId===undefined||returnedSessionId===requested.sessionId);
}
