import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  DecisionBundleExportReceipt,
  DecisionBundlePreview,
  DecisionBundleRedaction,
  PolicySimulationReport,
  PolicySimulationScenarioId,
} from "../../shared/contracts.ts";

export const DECISION_BUNDLE_LIMITS = {
  maxBytes: 512 * 1024,
  maxAttachments: 16,
  maxScenarios: 9,
} as const;

export const DECISION_BUNDLE_BOUNDARY = "Audit artifact only. This unsigned bundle cannot start a model, call a tool, resolve an approval, replay a decision, access the network, execute code, or authorize a file effect.";

const SCENARIO_IDS = [
  "current", "plan-posture", "act-posture", "network-unavailable", "execution-unavailable",
  "isolated-execution-ready", "workspace-drift", "model-chat-only", "strict-lockdown",
] as const;
const REQUIREMENT_IDS = ["integrity", "workspace", "runtime", "model", "attachments", "network", "writes", "execution", "human-review"] as const;
const PREFLIGHT_STATES = ["ready", "approval-required", "blocked"] as const;
const REQUIREMENT_STATES = [...PREFLIGHT_STATES, "deferred"] as const;
const DELTA_DIRECTIONS = ["unchanged", "more-restrictive", "less-restrictive", "posture-shift"] as const;

export interface DecisionBundleBuildOptions {
  selectedScenarioId: PolicySimulationScenarioId;
  redaction: DecisionBundleRedaction;
  attachmentCount: number;
  producerVersion: string;
  moduleManifestSha256: string;
}

export function buildDecisionBundle(
  report: PolicySimulationReport,
  options: DecisionBundleBuildOptions,
): DecisionBundlePreview {
  assertSimulationReport(report);
  if (!Number.isSafeInteger(options.attachmentCount) || options.attachmentCount < 0 || options.attachmentCount > DECISION_BUNDLE_LIMITS.maxAttachments) {
    throw new Error(`Decision Bundles support at most ${DECISION_BUNDLE_LIMITS.maxAttachments} attachments.`);
  }
  if (!/^[a-f0-9]{64}$/.test(options.moduleManifestSha256)) {
    throw new Error("Decision Bundle producer metadata requires a lowercase SHA-256 module manifest digest.");
  }
  const producerVersion = options.producerVersion.trim();
  if (!producerVersion || producerVersion.length > 64) throw new Error("Decision Bundle producer version is invalid.");
  if (options.redaction !== "metadata-only" && options.redaction !== "include-goal-preview") {
    throw new Error("Decision Bundle redaction profile is invalid.");
  }
  const selected = report.scenarios.find((scenario) => scenario.id === options.selectedScenarioId);
  if (!selected) throw new Error("The selected Decision Bundle scenario is not present in the trusted simulation report.");
  const includeDetails = options.redaction === "include-goal-preview";
  const removed = [
    "/attestation/predicate/context/threadId",
    "/attestation/predicate/context/workspacePath",
    "/attestation/predicate/context/attachmentNames",
    "/attestation/predicate/context/attachmentPaths",
    "/attestation/predicate/context/modelPath",
    "/attestation/predicate/context/runtimePath",
    ...(!includeDetails ? [
      "/attestation/predicate/goal/preview",
      "/attestation/predicate/selectedScenario/requirements/*/detail",
      "/attestation/predicate/selectedScenario/deltas/*/detail",
      "/attestation/predicate/selectedScenario/warnings",
    ] : []),
  ];
  const content = {
    schema: "proto-workbench.decision-bundle.v1" as const,
    mediaType: "application/vnd.proto-workbench.decision-bundle+json" as const,
    fileName: "decision-bundle.json" as const,
    attestation: {
      _type: "https://in-toto.io/Statement/v1" as const,
      subject: [{
        name: "policy-simulation-report" as const,
        digest: { sha256: report.digest },
      }],
      predicateType: "urn:proto-workbench:attestation:policy-simulation:v1" as const,
      predicate: {
        simulation: {
          digest: report.digest,
          decisionId: report.decisionId,
          scenarioCount: report.scenarios.length,
          boundary: report.boundary,
          executedEffects: [] as [],
        },
        goal: {
          sha256: report.goalSha256,
          preview: includeDetails ? report.goalPreview.slice(0, 180) : null,
        },
        context: {
          threadBindingSha256: sha256(report.threadId),
          attachmentCount: options.attachmentCount,
        },
        selectedScenario: {
          id: selected.id,
          label: selected.label,
          summary: selected.summary,
          hypothetical: selected.hypothetical,
          decisionDigest: selected.decisionDigest,
          state: selected.state,
          wouldBeLaunchable: selected.wouldBeLaunchable,
          determiningRequirements: [...selected.determiningRequirements],
          requirements: selected.requirements.map((requirement) => ({
            id: requirement.id,
            title: requirement.title,
            state: requirement.state,
            ...(includeDetails ? { detail: requirement.detail } : {}),
          })),
          deltas: selected.deltas.map((delta) => ({
            requirementId: delta.requirementId,
            title: delta.title,
            baselineState: delta.baselineState,
            scenarioState: delta.scenarioState,
            direction: delta.direction,
            ...(includeDetails ? { detail: delta.detail } : {}),
          })),
          warnings: includeDetails ? [...selected.warnings] : [],
          warningsRedactedCount: includeDetails ? 0 : selected.warnings.length,
        },
        scenarioMatrix: report.scenarios.map((scenario) => ({
          id: scenario.id,
          label: scenario.label,
          state: scenario.state,
          hypothetical: scenario.hypothetical,
          decisionDigest: scenario.decisionDigest,
          wouldBeLaunchable: scenario.wouldBeLaunchable,
          determiningRequirements: [...scenario.determiningRequirements],
        })),
        producer: {
          name: "Proto Workbench" as const,
          version: producerVersion,
          moduleManifestSha256: options.moduleManifestSha256,
        },
      },
    },
    authentication: {
      status: "unsigned" as const,
      envelope: "none" as const,
      assurance: "content-digest-only" as const,
      detail: "No DSSE or Sigstore envelope is present. Verify the SHA-256 content binding only; publisher identity is not established.",
    },
    redaction: {
      profile: options.redaction,
      removed,
      pathsAlwaysRedacted: true as const,
    },
    boundary: DECISION_BUNDLE_BOUNDARY,
  };
  const bundleDigest = sha256(stableJson(content));
  const bundle: DecisionBundlePreview = {
    ...content,
    bundleId: `db_${bundleDigest.slice(0, 24)}`,
    bundleDigest,
  };
  const bytes = Buffer.byteLength(serializeDecisionBundle(bundle), "utf8");
  if (bytes > DECISION_BUNDLE_LIMITS.maxBytes) throw new Error("Decision Bundle exceeds its serialized size limit.");
  return bundle;
}

