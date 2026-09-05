// Persisted/manual review boundaries that remain after the autonomous loop migration.
// Service lifecycle, scoped writes and explicit completion are covered by
// agent-harness-service.test.mjs; see docs/harness-test-migration.md.
import assert from "node:assert/strict";
import test from "node:test";
import { AgentService } from "../src/main/services/agent-service.ts";
import * as agentModule from "../src/main/services/agent-service.ts";
import { AppDatabase } from "../src/main/services/database.ts";

test("an orphaned persisted approval is invalidated instead of being executed by a rebuilt service", async () => {
  const database = new AppDatabase(":memory:");
  const approval = {
    id: "orphaned-approval",
    runId: "old-run",
    threadId: "old-thread",
    workspacePath: "C:\\old-workspace",
    serviceSessionId: "old-service-session",
    tool: "proto_run_python",
    arguments: { path: "scripts/untrusted.py" },
    argumentsSha256: "0".repeat(64),
    risk: "code-execution",
    status: "pending",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  database.saveApproval(approval);
  let toolCalls = 0;
  const agent = new AgentService(
    database,
    { get: () => undefined, getActiveModel: () => undefined },
    { read: async () => { throw new Error("No policy fixture"); } },
    { tools: async () => [], call: async () => { toolCalls += 1; return { ok: true }; } },
    () => {},
    undefined,
    "C:\\new-workspace",
  );

  await assert.rejects(agent.resolveApproval(approval.id, "approved"), /not bound to this live workspace request/);
  assert.equal(database.getApproval(approval.id).status, "stale");
  assert.equal(toolCalls, 0);
  database.close();
});


test("an incomplete non-Proto artifact is blocked again at approval time", () => {
  const database = new AppDatabase(":memory:");
  const model = { id: "approval-gate-model", name: "Approval gate model" };
  const models = { get: () => model, getActiveModel: () => model, setToolCapability: () => {} };
  const workspace = { read: async () => { throw new Error("No optional policy fixture"); }, canonicalRootPath: async () => "C:\\test-workspace" };
  const mcp = { tools: async () => [], call: async () => ({ ok: true }) };
  const agent = new AgentService(database, models, workspace, mcp, () => {});
  const runId = "approval-gate-run";
  database.appendEvent({
    id: "approval-gate-goal",
    runId,
    stage: "goal",
    actor: "user",
    title: "Goal defined",
    summary: "The dossier must include: corrected goal; high-level pathway architecture; requirement-to-evidence matrix with source identifiers; inventory table; chassis and burden assumptions; toolchain coverage gaps; failure modes; unresolved scientific questions; software validation criteria; and safety boundary. Decision rule: return GO or NO-GO.",
    inputProvenance: [],
    outputArtifacts: [],
    evidenceIds: [],
    status: "completed",
    createdAt: "2026-07-13T00:00:00.000Z",
    completedAt: "2026-07-13T00:00:00.000Z",
  });
  const patch = {
    id: "incomplete-approval-patch",
    runId,
    targetPath: "C:\\test-workspace\\analyses\\review.md",
    baseSha256: "base",
    before: "",
    after: "# Review\n\n## Corrected Goal\n\nA truncated claim (",
    unifiedDiff: "+# Review",
    rationale: "Review dossier",
    status: "pending",
    createdAt: "2026-07-13T00:00:00.000Z",
  };
  database.savePatch(patch);

  assert.throws(
    () => agent.assertPatchReadyForApproval(patch.id),
    /Artifact is incomplete and cannot be approved:.*requirement-to-evidence matrix.*safety boundary/i,
  );
  database.close();
});


test("evidence-sensitive artifacts require claim tags and tool-returned source IDs", () => {
  const database = new AppDatabase(":memory:");
  const model = { id: "grounding-gate-model", name: "Grounding gate model" };
  const models = { get: () => model, getActiveModel: () => model, setToolCapability: () => {} };
  const workspace = { read: async () => { throw new Error("No optional policy fixture"); }, canonicalRootPath: async () => "C:\\test-workspace" };
  const mcp = { tools: async () => [], call: async () => ({ ok: true }) };
  const agent = new AgentService(database, models, workspace, mcp, () => {});
  const runId = "grounding-gate-run";
  const baseEvent = {
    runId,
    inputProvenance: [],
    outputArtifacts: [],
    status: "completed",
    createdAt: "2026-07-13T00:00:00.000Z",
    completedAt: "2026-07-13T00:00:00.000Z",
  };
  database.appendEvent({
    ...baseEvent,
    id: "grounding-goal",
    stage: "goal",
    actor: "user",
    title: "Goal defined",
    summary: "The dossier must include corrected goal, high-level pathway architecture, chassis and burden assumptions, failure modes, and a safety boundary. Cite only exact evidence identifiers actually returned by tools and preserve identifier namespaces.",
    evidenceIds: [],
  });
  database.appendEvent({
    ...baseEvent,
    id: "grounding-source",
    stage: "plan",
    actor: "tool",
    title: "Europe PMC Search",
    summary: "Tool completed.",
    evidenceIds: ["PMID:34181032", "UniProt:P00001", "RHEA:12345"],
  });
  const completeBody = (architectureLine) => [
    "# Review",
    "## Corrected Goal",
    "Review a metabolite-production software concept.",
    "## High-Level Pathway Architecture",
    architectureLine,
    "## Chassis and Burden Assumptions",
    "[Assumption] Chassis burden remains a review assumption.",
    "## Failure Modes",
    "- [Unsupported] No returned source established a chassis-specific failure mode.",
    "## Safety Boundary",
    "Software and evidence review only.",
  ].join("\n\n");
  const patch = {
    id: "grounding-patch",
    runId,
    targetPath: "C:\\test-workspace\\analyses\\grounding.md",
    baseSha256: "base",
    before: "",
    after: `${completeBody("A hydroxylation route is established.")}\n\nworkspace_propose_patch with path analyses/grounding.md`,
    unifiedDiff: "+# Review",
    rationale: "Review dossier",
    status: "pending",
    createdAt: "2026-07-13T00:00:00.000Z",
  };
  database.savePatch(patch);

  assert.throws(
    () => agent.assertPatchReadyForApproval(patch.id),
    /tool-call narration|ungrounded scientific claim/i,
  );

  patch.after = completeBody("[Supported: DOI:10.1000/not-returned] A hydroxylation route is established.");
  database.savePatch(patch);
  assert.throws(
    () => agent.assertPatchReadyForApproval(patch.id),
    /identifiers not returned by tools: DOI:10.1000\/not-returned/i,
  );

  patch.after = completeBody("[Assumption] Tyrosine decarboxylase converts tyrosine to L-DOPA.");
  database.savePatch(patch);
  assert.throws(
    () => agent.assertPatchReadyForApproval(patch.id),
    /biochemical relation claim.*exact returned source.*Unresolved/i,
  );

  patch.after = `${completeBody("[Unresolved] Whether any enzyme converts tyrosine to L-DOPA is not established by returned evidence.")}\n\nInventory evidence: P00001 and 12345.`;
  database.savePatch(patch);
  assert.throws(
    () => agent.assertPatchReadyForApproval(patch.id),
    /source identifier lost its namespace.*UniProt:P00001/i,
  );

  patch.after = completeBody("[Unresolved] Whether any enzyme converts tyrosine to L-DOPA is not established by returned evidence.")
    .replace("Software and evidence review only.", "Select a non-pathogenic strain and dispose biological waste according to local rules.");
  database.savePatch(patch);
  assert.throws(
    () => agent.assertPatchReadyForApproval(patch.id),
    /imperative wet-lab recommendation/i,
  );

  patch.after = `${completeBody("[Supported: PMID:34181032] The returned publication discusses enzyme selection context.")}\n\nInventory evidence: UniProt:P00001 and RHEA:12345.`;
  database.savePatch(patch);
  assert.doesNotThrow(() => agent.assertPatchReadyForApproval(patch.id));
  database.close();
});


test("fail-closed dossier keeps software status separate from scientific NO-GO", () => {
  const database = new AppDatabase(":memory:");
  const model = { id: "decision-gate-model", name: "Decision gate model" };
  const agent = new AgentService(
    database,
    { get: () => model, getActiveModel: () => model, setToolCapability: () => {} },
    { read: async () => { throw new Error("No optional policy fixture"); } },
    { tools: async () => [], call: async () => ({ ok: true }) },
    () => {},
  );
  const runId = "decision-gate-run";
  database.appendEvent({
    id: "decision-gate-goal",
    runId,
    stage: "goal",
    actor: "user",
    title: "Goal defined",
    summary: "Apply a fail-closed decision rule and declare NO-GO if identifiers are absent. Report software_pipeline_status separately from scientific_design_decision. The dossier must include a safety boundary.",
    inputProvenance: [],
    outputArtifacts: [],
    evidenceIds: [],
    status: "completed",
    createdAt: "2026-08-18T00:00:00.000Z",
    completedAt: "2026-08-18T00:00:00.000Z",
  });
  const patch = {
    id: "decision-gate-patch",
    runId,
    targetPath: "C:\\test-workspace\\analyses\\decision.md",
    baseSha256: "base",
    before: "",
    after: "# Review\n\n## Decision\n\nPass with warnings.\n\n## Safety Boundary\n\nSoftware review only.",
    unifiedDiff: "+# Review",
    rationale: "Review dossier",
    status: "pending",
    createdAt: "2026-08-18T00:00:00.000Z",
  };
  database.savePatch(patch);
  assert.throws(
    () => agent.assertPatchReadyForApproval(patch.id),
    /scientific design decision must remain NO-GO.*software_pipeline_status.*scientific_design_decision/i,
  );

  patch.after = "# Review\n\nsoftware_pipeline_status: PASS\n\n## Decision\n\nscientific_design_decision: NO-GO.\n\n## Safety Boundary\n\nSoftware and evidence review only; human approval remains required.";
  database.savePatch(patch);
  assert.doesNotThrow(() => agent.assertPatchReadyForApproval(patch.id));
  database.close();
});

test("retired topic-specific fallback generators are absent from the production module", () => {
  for (const name of ["automaticSafetyDossierRequest", "buildFailClosedEvidenceDossier", "failClosedEmptyResponse", "planOfflineCoverageCalls"]) assert.equal(name in agentModule, false);
});


test("an approved non-Proto artifact receives explicit validation and review boundaries", async () => {
  const database = new AppDatabase(":memory:");
  const model = { id: "review-model", name: "Review model" };
  let mcpCalls = 0;
  const models = { get: () => model, getActiveModel: () => model, setToolCapability: () => {} };
  const workspace = { read: async () => { throw new Error("No optional policy fixture"); }, canonicalRootPath: async () => "C:\\test-workspace" };
  const mcp = { tools: async () => [], call: async () => { mcpCalls += 1; return { ok: true }; } };
  const agent = new AgentService(database, models, workspace, mcp, () => {});
  const patch = {
    id: "artifact-patch",
    runId: "artifact-run",
    targetPath: "C:\\test-workspace\\analyses\\stress.md",
    baseSha256: "base",
    before: "",
    after: "# Review",
    unifiedDiff: "+# Review",
    rationale: "Approve dossier",
    status: "approved",
    createdAt: "2026-07-13T00:00:00.000Z",
  };

  const events = await agent.afterPatchApplied(patch);
  const review = database.getReview(patch.runId);
  const durableEvents = database.getRunEvents(patch.runId);

  assert.deepEqual(events.map((event) => event.stage), ["design", "validate", "review"]);
  assert.deepEqual(durableEvents.map((event) => event.stage), ["design", "validate", "review"]);
  assert.ok(durableEvents.every((event) => event.status === "approved" || event.status === "completed"));
  assert.equal(mcpCalls, 0);
  assert.equal(review.packetPath, patch.targetPath);
  assert.equal(review.gate, "review-required");
  assert.match(review.summary, /Proto check, compile, and workflow validation were not run/);
  database.close();
});


test("failed Proto validation is durably recorded before review is blocked", async () => {
  const database = new AppDatabase(":memory:");
  const model = { id: "validation-failure-model", name: "Validation failure model" };
  const models = { get: () => model, getActiveModel: () => model, setToolCapability: () => {} };
  const workspace = { read: async () => { throw new Error("No optional policy fixture"); }, canonicalRootPath: async () => "C:\\test-workspace" };
  const calls = [];
  const mcp = {
    tools: async () => [],
    call: async (name) => {
      calls.push(name);
      return { ok: false, diagnostics: [{ code: "TEST_FAILURE", message: "Deterministic fixture failure." }] };
    },
  };
  const agent = new AgentService(database, models, workspace, mcp, () => {});
  const patch = {
    id: "failed-proto-patch",
    runId: "failed-proto-run",
    targetPath: "C:\\test-workspace\\designs\\failed.proto",
    baseSha256: "base",
    before: "",
    after: "design failed_fixture chassis ecoli_k12\n",
    unifiedDiff: "+design failed_fixture chassis ecoli_k12",
    rationale: "Exercise a deterministic validation failure.",
    status: "approved",
    createdAt: "2026-08-30T00:00:00.000Z",
  };

  const events = await agent.afterPatchApplied(patch);
  const durableEvents = database.getRunEvents(patch.runId);
  const review = database.getReview(patch.runId);

  assert.deepEqual(calls, ["proto_check"]);
  assert.deepEqual(events.map((event) => event.status), ["approved", "failed"]);
  assert.deepEqual(durableEvents.map((event) => event.status), ["approved", "failed"]);
  assert.equal(review.gate, "blocked");
  assert.match(review.summary, /validation failed/i);
  database.close();
});
