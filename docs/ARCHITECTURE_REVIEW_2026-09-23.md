# Proto CLI 架构评审：结构、Harness 与端到端工作流

评审日期：**2026-09-23**。评审对象：分支 `Biomni_Transplant` 的当前工作树（`git status --short` 显示 378 个已修改或未跟踪的文件）。

范围说明：本次只做只读检查，没有运行测试、构建、模型或外部运行时，也没有访问外部 materials root 或任何 fixture 的序列内容。评审只涉及软件架构与工作流编排，不涉及生物部件或序列的设计与优化，也不提供任何实验操作说明。本地 Qwen3.8-27B Q4_K_M 仅作为开发和测试基线，其生物设计能力与一般科学可靠性均未确立。

标记含义：**[观察]** 为直接读到的代码行为；**[推断]** 由代码路径推出、未经执行验证；**[未核实]** 为文档声称但本次未核对。文中行号对应评审时的工作树，后续编辑可能使其偏移。

---

## 1. 当前架构与信任边界

```
Renderer (App.tsx / ChatWorkspace / ComputeWorkspace / Chem*)
  │  preload/index.ts：103 个通道，定义在 shared/ipc.ts
  ▼
ipc-security.ts：发送方 frame 校验 + zod 参数校验（没有 schema 的通道直接拒绝）
  ▼
main/index.ts 中的 handlePrivileged
  ├─ ResearchChatService（Chat）──► ResearchToolBridge ─┬─► McpClient.fork() ─► Python mcp_server.py（43 个工具）
  ├─ AgentService / HarnessWorkspace（Design Harness）──┘        │
  ├─ ResearchWorkflows / ComputeStudies / ResearchFigures ───────┘
  └─ ChemScienceService ─► 独立的 python chem_science.py 进程（不经过 MCP）
持久化：
  userData/proto-workbench.sqlite  （Harness、patch、validation、tool_execution_journal）
  userData/research-chat.sqlite    （Chat 会话 + 消息投影）
  <workspace>/build/compute-studies/studies.sqlite（studies、workflows、figures 三个服务各自打开同一个文件）
  <workspace>/build/**             （compute manifest、chem run 目录、chat 导出、review packet）
```

已经做得比较扎实的边界：

- **[观察]** IPC 对缺 schema 的调用一律拒绝（`apps/proto-workbench/src/main/ipc-security.ts:418-423`）。103 个通道中 101 个有 schema，剩下两个（`modelsChanged`、`threadStream`）是只推送的通道。
- **[观察]** MCP 调用前会先落盘 intent，再在 dispatch 前标记状态（`src/main/services/mcp-client.ts:161-183`）。
- **[观察]** Compute 数值带 JSON Pointer、单位、实体和 maturity 字段（`src/proto_agent/compute.py:343-409`、`:489-490`），maturity 默认是 `not-established`。
- **[观察]** 导出的图版重新打开时会按 hash 校验（`src/main/services/research-figures.ts:156`、`:208`）。
- **[观察]** Design 流程的 workflow 与 review packet 保留 `human_review_required` 门禁（`src/proto_agent/workflow.py:282-296`、`src/proto_agent/review.py:108`、`:713-714`）。

以下路径若无特别说明，TS 文件均相对于 `apps/proto-workbench/`。

---

## 2. 最有价值的 10 项结构性问题

### F1 所谓 canonical 的能力注册表，在执行边界上并不 canonical

- **[观察]** 同一个工具的元数据分散在至少 6 份手写清单里：
  - `src/shared/research-tool-registry.ts`：id 和别名
  - `src/main/services/tool-effects.ts:5-38`：读/写
  - `src/main/services/permissions.ts:3-52`：是否暴露给模型、风险
  - `src/main/services/harness-workspace.ts:19-23`：Harness 的覆盖规则
  - `src/shared/modules.ts`：模块开关
  - `src/proto_agent/mcp_server.py:74-82`：Python 侧的 `NETWORK_TOOLS`
