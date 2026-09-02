import { createHash, createPublicKey, timingSafeEqual, type KeyObject } from "node:crypto";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { resolve } from "node:path";
import { bundleFromJSON, type Bundle } from "@sigstore/bundle";
import { TrustedRoot } from "@sigstore/protobuf-specs";
import { toSignedEntity, toTrustMaterial, Verifier, type SignedEntity } from "@sigstore/verify";
import type {
  SignatureEvidenceIdentity,
  TrustPolicyAuthority,
  TrustPolicyPreview,
} from "../../shared/contracts.ts";

export const SIGSTORE_BUNDLE_MEDIA_TYPE = "application/vnd.dev.sigstore.bundle.v0.3+json" as const;
export const SIGSTORE_PUBLIC_GOOD_ROOT_SHA256 = "a040678bbcc3e3f708a107e3955308bcb4fd31d58860dde6317ea18416af9d36";
export const SIGSTORE_PUBLIC_GOOD_ROOT_SOURCE = "https://github.com/sigstore/root-signing/blob/e3399e7e6f2c3f4039aa2464f95f7d8fcf57910c/targets/trusted_root.json";
export const SIGSTORE_PUBLIC_GOOD_ROOT_UPDATE_POLICY = "manual-reviewed-replacement" as const;

const MAX_TRUST_ROOT_BYTES = 128 * 1024;
const MAX_SIGNATURE_BUNDLE_BYTES = 2 * 1024 * 1024;
const FULCIO_ISSUER_V1 = "1.3.6.1.4.1.57264.1.1";
const FULCIO_ISSUER_V2 = "1.3.6.1.4.1.57264.1.8";

export interface PinnedTrustedRoot {
  bytes: Buffer;
  sha256: string;
  mediaType: string;
  root: TrustedRoot;
}

export interface OfflineSigstoreInput {
  artifact: Buffer;
  serializedBundle: string;
  policy: TrustPolicyPreview;
  trustedRoot: PinnedTrustedRoot;
  publicKeyPem?: string;
}

export interface OfflineSigstoreResult {
  state: "verified" | "incomplete" | "rejected";
  bundleSha256: string;
  artifactSha256: string;
  mediaType: typeof SIGSTORE_BUNDLE_MEDIA_TYPE;
  content: "message-signature" | "dsse-envelope";
  artifactBinding: "passed" | "failed";
  cryptographicSignature: "passed" | "failed";
  trustedTime: "verified" | "missing" | "rejected";
  trustRoot: "passed" | "missing" | "failed";
  authorityIdentity: "passed" | "failed" | "not-checked";
  identity?: SignatureEvidenceIdentity;
  signedTime?: {
    source: "transparency-log" | "timestamp-authority";
    observedAt?: string;
  };
  diagnostics: Array<{ code: string; title: string; detail: string }>;
}

export async function loadPinnedTrustedRoot(path: string): Promise<PinnedTrustedRoot> {
  const requested = resolve(path);
  const info = await lstat(requested);
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1 || info.size < 1 || info.size > MAX_TRUST_ROOT_BYTES) {
    throw new Error("The pinned Sigstore trust root is not a bounded single-link regular file.");
  }
  const canonical = await realpath(requested);
  if (!samePath(requested, canonical)) throw new Error("The pinned Sigstore trust root cannot traverse a link or junction.");
  const handle = await open(requested, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  let bytes: Buffer;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== info.dev || opened.ino !== info.ino || opened.size !== info.size) {
      throw new Error("The pinned Sigstore trust root changed while it was being read.");
    }
    bytes = await readFile(handle);
  } finally {
    await handle.close();
  }
  const sha256 = digest(bytes);
  if (sha256 !== SIGSTORE_PUBLIC_GOOD_ROOT_SHA256) {
    throw new Error(`The pinned Sigstore trust root digest is ${sha256}; expected ${SIGSTORE_PUBLIC_GOOD_ROOT_SHA256}.`);
  }
  let json: unknown;
  try {
    json = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("The pinned Sigstore trust root is not valid JSON.");
  }
  const root = TrustedRoot.fromJSON(json);
  if (!root.mediaType || root.tlogs.length < 1 || root.ctlogs.length < 1 || root.certificateAuthorities.length < 1) {
    throw new Error("The pinned Sigstore trust root is incomplete.");
  }
  return { bytes, sha256, mediaType: root.mediaType, root };
}

