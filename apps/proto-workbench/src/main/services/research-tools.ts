import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { McpClient } from "./mcp-client.ts";
import type { WorkspaceFiles } from "./workspace-files.ts";
import { isToolExposedToModel, isNetworkTool, evaluateToolPolicy } from "./permissions.ts";
import type { ResearchActivity, ResearchChatSession, ResearchPlanItem } from "../../shared/research-chat.ts";
import { canonicalScienceTools, canonicalScienceName, resolveScienceTool } from "../../shared/research-tool-registry.ts";
import { resolveToolContract } from "../../shared/tool-contracts.ts";
import { isToolEnabledForModules, defaultModuleSettings, type ModuleSettings } from "../../shared/modules.ts";
import { designSkillInstructions } from "../../shared/design-skills.ts";
import { harnessToolEffect } from "./harness-workspace.ts";
import { withReadSlot, withWorkspaceWrite } from "./workspace-execution-queue.ts";
import { importResearchDocument, readResearchDocument } from "./research-documents.ts";
import {summarizeChemScience,type ChemScienceService} from "./chem-science.ts";

import type { PolicyGrant } from "../../shared/tool-policy.ts";

// Algorithm adaptations from OpenScience ef6156f8 (Apache-2.0):
// session/search-dedupe.ts canonical signatures; session/processor.ts isDoomLoop;
// tool/todo.ts compact plan receipts. See THIRD_PARTY_NOTICES.md.
function canonical(value:unknown):unknown {
  if(Array.isArray(value)) return value.map(canonical);
  if(!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,canonical(item)]));
}
export function researchSignature(tool:string,input:unknown):string {
  const normalized=tool==="science_run" && input && typeof input==="object" && "name" in input && typeof input.name==="string"
    ? {...input,name:canonicalScienceName(input.name)} : input;
  return createHash("sha256").update(JSON.stringify([tool,canonical(normalized)])).digest("hex");
}
export function repeatedResearchCall(activity:ResearchActivity[], tool:string,input:unknown):boolean {
  const last=activity.filter(item=>item.status!=="running").slice(-3);
  return last.length===3 && last.every(item=>researchSignature(item.tool,item.input)===researchSignature(tool,input));
}
/** External lookups are the repeatable reads worth caching; the contract decides, not the capability prefix. */
export function cacheableResearchCall(tool:string,input:Record<string,unknown>):boolean {
  if(tool!=="science_run" || typeof input.name!=="string") return false;
  const contract=resolveToolContract(input.name);
  return contract?.effect==="read" && contract.network;
}
export function planReceipt(plan:ResearchPlanItem[]):string {
  return `${plan.filter(item=>item.status==="completed").length}/${plan.length} completed; ${plan.filter(item=>item.status==="pending").length} pending.\nIn progress: ${plan.filter(item=>item.status==="in_progress").map(item=>item.content).join("; ") || "none"}`;
}
export const PLAN_SCHEMA=z.array(z.object({content:z.string().min(1).max(300),status:z.enum(["pending","in_progress","completed","cancelled"])}).strict()).max(20);
export const BLOCKED_SCHEMA=z.object({reason:z.string().trim().min(1).max(2000),unmetRequirements:z.array(z.string().trim().min(1).max(1024)).min(1).max(20)}).strict();
function tool(name:string,description:string,properties:Record<string,unknown>,required:string[]) {
  return {type:"function",function:{name,description,parameters:{type:"object",properties,required,additionalProperties:false}}};
}
export const RESEARCH_TOOLS=[
  tool("research_report_blocked","Stop this response when missing inputs, unavailable prerequisites or unresolved evidence prevent the requested work. Record the reason and concrete unmet requirements; this is an explicit blocked outcome, never a success claim.",{reason:{type:"string",minLength:1,maxLength:2000},unmetRequirements:{type:"array",minItems:1,maxItems:20,items:{type:"string",minLength:1,maxLength:1024}}},["reason","unmetRequirements"]),
  tool("research_plan","Maintain the visible research plan. Mark steps completed only after supporting tool evidence or a delivered artifact.",{items:{type:"array",items:{type:"object",properties:{content:{type:"string"},status:{type:"string",enum:["pending","in_progress","completed","cancelled"]}},required:["content","status"],additionalProperties:false}}},["items"]),
  tool("science_catalog","Discover available scientific tools and their exact argument schemas. Supports chemistry, reaction kinetics, molecular analysis, computations, literature, databases, Python/R/notebooks, governed Design workflows and project skills. Search first; never guess tool arguments.",{query:{type:"string"}},["query"]),
  tool("science_run","Run a scientific tool returned by science_catalog using its exact schema. Real execution state and artifacts are returned; unavailable backends must not be described as successful.",{name:{type:"string"},arguments:{type:"object",additionalProperties:true}},["name","arguments"]),
  tool("workspace_list","List workspace files to locate data, documents and source code.",{query:{type:"string"}},["query"]),
  tool("workspace_read","Read a workspace file using an exact path. Text and source code only. Offset is a zero-based character offset.",{path:{type:"string"},offset:{type:"integer",minimum:0},limit:{type:"integer",minimum:100,maximum:20000}},["path"]),
  tool("workspace_search","Search workspace text for a term. Returns file paths and line references.",{query:{type:"string"}},["query"]),
  tool("conversation_read","Read complete earlier transcript messages by zero-based source index when the context-retention note identifies omitted turns. Returns whole messages only; oversized message pages fail explicitly and are never shortened.",{startIndex:{type:"integer",minimum:0},limit:{type:"integer",minimum:1,maximum:8}},["startIndex"]),
  tool("document_import","Parse a workspace PDF, DOCX or XLSX file. Saves its immutable source and structured extraction, returns a document ID and an initial excerpt. Use document_read for page, paragraph or sheet/cell evidence beyond the excerpt.",{path:{type:"string"}},["path"]),
  tool("document_read","Read extracted PDF pages, DOCX paragraphs or XLSX cells from a previously attached/imported document. startUnit is zero-based; follow nextUnit until null for the complete available extraction. Citations should use returned locators.",{documentId:{type:"string"},startUnit:{type:"integer",minimum:0},limit:{type:"integer",minimum:1,maximum:20}},["documentId"]),
  tool("document_write","Create or revise a working text/code document and export a new version under build/chat. Returns its real path for follow-up analysis. Original source files remain available.",{name:{type:"string"},content:{type:"string"}},["name","content"]),
];

