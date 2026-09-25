import type { Plugin } from "vite";
import { resolve } from "node:path";
import { AppDatabase } from "../main/services/database.ts";
import { ModelService } from "../main/services/model-service.ts";
import { LmStudioProvider } from "../main/services/lm-studio-provider.ts";
import { WorkspaceFiles } from "../main/services/workspace-files.ts";
import { ResearchChatService } from "../main/services/research-chat.ts";
import { acquirePreviewExecutionJournal } from "./preview-execution-journal.ts";
import { McpClient } from "../main/services/mcp-client.ts";
import { ResearchToolBridge } from "../main/services/research-tools.ts";
import { randomBytes, randomUUID } from "node:crypto";
import { defaultModuleSettings, normalizeModuleSettings } from "../shared/modules.ts";
import {z} from "zod";
import { CHAT_IMPORT_REQUEST_LIMIT, chatRequestLimit } from "../shared/research-request-limits.ts";
import {previewChemScience} from "./chem-science-preview.ts";
import {runWorkspaceComputation} from "../main/services/compute-workspace.ts";
import {requestComputeStudies} from "../main/services/compute-studies.ts";
import {requestResearchFigures} from "../main/services/research-figures.ts";
import {createResearchWorkflowService} from '../main/services/research-workflow-runtime.ts';
import {requestManagedResearch} from '../main/services/research-study-commands.ts';
import {managedResearchDependencies} from '../main/services/managed-research-runtime.ts';
import {withWorkspaceWrite} from '../main/services/workspace-execution-queue.ts';
import {ResearchWorkflowsRequestSchema,RESEARCH_WORKFLOW_REQUEST_BYTES} from '../shared/research-workflows.ts';
import {ComputeStudiesRequestSchema} from "../shared/compute-studies.ts";
import {ResearchFiguresRequestSchema} from "../shared/research-figures.ts";
import {validateIpcArguments} from "../main/ipc-security.ts";
import {IPC} from "../shared/ipc.ts";
import {IPC_ARGUMENT_SCHEMAS} from "../shared/ipc-channel-contracts.ts";
import type {ComputeRequest} from "../shared/compute.ts";
import { researchPreviewDatabase } from "./research-preview-database.ts";

