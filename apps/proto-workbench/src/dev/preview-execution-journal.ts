import {resolve} from "node:path";
import type {DatabaseSync} from "node:sqlite";
import {openWorkspaceExecutionJournal} from "../main/services/workspace-execution-journal.ts";

const ledgers=new Map<string,{ledger:ReturnType<typeof openWorkspaceExecutionJournal>;owners:number}>();
/** Every preview surface shares the same live leases as well as the same file. */
export function acquirePreviewExecutionJournal(workspace:string,legacyDb?:DatabaseSync){
  const root=resolve(workspace);let shared=ledgers.get(root);
  if(!shared){shared={ledger:openWorkspaceExecutionJournal(root,{legacyDb}),owners:0};ledgers.set(root,shared);}
  shared.owners++;let released=false;
  return {...shared.ledger,close(){if(released)return;released=true;if(--shared!.owners===0){ledgers.delete(root);shared!.ledger.close();}}};
}