export const WORKFLOW_GUIDANCE={
  explore:"Explore the question, distinguish hypotheses from evidence and use tools when they can resolve an uncertainty. For substantial work keep a visible research plan.",
  literature:"Conduct a focused literature review. Start with two or three targeted searches; select the closest papers, distinguish metadata from content actually read, cite stable DOI or source URLs, mark preprints, compare disagreements and identify the missing comparison. Do not infer full-paper findings from titles or snippets.",
  analysis:"Inspect inputs and missingness before choosing methods. Write a short analysis plan, run appropriate scientific tools, inspect actual outputs and save a reproducible report with assumptions and limitations. Use compute_catalog through science_run to discover exact computation parameters.",
  reproduce:"State the claim, inputs, prerequisites and success criteria. Inspect available files and methods, run a bounded reproduction, compare expected and measured results, and record mismatches and provenance. Never label unexecuted code as a result.",
};

// Public OpenScience chemistry procedures, independently adapted to fixed local
// operators. These are workflow directions, not a claim that its remote engines
// or every skill dependency is installed. Source revision is pinned for review.
export const CHEMISTRY_RESEARCH_GUIDANCE={
  source:"https://github.com/synthetic-sciences/openscience/tree/ef6156f8fe5a1e40bd7889707e7abdba9ea1da80/backend/cli/skills/chemistry",
  sources:["smiles-validation/scripts/validate.py","rdkit/scripts/molecular_properties.py","molecule-visualization/SKILL.md"],
  procedure:[
    "Use chemistry.simulate_stochastic_network for seeded Gillespie ensembles of elementary mass-action reactions: initial mol/L multiplied by NA and volume in L must give integer molecule counts. Retain all replicates, stream keys and failures; count quantiles describe molecular noise, not parameter confidence. chemistry.analyze_network_structure returns signed algebraic conservation and cycle bases, not thermodynamic or feasible-flux certificates.",
    "chemistry.simulate_axial_dispersion resolves transient 1D open-flow transport, with Danckwerts inlet flux and upwind numerical-dispersion diagnostics. chemistry.analyze_tracer_rtd normalizes only a supplied pulse's observed window; chemistry.simulate_rtd_segregation weights independent batch parcels by that same distribution. Do not invent missing tails, injected-mass recovery or micromixing. chemistry.scan_cstr_steady_states follows one locally found isothermal branch and checks balance residuals and eigenvalues; it does not enumerate all roots or prove global stability.",
    "Reaction Sim also shares chemistry.simulate_reversible_chain and chemistry.simulate_catalytic_cycle (explicit complexes, competitive inhibition, reversible product release). Reuse validated networks with chemistry.simulate_cstr, chemistry.simulate_pfr or chemistry.simulate_semibatch; keep mol/L, L/s, residence time and startup time distinct. These are isothermal ideal liquid models, not full thermochemical reactor engines.",
    "Use chemistry.analyze_reaction_sensitivity for forward derivatives d concentration/d ln(k), chemistry.analyze_reaction_flux for integrated extents and signed pathway contributions, and chemistry.propagate_reaction_uncertainty for seeded independent lognormal rate draws. Keep all rate samples and model assumptions; empirical quantiles are not confidence intervals or mechanism validation. Prefer actual observed time series for chemistry.fit_reaction_rates.",
    "Use chemistry.simulate_nonisothermal_batch or chemistry.simulate_nonisothermal_cstr for constant-volume heat balances. Require explicit reaction enthalpies for every step (negative means exothermic), consistent around stoichiometric cycles, with declared heat capacity, cooling and Arrhenius data. Never invent heat values or claim phase-change/pressure/runaway validation. chemistry.simulate_tanks_in_series uses total train residence time and reports startup, outlet curves and stage profiles.",
    "chemistry.simulate_catalyst_deactivation scales only selected steps by phenomenological activity loss/regeneration; this is not a resolved poisoning mechanism. chemistry.simulate_gas_liquid_reaction couples supplied saturation and kLa to dissolved A+B kinetics with signed reservoir transfer. chemistry.simulate_catalyst_pellet resolves spherical diffusion, film transfer and first-order consumption: distinguish pore concentrations (mol/m³ fluid) from inventory and reaction per pellet volume. Spatial profiles are continuum solutions, not atomic trajectories. Steady-state reference diagnostics do not establish that a transient endpoint has reached steady state.",
    "chemistry.simulate_photochemical_isomerization uses absorbed photons, explicit molar absorptivities and quantum yields; chemistry.simulate_excited_state_quenching resolves abstract singlet/triplet populations with a maintained quencher. These do not infer electronic structure or spectra. chemistry.simulate_cyclic_voltammetry and chemistry.simulate_chronoamperometry couple Butler–Volmer kinetics to a finite closed diffusion slab with equal diffusivities; anodic current is positive. Only CV includes ideal capacitive current. Do not claim a semi-infinite domain, instrument operation or atomic trajectories.",
    "chemistry.fit_arrhenius_eyring fits first-order rates in s^-1 with supplied log-rate SD; activation standard errors are conditional, and Eyring assumes transmission coefficient 1. chemistry.compare_integrated_rate_laws compares zero/first/second order depletion using known Gaussian concentration SD and independently fixed C0. Preserve every candidate, residual and convergence diagnostic; AICc weights are relative model support, not proven mechanisms. Use chemistry.fit_reaction_rates for fitting an authored multistep network instead.",
    "For interface kinetics, use chemistry.simulate_competitive_adsorption, chemistry.simulate_langmuir_hinshelwood or chemistry.simulate_eley_rideal with explicit activities, surface site density and rate constants. Use chemistry.simulate_electrode_step for Butler–Volmer and double-layer charge balance; chemistry.simulate_diffusion_film for a Robin surface sink and reservoir mass balance. These independent SciPy models are shared with Reaction Sim. Their examples and surface occupancy views are illustrative, not atomistic trajectories or validated material mechanisms.",
    "For physical chemistry data, fit adsorption with chemistry.fit_adsorption_isotherm, dimensionless equilibrium constants with chemistry.analyze_vanthoff_equilibrium, polyprotic fractions with chemistry.calculate_acid_base_speciation, or complex impedance with chemistry.fit_electrochemical_impedance. Keep the declared model, units and residuals; the ideal RC fit does not validate a physical mechanism.",
    "For analytical chemistry, use chemistry.fit_calibration_curve for an explicit calibration and dilution correction, chemistry.analyze_spectrum for supplied signal processing, and chemistry.chemical_pca for numeric descriptors. Retain axis units, residuals and scaling choices; a signal peak does not identify a compound.",
    "Use chemistry.summarize_replicates and chemistry.compare_assay_groups with explicit measurement units and pairing. Preserve missing counts, sample size, uncertainty and test assumptions. Do not convert p-values or descriptors into chemical activity claims.",
    "For compound tables, use chemistry.prepare_molecular_dataset with an explicit salt policy, then chemistry.search_substructures or chemistry.cluster_molecules. Retain invalid records and original identifiers. Formula properties, balance_equation and solution_calculator report arithmetic and units, not experimental instructions.",
    "Validate and sanitize SMILES with chemistry.analyze_molecule before interpreting descriptors or drawing structures. Report canonical identity, formal charge and formula; retain parsing failures.",
    "For reaction SMILES call chemistry.inspect_reaction_smiles, inspect atom mapping, element and charge balance, then state which bond changes are supported. Atom mapping is not kinetic evidence.",
    "Represent kinetic assumptions as an explicit stoichiometric network. Use chemistry.simulate_reaction_network with declared rate constants, units, concentration, time and temperature. Inspect conservation, concentrations and solver diagnostics.",
    "Use chemistry.scan_reaction_temperature for an Arrhenius sensitivity comparison and chemistry.fit_reaction_rates only with actual supplied time-series observations. Compare residuals and identifiability before interpreting fitted constants.",
    "Use chemistry.parse_xyz_trajectory for actual coordinate trajectories. Population-based 3D playback visualizes solved concentrations; it does not compute atomistic reaction paths, transition states or molecular dynamics.",
    "Reuse chemistry.organic_candidates, chemistry.inorganic_candidates and chemistry.simulate_interface for the existing Chem design engines; existing quantum workflow approvals remain in the Design workspace.",
    "Keep complete input/result/manifest artifacts and cite their paths. Molecular geometry generated by ETKDG/MMFF is a computed conformer, not an experimental structure. Descriptor thresholds do not establish safety, potency or synthesis feasibility.",
  ],
};
const CHEM_READ_SCHEMA={type:"object",properties:{runId:{type:"string",format:"uuid"}},required:["runId"],additionalProperties:false};

