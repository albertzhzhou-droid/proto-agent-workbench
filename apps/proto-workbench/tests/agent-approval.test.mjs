import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentService,
  automaticSafetyDossierRequest,
  buildFailClosedEvidenceDossier,
  failClosedEmptyResponse,
  isHighRiskBiologicalDesignIntent,
  planOfflineCoverageCalls,
} from "../src/main/services/agent-service.ts";
import { AppDatabase } from "../src/main/services/database.ts";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function runApprovalScenario(decision) {
  const database = new AppDatabase(":memory:");
  const approvalReady = deferred();
  const complete = deferred();
  const model = {
    id: "model-local",
    name: "Local test model",
  };
  let chatTurns = 0;
  const models = {
    get: (modelId) => (modelId === model.id ? model : undefined),
    getActiveModel: () => model,
    setToolCapability: () => {},
    chat: async (_modelId, _payload, onChunk) => {
      chatTurns += 1;
      if (chatTurns === 1) {
        onChunk({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_pubmed",
                    type: "function",
                    function: {
                      name: "proto_pubmed_search",
                      arguments: JSON.stringify({ query: "synthetic biology design", offline: false }),
                    },
                  },
                ],
              },
            },
          ],
        });
        return;
      }
      onChunk({ choices: [{ delta: { content: "Permission continuation complete." } }] });
    },
  };
  let toolCalls = 0;
  const mcp = {
    tools: async () => [
      {
        name: "proto_pubmed_search",
        description: "Search PubMed.",
        inputSchema: {
          type: "object",
          required: ["query"],
          properties: { query: { type: "string" }, offline: { type: "boolean" } },
          additionalProperties: false,
        },
      },
    ],
    call: async (name, arguments_, _signal, authorization) => {
      toolCalls += 1;
      assert.equal(name, "proto_pubmed_search");
      assert.equal(arguments_.query, "synthetic biology design");
      assert.equal(arguments_.offline, false);
      assert.match(authorization.runId, /^[0-9a-f-]{36}$/);
      assert.match(authorization.approvalId, /^[0-9a-f-]{36}$/);
      assert.ok(Date.parse(authorization.expiresAt) > Date.now());
      return { ok: true, summary: "One record found." };
    },
  };
  const workspace = {
    read: async () => {
      throw new Error("No optional policy fixture");
    },
  };
  const events = [];
  const agent = new AgentService(database, models, workspace, mcp, (event) => {
    events.push(event);
    if (event.type === "approval-required") approvalReady.resolve(event.approval);
    if (event.type === "message-complete") complete.resolve(event.message);
    if (event.type === "error") complete.reject(new Error(event.error));
  });
  const thread = agent.createThread({
    workspacePath: "C:\\test-workspace",
    title: "Approval continuation",
    mode: "act",
    modelId: model.id,
  });

  await agent.send(thread.id, "Find supporting literature.");
  const approval = await approvalReady.promise;
  assert.equal(approval.status, "pending");
  assert.equal(approval.arguments.offline, false);
  await agent.resolveApproval(approval.id, decision);
  const message = await complete.promise;
  const savedApproval = database.getApproval(approval.id);

  database.close();
  return { chatTurns, events, message, savedApproval, toolCalls };
}

test("approved tool execution resumes the same agent turn", async () => {
  const result = await runApprovalScenario("approved");
  assert.equal(result.savedApproval.status, "approved");
  assert.equal(result.toolCalls, 1);
  assert.equal(result.chatTurns, 2);
  assert.equal(result.message.content, "Permission continuation complete.");
  assert.ok(result.events.some((event) => event.type === "run-event" && event.runEvent.status === "approved"));
  assert.ok(result.events.some((event) =>
    event.type === "run-event" && event.runEvent.title === "Pubmed Search" && event.runEvent.stage === "plan",
  ));
});

test("rejected tool execution is skipped and the agent still concludes", async () => {
  const result = await runApprovalScenario("rejected");
  assert.equal(result.savedApproval.status, "rejected");
  assert.equal(result.toolCalls, 0);
  assert.equal(result.chatTurns, 2);
  assert.equal(result.message.content, "Permission continuation complete.");
  assert.ok(result.events.some((event) => event.type === "run-event" && event.runEvent.status === "rejected"));
});

test("offline scientific fixture calls execute without a network approval", async () => {
  const database = new AppDatabase(":memory:");
  const complete = deferred();
  const model = { id: "offline-fixture-model", name: "Offline fixture model" };
  let chatTurns = 0;
  let toolCalls = 0;
  const events = [];
  const agent = new AgentService(
    database,
    {
      get: () => model,
      getActiveModel: () => model,
      setToolCapability: () => {},
      chat: async (_modelId, _payload, onChunk) => {
        chatTurns += 1;
        if (chatTurns === 1) {
          onChunk({ choices: [{ delta: { tool_calls: [{
            index: 0,
            id: "call_offline_fixture",
            type: "function",
            function: {
              name: "proto_europe_pmc_search",
              arguments: JSON.stringify({ query: "fixture", offline: false }),
            },
          }] } }] });
          return;
        }
        onChunk({ choices: [{ delta: { content: "Offline fixture complete." } }] });
      },
    },
    { read: async () => { throw new Error("No optional policy fixture"); } },
    {
      tools: async () => [{
        name: "proto_europe_pmc_search",
        description: "Search an offline fixture.",
        inputSchema: {
          type: "object",
          required: ["query"],
          properties: { query: { type: "string" }, offline: { type: "boolean" }, fixture: { type: "string" } },
          additionalProperties: false,
        },
      }],
      call: async (_name, arguments_, _signal, authorization) => {
        toolCalls += 1;
        assert.equal(arguments_.offline, true);
        assert.equal(arguments_.fixture, "tests/fixtures/europe_pmc_search.json");
        assert.equal(authorization, undefined);
        return { ok: true, source_ids: ["PMID:34181032"] };
      },
    },
    (event) => {
      events.push(event);
      if (event.type === "message-complete") complete.resolve(event.message);
      if (event.type === "error") complete.reject(new Error(event.error));
    },
  );
  const thread = agent.createThread({
    workspacePath: "C:\\test-workspace",
    title: "Offline fixture",
    mode: "act",
    modelId: model.id,
  });

  await agent.send(
    thread.id,
    "For an L-DOPA E. coli review, run Europe PMC with offline=true and fixture tests/fixtures/europe_pmc_search.json.",
  );
  const message = await complete.promise;
  assert.equal(message.content, "Offline fixture complete.");
  assert.equal(toolCalls, 1);
  assert.equal(events.some((event) => event.type === "approval-required"), false);
  database.close();
});

