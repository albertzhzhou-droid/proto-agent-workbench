import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { buildDecisionBundle, exportDecisionBundle } from "../src/main/services/decision-bundle.ts";
import { scanDecisionBundles } from "../src/main/services/decision-bundle-verification.ts";
import { buildPolicySimulation } from "../src/main/services/policy-simulation.ts";

function simulation() {
  return buildPolicySimulation({
    thread: { id: "thread-verification", workspacePath: "C:\\private\\workspace", title: "Verification", mode: "act", modelId: "model-1", createdAt: "2026-08-31T00:00:00.000Z", updatedAt: "2026-08-31T00:00:00.000Z" },
    content: "Prepare a reviewed audit bundle without applying a workspace patch.",
    attachments: [],
    model: { id: "model-1", name: "Local Agent", path: "C:\\private\\model.gguf", files: ["C:\\private\\model.gguf"], sizeBytes: 1, architecture: "fixture", quantization: "Q4", contextLength: 32768, vision: false, toolCapability: "agent-ready", fingerprint: "f".repeat(64), estimatedVramBytes: 1, loadState: "active", pinned: false, metadataSource: "filename" },
    runtime: { available: true, path: "C:\\private\\llama-server.exe", backend: "cuda", detail: "Ready" },
    moduleIntegrity: { ok: true, enforced: true, manifestPath: "module-manifest.json", manifestSha256: "a".repeat(64), checkedAt: "2026-08-31T00:00:00.000Z", modules: [{ moduleId: "core.audit", version: 1, core: true, status: "verified", disposition: "loaded", moduleSha256: "b".repeat(64), checkedArtifacts: 1, diagnostics: [] }] },
    visionModuleEnabled: false,
    workspaceUri: "file:///C:/private/workspace",
    capabilities: { workspace: "file:///C:/private/workspace", execution: { mode: "disabled", available: false, configured: false, provider_visible: false, smoke_verified: false, image_digest_pinned: false, reason: "Execution disabled." }, networkPaths: [], networkEnabled: false, networkAuthorization: "per-call-hmac-capability", filesystemSafety: { relativePathsOnly: true, reparsePointsAllowed: false, atomicReplace: true, windowsResidualSameUserRenameRace: true } },
    toolNames: ["workspace_read", "workspace_propose_patch"],
  }, ["current", "workspace-drift"]);
}

function bundle() {
  return buildDecisionBundle(simulation(), {
    selectedScenarioId: "workspace-drift",
    redaction: "metadata-only",
    attachmentCount: 0,
    producerVersion: "1.0.0-test",
    moduleManifestSha256: "a".repeat(64),
  });
}

async function exportedRoot(context, prefix = "proto-decision-verify-") {
  const root = await mkdtemp(join(tmpdir(), prefix));
  context.after(() => rm(root, { recursive: true, force: true }));
  const receipt = await exportDecisionBundle(root, bundle());
  return { root, receipt };
}

test("Verification Center discovers a canonical export and separates content integrity from identity", async (context) => {
  const { root, receipt } = await exportedRoot(context);
  const result = await scanDecisionBundles(root, "2026-08-31T23:00:00.000Z");
  const entry = result.entries[0];

  assert.equal(result.schema, "proto-workbench.decision-bundle-verification.v1");
  assert.equal(result.summary.contentVerified, 1);
  assert.equal(entry.state, "content-verified");
  assert.equal(entry.signatureStatus, "unsigned");
  assert.equal(entry.identityAssurance, "not-verified");
  assert.equal(entry.bundleSha256, receipt.bundleSha256);
  assert.equal(entry.expectedBundleSha256, receipt.bundleSha256);
  assert.ok(entry.checks.every((check) => check.state === "passed"));
  assert.match(result.boundary, /does not execute|does not.*establish publisher identity/i);
});

