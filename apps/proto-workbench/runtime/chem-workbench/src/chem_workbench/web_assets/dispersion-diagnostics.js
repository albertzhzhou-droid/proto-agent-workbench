/* A read-only D3(BJ) API comparison part. Receives a host-validated retained record. */
(function (root, factory) {
  const api = factory(root, typeof module === 'object' && module.exports ? require('./geometry-view-model.js') : root.ChemGeometryView);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ChemDispersionDiagnostics = api;
})(typeof globalThis === 'object' ? globalThis : this, function (root, geometryModel) {
  'use strict';
  const mounted = new WeakMap();
  const decimal = value => typeof value === 'string' && value.length <= 120 && /^(?:0|-?(?:[1-9]\d*(?:\.\d*[1-9])?|0\.\d*[1-9]))$/.test(value) && Number.isFinite(Number(value));
  const vector = value => Array.isArray(value) && value.length === 3 && value.every(decimal);
  const hash = value => typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
  const failUnless = (condition, message) => { if (!condition) throw Error(message); };
  const reference = value => value && typeof value.path === 'string' && value.path.length > 0 && typeof value.sha256 === 'string' && /^[0-9a-f]{64}$/.test(value.sha256);
  const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  const metricLabels = {
    absolute_energy_difference_hartree: 'Absolute energy difference / hartree',
    maximum_gradient_difference_hartree_per_bohr: 'Maximum gradient difference / hartree bohr⁻¹',
    maximum_bridge_matrix_result_difference_hartree_per_bohr: 'Bridge matrix / raw result difference / hartree bohr⁻¹'
  };
  function prepare(value) {
    failUnless(value?.version === 'dispersion-diagnostics-view/v1' && value.quantity === 'two_body_d3bj_dispersion' && value.status === 'passed', 'A retained D3(BJ) dispersion comparison is required.');
    failUnless(hash(value.view_hash) && hash(value.input_hash) && hash(value.spec_hash) && reference(value.receipt_ref) && Array.isArray(value.source_refs) && value.source_refs.length > 0 && value.source_refs.every(reference), 'Retained input and source references are required.');
    const scope = value.scope;
    failUnless(scope && ['accepted_science', 'full_dft_gradient', 'geometry_optimization', 'minimum_certification', 'scientific_accuracy_validation', 'synthetic_data', 'worker_record', 'total_dft_energy', 'physical_trajectory'].every(key => scope[key] === false) && scope.physical_time_s === null && scope.electronic_energy_evaluations === 0 && scope.electronic_gradient_evaluations === 0 && value.electronic_energy_evaluations === 0 && value.electronic_gradient_evaluations === 0, 'Unsupported scientific scope or physical-time claim.');
    failUnless(value.counts?.dispersion_library_calls_attempted === 2 && value.counts.dispersion_library_calls_completed === 2 && value.counts.outer_qcengine_calls_forwarded === 1 && value.counts.inner_qcschema_calls_forwarded === 1 && value.counts.blocked_electronic_dispatches === 0, 'Expected one bridge path and one direct library call.');
    failUnless(value.receipt_checks && Object.keys(value.receipt_checks).length > 0 && Object.values(value.receipt_checks).every(check => check === true), 'Receipt has a missing or failed diagnostic check.');
    failUnless(value.method?.functional === 'wb97x-d3bj' && value.method.engine === 's-dftd3' && value.method.level === 'd3bj2b' &&
      value.method.parameters && ['s6', 's8', 'a1', 'a2', 's9'].every(key => decimal(value.method.parameters[key])) && value.method.parameters.s9 === '0' && typeof value.method.cutoffs === 'string', 'Explicit two-body D3(BJ) method parameters are required.');
    failUnless(value.timing && decimal(value.timing.wall_seconds) && Number(value.timing.wall_seconds) >= 0 && value.timing.physical_time_s === null, 'Only computation wall time is recorded.');
    failUnless(Number.isSafeInteger(value.atom_count) && value.atom_count > 0 && value.atom_count <= 256 && Array.isArray(value.atoms) && value.atoms.length === value.atom_count, 'Invalid common atom inventory.');
    const ids = new Set();
    for (const atom of value.atoms) {
      failUnless(atom && typeof atom.id === 'string' && /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(atom.id) && !ids.has(atom.id) && /^[A-Z][a-z]?$/.test(atom.element) && vector(atom.position_bohr), 'Invalid or duplicate common atom identity or Bohr position.'); ids.add(atom.id);
    }
    for (const name of ['bridge', 'native']) {
      const result = value[name];
      failUnless(result && decimal(result.energy_hartree) && Array.isArray(result.gradient_hartree_per_bohr) && result.gradient_hartree_per_bohr.length === value.atom_count && result.gradient_hartree_per_bohr.every(vector), 'Both paths require finite exact dispersion energies and complete gradients.');
    }
    const metrics = value.metrics;
    failUnless(metrics && Object.keys(metricLabels).every(key => decimal(metrics[key]) && Number(metrics[key]) >= 0) && metrics.bridge_energy_hartree === value.bridge.energy_hartree && metrics.native_energy_hartree === value.native.energy_hartree && vector(metrics.bridge_sum_force_hartree_per_bohr) && vector(metrics.native_sum_force_hartree_per_bohr), 'Comparison metrics do not bind the two results.');
    if (metrics.absolute_energy_difference_hartree === '0') failUnless(value.bridge.energy_hartree === value.native.energy_hartree, 'A zero energy difference requires identical recorded decimal values.');
    if (metrics.maximum_gradient_difference_hartree_per_bohr === '0') failUnless(same(value.bridge.gradient_hartree_per_bohr, value.native.gradient_hartree_per_bohr), 'A zero gradient difference requires identical recorded components.');
    failUnless(value.tolerances && decimal(value.tolerances.energy_hartree) && decimal(value.tolerances.gradient_hartree_per_bohr) && typeof value.tolerances.scope === 'string', 'Recorded API comparison tolerances are required.');
    failUnless(Number(metrics.absolute_energy_difference_hartree) <= Number(value.tolerances.energy_hartree) && Number(metrics.maximum_gradient_difference_hartree_per_bohr) <= Number(value.tolerances.gradient_hartree_per_bohr), 'Passed comparison exceeds its declared API tolerance.');
    const scene = value.scene;
    geometryModel.validate(scene, 1);
    failUnless(scene.provenance === 'evaluated_geometry' && hash(scene.geometry_hash) && scene.input_record_hash === value.input_hash && scene.display_source?.input_hash === value.input_hash && scene.display_source.coordinate_units === 'bohr' && scene.display_source.angstrom_to_bohr === '1.8897261254578281' && scene.atoms.length === value.atom_count && scene.bonds.length === 0 && scene.cell === null && scene.coordinate_table === undefined && scene.refinement_binding === undefined, 'The shared view must be the common dispersion input projection.');
    value.atoms.forEach((atom, index) => failUnless(scene.atoms[index].id === atom.id && scene.atoms[index].element === atom.element && atom.position_bohr.every((component, axis) => scene.atoms[index].position[axis] === Number(component) / Number(scene.display_source.angstrom_to_bohr)), 'The 3D projection changed a common input coordinate or atom identity.'));
    // Display consistency only: host code verifies the exact source bytes and record hash.
    return structuredClone(value);
  }
  function coordinateCSV(value) {
    const view = prepare(value);
    const quote = value => '"' + String(value).replaceAll('"', '""') + '"';
    const text = value => quote(/^[\s]*[=+@\-]|^[\t\r\n]/u.test(value) ? "'" + value : value);
    const header = ['input_hash', 'atom_id', 'element', 'x_bohr', 'y_bohr', 'z_bohr', 'bridge_gradient_x_Eh_per_bohr', 'bridge_gradient_y_Eh_per_bohr', 'bridge_gradient_z_Eh_per_bohr', 'native_gradient_x_Eh_per_bohr', 'native_gradient_y_Eh_per_bohr', 'native_gradient_z_Eh_per_bohr'];
    return [header.map(quote).join(','), ...view.atoms.map((atom, index) => [text(view.input_hash), text(atom.id), text(atom.element), ...atom.position_bohr.map(quote), ...view.bridge.gradient_hartree_per_bohr[index].map(quote), ...view.native.gradient_hartree_per_bohr[index].map(quote)].join(','))].join('\r\n') + '\r\n';
  }
  function node(tag, text, className) {
    const item = root.document.createElement(tag); if (text !== undefined) item.textContent = String(text); if (className) item.className = className; return item;
  }
  function detail(title, value) { const item = node('details'); item.append(node('summary', title), node('pre', JSON.stringify(value, null, 2))); return item; }
  function metric(label, value, unit) { const item = node('div', undefined, 'dd-metric'); item.append(node('dt', label), node('dd', value), node('span', unit)); return item; }
  function download(filename, text, type) {
    const link = node('a'), url = root.URL.createObjectURL(new Blob([text], { type })); link.href = url; link.download = filename; link.click(); root.setTimeout(() => root.URL.revokeObjectURL(url), 1000);
  }
  function table(headers, rows, caption) {
    const wrap = node('div', undefined, 'dd-table-wrap'), table = node('table'), head = node('thead'), header = node('tr'), body = node('tbody');
    for (const label of headers) { const cell = node('th', label); cell.setAttribute('scope', 'col'); header.append(cell); } head.append(header);
    for (const values of rows) { const row = node('tr'); for (const value of values) { const cell = node('td'); if (Array.isArray(value)) for (const [index, part] of value.entries()) cell.append(node('code', `${['x', 'y', 'z'][index]}: ${part}`)); else cell.textContent = String(value); row.append(cell); } body.append(row); }
    table.append(node('caption', caption), head, body); wrap.append(table); return wrap;
  }
  function renderDispersionDiagnostics(host, supplied) {
    mounted.get(host)?.dispose(); host.replaceChildren(); let view;
    try { view = prepare(supplied); } catch (error) { const alert = node('p', 'Dispersion comparison unavailable: ' + error.message); alert.setAttribute('role', 'alert'); host.append(alert); throw error; }
    let disposed = false, ownedSceneDisplayed = false, mode = 'coordinates';
    const panel = node('section', undefined, 'dispersion-diagnostics'), heading = node('div', undefined, 'dd-heading'), title = node('div');
    title.append(node('p', 'RETAINED NATIVE API COMPARISON', 'dd-eyebrow'), node('h2', 'D3(BJ) dispersion contribution')); heading.append(title, node('span', 'API comparison passed', 'dd-status'));
    const metrics = node('dl', undefined, 'dd-metrics'); metrics.append(metric('Psi4 / QCEngine bridge', view.bridge.energy_hartree, 'dispersion energy / hartree'), metric('Direct s-dftd3 library', view.native.energy_hartree, 'dispersion energy / hartree'));
    panel.append(heading, node('p', `${view.atom_count} common atoms · One retained input · Two actual dispersion calls.`, 'dd-lede'), metrics,
      node('p', 'These values are the two-body D3(BJ) dispersion contribution. No total DFT energy, full electronic gradient, optimized geometry or physical-time trajectory is provided.', 'dd-scope'),
      table(['Comparison metric', 'Recorded value'], Object.entries(metricLabels).map(([key, label]) => [label, view.metrics[key]]), 'Agreement on this one shared input'),
      node('p', `Recorded API tolerances: energy ${view.tolerances.energy_hartree} hartree; gradient ${view.tolerances.gradient_hartree_per_bohr} hartree/bohr. These are serialization/API comparison limits, not chemical accuracy estimates.`, 'dd-note'));
    const actions = node('div', undefined, 'dd-actions'), show = node('button', 'Show common geometry in 3D', 'dd-primary'), csv = node('button', 'Export exact coordinates and gradients'), json = node('button', 'Export diagnostic view');
    for (const item of [show, csv, json]) item.type = 'button'; actions.append(show, csv, json); panel.append(actions);
    const notice = node('p', undefined, 'dd-notice'); notice.setAttribute('role', 'status'); panel.append(notice,
      node('p', 'The table retains the native Bohr input values. The shared 3D viewport converts them to Å for display; its colors and sphere sizes are visual conventions. No bonds or atom motion are inferred.', 'dd-note'));
    const tabs = node('div', undefined, 'dd-table-controls'), coordinates = node('button', 'Raw coordinates / bohr'), gradients = node('button', 'Dispersion gradients / hartree bohr⁻¹'), data = node('div');
    for (const item of [coordinates, gradients]) item.type = 'button'; tabs.append(coordinates, gradients); panel.append(tabs, data,
      node('p', `Diagnostic computation wall time: ${view.timing.wall_seconds} s. Physical time is not recorded.`, 'dd-note'),
      detail('Method, parameters and comparison tolerances', { method: view.method, tolerances: view.tolerances, metrics: view.metrics }),
      detail('Retained source provenance', { input_hash: view.input_hash, spec_hash: view.spec_hash, view_hash: view.view_hash, receipt_ref: view.receipt_ref, source_refs: view.source_refs, receipt_checks: view.receipt_checks, counts: view.counts, scope: view.scope }));
    host.append(panel);
    function renderTable() {
      coordinates.setAttribute('aria-pressed', mode === 'coordinates'); gradients.setAttribute('aria-pressed', mode === 'gradients');
      data.replaceChildren(mode === 'coordinates' ? table(['Atom ID', 'Element', 'x / bohr', 'y / bohr', 'z / bohr'], view.atoms.map(atom => [atom.id, atom.element, ...atom.position_bohr]), 'Exact common native input coordinates') :
        table(['Atom ID', 'Element', 'Bridge Cartesian gradient / hartree bohr⁻¹', 'Native Cartesian gradient / hartree bohr⁻¹'], view.atoms.map((atom, index) => [atom.id, atom.element, view.bridge.gradient_hartree_per_bohr[index], view.native.gradient_hartree_per_bohr[index]]), 'Exact recorded dispersion-only gradient components'));
    }
    coordinates.addEventListener('click', () => { if (!disposed) { mode = 'coordinates'; renderTable(); } });
    gradients.addEventListener('click', () => { if (!disposed) { mode = 'gradients'; renderTable(); } });
    show.addEventListener('click', () => {
      if (disposed) return;
      try { failUnless(typeof root.displayGeometry === 'function', 'Shared 3D viewport unavailable.'); root.displayGeometry(structuredClone(view.scene), 1); failUnless(root.getDisplayedGeometry?.()?.geometry.geometry_hash === view.scene.geometry_hash, 'Shared viewport did not display the bound input.'); ownedSceneDisplayed = true; notice.textContent = 'Common dispersion input displayed in 3D. Exact native Bohr coordinates remain in this table.'; }
      catch (error) { notice.textContent = '3D unavailable: ' + error.message; }
    });
    csv.addEventListener('click', () => { if (!disposed) download('d3bj-dispersion-exact.csv', coordinateCSV(view), 'text/csv'); });
    json.addEventListener('click', () => { if (!disposed) download('d3bj-dispersion-view.json', JSON.stringify(view, null, 2) + '\n', 'application/json'); });
    const controller = { dispose() {
      if (disposed) return; disposed = true;
      if (mounted.get(host) === controller) {
        mounted.delete(host); host.replaceChildren();
        if (ownedSceneDisplayed && root.getDisplayedGeometry?.()?.geometry.geometry_hash === view.scene.geometry_hash && typeof root.clearGeometry === 'function') root.clearGeometry('Dispersion comparison closed. Choose a retained geometry to display.');
      }
    } };
    mounted.set(host, controller); renderTable(); return controller;
  }
  return { prepare, coordinateCSV, renderDispersionDiagnostics };
});
