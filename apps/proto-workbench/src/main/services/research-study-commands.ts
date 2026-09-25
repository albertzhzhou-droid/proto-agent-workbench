import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { ComputeCatalog, ComputeRequest } from '../../shared/compute.ts';
import type { ComputeFingerprint, WorkflowExecution } from '../../shared/research-workflows.ts';
import { ManagedResearchRequestSchema } from '../../shared/managed-research.ts';
import type { ManagedResearchDraft, ManagedResearchResponse, ManagedPlanSummary } from '../../shared/managed-research.ts';
import { ResearchPlanIRSchema, canonicalResearchJson } from '../../shared/research-plan.ts';
import type { StudySpec, StudyDataset } from '../../shared/research-plan.ts';
import { scientificDiff } from '../../shared/research-evidence-graph.ts';
import type { ResearchOpenedVersion } from '../../shared/research-project.ts';
import { ResearchProjectStore } from './research-project-store.ts';
import { compileResearchPlan, deriveMethodContract, researchHash, verifyResearchPlanIdentity } from './research-plan-compiler.ts';
import { requestComputeStudies } from './compute-studies.ts';
import { readContained } from './research-documents.ts';
import type { ResearchWorkflowService } from './research-workflows.ts';
import { collectManagedResearchEvidence, type ManagedResearchEvidence } from './managed-research-evidence.ts';

const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const FrozenPlanSchema = z.object({schema: z.literal('proto.managed-plan.v1'), plan: ResearchPlanIRSchema,
  workflowId: z.string().uuid(), workflowRevision: z.number().int().positive()}).strict();
