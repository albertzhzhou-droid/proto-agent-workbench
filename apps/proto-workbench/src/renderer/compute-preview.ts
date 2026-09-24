import fixture from "./compute-preview.json" with { type: "json" };
import type { ComputeApi, ComputeCatalog } from "../shared/compute.ts";
import {previewScienceModules} from "./research-chat-api.ts";

async function localCompute(request: Record<string,unknown>) {
  const response=await fetch("/__proto/compute",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({request,modules:previewScienceModules()})});
  const data=await response.json();
  if(!response.ok) throw new Error(data.error || "Local computation is unavailable.");
  return data;
}
export async function downloadLocalComputeArtifact(path:string) {
  const file=await localCompute({action:"read",path});
  const url=URL.createObjectURL(new Blob([file.content],{type:"application/json"}));
  const link=document.createElement("a");link.href=url;link.download=path.split("/").slice(-2).join("-");link.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}

export async function readLocalComputeArtifact(path: string): Promise<{path:string;content:string;sha256:string}> {
  return localCompute({action:"read",path});
}

export const previewCompute: ComputeApi = {
  async workflows(request) {
    if (import.meta.env?.DEV) return localCompute({action:'workflows',request});
    throw new Error('Research workflows require the local Workbench or its development server. Recorded examples cannot execute or reuse workflow steps.');
  },
  async figures(request) {
    if (import.meta.env?.DEV) return localCompute({action:"figures",request});
    throw new Error("Research figures require the local Workbench or its development server. Recorded examples cannot create research artifacts.");
  },
  async studies(request) {
    if (import.meta.env?.DEV) return localCompute({action:"studies",request});
    throw new Error("Saved research projects require the local Workbench or its development server. Recorded examples do not create saved runs.");
  },
  async catalog(tool) {
    if(import.meta.env?.DEV) return localCompute({action:"catalog",...(tool ? {tool} : {})});
    const catalog = structuredClone(fixture.catalog) as unknown as ComputeCatalog;
    if (tool) catalog.tools = catalog.tools.filter(entry => entry.id === tool);
    return catalog;
  },
  async run(request) {
    if(import.meta.env?.DEV) return localCompute({action:"run",request});
    const entry = fixture.catalog.tools.find(tool => tool.id === request.tool);
    if (!entry || canonical(request.arguments) !== canonical(entry.example)) {
      throw new Error("Browser preview replays the supplied example only. Restore the example, or use the desktop app to calculate your own data.");
    }
    return { ok: true, tool: request.tool, preview: true,
      result: structuredClone(fixture.results[request.tool as keyof typeof fixture.results]) as unknown as Record<string, unknown> };
  },
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