test("checksum mismatch is reported as tampering without crashing the catalog", async (context) => {
  const { root, receipt } = await exportedRoot(context, "proto-decision-verify-tamper-");
  const bundlePath = join(root, receipt.relativePath);
  const parsed = JSON.parse(await readFile(bundlePath, "utf8"));
  parsed.attestation.predicate.selectedScenario.state = "ready";
  await writeFile(bundlePath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");

  const result = await scanDecisionBundles(root);
  const entry = result.entries[0];
  assert.equal(entry.state, "tampered");
  assert.equal(entry.signatureStatus, "unknown");
  assert.ok(entry.diagnostics.some((item) => item.code === "CHECKSUM_MISMATCH"));
  assert.equal(entry.checks.find((item) => item.id === "checksum-match").state, "failed");
});

test("coordinated JSON and checksum edits still fail the content-address check", async (context) => {
  const { root, receipt } = await exportedRoot(context, "proto-decision-verify-content-");
  const bundlePath = join(root, receipt.relativePath);
  const checksumPath = join(root, receipt.checksumRelativePath);
  const parsed = JSON.parse(await readFile(bundlePath, "utf8"));
  parsed.attestation.predicate.selectedScenario.state = "ready";
  const changed = `${JSON.stringify(parsed, null, 2)}\n`;
  await writeFile(bundlePath, changed, "utf8");
  await writeFile(checksumPath, `${createHash("sha256").update(changed).digest("hex")}  decision-bundle.json\n`, "utf8");

  const result = await scanDecisionBundles(root);
  assert.equal(result.entries[0].state, "tampered");
  assert.equal(result.entries[0].checks.find((item) => item.id === "checksum-match").state, "passed");
  assert.equal(result.entries[0].checks.find((item) => item.id === "content-digest").state, "failed");
  assert.ok(result.entries[0].diagnostics.some((item) => item.code === "CONTENT_DIGEST_MISMATCH"));
});

test("missing checksum and unexpected entries fail closed as invalid directories", async (context) => {
  const first = await exportedRoot(context, "proto-decision-verify-missing-");
  await unlink(join(first.root, first.receipt.checksumRelativePath));
  const missing = await scanDecisionBundles(first.root);
  assert.equal(missing.entries[0].state, "invalid");
  assert.ok(missing.entries[0].diagnostics.some((item) => item.code === "UNEXPECTED_ENTRIES"));

  const second = await exportedRoot(context, "proto-decision-verify-extra-");
  await writeFile(join(dirname(join(second.root, second.receipt.relativePath)), "extra.txt"), "unexpected", "utf8");
  const extra = await scanDecisionBundles(second.root);
  assert.equal(extra.entries[0].state, "invalid");
  assert.equal(extra.entries[0].checks.find((item) => item.id === "entries").state, "failed");
});

test("hardlinked bundle bytes are rejected even when the link is outside the bundle directory", async (context) => {
  const { root, receipt } = await exportedRoot(context, "proto-decision-verify-link-");
  await link(join(root, receipt.relativePath), join(root, "linked-copy.json"));
  const result = await scanDecisionBundles(root);
  assert.equal(result.entries[0].state, "invalid");
  assert.equal(result.entries[0].checks.find((item) => item.id === "bundle-file").state, "failed");
});

test("an empty workspace remains read-only and creates no audit directories", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "proto-decision-verify-empty-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const result = await scanDecisionBundles(root);
  assert.equal(result.returnedCount, 0);
  assert.deepEqual(await readdir(root), []);
});

test("catalog scanning is bounded and reports truncation", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "proto-decision-verify-bounded-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const bundleRoot = join(root, "build", "decision-bundles");
  await mkdir(bundleRoot, { recursive: true });
  for (let index = 0; index < 65; index += 1) {
    await mkdir(join(bundleRoot, `db_${index.toString(16).padStart(24, "0")}`));
  }
  const result = await scanDecisionBundles(root);
  assert.equal(result.scannedDirectoryCount, 65);
  assert.equal(result.returnedCount, 64);
  assert.equal(result.truncated, true);
  assert.equal(result.summary.invalid, 64);
});