export function verifyOfflineSigstore(input: OfflineSigstoreInput): OfflineSigstoreResult {
  if (Buffer.byteLength(input.serializedBundle, "utf8") > MAX_SIGNATURE_BUNDLE_BYTES) {
    throw new Error("The Sigstore bundle exceeds the offline verification limit.");
  }
  let json: unknown;
  try {
    json = JSON.parse(input.serializedBundle);
  } catch {
    throw new Error("The Sigstore bundle is not valid JSON.");
  }
  const bundle = bundleFromJSON(json);
  if (bundle.mediaType !== SIGSTORE_BUNDLE_MEDIA_TYPE) {
    throw new Error(`Only ${SIGSTORE_BUNDLE_MEDIA_TYPE} is accepted.`);
  }
  if (!bundle.verificationMaterial || !bundle.content) throw new Error("The Sigstore bundle is missing verification material or signed content.");
  if (bundle.content.$case === "dsseEnvelope" && bundle.content.dsseEnvelope.signatures.length !== 1) {
    throw new Error("A DSSE Sigstore bundle must contain exactly one signature.");
  }

  const entity = toSignedEntity(bundle, bundle.content.$case === "messageSignature" ? input.artifact : undefined);
  const content = bundle.content.$case === "messageSignature" ? "message-signature" as const : "dsse-envelope" as const;
  const artifactBinding = verifyArtifactBinding(bundle, input.artifact) ? "passed" as const : "failed" as const;
  const diagnostics: OfflineSigstoreResult["diagnostics"] = [];
  if (artifactBinding === "failed") {
    diagnostics.push({ code: "ARTIFACT_BINDING_FAILED", title: "Signed content does not bind this artifact", detail: "The message digest or exact DSSE payload does not match decision-bundle.json." });
  }

  const keyKind = bundle.verificationMaterial.content?.$case;
  const resultBase = {
    bundleSha256: digest(Buffer.from(input.serializedBundle, "utf8")),
    artifactSha256: digest(input.artifact),
    mediaType: SIGSTORE_BUNDLE_MEDIA_TYPE,
    content,
    artifactBinding,
  };

  if (keyKind === "publicKey") {
    return verifyPublicKeyEvidence(input, entity, resultBase, diagnostics);
  }
  if (keyKind === "certificate" || keyKind === "x509CertificateChain") {
    return verifyKeylessEvidence(input, entity, resultBase, diagnostics);
  }
  throw new Error("The Sigstore bundle does not identify a supported verification key.");
}