- **[观察]** 对这些清单做本地交叉比对，结果如下：
  - Python 暴露 43 个工具，其中 **14 个没有效应分类**，按默认一律当作 write：`proto_connectors_check`、`proto_crossref_search`、`proto_europe_pmc_search`、`proto_language_reference`、`proto_literature_search`、`proto_protein_validate`、`proto_pubmed_search`、`proto_r_status`、`proto_remote_catalog`、`proto_rhea_search`、`proto_skills_list`、`proto_skills_resolve`、`proto_uniprot_search`、`proto_validate_sbol`。
  - 27 个 Python 工具不在注册表里，会被 `research-tool-registry.ts:85` 静默映射为 `design.*`，例如 `proto_check`、`proto_compile`、`proto_workflow_run`、`proto_remote_run`、`proto_research_figure_render`。
  - `permissions.ts` 列出的 6 个工具在 Python MCP 中不存在：`proto_protein_inspect` 和 5 个 `proto_structure_*`。
  - TS 侧的网络工具集合比 Python 侧多出 `proto_remote_run` 和 `proto_structure_*`。
- **影响**：只读的文献检索一旦超时，会被记成 `effect-unknown`；Harness 恢复时会拒绝该 callId。审计里出现的"未知效应"大多是假阳性，稀释了真正需要人工核对的记录。
- **根因**：没有一个"工具契约"数据源，每一层各自维护一个 Set。
- **建议**：建立唯一的 `ToolContract` 表。字段包括 effect（read / idempotent-write / write / external）、network、risk、module、deadline、outputBudget、maturityRef。其余各层都从这张表派生；未登记的工具直接拒绝，不再回退成 `design.*`。
- **取舍**：需要一次性补齐约 60 个 chem 工具和 43 个 MCP 工具的元数据。
- **验收**：一个契约测试，枚举 Python 的 `tools/list` 和 chem catalog，任何名字没有契约行就让 CI 失败；并断言 PubMed 超时后 journal 状态为 `no-effect`。

### F2 三套效应分类器，调用方还会各自覆盖；journal 的 `runId` 语义不统一

- **[观察]** 分类来源有三处：`declaredMcpToolEffect`、`harnessToolEffect`，以及 `src/main/services/research-workflow-runtime.ts:18-19` 里的内联写法 `name==='proto_compute_run'?'write':'read'`。
- **[观察]** `runId` 在各调用方含义不同：
  - Chat 用 `session.id`（`research-tools.ts:137`）
  - Harness 用 `contract.runId`（`harness-workspace.ts:99`）
  - Workflow 用 `runId: operationId`（`research-workflow-runtime.ts:19`）
  - 没传的调用方得到 `"mcp-session"`（`mcp-client.ts:156`）
- **影响**：按 run 查询 journal 时，Chat、Workflow、Harness 的粒度不同，无法用一个 UI 统一展示"这次运行做了哪些事"。
- **建议**：把 `runId` 改成必填的 `ExecutionScope { surface, scopeId, parentOperationId? }`，删除调用方传入的 `effect` 覆盖，effect 只由契约决定。
- **验收**：用同一个 compute 请求分别从 Chat、Compute、Workflow 发起，三条 journal 行的 effect 相同，scope 可以区分来源。

### F3 Chem 执行完全绕过共享的执行层

- **[观察]** 与 journal 相关：`chemistry.*` 走 `this.chem.request()`（`research-tools.ts:123-129`），不经过 McpClient，因此没有 intent/receipt 记录。它还被放进 `withReadSlot`，而实际上它会写 run 目录（`chem-science.ts:110-124`）。
- **[观察]** 与模块开关相关：`isToolEnabledForModules` 的实现是 `!optional || …`（`src/shared/modules.ts:287-290`），而 modules 里完全没有 chemistry 条目。结果是 core-only 配置下 Chat 仍然暴露全部 chem 算子。
- **[观察]** 与结果契约相关：chem 返回的信封只有 `{ok, operator, result, provenance}`（`runtime/chem-integration/chem_science.py:712-737`），没有 maturity、Quantity schema，也没有 `schema_version`。
- **[观察]** 与持久化相关：`chem-science.ts:124` 用非 `wx`、非原子的方式重写 manifest。history 读取时会静默跳过损坏的记录（`:42`）。
- **影响**：崩溃后 chem run 可能从历史里消失，用户看不到任何失败提示。Chem 的数值也无法像 compute 数值那样逐点回指来源。
- **建议**：把 ChemScienceService 包装成一个执行后端适配器，与 MCP 共用同一个 invoke 路径；输出包裹为 `proto-agent.compute.v1` 兼容的 manifest，加上 maturity；损坏的 run 显示为"不可验证"，而不是被隐藏。
- **验收**：在 chem 写 manifest 的中途注入进程终止，history 中应出现一条 `unverifiable` 记录，journal 中对应的是 `effect-unknown`。

