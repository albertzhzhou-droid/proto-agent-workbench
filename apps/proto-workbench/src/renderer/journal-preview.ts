import type {JournalApi} from "../shared/execution-journal.ts";
import {previewScienceModules} from "./research-chat-api.ts";

async function request<T>(action:string,input:unknown):Promise<T>{
  const response=await fetch("/__proto/journal",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({request:{action,input},modules:previewScienceModules()})});
  const result=await response.json();
  if(!response.ok)throw new Error(result.error||"Workspace execution journal is unavailable.");
  return result as T;
}
export const previewJournal:JournalApi={
  list:input=>request("list",input),inspect:input=>request("inspect",input),reconcile:input=>request("reconcile",input),
};
