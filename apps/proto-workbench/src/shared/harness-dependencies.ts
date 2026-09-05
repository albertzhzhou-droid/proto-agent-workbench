import type { HarnessMessage } from "./harness.ts";

export interface ObservedToolDependencies {
  schema: "proto-workbench.observed-tool-results.v1";
  callIds: string[];
}

/** Record only the preceding result batch actually visible before this model decision. */
export function observedToolDependencies(messages: readonly HarnessMessage[], callId: string): ObservedToolDependencies {
  let current = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role === "assistant" && message.tool_calls?.some(call => call.id === callId)) { current = index; break; }
  }
  const observed = new Set<string>();
  if (current >= 0) {
    for (let index = current - 1; index >= 0; index--) {
      const message = messages[index]!;
      if (message.role === "tool") observed.add(message.tool_call_id);
      if (message.role === "assistant" && message.tool_calls?.length) {
        // Internal discovery/plan/result-page calls have no external operation
        // event. Earlier external results are still visible across those steps.
        const external = message.tool_calls.filter(call => !call.function.name.startsWith("harness_"));
        if (external.length) return {schema: "proto-workbench.observed-tool-results.v1", callIds: [...new Set(external.map(call => call.id).filter(id => observed.has(id)))].slice(0, 32)};
      }
    }
  }
  return {schema: "proto-workbench.observed-tool-results.v1", callIds: []};
}