### F4 Journal 的状态语义不完整：工具失败被记为 completed，已知无效应的拒绝被记为 unknown，也没有 reconcile 出口

- **[观察]** `mcp-client.ts:182-183` 在收到 `isError:true` 时仍调用 `complete()`。同一 operationId 之后只会重放这个错误回执；没有 `structuredContent` 时回执被替换成 `{ok:true}`，文本内容丢失。
- **[推断]** dispatch 之后的任何异常（包括服务端的参数校验拒绝）都会让写工具进入 `effect-unknown`（`mcp-client.ts:186-189`），错误对象上的 `effectState` 被忽略。
- **[观察]** `effect-unknown` 没有任何状态迁移出口（`src/main/services/tool-execution-journal.ts:89`、`:196-202`），全仓库也没有针对 journal 的 reconcile API；patch_operations 自己有一套（`src/main/index.ts:945`）。
- **[观察]** Chat 恢复时把所有 running 的 activity 统一改成 `error`（`research-chat.ts:229-235`），而不是从 journal 读取真实状态。
- **影响**：UI 里"失败""未知""已完成"三者的真实来源不唯一，恢复逻辑只能保守地整体阻断。
- **建议**：
  1. 增加 `outcome: ok | tool-error` 列。
  2. 服务端返回 `effect_state:"none"` 时降级为 `no-effect`。
  3. 新增 `reconcile(operationId, verdict: applied | not-applied, actor, evidenceRef)`，迁移到 `reconciled-*` 状态。
  4. Chat 和 Harness 的 activity 状态改为 journal 的投影。
- **验收**：做一个故障注入矩阵，覆盖 {intent, dispatched, 服务端拒绝, 工具错误, 超时, 进程退出} × {read, write} 共 12 个用例，每个用例的 journal 状态、UI 状态和能否重试都符合预期。

### F5 Chat 与 Harness 的授权模型不一致，Chat 的 approvalId 是凭空生成的

- **[观察]** Harness 每次调用都走 `classifyToolCall`（`harness-workspace.ts:70`），网络和代码执行需要 grant。Chat 从不调用它：`proto_run_analysis`、`proto_run_r`、`proto_bioinformatics_run` 和各类网络检索只要被暴露就会执行；网络能力直接签发 `approvalId: chat-${randomUUID()}`（`research-tools.ts:136`），不对应任何用户决定记录。
- **说明**：依据 `docs/chat-unified-workflow.md`，代码执行在 OCI 沙箱里运行（**[未核实]** 具体实现），风险被缓解了，但审计链上看不出"谁在什么范围内授权了什么"。
- **建议**：抽出一个 `PolicyDecision` 对象，Chat 和 Harness 共用。Chat 的"发送消息"这一动作生成一条 `session-send` grant，写明它覆盖的风险类别；每次工具调用把 decisionId 写进 journal。
- **验收**：在 Chat 中关闭网络 grant 后发起 PubMed 调用，应该得到 `POLICY_DENIED`；打开时 journal 行能带出对应的 grant 记录。

### F6 两套对话引擎：上下文组装、预算和"完成"的定义各不相同

- **[观察]** 上下文与预算：
  - Chat 使用 `chat-context.ts`，按字节截断工具输出并附 artifact 路径（`research-chat.ts:436`）；预算为回复 4096 token、余量 256（`:349-350`），只有时间上限。
  - Harness 使用 `harness-context.ts`，按工具类型投影、保留身份字段；预算为 4096 + 2048 余量，另有 128 轮和 65,536 token 的限制（依据 `docs/reliable-harness.md`）。
- **[观察]** 完成判定：Chat 在循环结束时直接写 `assistant.state="complete"`（`research-chat.ts:451`）；Harness 需要 `harness_finish` 做独立校验。
- **[观察]** Chat 消息只记录 `session.modelId`，不记录 instanceId 或模型 fingerprint（`src/shared/research-chat.ts:112` 附近），事后无法归因到具体加载的模型实例。
- **影响**：同一个 Qwen 实例在两个入口下表现出不同的可靠性语义。对于能力未经确认的基线模型，Chat 在工具证据不完整时仍会显示 complete。
- **建议**：抽出统一的 `TurnEngine`，包含 budgeter、tool-result projector、completion gate 三部分。Chat 使用轻量的 completion gate：只要存在 `error` 或 `effect-unknown` 的 activity，就标为 `incomplete-evidence`。每条 assistant 消息写入 `{instanceId, modelFingerprint, contextLength}`。
- **验收**：在同一个工具失败的场景下，Chat 和 Harness 显示相同的终态类别；更换 instance 后，旧消息仍显示原来的实例身份。

