import {createHash} from "node:crypto";
import {resolve} from "node:path";
import type {MissionEvidenceRequirement, ToolResultEnvelope} from "../../shared/harness.ts";
import type {WorkspaceFiles} from "./workspace-files.ts";
import {parseDesignIr} from "../../renderer/design-visualization.ts";
import {deriveMissionTargets} from "./mission-contract.ts";
import {positiveMissionClauses} from "./mission-intent.ts";

type Requirement = Extract<MissionEvidenceRequirement, {kind: "dna-edit"}>;
type Orientation = "forward" | "reverse";
type Row = {instanceId: string; id: string; type: string; orientation: Orientation};
type Construct = {name: string; topology: string; parts: Row[]; other: string[]};
export interface DnaEvidenceSource {designId: string; chassis: string; constructs: Construct[]; other: string[]}
const object = (value: unknown): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
const digest = (content: string) => createHash("sha256").update(content).digest("hex");
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const samePath = (root: string, a: unknown, b: unknown) => typeof a === "string" && typeof b === "string" && resolve(root, a).toLowerCase() === resolve(root, b).toLowerCase();
const localId = "[A-Za-z][A-Za-z0-9_.-]{0,63}";

/** Only explicit trusted user text supplies identifiers or edit obligations. */
export function deriveDnaEvidence(goal: string, workspacePath = "."): Requirement[] {
  const clauses = positiveMissionClauses(goal), text = clauses.join("\n");
  const orientations: Requirement["occurrenceOrientations"] = [];
  const target = `(?:occurrence|instance|实例|出现位置)\\s*(?:id\\s*[:=]?\\s*|=\\s*)?[\x60"']?(${localId})[\x60"']?`;
  for (const expression of [
    new RegExp(`${target}\\s+(?:(?:orientation\\s*[:=]?|to|as|is|为|改为|设置为)\\s*){0,2}(forward|reversed?|正向|反向)(?![A-Za-z0-9_])`, "gi"),
    new RegExp(`\\b(revers(?:e|ing|ed))\\s+(?:(?:only|the)\\s+){0,2}${target}`, "gi"),
  ]) for (const match of text.matchAll(expression)) {
    const reverseVerb = expression.source.startsWith("\\b(revers");
    const instanceId = match[reverseVerb ? 2 : 1], direction = match[reverseVerb ? 1 : 2].toLowerCase();
    orientations.push({instanceId, orientation: direction.startsWith("revers") || direction === "反向" ? "reverse" : "forward"});
  }
  const topologyValues = [...text.matchAll(/\btopology(?:\s+declaration)?\s*(?:(?:to|as|=|:)\s*)?(linear|circular)\b|拓扑\s*(?:为|改为|设置为)?\s*(linear|circular|线性|环状)/gi)].map(match => /^(?:circular|环状)$/i.test(match[1] ?? match[2]) ? "circular" as const : "linear" as const);
  const preserve = "(?:preserv(?:e|ing)|retain|keep|do not (?:change|replace)|保持|保留|不要(?:修改|替换))";
  const preservePartIdentities = new RegExp(`${preserve}[^.。;\\n]{0,65}(?:(?:part|material|resource)(?:\\s+and\\s+(?:instance|occurrence))?[ _-]*(?:ids?|identit(?:y|ies))|部件(?:标识|ID)|材料(?:标识|ID))`, "i").test(goal);
  const preserveOccurrenceIds = new RegExp(`${preserve}[^.。;\\n]{0,65}(?:(?:occurrence|instance)[ _-]*ids?|实例(?:标识|ID))`, "i").test(goal);
  const onlyTargetOccurrences = orientations.length > 0 && /\bonly\s+(?:(?:change|modify|reverse|flip|set|the)\s+){0,3}(?:occurrence|instance)\b|\b(?:change|modify|reverse|flip|set)\s+only\b|仅(?:修改|反转|设置)|其他实例不变/i.test(text)
    || topologyValues.length > 0 && /\bonly\s+(?:(?:the|invalid|existing|declared)\s+){0,3}topology\b|仅(?:修改|修复)[^。\n]{0,12}拓扑/i.test(text);
  if (!orientations.length && !topologyValues.length && !preservePartIdentities && !preserveOccurrenceIds) return [];
  const targets = deriveMissionTargets(goal, workspacePath), outputs = targets.deliverables.filter(item => /\.proto$/i.test(item.path)).map(item => item.path);
  const inputs = targets.requiredReads.filter(path => /\.proto$/i.test(path));
  const candidates = outputs.length ? outputs : [...new Set(inputs)];
  const constructs = [...text.matchAll(new RegExp(`\\b(?:in|of|within)\\s+construct\\s+[\x60"']?(${localId})`, "gi"))].map(match => match[1]);
  const uniqueOrientations = [...new Map(orientations.map(item => [`${item.instanceId}:${item.orientation}`, item])).values()];
  const errors = [candidates.length !== 1 ? "Bind the requested DNA edit to one explicit .proto output path." : "",
    new Set(constructs).size > 1 ? "The requested edits name multiple constructs; bind each construct separately." : "",
    new Set(topologyValues).size > 1 ? "The requested topology values conflict." : "",
    new Set(uniqueOrientations.map(item => item.instanceId)).size !== uniqueOrientations.length ? "The requested orientations conflict for an occurrence." : ""].filter(Boolean);
  return [{kind: "dna-edit", path: candidates[0] ?? "", ...(inputs.length === 1 && inputs[0] !== candidates[0] ? {baselinePath: inputs[0]} : {}),
    ...(constructs.length ? {construct: constructs[0]} : {}), occurrenceOrientations: uniqueOrientations, preservePartIdentities, preserveOccurrenceIds, onlyTargetOccurrences,
    ...(topologyValues.length ? {topology: topologyValues[0]} : {}), ...(errors.length ? {bindingError: errors.join(" ")} : {})}];
}

