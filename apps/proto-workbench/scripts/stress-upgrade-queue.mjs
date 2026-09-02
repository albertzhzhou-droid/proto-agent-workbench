import { randomBytes } from "node:crypto";
import { lstat, mkdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const MAX_QUEUE_BYTES = 256 * 1024;

export async function writeStressUpgradeQueue(buildRoot, report) {
  const root = await canonicalDirectory(buildRoot, "build root");
  const queueRoot = join(root, "upgrade-queue");
  await mkdir(queueRoot, { mode: 0o700 }).catch((error) => {
    if (error?.code !== "EEXIST") throw error;
  });
  const canonicalQueue = await canonicalDirectory(queueRoot, "upgrade queue");
  if (!containsPath(root, canonicalQueue) || root === canonicalQueue) throw new Error("QUEUE_ROOT_ESCAPE");

  const normalized = normalizeReport(report);
  const data = `${JSON.stringify(normalized, null, 2)}\n`;
  if (Buffer.byteLength(data, "utf8") > MAX_QUEUE_BYTES) throw new Error("QUEUE_SIZE_LIMIT");
  const stamp = normalized.created_at.replace(/[-:.TZ]/g, "").slice(0, 14);
  const name = `${normalized.scenario}-${stamp}-${randomBytes(4).toString("hex")}.json`;
  const target = join(canonicalQueue, name);
  const temporary = join(canonicalQueue, `.${name}.${randomBytes(8).toString("hex")}.tmp`);
  try {
    await writeFile(temporary, data, { encoding: "utf8", flag: "wx", mode: 0o600 });
    if (await realpath(canonicalQueue) !== canonicalQueue) throw new Error("QUEUE_ROOT_CHANGED");
    await rename(temporary, target);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
  return target;
}

export function normalizeReport(report) {
  const scenario = boundedToken(report?.scenario, "scenario");
  const status = report?.status === "passed" ? "passed" : "failed";
  const stage = boundedToken(report?.stage ?? "report", "stage");
  const detailCode = boundedToken(report?.detailCode ?? (status === "passed" ? "NONE" : "UNCLASSIFIED"), "detail code");
  const rawFindings = Array.isArray(report?.findings) ? report.findings : [];
  const findingCodes = [...new Set(rawFindings.map((value) => boundedToken(value, "finding")))].slice(0, 64);
  if (status === "failed" && !findingCodes.includes(detailCode)) findingCodes.unshift(detailCode);
  const diagnosticFingerprint = report?.diagnosticFingerprint === undefined
    ? undefined
    : boundedFingerprint(report.diagnosticFingerprint);
  const metrics = normalizeMetrics(report?.metrics);
  return {
    schema_version: "proto-workbench.stress-upgrade-queue.v1",
    created_at: new Date().toISOString(),
    scenario,
    status,
    stage,
    detail_code: detailCode,
    diagnostic_fingerprint: diagnosticFingerprint,
    metrics,
    items: findingCodes.map((code, index) => ({
      id: `${scenario}-${String(index + 1).padStart(3, "0")}`,
      priority: stage === "model-load" || /SAFETY|GROUNDING|DECISION|NETWORK|RUNTIME/.test(code) ? "P1" : "P2",
      status: "open",
      code,
      acceptance: "Add a reproducing regression, fix the shared boundary, and prove both the original failure and a legitimate control.",
    })),
  };
}

function boundedToken(value, label) {
  const token = String(value);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(token)) throw new Error(`INVALID_${label.toUpperCase().replaceAll(" ", "_")}`);
  return token;
}

function boundedFingerprint(value) {
  const fingerprint = String(value);
  if (!/^[a-f0-9]{16}$/.test(fingerprint)) throw new Error("INVALID_DIAGNOSTIC_FINGERPRINT");
  return fingerprint;
}

function normalizeMetrics(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_STRESS_METRICS");
  const eventCount = boundedCount(value.eventCount ?? 0);
  const messageCharacters = boundedCount(value.messageCharacters ?? 0);
  const completedTools = Array.isArray(value.completedTools)
    ? [...new Set(value.completedTools.map((tool) => boundedToken(tool, "tool")))].slice(0, 64)
    : [];
  const eventTypes = {};
  if (value.eventTypes && typeof value.eventTypes === "object" && !Array.isArray(value.eventTypes)) {
    for (const [name, count] of Object.entries(value.eventTypes).slice(0, 64)) {
      eventTypes[boundedToken(name, "event type")] = boundedCount(count);
    }
  }
  let lastRunEvent;
  if (value.lastRunEvent && typeof value.lastRunEvent === "object" && !Array.isArray(value.lastRunEvent)) {
    lastRunEvent = {};
    for (const key of ["stage", "actor", "status", "tool"]) {
      if (value.lastRunEvent[key] !== undefined) lastRunEvent[key] = boundedToken(value.lastRunEvent[key], key);
    }
  }
  return { eventCount, eventTypes, completedTools, messageCharacters, lastRunEvent };
}

function boundedCount(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 10_000_000) throw new Error("INVALID_STRESS_COUNT");
  return value;
}

async function canonicalDirectory(value, label) {
  if (typeof value !== "string" || !isAbsolute(value)) throw new Error(`INVALID_${label.toUpperCase().replaceAll(" ", "_")}`);
  const requested = resolve(value);
  const info = await lstat(requested);
  const canonical = resolve(await realpath(requested));
  if (!info.isDirectory() || info.isSymbolicLink() || canonical !== requested) {
    throw new Error(`UNSAFE_${label.toUpperCase().replaceAll(" ", "_")}`);
  }
  return canonical;
}

function containsPath(root, candidate) {
  const delta = relative(root, candidate);
  return delta !== "" && delta !== ".." && !delta.startsWith(`..${sep}`) && !isAbsolute(delta);
}