function verifyPublicKeyEvidence(
  input: OfflineSigstoreInput,
  entity: SignedEntity,
  resultBase: Pick<OfflineSigstoreResult, "bundleSha256" | "artifactSha256" | "mediaType" | "content" | "artifactBinding">,
  diagnostics: OfflineSigstoreResult["diagnostics"],
): OfflineSigstoreResult {
  if (!input.publicKeyPem) throw new Error("A public-key Sigstore bundle requires public-key.pem in the evidence pack.");
  let publicKey: KeyObject;
  try {
    publicKey = createPublicKey(input.publicKeyPem);
  } catch {
    throw new Error("public-key.pem is not a supported public key.");
  }
  const publicKeySha256 = digest(publicKey.export({ type: "spki", format: "der" }));
  const authority = input.policy.verification.authorities.find(
    (candidate): candidate is Extract<TrustPolicyAuthority, { kind: "public-key" }> => candidate.kind === "public-key" && candidate.publicKeySha256 === publicKeySha256,
  );
  const signatureValid = entity.signature.verifySignature(publicKey);
  if (!signatureValid) diagnostics.push({ code: "SIGNATURE_INVALID", title: "Cryptographic signature rejected", detail: "The Sigstore signature does not verify with public-key.pem." });
  if (!authority) diagnostics.push({ code: "PUBLIC_KEY_POLICY_MISMATCH", title: "Public key is not allowed by policy", detail: `The SHA-256 digest of the DER SubjectPublicKeyInfo is ${publicKeySha256}.` });

  const identity: SignatureEvidenceIdentity = {
    kind: "public-key",
    authorityName: authority?.name,
    publicKeySha256,
  };
  const hasSignedTime = entity.timestamps.length > 0 && entity.tlogEntries.length > 0;
  let trustedTime: OfflineSigstoreResult["trustedTime"] = "missing";
  let signedTime: OfflineSigstoreResult["signedTime"];
  if (hasSignedTime && signatureValid && authority) {
    try {
      const trust = toTrustMaterial(input.trustedRoot.root, () => ({ publicKey, validFor: () => true }));
      new Verifier(trust).verify(entity);
      trustedTime = "verified";
      signedTime = signedTimeSummary(entity);
    } catch (error) {
      trustedTime = "rejected";
      diagnostics.push({ code: errorCode(error, "SIGNED_TIME_REJECTED"), title: "Trusted time evidence rejected", detail: safeMessage(error) });
    }
  } else if (!hasSignedTime) {
    diagnostics.push({ code: "SIGNED_TIME_MISSING", title: "Trusted time evidence is missing", detail: "The signature may be cryptographically valid, but policy requires independently verified signed time." });
  }

  const rejected = resultBase.artifactBinding === "failed" || !signatureValid || !authority || trustedTime === "rejected";
  return {
    ...resultBase,
    state: rejected ? "rejected" : trustedTime === "verified" ? "verified" : "incomplete",
    cryptographicSignature: signatureValid ? "passed" : "failed",
    trustedTime,
    trustRoot: authority ? (trustedTime === "rejected" ? "failed" : "passed") : "failed",
    authorityIdentity: authority ? "passed" : "failed",
    identity,
    signedTime,
    diagnostics,
  };
}

function verifyKeylessEvidence(
  input: OfflineSigstoreInput,
  entity: SignedEntity,
  resultBase: Pick<OfflineSigstoreResult, "bundleSha256" | "artifactSha256" | "mediaType" | "content" | "artifactBinding">,
  diagnostics: OfflineSigstoreResult["diagnostics"],
): OfflineSigstoreResult {
  if (input.publicKeyPem !== undefined) throw new Error("A keyless Sigstore evidence pack must not include public-key.pem.");
  if (entity.key.$case !== "certificate") throw new Error("Keyless evidence does not contain a leaf signing certificate.");
  const certificate = entity.key.certificate;
  const signatureValid = entity.signature.verifySignature(createPublicKey({ key: certificate.publicKey, format: "der", type: "spki" }));
  if (!signatureValid) diagnostics.push({ code: "SIGNATURE_INVALID", title: "Cryptographic signature rejected", detail: "The signature does not verify with the leaf certificate public key." });

  const observedIdentity = certificateIdentity(certificate);
  const authority = input.policy.verification.authorities.find(
    (candidate): candidate is Extract<TrustPolicyAuthority, { kind: "keyless" }> => candidate.kind === "keyless"
      && candidate.certificateIssuer === observedIdentity.certificateIssuer
      && candidate.certificateIdentity === observedIdentity.certificateIdentity,
  );
  if (!authority) diagnostics.push({ code: "KEYLESS_POLICY_MISMATCH", title: "Certificate identity is not allowed by policy", detail: "The exact issuer and subject alternative name do not match any keyless authority." });

  const identity: SignatureEvidenceIdentity = {
    kind: "keyless",
    authorityName: authority?.name,
    certificateIssuer: observedIdentity.certificateIssuer,
    certificateIdentity: observedIdentity.certificateIdentity,
  };
  const hasSignedTime = entity.timestamps.length > 0;
  let trustedTime: OfflineSigstoreResult["trustedTime"] = "missing";
  let trustRoot: OfflineSigstoreResult["trustRoot"] = "missing";
  let signedTime: OfflineSigstoreResult["signedTime"];
  if (hasSignedTime && signatureValid) {
    try {
      const signer = new Verifier(toTrustMaterial(input.trustedRoot.root)).verify(entity);
      trustedTime = "verified";
      trustRoot = "passed";
      signedTime = signedTimeSummary(entity);
      if (signer.identity?.extensions?.issuer !== observedIdentity.certificateIssuer
        || signer.identity?.subjectAlternativeName !== observedIdentity.certificateIdentity) {
        throw new Error("The independently verified signer identity changed during verification.");
      }
    } catch (error) {
      trustedTime = "rejected";
      trustRoot = "failed";
      diagnostics.push({ code: errorCode(error, "SIGSTORE_TRUST_REJECTED"), title: "Sigstore trust verification rejected", detail: safeMessage(error) });
    }
  } else if (!hasSignedTime) {
    diagnostics.push({ code: "SIGNED_TIME_MISSING", title: "Trusted time evidence is missing", detail: "A keyless certificate cannot be accepted without independently verified signed time." });
  }

  const rejected = resultBase.artifactBinding === "failed" || !signatureValid || !authority || trustedTime === "rejected";
  return {
    ...resultBase,
    state: rejected ? "rejected" : trustedTime === "verified" && trustRoot === "passed" ? "verified" : "incomplete",
    cryptographicSignature: signatureValid ? "passed" : "failed",
    trustedTime,
    trustRoot,
    authorityIdentity: authority ? "passed" : "failed",
    identity,
    signedTime,
    diagnostics,
  };
}

