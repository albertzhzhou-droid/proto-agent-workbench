import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(appRoot, "..", "..");
const outputPath = resolve(repositoryRoot, "build", "visualization-qa", "toy-10kb.ir.json");

if (process.argv.includes("--cleanup")) {
  await rm(outputPath, { force: true });
  process.stdout.write(JSON.stringify({ removed: outputPath }) + "\n");
  process.exit(0);
}

const library = JSON.parse(await readFile(resolve(repositoryRoot, "parts", "ecoli_k12_library.json"), "utf8"));
if (!Array.isArray(library.parts) || library.parts.length === 0) throw new Error("Toy part library is unavailable.");

const parts = [];
let bases = 0;
for (let index = 0; bases < 10_000; index += 1) {
  const source = library.parts[index % library.parts.length];
  if (!source || typeof source.id !== "string" || typeof source.type !== "string" || typeof source.sequence !== "string") {
    throw new Error("Toy part library entry is invalid.");
  }
  parts.push({ id: source.id, type: source.type, name: source.name, sequence: source.sequence });
  bases += source.sequence.length;
}

const artifact = {
  schema_version: "proto-agent.ir.v1",
  design_id: "visualization_benchmark_fixture",
  chassis: library.chassis,
  constructs: [{ name: "toy_repeated_parts_10kb", topology: "unknown", parts }],
  constraints: [],
  provenance: { source: "parts/ecoli_k12_library.json (toy visualization benchmark fixture)" },
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, JSON.stringify(artifact), { encoding: "utf8", flag: "w" });
process.stdout.write(JSON.stringify({ outputPath, bases, features: parts.length, toyFixture: true }) + "\n");