/** An identity projection, not a design validator. Python compilation remains
 * authoritative. Unknown baseline statements remain in `other` so an only-edit
 * comparison cannot silently discard them. Generated local IDs mirror the
 * documented DSL algorithm and are checked against Python in the test suite. */
export function dnaEvidenceSource(content: string): DnaEvidenceSource {
  if (Buffer.byteLength(content) > 2 * 1024 * 1024) throw new Error("DNA source exceeds the bounded identity projection limit.");
  const source: DnaEvidenceSource = {designId: "", chassis: "", constructs: [], other: []};
  let construct: Construct | undefined;
  for (const raw of content.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (!/^annotation(?:\s|$)/.test(line)) line = line.split("#", 1)[0].trim();
    const tokens = line.split(/\s+/);
    if (tokens[0] === "design" && tokens.length === 4 && tokens[2] === "chassis") {
      if (source.designId) throw new Error("DNA source contains multiple design headers.");
      source.designId = tokens[1]; source.chassis = tokens[3]; construct = undefined;
    } else if (tokens[0] === "construct" && tokens.length === 2 && tokens[1].endsWith(":")) {
      construct = {name: tokens[1].slice(0, -1), topology: "unknown", parts: [], other: []};
      if (source.constructs.some(item => item.name === construct!.name)) throw new Error("DNA construct identity is ambiguous.");
      source.constructs.push(construct);
    } else if (["promoter", "rbs", "cds", "terminator"].includes(tokens[0])) {
      if (!construct || tokens.length < 2 || tokens.length > 4) throw new Error("DNA part identity cannot be projected safely.");
      const options: Record<string, string> = {};
      for (const token of tokens.slice(2)) {
        const [key, value, extra] = token.split("=");
        if (!["instance", "orientation"].includes(key) || !value || extra || key in options) throw new Error("DNA occurrence options are ambiguous.");
        options[key] = value;
      }
      if (options.instance && !new RegExp(`^${localId}$`).test(options.instance) || options.orientation && !["forward", "reverse"].includes(options.orientation)) throw new Error("DNA occurrence options are invalid.");
      construct.parts.push({type: tokens[0], id: tokens[1], instanceId: options.instance ?? "", orientation: options.orientation as Orientation ?? "forward"});
    } else if (construct && tokens[0] === "topology" && tokens.length === 2) {
      if (construct.topology !== "unknown") throw new Error("DNA topology is ambiguous.");
      construct.topology = tokens[1];
    } else {
      if (tokens[0] === "constraint") construct = undefined;
      // Whitespace inside annotation JSON strings is scientific report content.
      // Retain it exactly; do not normalize a changed note into its old value.
      (construct?.other ?? source.other).push(tokens[0] === "annotation" ? line : line.replace(/\s+/g, " "));
    }
  }
  if (!source.designId || !source.constructs.length || source.constructs.some(item => !item.parts.length)) throw new Error("DNA source lacks bounded design/construct/part identities.");
  for (const item of source.constructs) {
    const explicit = item.parts.map(part => part.instanceId).filter(Boolean), reserved = new Set(explicit);
    if (reserved.size !== explicit.length || item.parts.length > 10_000) throw new Error("DNA occurrence identities are duplicated or exceed the limit.");
    item.parts.forEach((part, index) => {
      if (!part.instanceId) {const base = `occurrence_${String(index + 1).padStart(4, "0")}`; let id = base, suffix = 1; while (reserved.has(id)) id = `${base}_${suffix++}`; part.instanceId = id;}
      reserved.add(part.instanceId);
    });
  }
  return source;
}

