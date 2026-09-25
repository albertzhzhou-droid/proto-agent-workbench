import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { ManagedMcpTestClient } from './helpers/managed-mcp.mjs';
import { PDB_FIXTURE } from './helpers/protein-structure-fixture.mjs';
import { createResearchWorkflowService } from '../src/main/services/research-workflow-runtime.ts';
import { managedResearchDependencies } from '../src/main/services/managed-research-runtime.ts';
import { requestManagedResearch } from '../src/main/services/research-study-commands.ts';
import { requestComputeStudies } from '../src/main/services/compute-studies.ts';
import { ResearchProjectStore } from '../src/main/services/research-project-store.ts';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const python = process.env.PROTO_AGENT_PYTHON || join(repo, process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// Two independent existing development examples exercise protein method routing
// and file provenance. They do not represent the same protein or a biological
// reference study. No alignment inference, prediction, GPU or network is used.
test('managed protein software references preserve alignment and actual PDB file bindings through CPU execution and capsule reopening', { timeout: 180_000 }, async t => {
  const parent = join(repo, 'build', 'next-architecture-20260924');
  await mkdir(parent, { recursive: true });
  const workspace = await mkdtemp(join(parent, 'managed-protein-cpu-'));
  const clients = [];
  const createClient = () => {
    const client = new ManagedMcpTestClient({ packaged: false, resourcesPath: '', repoRoot: repo,
      workspacePath: workspace, workspaceCapability: randomBytes(32).toString('hex'),
      materialsRoot: join(workspace, 'isolated-materials'), pythonExecutable: python,
    }, { startupTimeoutMs: 10_000, controlTimeoutMs: 10_000 });
    clients.push(client); return client;
  };
  let workflows = createResearchWorkflowService(workspace, createClient);
  let deps = managedResearchDependencies(workspace, createClient, workflows, () => true);
  const invoke = request => requestManagedResearch(workspace, request, deps);
  const evidence = { schema: 'proto.managed-protein-cpu-reference-test.v1', workspace, python, status: 'running',
    scope: 'two independent development examples; CPU source-runtime and provenance reference only; no biological-quality or Protein Studio acceptance',
    fixtures: ['src/proto_agent/compute_protein_study.py:TOOLS.analyze_protein_comparison.example',
      'apps/proto-workbench/tests/helpers/protein-structure-fixture.mjs:PDB_FIXTURE'] };
  try {
    const catalog = await deps.catalog('analyze_protein_comparison');
    const method = catalog.tools.find(tool => tool.id === 'analyze_protein_comparison');
    assert.equal(method.available, true);
    assert.equal(Object.keys(method.file_inputs ?? {}).length, 0, 'the alignment method currently accepts inline JSON, not a FASTA file');
    const alignment = method.example;
    assert.deepEqual(alignment.aligned_sequences.map(row => row.name), ['example-a', 'example-b', 'example-c']);
    const alignmentPath = 'sources/development-alignment.json', pdbPath = 'sources/software-test-fixture.pdb', pdbCopyPath = 'sources/software-test-fixture-copy.pdb';
    // The provenance ledger rejects duplicate claims on one physical file.
    // These are two independently retained, byte-identical fixture files.
    const sources = new Map([[alignmentPath, Buffer.from(`${JSON.stringify(alignment)}\n`)],
      [pdbPath, Buffer.from(PDB_FIXTURE)], [pdbCopyPath, Buffer.from(PDB_FIXTURE)]]);
    await mkdir(join(workspace, 'sources'));
    for (const [path, bytes] of sources) await writeFile(join(workspace, path), bytes);
    const created = await invoke({ action: 'create', name: 'Protein CPU software references',
      question: 'Can the existing toy alignment and independent PDB self-comparison retain exact source identities and their inspectable reference results?' });
    evidence.studyId = created.study.id;
    const draft = {
      workflow: { name: 'Protein development reference branches',
        description: 'Independent alignment and structural self-comparison examples; no biological relationship is asserted.',
        steps: [
          { id: 'alignment', title: 'Development protein alignment', tool: 'analyze_protein_comparison', arguments: alignment, bindings: [] },
          { id: 'structure', title: 'Development PDB self-comparison', tool: 'compare_protein_structures',
            arguments: { structure_a_path: pdbPath, structure_b_path: pdbCopyPath }, bindings: [] },
        ] },
      datasets: [
        { id: 'alignment-source', version: 1, sourcePath: alignmentPath, entityIds: alignment.aligned_sequences.map(row => row.name),
          units: ['1'], referenceVersion: 'existing-catalog-development-example-v1' },
        { id: 'structure-source', version: 1, sourcePath: pdbPath, entityIds: ['software-test-fixture'],
          units: ['angstrom'], referenceVersion: 'existing-pdb-software-fixture-v1' },
        { id: 'structure-source-copy', version: 1, sourcePath: pdbCopyPath, entityIds: ['software-test-fixture'],
          units: ['angstrom'], referenceVersion: 'existing-pdb-software-fixture-v1' },
      ],
      stepSemantics: [
        { stepId: 'alignment', role: 'required', datasetIds: ['alignment-source'],
          assumptions: ['Existing named toy sequences are already aligned. They do not establish homology, eligibility or biological function.'] },
        { stepId: 'structure', role: 'required', datasetIds: ['structure-source', 'structure-source-copy'],
          assumptions: ['Two separate files contain the same existing three-CA software fixture. They are independent of the alignment example; expected RMSD is approximately zero.'] },
      ],
    };
    const compiled = await invoke({ action: 'compile', studyId: created.study.id, expectedStudyRevision: created.study.revision, draft });
    assert.ok(compiled.plan, JSON.stringify(compiled));
    assert.deepEqual(compiled.diagnostics, []);
    assert.equal(compiled.preview.canStart, true, JSON.stringify(compiled.preview));
    evidence.planId = compiled.plan.id;
    const started = await invoke({ action: 'start', studyId: created.study.id, planId: compiled.plan.id,
      expectedPreviewSha256: compiled.preview.planSha256 });
    await workflows.wait(started.execution.id);
    const requestEvidence = { action: 'execution', studyId: created.study.id, planId: compiled.plan.id, executionId: started.execution.id };
    const completed = await invoke(requestEvidence);
    assert.equal(completed.execution.status, 'succeeded', JSON.stringify(completed));
    assert.equal(completed.evidence.verifiedRuns, 2, JSON.stringify(completed));
    assert.equal(completed.evidence.missingRuns, 0);
    assert.equal(completed.evidence.integrity, 'verified');
    assert.equal(completed.evidence.scientificReview, 'unreviewed');
    assert.deepEqual(completed.evidence.sourceFreshness, ['current']);
    assert.equal(completed.completion.complete, true, JSON.stringify(completed.completion));
    assert.deepEqual(completed.diagnostics, []);
    const outputs = new Map();
    for (const step of completed.execution.steps) {
      assert.equal(step.status, 'succeeded');
      const opened = (await requestComputeStudies(workspace, { action: 'open-run', runId: step.runId })).run;
      assert.equal(opened.integrity.status, 'verified');
      assert.equal(opened.receipt.execution_fingerprint.verified_unchanged, true);
      assert.equal(opened.sourceFreshness.status, 'current');
      outputs.set(step.stepId, opened);
    }
    const comparison = outputs.get('alignment').receipt.result;
    assert.equal(comparison.sequence_count, 3);
    assert.equal(comparison.alignment_length, 12);
    assert.deepEqual(comparison.alignment[1].alignment_to_sequence.slice(0, 5), [0, 1, null, 2, 3]);
    assert.equal(comparison.alignment[1].ungapped_sequence, 'ACEFGHIKLMN');
    assert.ok(Math.abs(comparison.conservation.columns[2].conservation_fraction - 2 / 3) < 1e-12);
    assert.deepEqual(comparison.phylogeny.tree_graph.nodes.filter(node => node.name).map(node => node.name).sort(), ['example-a', 'example-b', 'example-c']);
    const structure = outputs.get('structure').receipt.result;
    assert.equal(structure.common_residues, 3);
    assert.ok(structure.ca_rmsd_a < 1e-8, JSON.stringify(structure));
    assert.equal(structure.mapping.sequence_identity, 1);
    assert.equal(structure.per_residue[0].residue_a.residue_number, 10);
    const fileClaims = outputs.get('structure').sourceFreshness.details.filter(item => item.name.startsWith('file:'));
    assert.deepEqual(fileClaims.map(item => item.name).sort(), ['file:structure_a_path', 'file:structure_b_path']);
    assert.deepEqual(fileClaims.map(item => item.path).sort(), [pdbPath, pdbCopyPath].sort());
    assert.ok(fileClaims.every(item => item.expectedSha256 === sha256(sources.get(item.path)) && item.status === 'current'));

    await workflows.close();
    workflows = createResearchWorkflowService(workspace, createClient);
    deps = managedResearchDependencies(workspace, createClient, workflows, () => true);
    const inspected = await invoke({ action: 'inspect-plan', studyId: created.study.id, planId: compiled.plan.id });
    assert.equal(inspected.execution.id, started.execution.id);
    const reopened = await invoke(requestEvidence);
    assert.deepEqual(reopened.evidence, completed.evidence);
    assert.equal(reopened.completion.complete, true);
    const exported = await invoke({ action: 'capsule', studyId: created.study.id, mode: 'full' });
    const capsuleBytes = await readFile(join(workspace, exported.capsule.path));
    assert.equal(sha256(capsuleBytes), exported.capsule.sha256);
    const importedWorkspace = join(workspace, 'imported-project'); await mkdir(importedWorkspace);
    const target = ResearchProjectStore.open(importedWorkspace);
    try {
      const report = target.importCapsule(capsuleBytes);
      assert.equal(report.integrity, 'verified');
      assert.equal(report.authority, 'imported-unverified-no-execution-or-review-grants');
      const plan = target.getVersion(compiled.plan.id);
      assert.equal(plan.origin, 'imported-unverified');
      assert.equal(plan.references.length, 2);
      for (const bytes of sources.values()) {
        const identity = plan.references.find(item => item.sha256 === sha256(bytes));
        assert.ok(identity); assert.deepEqual(target.readObject(identity), bytes);
      }
      assert.equal(target.listVersions(created.study.id, 'run-evidence').length, 2);
      assert.equal(target.listVersions(created.study.id, 'evidence-graph').length, 1);
      evidence.capsule = { ...exported.capsule, import: report };
    } finally { target.close(); }

    // Changed PDB bytes invalidate only the structural branch's freshness. The
    // retained reference run and independent alignment remain inspectable.
    await writeFile(join(workspace, pdbCopyPath), PDB_FIXTURE.replace('SOFTWARE TEST FIXTURE', 'MODIFIED SOFTWARE TEST FIXTURE'));
    const stale = await invoke(requestEvidence);
    assert.equal(stale.evidence.integrity, 'verified');
    assert.equal(stale.completion.complete, false);
    assert.equal(stale.graph.nodes.find(node => node.kind === 'artifact' && node.stepId === 'alignment').freshness, 'current');
    assert.equal(stale.graph.nodes.find(node => node.kind === 'artifact' && node.stepId === 'structure').freshness, 'stale');
    await assert.rejects(invoke({ action: 'preview', studyId: created.study.id, planId: compiled.plan.id }), /PLAN_STALE/);
    evidence.fileMutation = { structuralFreshness: 'stale', independentAlignmentFreshness: 'current', retainedIntegrity: 'verified', previewRejected: true };
    const journal = new DatabaseSync(join(workspace, 'build', '.proto', 'execution.sqlite'), { readOnly: true });
    try {
      const runs = journal.prepare("SELECT operation_id,state,outcome,scope_surface FROM tool_execution_journal WHERE tool='proto_compute_run'").all();
      assert.equal(runs.length, 2);
      assert.ok(runs.every(row => row.state === 'completed' && row.outcome === 'ok' && row.scope_surface === 'workflow'));
      assert.deepEqual(runs.map(row => row.operation_id).sort(), completed.execution.steps.map(step => step.operationId).sort());
    } finally { journal.close(); }
    evidence.status = 'passed';
    evidence.executionId = started.execution.id;
    evidence.actual = { sequenceCount: comparison.sequence_count, alignmentLength: comparison.alignment_length,
      gapColumnConservation: comparison.conservation.columns[2].conservation_fraction,
      commonCaResidues: structure.common_residues, selfComparisonRmsdAngstrom: structure.ca_rmsd_a,
      verifiedRuns: completed.evidence.verifiedRuns, fileClaims, completionBeforeMutation: completed.completion };
  } catch (error) {
    evidence.status = 'failed'; evidence.error = { message: error.message, stack: error.stack }; throw error;
  } finally {
    await workflows.close();
    await Promise.allSettled(clients.map(client => client.stop()));
    await writeFile(join(workspace, 'acceptance.json'), `${JSON.stringify(evidence, null, 2)}\n`);
    t.diagnostic(`Retained protein CPU reference evidence: ${join(workspace, 'acceptance.json')}`);
  }
});
