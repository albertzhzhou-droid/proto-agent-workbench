/** Artifact bounds, not permission to execute a tool or trust its contents. */
export function computeResultByteLimit(tool: unknown): number {
  return (tool === "analyze_rnaseq_study" ? 32 : 4) * 1024 * 1024;
}
export function computeResultNodeLimit(tool: unknown): number {
  return tool === "analyze_rnaseq_study" ? 2_000_000 : 600_000;
}