export function verifyDecisionBundle(bundle: DecisionBundlePreview): void {
  assertDecisionBundleShape(bundle);
  if (bundle.authentication.status !== "unsigned" || bundle.authentication.envelope !== "none") {
    throw new Error("Decision Bundle authentication metadata is inconsistent.");
  }
  if (bundle.attestation.predicate.simulation.executedEffects.length !== 0) {
    throw new Error("Decision Bundles cannot contain executed effects.");
  }
  const subjectDigest = bundle.attestation.subject[0]?.digest.sha256;
  if (subjectDigest !== bundle.attestation.predicate.simulation.digest) {
    throw new Error("Decision Bundle subject digest does not match its simulation binding.");
  }
  const matrix = bundle.attestation.predicate.scenarioMatrix;
  if (matrix.length !== bundle.attestation.predicate.simulation.scenarioCount
    || !matrix.some((scenario) => scenario.id === bundle.attestation.predicate.selectedScenario.id)) {
    throw new Error("Decision Bundle scenario matrix does not match its simulation binding.");
  }
  const { bundleId: _bundleId, bundleDigest: _bundleDigest, ...content } = bundle;
  const computed = sha256(stableJson(content));
  if (computed !== bundle.bundleDigest || bundle.bundleId !== `db_${computed.slice(0, 24)}`) {
    throw new Error("Decision Bundle content digest does not match its payload.");
  }
}