test("narration-only models get bounded host orchestration for explicit safe coverage", async () => {
  const database = new AppDatabase(":memory:");
  const complete = deferred();
  const model = { id: "narration-model", name: "Narration model" };
  let chatTurns = 0;
  let connectorCalls = 0;
  let proposed;
  const agent = new AgentService(
    database,
    {
      get: () => model,
      getActiveModel: () => model,
      setToolCapability: () => {},
      chat: async (_modelId, _payload, onChunk) => {
        chatTurns += 1;
        if (chatTurns <= 2) {
          onChunk({ choices: [{ delta: { content: "I will inspect the connector." } }] });
          return;
        }
        onChunk({ choices: [{ delta: { content: "# Safe review\n\nNO-GO." } }] });
        onChunk({ choices: [{ delta: { tool_calls: [{
          index: 0,
          id: "call_safe_patch",
          type: "function",
          function: {
            name: "workspace_propose_patch",
            arguments: JSON.stringify({ path: "analyses/host-fallback.md", rationale: "Review." }),
          },
        }] } }] });
      },
    },
    {
      read: async () => { throw new Error("No optional policy fixture"); },
      proposePatch: async (input) => {
        proposed = input;
        return { id: "host-fallback-patch", ...input, status: "pending", createdAt: "2026-08-18T00:00:00.000Z" };
      },
    },
    {
      tools: async () => [
        { name: "proto_connectors_check", description: "Check connectors.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
        {
          name: "workspace_propose_patch",
          description: "Propose a patch.",
          inputSchema: {
            type: "object",
            required: ["path", "rationale"],
            properties: { path: { type: "string" }, rationale: { type: "string" } },
            additionalProperties: false,
          },
        },
      ],
      call: async (name) => {
        assert.equal(name, "proto_connectors_check");
        connectorCalls += 1;
        return { ok: true, summary: "Connectors inspected." };
      },
    },
    (event) => {
      if (event.type === "message-complete") complete.resolve(event.message);
      if (event.type === "error") complete.reject(new Error(event.error));
    },
  );
  const thread = agent.createThread({ workspacePath: "C:\\test-workspace", title: "Host fallback", mode: "act", modelId: model.id });
  await agent.send(
    thread.id,
    "Run the declared connector check. Target deliverable: analyses/host-fallback.md. Use workspace_propose_patch.",
  );
  await complete.promise;
  assert.equal(chatTurns, 3);
  assert.equal(connectorCalls, 1);
  assert.equal(proposed.after, "# Safe review\n\nNO-GO.");
  database.close();
});

test("a malformed tool turn falls back to explicit safe coverage without a second malformed retry", async () => {
  const database = new AppDatabase(":memory:");
  const complete = deferred();
  const model = { id: "malformed-coverage-model", name: "Malformed coverage model" };
  let chatTurns = 0;
  let connectorCalls = 0;
  const agent = new AgentService(
    database,
    {
      get: () => model,
      getActiveModel: () => model,
      setToolCapability: () => {},
      chat: async (_modelId, _payload, onChunk) => {
        chatTurns += 1;
        if (chatTurns === 1) {
          onChunk({ choices: [{ delta: { content: "Discard this malformed turn." } }] });
          throw new Error("The model produced malformed tool-call JSON. Retry once.");
        }
        onChunk({ choices: [{ delta: { content: "Safe coverage completed." } }] });
      },
    },
    { read: async () => { throw new Error("No optional policy fixture"); } },
    {
      tools: async () => [{
        name: "proto_connectors_check",
        description: "Check connectors.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      }],
      call: async (name) => {
        assert.equal(name, "proto_connectors_check");
        connectorCalls += 1;
        return { ok: true, summary: "Connectors inspected." };
      },
    },
    (event) => {
      if (event.type === "message-complete") complete.resolve(event.message);
      if (event.type === "error") complete.reject(new Error(event.error));
    },
  );
  const thread = agent.createThread({ workspacePath: "C:\\test-workspace", title: "Malformed coverage", mode: "act", modelId: model.id });
  await agent.send(thread.id, "Run the declared connector check.");
  const message = await complete.promise;
  assert.equal(chatTurns, 2);
  assert.equal(connectorCalls, 1);
  assert.equal(message.content, "Safe coverage completed.");
  database.close();
});

test("offline coverage planner derives only explicit bounded fixture calls", () => {
  const prompt = [
    "研发一个表达左旋多巴的ecoli菌株。",
    "Run the declared connector check and read designs/toggle_switch.proto.",
    "Search the approved toy parts library for hpa and pLac.",
    "Run local literature search, Europe PMC with fixture tests/fixtures/europe_pmc_search.json, Crossref with fixture tests/fixtures/crossref_search.json, UniProt with fixture tests/fixtures/uniprot_search.json, and Rhea with fixture tests/fixtures/rhea_search.tsv.",
  ].join(" ");
  const calls = planOfflineCoverageCalls(prompt);
  assert.ok(calls.some((call) => call.name === "proto_connectors_check"));
  assert.ok(calls.some((call) => call.name === "workspace_read" && call.arguments.path === "designs/toggle_switch.proto"));
  assert.ok(calls.some((call) => call.name === "proto_search_parts" && call.arguments.query === "hpa"));
  assert.ok(calls.some((call) => call.name === "proto_literature_search"));
  for (const call of calls.filter((candidate) => /europe_pmc|crossref|uniprot|rhea/.test(candidate.name))) {
    assert.equal(call.arguments.offline, true);
    assert.match(call.arguments.fixture, /^tests\/fixtures\//);
  }
  assert.equal(calls.some((call) => call.arguments.offline === false), false);
});

test("the exact Chinese L-DOPA strain prompt activates a bounded host safety contract", () => {
  const prompt = "研发一个表达左旋多巴的ecoli菌株";
  assert.equal(isHighRiskBiologicalDesignIntent(prompt), true);
  const contract = automaticSafetyDossierRequest(prompt);
  assert.ok(contract);
  assert.match(contract, /designs\/levodopa-evidence-dossier\.md/);
  assert.match(contract, /offline=true.*tests\/fixtures\/europe_pmc_search\.json/i);
  assert.match(contract, /scientific_design_decision.*NO-GO/is);
  assert.match(contract, /no.*wet-lab execution instructions/i);
  assert.equal(automaticSafetyDossierRequest("Summarize the README."), undefined);
});

test("a zero-output evidence quiz fails closed instead of claiming an empty model response", async () => {
  const prompt = "研发一个表达左旋多巴的ecoli菌株";
  const quiz = "测验1：请用本次运行账本中的命名空间证据ID说明 L-DOPA 相关生化关系；没有精确证据时必须回答 [Unresolved]，不得把假设当支持。";
  assert.match(failClosedEmptyResponse(quiz, [prompt]), /^\[Unresolved\]/);

  const database = new AppDatabase(":memory:");
  const complete = deferred();
  const model = { id: "empty-quiz-model", name: "Empty quiz model", contextLength: 32_768 };
  const agent = new AgentService(
    database,
    {
      get: () => model,
      getActiveModel: () => model,
      setToolCapability: () => {},
      chat: async () => {},
    },
    { read: async () => { throw new Error("No optional policy fixture"); } },
    { tools: async () => [], call: async () => ({ ok: true }) },
    (event) => {
      if (event.type === "message-complete") complete.resolve(event.message);
      if (event.type === "error") complete.reject(new Error(event.error));
    },
  );
  const thread = agent.createThread({
    workspacePath: "C:\\test-workspace",
    title: prompt,
    mode: "act",
    modelId: model.id,
  });
  database.addMessage(thread.id, {
    id: "prior-user",
    role: "user",
    content: prompt,
    createdAt: "2026-08-18T00:00:00.000Z",
  });
  database.addMessage(thread.id, {
    id: "prior-assistant",
    role: "assistant",
    content: "A fail-closed software evidence dossier is ready for review.",
    createdAt: "2026-08-18T00:00:01.000Z",
  });

  await agent.send(thread.id, quiz);
  const message = await complete.promise;

  assert.match(message.content, /^\[Unresolved\]/);
  assert.doesNotMatch(message.content, /No response was generated/);
  database.close();
});

test("a zero-output model still completes the automatic offline evidence workflow and proposes a safe dossier", async () => {
  const database = new AppDatabase(":memory:");
  const complete = deferred();
  const prompt = "研发一个表达左旋多巴的ecoli菌株";
  const model = { id: "zero-output-safety-model", name: "Zero output safety model", contextLength: 32_768 };
  const calls = [];
  const events = [];
  let proposed;
  let chatTurns = 0;
  const scientificTools = [
    "proto_connectors_check",
    "proto_search_parts",
    "proto_literature_search",
    "proto_europe_pmc_search",
    "proto_crossref_search",
    "proto_uniprot_search",
    "proto_rhea_search",
  ];
  const mcp = {
    tools: async () => scientificTools.map((name) => ({
      name,
      description: `Safe fixture tool ${name}.`,
      inputSchema: name === "proto_connectors_check"
        ? { type: "object", properties: {}, additionalProperties: false }
        : {
            type: "object",
            required: ["query"],
            properties: {
              query: { type: "string" },
              offline: { type: "boolean" },
              fixture: { type: "string" },
            },
            additionalProperties: false,
          },
    })),
    call: async (name, arguments_) => {
      calls.push({ name, arguments: structuredClone(arguments_) });
      if (/europe_pmc/.test(name)) return { ok: true, records: [{ pmid: "34181032" }] };
      if (/crossref/.test(name)) return { ok: true, records: [{ doi: "10.1000/example-crossref" }] };
      if (/uniprot/.test(name)) return { ok: true, records: [{ accession: "P00001" }] };
      if (/rhea/.test(name)) return { ok: true, records: [{ rhea_id: "12345" }] };
      return { ok: true, matches: [] };
    },
  };
  const workspace = {
    read: async (path) => ({ path, content: "{}", sha256: "0".repeat(64) }),
    proposePatch: async (input) => {
      proposed = input;
      return {
        id: "automatic-safety-patch",
        runId: input.runId,
        targetPath: input.targetPath,
        baseSha256: "base",
        before: "",
        after: input.after,
        unifiedDiff: input.after,
        rationale: input.rationale,
        status: "pending",
        createdAt: "2026-08-18T00:00:00.000Z",
      };
    },
  };
  const agent = new AgentService(
    database,
    {
      get: () => model,
      getActiveModel: () => model,
      setToolCapability: () => {},
      chat: async (_modelId, payload, onChunk) => {
        chatTurns += 1;
        if (chatTurns === 1) {
          const systemPolicy = payload.messages.find((message) =>
            message.role === "system" && /HOST_ENFORCED_SAFETY_WORKFLOW/.test(message.content));
          assert.ok(systemPolicy);
          assert.equal(payload.messages.filter((message) => message.role === "system").length, 1);
          const storedUser = payload.messages.find((message) => message.role === "user");
          assert.equal(storedUser.content, prompt);
          onChunk({ choices: [{ delta: { tool_calls: [
            {
              index: 0,
              id: "call_unrequested_network",
              type: "function",
              function: { name: "proto_pubmed_search", arguments: JSON.stringify({ query: "leak", offline: false }) },
            },
            {
              index: 1,
              id: "call_unrequested_compile",
              type: "function",
              function: { name: "proto_compile", arguments: JSON.stringify({ path: "designs/unsafe.proto" }) },
            },
          ] } }] });
          return;
        }
        if (chatTurns === 2) {
          throw new Error("The model produced malformed tool-call JSON. Retry once; after two consecutive failures it will be limited to Chat-only mode.");
        }
      },
    },
    workspace,
    mcp,
    (event) => {
      events.push(structuredClone(event));
      if (event.type === "message-complete") complete.resolve(event.message);
      if (event.type === "error") complete.reject(new Error(event.error));
    },
  );
  const thread = agent.createThread({
    workspacePath: "C:\\test-workspace",
    title: prompt,
    mode: "act",
    modelId: model.id,
  });

  await agent.send(thread.id, prompt);
  const message = await complete.promise;

  assert.equal(database.getMessages(thread.id).find((item) => item.role === "user").content, prompt);
  const runId = events.find((event) => event.type === "run-event" && event.runEvent.title === "Goal defined").runEvent.runId;
  assert.equal(database.getRunEvents(runId).find((event) => event.title === "Goal defined").summary, prompt);
  assert.ok(calls.some((call) => call.name === "proto_connectors_check"));
  assert.ok(calls.some((call) => call.name === "proto_search_parts" && call.arguments.query === "L-DOPA"));
  assert.ok(calls.some((call) => call.name === "proto_search_parts" && call.arguments.query === "tyrosine"));
  for (const call of calls.filter((item) => /europe_pmc|crossref|uniprot|rhea/.test(item.name))) {
    assert.equal(call.arguments.offline, true);
    assert.match(call.arguments.fixture, /^tests\/fixtures\//);
  }
  assert.equal(events.some((event) => event.type === "approval-required"), false);
  assert.equal(calls.some((call) => call.name === "proto_pubmed_search" || call.name === "proto_compile"), false);
  assert.equal(proposed.targetPath, "designs/levodopa-evidence-dossier.md");
  assert.match(proposed.after, /scientific_design_decision: NO-GO/i);
  assert.match(proposed.after, /no wet-lab execution instructions/i);
  assert.match(message.content, /scientific_design_decision: NO-GO/i);
  assert.match(message.content, /no wet-lab execution instructions/i);
  assert.equal(chatTurns, 2);
  database.close();
});

test("an orphaned persisted approval is invalidated instead of being executed by a rebuilt service", async () => {
  const database = new AppDatabase(":memory:");
  const approval = {
    id: "orphaned-approval",
    runId: "old-run",
    threadId: "old-thread",
    workspacePath: "C:\\old-workspace",
    serviceSessionId: "old-service-session",
    tool: "proto_run_python",
    arguments: { path: "scripts/untrusted.py" },
    argumentsSha256: "0".repeat(64),
    risk: "code-execution",
    status: "pending",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  database.saveApproval(approval);
  let toolCalls = 0;
  const agent = new AgentService(
    database,
    { get: () => undefined, getActiveModel: () => undefined },
    { read: async () => { throw new Error("No policy fixture"); } },
    { tools: async () => [], call: async () => { toolCalls += 1; return { ok: true }; } },
    () => {},
    undefined,
    "C:\\new-workspace",
  );

  await assert.rejects(agent.resolveApproval(approval.id, "approved"), /not bound to this live workspace request/);
  assert.equal(database.getApproval(approval.id).status, "stale");
  assert.equal(toolCalls, 0);
  database.close();
});

test("two consecutive server-side malformed tool calls downgrade the model to chat-only", async () => {
  const database = new AppDatabase(":memory:");
  const model = { id: "malformed-model", name: "Malformed tool model" };
  const capabilities = [];
  let chatTurns = 0;
  const models = {
    get: () => model,
    getActiveModel: () => model,
    setToolCapability: (_modelId, capability) => capabilities.push(capability),
    chat: async () => {
      chatTurns += 1;
      throw new Error("The model produced malformed tool-call JSON. Retry once.");
    },
  };
  const workspace = { read: async () => { throw new Error("No optional policy fixture"); } };
  const mcp = { tools: async () => [], call: async () => ({ ok: true }) };
  const terminal = deferred();
  const complete = deferred();
  const events = [];
  const agent = new AgentService(database, models, workspace, mcp, (event) => {
    events.push(event);
    if (event.type === "error") terminal.resolve(event.error);
    if (event.type === "message-complete") complete.resolve(event.message);
  });
  const thread = agent.createThread({
    workspacePath: "C:\\test-workspace",
    title: "Malformed tool downgrade",
    mode: "act",
    modelId: model.id,
  });

  await agent.send(thread.id, "Attempt repair");
  await terminal.promise;
  const message = await complete.promise;

  assert.equal(chatTurns, 2);
  assert.deepEqual(capabilities, ["chat-only"]);
  assert.match(message.content, /Run stopped before completion/);
  assert.ok(events.some((event) => event.type === "run-event" && event.runEvent.title === "Agent plan started" && event.runEvent.status === "failed"));
  database.close();
});

test("one malformed server response is repaired inside the same run", async () => {
  const database = new AppDatabase(":memory:");
  const model = { id: "repair-model", name: "Repair model" };
  const capabilities = [];
  const complete = deferred();
  let chatTurns = 0;
  const models = {
    get: () => model,
    getActiveModel: () => model,
    setToolCapability: (_modelId, capability) => capabilities.push(capability),
    chat: async (_modelId, payload, onChunk) => {
      chatTurns += 1;
      if (chatTurns === 1) {
        onChunk({ choices: [{ delta: { content: "Discard this partial response." } }] });
        onChunk({ choices: [{ delta: { tool_calls: [{
          index: 0,
          id: "partial_call",
          type: "function",
          function: { name: "proto_search_parts", arguments: "{\"query\":" },
        }] } }] });
        throw new Error("The model produced malformed tool-call JSON. Retry once.");
      }
      assert.equal(payload.messages[0].role, "system");
      assert.equal(payload.messages.at(-1).role, "user");
      assert.equal(payload.messages.slice(1).some((message) => message.role === "system"), false);
      onChunk({ choices: [{ delta: { content: "Recovered without losing the run." } }] });
    },
  };
  const workspace = { read: async () => { throw new Error("No optional policy fixture"); } };
  const mcp = { tools: async () => [], call: async () => ({ ok: true }) };
  const events = [];
  const agent = new AgentService(database, models, workspace, mcp, (event) => {
    events.push(event);
    if (event.type === "message-complete") complete.resolve(event.message);
  });
  const thread = agent.createThread({ workspacePath: "C:\\test-workspace", title: "Repair", mode: "act", modelId: model.id });

  await agent.send(thread.id, "Recover the turn.");
  const message = await complete.promise;

  assert.equal(chatTurns, 2);
  assert.equal(message.content, "Recovered without losing the run.");
  assert.equal(message.content.includes("Discard this partial response"), false);
  assert.deepEqual(capabilities, []);
  assert.ok(events.some((event) => event.type === "run-event" && event.runEvent.title === "Agent plan started" && event.runEvent.status === "completed"));
  database.close();
});

test("long artifact content can travel outside tool-call JSON", async () => {
  const database = new AppDatabase(":memory:");
  const model = { id: "artifact-model", name: "Artifact model" };
  const complete = deferred();
  const dossier = "# L-DOPA software review\n\nNO-GO: required reviewed CDS identifiers are missing.\n";
  let proposed;
  const models = {
    get: () => model,
    getActiveModel: () => model,
    setToolCapability: () => {},
    chat: async (_modelId, _payload, onChunk) => {
      onChunk({ choices: [{ delta: { content: dossier } }] });
      onChunk({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: "call_patch",
              type: "function",
              function: {
                name: "workspace_propose_patch",
                arguments: JSON.stringify({ path: "analyses/stress.md", rationale: "Create the reviewed dossier." }),
              },
            }],
          },
        }],
      });
    },
  };
  const workspace = {
    read: async () => { throw new Error("No optional policy fixture"); },
    proposePatch: async (input) => {
      proposed = input;
      return {
        id: "patch-1",
        runId: input.runId,
        targetPath: input.targetPath,
        baseSha256: "base",
        before: "",
        after: input.after,
        unifiedDiff: input.after,
        rationale: input.rationale,
        status: "pending",
        createdAt: "2026-07-13T00:00:00.000Z",
      };
    },
  };
  const mcp = { tools: async () => [], call: async () => ({ ok: true }) };
  const events = [];
  const agent = new AgentService(database, models, workspace, mcp, (event) => {
    events.push(event);
    if (event.type === "message-complete") complete.resolve(event.message);
  });
  const thread = agent.createThread({ workspacePath: "C:\\test-workspace", title: "Artifact", mode: "act", modelId: model.id });

  await agent.send(thread.id, "Use workspace_propose_patch for analyses/stress.md.");
  await complete.promise;

  assert.equal(proposed.after, dossier.trim());
  assert.equal(proposed.targetPath, "analyses/stress.md");
  assert.ok(events.some((event) => event.type === "patch-proposal" && event.patch.id === "patch-1"));
  database.close();
});

test("an incomplete direct patch proposal is rejected and corrected in the same run", async () => {
  const database = new AppDatabase(":memory:");
  const model = { id: "direct-artifact-gate-model", name: "Direct artifact gate model" };
  const complete = deferred();
  const completeDossier = [
    "# Software Review",
    "## Corrected Goal",
    "Produce the metabolite.",
    "## High-Level Pathway Architecture",
    "Unsupported details remain unresolved.",
    "## Requirement-to-Evidence Matrix",
    "| Requirement | Evidence |",
    "| --- | --- |",
    "| Route | PMID:34181032 |",
    "## Inventory Table",
    "| Function | Status |",
    "| --- | --- |",
    "| Pathway CDS | missing ID |",
    "## Chassis and Burden Assumptions",
    "Chassis and burden assumptions require review.",
    "## Toolchain Coverage Gaps",
    "Toolchain coverage gaps remain.",
    "## Failure Modes",
    "Invented identifiers would invalidate the design.",
    "## Unresolved Scientific Questions",
    "Mechanistic claims remain unresolved.",
    "## Software Validation Criteria",
    "Use only returned identifiers.",
    "## Decision",
    "NO-GO.",
    "## Safety Boundary",
    "Software review only.",
  ].join("\n\n");
  let chatTurns = 0;
  let proposed;
  const models = {
    get: () => model,
    getActiveModel: () => model,
    setToolCapability: () => {},
    chat: async (_modelId, payload, onChunk) => {
      chatTurns += 1;
      if (chatTurns === 2) {
        assert.equal(payload.messages.at(-1).role, "tool");
        assert.match(payload.messages.at(-1).content, /Artifact is incomplete and cannot be proposed/i);
      }
      onChunk({ choices: [{ delta: { content: chatTurns === 1 ? "# Review\n\n## Corrected Goal\n\nTruncated (" : completeDossier } }] });
      onChunk({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: `call_direct_gate_${chatTurns}`,
              type: "function",
              function: {
                name: "workspace_propose_patch",
                arguments: JSON.stringify({ path: "analyses/direct-gate.md", rationale: "Create the reviewed dossier." }),
              },
            }],
          },
        }],
      });
    },
  };
  const workspace = {
    read: async () => { throw new Error("No optional policy fixture"); },
    proposePatch: async (input) => {
      proposed = input;
      return {
        id: "direct-gate-patch",
        runId: input.runId,
        targetPath: input.targetPath,
        baseSha256: "base",
        before: "",
        after: input.after,
        unifiedDiff: input.after,
        rationale: input.rationale,
        status: "pending",
        createdAt: "2026-07-13T00:00:00.000Z",
      };
    },
  };
  const mcp = { tools: async () => [], call: async () => ({ ok: true }) };
  const events = [];
  const agent = new AgentService(database, models, workspace, mcp, (event) => {
    events.push(structuredClone(event));
    if (event.type === "message-complete") complete.resolve(event.message);
  });
  const thread = agent.createThread({
    workspacePath: "C:\\test-workspace",
    title: "Direct artifact gate",
    mode: "act",
    modelId: model.id,
  });

  await agent.send(
    thread.id,
    "Target deliverable: analyses/direct-gate.md. The dossier must include: corrected goal; high-level pathway architecture; requirement-to-evidence matrix with source identifiers; inventory table; chassis and burden assumptions; toolchain coverage gaps; failure modes; unresolved scientific questions; software validation criteria; and safety boundary. Decision rule: return GO or NO-GO. Use workspace_propose_patch.",
  );
  await complete.promise;

  assert.equal(chatTurns, 2);
  assert.equal(proposed.after, completeDossier);
  const proposalEvents = events.filter((event) => event.type === "run-event" && event.runEvent.title === "Propose Patch");
  assert.deepEqual(proposalEvents.map((event) => event.runEvent.status), ["running", "failed", "running", "completed"]);
  database.close();
});

