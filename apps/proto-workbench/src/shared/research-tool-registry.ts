/** Canonical capabilities shared by the conversational and dedicated workspaces.
 * Naming is derived from the single tool contract table: upstream names are
 * discovery aliases, never separate implementations. A backend tool with no
 * contract row is dropped from discovery rather than given a guessed `design.*`
 * id, because a guessed id also meant a guessed effect and risk class.
 */
import { TOOL_CONTRACTS, resolveToolContract, type ToolContract } from "./tool-contracts.ts";

export interface ScienceCapability {
  id: string;
  aliases: string[];
  workflowFamilies: string[];
}

const capability = (contract: ToolContract): ScienceCapability => ({
  id: contract.capabilityId,
  aliases: [...contract.aliases],
  workflowFamilies: [...contract.workflowFamilies],
});

export const SCIENCE_CAPABILITIES: Record<string, ScienceCapability> = Object.fromEntries(
  [...TOOL_CONTRACTS.values()].map((contract) => [contract.name, capability(contract)]),
);

export function canonicalScienceTools<T extends {name: string}>(tools: T[]) {
  const unique = new Map<string, T & ScienceCapability>();
  for (const tool of tools) {
    const contract = resolveToolContract(tool.name);
    if (!contract) continue;
    // A row matched by backend name wins over one matched by alias.
    if (!unique.has(contract.capabilityId) || TOOL_CONTRACTS.has(tool.name)) {
      unique.set(contract.capabilityId, {...tool, ...capability(contract)});
    }
  }
  return [...unique.values()];
}

export function resolveScienceTool<T extends {name: string; id: string; aliases: string[]}>(tools: T[], name: string): T | undefined {
  return tools.find(tool => tool.id === name || tool.name === name || tool.aliases.includes(name));
}

export function canonicalScienceName(name: string): string {
  return resolveToolContract(name)?.capabilityId ?? name;
}

/** Backend names a surface offered that carry no contract row. */
export function unregisteredScienceTools<T extends {name: string}>(tools: T[]): string[] {
  return [...new Set(tools.filter(tool => !resolveToolContract(tool.name)).map(tool => tool.name))];
}
