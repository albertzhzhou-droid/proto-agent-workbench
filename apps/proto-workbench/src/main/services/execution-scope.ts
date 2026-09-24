/** The user-visible operation owning a tool call, independent of backend runs. */
export interface ExecutionScope {
  surface: "chat" | "harness" | "compute" | "workflow" | "design" | "chemistry" | "validation" | "figure" | "system" | "legacy";
  scopeId: string;
  parentOperationId?: string;
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const SURFACES = new Set(["chat", "harness", "compute", "workflow", "design", "chemistry", "validation", "figure", "system", "legacy"]);

export function validateExecutionScope(scope: ExecutionScope): void {
  if (!scope || !SURFACES.has(scope.surface) || !IDENTIFIER.test(scope.scopeId)
    || (scope.parentOperationId !== undefined && !IDENTIFIER.test(scope.parentOperationId))) {
    throw new Error("TOOL_EXECUTION_SCOPE_INVALID");
  }
}