test("malformed long patch calls recover the artifact body without another tool call", async () => {
  const database = new AppDatabase(":memory:");
  const model = { id: "artifact-recovery-model", name: "Artifact recovery model" };
  const complete = deferred();
  const dossier = "# L-DOPA software review\n\n## Decision\n\nNO-GO because reviewed pathway CDS identifiers are missing.\n";
  const capabilities = [];
  let chatTurns = 0;
  let proposed;
  const models = {
    get: () => model,
    getActiveModel: () => model,
    setToolCapability: (_modelId, capability) => capabilities.push(capability),
    chat: async (_modelId, payload, onChunk) => {
      chatTurns += 1;
      if (chatTurns === 1) {
        onChunk({ choices: [{ delta: { content: "The required pathway identifiers are missing." } }] });
        throw new Error("The model produced malformed tool-call JSON. Retry once.");
      }
      assert.equal(payload.tool_choice, "none");
      assert.equal(payload.messages[0].role, "system");
      assert.equal(payload.messages.at(-1).role, "user");
      assert.equal(payload.messages.slice(1).some((message) => message.role === "system"), false);
      onChunk({ choices: [{ delta: { content: `\`\`\`markdown\n${dossier}\`\`\`` } }] });
    },
  };
  const workspace = {
    read: async () => { throw new Error("No optional policy fixture"); },
    proposePatch: async (input) => {
      proposed = input;
      return {
        id: "patch-recovered",
        runId: input.runId,
        targetPath: input.targetPath,
        baseSha256: "base",
        before: "",
        after: input.after,
        unifiedDiff: input.after,
        rationale: input.rationale,
        status: "pending",
        createdAt: "2026-07-13T00:00:00.000Z",
      };
    },
  };
  const mcp = { tools: async () => [], call: async () => ({ ok: true }) };
  const events = [];
  const agent = new AgentService(database, models, workspace, mcp, (event) => {
    events.push(event);
    if (event.type === "message-complete") complete.resolve(event.message);
  });
  const thread = agent.createThread({
    workspacePath: "C:\\test-workspace",
    title: "Recover artifact",
    mode: "act",
    modelId: model.id,
  });

  await agent.send(
    thread.id,
    "Target deliverable: analyses/recovered.md. Use workspace_propose_patch and stop for review.",
  );
  await complete.promise;

  assert.equal(chatTurns, 2);
  assert.equal(proposed.targetPath, "analyses/recovered.md");
  assert.equal(proposed.after, dossier.trim());
  assert.deepEqual(capabilities, ["agent-ready"]);
  assert.ok(events.some((event) =>
    event.type === "run-event" && event.runEvent.title === "Recovering artifact proposal" && event.runEvent.status === "completed",
  ));
  assert.ok(events.some((event) => event.type === "patch-proposal" && event.patch.id === "patch-recovered"));
  database.close();
});

