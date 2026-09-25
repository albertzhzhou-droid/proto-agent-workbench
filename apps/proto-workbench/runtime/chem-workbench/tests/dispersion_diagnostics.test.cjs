/* Retained dispersion-only values; DOM mocks exercise rendering, not scientific accuracy. */
'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const diagnostics = require('../src/chem_workbench/web_assets/dispersion-diagnostics.js');
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/dispersion-diagnostics-retained.json'), 'utf8'));
const copy = value => structuredClone(value);

class Element {
  constructor(tag = 'div') { this.tagName = tag; this.children = []; this.attributes = {}; this.listeners = {}; this._text = ''; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(' '); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this._text = ''; this.children = children; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(name, callback) { (this.listeners[name] ||= []).push(callback); }
  fire(name) { for (const callback of this.listeners[name] || []) callback({ preventDefault() {} }); }
  click() { this.fire('click'); }
}
function elements(host, tag) { return host.children.flatMap(child => [ ...(child.tagName === tag ? [child] : []), ...elements(child, tag)]); }
function button(host, text) { const result = elements(host, 'button').find(item => item.textContent === text); assert.ok(result, text); return result; }
function mount(value = fixture) { global.document = { createElement: tag => new Element(tag) }; const host = new Element(); return { host, controller: diagnostics.renderDispersionDiagnostics(host, value) }; }
function exactTable(host) { return elements(host, 'table').find(item => elements(item, 'caption')[0].textContent.startsWith('Exact ')); }

test('retained 34-atom comparison is detached and preserves actual energy and source bindings', () => {
  const view = diagnostics.prepare(fixture);
  assert.deepEqual(view, fixture); assert.notEqual(view, fixture);
  assert.equal(view.atom_count, 34); assert.equal(view.source_refs.length, 20);
  assert.equal(view.bridge.energy_hartree, '-0.0775092927799016');
  assert.equal(view.native.energy_hartree, view.bridge.energy_hartree);
  assert.equal(view.metrics.maximum_gradient_difference_hartree_per_bohr, '0');
  assert.equal(view.view_hash, 'sha256:61ae19172d460e930d4bb6cd71769f65c5c42008200493ad032a874702449b97');
  assert.equal(view.receipt_ref.sha256, 'b02ff4cb40e0fe38d5db64c628a24ab3178a6c2ad5a355d3f304dd17bb66d596');
  view.atoms[0].position_bohr[0] = '999'; assert.notEqual(fixture.atoms[0].position_bohr[0], '999');
});

test('DOM labels dispersion contributions, two calls and API parity without a full refinement result', () => {
  const { host } = mount();
  assert.equal(elements(host, 'h2')[0].textContent, 'D3(BJ) dispersion contribution');
  assert.deepEqual(elements(host, 'dd').map(item => item.textContent), ['-0.0775092927799016', '-0.0775092927799016']);
  for (const text of ['Two actual dispersion calls', 'dispersion energy / hartree', 'No total DFT energy', 'Physical time is not recorded', 'not chemical accuracy estimates', 'Retained source provenance']) assert.ok(host.textContent.includes(text), text);
  assert.equal(elements(host, 'select').length, 0);
  assert.equal(elements(host, 'svg').length, 0);
  assert.ok(host.textContent.includes(fixture.input_hash));
  assert.equal(host.children[0].className, 'dispersion-diagnostics');
});

test('coordinate table preserves all exact native Bohr values in stable atom order', () => {
  const { host } = mount();
  const rows = elements(exactTable(host), 'tbody')[0].children;
  assert.equal(rows.length, 34);
  rows.forEach((row, index) => assert.deepEqual(row.children.map(cell => cell.textContent), [fixture.atoms[index].id, fixture.atoms[index].element, ...fixture.atoms[index].position_bohr]));
  assert.equal(button(host, 'Raw coordinates / bohr').attributes['aria-pressed'], 'true');
});

test('gradient toggle preserves both complete exact arrays matched to the same atom IDs', () => {
  const { host } = mount(); button(host, 'Dispersion gradients / hartree bohr⁻¹').fire('click');
  const rows = elements(exactTable(host), 'tbody')[0].children;
  assert.equal(rows.length, 34);
  rows.forEach((row, index) => {
    assert.equal(row.children[0].textContent, fixture.atoms[index].id);
    assert.equal(row.children[1].textContent, fixture.atoms[index].element);
    for (const [column, source] of [[2, 'bridge'], [3, 'native']]) assert.deepEqual(elements(row.children[column], 'code').map(cell => cell.textContent), fixture[source].gradient_hartree_per_bohr[index].map((value, axis) => `${['x', 'y', 'z'][axis]}: ${value}`));
  });
  assert.equal(button(host, 'Dispersion gradients / hartree bohr⁻¹').attributes['aria-pressed'], 'true');
  button(host, 'Raw coordinates / bohr').fire('click'); assert.equal(rows.length, 34);
  assert.equal(exactTable(host).children[0].textContent, 'Exact common native input coordinates');
});

test('CSV contains exact signed values for every atom and both gradients without floating point reformatting', () => {
  const csv = diagnostics.coordinateCSV(fixture), rows = csv.trimEnd().split('\r\n').map(row => row.split(',').map(cell => cell.slice(1, -1)));
  assert.equal(rows.length, 35); assert.equal(rows[0].length, 12);
  fixture.atoms.forEach((atom, index) => assert.deepEqual(rows[index + 1], [fixture.input_hash, atom.id, atom.element, ...atom.position_bohr, ...fixture.bridge.gradient_hartree_per_bohr[index], ...fixture.native.gradient_hartree_per_bohr[index]]));
  assert.ok(csv.includes('"-')); assert.ok(!csv.includes('"\'-'));
  assert.ok(csv.endsWith('\r\n'));
});

test('zero difference cannot hide decimal differences that collapse to the same binary64 value', () => {
  const energy = copy(fixture), changedEnergy = energy.native.energy_hartree + '000000000000001';
  assert.equal(Number(changedEnergy), Number(energy.native.energy_hartree));
  energy.native.energy_hartree = energy.metrics.native_energy_hartree = changedEnergy;
  assert.throws(() => diagnostics.prepare(energy), /zero energy difference/);
  const gradient = copy(fixture), original = gradient.native.gradient_hartree_per_bohr[0][0], changedGradient = original + '000000000000001';
  assert.equal(Number(changedGradient), Number(original));
  gradient.native.gradient_hartree_per_bohr[0][0] = changedGradient;
  assert.throws(() => diagnostics.prepare(gradient), /zero gradient difference/);
});

test('invalid atom inventories, numbers, results and source shapes fail before rendering', () => {
  for (const mutate of [
    v => v.atom_count = true, v => v.atom_count = 33, v => v.atoms.reverse(),
    v => v.atoms[1].id = v.atoms[0].id, v => v.atoms[0].id = '=1+1', v => v.atoms[0].element = false,
    v => v.atoms[0].position_bohr[0] = false, v => v.atoms[0].position_bohr[0] = 1,
    v => v.atoms[0].position_bohr[0] = 'NaN', v => v.atoms[0].position_bohr[0] = '-0',
    v => v.atoms[0].position_bohr[0] = '1.00', v => v.atoms[0].position_bohr[0] = '1e-2',
    v => v.bridge.energy_hartree = Infinity, v => v.bridge.energy_hartree = '-Infinity',
    v => v.native.gradient_hartree_per_bohr.pop(), v => v.native.gradient_hartree_per_bohr[0][0] = 'NaN',
    v => v.native.gradient_hartree_per_bohr[0] = [0, 0, 0], v => v.metrics.native_energy_hartree = '-1',
    v => v.source_refs = [], v => v.receipt_ref.sha256 = 'bad', v => v.view_hash = 'bad',
    v => v.receipt_checks[Object.keys(v.receipt_checks)[0]] = 1,
    v => v.counts.dispersion_library_calls_attempted = '2', v => v.counts.inner_qcschema_calls_forwarded = true
  ]) { const value = copy(fixture); mutate(value); assert.throws(() => diagnostics.prepare(value)); }
});

test('scientific scope and timing claims cannot be promoted by this display adapter', () => {
  for (const key of ['accepted_science', 'full_dft_gradient', 'geometry_optimization', 'minimum_certification', 'scientific_accuracy_validation', 'synthetic_data', 'worker_record', 'total_dft_energy', 'physical_trajectory']) {
    const value = copy(fixture); value.scope[key] = true; assert.throws(() => diagnostics.prepare(value), /scope/);
  }
  for (const mutate of [v => v.scope.physical_time_s = 0, v => v.timing.physical_time_s = '0', v => v.timing.wall_seconds = '-1',
    v => v.electronic_energy_evaluations = 1, v => v.electronic_gradient_evaluations = false,
    v => v.scope.electronic_gradient_evaluations = 1, v => v.scope.electronic_energy_evaluations = false,
    v => v.method.parameters.s9 = '1', v => v.version = 'molecular-refinement-view/v1',
    v => v.metrics.absolute_energy_difference_hartree = '1']) {
    const value = copy(fixture); mutate(value); assert.throws(() => diagnostics.prepare(value));
  }
});

test('shared scene must preserve the supplied Bohr projection without foreign refinement bindings', () => {
  for (const mutate of [v => v.scene.provenance = 'tool_generated', v => v.scene.units = 'bohr',
    v => v.scene.input_record_hash = 'sha256:' + '0'.repeat(64), v => v.scene.display_source.input_hash = 'other',
    v => v.scene.atoms[0].position[0] += 0.001, v => v.scene.atoms[0].id = 'other',
    v => v.scene.coordinate_table = [], v => v.scene.refinement_binding = {}, v => v.scene.display_source.angstrom_to_bohr = '1.8']) {
    const value = copy(fixture); mutate(value); assert.throws(() => diagnostics.prepare(value));
  }
});

test('3D is explicit, supplies only the detached common scene, and reports unavailable or wrong viewport', () => {
  const { host } = mount(), displayed = [];
  global.displayGeometry = (scene, scale) => { displayed.push({ scene, scale }); global.getDisplayedGeometry = () => ({ geometry: scene, scale }); };
  assert.equal(displayed.length, 0); button(host, 'Show common geometry in 3D').fire('click');
  assert.deepEqual(displayed[0], { scene: fixture.scene, scale: 1 });
  assert.equal(displayed[0].scene.refinement_binding, undefined);
  displayed[0].scene.atoms[0].position[0] = 999;
  button(host, 'Show common geometry in 3D').fire('click'); assert.notEqual(displayed[1].scene.atoms[0].position[0], 999);
  global.displayGeometry = () => {}; global.getDisplayedGeometry = () => ({ geometry: { geometry_hash: 'other' } });
  button(host, 'Show common geometry in 3D').fire('click'); assert.ok(host.textContent.includes('Shared viewport did not display the bound input'));
  delete global.displayGeometry; delete global.getDisplayedGeometry;
  button(host, 'Show common geometry in 3D').fire('click'); assert.ok(host.textContent.includes('3D unavailable:'));
});

test('replacing and disposing a part disables all stale controls without clearing a newer part', () => {
  const { host, controller } = mount(), stale = elements(host, 'button');
  let calls = 0; global.displayGeometry = () => calls++;
  const current = diagnostics.renderDispersionDiagnostics(host, fixture);
  stale.forEach(item => item.fire('click')); assert.equal(calls, 0);
  controller.dispose(); assert.ok(host.children.length > 0);
  const currentButtons = elements(host, 'button'); current.dispose(); assert.equal(host.children.length, 0);
  currentButtons.forEach(item => item.fire('click')); assert.equal(calls, 0);
  delete global.displayGeometry;
});

test('invalid replacement clears the prior result and presents a visible error', () => {
  const { host } = mount(), stale = button(host, 'Show common geometry in 3D');
  assert.throws(() => diagnostics.renderDispersionDiagnostics(host, {}));
  assert.equal(elements(host, 'table').length, 0);
  assert.equal(host.children[0].attributes.role, 'alert');
  assert.ok(host.textContent.includes('Dispersion comparison unavailable:'));
  let calls = 0; global.displayGeometry = () => calls++; stale.fire('click'); assert.equal(calls, 0); delete global.displayGeometry;
});

test('source and method text is displayed literally without markup interpretation', () => {
  const value = copy(fixture); value.method.cutoffs = '<script>unchanged source text</script>';
  const { host } = mount(value);
  assert.ok(host.textContent.includes(value.method.cutoffs)); assert.equal(elements(host, 'script').length, 0);
  assert.ok(elements(host, 'details').every(item => !item.open));
});

test('invalid or valid replacement clears only the prior successfully displayed bound scene', () => {
  let shown = null, clears = 0;
  global.displayGeometry = (geometry, scale) => { shown = { geometry, scale }; };
  global.getDisplayedGeometry = () => shown;
  global.clearGeometry = () => { shown = null; clears++; };
  const { host, controller } = mount(); button(host, 'Show common geometry in 3D').fire('click');
  assert.equal(shown.geometry.geometry_hash, fixture.scene.geometry_hash);
  assert.throws(() => diagnostics.renderDispersionDiagnostics(host, {}));
  assert.equal(shown, null); assert.equal(clears, 1);
  diagnostics.renderDispersionDiagnostics(host, fixture); button(host, 'Show common geometry in 3D').fire('click');
  diagnostics.renderDispersionDiagnostics(host, fixture); assert.equal(shown, null); assert.equal(clears, 2);
  button(host, 'Show common geometry in 3D').fire('click');
  controller.dispose(); assert.equal(shown.geometry.geometry_hash, fixture.scene.geometry_hash); assert.equal(clears, 2);
  delete global.displayGeometry; delete global.getDisplayedGeometry; delete global.clearGeometry;
});

test('disposal preserves a different viewer owner and a matching scene this controller never displayed', () => {
  let shown = { geometry: copy(fixture.scene), scale: 1 }, clears = 0;
  global.getDisplayedGeometry = () => shown;
  global.clearGeometry = () => { shown = null; clears++; };
  const neverShown = mount(); neverShown.controller.dispose();
  assert.equal(shown.geometry.geometry_hash, fixture.scene.geometry_hash); assert.equal(clears, 0);
  global.displayGeometry = (geometry, scale) => { shown = { geometry, scale }; };
  const { host, controller } = mount(); button(host, 'Show common geometry in 3D').fire('click');
  shown = { geometry: { geometry_hash: 'sha256:' + '0'.repeat(64) }, scale: 1 };
  controller.dispose(); assert.equal(shown.geometry.geometry_hash, 'sha256:' + '0'.repeat(64)); assert.equal(clears, 0);
  delete global.displayGeometry; delete global.getDisplayedGeometry; delete global.clearGeometry;
});
