# Chat and the unified scientific workflow

Verified locally on 2026-09-19. The workspace order is **Chat / Design / Compute**.
Chat has a durable conversation list, a reading column, a composer, a visible
research plan, expandable tool receipts, and an optional document editor. It uses
the same Anthropic font roles and neutral controls as the scientific workspaces.

## One capability, one implementation

`apps/proto-workbench/src/shared/research-tool-registry.ts` assigns canonical
capability IDs and resolves compatibility aliases. Chat discovers exact schemas
with `science_catalog`, then calls `science_run`. Both use existing Proto MCP
implementations; the dedicated Compute interface calls the same computation
backend. Aliases do not register or execute duplicate implementations.

| Capability | Canonical ID | Existing backend |
| --- | --- | --- |
| Computation discovery | `compute.catalog` | `proto_compute_catalog` |
| Biomni adaptations and native statistical companions | `compute.run` | `proto_compute_run` |
| PubMed, Europe PMC, Crossref | `literature.*` | Existing scientific database connectors |
| UniProt and Rhea | `database.*` | Existing scientific database connectors |
| Python, R and notebooks | `code.*` | Existing OCI execution broker |
| Installed WSL bioinformatics | `bioinformatics.catalog`, `bioinformatics.run` | Typed adapters to the same installed engines |
| PDF, DOCX and XLSX reading | `document_import`, `document_read` | Shared Chat document parser and source-bound extraction |
| Design and validation | `design.*` | Existing governed Proto tools |
| Skills | `skills.catalog` | Existing bundled skill catalogue |

The conversation loop combines three source families:

- **OpenScience**: focused research workflows, visible plans, canonical successful
  search reuse, repeated-call detection, and complete results stored behind
  bounded previews.
- **Biomni**: the existing ported computation library, native statistical
  companions, exact input schemas, method provenance and result artifacts.
- **DeepSeek Harness**: context projection that preserves the newest request and
  reports removed older turns without deleting the durable transcript.

These are selected adaptations, not a claim that either upstream application has
been imported in full. `workflowFamilies` describe integration references; the
computation receipt identifies the actual algorithm implementation and provenance.
Pinned commits, modified source paths and licenses are in the Workbench's
`THIRD_PARTY_NOTICES.md`.

## Execution and state

Module and skill choices are captured when a message starts. Later selection
changes apply to subsequent messages. The browser preview forwards its actual
session module settings; the desktop uses persistent settings. Disabled modules
are excluded from discovery and rejected by execution. Selected bundled skills
contribute their reviewed instructions to the model context.

Scientific calls use an owned MCP worker per call and the existing workspace
read/write queue. Cancelling a worker does not terminate the shared Design MCP
connection. Live database requests receive short-lived, call-bound network
capabilities. Arbitrary Python/R execution continues through the existing
digest-pinned OCI broker; it cannot opt into unsafe host execution from Chat.

The model must be explicitly connected to an exact LM Studio loaded instance.
Inventory and binding state are refreshed from `http://127.0.0.1:1234`. A saved
conversation is not evidence that its former model is currently loaded.

Text and code documents have revisions and immutable snapshots in messages.
Exports create new files under `build/chat/<conversation>/`. Full tool outputs
are JSON artifacts there; large observations are shortened only in the active
model context. Paths outside the workspace are rejected. A cancelled or
token-exhausted reply retains its partial output without being marked complete.

## Local acceptance evidence

- Real Qwen3.8 27B session: discovered the computation schema, wrote a request,
  ran `descriptive_statistics`, and obtained mean **6** and sample standard
  deviation **3.1622776601683795** for `[2,4,6,8,10]`.
- Real online PubMed search returned DESeq2's original 2014 method paper,
  PMID **25516281**, with an explicit metadata-only reading scope.
- Conversation: `8c60e37e-7ebb-4f8a-9ff0-ab4880cbcce5` in the preview database.
- Computation evidence: `build/compute/cd2dd0654f3f4607b0386cc98390eef2/`.
- UI-created document exported and reopened successfully:
  `build/chat/8c60e37e-7ebb-4f8a-9ff0-ab4880cbcce5/0e759452-r1-workflow-acceptance.md`.
- Chat/model/skill/computation regression: **59 tests passed**.
- Actual unified bridge and sandbox configuration: **2 tests passed**.
- Logs: `build/chat-qa/`; type checking and desktop build passed.

## Deployed execution and document reading

The current deployment crosses the earlier runtime boundaries. Python and R
scripts run in the independent rootless WSL OCI backend with the pinned Jupyter
data-science image. Python and R notebooks use real kernels and preserve cell
outputs, plots, execution counts and failure state. Six actual execution checks
passed, including a numeric comparison, rich output, a failing notebook and
container removal after timeout. Evidence:
`build/chat-runtime-qa/2026-09-19T17-53-18-743Z/verification.json`.

Nine typed WSL operations now cover GATK Mutect2, samtools, bcftools, LUMPY,
SnpEff, CNVkit, Prokka, DESeq2 and nucmer. All nine operations and cancellation
passed on synthetic fixtures. A real Chat tool bridge also completed nucmer
alignment and verified its contained artifacts. See
`build/bioinformatics-adapter-qa/summary.json` and
`build/bioinformatics-chat-qa/latest.json`.

Chat directly imports PDF, DOCX and XLSX attachments. The source reader and
model tools share paginated, source-hashed extractions with page, paragraph,
sheet and cell locations. PDFs need a selectable text layer; OCR is not
implemented. Spreadsheet formulas retain cached values and are not recalculated.

Deployment and restart information is in
[chat-execution-deployment.md](chat-execution-deployment.md). Format-specific
details and limits are in [chat-document-parsing.md](chat-document-parsing.md).
Installed engine inventory and operation schemas are documented in
[bioinformatics-environment.md](bioinformatics-environment.md).

The final UI check also covered light/dark themes, the local model menu,
820 x 700 compact navigation, and a draft preserved across Chat, Compute and
Design. The inspected browser log contained no warnings or errors. The final
local acceptance receipt is `build/chat-qa/acceptance.json`; this is source
preview and desktop-build evidence, not installer or hosted CI acceptance.
