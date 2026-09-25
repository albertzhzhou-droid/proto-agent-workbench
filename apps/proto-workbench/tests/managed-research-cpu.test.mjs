import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { ManagedMcpTestClient } from './helpers/managed-mcp.mjs';
import { createResearchWorkflowService } from '../src/main/services/research-workflow-runtime.ts';
import { managedResearchDependencies } from '../src/main/services/managed-research-runtime.ts';
import { requestManagedResearch } from '../src/main/services/research-study-commands.ts';
import { ResearchProjectStore } from '../src/main/services/research-project-store.ts';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const python = process.env.PROTO_AGENT_PYTHON || join(repo, process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// This test intentionally requires the existing native Python runtime. Missing or
// broken runtime dependencies fail the test; no install, network or GPU is used.
test('a managed Study executes a real CPU reference and reopens retained evidence and a full capsule', { timeout: 120_000 }, async t => {
  const parent = join(repo, 'build', 'next-architecture-20260924');
  await mkdir(parent, { recursive: true });
  const workspace = await mkdtemp(join(parent, 'managed-cpu-'));
  const importedWorkspace = join(workspace, 'imported-project');
  const clients = [];
  const createClient = () => {
    const client = new ManagedMcpTestClient({
      packaged: false, resourcesPath: '', repoRoot: repo, workspacePath: workspace,
      workspaceCapability: randomBytes(32).toString('hex'),
      materialsRoot: join(workspace, 'isolated-materials'), pythonExecutable: python,
    }, { startupTimeoutMs: 10_000, controlTimeoutMs: 10_000 });
    clients.push(client);
    return client;
  };
  let workflows = createResearchWorkflowService(workspace, createClient);
  let deps = managedResearchDependencies(workspace, createClient, workflows, () => true);
  const invoke = request => requestManagedResearch(workspace, request, deps);
  const evidence = { schema: 'proto.managed-cpu-reference-test.v1', workspace, python,
    scope: 'source-runtime CPU reference; not scientific, model, GPU or packaged-release acceptance',
    status: 'running', expectedMean: 3 };
  try {
    const source = { values: [1, 2, 3, 4, 5] };
    const sourceBytes = Buffer.from(`${JSON.stringify(source)}\n`);
    const sourcePath = 'sources/synthetic-observations.json';
    await mkdir(join(workspace, 'sources'));
    await writeFile(join(workspace, sourcePath), sourceBytes);
    const created = await invoke({ action: 'create', name: 'Synthetic CPU reference',
      question: 'Can the retained observations 1 to 5 reproduce the reference mean of 3?' });
    assert.ok(created.study);
    evidence.studyId = created.study.id;
    const draft = {
      workflow: { name: 'Synthetic mean reference', description: 'Software reference with no biological inference.',
        steps: [{ id: 'summary', title: 'Descriptive statistics', tool: 'descriptive_statistics', arguments: source, bindings: [] }] },
      datasets: [{ id: 'observations', version: 1, sourcePath, entityIds: ['synthetic-series'], units: ['1'], referenceVersion: 'synthetic-reference-v1' }],
      stepSemantics: [{ stepId: 'summary', role: 'required', datasetIds: ['observations'],
        assumptions: ['Synthetic observations 1 through 5. The exact arithmetic mean is 3. No biological inference.'] }],
    };
    const compiled = await invoke({ action: 'compile', studyId: created.study.id, expectedStudyRevision: created.study.revision, draft });
    assert.ok(compiled.plan, JSON.stringify(compiled));
    assert.deepEqual(compiled.diagnostics, []);
    assert.equal(compiled.preview.canStart, true, JSON.stringify(compiled.preview));
    evidence.planId = compiled.plan.id;
    const preview = await invoke({ action: 'preview', studyId: created.study.id, planId: compiled.plan.id });
    assert.equal(preview.preview.canStart, true);
    assert.match(preview.preview.planSha256, /^[a-f0-9]{64}$/);
    const started = await invoke({ action: 'start', studyId: created.study.id, planId: compiled.plan.id,
      expectedPreviewSha256: preview.preview.planSha256 });
    assert.ok(started.execution);
    evidence.executionId = started.execution.id;
    await workflows.wait(started.execution.id);
    const requestEvidence = { action: 'execution', studyId: created.study.id, planId: compiled.plan.id, executionId: started.execution.id };
    const completed = await invoke(requestEvidence);
    assert.equal(completed.execution.status, 'succeeded', JSON.stringify(completed));
    assert.equal(completed.execution.steps[0].status, 'succeeded', JSON.stringify(completed.execution));
    assert.equal(completed.evidence.verifiedRuns, 1, JSON.stringify(completed));
    assert.equal(completed.evidence.missingRuns, 0);
    assert.equal(completed.evidence.integrity, 'verified');
    assert.equal(completed.evidence.scientificReview, 'unreviewed');
    assert.deepEqual(completed.evidence.sourceFreshness, ['current']);
    assert.equal(completed.completion.complete, true, JSON.stringify(completed.completion));
    assert.deepEqual(completed.diagnostics, []);
    assert.ok(completed.graph.edges.some(edge => edge.type === 'produces'));
    assert.ok(completed.study.links.some(link => link.runId === completed.execution.steps[0].runId));

    const store = ResearchProjectStore.open(workspace);
    let retainedRun, retainedGraph, frozenPlan;
    try {
      const runs = store.listVersions(created.study.id, 'run-evidence');
      assert.equal(runs.length, 1);
      retainedRun = store.getVersion(runs[0].versionId);
      assert.equal(retainedRun.value.receipt.result.mean, 3);
      assert.equal(retainedRun.value.receipt.execution_fingerprint.verified_unchanged, true);
      assert.deepEqual(retainedRun.value.request, { tool: 'descriptive_statistics', arguments: source });
      frozenPlan = store.getVersion(compiled.plan.id);
      assert.equal(frozenPlan.references.length, 1);
      assert.equal(frozenPlan.references[0].sha256, sha256(sourceBytes));
      assert.deepEqual(store.readObject(frozenPlan.references[0]), sourceBytes);
      const graphs = store.listVersions(created.study.id, 'evidence-graph');
      assert.equal(graphs.length, 1);
      retainedGraph = store.getVersion(graphs[0].versionId);
      assert.deepEqual(retainedGraph.value.graph, completed.graph);
      assert.equal(retainedGraph.value.completion.complete, true);
    } finally { store.close(); }

    // Reopen the workflow host and both SQLite stores. No rerun is necessary to
    // regain the same evidence, and reading it must not duplicate versions.
    await workflows.close();
    workflows = createResearchWorkflowService(workspace, createClient);
    deps = managedResearchDependencies(workspace, createClient, workflows, () => true);
    const reopened = await invoke(requestEvidence);
    assert.equal(reopened.execution.id, completed.execution.id);
    assert.deepEqual(reopened.evidence, completed.evidence);
    assert.deepEqual(reopened.completion, completed.completion);
    const exported = await invoke({ action: 'capsule', studyId: created.study.id, mode: 'full' });
    const capsuleBytes = await readFile(join(workspace, exported.capsule.path));
    assert.equal(sha256(capsuleBytes), exported.capsule.sha256);
    await mkdir(importedWorkspace);
    const target = ResearchProjectStore.open(importedWorkspace);
    try {
      const report = target.importCapsule(capsuleBytes);
      assert.equal(report.integrity, 'verified');
      assert.equal(report.authority, 'imported-unverified-no-execution-or-review-grants');
      const importedPlan = target.getVersion(compiled.plan.id);
      assert.equal(importedPlan.origin, 'imported-unverified');
      assert.deepEqual(importedPlan.value, frozenPlan.value);
      assert.deepEqual(target.readObject(importedPlan.references[0]), sourceBytes);
      assert.equal(target.getVersion(retainedRun.versionId).value.receipt.result.mean, 3);
      assert.equal(target.getVersion(retainedGraph.versionId).origin, 'imported-unverified');
      assert.equal(target.listVersions(created.study.id, 'run-evidence').length, 1);
      assert.equal(target.listVersions(created.study.id, 'evidence-graph').length, 1);
      evidence.capsule = { ...exported.capsule, import: report };
    } finally { target.close(); }
    await assert.rejects(access(join(importedWorkspace, 'build', '.proto', 'execution.sqlite')), { code: 'ENOENT' });

    // Keep the original receipt intact while independently changing the live
    // dataset. Historical evidence remains inspectable but cannot authorize a
    // new preview or run of this frozen plan.
    const originalRunPath = join(workspace, 'build', 'compute', completed.execution.steps[0].runId, 'result.json');
    const originalResultSha256 = sha256(await readFile(originalRunPath));
    await writeFile(join(workspace, sourcePath), `${JSON.stringify({ values: [999] })}\n`);
    const stalePlan = await invoke({ action: 'inspect-plan', studyId: created.study.id, planId: compiled.plan.id });
    assert.equal(stalePlan.plan.id, compiled.plan.id);
    assert.equal(stalePlan.execution.id, completed.execution.id);
    const staleEvidence = await invoke(requestEvidence);
    assert.equal(staleEvidence.evidence.integrity, 'verified');
    assert.equal(staleEvidence.evidence.verifiedRuns, 1);
    assert.deepEqual(staleEvidence.evidence.sourceFreshness, ['stale']);
    assert.equal(staleEvidence.completion.complete, false);
    assert.ok(staleEvidence.graph.nodes.some(node => node.kind === 'artifact' && node.integrity === 'verified' && node.freshness === 'stale'));
    assert.equal(sha256(await readFile(originalRunPath)), originalResultSha256);
    await assert.rejects(invoke({ action: 'preview', studyId: created.study.id, planId: compiled.plan.id }), /DATASET_ARGUMENT_MISMATCH|PLAN_STALE/);
    await assert.rejects(invoke({ action: 'start', studyId: created.study.id, planId: compiled.plan.id,
      expectedPreviewSha256: preview.preview.planSha256 }), /DATASET_ARGUMENT_MISMATCH|PLAN_STALE/);
    evidence.sourceMutation = { historicalResultSha256: originalResultSha256, retainedIntegrity: staleEvidence.evidence.integrity,
      currentSourceFreshness: staleEvidence.evidence.sourceFreshness, completionAfterMutation: staleEvidence.completion,
      previewRejected: true, startRejected: true };

    const journal = new DatabaseSync(join(workspace, 'build', '.proto', 'execution.sqlite'), { readOnly: true });
    try {
      const rows = journal.prepare('SELECT operation_id, tool, scope_surface, effect, state, outcome, decision_id, policy_decision_json FROM tool_execution_journal').all();
      assert.ok(rows.length > 0);
      assert.ok(rows.every(row => row.scope_surface === 'workflow' && row.state === 'completed' && row.outcome === 'ok'));
      assert.ok(rows.every(row => row.decision_id && JSON.parse(row.policy_decision_json).decisionId === row.decision_id));
      const computations = rows.filter(row => row.tool === 'proto_compute_run');
      assert.equal(computations.length, 1, 'reopening evidence and importing a capsule must not dispatch another computation');
      assert.equal(computations[0].operation_id, completed.execution.steps[0].operationId);
      assert.equal(computations[0].effect, 'write');
      evidence.journalOperations = rows.length;
      evidence.computeOperations = computations.length;
    } finally { journal.close(); }
    evidence.status = 'passed';
    evidence.actualMean = retainedRun.value.receipt.result.mean;
    evidence.completion = completed.completion;
    evidence.runId = completed.execution.steps[0].runId;
  } catch (error) {
    evidence.status = 'failed';
    evidence.error = { message: error.message, stack: error.stack };
    throw error;
  } finally {
    await workflows.close();
    await Promise.allSettled(clients.map(client => client.stop()));
    await writeFile(join(workspace, 'acceptance.json'), `${JSON.stringify(evidence, null, 2)}\n`);
    t.diagnostic(`Retained CPU reference evidence: ${join(workspace, 'acceptance.json')}`);
  }
});