### F7 持久化拓扑分散，没有迁移账本，旧 artifact 升级后会被静默隐藏

- **[观察]** 三个 SQLite 文件，外加文件形式的存储（`index.ts:287`、`:1277`）。三个服务各自打开同一个 `studies.sqlite` 并各自执行建表（`compute-studies.ts:203`、`research-workflows.ts:127`、`research-figures.ts:165`）。
- **[观察]** 迁移方式只有 `CREATE IF NOT EXISTS` 加 `ALTER ADD COLUMN`（`database.ts:2278`、`research-chat-repository.ts:82-83`），没有 `user_version` 或迁移账本。
- **[观察]** 读取器按字面值判定版本：`schema_version!=="proto-agent.compute.v1"`（`compute-studies.ts:85`），列表逻辑遇到不匹配时直接跳过（`:190`）。
- **[推断]** journal 存在 userData 里，workflow 的 operationId 和 artifact 存在 workspace 里。如果把 workspace 换一台机器打开，或清理了 userData，带着旧 operationId 的 workflow 恢复会从 `intent` 重新开始并再次 dispatch 写操作。compute 请求文件因为使用 `wx` 并比对字节（`compute-workspace.ts:30-45`），可以防住一部分，但其他写工具没有同样的保护。
- **建议**：
  1. 每个 DB 引入 `schema_migrations(version, sha, applied_at)`，并提供启动时的迁移报告。
  2. 建立 `ArtifactReaderRegistry`：已知的旧版本走只读兼容，未知版本显示为 `unsupported-version`，不再隐藏。
  3. 把 journal 做成 workspace 级；或者在 workspace 侧保存 journal 的镜像行，并在两侧做一致性校验。
- **验收**：用 v1 的 fixture DB 和 artifact 启动新版本，迁移报告列出全部变更；伪造的 v2 manifest 在列表中显示为"不支持的版本"。

### F8 Chat 存储存在 O(N) 写放大

- **[观察]** 流式生成时每 1.5 秒保存一次（`research-chat.ts:392`），每次工具调用前后也各保存一次。每次保存都会重写最多 8 MiB 的完整 payload，并把**全部**消息重新 JSON 序列化两遍、计算 hash、执行 upsert（`research-chat-repository.ts:108-119`）。
- **影响**：长会话（这正是 E2/U03 想支持的场景）下，流式阶段的 I/O 和 CPU 随消息数线性增长。
- **建议**：维持 ADR 0001 的"payload 为权威"决定不变，只对 `messages[i]` 的 hash 发生变化的行做 upsert；流式增量单独写入 `research_chat_stream_buffer`，在消息结束时一次性并入 payload。
- **验收**：对 500 条消息的会话做基准测试，单次保存写入的行数不超过 2，并且与原实现产生相同的 transcript hash。

### F9 证据等级和科学成熟度不是一个跨层共享的类型

- **[观察]** 各类状态标签分散在不同层：
  - 材料层：`DESIGN_ELIGIBLE` / `QUARANTINED`
  - compute：`not-established`
  - claims：`reviewed`
  - harness：`"fixture"`
  - 预览：`"demo"`
  - review packet 的 toy 说明只是一句建议文本（`review.py:597`）
  - chem 结果完全没有这类标签
- **影响**：导出包、Chat 回答、review packet 之间，无法用同一种方式表达"这是 toy fixture""这只是数值参考""这已由人工审阅"。本地的 eligibility 标签也容易被误读为生物学安全或实验就绪的保证。
- **建议**：新增 `EvidenceStanding`，按正交的轴拆分，而不是合成一个总分：
  - `dataOrigin`：fixture / synthetic / imported / governed-snapshot
  - `eligibility`：只针对 materials
  - `methodMaturity`
  - `executionStatus`
  - `humanReview`

  每一轴的取值独立展示，任何一轴都不推导其他轴。
- **验收**：用 toy fixture 走完 workflow 再生成 review packet，packet、UI 和导出三处都显示 `dataOrigin=fixture`，且 `humanReview=required`。

### F10 IPC、preload、mock 三份契约靠手工保持同步

