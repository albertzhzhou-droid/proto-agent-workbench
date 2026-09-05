import { isAbsolute, relative, resolve } from "node:path";
import type { MissionContract } from "../../shared/harness.ts";

type Deliverable = MissionContract["deliverables"][number];
export interface MissionTargets {
  deliverables: Deliverable[];
  requiredReads: string[];
  writeTargets: string[];
  requiresArtifacts: boolean;
}
const EXTENSIONS = "proto|json|md|txt|csv|tsv|fasta|fa|gb|gbk|svg|png|pdf|pdb|cif|mmcif|py|ipynb|r";
const ACTION = /\b(read|inspect|review|check|validate|open|use|compare|summari[sz]e|create|write|save|edit|modify|update|export|generate|output|produce|design|compile)\b|读取|阅读|查看|检查|校验|打开|使用|基于|比较|总结|创建|写入|保存|修改|编辑|更新|导出|生成|输出|设计|编译/gi;
const WRITES = /^(?:create|write|save|edit|modify|update|export|generate|output|produce|design|创建|写入|保存|修改|编辑|更新|导出|生成|输出|设计)$/i;
const EDITS = /^(?:edit|modify|update|修改|编辑|更新)$/i;
const COMPILES = /^(?:compile|编译)$/i;

/** Explicit capabilities for callers that do not use the desktop preflight.
 * Only actual user text belongs here, never attachment contents or tool data. */
export function deriveMissionCapabilities(content: string): {network: boolean; execution: boolean} {
  const offline = /\b(?:offline(?:[ -]only)?|without\s+(?:network|internet)|no\s+(?:network|internet)|do\s+not\s+(?:browse|connect|fetch|download))\b|离线|不要联网|禁止联网|不得联网/i.test(content);
  const network = !offline && /\b(?:online|internet|web|pubmed|crossref|europe[ -]?pmc)\b|\blive\s+network\b|\b(?:search|query|fetch|download)\b[^.\n]{0,90}\b(?:pdb|alphafold|uniprot|rhea)\b|联网|上网|网络|在线/i.test(content);
  const deniedExecution = /\b(?:do not|never|without)\s+(?:run|execute|executing)\b|不要执行|禁止执行|不得执行/i.test(content);
  const execution = !deniedExecution && /\b(?:run|execute)\s+(?:(?:the|this|a|an)\s+)?(?:python|r\b|notebooks?|scripts?|analys[ie]s|jupyter)\b|(?:运行|执行)[^。\n]{0,20}(?:脚本|代码|Python|notebook|分析)/i.test(content);
  return {network, execution};
}

/** Protect explicit user targets before the model can add a plan. This does not
 * infer unspecified filenames or assert semantic completeness of a document. */
export function deriveMissionTargets(goal: string, workspacePath: string): MissionTargets {
  const references: Array<{path: string; index: number; end: number}> = [];
  const quoted = new RegExp("[`\"']([^`\"'\\r\\n]{1,512}\\.(?:" + EXTENSIONS + "))[`\"']", "giu");
  const plain = new RegExp("(?:(?:build|designs|analyses|notebooks|examples|docs|connectors)[\\\\/][\\p{L}\\p{N}_./\\\\-]+|(?:[A-Za-z]:[\\\\/])?[\\p{L}\\p{N}_.-]+(?:[\\\\/][\\p{L}\\p{N}_.-]+)*)\\.(?:" + EXTENSIONS + ")(?![\\p{L}\\p{N}_])", "giu");
  for (const expression of [quoted, plain]) for (const match of goal.matchAll(expression)) {
    const index = match.index ?? 0, end = index + match[0].length;
    if (references.some(r => index >= r.index && end <= r.end)) continue;
    const path = (expression === quoted ? match[1] : match[0]).trim();
    const token = goal.slice(Math.max(goal.lastIndexOf(" ", index), goal.lastIndexOf("\n", index)) + 1, end);
    if (token.includes("://")) continue;
    const absolute = resolve(workspacePath, path);
    const normalized = relative(resolve(workspacePath), absolute).replaceAll("\\", "/");
    if (!normalized || normalized === ".." || normalized.startsWith("../") || isAbsolute(normalized) || path.includes("\0")) continue;
    references.push({path: normalized, index, end});
  }
  references.sort((a, b) => a.index - b.index);
  const deliverables: Deliverable[] = [], requiredReads: string[] = [];
  const actions = [...goal.matchAll(ACTION)].filter(action => {
    const before = goal.slice(Math.max(0, (action.index ?? 0) - 20), action.index);
    return !/(?:\bnot|\bnever|\bdon't|\bthe|\ba|\ban|不要|不得|不能|禁止)\s*$/i.test(before);
  });
  const hasWrite = actions.some(action => WRITES.test(action[0]) || COMPILES.test(action[0]));
  for (const reference of references) {
    const precedingMatch = actions.filter(action => (action.index ?? 0) < reference.index).at(-1);
    const preceding = precedingMatch?.[0];
    const suffix = goal.slice(reference.end, reference.end + 24);
    // Also support noun-first requests such as "build/result.md を..." or
    // "build/result.md: create ..." when no earlier verb disambiguates it.
    const following = [...suffix.matchAll(ACTION)][0]?.[0];
    const action = preceding ?? following;
    const compileOutput = preceding && COMPILES.test(preceding) && /(?:\b(?:to|into|as|out)\s+|--out\s+|(?:到|为|至)\s*)[`"']?$/i.test(goal.slice((precedingMatch.index ?? 0) + preceding.length, reference.index));
    const output = action ? WRITES.test(action) || compileOutput : hasWrite && reference.path.startsWith("build/");
    if (output) {
      if (!deliverables.some(item => item.path.toLowerCase() === reference.path.toLowerCase())) deliverables.push({path: reference.path, kind: deliverableKind(reference.path, goal)});
      if (action && EDITS.test(action)) requiredReads.push(reference.path);
    } else requiredReads.push(reference.path);
  }
  return {deliverables, requiredReads: [...new Set(requiredReads)], writeTargets: deliverables.map(item => item.path), requiresArtifacts: hasWrite};
}

function deliverableKind(path: string, goal: string): Deliverable["kind"] {
  if (/\.proto$/i.test(path)) return "dna";
  // A report about proteins is still a document. Scientific JSON is checked
  // independently by its schema at completion; topic words cannot type all JSON.
  if (/(?:^|[/\\.]|-)proteins?(?:\.ir)?\.json$/i.test(path)
    || (/protein|蛋白质|蛋白/i.test(goal) && /\.(?:fasta|fa)$/i.test(path))) return "protein";
  return "document";
}