test("an explicit patch request gets one corrective turn instead of a false completion", async () => {
  const database = new AppDatabase(":memory:");
  const model = { id: "patch-reminder-model", name: "Patch reminder model" };
  const complete = deferred();
  let chatTurns = 0;
  let proposed;
  const models = {
    get: () => model,
    getActiveModel: () => model,
    setToolCapability: () => {},
    chat: async (_modelId, _payload, onChunk) => {
      chatTurns += 1;
      if (chatTurns === 1) {
        onChunk({ choices: [{ delta: { content: "I would make the dossier the reviewed artifact." } }] });
        return;
      }
      onChunk({ choices: [{ delta: { content: "# Reviewed dossier\n\nNO-GO.\n" } }] });
      onChunk({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: "call_reminded_patch",
              type: "function",
              function: {
                name: "workspace_propose_patch",
                arguments: JSON.stringify({ path: "analyses/reminded.md", rationale: "Create the required artifact." }),
              },
            }],
          },
        }],
      });
    },
  };
  const workspace = {
    read: async () => { throw new Error("No optional policy fixture"); },
    proposePatch: async (input) => {
      proposed = input;
      return {
        id: "patch-reminded",
        runId: input.runId,
        targetPath: input.targetPath,
        baseSha256: "base",
        before: "",
        after: input.after,
        unifiedDiff: input.after,
        rationale: input.rationale,
        status: "pending",
        createdAt: "2026-07-13T00:00:00.000Z",
      };
    },
  };
  const mcp = { tools: async () => [], call: async () => ({ ok: true }) };
  const agent = new AgentService(database, models, workspace, mcp, (event) => {
    if (event.type === "message-complete") complete.resolve(event.message);
  });
  const thread = agent.createThread({ workspacePath: "C:\\test-workspace", title: "Reminder", mode: "act", modelId: model.id });

  await agent.send(thread.id, "Use workspace_propose_patch for analyses/reminded.md.");
  await complete.promise;

  assert.equal(chatTurns, 2);
  assert.equal(proposed.after, "# Reviewed dossier\n\nNO-GO.");
  database.close();
});

test("an omitted patch tool call is recovered after the corrective turn", async () => {
  const database = new AppDatabase(":memory:");
  const model = { id: "missing-patch-recovery-model", name: "Missing patch recovery model" };
  const complete = deferred();
  const dossier = "# Reviewed L-DOPA dossier\n\nNO-GO: required reviewed pathway CDS identifiers are missing.\n";
  let chatTurns = 0;
  let proposed;
  let recoveryWasRunningBeforeCorrectiveTurn = false;
  const models = {
    get: () => model,
    getActiveModel: () => model,
    setToolCapability: () => {},
    chat: async (_modelId, payload, onChunk) => {
      chatTurns += 1;
      if (chatTurns === 1) {
        onChunk({ choices: [{ delta: { content: "I will make the dossier the reviewed artifact." } }] });
        return;
      }
      if (chatTurns === 2) {
        assert.equal(recoveryWasRunningBeforeCorrectiveTurn, true);
        assert.equal(payload.messages.at(-1).role, "user");
        onChunk({ choices: [{ delta: { content: "# Incomplete dossier\n\nThe model omitted the tool again." } }] });
        return;
      }
      assert.equal(payload.tool_choice, "none");
      assert.equal(payload.messages[0].role, "system");
      assert.equal(payload.messages.at(-1).role, "user");
      assert.equal(payload.messages.slice(1).some((message) => message.role === "system"), false);
      onChunk({ choices: [{ delta: { content: `\`\`\`markdown\n${dossier}\`\`\`` } }] });
    },
  };
  const workspace = {
    read: async () => { throw new Error("No optional policy fixture"); },
    proposePatch: async (input) => {
      proposed = input;
      return {
        id: "patch-recovered-after-omission",
        runId: input.runId,
        targetPath: input.targetPath,
        baseSha256: "base",
        before: "",
        after: input.after,
        unifiedDiff: input.after,
        rationale: input.rationale,
        status: "pending",
        createdAt: "2026-07-13T00:00:00.000Z",
      };
    },
  };
  const mcp = { tools: async () => [], call: async () => ({ ok: true }) };
  const events = [];
  const agent = new AgentService(database, models, workspace, mcp, (event) => {
    events.push(event);
    if (
      event.type === "run-event"
      && event.runEvent.title === "Recovering artifact proposal"
      && event.runEvent.status === "running"
    ) recoveryWasRunningBeforeCorrectiveTurn = true;
    if (event.type === "message-complete") complete.resolve(event.message);
  });
  const thread = agent.createThread({
    workspacePath: "C:\\test-workspace",
    title: "Recover omitted patch",
    mode: "act",
    modelId: model.id,
  });

  await agent.send(
    thread.id,
    "Target deliverable: analyses/omitted.md. Use workspace_propose_patch and stop for review.",
  );
  await complete.promise;

  assert.equal(chatTurns, 3);
  assert.equal(proposed.targetPath, "analyses/omitted.md");
  assert.equal(proposed.after, dossier.trim());
  assert.ok(events.some((event) =>
    event.type === "run-event" && event.runEvent.title === "Recovering artifact proposal" && event.runEvent.status === "completed",
  ));
  assert.ok(events.some((event) =>
    event.type === "patch-proposal" && event.patch.id === "patch-recovered-after-omission",
  ));
  assert.ok(events.some((event) =>
    event.type === "run-event" && event.runEvent.title === "Agent plan started" && event.runEvent.status === "completed",
  ));
  database.close();
});

