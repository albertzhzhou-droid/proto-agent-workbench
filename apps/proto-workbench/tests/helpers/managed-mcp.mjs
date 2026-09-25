import { randomUUID } from "node:crypto";
import { McpClient } from "../../src/main/services/mcp-client.ts";
import { openWorkspaceExecutionJournal } from "../../src/main/services/workspace-execution-journal.ts";

/** Native integration fixture uses the real production context and workspace
 * journal. Only supplies explicit test-operation identity at the host boundary. */
export class ManagedMcpTestClient extends McpClient {
  constructor(paths, options = {}) {
    const ledger = openWorkspaceExecutionJournal(paths.workspacePath);
    super(paths, { ...options, journal: ledger.journal });
    this.ownedTestLedger = ledger;
  }
  call(name, args, signal, authorization, options = {}) {
    return super.call(name, args, signal, authorization, { ...options,
      scope: options.scope ?? { surface: "system", scopeId: randomUUID() } });
  }
  async stop() {
    await super.stop();
    this.ownedTestLedger?.close();
    this.ownedTestLedger = undefined;
  }
}