- **[观察]** handler 的类型是 `(...args:any[])`（`index.ts:355`），参数类型由人工声明，并不从 zod schema 推导。`src/renderer/mock-api.ts` 有 2341 行，重新实现了一遍 API。`ipc-security.ts:36-51` 里又硬编码了一份技能和模块的枚举。
- **[推断]** `src/main/services/llama-server.ts`（681 行）只被测试和 `path-security.ts` 引用，没有被 `index.ts` 装配，属于遗留的运行路径。
- **建议**：用 `defineChannel(name, zodArgs, zodResult)` 一处定义通道，由它生成 preload 桥、handler 类型和 mock 骨架；模块枚举改从模块 manifest 生成。
- **验收**：删掉一个 schema 字段后，`tsc` 能在 handler、preload 和 mock 三处同时报错。

---

## 3. 两种目标架构

### A. 渐进路径：契约表 + 执行内核（ExecutionKernel）

- **合并**：F1/F2 的所有清单合并为 `ToolContract`；Chat、Harness、Workflow、Compute、Chem 五个入口统一调用 `kernel.invoke(scope, capabilityId, args, decision)`，由内核串联 policy → journal → backend adapter（MCP 或 Chem）→ receipt → artifact 登记。
- **保留**：现有的三个 DB、ADR 0001 的 payload 权威、patch_operations 的 CAS、Python MCP 进程模型。
- **迁移**：journal 增加 outcome、reconcile 和 scope 字段；增加迁移账本；增加 reader registry。
- **理由**：每一步都能单独提交和回滚，能直接消除 F1–F5 的不一致，也不需要重写 UI。

### B. 进取路径：workspace 级事件账本（Run Ledger）+ 生成式协议

- **合并**：新建 `<workspace>/build/.proto/ledger.sqlite`，只追加事件：IntentRecorded、PolicyDecided、Dispatched、EffectObserved、ReceiptSaved、EvidenceChecked、ReviewDecided、Exported。Chat transcript、Harness checkpoint、workflow execution、compute studies 都成为这个账本的投影（reducer）。Python 侧收敛为 `capabilities / validate / plan / run / status / cancel / collect` 七个动词的 worker。Electron、浏览器预览和 CLI 共用生成的协议（对应 brainstorm 的 H18）。
- **保留**：已有的 artifact 格式，作为账本里内容寻址的附件。
- **迁移**：旧 DB 一次性导入，事件标记为 `legacy-import`；导出的研究包 = 账本切片 + artifact（可以对接 RO-Crate）。
- **理由**：从根本上解决 F7 的跨库原子性和可移植性问题，也让"重开旧结果"成为账本重放。代价是 reducer 的正确性测试和迁移工作量都比较大。建议先完成 A，再以 A 的内核作为 B 的写入入口。

---

## 4. 建议的端到端工作流状态

```
Intent(用户/模型)
 → CapabilityResolved ── 未登记 ─► Rejected(UNKNOWN_CAPABILITY)
 → PolicyDecided ── needs-approval ─► AwaitingApproval ─(拒绝/超时)─► Denied
 → Prepared(输入快照 hash、依赖指纹)
 → Dispatched
    ├─ Completed(ok)          ──┐
    ├─ ToolError(no-effect)   ──┤ 可按原 operationId 重放回执
    ├─ Rejected(no-effect)    ──┘ 可以用新的 operationId 重试
    ├─ EffectUnknown ─► Reconciling ─► ReconciledApplied | ReconciledNotApplied
    └─ CancelRequested ─► CancelConfirmed | LateCompletion(保留回执, 不标完成)
 → EvidenceCheck: complete | incomplete-evidence | contradicted
 → SoftwareDone（≠ 科学结论）
 → HumanReview: required | reviewed-supported | reviewed-rejected
 → Exported(bundle sha256)
 → Reopened: verified | drifted(源已变) | legacy-readonly | unsupported-version | content-missing
```

两个关键规则：

- **不完整的回答**：模型输出了看似完整的文字，但存在 `incomplete-evidence` 时，一律不显示为 complete。
- **依赖变化**：依赖一旦变化，从 `Reopened` 进入 `drifted`，只允许用户显式重跑，不自动复用缓存。

### 两条代表性路径的追踪结果

