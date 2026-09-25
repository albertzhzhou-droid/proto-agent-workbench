/* Synthetic validated display records and mock DOM/WebGL only; no browser acceptance. */
'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const lab = require('../src/chem_workbench/web_assets/refinement-lab.js');
const model = require('../src/chem_workbench/web_assets/geometry-view-model.js');
const fixtures = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const copy = value => structuredClone(value);

class Element {
  constructor(tag = 'div') { this.tagName = tag; this.children = []; this.attributes = {}; this.listeners = {}; this.style = {}; this.value = ''; this.disabled = false; this._text = ''; this.classList = { add() {}, toggle() { return false; } }; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(' '); }
  append(...children) { this.children.push(...children); }
  prepend(...children) { this.children.unshift(...children); }
  after() {}
  replaceChildren(...children) { this._text = ''; this.children = children; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(name, callback) { (this.listeners[name] ||= []).push(callback); }
  fire(name, properties = {}) { for (const callback of this.listeners[name] || []) callback({ key: '', preventDefault() {}, ...properties }); this['on' + name]?.(properties); }
  querySelector() { return null; }
}
function elements(host, tag) { return host.children.flatMap(child => [ ...(child.tagName === tag ? [child] : []), ...elements(child, tag)]); }
function button(host, text) { const found = elements(host, 'button').find(item => item.textContent === text); assert.ok(found, text); return found; }
function mount(value) { global.document = { createElement: tag => new Element(tag), createElementNS: (_namespace, tag) => new Element(tag) }; const host = new Element(); return { host, controller: lab.renderRefinementView(host, value) }; }

test('every actual adapter output is admitted without inventing successful optimization', () => {
  for (const value of Object.values(fixtures)) assert.deepEqual(lab.prepare(value), value);
  assert.equal(lab.prepare(fixtures.failure).state, 'failed');
  assert.equal(lab.prepare(fixtures.precise).convergence.optimizer_reported_converged, null);
});
test('display inventory supports the scientific contract above 1000 evaluations without sorting', () => {
  // Synthetic capacity shape only; this is not a newly validated scientific trajectory.
  const value = copy(fixtures.precise), frame = value.frames[0], point = value.trajectory_chart.points[0];
  value.frames = Array.from({ length: 1001 }, (_, index) => ({ ...copy(frame), evaluation_index: index, elapsed_wall_seconds: String(index) }));
  value.trajectory_chart.points = Array.from({ length: 1001 }, (_, index) => ({ ...copy(point), evaluation_index: index, elapsed_wall_seconds: String(index), plot_projection: { ...point.plot_projection, elapsed_wall_seconds: index } }));
  value.playback.sample_count = 1001; value.timing.elapsed_seconds = '1001'; value.final_frame_hash = frame.frame_hash;
  assert.equal(lab.prepare(value).frames.length, 1001);
});
test('exact signed decimal strings survive rows and CSV; old numeric geometry behavior remains identical', () => {
  const scene = fixtures.precise.frames[0].scene, exact = scene.coordinate_table[0].position_angstrom[0];
  assert.notEqual(exact, String(scene.atoms[0].position[0]));
  assert.equal(lab.coordinateRows(scene)[0].position[0], exact);
  assert.ok(lab.coordinateCSV(scene).includes('"' + exact + '"'));
  assert.ok(!lab.coordinateCSV(scene).includes('"\'' + exact));
  assert.equal(lab.coordinateRows(scene, 2)[0].position[0], exact);
  assert.equal(lab.coordinateRows(scene, 2)[0].displayed_position[0], scene.atoms[0].position[0] * 2);
  const old = copy(scene); delete old.coordinate_table;
  assert.deepEqual(lab.coordinateRows(old, 1.02), model.rows(old, 1.02));
  assert.equal(lab.coordinateCSV(old, 1.02), model.csv(old, 1.02));
});
test('text CSV fields remain injection-safe without modifying validated negative decimals', () => {
  const scene = copy(fixtures.precise.frames[0].scene); scene.atoms[0].id = scene.coordinate_table[0].id = '=1+1';
  assert.ok(lab.coordinateCSV(scene).includes('"\'=1+1"'));
  assert.ok(lab.coordinateCSV(scene).includes('"-0.1234567890123456789012345"'));
});
test('present mismatched exact tables fail closed, including bool/numeric substitution', () => {
  for (const mutate of [g => g.coordinate_table.pop(), g => g.coordinate_table[0].id = 'other', g => g.coordinate_table[0].index = false,
    g => g.coordinate_table[0].element = 'H', g => g.coordinate_table[0].position_angstrom[0] = '42', g => g.coordinate_table[0].position_angstrom[0] = false,
    g => g.coordinate_table[0].gradient_hartree_per_bohr[0] = '=1+1', g => g.atoms[0].position[0] = false, g => g.projection.display_scale = true]) {
    const scene = copy(fixtures.precise.frames[0].scene); mutate(scene); assert.throws(() => lab.coordinateRows(scene));
  }
});
test('display conflicts cannot advertise physical time, minima or unrelated energy', () => {
  for (const mutate of [v => v.playback.clock = 'physical_time_s', v => v.convergence.minimum_status = 'minimum', v => v.execution_authority = true,
    v => v.trajectory_chart.points[0].energy_hartree = '-999', v => v.frames[0].scene.refinement_binding.frame_hash = 'other',
    v => v.frames[0].physical_time_s = 0, v => v.frames[0].evaluation_index = false, v => v.convergence.optimizer_reported_converged = 1,
    v => v.scope.scientific_accuracy_inferred = true, v => v.frames[0].scene.provenance = 'tool_generated']) {
    const value = copy(fixtures.precise); mutate(value); assert.throws(() => lab.prepare(value));
  }
});
test('DOM shows exact coordinate/gradient values and origin without parsing failure text as markup', () => {
  const { host, controller } = mount(fixtures.failure); controller.selectEvaluation(0);
  assert.ok(host.textContent.includes('Synthetic validation'));
  assert.ok(host.textContent.includes('-0.1234567890123456789012345'));
  assert.ok(host.textContent.includes('Synthetic failure <script>must remain text</script>'));
  assert.equal(elements(host, 'script').length, 0);
  assert.ok(host.textContent.includes('Minimum: not evaluated'));
  assert.ok(host.textContent.includes('Physical time: not recorded'));
  const coordinates = elements(host, 'table')[0]; assert.equal(elements(coordinates, 'tbody')[0].children.length, fixtures.failure.frames[0].coordinate_table.length);
  assert.deepEqual(elements(coordinates, 'tbody')[0].children[0].children.map(cell => cell.textContent),
    [fixtures.failure.frames[0].coordinate_table[0].id, fixtures.failure.frames[0].coordinate_table[0].element, ...fixtures.failure.frames[0].coordinate_table[0].position_angstrom, ...fixtures.failure.frames[0].coordinate_table[0].gradient_hartree_per_bohr]);
});
test('failure presentation uses scoped layout and collapsed unmodified original text', () => {
  const value = copy(fixtures.failure); value.failure.message = 'Synthetic original failure\n' + 'trace detail\t<unsafe>\n'.repeat(100);
  const { host } = mount(value);
  assert.equal(host.children[0].className, 'refinement-lab-panel');
  assert.equal(host.children[0].children[0].className, 'rl-body');
  assert.equal(elements(host, 'dl').length, 1);
  const failure = elements(host, 'details').find(item => item.children[0].textContent === 'Original failure message');
  assert.ok(failure); assert.ok(!failure.open); assert.equal(failure.children[1].textContent, value.failure.message);
  assert.ok(!elements(host, 'p').some(item => item.textContent.includes(value.failure.message)));
  assert.ok(!elements(host, 'div').some(item => ['agent-body', 'agent-actions'].includes(item.className)));
});
test('rejected trial followed by anchor reevaluation stays in evaluation event order', () => {
  const { host, controller } = mount(fixtures.reevaluation);
  const select = elements(host, 'select')[0];
  assert.deepEqual(select.children.map(option => option.value), ['0', '1', '2', '3']);
  controller.selectEvaluation(3); assert.ok(host.textContent.includes('Optimizer iteration: 1')); assert.ok(host.textContent.includes('Elapsed computation wall time: 4 s'));
  button(host, 'Previous evaluation').fire('click'); assert.equal(select.value, '2'); assert.ok(host.textContent.includes('Evaluation 2 · rejected'));
  button(host, 'Next evaluation').fire('click'); assert.equal(select.value, '3');
});
test('energy chart has exactly one selectable point per recorded frame and no connecting motion line', () => {
  const { host } = mount(fixtures.reevaluation);
  assert.equal(elements(host, 'circle').length, 4);
  assert.equal(elements(host, 'polyline').length, 0);
  elements(host, 'circle')[1].fire('keydown', { key: 'Enter' }); assert.equal(elements(host, 'select')[0].value, '1');
  const axis = elements(host, 'select')[1]; axis.value = 'elapsed_wall_seconds'; axis.fire('change');
  assert.ok(host.textContent.includes('Elapsed computation wall time / s'));
  assert.equal(elements(host, 'circle').length, 4);
});
test('zero evaluation result has no geometry, plot points, coordinate rows or enabled display action', () => {
  const { host } = mount(fixtures.empty);
  assert.equal(elements(host, 'circle').length, 0); assert.equal(elements(host, 'table').length, 0);
  assert.equal(button(host, 'Show evaluation in 3D').disabled, true);
  assert.ok(host.textContent.includes('No successful gradient evaluations were retained'));
});
test('3D action copies the selected bound scene only and reports missing viewport', () => {
  const { host, controller } = mount(fixtures.precise), displayed = [];
  global.displayGeometry = (scene, scale) => { displayed.push({ scene, scale }); global.getDisplayedGeometry = () => ({ geometry: scene, scale }); };
  assert.equal(displayed.length, 0); controller.selectEvaluation(0); assert.equal(displayed.length, 0);
  button(host, 'Show evaluation in 3D').fire('click');
  assert.deepEqual(displayed[0], { scene: fixtures.precise.frames[0].scene, scale: 1 });
  displayed[0].scene.atoms[0].position[0] = 42;
  button(host, 'Show evaluation in 3D').fire('click'); assert.notEqual(displayed[1].scene.atoms[0].position[0], 42);
  delete global.displayGeometry; button(host, 'Show evaluation in 3D').fire('click'); assert.ok(host.textContent.includes('3D unavailable:'));
});
test('replacing or disposing a part prevents stale controls changing shared viewport', () => {
  const { host, controller } = mount(fixtures.precise), stale = button(host, 'Show evaluation in 3D');
  let calls = 0; global.displayGeometry = () => calls++;
  const current = lab.renderRefinementView(host, fixtures.empty);
  stale.fire('click'); assert.equal(calls, 0); assert.equal(controller.selectEvaluation(0), false);
  controller.dispose(); assert.ok(host.children.length > 0);
  current.dispose(); assert.equal(host.children.length, 0);
  delete global.displayGeometry;
});
test('invalid replacement removes stale result and gives a visible error', () => {
  const { host } = mount(fixtures.precise);
  assert.throws(() => lab.renderRefinementView(host, {}));
  assert.equal(elements(host, 'table').length, 0); assert.ok(host.textContent.includes('Refinement view unavailable:'));
});

function viewerContext() {
  const ids = new Map(), exports = [], styles = [];
  const get = id => { if (!ids.has(id)) ids.set(id, new Element()); return ids.get(id); };
  const document = { getElementById: get, createElement: tag => new Element(tag), querySelector: () => new Element(), addEventListener() {}, dispatchEvent() {} };
  const viewer = { spin() {}, clear() {}, setProjection() {}, setViewStyle() {}, getView: () => [1, 2, 3], setView() {}, resize() {}, render() {}, rotate() {}, zoomTo() {}, zoom() {}, setStyle(selection, style) { styles.push({ selection, style }); }, removeAllShapes() {}, removeAllLabels() {}, addLabel() {}, setClickable() {}, addModel: () => ({ addAtoms() {} }) };
  const context = vm.createContext({ document, ChemGeometryView: model, ChemRefinementLab: lab, structuredClone, console,
    Option: function (label, value) { const node = new Element('option'); node.textContent = label; node.value = value; return node; },
    ResizeObserver: class { observe() {} }, CustomEvent: class {}, setTimeout() {},
    $3Dmol: { elementColors: { Jmol: {} }, createViewer: () => viewer } });
  context.window = context;
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/chem_workbench/web_assets/viewer.js'), 'utf8'), context);
  context.saveGeometryText = (text, type, name) => exports.push({ text, type, name });
  get('representation').value = 'ball';
  return { context, get, exports, styles };
}
test('actual viewer.js labels evaluated geometry and uses precise table, atom text and CSV', () => {
  const { context, get, exports } = viewerContext(), scene = copy(fixtures.precise.frames[0].scene);
  context.displayGeometry(scene);
  assert.equal(get('geometry-kind').textContent, 'Evaluated geometry');
  assert.equal(context.getDisplayedGeometry().geometry.geometry_hash, scene.geometry_hash);
  assert.ok(get('coordinate-rows').textContent.includes('-0.1234567890123456789012345'));
  context.pickRecordedAtom(0); context.pickRecordedAtom(1);
  assert.ok(get('atom-inspector').textContent.includes('approximate binary64 projection'));
  get('export-coordinate-csv').fire('click'); assert.equal(exports[0].text, lab.coordinateCSV(scene));
  context.pickRecordedAtom(0); assert.ok(get('atom-inspector').textContent.includes('-0.1234567890123456789012345'));
});
test('actual viewer.js fails malformed exact data visibly and retains legacy source label/export', () => {
  const { context, get, exports } = viewerContext(), scene = copy(fixtures.precise.frames[0].scene);
  scene.coordinate_table[0].id = 'mismatch'; context.displayGeometry(scene);
  assert.equal(context.getDisplayedGeometry(), null); assert.ok(get('viewer-empty').textContent.includes('Exact coordinate table'));
  const old = copy(fixtures.precise.frames[0].scene); delete old.coordinate_table; old.provenance = 'source_imported';
  context.displayGeometry(old, 1.02); assert.equal(get('geometry-kind').textContent, 'Imported coordinates');
  get('export-coordinate-csv').fire('click'); assert.equal(exports[0].text, model.csv(old, 1.02));
  old.provenance = 'calculation_input'; context.displayGeometry(old); assert.equal(get('geometry-kind').textContent, 'Calculation input');
});
test('atom-only evaluated geometry stays visible as spheres in wire mode without inferred bonds', () => {
  const { context, get, styles } = viewerContext(), scene = copy(fixtures.precise.frames[0].scene);
  get('representation').value = 'wire'; context.displayGeometry(scene);
  assert.ok(styles.filter(item => item.selection.elem).every(item => item.style.sphere && !item.style.line));
  assert.equal(scene.bonds.length, 0);
  styles.length = 0; const old = copy(scene); delete old.coordinate_table; old.provenance = 'source_imported'; context.displayGeometry(old);
  assert.ok(styles.filter(item => item.selection.elem).every(item => item.style.line && !item.style.sphere));
});