function verifyArtifactBinding(bundle: Bundle, artifact: Buffer): boolean {
  if (!bundle.content) return false;
  if (bundle.content.$case === "dsseEnvelope") {
    const payload = Buffer.from(bundle.content.dsseEnvelope.payload);
    return payload.length === artifact.length && timingSafeEqual(payload, artifact);
  }
  const messageDigest = bundle.content.messageSignature.messageDigest;
  if (!messageDigest || messageDigest.digest.length !== 32) return false;
  const artifactDigest = createHash("sha256").update(artifact).digest();
  return timingSafeEqual(artifactDigest, Buffer.from(messageDigest.digest));
}

function certificateIdentity(certificate: SignedEntity["key"] extends infer _T ? any : never): { certificateIssuer?: string; certificateIdentity?: string } {
  const v2 = certificate.extension(FULCIO_ISSUER_V2);
  const issuer = v2?.valueObj?.subs?.[0]?.value?.toString("ascii")
    ?? certificate.extension(FULCIO_ISSUER_V1)?.value?.toString("ascii");
  return { certificateIssuer: issuer, certificateIdentity: certificate.subjectAltName };
}

function signedTimeSummary(entity: SignedEntity): OfflineSigstoreResult["signedTime"] {
  const tlog = entity.timestamps.find((item) => item.$case === "transparency-log");
  if (tlog?.$case === "transparency-log") {
    const seconds = Number(tlog.tlogEntry.integratedTime);
    return { source: "transparency-log", ...(Number.isSafeInteger(seconds) && seconds > 0 ? { observedAt: new Date(seconds * 1_000).toISOString() } : {}) };
  }
  return entity.timestamps.some((item) => item.$case === "timestamp-authority") ? { source: "timestamp-authority" } : undefined;
}

function errorCode(error: unknown, fallback: string): string {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" && /^[A-Z0-9_]{3,64}$/.test(code) ? code : fallback;
}

function safeMessage(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  const normalized = value.replace(/[\r\n\t]+/g, " ").trim();
  return normalized.length > 320 ? `${normalized.slice(0, 319)}…` : normalized || "Verification failed closed.";
}

function digest(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? resolve(left).toLocaleLowerCase() === resolve(right).toLocaleLowerCase() : resolve(left) === resolve(right);
}