const limits = [
  'Study specifications, frozen plans and copied result evidence are stored in the project. Existing workflow and linked-run storage remains a compatibility authority; full legacy cutover is not complete.',
  'The compiler validates declared contracts and byte identities. Method-specific output Quantity bindings and scientific review remain separate.',
  'Runs use the existing local Compute workers. GPU prediction, remote MSA submission and external job reconciliation are not provided by this profile.',
  'Capsules contain selected research versions and retained result evidence. They are local version capsules, not a complete runtime distribution or a RO-Crate conformance claim.',
];
export interface ManagedResearchDependencies {
  catalog(tool?: string): Promise<ComputeCatalog>;
  fingerprint(request: ComputeRequest): Promise<ComputeFingerprint>;
  workflows: Pick<ResearchWorkflowService, 'request'>;
  databaseRelativePath?: string;
  executionEnabled(): boolean;
}
function frozen(record: ResearchOpenedVersion, studyId: string) {
  if (record.studyId !== studyId || record.kind !== 'research-plan') throw new Error('PLAN_SCOPE_MISMATCH: The plan does not belong to this Study.');
  const value = FrozenPlanSchema.parse(record.value);
  if (value.plan.spec.studyId !== studyId || !verifyResearchPlanIdentity(value.plan)) throw new Error('PLAN_DAMAGED: Frozen plan identity does not match.');
  const retained = new Set(record.references.map(reference=>reference.sha256));
  if(value.plan.spec.datasets.some(dataset=>!retained.has(dataset.sha256))) throw new Error('PLAN_SOURCE_IDENTITY_MISSING: Frozen plan is missing an explicitly retained source snapshot.');
  return value;
}
function checkedSourcePath(input: string): string {
  const path=input.replaceAll('\\','/'), parts=path.split('/');
  if(!path || path.startsWith('/') || /[:\x00-\x1f\x7f]/.test(path) || parts.some(part=>!part || part==='.' || part==='..' || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error('DATASET_PATH_INVALID: Source files require normalized relative project paths without traversal, alternate streams or device names.');
  }
  if(parts.some(part=>/^(?:\.proto|\.git|\.hg|\.svn|\.codex|\.agents|\.ssh|\.aws|\.azure)$/i.test(part)) || /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|id_rsa|id_ed25519)$/i.test(parts.at(-1)!) || /\.(?:pem|key)$/i.test(parts.at(-1)!)) {
    throw new Error('DATASET_SOURCE_CONTROLLED: Project control state and credential files cannot become scientific dataset snapshots.');
  }
  return path;
}
function summary(record: ResearchOpenedVersion): ManagedPlanSummary {
  const value = frozen(record, record.studyId);
  return {id: record.versionId, title: value.plan.spec.title, createdAt: record.createdAt, sha256: record.object.sha256, workflowId: value.workflowId, workflowRevision: value.workflowRevision};
}
/** Shared application commands for the native host and loopback development host. */
export async function requestManagedResearch(workspace: string, input: unknown, deps: ManagedResearchDependencies): Promise<ManagedResearchResponse> {
  const request = ManagedResearchRequestSchema.parse(input);
  const studies = (value: Parameters<typeof requestComputeStudies>[1]) => requestComputeStudies(workspace, value, {databaseRelativePath: deps.databaseRelativePath});
  if (request.action === 'list') {
    const result = await studies({action: 'list', limit: 50});
    return {studies: result.studies, limits: [...limits, ...(result.page?.nextCursor ? ['This navigation page contains the latest 50 studies. The existing notebook supports older pages.'] : [])]};
  }
  if (request.action === 'create') return {...await studies({action:'create',name:request.name,question:request.question}), limits};
  const study = (await studies({action:'get',studyId:request.studyId})).study;
  if (!study) throw new Error('STUDY_UNAVAILABLE');
  const store = ResearchProjectStore.open(workspace);
  try {
    if (request.action === 'get') return {study, plans: store.listVersions(study.id,'research-plan').map(record => summary(store.getVersion(record.versionId))), limits};
    if (request.action === 'compile') {
      if (study.revision !== request.expectedStudyRevision) throw new Error('STUDY_CHANGED: Reload the Study before freezing a plan.');
      const catalog = await planCatalog(request.draft.workflow.steps.map(step=>step.tool),deps);
      const prepared = await prepareSpec(workspace, study.id, study.question, request.draft, catalog, deps);
      const compiled = compileResearchPlan(prepared.spec, catalog, prepared.facts);
      if (!compiled.ok) return {diagnostics: compiled.diagnostics, limits};
      const latest = (await studies({action:'get',studyId:study.id})).study;
      if (latest?.revision !== request.expectedStudyRevision) throw new Error('STUDY_CHANGED: The Study changed during compilation.');
      const saved = await deps.workflows.request({action:'save',studyId:study.id,draft:compiled.workflow});
      if (!saved.workflow) return {diagnostics: saved.validation?.diagnostics ?? [{code:'WORKFLOW_INVALID',message:'The existing workflow compiler rejected this plan.'}], limits};
      if((await studies({action:'get',studyId:study.id})).study?.revision !== request.expectedStudyRevision) throw new Error('STUDY_CHANGED: The Study changed before publication. The unexecuted workflow is retained.');
      const references = [...new Map(prepared.sources.map(bytes => {const identity=store.putObject(bytes);return [identity.sha256,identity] as const;})).values()];
      store.appendVersion({studyId:study.id,kind:'study-spec',versionId:randomUUID(),value:compiled.plan.spec,references});
      const record = store.appendVersion({studyId:study.id,kind:'research-plan',versionId:randomUUID(),references,value:{schema:'proto.managed-plan.v1',plan:compiled.plan,workflowId:saved.workflow.id,workflowRevision:saved.workflow.revision}});
      const preview = await deps.workflows.request({action:'preview',studyId:study.id,workflowId:saved.workflow.id,expectedRevision:saved.workflow.revision});
      return {study,plan:summary(record),workflow:compiled.workflow,preview:preview.preview,diagnostics:[],limits};
    }
    if (request.action === 'compare') {
      const left = frozen(store.getVersion(request.leftPlanId),study.id), right = frozen(store.getVersion(request.rightPlanId),study.id);
      return {comparison: scientificDiff(left.plan.spec,right.plan.spec), limits};
    }
    if (request.action === 'capsule') {
      const bytes = store.exportCapsule({mode:request.mode,studyIds:[study.id]});
      const root = await realpath(workspace);
      let directory = root;
      for (const part of ['build','research-capsules']) {
        directory = join(directory,part);
        await mkdir(directory).catch(error => {if(error.code !== 'EEXIST') throw error;});
        const stat = await lstat(directory);
        if(!stat.isDirectory() || stat.isSymbolicLink() || await realpath(directory) !== directory) throw new Error('CAPSULE_UNSAFE_PATH');
      }
      const path = `build/research-capsules/${randomUUID()}.json`;
      await writeFile(join(root,path),bytes,{flag:'wx'});
      const reopened = await readContained(root,path,24*1024*1024);
      if(sha(reopened)!==sha(bytes)) throw new Error('CAPSULE_EXPORT_CHANGED');
      return {capsule:{path,sha256:sha(bytes),bytes:bytes.length,mode:request.mode},limits};
    }
    const record = store.getVersion(request.planId), value = frozen(record,study.id);
    if(request.action==='inspect-plan') {
      // Reopen retained evidence even when a source or installed runtime changed.
      // Starting again still requires a separate current dry run below.
      const current=await deps.workflows.request({action:'get',studyId:study.id,workflowId:value.workflowId,revision:value.workflowRevision});
      const latest=current.executions?.find(execution=>execution.workflowRevision===value.workflowRevision);
      const execution=latest?(await deps.workflows.request({action:'get-execution',studyId:study.id,workflowId:value.workflowId,executionId:latest.id})).execution:undefined;
      return {plan:summary(record),workflow:value.plan.workflow,execution,limits};
    }
    if(request.action === 'preview' || request.action === 'start') {
      if(record.origin !== 'local') throw new Error('IMPORTED_PLAN_REQUIRES_RECOMPILE: Imported versions do not convey execution authority.');
      await checkCurrent(workspace,value.plan.spec,deps);
      const current = await deps.workflows.request({action:'get',studyId:study.id,workflowId:value.workflowId,revision:value.workflowRevision});
      if(!current.workflow || researchHash({name:current.workflow.name,description:current.workflow.description,steps:current.workflow.steps}) !== researchHash(value.plan.workflow)) throw new Error('WORKFLOW_BINDING_CHANGED');
      if(request.action === 'preview') {
        const response = await deps.workflows.request({action:'preview',studyId:study.id,workflowId:value.workflowId,expectedRevision:value.workflowRevision});
        return {plan:summary(record),workflow:value.plan.workflow,preview:response.preview,limits};
      }
      if(!deps.executionEnabled()) throw new Error('Enable computations in Settings before running a research plan.');
      const response = await deps.workflows.request({action:'start',studyId:study.id,workflowId:value.workflowId,expectedRevision:value.workflowRevision,expectedPlanSha256:request.expectedPreviewSha256});
      return {execution:response.execution,limits};
    }
    const response = await deps.workflows.request({action:request.action === 'cancel'?'cancel':'get-execution',studyId:study.id,workflowId:value.workflowId,executionId:request.executionId});
    if(!response.execution || response.execution.workflowRevision !== value.workflowRevision) throw new Error('EXECUTION_PLAN_MISMATCH');
    const executions = (await deps.workflows.request({action:'get',studyId:study.id,workflowId:value.workflowId,revision:value.workflowRevision})).executions ?? [];
    const priorExecutions: WorkflowExecution[]=[];
    for(const previous of executions.filter(item=>item.id!==response.execution!.id && item.workflowRevision===value.workflowRevision && item.createdAt<=response.execution!.createdAt).reverse()) {
      const previousRecord=await deps.workflows.request({action:'get-execution',studyId:study.id,workflowId:value.workflowId,executionId:previous.id});
      if(!previousRecord.execution) throw new Error('EXECUTION_HISTORY_UNAVAILABLE');
      priorExecutions.push(previousRecord.execution);
    }
    const inspected=await collectManagedResearchEvidence({plan:value.plan,binding:value,execution:response.execution,priorExecutions,
      openRun:async runId=>{const opened=(await studies({action:'open-run',runId})).run;if(!opened)throw new Error('RUN_UNAVAILABLE');return opened;},
      sourceHash:async path=>sha(await readContained(workspace,path,16*1024*1024)),
      verifyDatasetSnapshot:async dataset=>{const identity=record.references.find(reference=>reference.sha256===dataset.sha256);if(!identity)return false;return sha(store.readObject(identity,16*1024*1024))===dataset.sha256;},
    });
    const evidence=await collectEvidence(store,study.id,inspected,studies);
    if(!['running','pending'].includes(response.execution.status)) {
      const graphId=`evidence-${study.id}-${response.execution.id}-${researchHash(inspected.facts).slice(0,24)}`;
      if(!store.listVersions(study.id,'evidence-graph').some(version=>version.versionId===graphId))store.appendVersion({studyId:study.id,kind:'evidence-graph',versionId:graphId,value:{graph:inspected.graph,facts:inspected.facts,completion:inspected.completion},references:record.references});
    }
    return {study:(await studies({action:'get',studyId:study.id})).study,execution:response.execution,evidence,graph:inspected.graph,completion:inspected.completion,diagnostics:inspected.diagnostics,limits};
  } finally {store.close();}
}

