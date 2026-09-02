import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildDecisionBundle,
  exportDecisionBundle,
  serializeDecisionBundle,
  verifyDecisionBundle,
} from "../src/main/services/decision-bundle.ts";
import { buildPolicySimulation } from "../src/main/services/policy-simulation.ts";

function simulation() {
  return buildPolicySimulation({
    thread: {
      id: "thread-sensitive-id",
      workspacePath: "C:\\private\\workspace",
      title: "Decision bundle",
      mode: "act",
      modelId: "model-1",
      createdAt: "2026-08-31T00:00:00.000Z",
      updatedAt: "2026-08-31T00:00:00.000Z",
    },
    content: "Search PubMed and prepare a reviewed workspace patch without applying it.",
    attachments: [{ path: "C:\\private\\evidence.pdf", name: "evidence.pdf", mediaType: "application/pdf", sizeBytes: 42 }],
    model: {
      id: "model-1",
      name: "Local Agent",
      path: "C:\\private\\model.gguf",
      files: ["C:\\private\\model.gguf"],
      sizeBytes: 1,
      architecture: "fixture",
      quantization: "Q4",
      contextLength: 32768,
      vision: false,
      toolCapability: "agent-ready",
      fingerprint: "f".repeat(64),
      estimatedVramBytes: 1,
      loadState: "active",
      pinned: false,
      metadataSource: "filename",
    },
    runtime: { available: true, path: "C:\\private\\llama-server.exe", backend: "cuda", detail: "Ready" },
    moduleIntegrity: {
      ok: true,
      enforced: true,
      manifestPath: "module-manifest.json",
      manifestSha256: "a".repeat(64),
      checkedAt: "2026-08-31T00:00:00.000Z",
      modules: [{ moduleId: "core.audit", version: 1, core: true, status: "verified", disposition: "loaded", moduleSha256: "b".repeat(64), checkedArtifacts: 1, diagnostics: [] }],
    },
    visionModuleEnabled: false,
    workspaceUri: "file:///C:/private/workspace",
    capabilities: {
      workspace: "file:///C:/private/workspace",
      execution: { mode: "disabled", available: false, configured: false, provider_visible: false, smoke_verified: false, image_digest_pinned: false, reason: "Execution disabled." },
      networkPaths: ["proto_pubmed_search"],
      networkEnabled: false,
      networkAuthorization: "per-call-hmac-capability",
      filesystemSafety: { relativePathsOnly: true, reparsePointsAllowed: false, atomicReplace: true, windowsResidualSameUserRenameRace: true },
    },
    toolNames: ["workspace_read", "workspace_propose_patch", "proto_pubmed_search"],
  }, ["current", "plan-posture", "workspace-drift"]);
}

function options(redaction = "metadata-only") {
  return {
    selectedScenarioId: "workspace-drift",
    redaction,
    attachmentCount: 1,
    producerVersion: "1.0.0-test",
    moduleManifestSha256: "a".repeat(64),
  };
}

test("Decision Bundle is stable, in-toto-shaped, unsigned, and non-executable", () => {
  const first = buildDecisionBundle(simulation(), options());
  const second = buildDecisionBundle(simulation(), options());

  assert.equal(first.bundleDigest, second.bundleDigest);
  assert.equal(first.bundleId, second.bundleId);
  assert.equal(first.attestation._type, "https://in-toto.io/Statement/v1");
  assert.equal(first.attestation.subject[0].digest.sha256, simulation().digest);
  assert.equal(first.authentication.status, "unsigned");
  assert.equal(first.authentication.envelope, "none");
  assert.deepEqual(first.attestation.predicate.simulation.executedEffects, []);
  assert.match(first.boundary, /cannot start a model/i);
  assert.doesNotThrow(() => verifyDecisionBundle(first));
});

test("metadata-only redaction removes raw identifiers, goal preview, details, and warnings", () => {
  const report = simulation();
  const bundle = buildDecisionBundle(report, options("metadata-only"));
  const serialized = serializeDecisionBundle(bundle);

  assert.equal(bundle.attestation.predicate.goal.preview, null);
  assert.ok(bundle.attestation.predicate.selectedScenario.requirements.every((item) => item.detail === undefined));
  assert.ok(bundle.attestation.predicate.selectedScenario.deltas.every((item) => item.detail === undefined));
  assert.deepEqual(bundle.attestation.predicate.selectedScenario.warnings, []);
  assert.equal(bundle.redaction.pathsAlwaysRedacted, true);
  for (const secret of ["thread-sensitive-id", "C:\\private", "evidence.pdf", "model.gguf", "llama-server.exe", report.goalPreview]) {
    assert.equal(serialized.includes(secret), false, `unexpected sensitive value: ${secret}`);
  }
});

test("include-goal-preview remains path-redacted and changes the content address", () => {
  const report = simulation();
  const metadataOnly = buildDecisionBundle(report, options("metadata-only"));
  const included = buildDecisionBundle(report, options("include-goal-preview"));
  const serialized = serializeDecisionBundle(included);

  assert.equal(included.attestation.predicate.goal.preview, report.goalPreview);
  assert.ok(included.attestation.predicate.selectedScenario.requirements.some((item) => item.detail));
  assert.notEqual(included.bundleDigest, metadataOnly.bundleDigest);
  assert.equal(serialized.includes("C:\\private"), false);
  assert.equal(serialized.includes("thread-sensitive-id"), false);
});

test("Decision Bundle verification rejects payload and digest tampering", () => {
  const bundle = buildDecisionBundle(simulation(), options());
  const tampered = structuredClone(bundle);
  tampered.attestation.predicate.selectedScenario.state = "ready";
  assert.throws(() => verifyDecisionBundle(tampered), /digest does not match/i);

  const executable = structuredClone(bundle);
  executable.attestation.predicate.simulation.executedEffects.push("forged");
  assert.throws(() => verifyDecisionBundle(executable), /cannot contain executed effects/i);
});

test("Decision Bundle export writes immutable workspace artifacts and reuses exact content", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "proto-decision-bundle-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const bundle = buildDecisionBundle(simulation(), options());
  const first = await exportDecisionBundle(root, bundle);
  const second = await exportDecisionBundle(root, bundle);
  const bytes = await readFile(join(root, first.relativePath));
  const checksum = await readFile(join(root, first.checksumRelativePath), "utf8");

  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.equal(first.bundleSha256, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(checksum, `${first.bundleSha256}  decision-bundle.json\n`);
  assert.match(first.relativePath, /^build\/decision-bundles\/db_[a-f0-9]{24}\/decision-bundle\.json$/);
  assert.equal(JSON.parse(bytes.toString("utf8")).bundleDigest, bundle.bundleDigest);
});

test("Decision Bundle export repairs a missing checksum but rejects changed bundle bytes", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "proto-decision-bundle-recovery-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const bundle = buildDecisionBundle(simulation(), options());
  const first = await exportDecisionBundle(root, bundle);
  await unlink(join(root, first.checksumRelativePath));
  const repaired = await exportDecisionBundle(root, bundle);
  assert.equal(repaired.reused, false);

  await writeFile(join(root, first.relativePath), "tampered", "utf8");
  await assert.rejects(exportDecisionBundle(root, bundle), /does not match|not a bounded/i);
});