const checkedPatch = (result: ToolResultEnvelope) => ["workspace_propose_patch", "workspace_resume_validation"].includes(result.tool)
  && object(result.data.validation).ok === true && ["proto_check", "proto_workflow_run", "proto_provenance_verify", "proto_review_packet"].every(tool => object(result.data.validation).steps?.some((step: any) => step.tool === tool && step.status === "completed"));

async function currentCompilerIr(path: string, sha256: string, results: ToolResultEnvelope[], workspace: WorkspaceFiles, root: string): Promise<Record<string, any> | undefined> {
  let inspected = 0;
  for (const result of results) {
    if (!result.ok || !["proto_compile", "proto_workflow_run"].includes(result.tool) && !checkedPatch(result)) continue;
    const validation = object(result.data.validation), input = object(result.data._harnessInputs);
    const source = checkedPatch(result) ? {path: validation.source, sha256: validation.sha256} : input;
    const binding = object(validation.materialBinding ?? input.materialBinding ?? result.data._harnessMaterialBinding);
    if (!samePath(root, source.path, path) || source.sha256 !== sha256 || !hash(binding.partsSha256) || typeof binding.partsPath !== "string") continue;
    if ((await workspace.artifactFingerprint(binding.partsPath).catch(() => undefined))?.sha256 !== binding.partsSha256) continue;
    for (const artifact of Array.isArray(result.data._harnessArtifacts) ? result.data._harnessArtifacts : []) {
      if (!artifact || typeof artifact.path !== "string" || !/\.ir\.json$/i.test(artifact.path) || !hash(artifact.sha256)) continue;
      if (++inspected > 64) return undefined;
      const file = await workspace.read(artifact.path).catch(() => undefined);
      if (!file || file.sha256 !== artifact.sha256 || digest(file.content) !== artifact.sha256) continue;
      const parsed = parseDesignIr(file.content);
      if (!parsed.ok || parsed.design?.domain !== "dna") continue;
      const ir = JSON.parse(file.content), provenance = object(ir.provenance);
      if (provenance.source_sha256 === sha256 && samePath(root, provenance.source, path) && provenance.parts_sha256 === binding.partsSha256 && samePath(root, provenance.parts_source, binding.partsPath)) return ir;
    }
  }
  return undefined;
}

/** Current compiler evidence and the original read/patch baseline, never a
 * model-written summary, decide whether an explicit edit was actually made. */