test("a complete corrective dossier is reused, bounded, and deduplicated without another model turn", async () => {
  const database = new AppDatabase(":memory:");
  const complete = deferred();
  const repeated = "[Unsupported] This deliberately repeated bibliographic narrative is longer than the deduplication threshold and must appear only once in the proposed review artifact.";
  const dossier = [
    "# L-DOPA Software Review",
    "## Corrected Goal",
    "Software-only metabolite design review.",
    "## High-Level Pathway Architecture",
    "[Unsupported] Pathway details require reviewed evidence.",
    "## Requirement-to-Evidence Matrix",
    "| Requirement | Evidence |",
    "| --- | --- |",
    "| Route | unsupported |",
    "## Inventory Table",
    "| Function | Status |",
    "| --- | --- |",
    "| Essential CDS | missing ID |",
    "## Chassis and Burden Assumptions",
    "[Assumption] The software chassis remains unvalidated.",
    "## Toolchain Coverage Gaps",
    "No reviewed pathway CDS identifier was returned.",
    "## Failure Modes",
    repeated,
    repeated,
    "## Unresolved Scientific Questions",
    "Evidence gaps remain unresolved.",
    "## Software Validation Criteria",
    "Every identifier must be tool-returned before compilation.",
    "## Decision",
    "NO-GO for .proto compilation.",
    "## Safety Boundary",
    "Software and evidence review only; no wet-lab instructions.",
  ].join("\n\n");
  let chatTurns = 0;
  let proposed;
  const model = { id: "reuse-corrective-dossier", name: "Reuse corrective dossier", contextLength: 8_192 };
  const models = {
    get: () => model,
    getActiveModel: () => model,
    setToolCapability: () => {},
    chat: async (_modelId, _payload, onChunk) => {
      chatTurns += 1;
      onChunk({ choices: [{ delta: { content: chatTurns === 1 ? "I still need to propose the dossier." : dossier } }] });
    },
  };
  const workspace = {
    read: async () => { throw new Error("No optional policy fixture"); },
    proposePatch: async (input) => {
      proposed = input;
      return {
        id: "reused-corrective-patch",
        runId: input.runId,
        targetPath: input.targetPath,
        baseSha256: "base",
        before: "",
        after: input.after,
        unifiedDiff: input.after,
        rationale: input.rationale,
        status: "pending",
        createdAt: "2026-07-19T00:00:00.000Z",
      };
    },
  };
  const agent = new AgentService(
    database,
    models,
    workspace,
    { tools: async () => [], call: async () => ({ ok: true }) },
    (event) => {
      if (event.type === "message-complete") complete.resolve(event.message);
    },
  );
  const thread = agent.createThread({
    workspacePath: "C:\\test-workspace",
    title: "Reuse corrective dossier",
    mode: "act",
    modelId: model.id,
  });

  await agent.send(
    thread.id,
    "Target deliverable: analyses/reused.md. The dossier must include: corrected goal; pathway architecture; requirement-to-evidence matrix; inventory table; chassis and burden assumptions; toolchain coverage gaps; failure modes; unresolved scientific questions; software validation criteria; and safety boundary. Decision rule: return GO or NO-GO. Use workspace_propose_patch.",
  );
  await complete.promise;

  assert.equal(chatTurns, 2);
  assert.equal(proposed.targetPath, "analyses/reused.md");
  assert.equal(proposed.after.split(repeated).length - 1, 1);
  database.close();
});

test("an incomplete recovered dossier is retried before a patch can be proposed", async () => {
  const database = new AppDatabase(":memory:");
  const model = { id: "dossier-completeness-model", name: "Dossier completeness model" };
  const complete = deferred();
  const completeDossier = [
    "# L-DOPA Software Review",
    "## Corrected Goal",
    "Produce a metabolite; do not describe it as gene expression.",
    "## High-Level Pathway Architecture",
    "Mechanistic details not established by returned evidence remain unsupported.",
    "## Requirement-to-Evidence Matrix",
    "| Requirement | Evidence |",
    "| --- | --- |",
    "| High-level route | PMID:34181032 |",
    "## Inventory Table",
    "| Function | Status |",
    "| --- | --- |",
    "| Essential pathway CDS | missing ID |",
    "## Chassis and Burden Assumptions",
    "Chassis and burden assumptions require human review.",
    "## Toolchain Coverage Gaps",
    "The toolchain does not establish pathway CDS identifiers.",
    "## Failure Modes",
    "Unsupported identifiers would invalidate compilation.",
    "## Unresolved Scientific Questions",
    "Mechanism and cofactor claims remain unresolved.",
    "## Software Validation Criteria",
    "All identifiers must be returned by approved tools.",
    "## Decision",
    "NO-GO for .proto compilation.",
    "## Safety Boundary",
    "Software and evidence review only; no wet-lab instructions.",
  ].join("\n\n");
  const [firstDraft, continuation] = completeDossier.split("\n\n## Toolchain Coverage Gaps\n\n");
  const continuationDraft = `## Toolchain Coverage Gaps\n\n${continuation}`;
  let chatTurns = 0;
  let proposed;
  const models = {
    get: () => model,
    getActiveModel: () => model,
    setToolCapability: () => {},
    chat: async (_modelId, payload, onChunk) => {
      chatTurns += 1;
      if (chatTurns <= 2) {
        onChunk({ choices: [{ delta: { content: "I did not create the required patch." } }] });
        return;
      }
      assert.equal(payload.tool_choice, "none");
      if (chatTurns === 3) {
        onChunk({ choices: [{ delta: { content: `\`\`\`markdown\n${firstDraft}` } }] });
        return;
      }
      assert.match(payload.messages.at(-1).content, /Continue the existing Markdown artifact/i);
      assert.match(payload.messages.at(-1).content, /missing toolchain coverage gaps/i);
      onChunk({ choices: [{ delta: { content: continuationDraft } }] });
    },
  };
  const workspace = {
    read: async () => { throw new Error("No optional policy fixture"); },
    proposePatch: async (input) => {
      proposed = input;
      return {
        id: "complete-dossier-patch",
        runId: input.runId,
        targetPath: input.targetPath,
        baseSha256: "base",
        before: "",
        after: input.after,
        unifiedDiff: input.after,
        rationale: input.rationale,
        status: "pending",
        createdAt: "2026-07-13T00:00:00.000Z",
      };
    },
  };
  const mcp = { tools: async () => [], call: async () => ({ ok: true }) };
  const agent = new AgentService(database, models, workspace, mcp, (event) => {
    if (event.type === "message-complete") complete.resolve(event.message);
  });
  const thread = agent.createThread({
    workspacePath: "C:\\test-workspace",
    title: "Complete recovered dossier",
    mode: "act",
    modelId: model.id,
  });

  await agent.send(
    thread.id,
    "Target deliverable: analyses/complete.md. The dossier must include: corrected goal; high-level pathway architecture; requirement-to-evidence matrix with source identifiers; inventory table; chassis and burden assumptions; toolchain coverage gaps; failure modes; unresolved scientific questions; software validation criteria; and safety boundary. Decision rule: return GO or NO-GO. Use workspace_propose_patch.",
  );
  await complete.promise;

  assert.equal(chatTurns, 4);
  assert.equal(proposed.after, completeDossier);
  database.close();
});

test("an incomplete non-Proto artifact is blocked again at approval time", () => {
  const database = new AppDatabase(":memory:");
  const model = { id: "approval-gate-model", name: "Approval gate model" };
  const models = { get: () => model, getActiveModel: () => model, setToolCapability: () => {} };
  const workspace = { read: async () => { throw new Error("No optional policy fixture"); } };
  const mcp = { tools: async () => [], call: async () => ({ ok: true }) };
  const agent = new AgentService(database, models, workspace, mcp, () => {});
  const runId = "approval-gate-run";
  database.appendEvent({
    id: "approval-gate-goal",
    runId,
    stage: "goal",
    actor: "user",
    title: "Goal defined",
    summary: "The dossier must include: corrected goal; high-level pathway architecture; requirement-to-evidence matrix with source identifiers; inventory table; chassis and burden assumptions; toolchain coverage gaps; failure modes; unresolved scientific questions; software validation criteria; and safety boundary. Decision rule: return GO or NO-GO.",
    inputProvenance: [],
    outputArtifacts: [],
    evidenceIds: [],
    status: "completed",
    createdAt: "2026-07-13T00:00:00.000Z",
    completedAt: "2026-07-13T00:00:00.000Z",
  });
  const patch = {
    id: "incomplete-approval-patch",
    runId,
    targetPath: "C:\\test-workspace\\analyses\\review.md",
    baseSha256: "base",
    before: "",
    after: "# Review\n\n## Corrected Goal\n\nA truncated claim (",
    unifiedDiff: "+# Review",
    rationale: "Review dossier",
    status: "pending",
    createdAt: "2026-07-13T00:00:00.000Z",
  };
  database.savePatch(patch);

  assert.throws(
    () => agent.assertPatchReadyForApproval(patch.id),
    /Artifact is incomplete and cannot be approved:.*requirement-to-evidence matrix.*safety boundary/i,
  );
  database.close();
});

test("evidence-sensitive artifacts require claim tags and tool-returned source IDs", () => {
  const database = new AppDatabase(":memory:");
  const model = { id: "grounding-gate-model", name: "Grounding gate model" };
  const models = { get: () => model, getActiveModel: () => model, setToolCapability: () => {} };
  const workspace = { read: async () => { throw new Error("No optional policy fixture"); } };
  const mcp = { tools: async () => [], call: async () => ({ ok: true }) };
  const agent = new AgentService(database, models, workspace, mcp, () => {});
  const runId = "grounding-gate-run";
  const baseEvent = {
    runId,
    inputProvenance: [],
    outputArtifacts: [],
    status: "completed",
    createdAt: "2026-07-13T00:00:00.000Z",
    completedAt: "2026-07-13T00:00:00.000Z",
  };
  database.appendEvent({
    ...baseEvent,
    id: "grounding-goal",
    stage: "goal",
    actor: "user",
    title: "Goal defined",
    summary: "The dossier must include corrected goal, high-level pathway architecture, chassis and burden assumptions, failure modes, and a safety boundary. Cite only exact evidence identifiers actually returned by tools and preserve identifier namespaces.",
    evidenceIds: [],
  });
  database.appendEvent({
    ...baseEvent,
    id: "grounding-source",
    stage: "plan",
    actor: "tool",
    title: "Europe PMC Search",
    summary: "Tool completed.",
    evidenceIds: ["PMID:34181032", "UniProt:P00001", "RHEA:12345"],
  });
  const completeBody = (architectureLine) => [
    "# Review",
    "## Corrected Goal",
    "Review a metabolite-production software concept.",
    "## High-Level Pathway Architecture",
    architectureLine,
    "## Chassis and Burden Assumptions",
    "[Assumption] Chassis burden remains a review assumption.",
    "## Failure Modes",
    "- [Unsupported] No returned source established a chassis-specific failure mode.",
    "## Safety Boundary",
    "Software and evidence review only.",
  ].join("\n\n");
  const patch = {
    id: "grounding-patch",
    runId,
    targetPath: "C:\\test-workspace\\analyses\\grounding.md",
    baseSha256: "base",
    before: "",
    after: `${completeBody("A hydroxylation route is established.")}\n\nworkspace_propose_patch with path analyses/grounding.md`,
    unifiedDiff: "+# Review",
    rationale: "Review dossier",
    status: "pending",
    createdAt: "2026-07-13T00:00:00.000Z",
  };
  database.savePatch(patch);

  assert.throws(
    () => agent.assertPatchReadyForApproval(patch.id),
    /tool-call narration|ungrounded scientific claim/i,
  );

  patch.after = completeBody("[Supported: DOI:10.1000/not-returned] A hydroxylation route is established.");
  database.savePatch(patch);
  assert.throws(
    () => agent.assertPatchReadyForApproval(patch.id),
    /identifiers not returned by tools: DOI:10.1000\/not-returned/i,
  );

  patch.after = completeBody("[Assumption] Tyrosine decarboxylase converts tyrosine to L-DOPA.");
  database.savePatch(patch);
  assert.throws(
    () => agent.assertPatchReadyForApproval(patch.id),
    /biochemical relation claim.*exact returned source.*Unresolved/i,
  );

  patch.after = `${completeBody("[Unresolved] Whether any enzyme converts tyrosine to L-DOPA is not established by returned evidence.")}\n\nInventory evidence: P00001 and 12345.`;
  database.savePatch(patch);
  assert.throws(
    () => agent.assertPatchReadyForApproval(patch.id),
    /source identifier lost its namespace.*UniProt:P00001/i,
  );

  patch.after = completeBody("[Unresolved] Whether any enzyme converts tyrosine to L-DOPA is not established by returned evidence.")
    .replace("Software and evidence review only.", "Select a non-pathogenic strain and dispose biological waste according to local rules.");
  database.savePatch(patch);
  assert.throws(
    () => agent.assertPatchReadyForApproval(patch.id),
    /imperative wet-lab recommendation/i,
  );

  patch.after = `${completeBody("[Supported: PMID:34181032] The returned publication discusses enzyme selection context.")}\n\nInventory evidence: UniProt:P00001 and RHEA:12345.`;
  database.savePatch(patch);
  assert.doesNotThrow(() => agent.assertPatchReadyForApproval(patch.id));
  database.close();
});