export function parseDecisionBundle(serialized: string): DecisionBundlePreview {
  if (typeof serialized !== "string" || Buffer.byteLength(serialized, "utf8") > DECISION_BUNDLE_LIMITS.maxBytes) {
    throw new Error("Decision Bundle exceeds its serialized size limit.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error("Decision Bundle JSON is invalid.");
  }
  verifyDecisionBundle(parsed as DecisionBundlePreview);
  const canonical = `${JSON.stringify(parsed, null, 2)}\n`;
  if (canonical !== serialized) throw new Error("Decision Bundle serialization is not canonical.");
  return parsed as DecisionBundlePreview;
}

export function serializeDecisionBundle(bundle: DecisionBundlePreview): string {
  verifyDecisionBundle(bundle);
  const serialized = `${JSON.stringify(bundle, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > DECISION_BUNDLE_LIMITS.maxBytes) {
    throw new Error("Decision Bundle exceeds its serialized size limit.");
  }
  return serialized;
}

export async function exportDecisionBundle(
  workspaceRoot: string,
  bundle: DecisionBundlePreview,
): Promise<DecisionBundleExportReceipt> {
  verifyDecisionBundle(bundle);
  const root = await canonicalRoot(workspaceRoot);
  const buildDirectory = await ensureCanonicalDirectory(root, "build");
  const bundleRoot = await ensureCanonicalDirectory(buildDirectory, "decision-bundles", root);
  const targetDirectory = join(bundleRoot, bundle.bundleId);
  let reused = false;
  try {
    await mkdir(targetDirectory, { recursive: false });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    reused = true;
  }
  await assertCanonicalDirectory(targetDirectory, root);

  const serialized = serializeDecisionBundle(bundle);
  const bundleSha256 = sha256(serialized);
  const checksum = `${bundleSha256}  ${bundle.fileName}\n`;
  const bundlePath = join(targetDirectory, bundle.fileName);
  const checksumPath = join(targetDirectory, "SHA256SUMS.txt");
  const wroteBundle = await writeOrVerifyImmutable(bundlePath, serialized, DECISION_BUNDLE_LIMITS.maxBytes);
  const wroteChecksum = await writeOrVerifyImmutable(checksumPath, checksum, 512);
  const entries = (await readdir(targetDirectory)).sort();
  if (entries.length !== 2 || entries[0] !== "SHA256SUMS.txt" || entries[1] !== bundle.fileName) {
    throw new Error("Decision Bundle directory contains unexpected entries and cannot be trusted.");
  }
  const relativePath = relative(root, bundlePath).replaceAll("\\", "/");
  const checksumRelativePath = relative(root, checksumPath).replaceAll("\\", "/");
  return {
    schema: "proto-workbench.decision-bundle-receipt.v1",
    bundleId: bundle.bundleId,
    bundleDigest: bundle.bundleDigest,
    bundleSha256,
    relativePath,
    checksumRelativePath,
    bytes: Buffer.byteLength(serialized, "utf8"),
    exportedAt: new Date().toISOString(),
    reused: reused && !wroteBundle && !wroteChecksum,
    signatureStatus: "unsigned",
  };
}

async function canonicalRoot(workspaceRoot: string): Promise<string> {
  const requested = resolve(workspaceRoot);
  const info = await lstat(requested);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Decision Bundle export requires a canonical workspace directory.");
  const canonical = await realpath(requested);
  if (!sameCanonicalPath(requested, canonical)) throw new Error("Decision Bundle export cannot traverse a linked workspace root.");
  return canonical;
}

async function ensureCanonicalDirectory(parent: string, name: string, containmentRoot = parent): Promise<string> {
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(name)) throw new Error("Decision Bundle directory name is invalid.");
  const candidate = join(parent, name);
  try {
    await mkdir(candidate, { recursive: false });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  await assertCanonicalDirectory(candidate, containmentRoot);
  return candidate;
}

async function assertCanonicalDirectory(path: string, containmentRoot: string): Promise<void> {
  assertContained(containmentRoot, path);
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Decision Bundle export path is not a canonical directory.");
  const canonical = await realpath(path);
  assertContained(containmentRoot, canonical);
  if (!sameCanonicalPath(path, canonical)) throw new Error("Decision Bundle export path cannot traverse links or junctions.");
}

async function writeOrVerifyImmutable(path: string, content: string, maxBytes: number): Promise<boolean> {
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > maxBytes) throw new Error("Decision Bundle artifact exceeds its write limit.");
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  let handle;
  try {
    handle = await open(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readImmutable(path, maxBytes);
    if (existing !== content) throw new Error("An existing Decision Bundle artifact does not match the requested content.");
    return false;
  }
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size !== bytes) {
      throw new Error("Decision Bundle artifact did not remain a single-link regular file.");
    }
  } finally {
    await handle.close();
  }
  return true;
}

async function readImmutable(path: string, maxBytes: number): Promise<string> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1 || info.size > maxBytes) {
    throw new Error("Existing Decision Bundle artifact is not a bounded single-link regular file.");
  }
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const handle = await open(path, fsConstants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.size !== info.size) {
      throw new Error("Existing Decision Bundle artifact changed during verification.");
    }
    return await readFile(handle, "utf8");
  } finally {
    await handle.close();
  }
}

function assertSimulationReport(report: PolicySimulationReport): void {
  if (report.schema !== "proto-workbench.policy-simulation.v1" || !report.simulationOnly) {
    throw new Error("Decision Bundles require a trusted simulation-only report.");
  }
  if (!/^[a-f0-9]{64}$/.test(report.digest) || !/^[a-f0-9]{64}$/.test(report.goalSha256)) {
    throw new Error("Decision Bundle source digests are invalid.");
  }
  if (report.executedEffects.length !== 0) throw new Error("Decision Bundles cannot bind a report with executed effects.");
  if (!report.scenarios.length || report.scenarios.length > DECISION_BUNDLE_LIMITS.maxScenarios) {
    throw new Error("Decision Bundle source scenario count is outside the supported range.");
  }
}

function assertDecisionBundleShape(value: unknown): asserts value is DecisionBundlePreview {
  const bundle = record(value, "Decision Bundle");
  exact(bundle.schema, "proto-workbench.decision-bundle.v1", "schema");
  exact(bundle.mediaType, "application/vnd.proto-workbench.decision-bundle+json", "media type");
  exact(bundle.fileName, "decision-bundle.json", "file name");
  pattern(bundle.bundleId, /^db_[a-f0-9]{24}$/, "bundle ID");
  sha(bundle.bundleDigest, "bundle digest");

  const attestation = record(bundle.attestation, "attestation");
  exact(attestation._type, "https://in-toto.io/Statement/v1", "Statement type");
  if (!Array.isArray(attestation.subject) || attestation.subject.length !== 1) throw new Error("Decision Bundle subject is invalid.");
  const subject = record(attestation.subject[0], "subject");
  exact(subject.name, "policy-simulation-report", "subject name");
  sha(record(subject.digest, "subject digest").sha256, "subject digest");
  exact(attestation.predicateType, "urn:proto-workbench:attestation:policy-simulation:v1", "predicate type");

  const predicate = record(attestation.predicate, "predicate");
  const simulation = record(predicate.simulation, "simulation");
  sha(simulation.digest, "simulation digest");
  bounded(simulation.decisionId, "decision ID", 128);
  integer(simulation.scenarioCount, "scenario count", 1, DECISION_BUNDLE_LIMITS.maxScenarios);
  bounded(simulation.boundary, "simulation boundary", 2_048);
  if (!Array.isArray(simulation.executedEffects) || simulation.executedEffects.length !== 0) throw new Error("Decision Bundles cannot contain executed effects.");

  const goal = record(predicate.goal, "goal");
  sha(goal.sha256, "goal digest");
  if (goal.preview !== null) bounded(goal.preview, "goal preview", 180);
  const context = record(predicate.context, "context");
  sha(context.threadBindingSha256, "thread binding");
  integer(context.attachmentCount, "attachment count", 0, DECISION_BUNDLE_LIMITS.maxAttachments);

  const selected = record(predicate.selectedScenario, "selected scenario");
  enumValue(selected.id, SCENARIO_IDS, "selected scenario ID");
  bounded(selected.label, "selected scenario label", 128);
  bounded(selected.summary, "selected scenario summary", 1_024);
  booleanValue(selected.hypothetical, "selected scenario hypothetical state");
  sha(selected.decisionDigest, "selected scenario digest");
  enumValue(selected.state, PREFLIGHT_STATES, "selected scenario state");
  booleanValue(selected.wouldBeLaunchable, "selected scenario launch state");
  enumArray(selected.determiningRequirements, REQUIREMENT_IDS, "determining requirements", REQUIREMENT_IDS.length);
  objectArray(selected.requirements, "requirements", REQUIREMENT_IDS.length, (item) => {
    enumValue(item.id, REQUIREMENT_IDS, "requirement ID");
    bounded(item.title, "requirement title", 128);
    enumValue(item.state, REQUIREMENT_STATES, "requirement state");
    if (item.detail !== undefined) bounded(item.detail, "requirement detail", 1_024);
  });
  objectArray(selected.deltas, "deltas", REQUIREMENT_IDS.length, (item) => {
    enumValue(item.requirementId, REQUIREMENT_IDS, "delta requirement ID");
    bounded(item.title, "delta title", 128);
    enumValue(item.baselineState, REQUIREMENT_STATES, "delta baseline state");
    enumValue(item.scenarioState, REQUIREMENT_STATES, "delta scenario state");
    enumValue(item.direction, DELTA_DIRECTIONS, "delta direction");
    if (item.detail !== undefined) bounded(item.detail, "delta detail", 1_024);
  });
  stringArray(selected.warnings, "warnings", 16, 1_024);
  integer(selected.warningsRedactedCount, "redacted warning count", 0, 1_000);

  objectArray(predicate.scenarioMatrix, "scenario matrix", DECISION_BUNDLE_LIMITS.maxScenarios, (item) => {
    enumValue(item.id, SCENARIO_IDS, "scenario ID");
    bounded(item.label, "scenario label", 128);
    enumValue(item.state, PREFLIGHT_STATES, "scenario state");
    booleanValue(item.hypothetical, "scenario hypothetical state");
    sha(item.decisionDigest, "scenario digest");
    booleanValue(item.wouldBeLaunchable, "scenario launch state");
    enumArray(item.determiningRequirements, REQUIREMENT_IDS, "scenario determining requirements", REQUIREMENT_IDS.length);
  }, 1);
  const scenarioIds = (predicate.scenarioMatrix as Array<Record<string, unknown>>).map((item) => item.id);
  if (new Set(scenarioIds).size !== scenarioIds.length) throw new Error("Decision Bundle scenario IDs are duplicated.");

  const producer = record(predicate.producer, "producer");
  exact(producer.name, "Proto Workbench", "producer name");
  bounded(producer.version, "producer version", 64);
  sha(producer.moduleManifestSha256, "producer module manifest digest");

  const authentication = record(bundle.authentication, "authentication");
  exact(authentication.status, "unsigned", "authentication status");
  exact(authentication.envelope, "none", "authentication envelope");
  exact(authentication.assurance, "content-digest-only", "authentication assurance");
  bounded(authentication.detail, "authentication detail", 1_024);
  const redaction = record(bundle.redaction, "redaction");
  enumValue(redaction.profile, ["metadata-only", "include-goal-preview"] as const, "redaction profile");
  stringArray(redaction.removed, "redaction paths", 16, 256);
  if (redaction.pathsAlwaysRedacted !== true) throw new Error("Decision Bundle path redaction metadata is invalid.");
  exact(bundle.boundary, DECISION_BUNDLE_BOUNDARY, "bundle boundary");
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Decision Bundle ${label} is invalid.`);
  return value as Record<string, unknown>;
}