export class ResearchToolBridge {
  private mcp:McpClient; private files:WorkspaceFiles; private modules:()=>ModuleSettings;private chem?:ChemScienceService;
  constructor(mcp:McpClient,files:WorkspaceFiles,modules:()=>ModuleSettings=defaultModuleSettings,chem?:ChemScienceService) {this.mcp=mcp;this.files=files;this.modules=modules;this.chem=chem;}
  private sendGrants=new Map<string,PolicyGrant>();
  authorizeSend(grant:PolicyGrant) {this.sendGrants.set(grant.scopeId,structuredClone(grant));}
  finishSend(scopeId:string) {this.sendGrants.delete(scopeId);}
  executionRecord(operationId:string) {return this.mcp.executionRecord?.(operationId)??this.chem?.executionRecord(operationId);}
  settings() {return structuredClone(this.modules());}
  guidance(settings:ModuleSettings) {return designSkillInstructions(settings);}
  private async tools(session:ResearchChatSession,signal:AbortSignal) {
    const tools=(await this.mcp.tools()).filter(item=>(isToolExposedToModel(item.name)||item.name==="proto_skills_list")&&isToolEnabledForModules(item.name,session.moduleSettings??this.modules()));
    if(this.chem&&isToolEnabledForModules("chemistry.catalog",session.moduleSettings??this.modules())) {
      tools.push({name:"chemistry.catalog",description:"Chemistry operators, exact schemas, examples and live local dependency availability. Calibration, spectrum analysis, PCA, assay statistics, compound datasets, SMARTS search, molecular clustering, formula and solution calculations, reaction kinetics, inorganic design and trajectories.",inputSchema:{type:"object",properties:{},additionalProperties:false}},
        {name:"chemistry.read",description:"Read a saved chemistry simulation or analysis by run ID, including complete result and reproducible artifact references.",inputSchema:CHEM_READ_SCHEMA},
        {name:"chemistry.history",description:"List saved chemistry runs shared by Proto Chat, Chem Chat and the visual Computation workspace.",inputSchema:{type:"object",properties:{limit:{type:"integer",minimum:1,maximum:100}},additionalProperties:false}},
        {name:"chemistry.guidance",description:"Chemical research workflow adapted from public OpenScience procedures and local scientific libraries: analytical calibration, spectra, assay statistics, molecular datasets, identity validation, kinetics and evidence-aware visualization.",inputSchema:{type:"object",properties:{},additionalProperties:false}});
      const response=await this.chem.request({action:"catalog"},signal);
      if(response.ok&&response.data&&"operators" in response.data) tools.push(...response.data.operators.filter(item=>item.available&&isToolEnabledForModules(`chemistry.${item.id}`,session.moduleSettings??this.modules())).map(item=>({name:`chemistry.${item.id}`,description:item.description,inputSchema:item.input_schema})));
    }
    return canonicalScienceTools(tools);
  }
  async execute(name:string,input:Record<string,unknown>,session:ResearchChatSession,signal:AbortSignal,operationId?:string):Promise<unknown> {
    signal.throwIfAborted();
    if(name==="science_catalog") {
      const {query}=z.object({query:z.string().max(300)}).parse(input);
      const words=query.toLowerCase().split(/\s+/).filter(Boolean);
      const tools=await this.tools(session,signal);
      const ranked=tools.map(tool=>({tool,score:words.reduce((score,word)=>score+(`${tool.id} ${tool.name} ${tool.aliases.join(" ")}`.toLowerCase().includes(word)?4:tool.description.toLowerCase().includes(word)?1:0),0)})).filter(item=>!words.length||item.score>0).sort((a,b)=>b.score-a.score);
      return {tools:ranked.slice(0,8).map(item=>item.tool),totalMatching:ranked.length,totalAvailable:tools.length,execution:await this.mcp.capabilities(true),chemistry:{available:tools.some(tool=>tool.id.startsWith("chemistry.")&&!['catalog','history','read','guidance'].includes(tool.id.slice(10))),mode:"fixed-local-operators"},note:"Use chemistry.catalog for real local chemistry schemas, examples and dependency availability; chemistry.guidance describes molecule validation, kinetic fitting and visualization. Chemistry operators run independently of generic code sandbox availability. Narrow the search to an exact operator ID to obtain its schema. Use compute.catalog for fixed computations; bioinformatics.catalog with probe:true for installed WSL tool schemas and live versions. For generic Python/R/notebooks use code.*; write artifacts to PROTO_AGENT_RUN_DIR (/run), read inputs from PROTO_AGENT_WORKSPACE (/workspace). Network searches require offline:false for live results."};
    }
    if(name==="science_run") {
      const request=z.object({name:z.string().max(128),arguments:z.record(z.string(),z.unknown())}).strict().parse(input);
      const selected=resolveScienceTool(await this.tools(session,signal),request.name);
      if(!selected) throw new Error("This scientific tool is not exposed by the local backend or is disabled in module settings.");
      const scopeId=session.messages?.at(-1)?.id??session.id;
      const scope={surface:"chat" as const,scopeId,parentOperationId:session.id};
      const callId=operationId??randomUUID();
      const grant=this.sendGrants.get(scopeId);
      const decision=evaluateToolPolicy({tool:selected.name,args:request.arguments,surface:"chat",scopeId,operationId:callId,grants:grant?[grant]:[]});
      if(!decision.allowed){this.mcp.recordPolicyDenial?.(selected.name,request.arguments,{operationId:callId,scope,decisionId:decision.decisionId,decision});throw Object.assign(new Error(`${decision.code}: ${decision.reason}`),{code:decision.code,effectState:"none"});}
      if(selected.id.startsWith("chemistry.")&&this.chem) {
        const operator=selected.id.slice("chemistry.".length);
        if(operator==="guidance") {z.object({}).strict().parse(request.arguments);return CHEMISTRY_RESEARCH_GUIDANCE;}
        if(operator==="catalog") {z.object({}).strict().parse(request.arguments);return this.chem.request({action:"catalog"},signal);}
        if(operator==="history") {const args=z.object({limit:z.number().int().min(1).max(100).optional()}).strict().parse(request.arguments);return summarizeChemScience(await this.chem.request({action:"history",...args},signal));}
        if(operator==="read") {const args=z.object({runId:z.string().uuid()}).strict().parse(request.arguments);return summarizeChemScience(await this.chem.request({action:"read",...args},signal));}
        return withWorkspaceWrite(await this.files.canonicalRootPath(),signal,async()=>summarizeChemScience(await this.chem!.request({action:"run",operator,input:request.arguments},signal,{operationId:callId,scope,decisionId:decision.decisionId,decision})));
      }
      // The Chat research capability is an explicit user action; bind each live
      // database request to this conversation and a short-lived signed grant.
      const execute=async()=>{
        const worker=this.mcp.fork();
        try {
          return await worker.call(selected.name,request.arguments,signal,isNetworkTool(selected.name)&&request.arguments.offline!==true?{runId:session.id,approvalId:decision.grantId!,expiresAt:new Date(Date.now()+55_000).toISOString()}:undefined,
            {operationId:callId,scope,decisionId:decision.decisionId,decision});
        } finally {await worker.stop();}
      };
      return harnessToolEffect(selected.name)==="write"||selected.name==="proto_design_edit"
        ? withWorkspaceWrite(await this.files.canonicalRootPath(),signal,execute) : withReadSlot(signal,execute);
    }
    if(name==="workspace_read") {
      const request=z.object({path:z.string().min(1).max(4096),offset:z.number().int().min(0).default(0),limit:z.number().int().min(100).max(20000).default(12000)}).strict().parse(input);
      const file=await this.files.read(request.path);
      return {path:file.path,sha256:file.sha256,content:file.content.slice(request.offset,request.offset+request.limit),offset:request.offset,totalCharacters:file.content.length,truncated:request.offset+request.limit<file.content.length};
    }
    if(name==="workspace_search") return this.files.search(z.object({query:z.string().min(1).max(500)}).parse(input).query);
    if(name==="document_import") {
      const request=z.object({path:z.string().min(1).max(4096)}).strict().parse(input);
      if(session.documents.length>=24) throw new Error("A conversation can hold up to 24 documents.");
      const document=await importResearchDocument({workspace:await this.files.canonicalRootPath(),sessionId:session.id,path:request.path});
      signal.throwIfAborted();
      session.documents.push(document);
      return {documentId:document.id,name:document.name,sourceSha256:document.sourceSha256,extraction:document.extraction,excerpt:document.content,note:"This is an excerpt. Use document_read with the documentId for structured, paginated source evidence."};
    }
    if(name==="document_read") {
      const request=z.object({documentId:z.string().uuid(),startUnit:z.number().int().min(0).default(0),limit:z.number().int().min(1).max(20).default(5)}).strict().parse(input);
      const document=session.documents.find(item=>item.id===request.documentId);
      if(!document) throw new Error("The document is not attached to this conversation.");
      const page=await readResearchDocument(await this.files.canonicalRootPath(),document,request.startUnit,request.limit);
      signal.throwIfAborted();
      return page;
    }
    if(name==="workspace_list") {
      const query=z.object({query:z.string().max(300)}).parse(input).query.toLowerCase();
      return (await this.files.list()).filter(item=>!query||item.path.toLowerCase().includes(query)).slice(0,100);
    }
    throw new Error(`Unknown research tool ${name}.`);
  }
}