test("fail-closed dossier keeps software status separate from scientific NO-GO", () => {
  const database = new AppDatabase(":memory:");
  const model = { id: "decision-gate-model", name: "Decision gate model" };
  const agent = new AgentService(
    database,
    { get: () => model, getActiveModel: () => model, setToolCapability: () => {} },
    { read: async () => { throw new Error("No optional policy fixture"); } },
    { tools: async () => [], call: async () => ({ ok: true }) },
    () => {},
  );
  const runId = "decision-gate-run";
  database.appendEvent({
    id: "decision-gate-goal",
    runId,
    stage: "goal",
    actor: "user",
    title: "Goal defined",
    summary: "Apply a fail-closed decision rule and declare NO-GO if identifiers are absent. Report software_pipeline_status separately from scientific_design_decision. The dossier must include a safety boundary.",
    inputProvenance: [],
    outputArtifacts: [],
    evidenceIds: [],
    status: "completed",
    createdAt: "2026-08-18T00:00:00.000Z",
    completedAt: "2026-08-18T00:00:00.000Z",
  });
  const patch = {
    id: "decision-gate-patch",
    runId,
    targetPath: "C:\\test-workspace\\analyses\\decision.md",
    baseSha256: "base",
    before: "",
    after: "# Review\n\n## Decision\n\nPass with warnings.\n\n## Safety Boundary\n\nSoftware review only.",
    unifiedDiff: "+# Review",
    rationale: "Review dossier",
    status: "pending",
    createdAt: "2026-08-18T00:00:00.000Z",
  };
  database.savePatch(patch);
  assert.throws(
    () => agent.assertPatchReadyForApproval(patch.id),
    /scientific design decision must remain NO-GO.*software_pipeline_status.*scientific_design_decision/i,
  );

  patch.after = "# Review\n\nsoftware_pipeline_status: PASS\n\n## Decision\n\nscientific_design_decision: NO-GO.\n\n## Safety Boundary\n\nSoftware and evidence review only; human approval remains required.";
  database.savePatch(patch);
  assert.doesNotThrow(() => agent.assertPatchReadyForApproval(patch.id));
  database.close();
});

test("ledger-bound fail-closed dossier passes the same evidence and safety gate", () => {
  const database = new AppDatabase(":memory:");
  const model = { id: "fallback-dossier-model", name: "Fallback dossier model" };
  const agent = new AgentService(
    database,
    { get: () => model, getActiveModel: () => model, setToolCapability: () => {} },
    { read: async () => { throw new Error("No optional policy fixture"); } },
    { tools: async () => [], call: async () => ({ ok: true }) },
    () => {},
  );
  const runId = "fallback-dossier-run";
  const request = "For an L-DOPA E. coli review, apply a fail-closed decision rule and declare NO-GO for a compilable design. The dossier must include corrected goal; high-level pathway architecture; requirement-to-evidence matrix with source identifiers; inventory table; chassis and burden assumptions; toolchain coverage gaps; failure modes; unresolved scientific questions; software validation criteria; safety boundary; software_pipeline_status; and scientific_design_decision. Cite only exact evidence identifiers actually returned and preserve every identifier namespace.";
  database.appendEvent({
    id: "fallback-goal",
    runId,
    stage: "goal",
    actor: "user",
    title: "Goal defined",
    summary: request,
    inputProvenance: [],
    outputArtifacts: [],
    evidenceIds: [],
    status: "completed",
    createdAt: "2026-08-18T00:00:00.000Z",
    completedAt: "2026-08-18T00:00:00.000Z",
  });
  const evidenceIds = ["PMID:34181032", "DOI:10.1000/example-crossref", "UniProt:P00001", "RHEA:12345"];
  database.appendEvent({
    id: "fallback-evidence",
    runId,
    stage: "plan",
    actor: "tool",
    title: "Fixture evidence",
    summary: "Fixture evidence returned.",
    inputProvenance: [],
    outputArtifacts: [],
    evidenceIds,
    status: "completed",
    createdAt: "2026-08-18T00:00:01.000Z",
    completedAt: "2026-08-18T00:00:01.000Z",
  });
  const dossier = buildFailClosedEvidenceDossier(request, evidenceIds);
  assert.ok(dossier);
  assert.match(dossier, /scientific_design_decision: NO-GO/i);
  const patch = {
    id: "fallback-dossier-patch",
    runId,
    targetPath: "C:\\test-workspace\\analyses\\fallback.md",
    baseSha256: "base",
    before: "",
    after: dossier,
    unifiedDiff: `+${dossier}`,
    rationale: "Fail-closed fallback",
    status: "pending",
    createdAt: "2026-08-18T00:00:02.000Z",
  };
  database.savePatch(patch);
  assert.doesNotThrow(() => agent.assertPatchReadyForApproval(patch.id));
  database.close();
});

test("an approved non-Proto artifact receives explicit validation and review boundaries", async () => {
  const database = new AppDatabase(":memory:");
  const model = { id: "review-model", name: "Review model" };
  let mcpCalls = 0;
  const models = { get: () => model, getActiveModel: () => model, setToolCapability: () => {} };
  const workspace = { read: async () => { throw new Error("No optional policy fixture"); } };
  const mcp = { tools: async () => [], call: async () => { mcpCalls += 1; return { ok: true }; } };
  const agent = new AgentService(database, models, workspace, mcp, () => {});
  const patch = {
    id: "artifact-patch",
    runId: "artifact-run",
    targetPath: "C:\\test-workspace\\analyses\\stress.md",
    baseSha256: "base",
    before: "",
    after: "# Review",
    unifiedDiff: "+# Review",
    rationale: "Approve dossier",
    status: "approved",
    createdAt: "2026-07-13T00:00:00.000Z",
  };

  const events = await agent.afterPatchApplied(patch);
  const review = database.getReview(patch.runId);
  const durableEvents = database.getRunEvents(patch.runId);

  assert.deepEqual(events.map((event) => event.stage), ["design", "validate", "review"]);
  assert.deepEqual(durableEvents.map((event) => event.stage), ["design", "validate", "review"]);
  assert.ok(durableEvents.every((event) => event.status === "approved" || event.status === "completed"));
  assert.equal(mcpCalls, 0);
  assert.equal(review.packetPath, patch.targetPath);
  assert.equal(review.gate, "review-required");
  assert.match(review.summary, /Proto check, compile, and workflow validation were not run/);
  database.close();
});

test("failed Proto validation is durably recorded before review is blocked", async () => {
  const database = new AppDatabase(":memory:");
  const model = { id: "validation-failure-model", name: "Validation failure model" };
  const models = { get: () => model, getActiveModel: () => model, setToolCapability: () => {} };
  const workspace = { read: async () => { throw new Error("No optional policy fixture"); } };
  const calls = [];
  const mcp = {
    tools: async () => [],
    call: async (name) => {
      calls.push(name);
      return { ok: false, diagnostics: [{ code: "TEST_FAILURE", message: "Deterministic fixture failure." }] };
    },
  };
  const agent = new AgentService(database, models, workspace, mcp, () => {});
  const patch = {
    id: "failed-proto-patch",
    runId: "failed-proto-run",
    targetPath: "C:\\test-workspace\\designs\\failed.proto",
    baseSha256: "base",
    before: "",
    after: "design failed_fixture chassis ecoli_k12\n",
    unifiedDiff: "+design failed_fixture chassis ecoli_k12",
    rationale: "Exercise a deterministic validation failure.",
    status: "approved",
    createdAt: "2026-08-30T00:00:00.000Z",
  };

  const events = await agent.afterPatchApplied(patch);
  const durableEvents = database.getRunEvents(patch.runId);
  const review = database.getReview(patch.runId);

  assert.deepEqual(calls, ["proto_check"]);
  assert.deepEqual(events.map((event) => event.status), ["approved", "failed"]);
  assert.deepEqual(durableEvents.map((event) => event.status), ["approved", "failed"]);
  assert.equal(review.gate, "blocked");
  assert.match(review.summary, /validation failed/i);
  database.close();
});

