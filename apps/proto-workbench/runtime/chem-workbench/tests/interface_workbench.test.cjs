/* Rendering-contract checks use retained complex results, with no provider or calculator. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const view = require('../src/chem_workbench/web_assets/interface-workbench.js');
const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/interface-visualization-retained.json'), 'utf8'));

for (const fixture of fixtures) {
  const result = fixture.result;
  test(`${result.profile}: every returned variable retains its supplied unit and exact value`, () => {
    const data = view.prepare(result);
    assert.equal(data.validPlayback, true);
    assert.deepEqual(data.fields.map(field => field.key).sort(), Object.keys(result.series[0]).filter(key => key !== 'time_s').sort());
    assert.equal(data.rows.length, result.series.length);
    for (const field of data.fields) assert.equal(field.unit, result.units[field.key]);
    for (let index = 0; index < data.rows.length; index++) {
      assert.equal(data.rows[index].index, index);
      assert.strictEqual(data.rows[index].row, result.series[index]);
    }
  });
  test(`${result.profile}: CSV round-trips every finite sample without rounding`, () => {
    const rows = view.csv(result).trimEnd().split('\r\n');
    assert.equal(rows.length, result.series.length + 1);
    const keys = ['time_s', ...view.prepare(result).fields.map(field => field.key)];
    for (const [index, values] of rows.slice(1).entries()) {
      const actual = values.split(',').map(Number);
      assert.deepEqual(actual, keys.map(key => result.series[index][key]));
    }
    for (const key of keys) assert.ok(rows[0].includes(`${key} [${result.units[key]}]`));
  });
  test(`${result.profile}: occupancy glyphs preserve a bounded conserved aggregate`, () => {
    const data = view.prepare(result);
    for (const { row } of data.rows) {
      const bins = view.fractionBins(row, data.fields);
      assert.ok(bins);
      assert.equal(bins.reduce((sum, item) => sum + item.bins, 0), 60);
      for (const item of bins) {
        assert.ok(Number.isInteger(item.bins) && item.bins >= 0 && item.bins <= 60);
        assert.ok(Math.abs(item.bins / 60 - row[item.key]) <= 1 / 60 + 2e-7);
        assert.equal(item.value, row[item.key]);
      }
    }
  });
  test(`${result.profile}: species cards cover every declared participant and state mapping`, () => {
    const data = view.prepare(result);
    assert.deepEqual(data.species.map(item => item.id), result.mechanism.species.map(item => item.id));
    for (const [field, id] of Object.entries(result.state_species)) assert.ok(view.speciesFields(data, id).includes(field));
    assert.ok(view.speciesFields(data, result.mechanism.vacant_site).includes('vacant_fraction'));
    const declared = new Set(data.species.map(item => item.id));
    for (const step of data.mechanism.steps) for (const id of [...Object.keys(step.reactants), ...Object.keys(step.products)]) assert.ok(declared.has(id));
  });
  test(`${result.profile}: supplied molecular connectivity has finite deterministic display positions`, () => {
    for (const species of result.mechanism.species) {
      const atoms = species.graph.atoms.filter(atom => atom.element !== 'H');
      const first = view.graphPositions(atoms, species.graph.bonds);
      const second = view.graphPositions(atoms, species.graph.bonds);
      assert.deepEqual([...first], [...second]);
      assert.equal(first.size, atoms.length);
      for (const atom of atoms) {
        const point = first.get(atom.index);
        assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
        assert.ok(point.x >= 15 - 1e-9 && point.x <= 235 + 1e-9 && point.y >= 18 - 1e-9 && point.y <= 128 + 1e-9);
      }
    }
  });
}

test('signed current and reservoir exchange stay signed in inspection and export', () => {
  const electrode = fixtures[0].result;
  assert.ok(electrode.series.some(row => row.current_density_A_m2 < 0));
  assert.ok(view.csv(electrode).includes(String(electrode.series[0].current_density_A_m2)));
  const catalyst = fixtures[1].result;
  assert.deepEqual(view.speciesFields(view.prepare(catalyst), 'hydrogen'), ['hydrogen_chemostat_exchange_mol_m2']);
  assert.notEqual(catalyst.units.theta_product, catalyst.units.concentration_product_pool_mol_m3);
});

test('missing or nonfinite samples disable playback without fabricated values', () => {
  const result = structuredClone(fixtures[0].result);
  delete result.series[1].current_A;
  result.series[2].current_density_A_m2 = Infinity;
  const data = view.prepare(result);
  assert.equal(data.validPlayback, false);
  assert.equal(data.finite, false);
  assert.equal(data.rows[1].row.current_A, undefined);
  const line = view.csv(result).split('\r\n')[2].split(',');
  assert.equal(line[['time_s', ...data.fields.map(field => field.key)].indexOf('current_A')], '');
});

test('invalid time ordering, missing times and oversized grids remain unplayable', () => {
  const reversed = structuredClone(fixtures[0].result); reversed.series.reverse();
  assert.equal(view.prepare(reversed).validPlayback, false);
  const missing = structuredClone(fixtures[0].result); missing.series[0].time_s = null;
  assert.equal(view.prepare(missing).omittedTimes, 1);
  assert.equal(view.prepare(missing).validPlayback, false);
  const oversized = { ...fixtures[0].result, series: Array.from({ length: 202 }, (_, index) => ({ ...fixtures[0].result.series[0], time_s: index })) };
  assert.equal(view.prepare(oversized).validPlayback, false);
});

test('unknown units remain explicitly unavailable rather than inferred', () => {
  const result = structuredClone(fixtures[0].result); delete result.units.current_A;
  assert.equal(view.prepare(result).fields.find(field => field.key === 'current_A').unit, 'unit unavailable');
  assert.ok(view.csv(result).includes('current_A [unit unavailable]'));
});

test('nonphysical occupancy cannot create a plausible-looking state encoding', () => {
  const data = view.prepare(fixtures[0].result);
  assert.equal(view.fractionBins({ theta_reduced: 1.5, vacant_fraction: -0.5 }, data.fields), null);
  assert.equal(view.fractionBins({ theta_reduced: 0.4, vacant_fraction: 0.4 }, data.fields), null);
  assert.equal(view.fractionBins({ theta_reduced: NaN, vacant_fraction: 1 }, data.fields), null);
});

test('view export retains the original result and declares its verification scope', () => {
  const result = fixtures[1].result, before = JSON.stringify(result);
  const exported = view.exportDocument(result, 'sha256:retained-study', 3);
  assert.equal(exported.simulation_result_hash, result.result_hash);
  assert.equal(exported.study_record_hash, 'sha256:retained-study');
  assert.equal(exported.selected_sample_index, 3);
  assert.deepEqual(JSON.parse(JSON.stringify(exported)).simulation, result);
  assert.match(exported.sampling, /no numerical interpolation/);
  assert.match(exported.verification, /complete saved study/);
  assert.equal(JSON.stringify(result), before);
});

test('JSON view export retains signed zero, full finite precision and exact strings', () => {
  const result = fixtures[0].result;
  const exported = view.exportDocument(result, 'sha256:retained-study', 0);
  assert.deepEqual(JSON.parse(view.exactJSON(exported)), exported);
  const special = { value: -0, nested: [1.2345678901234567, '"quoted"\nvalue', null, false] };
  assert.deepEqual(JSON.parse(view.exactJSON(special)), special);
});

test('untrusted CSV headers cannot become spreadsheet formulas', () => {
  const result = { series: [{ time_s: 0, '=1+1': 3 }], units: { time_s: 's', '=1+1': '1' } };
  assert.ok(view.csv(result).startsWith('"time_s [s]","\'=1+1 [1]"'));
});

test('graph counts are rejected before layout inspects oversized array elements', () => {
  const atoms = new Array(view.LIMITS.atoms + 1);
  Object.defineProperty(atoms, 0, { get() { throw Error('Oversized atom array must not be inspected'); } });
  assert.match(view.graphIssue(atoms, []), /256 atoms/);
  assert.throws(() => view.graphPositions(atoms, []), /256 atoms/);
  const bonds = new Array(view.LIMITS.bonds + 1);
  Object.defineProperty(bonds, 0, { get() { throw Error('Oversized bond array must not be inspected'); } });
  assert.match(view.graphIssue([], bonds), /1024 bonds/);
  assert.throws(() => view.graphPositions([], bonds), /1024 bonds/);
  assert.equal(view.LIMITS.layoutIterations, 80);
  assert.ok(Object.isFrozen(view.LIMITS));
});

test('oversized species or reaction metadata does not produce a silently truncated preview', () => {
  const result = structuredClone(fixtures[0].result);
  result.mechanism.species = Array.from({ length: view.LIMITS.species + 1 }, (_, index) => ({ id: 'species-' + index, graph: { atoms: [], bonds: [] } }));
  result.mechanism.steps = Array.from({ length: view.LIMITS.reactions + 1 }, () => ({ reactants: { a: 1 }, products: { b: 1 } }));
  const data = view.prepare(result);
  assert.equal(data.species.length, 0); assert.match(data.speciesIssue, /32 species/);
  assert.equal(data.steps.length, 0); assert.match(data.reactionIssue, /64 steps/);
  assert.equal(data.rows.length, result.series.length);
  assert.equal(data.validPlayback, true, 'Oversized graph metadata does not discard valid solver values');
  const exported = JSON.parse(view.exactJSON(view.exportDocument(result, 'retained', 0)));
  assert.equal(exported.simulation.mechanism.species.length, 33);
  assert.equal(exported.simulation.mechanism.steps.length, 65);
});

test('invalid graph identities fail explicitly instead of receiving invented connectivity', () => {
  assert.match(view.graphIssue([{ index: 0, element: 'C' }, { index: 0, element: 'O' }], []), /duplicate atom/);
  assert.match(view.graphIssue([{ index: 0, element: 'C' }], [{ a: 0, b: 1, order: 1 }]), /invalid bond/);
  assert.match(view.graphIssue([{ index: 0, element: 'C' }, { index: 1, element: 'O' }], [{ a: 0, b: 1, order: Infinity }]), /invalid bond/);
  for (const fixture of fixtures) for (const species of fixture.result.mechanism.species) assert.equal(view.graphIssue(species.graph.atoms, species.graph.bonds), null);
});

test('imported time-unit labels remain explicit and inconsistent units disable playback', () => {
  const result = structuredClone(fixtures[0].result); result.units.time_s = 'ms';
  const data = view.prepare(result);
  assert.equal(data.timeUnit, 'ms'); assert.equal(data.validPlayback, false);
  assert.equal(data.rows[1].row.time_s, result.series[1].time_s, 'The view never invents a unit conversion');
  delete result.units.time_s;
  assert.equal(view.prepare(result).timeUnit, 'unit unavailable');
  assert.equal(view.prepare(result).validPlayback, false);
});
