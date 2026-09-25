// Explicit fixture adapter. Production never infers this mode from absent policy
// or persistence, and the host rejects it outside node --test.
import { createEphemeralKernelContext, invokeJournaledTool as invoke, recordPolicyDenial as deny } from "../../src/main/services/execution-kernel.ts";
import { McpClient } from "../../src/main/services/mcp-client.ts";

export const invokeJournaledTool = (request, dispatch) => invoke({ ...request, context: createEphemeralKernelContext(request) }, dispatch);
export const recordPolicyDenial = request => deny({ ...request, context: createEphemeralKernelContext(request) });
export class EphemeralMcpClient extends McpClient {
  constructor(paths, options = {}) { super(paths, { ...options, ephemeralTestContext: true }); }
}