test("connector availability checks remain in the plan stage", async () => {
  const database = new AppDatabase(":memory:");
  const complete = deferred();
  const model = { id: "stage-model", name: "Stage model" };
  let chatTurns = 0;
  const models = {
    get: () => model,
    getActiveModel: () => model,
    setToolCapability: () => {},
    chat: async (_modelId, _payload, onChunk) => {
      chatTurns += 1;
      if (chatTurns === 1) {
        onChunk({
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: "call_connectors",
                type: "function",
                function: { name: "proto_connectors_check", arguments: "{}" },
              }],
            },
          }],
        });
        return;
      }
      onChunk({ choices: [{ delta: { content: "Connector inspection complete." } }] });
    },
  };
  const mcp = {
    tools: async () => [{
      name: "proto_connectors_check",
      description: "Inspect declared connectors.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    }],
    call: async () => ({ ok: true, summary: "Local connectors inspected." }),
  };
  const workspace = { read: async () => { throw new Error("No optional policy fixture"); } };
  const events = [];
  const agent = new AgentService(database, models, workspace, mcp, (event) => {
    events.push(event);
    if (event.type === "message-complete") complete.resolve(event.message);
  });
  const thread = agent.createThread({ workspacePath: "C:\\test-workspace", title: "Stages", mode: "act", modelId: model.id });

  await agent.send(thread.id, "Inspect connectors.");
  await complete.promise;

  const connectorEvent = events.find((event) => event.type === "run-event" && event.runEvent.tool === "proto_connectors_check");
  assert.equal(connectorEvent.runEvent.stage, "plan");
  database.close();
});

test("tool budget exhaustion produces a failed run and resumable checkpoint", async () => {
  const database = new AppDatabase(":memory:");
  const complete = deferred();
  const model = { id: "budget-model", name: "Budget model" };
  let toolCalls = 0;
  let finalSynthesisCalls = 0;
  const models = {
    get: () => model,
    getActiveModel: () => model,
    setToolCapability: () => {},
    chat: async (_modelId, payload, onChunk) => {
      if (!payload.tools) {
        finalSynthesisCalls += 1;
        onChunk({ choices: [{ delta: { content: "Checkpoint: parts were searched, but no artifact was proposed." } }] });
        return;
      }
      const callId = `call_search_${toolCalls}`;
      onChunk({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: callId,
              type: "function",
              function: { name: "proto_search_parts", arguments: JSON.stringify({ query: "pLac" }) },
            }],
          },
        }],
      });
    },
  };
  const mcp = {
    tools: async () => [{
      name: "proto_search_parts",
      description: "Search local parts.",
      inputSchema: {
        type: "object",
        required: ["query"],
        properties: { query: { type: "string" } },
        additionalProperties: false,
      },
    }],
    call: async () => {
      toolCalls += 1;
      return { ok: true, parts: [] };
    },
  };
  const workspace = { read: async () => { throw new Error("No optional policy fixture"); } };
  const events = [];
  const agent = new AgentService(database, models, workspace, mcp, (event) => {
    events.push(event);
    if (event.type === "message-complete") complete.resolve(event.message);
  });
  const thread = agent.createThread({ workspacePath: "C:\\test-workspace", title: "Budget", mode: "act", modelId: model.id });

  await agent.send(thread.id, "Keep searching until the budget is reached.");
  const message = await complete.promise;

  assert.equal(toolCalls, 24);
  assert.equal(finalSynthesisCalls, 1);
  assert.match(message.content, /Checkpoint: parts were searched/);
  assert.match(message.content, /Tool budget exhausted after 24 rounds/);
  const planEvent = events.find((event) => event.type === "run-event" && event.runEvent.title === "Agent plan started");
  assert.equal(planEvent.runEvent.status, "failed");
  database.close();
});

test("context overflow compacts audited tool history and retries exactly once", async () => {
  const database = new AppDatabase(":memory:");
  const complete = deferred();
  const model = {
    id: "context-recovery-model",
    name: "Context recovery model",
    contextLength: 8_192,
    vramEstimate: { contextLength: 8_192 },
  };
  const toolNames = [
    "proto_search_parts",
    "proto_pubmed_search",
    "proto_europe_pmc_search",
    "proto_crossref_search",
    "proto_uniprot_search",
    "proto_rhea_search",
  ];
  let chatTurns = 0;
  let overflowPayload;
  const models = {
    get: () => model,
    getActiveModel: () => model,
    setToolCapability: () => {},
    chat: async (_modelId, payload, onChunk) => {
      chatTurns += 1;
      if (chatTurns === 1) {
        onChunk({
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: "call_large_parts",
                type: "function",
                function: { name: "proto_search_parts", arguments: JSON.stringify({ query: "L-DOPA" }) },
              }],
            },
          }],
        });
        return;
      }
      if (chatTurns === 2) {
        overflowPayload = structuredClone(payload);
        assert.doesNotMatch(JSON.stringify(payload), /\"sequence\"/);
        throw new Error(
          'llama-server request failed (400): {"error":{"message":"request (11896 tokens) exceeds the available context size (8192 tokens)"}}',
        );
      }
      const serialized = JSON.stringify(payload);
      assert.ok(
        serialized.length < JSON.stringify(overflowPayload).length,
        `${serialized.length} should be smaller than ${JSON.stringify(overflowPayload).length}; ` +
          `before=${JSON.stringify(overflowPayload.messages.map((message) => [message.role, message.content.length]))}; ` +
          `after=${JSON.stringify(payload.messages.map((message) => [message.role, message.content.length]))}`,
      );
      assert.match(serialized, /PART:ECOLI_PLAC/);
      assert.ok(!(payload.tools ?? []).some((tool) => tool.function.name === "proto_search_parts"));
      assert.ok(payload.max_tokens <= 2_621);
      onChunk({ choices: [{ delta: { content: "Compacted evidence synthesis completed." } }] });
    },
  };
  const mcp = {
    tools: async () => toolNames.map((name) => ({
      name,
      description: `${name} fixture ${"context ".repeat(name === "proto_search_parts" ? 100 : 8)}`,
      inputSchema: {
        type: "object",
        required: ["query"],
        properties: { query: { type: "string" } },
        additionalProperties: false,
      },
    })),
    call: async () => ({
      ok: true,
      source: "parts_library",
      match_count: 80,
      summary: "Returned a reviewed local part fixture.",
      matches: Array.from({ length: 80 }, (_, index) => ({
        ...(index === 0 ? { source_id: "PART:ECOLI_PLAC" } : { id: `fixture-${index}` }),
        title: `Large audited fixture ${index} ${"metadata ".repeat(40)}`,
        sequence: "ATGC".repeat(4_000),
      })),
    }),
  };
  const workspace = { read: async () => { throw new Error("No optional policy fixture"); } };
  const events = [];
  const agent = new AgentService(database, models, workspace, mcp, (event) => {
    events.push(structuredClone(event));
    if (event.type === "message-complete") complete.resolve(event.message);
  });
  const thread = agent.createThread({
    workspacePath: "C:\\test-workspace",
    title: "Context recovery",
    mode: "act",
    modelId: model.id,
  });

  await agent.send(
    thread.id,
    "Search the approved parts library for L-DOPA and summarize without a patch.",
  );
  const message = await complete.promise;

  assert.equal(chatTurns, 3);
  assert.match(message.content, /Compacted evidence synthesis completed/);
  const compaction = events.find((event) => event.type === "run-event" && event.runEvent.title === "Context compacted");
  assert.equal(compaction.runEvent.status, "completed");
  assert.ok(compaction.runEvent.evidenceIds.includes("PART:ECOLI_PLAC"));
  assert.ok(compaction.runEvent.payload.before.estimatedTokens > compaction.runEvent.payload.after.estimatedTokens);
  assert.equal(compaction.runEvent.payload.fullOutputsRetainedInAudit, true);
  const auditedTool = database.getRunEvents(compaction.runEvent.runId)
    .find((event) => event.tool === "proto_search_parts" && event.status === "completed");
  assert.equal(auditedTool.payload.auditSchema, "proto-workbench.tool-execution.v1");
  assert.equal(auditedTool.payload.input.query, "L-DOPA");
  assert.equal(auditedTool.payload.output.matches.length, 80);
  assert.match(auditedTool.payload.outputSha256, /^[a-f0-9]{64}$/);
  database.close();
});