- **Chat/Compute（合成数值数据）**：renderer ChatWorkspace → preload IPC → `ipc-security.ts` 校验 → `ResearchChatService.performRequest`（`research-chat.ts:188`）→ `generate`（`:345`）→ model-service 生成队列 → LM Studio → 工具调用 → `ResearchToolBridge.execute`（`research-tools.ts:110`）→ `science_run` → fork 的 McpClient → journal `begin` → Python `mcp_server.py` → `run_compute`（`compute.py:496`）写入带 maturity 和 value index 的 manifest → 回执 → `writeToolOutput` 写入 `build/chat` → 会话保存（`research-chat-repository.ts`）→ claims 投影 → 导出。
- **Design 验证与审阅（已有 toy fixture）**：`proto_check` → `proto_compile` → `proto_workflow_run`（`workflow.py` 生成 `proto-agent.run.v1` manifest，`review_gate` 为 `human_review_required`）→ `proto_review_packet`（`review.py:108` 生成 `review_packet.v1` 与人工审阅清单）。Harness 侧由 `harness_finish` 做独立校验。toy fixture 目前只通过建议文本标识（`review.py:597`），没有类型化的等级字段。

---

## 5. 实施顺序

| 序号 | 变更 | 依赖 |
|---|---|---|
| CS1 | ToolContract 单一表 + 契约测试 | — |
| CS2 | Journal 语义补全，Chem 接入 journal | CS1 |
| CS3 | 迁移账本 + reader registry | — |
| CS4 | TurnEngine：统一预算、投影、completion gate，记录消息的模型实例 | CS2 |
| CS5 | PolicyDecision 在 Chat 与 Harness 间统一 | CS1、CS2 |
| CS6 | Chat 增量写入 | — |
| CS7 | EvidenceStanding 类型 | CS3 |
| CS8 | 生成式 IPC 契约 | — |
| 之后 | 方向 B 的 Run Ledger | CS1–CS7 |

### 第一个可评审变更集（CS1，约 300 行）

1. 新建 `src/shared/tool-contracts.ts`，登记 43 个 MCP 工具和 chem 元工具。
2. `tool-effects.ts`、`permissions.ts`、`harnessToolEffect`、`research-workflow-runtime.ts:19` 全部改为读这张表。
3. 删除 `research-tool-registry.ts:85` 的 `design.*` 回退。
4. 新增测试：解析 `mcp_server.py` 的工具名，并与契约表双向比对。

### 第二个可评审变更集（CS2，约 250 行）

1. journal 增加 `outcome` 列，采用带版本号的迁移。
2. 修改 `mcp-client.ts:182-189`：`isError` 记为 tool-error；错误里的 `effectState:"none"` 记为 no-effect。
3. 新增 `reconcile()` 方法和对应的 IPC。
4. `ChemScienceService.request({action:"run"})` 通过同一个 journal 包装器执行。
5. 加上 F4 所述的 12 格故障注入测试。

### 与 2026-09-22 brainstorm 的对比

参见 [OPEN_SOURCE_RESEARCH_BRAINSTORM_2026-09-22.md](OPEN_SOURCE_RESEARCH_BRAINSTORM_2026-09-22.md)。

- H01/U02（共享的 journal）**已经部分实现**，但 brainstorm 没有指出本次发现的具体缺陷：分类漂移（14 个工具未分类）、Chem 绕过 journal、`isError` 被记为 completed、没有 reconcile 出口。
- H02（工具契约元数据）应当**先于** H04–H06 实施，因为它是其余工作的前提。
- H07（审批绑定）在 Chat 侧实际上是**缺失**的，比表中描述的更严重。
- E2/H04 的分页已经按 ADR 0001 落地，但引入了新的写放大问题（F8）。
- U01 的 Quantity 契约目前只在 compute 中实现，Chem 没有接入。
- 建议暂停 U10–U33 这类领域扩展，等 CS1–CS4 完成后再继续。否则每新增一个工具，都会在 6 份清单上继续累积漂移。

---

## 6. 未检查的部分与需要确认的问题

### 检查覆盖范围