export async function verifyDnaEvidence(requirement: Requirement, results: ToolResultEnvelope[], workspace: WorkspaceFiles, workspacePath = "."): Promise<string[]> {
  const fail = (message: string) => [`DNA_EDIT_REQUIREMENT: ${message}`];
  if (requirement.bindingError || !requirement.path) return fail(requirement.bindingError ?? "The DNA target path is not bound.");
  const current = await workspace.read(requirement.path).catch(() => undefined);
  if (!current || digest(current.content) !== current.sha256) return fail(`Cannot reopen current DNA source ${requirement.path}.`);
  const ir = await currentCompilerIr(current.path, current.sha256, results, workspace, workspacePath);
  if (!ir) return fail(`Compile ${requirement.path} against its current bound library and retain the exact source/library/IR receipt before finishing.`);
  let now: DnaEvidenceSource;
  try {now = dnaEvidenceSource(current.content);} catch (error) {return fail(String(error));}
  const actual = (ir.constructs as Array<Record<string, any>>).map(construct => ({name: construct.name, topology: construct.topology ?? "unknown", parts: (construct.parts as Array<Record<string, any>>).map((part, index) => ({type: part.type, id: part.id, instanceId: part.instance_id ?? now.constructs.find(item => item.name === construct.name)?.parts[index]?.instanceId, orientation: object(part.placement).orientation ?? "forward"}))}));
  if (JSON.stringify(actual) !== JSON.stringify(now.constructs.map(({name, topology, parts}) => ({name, topology, parts: parts.map(({type, id, instanceId, orientation}) => ({type, id, instanceId, orientation}))})))) return fail("Current source identity projection disagrees with its authoritative Python compiler IR.");
  const diagnostics: string[] = [];
  const scope = now.constructs.filter(item => !requirement.construct || item.name === requirement.construct);
  if (!scope.length) diagnostics.push(`Requested construct ${requirement.construct} is absent.`);
  const selected = new Set<string>();
  for (const expected of requirement.occurrenceOrientations) {
    const matches = scope.flatMap(construct => construct.parts.filter(part => part.instanceId === expected.instanceId).map(part => ({construct, part})));
    if (matches.length !== 1) diagnostics.push(`Occurrence ${expected.instanceId} must identify exactly one current construct placement; found ${matches.length}.`);
    else {selected.add(`${matches[0].construct.name}\0${expected.instanceId}`); if (matches[0].part.orientation !== expected.orientation) diagnostics.push(`Occurrence ${expected.instanceId} must have orientation=${expected.orientation}; current=${matches[0].part.orientation}.`);}
  }
  if (requirement.topology) {
    if (scope.length !== 1) diagnostics.push("Bind the topology request to one exact construct.");
    else if (scope[0].topology !== requirement.topology) diagnostics.push(`Construct ${scope[0].name} must have topology ${requirement.topology}; current=${scope[0].topology}.`);
  }
  if (requirement.preservePartIdentities || requirement.preserveOccurrenceIds || requirement.onlyTargetOccurrences) {
    const baselinePath = requirement.baselinePath ?? requirement.path;
    const firstWrite = results.findIndex(result => ["workspace_propose_patch", "workspace_resume_validation"].includes(result.tool) && result.data.effect_state === "committed" && samePath(workspacePath, object(result.data.patch).targetPath ?? object(result.data.validation).source, baselinePath));
    const baseline = results.slice(0, firstWrite < 0 ? undefined : firstWrite).find(result => result.ok && result.tool === "workspace_read" && samePath(workspacePath, result.data.path, baselinePath));
    const content = baseline?.data.content;
    if (typeof content !== "string" || !hash(baseline?.data.sha256) || digest(content) !== baseline.data.sha256) diagnostics.push("Read the original DNA source before its first write; a later read cannot replace the identity baseline.");
    else {
      const patch = firstWrite >= 0 ? object(results[firstWrite].data.patch) : undefined;
      const unchangedInput = firstWrite < 0 && (await workspace.artifactFingerprint(baselinePath).catch(() => undefined))?.sha256 === baseline.data.sha256;
      if (patch ? patch.baseSha256 !== baseline.data.sha256 || patch.before !== content || patch.baseExists !== true : !unchangedInput) diagnostics.push("The first committed patch does not match the task's original source read.");
      else try {
        const before = dnaEvidenceSource(content);
        const identities = (source: DnaEvidenceSource) => source.constructs.flatMap(construct => construct.parts.map(part => `${construct.name}\0${part.instanceId}\0${part.type}\0${part.id}`)).sort();
        const instances = (source: DnaEvidenceSource) => source.constructs.flatMap(construct => construct.parts.map(part => `${construct.name}\0${part.instanceId}`)).sort();
        if (requirement.preservePartIdentities && JSON.stringify(identities(before)) !== JSON.stringify(identities(now))) diagnostics.push("The original occurrence-to-part identities were not preserved.");
        if (requirement.preserveOccurrenceIds && JSON.stringify(instances(before)) !== JSON.stringify(instances(now))) diagnostics.push("The original occurrence IDs were not preserved.");
        if (requirement.onlyTargetOccurrences) {
          const strip = (source: DnaEvidenceSource) => ({
            ...source,
            constructs: source.constructs.map(construct => ({
              ...construct,
              ...(requirement.topology && scope.some(item => item.name === construct.name) ? {topology: "requested"} : {}),
              parts: construct.parts.map(part => ({...part, ...(selected.has(`${construct.name}\0${part.instanceId}`) ? {orientation: "requested"} : {})})),
            })),
          });
          if (JSON.stringify(strip(before)) !== JSON.stringify(strip(now))) diagnostics.push("Only the requested occurrences may change; another identity, placement, order, annotation or design declaration changed.");
        }
      } catch (error) {diagnostics.push(`Cannot safely project the original DNA identities: ${String(error)}`);}
    }
  }
  return diagnostics.map(message => `DNA_EDIT_REQUIREMENT: ${message}`);
}
