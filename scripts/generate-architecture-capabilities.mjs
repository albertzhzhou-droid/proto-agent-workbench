import { lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const input = resolve(root, "docs/next-architecture-capabilities.json");
const output = resolve(root, "docs/NEXT_ARCHITECTURE_CAPABILITIES.md");
const allowed = new Set(["--check"]);
if (process.argv.slice(2).some(arg => !allowed.has(arg))) throw new Error("Usage: node scripts/generate-architecture-capabilities.mjs [--check]");
const ledger = JSON.parse(readFileSync(input, "utf8"));
const implementation = new Set(["scoped-implementation", "partial", "not-implemented"]);
const statuses = new Set(["test-handles-only", "not-applicable", "not-assessed", "not-run", "unsupported"]);
const dimensions = ["software", "science", "model", "delivery"];
const requiredIds = Array.from({length: 14}, (_, index) => `P${String(index + 1).padStart(2, "0")}`);
const nonempty = value => typeof value === "string" && value.trim().length > 0;
if (ledger.schemaVersion !== "proto.architecture-capabilities.v1" || !/^\d{4}-\d{2}-\d{2}$/.test(ledger.reviewDate)
  || !nonempty(ledger.scope) || !Array.isArray(ledger.entries)
  || JSON.stringify(ledger.entries.map(entry => entry.id)) !== JSON.stringify(requiredIds)) throw new Error("Invalid architecture ledger identity or P01-P14 coverage.");

function verifyRef(path) {
  if (!nonempty(path) || path.includes("\\") || isAbsolute(path) || path.split("/").some(part => !part || part === "." || part === "..")) throw new Error(`Unsafe ledger reference: ${path}`);
  const target = resolve(root, path), actual = realpathSync(target), rel = relative(root, actual);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) || !lstatSync(target).isFile()
    || lstatSync(target).isSymbolicLink() || actual.toLowerCase() !== target.toLowerCase()) throw new Error(`Ledger reference is not a regular repository file: ${path}`);
}
for (const entry of ledger.entries) {
  if (!nonempty(entry.title) || !implementation.has(entry.implementation) || !nonempty(entry.implementedScope)
    || !Array.isArray(entry.sourceRefs) || !entry.sourceRefs.length || !Array.isArray(entry.testRefs)
    || !Array.isArray(entry.remaining) || !entry.remaining.length || entry.remaining.some(item => !nonempty(item))) throw new Error(`Invalid scope/refs in ${entry.id}`);
  for (const dimension of dimensions) if (!entry.evidence?.[dimension] || !statuses.has(entry.evidence[dimension].status)
    || !nonempty(entry.evidence[dimension].scope)) throw new Error(`Invalid ${dimension} evidence in ${entry.id}`);
  for (const path of [...entry.sourceRefs, ...entry.testRefs]) verifyRef(path);
}

const escape = value => String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
const link = path => `[${path}](../${path})`;
const lines = ["# Next architecture capability and evidence ledger", "", `Reviewed source inventory: ${ledger.reviewDate}.`, "", ledger.scope, "",
  "Generated from [next-architecture-capabilities.json](next-architecture-capabilities.json). Run `node scripts/generate-architecture-capabilities.mjs --check` at the repository root to verify source references and document parity.", "",
  "`scoped-implementation` means the described code exists. `partial` and `not-implemented` retain the listed gaps. `test-handles-only` points to checks that can be run; it does not assert their outcomes. Current test counts and environment-specific outcomes belong in the dated validation report.", "",
  `The supplied plan reported CI run ${ledger.baselineReport.ciRun} against ${ledger.baselineReport.commit}: ${ledger.baselineReport.conclusion}`, "",
  "| Work item | Implementation | Software evidence | Science evidence | Model evidence | Delivery evidence |", "|---|---|---|---|---|---|"];
for (const entry of ledger.entries) lines.push(`| ${entry.id} ${escape(entry.title)} | ${entry.implementation} | ${dimensions.map(dimension => entry.evidence[dimension].status).join(" | ")} |`);
for (const entry of ledger.entries) {
  lines.push("", `## ${entry.id}: ${entry.title}`, "", entry.implementedScope, "", `Source: ${entry.sourceRefs.map(link).join(", ")}.`, "",
    entry.testRefs.length ? `Check definitions: ${entry.testRefs.map(link).join(", ")}.` : "Check: generator reference validation and `--check` parity.", "",
    ...dimensions.map(dimension => `- ${dimension}: **${entry.evidence[dimension].status}**. ${entry.evidence[dimension].scope}`), "", "Remaining scope:", "",
    ...entry.remaining.map(item => `- ${item}`));
}
const generated = `${lines.join("\n")}\n`;
if (process.argv.includes("--check")) {
  if (readFileSync(output, "utf8") !== generated) throw new Error("Architecture ledger document is stale; regenerate it from its reviewed JSON source.");
} else writeFileSync(output, generated, "utf8");
console.log(`Architecture ledger: ${ledger.entries.length} entries; source/test references and ${process.argv.includes("--check") ? "generated parity verified" : "document generated"}.`);
