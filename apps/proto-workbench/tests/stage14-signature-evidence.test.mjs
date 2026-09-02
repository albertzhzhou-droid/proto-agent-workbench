import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

test("Stage 14 exposes typed five-stage offline Signature Evidence results", async () => {
  const contracts = await source("src/shared/contracts.ts");
  const ipc = await source("src/shared/ipc.ts");

  assert.match(contracts, /SignatureEvidenceState = "verified" \| "incomplete" \| "rejected" \| "invalid"/);
  for (const stage of ["artifact-binding", "cryptographic-signature", "trusted-time", "trust-root", "authority-identity"]) {
    assert.match(contracts, new RegExp(`\\| "${stage}"`));
  }
  assert.match(contracts, /importSignatureEvidence\(\): Promise<SignatureEvidenceImportReceipt \| undefined>/);
  assert.match(contracts, /listSignatureEvidence\(\): Promise<SignatureEvidenceCatalog>/);
  assert.match(ipc, /harnessSignatureEvidenceImport: "harness:signature-evidence-import"/);
  assert.match(ipc, /harnessSignatureEvidenceList: "harness:signature-evidence-list"/);
});

test("Stage 14 verification core uses pinned local trust and lower-level verify-only packages", async () => {
  const verifier = await source("src/main/services/sigstore-offline.ts");
  const packageJson = JSON.parse(await source("package.json"));

  assert.equal(packageJson.dependencies["@sigstore/bundle"], "5.0.0");
  assert.equal(packageJson.dependencies["@sigstore/verify"], "4.1.2");
  assert.equal(packageJson.dependencies["@sigstore/protobuf-specs"], "0.5.2");
  assert.equal(packageJson.dependencies.sigstore, undefined);
  assert.equal(packageJson.dependencies["@sigstore/sign"], undefined);
  assert.equal(packageJson.dependencies["@sigstore/tuf"], undefined);
  assert.match(verifier, /loadPinnedTrustedRoot/);
  assert.match(verifier, /SIGSTORE_PUBLIC_GOOD_ROOT_SHA256/);
  assert.match(verifier, /new Verifier\(toTrustMaterial\(input\.trustedRoot\.root\)\)/);
  assert.match(verifier, /state: rejected \? "rejected" : trustedTime === "verified" \? "verified" : "incomplete"/);
  assert.doesNotMatch(verifier, /fetch\(|https\.request|http\.request|spawn\(|execFile|generateKeyPair|createPrivateKey|sign\(/);
});

test("Stage 14 evidence import is exact, content-addressed, immutable, and read-only when scanning", async () => {
  const evidence = await source("src/main/services/signature-evidence.ts");

  assert.match(evidence, /EVIDENCE_DIRECTORY_PATTERN = \/\^se_/);
  assert.match(evidence, /checksumText !== expectedChecksums/);
  assert.match(evidence, /fsConstants\.O_EXCL/);
  assert.match(evidence, /opened\.dev !== info\.dev \|\| opened\.ino !== info\.ino/);
  assert.match(evidence, /nlink !== 1/);
  assert.match(evidence, /scanSignatureEvidence/);
  assert.match(evidence, /never signs, generates keys, activates trust, authorizes effects/);
  assert.doesNotMatch(evidence, /fetch\(|https\.request|http\.request|spawn\(|execFile|approvals\.resolve|files\.applyApprovedPatch/);
});

test("Stage 14 main and preload expose only no-argument import/list capabilities", async () => {
  const main = await source("src/main/index.ts");
  const preload = await source("src/preload/index.ts");
  const ipcSecurity = await source("src/main/ipc-security.ts");
  const packageJson = await source("package.json");

  assert.match(main, /handlePrivileged\(IPC\.harnessSignatureEvidenceImport/);
  assert.match(main, /pickDirectory\("Select a Signature Evidence pack"/);
  assert.match(main, /handlePrivileged\(IPC\.harnessSignatureEvidenceList, \(\) => scanSignatureEvidence/);
  assert.match(preload, /importSignatureEvidence: \(\) => invoke\(IPC\.harnessSignatureEvidenceImport\)/);
  assert.match(preload, /listSignatureEvidence: \(\) => invoke\(IPC\.harnessSignatureEvidenceList\)/);
  assert.match(ipcSecurity, /\[IPC\.harnessSignatureEvidenceImport\]: noArguments/);
  assert.match(ipcSecurity, /\[IPC\.harnessSignatureEvidenceList\]: noArguments/);
  assert.match(packageJson, /"from": "runtime\/trust"/);
});

test("Stage 14 UI makes all five trust stages visible without activation or signing actions", async () => {
  const center = await source("src/renderer/SignatureEvidenceCenter.tsx");
  const verification = await source("src/renderer/DecisionBundleVerificationCenter.tsx");
  const policy = await source("src/renderer/TrustPolicyCenter.tsx");
  const mockApi = await source("src/renderer/mock-api.ts");

  assert.match(center, /Signature Evidence Center/);
  assert.match(center, /Artifact → signature → trusted time → trust root → identity/);
  assert.match(center, /Import pack/);
  assert.match(center, /Exact issuer \+ SAN/);
  assert.match(center, /Exact SPKI digest/);
  assert.match(center, /Verification does not activate trust/);
  assert.match(center, /Signing, key creation, and trust activation are unavailable/);
  assert.match(verification, /Signatures/);
  assert.match(policy, />Evidence</);
  assert.match(mockApi, /explicitLocalFixturePreview/);
  assert.match(mockApi, /window\.location\.search === "\?fixtures=1"/);
  assert.match(mockApi, /hostname === "127\.0\.0\.1".*hostname === "localhost"/s);
  assert.doesNotMatch(center, /threads\.send|approvals\.resolve|files\.applyApprovedPatch|models\.load|generateKey|signBundle/);
});