/** Real local chat in source previews. Fixed same-origin route; no arbitrary proxy. */
export function researchChatPreview(): Plugin {
  return { name: "proto-research-chat", configureServer(server) {
    const workspace = resolve(server.config.root, "../..");
    const chatDatabasePath = researchPreviewDatabase(workspace, process.env.PROTO_CHAT_PREVIEW_DB);
    const database = new AppDatabase(resolve(workspace, "build/chat-preview/models.sqlite"));
    const provider = new LmStudioProvider();
    const models = new ModelService(database, provider, provider);
    const files = new WorkspaceFiles(workspace, database);
    let modules=defaultModuleSettings();
    const ledger=acquirePreviewExecutionJournal(workspace,database.db);
    const mcp = new McpClient({packaged:false,resourcesPath:"",repoRoot:workspace,workspacePath:workspace,workspaceCapability:randomBytes(32).toString("hex"),pythonExecutable:resolve(workspace,process.platform==="win32"?".venv/Scripts/python.exe":".venv/bin/python")},{journal:ledger.journal});
    const service = new ResearchChatService({ databasePath: chatDatabasePath, workspace, runtime: models, readFile: path => files.read(path),tools:new ResearchToolBridge(mcp,files,()=>modules,previewChemScience(workspace)) });
    const workflows=createResearchWorkflowService(workspace,()=>mcp.fork(),{databaseRelativePath:process.env.PROTO_COMPUTE_STUDIES_DB});
    server.httpServer?.once("close", () => { void workflows.close().finally(()=>service.close()).finally(async () => { await mcp.stop(); await models.shutdown(); ledger.close(); database.close(); }); });
    server.middlewares.use(async (req, res, next) => {
      const route = req.url?.split("?")[0];
      if (route !== "/__proto/chat" && route !== "/__proto/compute" && route !== "/__proto/journal" && route !== '/__proto/research') return next();
      res.setHeader("Cache-Control", "no-store"); res.setHeader("Content-Type", "application/json");
      const host = req.headers.host ?? "";
      if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host) || req.headers.origin !== `http://${host}` || req.headers["sec-fetch-site"] === "cross-site") {
        res.statusCode = 403; res.end(JSON.stringify({error:"Loopback same-origin access required."})); return;
      }
      if (req.method !== "POST" || req.url?.includes("?") || req.headers["content-type"] !== "application/json") {
        res.statusCode = 405; res.end(JSON.stringify({error:"Use the Chat interface."})); return;
      }
      try {
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > (route === "/__proto/compute" || route === '/__proto/research' ? RESEARCH_WORKFLOW_REQUEST_BYTES : CHAT_IMPORT_REQUEST_LIMIT)) throw new Error("Request exceeds the route input limit.");
          chunks.push(chunk);
        }
        const payload=z.object({request:z.record(z.string(),z.unknown()),modules:z.object({profile:z.enum(["core-only","research","full","custom"]),enabledOptional:z.array(z.string()),enabledSkills:z.array(z.string()).optional()})}).strict().parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        const requestLimit=route==='/__proto/research'||route==='/__proto/compute'&&payload.request.action==='workflows'?RESEARCH_WORKFLOW_REQUEST_BYTES:chatRequestLimit(payload.request);
        if(size > requestLimit) throw new Error("Request is too large for this action.");
        modules=normalizeModuleSettings(payload.modules as Parameters<typeof normalizeModuleSettings>[0]);
        if(route === '/__proto/research') {
          validateIpcArguments(IPC.managedResearch,[payload.request]);
          const requestModules=modules;
          const result=await withWorkspaceWrite(workspace,undefined,()=>requestManagedResearch(workspace,payload.request,
            managedResearchDependencies(workspace,()=>mcp.fork(),workflows,()=>requestModules.enabledOptional.includes('analysis.biomni'),process.env.PROTO_COMPUTE_STUDIES_DB)));
          res.end(JSON.stringify(result)); return;
        }
        if(route==="/__proto/journal"){
          const request=z.object({action:z.enum(["list","inspect","reconcile"]),input:z.unknown()}).strict().parse(payload.request);
          if(request.action==="list"){
            const [input]=IPC_ARGUMENT_SCHEMAS[IPC.journalList].parse([request.input]);
            res.end(JSON.stringify(ledger.journal.listPage(input)));
          }else if(request.action==="inspect"){
            const [input]=IPC_ARGUMENT_SCHEMAS[IPC.journalInspect].parse([request.input]);
            res.end(JSON.stringify({record:ledger.journal.get(input.operationId),reconciliations:ledger.journal.reconciliationHistory(input.operationId),migrationReport:ledger.migrationReport}));
          }else{
            const [input]=IPC_ARGUMENT_SCHEMAS[IPC.journalReconcile].parse([request.input]);
            res.end(JSON.stringify(ledger.journal.reconcile(input.operationId,input.verdict,input.actor,input.evidenceRef)));
          }
          return;
        }
        if (route === "/__proto/compute") {
          const request=z.discriminatedUnion("action",[
            z.object({action:z.literal("catalog"),tool:z.string().optional()}).strict(),
            z.object({action:z.literal("studies"),request:ComputeStudiesRequestSchema}).strict(),
            z.object({action:z.literal("figures"),request:ResearchFiguresRequestSchema}).strict(),
            z.object({action:z.literal('workflows'),request:ResearchWorkflowsRequestSchema}).strict(),
            z.object({action:z.literal("read"),path:z.string().regex(/^build\/compute\/[a-f0-9]{32}\/(input|result|manifest|provenance)\.json$/)}).strict(),
            z.object({action:z.literal("run"),request:z.object({tool:z.string(),arguments:z.record(z.string(),z.unknown())}).strict()}).strict(),
          ]).parse(payload.request);
          if(request.action === "catalog") {
            validateIpcArguments(IPC.computeCatalog,[request.tool]);
            res.end(JSON.stringify({...await mcp.call("proto_compute_catalog",request.tool ? {tool:request.tool} : {},undefined,undefined,{scope:{surface:"compute",scopeId:randomUUID()}}),execution:"local",workspace_path:workspace}));
          } else if(request.action === "read") {
            res.end(JSON.stringify(await files.read(request.path)));
          } else if(request.action === "studies") {
            validateIpcArguments(IPC.computeStudies,[request.request]);
            res.end(JSON.stringify(await requestComputeStudies(workspace,request.request,
              process.env.PROTO_COMPUTE_STUDIES_DB ? {databaseRelativePath:process.env.PROTO_COMPUTE_STUDIES_DB} : undefined)));
          } else if(request.action === "figures") {
            validateIpcArguments(IPC.computeFigures,[request.request]);
            res.end(JSON.stringify(await requestResearchFigures(workspace,request.request,{
              databaseRelativePath:process.env.PROTO_COMPUTE_STUDIES_DB,
              render:(name,input)=>mcp.call(name,input,undefined,undefined,{timeoutMs:120_000,scope:{surface:"figure",scopeId:randomUUID()}}),
            })));
          } else if(request.action === 'workflows') {
            validateIpcArguments(IPC.computeWorkflows,[request.request]);
            if((request.request.action==='start'||request.request.action==='recover')&&!modules.enabledOptional.includes('analysis.biomni'))throw new Error('Enable computations in Settings before running a workflow.');
            res.end(JSON.stringify(await workflows.request(request.request)));
          } else {
            validateIpcArguments(IPC.computeRun,[request.request]);
            if(!modules.enabledOptional.includes("analysis.biomni")) throw new Error("Enable computations in Settings to run this method.");
            res.end(JSON.stringify(await runWorkspaceComputation(workspace,request.request as ComputeRequest,(name,input,operationId)=>mcp.call(name,input,undefined,undefined,{operationId,scope:{surface:"compute",scopeId:operationId}}))));
          }
          return;
        }
        const result = await service.request(payload.request);
        res.end(JSON.stringify(result));
      } catch (error) {
        res.statusCode = 400; res.end(JSON.stringify({ error: error instanceof Error ? error.message : "Chat request failed." }));
      }
    });
  } };
}