async function prepareSpec(workspace: string, studyId: string, question: string, draft: ManagedResearchDraft, catalog: ComputeCatalog, deps: ManagedResearchDependencies) {
  if(draft.stepSemantics.length !== draft.workflow.steps.length || new Set(draft.stepSemantics.map(step=>step.stepId)).size !== draft.stepSemantics.length) throw new Error('STEP_SEMANTICS_MISMATCH: Each workflow step needs one explicit role and dataset declaration.');
  const sources: Buffer[] = [], datasetFingerprints: Record<string,string> = {}, runtimeFingerprints: Record<string,string> = {};
  // Validate the entire source set before any source read or runtime probe.
  for(const dataset of draft.datasets) checkedSourcePath(dataset.sourcePath);
  let totalBytes=0;
  const datasets: StudyDataset[]=[];
  for(const dataset of draft.datasets) {
    const bytes = await readContained(workspace,dataset.sourcePath,16*1024*1024); totalBytes+=bytes.length;
    if(totalBytes>32*1024*1024) throw new Error('DATASET_READ_BUDGET');
    sources.push(bytes); datasetFingerprints[dataset.id]=sha(bytes); datasets.push({...dataset,sha256:sha(bytes)});
  }
  const steps=[];
  for(const step of draft.workflow.steps) {
    if(step.bindings.length) throw new Error('MANAGED_RUNTIME_PROBE_UNSUPPORTED: Freeze currently accepts literal-input steps. Binding-dependent DAGs remain available in the existing workflow editor; this profile cannot verify their runtime before inputs resolve.');
    const semantic = draft.stepSemantics.find(item=>item.stepId===step.id);
    if(!semantic) throw new Error('STEP_SEMANTICS_MISSING');
    const method = catalog.tools.find(tool=>tool.id===step.tool);
    if(!method) throw new Error(`METHOD_UNAVAILABLE: ${step.tool}`);
    // Literal inline data must match a retained JSON source, or a declared file input.
    // Binding-only downstream steps inherit provenance through the existing DAG.
    if(!step.bindings.length && semantic.role !== 'superseded-with-reason') {
      const declared = datasets.filter(dataset=>semantic.datasetIds.includes(dataset.id));
      const filePaths = Object.keys(method.file_inputs ?? {}).flatMap(key=>Array.isArray(step.arguments[key])?step.arguments[key] as unknown[]:[step.arguments[key]]).filter((path):path is string=>typeof path==='string');
      for(const path of filePaths) checkedSourcePath(path);
      const fileBound = filePaths.length > 0 && filePaths.every(path=>declared.some(dataset=>checkedSourcePath(dataset.sourcePath)===checkedSourcePath(path)));
      const inlineBound = declared.some(dataset=>{try{return canonicalResearchJson(JSON.parse(sources[datasets.indexOf(dataset)].toString('utf8')))===canonicalResearchJson(step.arguments);}catch{return false;}});
      if(filePaths.length ? !fileBound : !inlineBound) throw new Error(`DATASET_ARGUMENT_MISMATCH: ${step.id} must bind its actual file inputs or an exact JSON snapshot of its inline arguments.`);
    }
    const fingerprint = await deps.fingerprint({tool:step.tool,arguments:step.arguments});
    if(fingerprint.ok!==true || !fingerprint.materials?.runtime || !fingerprint.materials?.implementation) throw new Error('RUNTIME_FINGERPRINT_UNAVAILABLE');
    const runtimeSha256 = researchHash({runtime:fingerprint.materials.runtime,implementation:fingerprint.materials.implementation});
    runtimeFingerprints[step.tool]=runtimeSha256;
    const {stepId: _, ...semanticFields} = semantic;
    steps.push({...step,...semanticFields,methodIdentity:{contractSha256:deriveMethodContract(method).contractSha256,runtimeSha256}});
  }
  return {spec:{schemaVersion:'proto.study-spec.v1',studyId,title:draft.workflow.name,question,datasets,steps,proofObligations:[]} as StudySpec,facts:{runtimeFingerprints,datasetFingerprints},sources};
}
async function checkCurrent(workspace: string, spec: StudySpec, deps: ManagedResearchDependencies) {
  const catalog=await planCatalog(spec.steps.map(step=>step.tool),deps);
  const prepared=await prepareSpec(workspace,spec.studyId,spec.question,{workflow:{name:spec.title,description:spec.question,steps:spec.steps.map(({id,title,tool,arguments:args,bindings})=>({id,title,tool,arguments:args,bindings}))},datasets:spec.datasets.map(({sha256:_,...dataset})=>dataset),stepSemantics:spec.steps.map(({id,role,supersededReason,datasetIds,assumptions})=>({stepId:id,role,...(supersededReason?{supersededReason}:{}),datasetIds,assumptions}))},catalog,deps);
  const result=compileResearchPlan(spec,catalog,prepared.facts);
  if(!result.ok) throw new Error(`PLAN_STALE: ${result.diagnostics.map(item=>`${item.code}: ${item.message}`).join('; ')}`);
}
async function planCatalog(methods: string[], deps: ManagedResearchDependencies): Promise<ComputeCatalog> {
  const tools: ComputeCatalog['tools']=[];
  for(const method of new Set(methods)) {
    const catalog=await deps.catalog(method);
    if(!catalog.ok || catalog.execution==='recorded') throw new Error('CATALOG_NOT_CURRENT');
    const matches=catalog.tools.filter(tool=>tool.id===method);
    if(matches.length!==1)throw new Error(`METHOD_UNAVAILABLE: ${method}`);
    tools.push(matches[0]);
  }
  return {ok:true,execution:'local',tools,upstream:{}};
}
async function collectEvidence(store: ResearchProjectStore, studyId: string, inspected: ManagedResearchEvidence, studies: (request: Parameters<typeof requestComputeStudies>[1])=>ReturnType<typeof requestComputeStudies>): Promise<NonNullable<ManagedResearchResponse['evidence']>> {
  const evidence: NonNullable<ManagedResearchResponse['evidence']> = {verifiedRuns:inspected.verifiedRuns,missingRuns:inspected.missingRuns,sourceFreshness:inspected.sourceFreshness,integrity:'incomplete',scientificReview:'unreviewed',objects:[]};
  for(const {run:opened} of inspected.runs) {
    const versionId=`run-${studyId}-${opened.runId}-${opened.binding!.resultSha256}`;
    const existing=store.listVersions(studyId,'run-evidence').find(record=>record.versionId===versionId);
    const record=existing?store.getVersion(versionId):store.appendVersion({studyId,kind:'run-evidence',versionId,value:{schema:'proto.retained-run-evidence.v1',runId:opened.runId,request:opened.request,receipt:opened.receipt,binding:opened.binding,scope:'unsigned-result-copy; not transferred execution authority'}});
    evidence.objects.push({runId:opened.runId,sha256:record.object.sha256});
    const current=(await studies({action:'get',studyId})).study;
    if(current&&!current.links.some(link=>link.runId===opened.runId))await studies({action:'link',studyId,expectedRevision:current.revision,runId:opened.runId});
  }
  evidence.sourceFreshness=[...new Set(evidence.sourceFreshness)];
  evidence.integrity=evidence.verifiedRuns>0 && evidence.missingRuns===0?'verified':'incomplete';
  return evidence;
}