function exact(value: unknown, expected: string, label: string): void {
  if (value !== expected) throw new Error(`Decision Bundle ${label} is invalid.`);
}

function bounded(value: unknown, label: string, maximum: number): asserts value is string {
  if (typeof value !== "string" || !value || value.length > maximum) throw new Error(`Decision Bundle ${label} is invalid.`);
}

function pattern(value: unknown, expected: RegExp, label: string): asserts value is string {
  if (typeof value !== "string" || !expected.test(value)) throw new Error(`Decision Bundle ${label} is invalid.`);
}

function sha(value: unknown, label: string): asserts value is string {
  pattern(value, /^[a-f0-9]{64}$/, label);
}

function integer(value: unknown, label: string, minimum: number, maximum: number): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) throw new Error(`Decision Bundle ${label} is invalid.`);
}

function booleanValue(value: unknown, label: string): asserts value is boolean {
  if (typeof value !== "boolean") throw new Error(`Decision Bundle ${label} is invalid.`);
}

function enumValue<const T extends readonly string[]>(value: unknown, allowed: T, label: string): asserts value is T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) throw new Error(`Decision Bundle ${label} is invalid.`);
}

function stringArray(value: unknown, label: string, maximumItems: number, maximumCharacters: number): asserts value is string[] {
  if (!Array.isArray(value) || value.length > maximumItems) throw new Error(`Decision Bundle ${label} is invalid.`);
  for (const item of value) bounded(item, label, maximumCharacters);
}

function enumArray<const T extends readonly string[]>(value: unknown, allowed: T, label: string, maximumItems: number): asserts value is T[number][] {
  if (!Array.isArray(value) || value.length > maximumItems) throw new Error(`Decision Bundle ${label} is invalid.`);
  for (const item of value) enumValue(item, allowed, label);
  if (new Set(value).size !== value.length) throw new Error(`Decision Bundle ${label} contains duplicates.`);
}

function objectArray(
  value: unknown,
  label: string,
  maximumItems: number,
  validate: (item: Record<string, unknown>) => void,
  minimumItems = 0,
): asserts value is Array<Record<string, unknown>> {
  if (!Array.isArray(value) || value.length < minimumItems || value.length > maximumItems) throw new Error(`Decision Bundle ${label} is invalid.`);
  for (const item of value) validate(record(item, label));
}

function assertContained(root: string, candidate: string): void {
  const pathFromRoot = relative(root, candidate);
  if (pathFromRoot === "" || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== ".." && !isAbsolute(pathFromRoot))) return;
  throw new Error("Decision Bundle path is outside the selected workspace.");
}

function sameCanonicalPath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? resolve(left).toLocaleLowerCase() === resolve(right).toLocaleLowerCase()
    : resolve(left) === resolve(right);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
