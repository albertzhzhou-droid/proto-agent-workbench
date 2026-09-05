import test from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { candidateLaunchBinding } from "../scripts/verify-packaged-scientific.mjs";

const root=resolve("build","candidate-binding-fixture"),digest="a".repeat(64),payloadDigest="b".repeat(64);
const candidate=()=>({schemaVersion:"proto-workbench.release-candidate.v2",smoke:{portableExecutable:join(root,"workbench-portable.exe")},releaseSnapshot:{executableArtifacts:[{path:"workbench-portable.exe",sha256:digest}]},packageEvidence:{asarSha256:digest,manifestSha256:digest},distributionEvidence:{unpackedPayload:{executableArtifacts:[{path:"Proto Workbench.exe",sha256:payloadDigest}]},distributions:[{kind:"portable",artifact:{path:join(root,"workbench-portable.exe")},payloadRoot:join(root,"portable-payload"),payloadStatus:"verified-exact-unpacked-bytes"},{kind:"installer",artifact:{path:join(root,"workbench-setup.exe")},payloadRoot:join(root,"installer-payload"),payloadStatus:"verified-exact-unpacked-bytes"}]}});

test("Portable smoke binds the produced wrapper separately from its payload hash",()=>{
  const result=candidateLaunchBinding(candidate(),"portable");assert.equal(result.executablePath,join(root,"workbench-portable.exe"));assert.equal(result.executableSha256,digest);assert.equal(result.expectedPayloadSha256,payloadDigest);
});
test("an extracted payload cannot be relabeled as the produced Portable wrapper",()=>{
  const input=candidate();input.smoke.portableExecutable=join(root,"portable-payload","Proto Workbench.exe");assert.throws(()=>candidateLaunchBinding(input,"portable"),/exact verified wrapper/);
});
test("installer smoke selects only verified extracted payload and never executes Setup",()=>{
  const result=candidateLaunchBinding(candidate(),"installer-payload");assert.equal(result.executablePath,join(root,"installer-payload","Proto Workbench.exe"));assert.equal(result.executableSha256,payloadDigest);
});
test("unverified distribution and malformed candidate identities are rejected",()=>{
  const input=candidate();input.distributionEvidence.distributions[0].payloadStatus="pending";assert.throws(()=>candidateLaunchBinding(input,"portable"));const other=candidate();other.packageEvidence.asarSha256="unavailable";assert.throws(()=>candidateLaunchBinding(other,"portable"));assert.throws(()=>candidateLaunchBinding(candidate(),"installer"));
});
