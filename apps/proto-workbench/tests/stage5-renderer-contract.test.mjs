import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const rendererPath = (...parts) => resolve("src", "renderer", ...parts);

test("Runs mounts the Stage 5 evidence explorer without replacing the Stage 4 shell", async () => {
  const app = await readFile(rendererPath("App.tsx"), "utf8");
  const runs = section(app, "currentView === \"runs\" ? <>", "</> : <main className=\"page-workspace\">");

  assert.match(app, /import \{ RunEvidenceViews \} from "\.\/RunEvidenceViews\.tsx"/);
  assert.match(runs, /<RunHeader \/>[\s\S]*?<RunAttentionStrip \/>[\s\S]*?<StageTracker \/>[\s\S]*?<RunEvidenceViews \/>[\s\S]*?<CodeDrawer \/>[\s\S]*?<ReviewPanel \/>/);
  assert.doesNotMatch(runs, /<RunLedger \/>/);
});

test("Timeline, Topology, and Artifacts share one accessible selected step", async () => {
  const views = await readFile(rendererPath("RunEvidenceViews.tsx"), "utf8");

  assert.match(views, /type EvidenceTab = "timeline" \| "topology" \| "artifacts"/);
  assert.match(views, /role="tablist" aria-label="Run evidence views"/);
  assert.match(views, /role="tab"[\s\S]*?aria-selected=\{activeTab === id\}[\s\S]*?aria-controls=\{`run-evidence-panel-\$\{id\}`\}/);
  assert.match(views, /ArrowLeft[\s\S]*?ArrowRight[\s\S]*?Home[\s\S]*?End/);
  assert.match(views, /const selectedStepId = useWorkbenchStore\(\(state\) => state\.selectedEventId\)/);
  assert.match(views, /const selectEvidenceStep = useWorkbenchStore\(\(state\) => state\.selectEvidenceStep\)/);
  assert.match(views, /role="option"[\s\S]*?aria-selected=\{selectedStepId === step\.id\}[\s\S]*?aria-current=\{selectedStepId === step\.id \? "step" : undefined\}/);
  assert.match(views, /id="run-evidence-panel-timeline"[\s\S]*?role="tabpanel"/);
  assert.match(views, /id="run-evidence-panel-topology"[\s\S]*?role="tabpanel"/);
  assert.match(views, /id="run-evidence-panel-artifacts"[\s\S]*?role="tabpanel"/);
});

test("artifact selection is passive and artifact inspection is an explicit action", async () => {
  const views = await readFile(rendererPath("RunEvidenceViews.tsx"), "utf8");
  const store = await readFile(rendererPath("store.ts"), "utf8");
  const selectStep = section(store, "selectEvidenceStep(selectedEventId)", "async openEvidenceArtifact(locator)");
  const openArtifact = section(store, "async openEvidenceArtifact(locator)", "setLedgerSearchOpen(ledgerSearchOpen)");

  assert.doesNotMatch(views, /outputArtifacts\s*\[\s*0\s*\]/);
  assert.doesNotMatch(views, /selectEvent/);
  assert.match(views, /Artifacts open only on explicit request\./);
  assert.match(views, /onClick=\{\(\) => onOpen\(artifact\.locator\)\}[\s\S]*?>Inspect artifact<\/button>/);
  assert.match(selectStep, /set\(\{ selectedEventId \}\)/);
  assert.doesNotMatch(selectStep, /files\.read|activeDocument|outputArtifacts/);
  assert.match(openArtifact, /workbenchApi\(\)\.files\.read\(locator\)/);
  assert.match(openArtifact, /activeDocument: \{ path: document\.path, content: document\.content \}/);
});

