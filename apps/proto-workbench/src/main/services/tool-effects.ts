/**
 * Effect classification for the execution journal. Every name resolves through
 * the shared contract table; an unregistered name is rejected before dispatch.
 */
import { requireToolContract, toolContract, type ToolEffect } from "../../shared/tool-contracts.ts";

export type { ToolEffect };

export function declaredMcpToolEffect(name: string): ToolEffect {
  return requireToolContract(name).effect;
}

export function isKnownWriteMcpTool(name: string): boolean {
  return toolContract(name)?.effect === "write";
}

/** True when the name has no contract row and cannot be dispatched. */
export function isUnregisteredTool(name: string): boolean {
  return toolContract(name) === undefined;
}
