import type { ResearchChatApi } from "../shared/research-chat.ts";
import {defaultModuleSettings,type ModuleSettings} from "../shared/modules.ts";
let readModules:()=>ModuleSettings=defaultModuleSettings;
export function configurePreviewChatModules(read:()=>ModuleSettings) {readModules=read;}
export function previewScienceModules() { return readModules(); }
export const previewResearchChat: ResearchChatApi = {
  async request(input) {
    const response = await fetch("/__proto/chat", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({request:input,modules:readModules()}) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Local Chat is unavailable.");
    return data;
  },
};