test("topology consumes only hardened projection edges and renders accessible DOM lanes", async () => {
  const views = await readFile(rendererPath("RunEvidenceViews.tsx"), "utf8");
  const topology = section(views, "function TopologyView", "function ArtifactsView");

  assert.match(views, /projectRunExecution\(events, fixture\?\.execution\)/);
  assert.match(views, /edges=\{projection\.topologyEdges\}/);
  assert.match(views, /quarantined=\{projection\.quarantined\}/);
  assert.match(topology, /className="topology-lanes" aria-label="Execution topology lanes"/);
  assert.match(topology, /<section className="topology-lane" aria-label=\{`\$\{capitalize\(stage\)\} lane`\}/);
  assert.match(topology, /edges\.map\(\(edge\) =>/);
  assert.match(topology, /Only persisted explicit lineage is shown\. Matching locators never create an edge\./);
  assert.match(topology, /malformed projection record[\s\S]*?quarantined and cannot drive selection or lineage/);
  assert.doesNotMatch(topology, /find\([^\n]*locator|filter\([^\n]*locator/);
});

test("artifacts expose role, locator, lineage binding, and digest binding state", async () => {
  const views = await readFile(rendererPath("RunEvidenceViews.tsx"), "utf8");
  const artifacts = section(views, "function ArtifactsView", "function bindingLabel");
  const labels = section(views, "function bindingLabel", "function isInspectableLocator");

  assert.match(artifacts, /artifact-role[\s\S]*?capitalize\(artifact\.role\)/);
  assert.match(artifacts, /artifact-locator[\s\S]*?artifact\.locator/);
  assert.match(artifacts, /<dt>Binding<\/dt><dd>\{bindingLabel\(artifact\.binding\)\}<\/dd>/);
  assert.match(artifacts, /<dt>Digest state<\/dt>/);
  assert.match(artifacts, /SHA-256 \+ size recorded/);
  assert.match(artifacts, /No byte binding/);
  assert.match(labels, /digest-bound[\s\S]*?Digest-bound · SHA-256 \+ size/);
  assert.match(labels, /declared[\s\S]*?Explicit lineage · no byte binding/);
  assert.match(labels, /unbound[\s\S]*?Unbound legacy reference/);
});

test("preview evidence is explicitly bounded and includes realistic declared and digest-bound refs", async () => {
  const mock = await readFile(rendererPath("mock-api.ts"), "utf8");
  const fixture = section(mock, "export function previewRunEvidenceFixture", "\n}\n", true);

  assert.match(fixture, /if \(workbenchDataMode\(\) !== "preview"\) return undefined/);
  assert.match(fixture, /artifactRefs: \[/);
  assert.match(fixture, /sourceStepId: "event-plan-102712"/);
  assert.match(fixture, /sha256: "3"\.repeat\(64\)/);
  assert.match(fixture, /sizeBytes: DEMO_PATCH\.before\.length/);
  assert.match(fixture, /locator: "build\/runs\/toggle_switch\/manifest\.json"/);
});

test("preview task checkpoints and forks clone task context without file or model effects", async () => {
  const mock = await readFile(rendererPath("mock-api.ts"), "utf8");
  const detail = section(mock, "function mockRunDetail", "const mockWorkbench:");
  const runs = section(mock, "  runs: {", "  reviews: {");
  const fork = section(runs, "async forkCheckpoint(input)", "async archive(runId, archived)");

  assert.match(detail, /eventHistory,/);
  assert.match(detail, /historyHead,/);
  assert.match(detail, /taskCheckpoints: structuredClone\(taskCheckpoints\.get\(runId\) \?\? \[\]\)/);
  assert.match(detail, /runForks: structuredClone\(runForks\.get\(runId\) \?\? \[\]\)/);
  assert.match(runs, /async createCheckpoint\(runId\)/);
  assert.match(runs, /sourceMessageId: message\.id/);
  assert.match(runs, /historyHead: structuredClone\(detail\.historyHead\)/);
  assert.match(fork, /forkResultsByIdempotencyKey\.get\(input\.idempotencyKey\)/);
  assert.match(fork, /idempotency key is already bound to a different task checkpoint/);
  assert.match(fork, /checkpoint\.snapshotDigest !== input\.expectedSnapshotDigest/);
  assert.match(fork, /input\.expectedResumeContractDigest !== previewDigest\(14\)/);
  assert.match(fork, /const thread: AgentThread =/);
  assert.match(fork, /const forkMessages: ChatMessage\[\] = checkpoint\.messages\.map/);
  assert.match(fork, /messages\.set\(thread\.id, forkMessages\)/);
  assert.match(fork, /forkThreadIds\.add\(thread\.id\)/);
  assert.match(fork, /return structuredClone\(result\)/);
  assert.doesNotMatch(fork, /files\.|models\.(?:load|unload)|send\(|proposePatch|applyApprovedPatch/);
});

test("renderer task checkpoint actions use the runs API and task-only fork enters the child thread", async () => {
  const views = await readFile(rendererPath("RunEvidenceViews.tsx"), "utf8");
  const store = await readFile(rendererPath("store.ts"), "utf8");
  const createCheckpoint = section(store, "async createTaskCheckpoint(runId)", "async forkTaskCheckpoint(checkpointId");
  const forkCheckpoint = section(store, "async forkTaskCheckpoint(checkpointId", "setLedgerSearchOpen(ledgerSearchOpen)");

  assert.match(views, /runDetail\?\.taskCheckpoints \?\? \[\]/);
  assert.match(views, /checkpoint\.historyHead\.sequence <= selectedHistoryHead\.sequence/);
  assert.match(views, /selectionIsCurrentHead/);
  assert.match(views, /createTaskCheckpoint\(runDetail\.summary\.runId\)/);
  assert.match(views, /forkTaskCheckpoint\(taskCheckpoint\.id, taskCheckpoint\.snapshotDigest, resumeContract\.digest, forkTitle\)/);
  assert.match(views, /Creating a child task does not start the model, restore files, or approve later effects\./);
  assert.match(createCheckpoint, /workbenchApi\(\)\.runs\.createCheckpoint\(runId\)/);
  assert.match(createCheckpoint, /taskCheckpoints:/);
  assert.doesNotMatch(createCheckpoint, /files\.|models\.|threads\.send|send\(/);
  assert.match(forkCheckpoint, /workbenchApi\(\)\.runs\.forkCheckpoint/);
  assert.match(forkCheckpoint, /thread: result\.thread/);
  assert.match(forkCheckpoint, /messages: result\.messages/);
  assert.match(forkCheckpoint, /selectedRunId: undefined/);
  assert.match(forkCheckpoint, /runDetail: undefined/);
  assert.match(forkCheckpoint, /events: \[\]/);
  assert.match(forkCheckpoint, /patch: undefined/);
  assert.match(forkCheckpoint, /pendingApprovals: \[\]/);
  assert.match(forkCheckpoint, /prompt: ""/);
  assert.match(forkCheckpoint, /attachments: \[\]/);
  assert.doesNotMatch(forkCheckpoint, /files\.|models\.|threads\.send|send\(/);
});

test("workspace trust, immutable checkpoint, task-only fork preview, and legacy restore boundary stay explicit", async () => {
  const views = await readFile(rendererPath("RunEvidenceViews.tsx"), "utf8");
  const app = await readFile(rendererPath("App.tsx"), "utf8");
  const pages = await readFile(rendererPath("OperationalPages.tsx"), "utf8");
  const styles = await readFile(rendererPath("styles.css"), "utf8");

  assert.match(views, /aria-label="Current workspace files trust boundary"/);
  assert.match(views, /Current files · workspace trust boundary/);
  assert.match(views, /aria-label="Immutable task checkpoint"/);
  assert.match(views, /<strong>Task checkpoint<\/strong>/);
  assert.match(views, /<GitFork size=\{13\} \/>Review safe resume/);
  assert.match(views, /The parent run and current workspace files remain unchanged\./);
  assert.match(views, /Creating a child task does not start the model, restore files, or approve later effects\./);
  assert.match(app, /Legacy recovery\/audit only[\s\S]*?Prepare restore diff/);
  assert.match(pages, /Legacy recovery\/audit only[\s\S]*?Prepare restore diff/);
  assert.match(styles, /\.workspace-trust-banner\s*\{/);
  assert.match(styles, /\.topology-lanes\s*\{/);
  assert.match(styles, /\.immutable-checkpoint-card\s*\{/);
});

function section(source, startMarker, endMarker, includeEnd = false) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `Missing source marker: ${startMarker}`);
  assert.notEqual(end, -1, `Missing source marker: ${endMarker}`);
  return source.slice(start, includeEnd ? end + endMarker.length : end);
}