test("requested tool coverage blocks an early patch and exposes the patch only after coverage", async () => {
  const database = new AppDatabase(":memory:");
  const complete = deferred();
  const model = { id: "coverage-gate-model", name: "Coverage gate model", contextLength: 8_192 };
  let chatTurns = 0;
  let proposed;
  const models = {
    get: () => model,
    getActiveModel: () => model,
    setToolCapability: () => {},
    chat: async (_modelId, payload, onChunk) => {
      chatTurns += 1;
      const names = (payload.tools ?? []).map((tool) => tool.function.name);
      if (chatTurns === 1) {
        assert.ok(names.includes("proto_connectors_check"));
        assert.ok(names.includes("proto_search_parts"));
        assert.ok(!names.includes("workspace_propose_patch"), names.join(","));
        onChunk({ choices: [{ delta: { content: "# Premature artifact\n\nThis must be rejected." } }] });
        onChunk({
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: "call_early_patch",
                type: "function",
                function: {
                  name: "workspace_propose_patch",
                  arguments: JSON.stringify({ path: "analyses/coverage.md", rationale: "Too early" }),
                },
              }],
            },
          }],
        });
        return;
      }
      if (chatTurns === 2) {
        assert.match(payload.messages.at(-1).content, /REQUIRED_TOOL_COVERAGE/);
        assert.ok(!names.includes("workspace_propose_patch"));
        onChunk({
          choices: [{
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_connector_coverage",
                  type: "function",
                  function: { name: "proto_connectors_check", arguments: "{}" },
                },
                {
                  index: 1,
                  id: "call_parts_coverage",
                  type: "function",
                  function: { name: "proto_search_parts", arguments: JSON.stringify({ query: "pLac B0034" }) },
                },
              ],
            },
          }],
        });
        return;
      }
      assert.ok(names.includes("workspace_propose_patch"));
      assert.ok(!names.includes("proto_connectors_check"), names.join(","));
      assert.ok(!names.includes("proto_search_parts"), names.join(","));
      onChunk({ choices: [{ delta: { content: "# Covered artifact\n\nSoftware-only fixture review." } }] });
      onChunk({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: "call_covered_patch",
              type: "function",
              function: {
                name: "workspace_propose_patch",
                arguments: JSON.stringify({ path: "analyses/coverage.md", rationale: "Coverage completed" }),
              },
            }],
          },
        }],
      });
    },
  };
  const mcp = {
    tools: async () => [
      {
        name: "proto_connectors_check",
        description: "Inspect declared connectors.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: "proto_search_parts",
        description: "Search approved parts.",
        inputSchema: {
          type: "object",
          required: ["query"],
          properties: { query: { type: "string" } },
          additionalProperties: false,
        },
      },
    ],
    call: async (name) => name === "proto_connectors_check"
      ? { ok: true, summary: "Connectors inspected." }
      : { ok: true, summary: "Parts searched.", matches: [{ source_id: "PART:ECOLI_PLAC" }] },
  };
  const workspace = {
    read: async () => { throw new Error("No optional policy fixture"); },
    proposePatch: async (input) => {
      proposed = input;
      return {
        id: "covered-patch",
        runId: input.runId,
        targetPath: input.targetPath,
        baseSha256: "base",
        before: "",
        after: input.after,
        unifiedDiff: input.after,
        rationale: input.rationale,
        status: "pending",
        createdAt: "2026-07-13T00:00:00.000Z",
      };
    },
  };
  const events = [];
  const agent = new AgentService(database, models, workspace, mcp, (event) => {
    events.push(structuredClone(event));
    if (event.type === "message-complete") complete.resolve(event.message);
  });
  const thread = agent.createThread({
    workspacePath: "C:\\test-workspace",
    title: "Coverage gate",
    mode: "act",
    modelId: model.id,
  });

  await agent.send(
    thread.id,
    "Run the declared connector check; search the approved parts library for pLac and B0034; Target deliverable: analyses/coverage.md. Use workspace_propose_patch.",
  );
  const completedMessage = await complete.promise;

  assert.equal(chatTurns, 3, completedMessage.content);
  assert.equal(proposed.targetPath, "analyses/coverage.md");
  const earlyPatch = events.find((event) =>
    event.type === "run-event"
      && event.runEvent.tool === "workspace_propose_patch"
      && event.runEvent.status === "failed",
  );
  assert.match(earlyPatch.runEvent.summary, /REQUIRED_TOOL_COVERAGE/);
  assert.ok(events.some((event) => event.type === "patch-proposal" && event.patch.id === "covered-patch"));
  database.close();
});

test("successful zero-result searches remain explicit evidence gaps", async () => {
  const database = new AppDatabase(":memory:");
  const complete = deferred();
  const model = { id: "zero-result-model", name: "Zero result model", contextLength: 8_192 };
  let chatTurns = 0;
  const models = {
    get: () => model,
    getActiveModel: () => model,
    setToolCapability: () => {},
    chat: async (_modelId, _payload, onChunk) => {
      chatTurns += 1;
      if (chatTurns === 1) {
        onChunk({
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: "call_zero_result",
                type: "function",
                function: { name: "proto_search_parts", arguments: JSON.stringify({ query: "absent fixture" }) },
              }],
            },
          }],
        });
        return;
      }
      onChunk({ choices: [{ delta: { content: "The requested source returned no matches." } }] });
    },
  };
  const mcp = {
    tools: async () => [{
      name: "proto_search_parts",
      description: "Search a source fixture.",
      inputSchema: {
        type: "object",
        required: ["query"],
        properties: { query: { type: "string" } },
        additionalProperties: false,
      },
    }],
    call: async () => ({ ok: true, source: "uniprot", match_count: 0, matches: [], source_ids: [] }),
  };
  const events = [];
  const agent = new AgentService(
    database,
    models,
    { read: async () => { throw new Error("No optional policy fixture"); } },
    mcp,
    (event) => {
      events.push(structuredClone(event));
      if (event.type === "message-complete") complete.resolve(event.message);
    },
  );
  const thread = agent.createThread({
    workspacePath: "C:\\test-workspace",
    title: "Zero result",
    mode: "act",
    modelId: model.id,
  });

  await agent.send(thread.id, "Search the source once and report whether evidence exists.");
  await complete.promise;

  const execution = events.find((event) =>
    event.type === "run-event"
      && event.runEvent.tool === "proto_search_parts"
      && event.runEvent.status === "completed",
  );
  assert.match(execution.runEvent.summary, /no matches.*evidence gap/i);
  assert.equal(execution.runEvent.evidenceIds.length, 0);
  database.close();
});

test("plain-language propose-a-patch-at requests recover the named target", async () => {
  const database = new AppDatabase(":memory:");
  const complete = deferred();
  const model = { id: "patch-phrase-model", name: "Patch phrase model", contextLength: 8_192 };
  let chatTurns = 0;
  let proposed;
  const models = {
    get: () => model,
    getActiveModel: () => model,
    setToolCapability: () => {},
    chat: async (_modelId, payload, onChunk) => {
      chatTurns += 1;
      if (chatTurns < 3) {
        onChunk({ choices: [{ delta: { content: "No patch call was emitted." } }] });
        return;
      }
      assert.equal(payload.tool_choice, "none");
      onChunk({ choices: [{ delta: { content: "# Phrase patch\n\nComplete software-only review artifact." } }] });
    },
  };
  const workspace = {
    read: async () => { throw new Error("No optional policy fixture"); },
    proposePatch: async (input) => {
      proposed = input;
      return {
        id: "phrase-patch",
        runId: input.runId,
        targetPath: input.targetPath,
        baseSha256: "base",
        before: "",
        after: input.after,
        unifiedDiff: input.after,
        rationale: input.rationale,
        status: "pending",
        createdAt: "2026-07-13T00:00:00.000Z",
      };
    },
  };
  const agent = new AgentService(database, models, workspace, { tools: async () => [], call: async () => ({ ok: true }) }, (event) => {
    if (event.type === "message-complete") complete.resolve(event.message);
  });
  const thread = agent.createThread({
    workspacePath: "C:\\test-workspace",
    title: "Patch phrase",
    mode: "act",
    modelId: model.id,
  });

  await agent.send(thread.id, "Propose a patch at analyses/phrase.md for a software-only review note.");
  await complete.promise;

  assert.equal(chatTurns, 3);
  assert.equal(proposed.targetPath, "analyses/phrase.md");
  assert.match(proposed.after, /Complete software-only review artifact/);
  database.close();
});

test("cancelAll waits until the active run is durably marked cancelled", async () => {
  const database = new AppDatabase(":memory:");
  const chatStarted = deferred();
  const streamEvents = [];
  const model = { id: "cancel-model", name: "Cancellation model", contextLength: 8_192 };
  const models = {
    get: () => model,
    getActiveModel: () => model,
    setToolCapability: () => {},
    chat: async (_modelId, _payload, _onChunk, signal) => {
      chatStarted.resolve();
      await new Promise((resolve, reject) => {
        const cancel = () => reject(new DOMException("Cancelled", "AbortError"));
        if (signal.aborted) {
          cancel();
          return;
        }
        signal.addEventListener("abort", cancel, { once: true });
      });
    },
  };
  const workspace = {
    read: async () => { throw new Error("No optional policy fixture"); },
  };
  const agent = new AgentService(
    database,
    models,
    workspace,
    { tools: async () => [], call: async () => ({ ok: true }) },
    (event) => streamEvents.push(event),
  );
  const thread = agent.createThread({
    workspacePath: "C:\\test-workspace",
    title: "Cancellation",
    mode: "act",
    modelId: model.id,
  });

  await agent.send(thread.id, "Wait until this request is cancelled.");
  await chatStarted.promise;
  await agent.cancelAll();

  const runId = streamEvents.find((event) => event.type === "run-event")?.runEvent?.runId;
  assert.ok(runId);
  const persistedPlan = database.getRunEvents(runId).find((event) => event.stage === "plan");
  assert.equal(persistedPlan.status, "cancelled");
  assert.equal(persistedPlan.summary, "Cancelled.");
  assert.ok(streamEvents.some((event) => event.type === "message-complete"));
  database.close();
});

test("cancelling an artifact recovery marks both the segment and parent as cancelled", async () => {
  const database = new AppDatabase(":memory:");
  const recoveryStarted = deferred();
  const model = { id: "cancel-recovery-model", name: "Cancel recovery model", contextLength: 32_768 };
  let chatTurns = 0;
  const models = {
    get: () => model,
    getActiveModel: () => model,
    setToolCapability: () => {},
    chat: async (_modelId, payload, onChunk, signal) => {
      chatTurns += 1;
      if (chatTurns <= 2) {
        onChunk({ choices: [{ delta: { content: chatTurns === 1 ? "I omitted the patch." : "# Incomplete artifact" } }] });
        return;
      }
      assert.equal(payload.tool_choice, "none");
      assert.equal(payload.max_tokens, 3_072);
      recoveryStarted.resolve();
      await new Promise((resolve, reject) => {
        const cancel = () => reject(new DOMException("This operation was aborted", "AbortError"));
        if (signal.aborted) {
          cancel();
          return;
        }
        signal.addEventListener("abort", cancel, { once: true });
      });
    },
  };
  const events = [];
  const agent = new AgentService(
    database,
    models,
    { read: async () => { throw new Error("No optional policy fixture"); } },
    { tools: async () => [], call: async () => ({ ok: true }) },
    (event) => events.push(event),
  );
  const thread = agent.createThread({
    workspacePath: "C:\\test-workspace",
    title: "Cancel recovery",
    mode: "act",
    modelId: model.id,
  });

  await agent.send(thread.id, "Target deliverable: analyses/cancelled.md. Use workspace_propose_patch.");
  await recoveryStarted.promise;
  await agent.cancelAll();

  const runId = events.find((event) => event.type === "run-event")?.runEvent?.runId;
  const persisted = database.getRunEvents(runId);
  assert.equal(persisted.find((event) => event.title === "Agent plan started")?.status, "cancelled");
  assert.equal(persisted.find((event) => event.title === "Recovering artifact proposal")?.status, "cancelled");
  assert.equal(persisted.find((event) => event.title.startsWith("Artifact recovery segment"))?.status, "cancelled");
  assert.equal(persisted.some((event) => event.summary.includes("AbortError")), false);
  database.close();
});
