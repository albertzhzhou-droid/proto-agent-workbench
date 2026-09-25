import { randomUUID } from 'node:crypto';
import type { ComputeCatalog } from '../../shared/compute.ts';
import type { ComputeFingerprint } from '../../shared/research-workflows.ts';
import type { WorkflowRuntimeClient } from './research-workflow-runtime.ts';
import type { ResearchWorkflowService } from './research-workflows.ts';
import type { ManagedResearchDependencies } from './research-study-commands.ts';
import { writeWorkspaceComputeRequest } from './compute-workspace.ts';

export function managedResearchDependencies(workspace: string, createClient:()=>WorkflowRuntimeClient,
  workflows: ResearchWorkflowService, executionEnabled:()=>boolean, databaseRelativePath?:string): ManagedResearchDependencies {
  const call = async (tool:string,input:Record<string,unknown>) => {
    const client=createClient();
    try {
      const value=await client.call(tool,input,undefined,undefined,{timeoutMs:120_000,scope:{surface:'workflow',scopeId:randomUUID()}});
      if(value.ok!==true) throw new Error(`RESEARCH_PREFLIGHT_FAILED: ${JSON.stringify(value.diagnostics ?? value.error ?? value.message ?? tool)}`);
      return value;
    } finally {await client.stop();}
  };
  return {workflows,executionEnabled,databaseRelativePath,
    catalog:async tool=>await call('proto_compute_catalog',tool?{tool}:{}) as unknown as ComputeCatalog,
    fingerprint:async request=>await call('proto_compute_fingerprint',{path:await writeWorkspaceComputeRequest(workspace,request)}) as unknown as ComputeFingerprint,
  };
}
