import test from "node:test";
import assert from "node:assert/strict";
import {loadMissionPanelFixture, projection} from "./helpers/harness-mission-render-fixture.mjs";

test("production mission panel renders review evidence without offering terminal resume", async t => {
  const fixture = await loadMissionPanelFixture(); t.after(() => fixture.dispose());
  const html = fixture.render(projection());
  assert.match(html, /needs human/);
  assert.match(html, /The synthetic exporter cannot establish this required receipt/);
  assert.match(html, /aria-label="Unmet requirements"/);
  assert.match(html, /build\/fixture.png needs a verified renderer receipt/);
  assert.match(html, /Repairs remaining: output 1 · progress 1 · verification 0/);
  assert.match(html, /Verification history · 1 checks/);
  assert.match(html, /unsupported/);
  assert.match(html, /No trusted renderer receipt exists for this synthetic fixture/);
  assert.doesNotMatch(html, /Resume saved task|Pause task|Verified and ready to inspect/);
});

test("direct abstention exposes unmet requirements and export even without a verify cycle", async t => {
  const fixture = await loadMissionPanelFixture(); t.after(() => fixture.dispose());
  const html = fixture.render(projection({state: "abstained", verdicts: [], diagnosticCounts: {},
    abstention: {reason: "Insufficient synthetic input", unmetRequirements: ["Fixture dependency <not executable> is absent"], declaredAt: "2026-09-23T12:00:00.000Z"}}));
  assert.match(html, /abstained/);
  assert.match(html, /Fixture dependency &lt;not executable&gt; is absent/);
  assert.match(html, /Export diagnostics/);
  assert.doesNotMatch(html, /Verification history|Resume saved task|Pause task/);
  assert.equal(fixture.elements().filter(element => element.type === "button" && element.props.children === "Export diagnostics").length, 1);
});

test("production diagnostics download retains all verdicts, references and exhausted budgets", async t => {
  const fixture = await loadMissionPanelFixture(); t.after(() => fixture.dispose());
  const checkpoint = projection(); fixture.render(checkpoint);
  const button = fixture.elements().find(element => element.type === "button" && element.props.children === "Export diagnostics");
  assert.ok(button, "Production component exposes its export handler");
  let blob, clicked = false, revoked;
  const anchor = {href: "", download: "", click() {clicked = true;}};
  const originalDocument = globalThis.document;
  globalThis.document = {createElement(tag) {assert.equal(tag, "a"); return anchor;}};
  t.after(() => {if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument;});
  t.mock.method(URL, "createObjectURL", value => {blob = value; return "blob:synthetic-test-export";});
  t.mock.method(URL, "revokeObjectURL", value => {revoked = value;});
  t.mock.method(globalThis, "setTimeout", callback => {callback(); return 0;});
  button.props.onClick();
  assert.equal(clicked, true);
  assert.equal(anchor.download, "harness-diagnostics-synthetic_diagnostics_fixture.json");
  assert.equal(revoked, "blob:synthetic-test-export");
  assert.equal(blob.type, "application/json");
  const exported = JSON.parse(await blob.text());
  assert.deepEqual(exported.verdicts, checkpoint.verdicts);
  assert.deepEqual(exported.repairBudget, checkpoint.repairBudget);
  assert.deepEqual(exported.diagnosticCounts, checkpoint.diagnosticCounts);
  assert.deepEqual(exported.toolCallCounts, checkpoint.toolCallCounts);
  assert.deepEqual(exported.abstention, checkpoint.abstention);
  assert.match(exported.scope, /scientific interpretation requires human review/);
});

test("legacy unknown counters remain explicit and repaired histories preserve earlier failure", async t => {
  const fixture = await loadMissionPanelFixture(); t.after(() => fixture.dispose());
  const legacy = projection({repairBudget: {outputRepairs: 0, progressRepairs: 0}, contextUsed: undefined, tokenCountMethod: undefined});
  assert.match(fixture.render(legacy), /verification unknown/);
  const original = projection();
  const completed = projection({state: "completed", abstention: undefined, verdicts: [...original.verdicts, {...original.verdicts[0], callId: "finish-2", round: 4, action: "completed", diagnostics: [], passed: ["build/report.txt"]}]});
  const html = fixture.render(completed);
  assert.match(html, /Verified and ready to inspect/);
  assert.match(html, /Verification history · 2 checks/);
  assert.match(html, /No trusted renderer receipt exists for this synthetic fixture/);
  assert.match(html, /Round 4 · completed/);
});