- 已精读：两份 AGENTS.md、`docs/reliable-harness.md`、`docs/chat-unified-workflow.md`、`apps/proto-workbench/docs/tool-execution-journal.md`、brainstorm 的第 2–5 节和 H 表、`docs/adr/0001-normalized-research-transcripts.md`。
- 源码已追踪：journal、MCP client、注册表、权限、Chat 服务和仓储、两个 context 模块、workflow runtime、compute studies、chem 服务和 worker、IPC 安全层、`review.py` 和 `workflow.py` 中与门禁相关的片段、CI 的结构。
- **未深入阅读**：`README.md`、`docs/README.md`、`connectors/proto_workbench.json`、`pyproject.toml`、`docs/security_architecture.md` 全文；renderer 的 `store.ts`、`App.tsx`、`mock-api.ts`；`materials.py`、`provenance.py`、`execution.py`（OCI broker）；信任、签名、TUF 相关模块；`build/` 下的证据文件。
- 本次**没有运行任何测试**。文档中"59 tests passed"等说法均属 **[未核实]**，托管 CI 的结果也未核实。
- 两条端到端路径中：Chat/Compute 路径追到 `compute.py:496` 为止；Design 验证路径只追到 `proto_workflow_run` → `review.py:108` 的门禁层面，没有深入 materials 与 provenance 的内部实现。

### 会实质改变建议的问题

1. Chat 每次发送消息即隐含授权网络访问和代码执行，这是有意的产品策略，还是应当向 Harness 的 grant 模型靠拢？这决定了 CS5 的范围。
2. 执行账本应当随 workspace 迁移，还是绑定到本机的 userData？这决定 F7 采用镜像方案还是迁移方案，以及是否直接走方向 B。
3. Chem 是否打算长期保持独立进程和独立 run 存储，还是可以改为 MCP 后端？
4. 升级后遇到旧版本 artifact，政策应该是只读展示，还是做实际迁移？
5. 浏览器预览（`mock-api.ts`）是受支持的产品界面，还是仅供开发使用？这决定 CS8 是否需要覆盖它。

---

## 7. 实施状态（2026-09-23 晚间更新）

本节记录第 5 节实施顺序的落实情况。**证据仅来自本机执行**：`tsc --noEmit` 无错误；Node 套件全量运行 1335 项全部通过（其中一项的结论依赖调度，见本节末）；Python `base` 353 项、`compute` 169 项、`figures` 22 项全部通过（另有 5 项平台相关跳过）。托管 CI 未在本轮运行，其结果仍为未核实。测试通过不等于科学方法适用，也不等于干净机器可用。

| 序号 | 状态 | 交付与验收证据 |
|---|---|---|
| CS1 | 已完成 | `src/shared/tool-contracts.ts` 为唯一契约表，覆盖 43 个 MCP 工具、10 个主进程工具、6 个 workspace 通道与 60 个化学算子；`tool-effects.ts`、`permissions.ts`、`harnessToolEffect`、`research-workflow-runtime.ts` 与 `policy-simulation.ts`（评审未列出的第 7 份清单）全部改为派生。Python 侧 `src/proto_agent/tool_contracts.py` 由 `scripts/export-tool-contracts.mjs` 从同一张表生成；`mcp_server.py` 的 `NETWORK_TOOLS` 改为派生，并在构造时调用 `verify_tool_contracts` 拒绝无契约的工具。验收：`tests/tool-contracts.test.mjs`（9 项）与 `tests/test_tool_contracts.py`（8 项）双向比对。|
| CS2 | 已完成 | journal 增加 `outcome`、`reconcile()` 与带版本迁移；`isError` 记为 `tool-error` 而非 completed；Chem 经同一 journal 包装执行。验收：`tests/execution-kernel.test.mjs` 的 12 格故障注入矩阵。|
| CS3 | 已完成 | `schema-migrations.ts` / `storage-migrations.ts` 提供迁移账本；`artifact-reader-registry.ts` 将未知版本显示为 `unsupported-version` 而不是隐藏。|
| CS4 | 已完成 | `turn-engine.ts` 统一预算、工具结果投影与完成门禁。|
| CS5 | 已完成 | `tool-policy.ts` 的 `PolicyDecision` 由 Chat 与 Harness 共用；本轮补齐缺失的 `recordPolicyDenial`，使**拒绝本身成为 journal 中的终态 `no-effect` 记录并携带决定**——否则审计无法区分"被策略拒绝的调用"与"从未发起的调用"。允许的调用记录授权它的 grant。验收：`tests/execution-kernel.test.mjs` 新增 4 项。|
| CS6 | 已完成 | Chat 增量写入使用 `research_chat_stream_buffer`，流式阶段不再重写全量 payload。|
| CS7 | 已完成 | `evidence-standing.ts` 与 `evidence_standing.py` 按正交轴表达证据状态。|
| CS8 | 已完成（验收口径已修正） | 见下。|

