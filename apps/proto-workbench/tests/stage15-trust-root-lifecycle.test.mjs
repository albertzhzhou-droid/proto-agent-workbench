import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

test("Stage 15 exposes typed offline Trust Root lifecycle contracts", async () => {
  const contracts = await source("src/shared/contracts.ts");
  const ipc = await source("src/shared/ipc.ts");

  assert.match(contracts, /TrustRootLifecycleState = "reviewable" \| "current" \| "rejected" \| "invalid"/);
  for (const check of ["old-root-threshold", "new-root-threshold", "timestamp-freshness", "snapshot-binding", "targets-binding", "trusted-root-binding", "rollback-protection"]) {
    assert.match(contracts, new RegExp(`\\| "${check}"`));
  }
  assert.match(contracts, /importTrustRootCandidate\(\): Promise<TrustRootLifecycleImportReceipt \| undefined>/);
  assert.match(contracts, /listTrustRootCandidates\(\): Promise<TrustRootLifecycleCatalog>/);
  assert.match(ipc, /harnessTrustRootCandidateImport: "harness:trust-root-candidate-import"/);
  assert.match(ipc, /harnessTrustRootCandidateList: "harness:trust-root-candidate-list"/);
});

test("Stage 15 verifier enforces sequential dual-threshold TUF rotation without an online updater", async () => {
  const verifier = await source("src/main/services/tuf-offline.ts");
  const packageJson = JSON.parse(await source("package.json"));

  assert.equal(packageJson.dependencies["@tufjs/models"], "5.0.0");
  assert.equal(packageJson.dependencies["@tufjs/canonical-json"], "2.0.0");
  assert.equal(packageJson.dependencies["@tufjs/client"], undefined);
  assert.match(verifier, /candidateRoot\.signed\.version === anchor\.root\.signed\.version \+ 1/);
  assert.match(verifier, /anchor\.root\.verifyDelegate\(MetadataKind\.Root, candidateRoot\)/);
  assert.match(verifier, /candidateRoot\.verifyDelegate\(MetadataKind\.Root, candidateRoot\)/);
  assert.match(verifier, /verifyMetaBinding/);
  assert.match(verifier, /verifyTargetBinding/);
  assert.match(verifier, /rollback-protection/);
  assert.match(verifier, /TrustedRoot\.fromJSON/);
  assert.doesNotMatch(verifier, /fetch\(|https\.request|http\.request|spawn\(|execFile|generateKeyPair|createPrivateKey|sign\(/);
});

test("Stage 15 candidate service keeps the exact seven-file pack immutable and bounded", async () => {
  const lifecycle = await source("src/main/services/trust-root-lifecycle.ts");

  for (const file of ["root.json", "timestamp.json", "snapshot.json", "targets.json", "trusted_root.json", "SOURCE.json", "SHA256SUMS.txt"]) {
    assert.match(lifecycle, new RegExp(file.replaceAll(".", "\\.")));
  }
  assert.match(lifecycle, /CANDIDATE_DIRECTORY_PATTERN = \/\^tr_/);
  assert.match(lifecycle, /checksums\.bytes\.toString\("utf8"\) !== checksumManifest/);
  assert.match(lifecycle, /fsConstants\.O_EXCL/);
  assert.match(lifecycle, /opened\.dev !== info\.dev \|\| opened\.ino !== info\.ino/);
  assert.match(lifecycle, /nlink !== 1/);
  assert.match(lifecycle, /Offline review only/);
  assert.doesNotMatch(lifecycle, /fetch\(|https\.request|http\.request|spawn\(|execFile|approvals\.resolve|files\.applyApprovedPatch/);
});

test("Stage 15 main and preload expose user-mediated no-argument import and read-only listing", async () => {
  const main = await source("src/main/index.ts");
  const preload = await source("src/preload/index.ts");
  const ipcSecurity = await source("src/main/ipc-security.ts");

  assert.match(main, /handlePrivileged\(IPC\.harnessTrustRootCandidateImport/);
  assert.match(main, /pickDirectory\("Select an offline TUF trust-root candidate pack"/);
  assert.match(main, /handlePrivileged\(IPC\.harnessTrustRootCandidateList/);
  assert.match(preload, /importTrustRootCandidate: \(\) => invoke\(IPC\.harnessTrustRootCandidateImport\)/);
  assert.match(preload, /listTrustRootCandidates: \(\) => invoke\(IPC\.harnessTrustRootCandidateList\)/);
  assert.match(ipcSecurity, /\[IPC\.harnessTrustRootCandidateImport\]: noArguments/);
  assert.match(ipcSecurity, /\[IPC\.harnessTrustRootCandidateList\]: noArguments/);
});

test("Stage 15 UI makes the full root lifecycle inspectable while activation remains absent", async () => {
  const center = await source("src/renderer/TrustRootLifecycleCenter.tsx");
  const signature = await source("src/renderer/SignatureEvidenceCenter.tsx");
  const verification = await source("src/renderer/DecisionBundleVerificationCenter.tsx");
  const mockApi = await source("src/renderer/mock-api.ts");

  assert.match(center, /Trust Root Lifecycle Center/);
  assert.match(center, /Anchor → old threshold → new threshold → metadata chain → trust material/);
  assert.match(center, /Candidate ready for human review/);
  assert.match(center, /Pinned checkpoint is current/);
  assert.match(center, /Candidate transition rejected/);
  assert.match(center, /Review is deliberately separate from activation/);
  assert.match(center, /Import candidate/);
  assert.match(signature, /Root lifecycle/);
  assert.match(verification, /TrustRootLifecycleCenter/);
  assert.match(mockApi, /previewTrustRootLifecycleCatalog/);
  assert.doesNotMatch(center, /threads\.send|approvals\.resolve|files\.applyApprovedPatch|models\.load|generateKey|signBundle|activateRoot/);
});

test("Stage 15 connector, pinned anchor, checkpoint, and licenses ship with the desktop app", async () => {
  const connector = JSON.parse(await source("../../connectors/proto_workbench.json"));
  const templateConnector = JSON.parse(await source("runtime/workspace-template/connectors/proto_workbench.json"));
  const checkpoint = JSON.parse(await source("runtime/trust/sigstore-public-good/tuf/CHECKPOINT.json"));
  const rootMetadata = JSON.parse(await source("runtime/trust/sigstore-public-good/tuf/15.root.json"));
  const notices = await source("THIRD_PARTY_NOTICES.md");
  const packageJson = JSON.parse(await source("package.json"));

  assert.ok(connector.connectors.some((entry) => entry.id === "tuf_trust_root_lifecycle" && entry.status === "available"));
  assert.deepEqual(templateConnector, connector);
  assert.equal(checkpoint.root.version, 15);
  assert.equal(rootMetadata.signed.version, 15);
  assert.match(notices, /TUF JavaScript models 5\.0\.0 and canonical JSON 2\.0\.0/);
  assert.ok(packageJson.build.extraResources.some((entry) => entry.to === "licenses/TUF-JS-MIT.txt"));
  assert.ok(packageJson.build.extraResources.some((entry) => entry.to === "runtime/trust"));
});