### CS8 的验收口径修正

评审原定验收是"删掉一个 schema 字段后，`tsc` 能在 handler、preload 和 mock 三处同时报错"。该表述预设三者都是手写的。实际交付的设计更强：preload 与 renderer mock 都声明为 `IpcWorkbenchApi`，其参数元组由同一批 schema 推导，因此二者**跟随** schema 变化而不可能与之漂移——它们不报错，正是因为它们无法脱节。手写的只剩主进程 handler 与 `WorkbenchApi` 领域类型。

因此本轮把验收改为：schema 变化必须在**所有仍然手写的**位置报错。为此在 `ipc-channel-contracts.ts` 增加编译期交叉检查，要求每个通道推导出的输入都仍能被其领域方法接受；失败时错误信息直接列出漂移的通道名。两个携带回调的流式通道按 `ContractDomain` 的既有规则排除。

验收：`tests/ipc-contract-drift.test.mjs` 在副本上删除 `journalReconcile` 的 `evidenceRef` 字段并实跑 `tsc`，断言主进程 handler 与交叉检查同时失败，且失败信息点名 `journal.reconcile`。

一个**未闭合的反方向**必须写明：该检查只保证 schema 承诺的不多于领域类型接受的。反过来，领域类型比边界更宽松的情况仍然存在——`ComputeRequest.arguments` 声明为 `Record<string, unknown>`，而边界实际只接受 JSON 值。本轮验证过收紧该类型，但它会波及大量构造 `Record<string, unknown>` 的调用点和缺少索引签名的接口（如 `AlignmentRecord`），属于独立工作，未在此完成。这是 101 个通道中唯一的此类分歧。

### 顺带修复的既有缺陷

以下问题与上述变更集无关，但会掩盖真实状态，因此一并修复：

- `src/proto_agent/compute.py:512` 的 `else:` 后缺少缩进，`IndentationError` 使 MCP 进程无法启动，导致 19 项 Node 测试失败。
- `scripts/run-test-profile.py` 从未把仓库根目录加入 `sys.path`，仓库自身的 `tools/` 命名空间包无法导入，`test_crawl_igem_parts` 与 `test_materials_promotion` **在该运行器下（也就是 CI 下）永远无法通过**，手工从根目录直接运行却可以。
- `test_scientific_contracts` 与 `test_evidence_standing` 未登记到任何 profile，使整个 `base` profile 直接判为 `invalid-profile` 而一项不跑。
- `research-workflows.ts` 的 `reusableResult` 缺少 `Promise<…>` 返回类型标注。
- 工作流预览门禁（U09）落地后，`research-workflows`、`research-workflow-state` 与 `research-workflows-bridge` 三处测试仍在断言 `start` 的旧契约，未随 `expectedPlanSha256` 更新。
- `test_skill_sdk` 与 `test_cli` 仍在断言可选适配器信任门禁（U07 / ADR 0004）之前的行为。已改为验证门禁本身：未固定内容时被 `blocked_by_extension_trust` 阻断，显式固定后可用，适配器内容变更后旧固定自动失效。CLI 侧只覆盖被阻断的一半，因为该测试夹具刻意不把 `git` 放进 PATH。

### 已知失败与未核实项

- `tests/owned-process.test.mjs` 的 `owned termination joins inherited stdio after the direct child has exited` 在本机**取决于运行方式**：随 `tests/*.test.mjs` 全量运行时通过，单独运行该文件时稳定失败（3/3）。`process-security.ts` 与该测试文件本轮均未修改（最后改动为 2026-09-04/05）。

  用**不含任何仓库代码**的独立脚本可复现其根因：直接子进程退出后，即使后代仍持有继承来的 stderr 写端，Node v24.20.0 在 Windows 上也会立刻把父侧可读流标记为 `closed`。该断言写的是"后代仍持有管道"，实际观测到的却是"stream 的 close 事件是否已被事件循环处理"——全量运行时事件循环繁忙、close 事件尚未派发，断言便偶然成立。

  因此这是一项**结论依赖调度的测试**，其通过并不构成它所声称的进程树属性的证据。本轮未收紧也未放宽其断言：修正它需要改变被测属性的定义，属于独立决定。
- 第 6 节列出的未读文件、未核实的托管 CI 结果，以及第 6 节末尾五个会实质改变建议的问题，均**仍然未解决**。本节只报告软件契约状态，不构成任何科学有效性结论。
