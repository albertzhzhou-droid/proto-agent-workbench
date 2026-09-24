/* Read-only views of retained interface samples. No simulation or atomistic trajectory. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ChemInterfaceWorkbench = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const COLORS = ['#47c9b0', '#f3b867', '#93a7ed', '#e889ac', '#74b8db', '#d2dca5'];
  const SVG = 'http://www.w3.org/2000/svg';
  // Current recipes have at most six species; a two-molecule association can
  // contain 240 explicit-H atoms. Imported previews are bounded independently.
  const LIMITS = Object.freeze({ species: 32, atoms: 256, bonds: 1024, reactions: 64, reactionParticipants: 32, layoutIterations: 80 });
  const humanize = value => String(value).replaceAll('_', ' ');
  const exact = value => Number.isFinite(value) ? Object.is(value, -0) ? '-0' : String(value) : 'Unavailable';
  const compact = value => !Number.isFinite(value) ? 'Unavailable' : value === 0 ? '0' :
    Math.abs(value) < 0.001 || Math.abs(value) >= 10000 ? value.toExponential(3) : Number(value.toPrecision(6)).toString();
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

  function prepare(simulation) {
    const raw = Array.isArray(simulation?.series) ? simulation.series : [];
    const rows = raw.map((row, index) => ({ row, index })).filter(item => Number.isFinite(item.row?.time_s));
    const keys = [...new Set(raw.flatMap(row => Object.keys(row || {})))].filter(key => key !== 'time_s' && raw.some(row => Number.isFinite(row?.[key])));
    const mechanism = simulation?.mechanism || simulation?.inputs?.spec?.mechanism || {};
    const units = simulation?.units || {};
    const speciesIssue = !Array.isArray(mechanism.species) ? 'Declared species metadata is unavailable.' : mechanism.species.length > LIMITS.species ? `Species preview limit exceeded (${LIMITS.species} species).` : mechanism.species.some(item => !item || typeof item !== 'object' || typeof item.id !== 'string' || !item.id.length || item.id.length > 128) || new Set(mechanism.species.map(item => item.id)).size !== mechanism.species.length ? 'Species preview has invalid or duplicate identities.' : null;
    const species = speciesIssue ? [] : mechanism.species;
    const rawSteps = mechanism.steps || mechanism.reactions || [];
    const reactionIssue = !Array.isArray(rawSteps) ? 'Declared reaction metadata is unavailable.' : rawSteps.length > LIMITS.reactions ? `Reaction preview limit exceeded (${LIMITS.reactions} steps).` : rawSteps.some(step => !step || typeof step !== 'object' || ['reactants', 'products'].some(side => !step[side] || typeof step[side] !== 'object' || Array.isArray(step[side]) || Object.keys(step[side]).length > LIMITS.reactionParticipants || Object.values(step[side]).some(value => !Number.isSafeInteger(value) || value <= 0 || value > 100))) ? 'Reaction preview has invalid or oversized participant metadata.' : null;
    const steps = reactionIssue ? [] : rawSteps;
    const stateSpecies = simulation?.state_species || mechanism.state_species || {};
    const fields = keys.map(key => ({ key, label: humanize(key), unit: typeof units[key] === 'string' ? units[key] : 'unit unavailable', species: stateSpecies[key] || null }));
    const finite = rows.every(({ row }) => keys.every(key => Number.isFinite(row[key])));
    const increasing = rows.every((item, index) => index === 0 || item.row.time_s > rows[index - 1].row.time_s);
    const timeUnit = typeof units.time_s === 'string' ? units.time_s : 'unit unavailable';
    return { rows, fields, species, speciesIssue, steps, reactionIssue, mechanism, stateSpecies, finite, increasing, timeUnit,
      omittedTimes: raw.length - rows.length, validPlayback: timeUnit === 's' && rows.length > 1 && rows.length <= 201 && finite && increasing && rows.length === raw.length };
  }

  function speciesFields(data, speciesId) {
    const keys = Object.entries(data.stateSpecies).filter(([, id]) => id === speciesId).map(([key]) => key);
    if (speciesId === data.mechanism.vacant_site) keys.push('vacant_fraction');
    if (speciesId === 'hydrogen' && data.fields.some(field => field.key === 'hydrogen_chemostat_exchange_mol_m2')) keys.push('hydrogen_chemostat_exchange_mol_m2');
    return [...new Set(keys)];
  }

  function fractionBins(row, fields, count = 60) {
    const entries = fields.filter(field => field.key.startsWith('theta_')).map(field => ({ ...field, value: Number.isFinite(row[field.key]) ? row[field.key] : null }));
    if (entries.some(item => item.value === null) || !Number.isFinite(row.vacant_fraction)) return null;
    entries.push({ key: 'vacant_fraction', label: 'vacant fraction', value: row.vacant_fraction });
    const sum = entries.reduce((total, item) => total + item.value, 0);
    if (entries.some(item => item.value < -2e-7 || item.value > 1 + 2e-7) || Math.abs(sum - 1) > 2e-7) return null;
    const exactBins = entries.map(item => Math.max(0, item.value) * count);
    const bins = exactBins.map(Math.floor);
    const remainderOrder = exactBins.map((value, index) => ({ index, remainder: value - bins[index] })).sort((a, b) => b.remainder - a.remainder || a.index - b.index);
    const remaining = count - bins.reduce((a, b) => a + b, 0);
    for (let n = 0; n < remaining; n++) bins[remainderOrder[n % entries.length].index]++;
    return entries.map((item, index) => ({ ...item, bins: bins[index] }));
  }

  function csv(simulation) {
    const data = prepare(simulation);
    const columns = ['time_s', ...data.fields.map(field => field.key)];
    const quote = value => '"' + String(value).replaceAll('"', '""') + '"';
    const header = key => {
      const text = `${key} [${simulation.units?.[key] || 'unit unavailable'}]`;
      return quote(/^[=+@\-\t\r]/.test(text) ? "'" + text : text);
    };
    return columns.map(header).join(',') + '\r\n' + (simulation.series || []).map(row => columns.map(key => Number.isFinite(row?.[key]) ? exact(row[key]) : '').join(',')).join('\r\n') + '\r\n';
  }

  function exactJSON(value, level = 0) {
    if (typeof value === 'number') return Number.isFinite(value) ? exact(value) : 'null';
    if (!value || typeof value !== 'object') return JSON.stringify(value);
    const indent = '  '.repeat(level + 1), closing = '  '.repeat(level);
    if (Array.isArray(value)) return value.length ? '[\n' + value.map(item => indent + (exactJSON(item, level + 1) ?? 'null')).join(',\n') + '\n' + closing + ']' : '[]';
    const entries = Object.entries(value).filter(([, item]) => item !== undefined);
    return entries.length ? '{\n' + entries.map(([key, item]) => indent + JSON.stringify(key) + ': ' + exactJSON(item, level + 1)).join(',\n') + '\n' + closing + '}' : '{}';
  }

  function exportDocument(simulation, studyHash, index) {
    return { version: 'interface-view-export/v1', study_record_hash: studyHash || null,
      simulation_result_hash: simulation.result_hash || null, selected_sample_index: index,
      sampling: 'Exact retained samples; no numerical interpolation. Plot segments are visual guides.',
      verification: 'Read-only view export. Use the complete saved study for host-verified reopening.', simulation };
  }

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = String(text);
    return element;
  }
  function svg(tag, attributes = {}, text) {
    const element = document.createElementNS(SVG, tag);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
    if (text !== undefined) element.textContent = String(text);
    return element;
  }
  function button(text, handler, label) {
    const element = node('button', 'iw-button', text); element.type = 'button';
    if (label) element.setAttribute('aria-label', label);
    element.addEventListener('click', handler); return element;
  }
  function detail(title, value) {
    const element = node('details', 'iw-details'); element.append(node('summary', '', title), node('pre', '', JSON.stringify(value, null, 2))); return element;
  }
  function download(filename, contents, type) {
    const link = node('a'); const url = URL.createObjectURL(new Blob([contents], { type }));
    link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function graphIssue(atoms, bonds, requireReferences = true) {
    if (!Array.isArray(atoms) || !Array.isArray(bonds)) return 'Atom and bond arrays are required.';
    if (atoms.length > LIMITS.atoms) return `Graph preview limit exceeded (${LIMITS.atoms} atoms).`;
    if (bonds.length > LIMITS.bonds) return `Graph preview limit exceeded (${LIMITS.bonds} bonds).`;
    const indices = new Set();
    for (const atom of atoms) {
      if (!atom || !Number.isSafeInteger(atom.index) || atom.index < 0 || indices.has(atom.index) || typeof atom.element !== 'string' || !/^[A-Z][a-z]{0,2}$/.test(atom.element)) return 'Graph preview has invalid or duplicate atom identities.';
      indices.add(atom.index);
    }
    for (const bond of bonds) if (!bond || !Number.isSafeInteger(bond.a) || !Number.isSafeInteger(bond.b) || bond.a < 0 || bond.b < 0 || bond.a === bond.b || ![1, 1.5, 2, 3].includes(bond.order) || (requireReferences && (!indices.has(bond.a) || !indices.has(bond.b)))) return 'Graph preview has invalid bond identities or orders.';
    return null;
  }

  function graphPositions(atoms, bonds) {
    const issue = graphIssue(atoms, bonds, false); if (issue) throw new RangeError(issue);
    const positions = atoms.map((atom, index) => ({ id: atom.index, x: 125 + Math.cos(index * 2.39996) * (25 + 7 * Math.sqrt(index)), y: 73 + Math.sin(index * 2.39996) * (25 + 6 * Math.sqrt(index)) }));
    const byId = new Map(positions.map(item => [item.id, item]));
    for (let iteration = 0; iteration < LIMITS.layoutIterations; iteration++) {
      const forces = new Map(positions.map(item => [item.id, { x: (125 - item.x) * 0.005, y: (73 - item.y) * 0.005 }]));
      for (let a = 0; a < positions.length; a++) for (let b = a + 1; b < positions.length; b++) {
        const left = positions[a], right = positions[b], dx = left.x - right.x, dy = left.y - right.y;
        const distance = Math.max(4, Math.hypot(dx, dy)), force = Math.min(5, 180 / distance ** 2);
        forces.get(left.id).x += dx / distance * force; forces.get(left.id).y += dy / distance * force;
        forces.get(right.id).x -= dx / distance * force; forces.get(right.id).y -= dy / distance * force;
      }
      for (const bond of bonds) {
        const left = byId.get(bond.a), right = byId.get(bond.b); if (!left || !right) continue;
        const dx = right.x - left.x, dy = right.y - left.y, distance = Math.max(1, Math.hypot(dx, dy)), force = (distance - 20) * 0.07;
        forces.get(left.id).x += dx / distance * force; forces.get(left.id).y += dy / distance * force;
        forces.get(right.id).x -= dx / distance * force; forces.get(right.id).y -= dy / distance * force;
      }
      for (const point of positions) { point.x += clamp(forces.get(point.id).x, -5, 5); point.y += clamp(forces.get(point.id).y, -5, 5); }
    }
    if (!positions.length) return byId;
    const minX = Math.min(...positions.map(p => p.x)), maxX = Math.max(...positions.map(p => p.x));
    const minY = Math.min(...positions.map(p => p.y)), maxY = Math.max(...positions.map(p => p.y));
    const scale = Math.min(220 / Math.max(20, maxX - minX), 110 / Math.max(20, maxY - minY), 1.6);
    for (const point of positions) { point.x = 125 + (point.x - (minX + maxX) / 2) * scale; point.y = 73 + (point.y - (minY + maxY) / 2) * scale; }
    return byId;
  }

  function speciesGraph(species, hydrogens) {
    const chart = svg('svg', { viewBox: '0 0 250 146', role: 'img', 'aria-label': `${species.formula || species.id}: declared molecular connectivity; layout is schematic` });
    const graph = species.graph || {}, issue = graphIssue(graph.atoms, graph.bonds);
    if (issue) { chart.setAttribute('aria-label', `Graph preview unavailable. ${issue} Full declared graph remains in raw evidence and JSON export.`); chart.append(svg('text', { x: 125, y: 68, 'text-anchor': 'middle', class: 'iw-axis-label' }, 'Graph preview unavailable'), svg('text', { x: 125, y: 91, 'text-anchor': 'middle', class: 'iw-axis-label' }, issue)); return chart; }
    const atoms = graph.atoms.filter(atom => hydrogens || atom.element !== 'H');
    if (!atoms.length) { chart.append(svg('text', { x: 125, y: 88, 'text-anchor': 'middle', class: 'iw-special-species' }, species.special_species === 'electron' ? 'e⁻' : species.special_species === 'site' ? '○' : species.formula || species.id)); return chart; }
    const positions = graphPositions(atoms, graph.bonds || []), colors = { O: '#d45c69', N: '#4676c1', S: '#ad8527', F: '#3c976e', Cl: '#3c976e', H: '#91a99f' };
    for (const bond of graph.bonds || []) {
      const a = positions.get(bond.a), b = positions.get(bond.b); if (!a || !b) continue;
      const count = bond.order === 2 ? 2 : bond.order === 3 ? 3 : 1, distance = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y));
      for (let index = 0; index < count; index++) {
        const offset = (index - (count - 1) / 2) * 3, dx = -(b.y - a.y) / distance * offset, dy = (b.x - a.x) / distance * offset;
        chart.append(svg('line', { x1: a.x + dx, y1: a.y + dy, x2: b.x + dx, y2: b.y + dy, stroke: '#839b91', 'stroke-width': 1.5, ...(bond.order === 1.5 ? { 'stroke-dasharray': '3 2' } : {}) }));
      }
    }
    for (const atom of atoms) {
      const point = positions.get(atom.index), title = svg('title', {}, `Atom ${atom.index}: ${atom.element}; charge ${atom.formal_charge}; radical electrons ${atom.radical_electrons}`);
      const group = svg('g'); group.append(title, svg('circle', { cx: point.x, cy: point.y, r: atom.element === 'H' ? 3 : 6.5, fill: '#f6fbf8', stroke: colors[atom.element] || '#54776a' }));
      if (atom.element !== 'H' || hydrogens) group.append(svg('text', { x: point.x, y: point.y + 3, 'text-anchor': 'middle', class: 'iw-atom-label', fill: colors[atom.element] || '#325b4b' }, atom.element));
      chart.append(group);
    }
    return chart;
  }

  function create(container, simulation, options = {}) {
    const data = prepare(simulation); let index = 0, timer = null, disposed = false, hydrogens = false, saving = false;
    const initial = simulation.profile === 'electrode_electrolyte' ? 'current_density_A_m2' : simulation.profile === 'catalyst_reactant' ? 'concentration_product_pool_mol_m3' : 'theta_adsorbed';
    let selectedKey = data.fields.some(field => field.key === initial) ? initial : data.fields[0]?.key;
    const reduced = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
    const root = node('section', 'interface-workbench'); root.setAttribute('aria-label', 'Interface result workbench');
    container.replaceChildren(root);
    if (!data.rows.length || !data.fields.length) { root.append(node('p', 'design-empty', 'No finite sampled series is available. Inspect the retained evidence record.')); return { dispose() {}, getState: () => ({ index: 0, playing: false }) }; }

    const headline = node('div', 'iw-headline'), title = node('div');
    title.append(node('p', 'eyebrow', 'COMPUTED RESPONSE / EXACT SAMPLES'), node('h4', '', 'A response you can follow.'));
    const status = node('div', 'iw-status-stack');
    status.append(node('span', simulation.success === true ? 'iw-pill' : 'iw-pill iw-warning', simulation.success === true ? 'Numerical solve complete' : 'Incomplete numerical result'), node('span', simulation.balances?.passed === true ? 'iw-pill' : 'iw-pill iw-warning', simulation.balances?.passed === true ? 'Conservation checks passed' : 'Conservation unconfirmed'));
    headline.append(title, status); root.append(headline);
    const qualifier = node('p', 'iw-scope', 'Conditional model response from declared parameters. Playback visits saved samples only; it does not construct an atomistic reaction trajectory or establish experimental yield.'); root.append(qualifier);
    if (!data.validPlayback) root.append(node('p', 'iw-warning iw-scope', 'Playback unavailable: incomplete, nonfinite, unordered or oversized samples, or a time unit other than the expected s. Available values retain their supplied labels; no unit conversion or missing-value replacement is applied.'));

    const layout = node('div', 'iw-response-layout'), response = node('div', 'iw-response'), toolbar = node('div', 'iw-chart-toolbar');
    const variableLabel = node('label', 'iw-field', 'Response variable'), selector = node('select'); selector.setAttribute('aria-label', 'Interface response variable');
    for (const field of data.fields) { const option = node('option', '', `${field.label} · ${field.unit}`); option.value = field.key; selector.append(option); } selector.value = selectedKey; variableLabel.append(selector);
    const exports = node('div', 'iw-export-actions'), exportStatus = node('p', 'iw-export-status'); exportStatus.setAttribute('role', 'status');
    const safeProfile = String(simulation.profile || 'interface').replace(/[^a-z0-9_-]/gi, '_');
    const save = async (format) => {
      if (disposed || saving) return;
      const sampleIndex = data.rows[index].index;
      saving = true; csvButton.disabled = true; jsonButton.disabled = true;
      try {
        if (typeof options.saveExport === 'function') {
          exportStatus.textContent = 'Saving all retained samples to the local workspace.';
          const receipt = await options.saveExport({ reference: options.studyHash, result_hash: simulation.result_hash, format, sample_index: sampleIndex });
          if (disposed) return;
          if (receipt?.reference !== options.studyHash || receipt.result_hash !== simulation.result_hash || receipt.format !== format || receipt.sample_index !== sampleIndex || receipt.row_count !== simulation.series.length || typeof receipt.path !== 'string' || !receipt.path || !/^sha256:[a-f0-9]{64}$/.test(receipt.file_sha256 || '')) throw Error('The saved artifact does not match this interface result.');
          exportStatus.textContent = `Saved locally: ${receipt.path}\nFile SHA-256: ${receipt.file_sha256}\nAll ${receipt.row_count} retained samples; selected sample ${sampleIndex + 1}. Use the complete study for verified reopening.`;
        } else {
          download(`chem-${safeProfile}-samples.${format}`, format === 'csv' ? csv(simulation) : exactJSON(exportDocument(simulation, options.studyHash, sampleIndex)), format === 'csv' ? 'text/csv;charset=utf-8' : 'application/json');
          exportStatus.textContent = `${format.toUpperCase()} download requested for all ${simulation.series.length} retained rows. The full study is required for verified reopening.`;
        }
      } catch (error) { if (!disposed) exportStatus.textContent = 'Export unavailable: ' + error.message; }
      finally { saving = false; if (!disposed) { csvButton.disabled = false; jsonButton.disabled = false; } }
    };
    const csvButton = button('↓ CSV', () => save('csv'), 'Export all interface samples as CSV'), jsonButton = button('↓ JSON', () => save('json'), 'Export interface result and provenance as JSON');
    exports.append(csvButton, jsonButton); toolbar.append(variableLabel, exports); response.append(toolbar);
    const readout = node('div', 'iw-readout'), readoutValue = node('strong'), readoutUnit = node('span'), readoutName = node('span', 'iw-readout-name'); readout.append(readoutName, readoutValue, readoutUnit); response.append(readout);
    const plot = svg('svg', { viewBox: '0 0 620 286', class: 'iw-chart', role: 'img' }); response.append(plot);
    response.append(node('p', 'iw-chart-note', 'Dots are retained solver samples. Connecting segments are visual guides, not additional numerical results.'));
    const controls = node('div', 'iw-player'), play = button('▶ Play samples', toggle), previous = button('←', () => move(index - 1), 'Previous retained sample'), next = button('→', () => move(index + 1), 'Next retained sample'), reset = button('↺ Reset', () => move(0), 'Reset to the first retained sample');
    const speedLabel = node('label', 'iw-speed', 'Display rate'), speed = node('select'); speed.setAttribute('aria-label', 'Playback samples per second');
    for (const value of [1, 2, 4, 8]) { const option = node('option', '', `${value} sample${value === 1 ? '' : 's'}/s`); option.value = String(value); speed.append(option); } speed.value = '4'; speedLabel.append(speed);
    controls.append(previous, play, next, reset, speedLabel); response.append(controls);
    const sliderLabel = node('label', 'iw-timeline', 'Retained time sample'), slider = node('input'); slider.type = 'range'; slider.min = '0'; slider.max = String(data.rows.length - 1); slider.step = '1'; slider.value = '0'; slider.setAttribute('aria-label', 'Retained time sample'); sliderLabel.append(slider);
    const timeline = node('div', 'iw-timeline-caption'), timestamp = node('strong'), sampleCounter = node('span'); timeline.append(timestamp, sampleCounter); response.append(sliderLabel, timeline, node('p', 'iw-chart-note', 'Playback speed controls samples per screen second. It is not physical time scaling. Arrow keys step the focused time slider.'), exportStatus);
    if (reduced?.matches) response.append(node('p', 'iw-chart-note', 'Reduced motion is enabled. Playback starts only when requested; step controls remain available.'));
    layout.append(response); const spatial = node('aside', 'iw-spatial'); layout.append(spatial); root.append(layout);

    spatial.append(node('p', 'eyebrow', 'STATE ENCODING / SPATIAL SCHEMATIC'), node('h4', '', 'At the interface'));
    const scene = svg('svg', { viewBox: '0 0 440 300', class: 'iw-scene', role: 'img' });
    scene.append(svg('polygon', { points: '62,143 279,72 388,137 170,211', fill: '#56cbb51a', stroke: '#79cbb94d' }), svg('polygon', { points: '62,143 170,211 170,247 62,179', fill: '#113d42' }), svg('polygon', { points: '170,211 388,137 388,173 170,247', fill: '#1d5b59' }), svg('polygon', { points: '62,143 279,72 388,137 170,211', fill: '#194c4f', stroke: '#77b8ae' }));
    const siteLayer = svg('g'); scene.append(siteLayer);
    scene.append(svg('polygon', { points: '62,52 279,-19 388,46 170,120', fill: '#68d4bd0c', stroke: '#a2e6d336' }), svg('polygon', { points: '62,52 170,120 170,207 62,140', fill: '#68d4bd0c', stroke: '#a2e6d326' }), svg('polygon', { points: '170,120 388,46 388,135 170,207', fill: '#68d4bd0a', stroke: '#a2e6d326' }));
    scene.append(svg('text', { x: 20, y: 36, class: 'iw-scene-label' }, 'Well-mixed liquid'), svg('text', { x: 235, y: 278, class: 'iw-scene-label' }, 'Declared support sites'));
    spatial.append(scene); const legend = node('div', 'iw-legend'), liquid = node('div', 'iw-liquid-values'); spatial.append(legend, liquid);
    spatial.append(node('p', 'iw-scene-note', '60 glyphs summarize aggregate site occupancy, rounded for display. Their positions, scale and palette are schematic. Colors identify states; they do not predict material color. No surface termination, binding pose, optical response or molecular motion is supplied.'));

    const speciesSection = node('section', 'iw-species-section'), speciesHeader = node('div', 'iw-section-title'), speciesTitle = node('div');
    speciesTitle.append(node('p', 'eyebrow', 'DECLARED SPECIES / MOLECULAR CONNECTIVITY'), node('h4', '', 'Every participant, accounted for.'));
    const hydrogenLabel = node('label', 'iw-checkbox'), hydrogenToggle = node('input'); hydrogenToggle.type = 'checkbox'; hydrogenLabel.append(hydrogenToggle, document.createTextNode('Show explicit hydrogen atoms')); speciesHeader.append(speciesTitle, hydrogenLabel); speciesSection.append(speciesHeader);
    speciesSection.append(node('p', 'iw-chart-note', 'Graphs show the supplied atom and bond identities with a schematic layout. They are not optimized structures or a sequence of reaction frames. Formulae include hydrogen; stereochemical identity remains in canonical SMILES.'));
    if (data.speciesIssue) speciesSection.append(node('p', 'iw-warning iw-scope', `${data.speciesIssue} No partial species preview is shown. Solver samples and full raw graph metadata remain available in the study evidence and JSON export.`));
    const speciesGrid = node('div', 'iw-species-grid'), speciesValues = new Map(), graphHosts = [];
    data.species.forEach((species, speciesIndex) => {
      const card = node('article', 'iw-species-card'); card.id = `iw-species-${speciesIndex}`;
      const cardHead = node('div', 'iw-species-heading'); cardHead.append(node('span', 'iw-species-id', species.id), node('strong', '', species.formula || 'Formula unavailable'));
      const graphHost = node('div', 'iw-graph-host'); graphHost.append(speciesGraph(species, hydrogens)); graphHosts.push({ graphHost, species });
      const currentValues = node('div', 'iw-species-values'); speciesValues.set(species.id, currentValues);
      const properties = node('p', 'iw-graph-metadata', `${species.atom_count ?? 'Unknown'} atoms · charge ${species.formal_charge ?? 'unknown'} · ${species.radical_electrons ?? 'unknown'} radical electrons · ${species.site_count ?? 'unknown'} sites`);
      card.append(cardHead, node('p', 'iw-species-role', species.role || 'Role not supplied'), graphHost, properties, currentValues,
        detail('Identity & graph evidence', { species_hash: species.species_hash, canonical_smiles: species.canonical_smiles, element_counts: species.element_counts, special_species: species.special_species, graph: species.graph })); speciesGrid.append(card);
    }); speciesSection.append(speciesGrid); root.append(speciesSection);
    const network = node('div', 'iw-reaction-network'); network.append(node('h4', '', 'Declared reaction network'));
    const side = values => { const box = node('div', 'iw-reaction-side'); for (const [id, coefficient] of Object.entries(values || {})) { const at = data.species.findIndex(species => species.id === id), species = data.species[at]; const item = button(`${coefficient === 1 ? '' : coefficient + ' × '}${species?.formula || id} · ${id}`, () => { const target = speciesGrid.children[at]; if (target) { target.setAttribute('tabindex', '-1'); target.focus({ preventScroll: true }); target.scrollIntoView({ block: 'nearest', behavior: 'auto' }); } }); box.append(item); } return box; };
    if (data.reactionIssue) network.append(node('p', 'iw-warning iw-scope', `${data.reactionIssue} No partial reaction network is shown. The complete declared mechanism remains in the saved study and JSON export.`));
    for (const step of data.steps) {
      const row = node('article', 'iw-reaction-step'), equation = node('div', 'iw-reaction-equation'); equation.append(side(step.reactants), node('span', 'iw-reaction-arrow', step.reversible ? '⇌' : '→'), side(step.products));
      row.append(node('strong', '', humanize(step.id)), equation, node('p', '', step.rate_assumption || 'No rate assumption supplied')); network.append(row);
    }
    root.append(network);

    const evidence = node('section', 'iw-evidence'); evidence.append(node('h4', '', 'Parameters & numerical evidence'));
    const spec = simulation.inputs?.spec || {}, parameters = node('table', 'iw-parameter-table'), phead = node('thead'), phrow = node('tr');
    for (const label of ['Quantity', 'Value', 'Unit', 'Source']) phrow.append(node('th', '', label)); phead.append(phrow); parameters.append(phead); const pbody = node('tbody');
    for (const [kind, quantities] of [['Parameter', spec.parameters], ['Initial state', spec.initial_conditions]]) for (const [key, quantity] of Object.entries(quantities || {})) {
      const row = node('tr'); row.append(node('th', '', `${kind} · ${humanize(key)}`), node('td', 'iw-exact', exact(quantity?.value)), node('td', '', quantity?.unit || 'Unavailable'), node('td', '', `${quantity?.provenance?.kind || 'Unverified'} · ${quantity?.provenance?.source || 'Source not supplied'}`)); pbody.append(row);
    }
    parameters.append(pbody); const pwrap = node('div', 'iw-table-wrap'); pwrap.append(parameters); evidence.append(pwrap);
    evidence.append(detail('Conservation, solver & model assumptions', { success: simulation.success, parameter_status: simulation.parameter_status, scientifically_calibrated: simulation.scientifically_calibrated, measured_data_claim: simulation.measured_data_claim, balances: simulation.balances, solver: simulation.solver, constants: simulation.constants, assumptions: simulation.assumptions, interpretation: simulation.interpretation, mechanism_status: data.mechanism.mechanism_status, conservation_proofs: data.mechanism.conservation_proofs, chemostats: data.mechanism.chemostats, site_recipe: data.mechanism.site_recipe, mechanism_limitations: data.mechanism.limitations, time_grid: spec.time_grid, sources: simulation.sources }), detail('Input and result bindings', { study_record_hash: options.studyHash, result_hash: simulation.result_hash, input_hash: simulation.input_hash, candidate_hashes: simulation.candidate_hashes, mechanism_hash: data.mechanism.mechanism_hash, imported: options.imported === true, imported_origin: options.imported ? 'Unverified' : 'See saved study evidence' })); root.append(evidence);

    const tableDetails = node('details', 'iw-sample-details'); tableDetails.append(node('summary', '', `Exact sample table · ${data.rows.length} time points · ${data.fields.length} variables`));
    const tableWrap = node('div', 'iw-table-wrap iw-sample-scroll'), table = node('table', 'iw-sample-table'), thead = node('thead'), tr = node('tr');
    tr.append(node('th', '', 'Sample'), node('th', '', `Time [${simulation.units?.time_s || 'unit unavailable'}]`)); for (const field of data.fields) tr.append(node('th', '', `${field.label} [${field.unit}]`)); thead.append(tr); table.append(thead); const tbody = node('tbody');
    const tableRows = data.rows.map((item, rowIndex) => { const row = node('tr'), first = node('th'); first.append(button(String(item.index + 1), () => move(rowIndex), `Inspect retained sample ${item.index + 1}`)); row.append(first, node('td', '', exact(item.row.time_s))); for (const field of data.fields) row.append(node('td', '', exact(item.row[field.key]))); tbody.append(row); return row; }); table.append(tbody); tableWrap.append(table); tableDetails.append(tableWrap); root.append(tableDetails);

    function drawPlot() {
      const field = data.fields.find(item => item.key === selectedKey), finiteRows = data.rows.filter(item => Number.isFinite(item.row[selectedKey])); plot.replaceChildren();
      plot.setAttribute('aria-label', `${field.label} in ${field.unit} against time in ${data.timeUnit}. Selected sample ${index + 1} has value ${exact(data.rows[index].row[selectedKey])} at ${exact(data.rows[index].row.time_s)} ${data.timeUnit}.`);
      if (!finiteRows.length) return;
      const xmin = Math.min(...data.rows.map(item => item.row.time_s)), xmax = Math.max(...data.rows.map(item => item.row.time_s));
      const values = finiteRows.map(item => item.row[selectedKey]), rawMin = Math.min(0, ...values), rawMax = Math.max(0, ...values), padding = (rawMax - rawMin || 1) * 0.08;
      const ymin = rawMin - padding, ymax = rawMax + padding, x = time => 72 + (time - xmin) / (xmax - xmin || 1) * 520, y = value => 242 - (value - ymin) / (ymax - ymin) * 207;
      for (let n = 0; n < 5; n++) { const value = ymin + (ymax - ymin) * n / 4, py = y(value); plot.append(svg('line', { x1: 72, y1: py, x2: 592, y2: py, class: 'iw-grid-line' }), svg('text', { x: 64, y: py + 3, 'text-anchor': 'end', class: 'iw-axis-label' }, compact(value))); }
      for (let n = 0; n < 5; n++) { const value = xmin + (xmax - xmin) * n / 4; plot.append(svg('text', { x: x(value), y: 261, 'text-anchor': 'middle', class: 'iw-axis-label' }, compact(value))); }
      plot.append(svg('text', { x: 592, y: 280, 'text-anchor': 'end', class: 'iw-axis-label' }, `Time / ${data.timeUnit}`));
      // Break the trace across missing values. Never visually bridge a missing result.
      let segment = [], previousIndex = -1; const flush = () => { if (segment.length > 1) plot.append(svg('polyline', { points: segment.join(' '), class: 'iw-series-line' })); segment = []; };
      for (const item of data.rows) { if (item.index !== previousIndex + 1) flush(); if (Number.isFinite(item.row[selectedKey])) segment.push(`${x(item.row.time_s)},${y(item.row[selectedKey])}`); else flush(); previousIndex = item.index; } flush();
      for (const item of finiteRows) { const circle = svg('circle', { cx: x(item.row.time_s), cy: y(item.row[selectedKey]), r: 2.1, class: 'iw-series-dot' }); circle.append(svg('title', {}, `${exact(item.row.time_s)} ${data.timeUnit}: ${exact(item.row[selectedKey])} ${field.unit}`)); plot.append(circle); }
      const row = data.rows[index].row, px = x(row.time_s); plot.append(svg('line', { x1: px, y1: 30, x2: px, y2: 243, class: 'iw-cursor-line' }));
      if (Number.isFinite(row[selectedKey])) plot.append(svg('circle', { cx: px, cy: y(row[selectedKey]), r: 6, class: 'iw-cursor-dot' }));
    }
    function updateScene(row) {
      const occupancy = fractionBins(row, data.fields); siteLayer.replaceChildren(); legend.replaceChildren(); liquid.replaceChildren();
      if (!occupancy) { legend.append(node('p', 'iw-scene-note', 'Occupancy encoding unavailable: finite, conserved fractions are required.')); scene.setAttribute('aria-label', 'Spatial schematic; occupancy data unavailable'); return; }
      const colors = occupancy.flatMap((item, at) => Array(item.bins).fill(item.key === 'vacant_fraction' ? '#526e72' : COLORS[at % COLORS.length]));
      for (let position = 0; position < colors.length; position++) { const column = position % 10, rowIndex = Math.floor(position / 10), x = 79 + column * 20 + rowIndex * 16.2, y = 141 - column * 6.5 + rowIndex * 10; siteLayer.append(svg('ellipse', { cx: x, cy: y + 3, rx: 6.3, ry: 3.2, fill: '#071f2866' }), svg('ellipse', { cx: x, cy: y, rx: 6.3, ry: 3.2, fill: colors[position], stroke: '#d7f7ee35' })); }
      occupancy.forEach((item, at) => { const entry = node('div', 'iw-legend-entry'), dot = node('span', 'iw-color-dot'); dot.style.backgroundColor = item.key === 'vacant_fraction' ? '#526e72' : COLORS[at % COLORS.length]; entry.append(dot, node('span', '', item.species || humanize(item.key)), node('strong', '', `${compact(item.value * 100)}%`)); legend.append(entry); });
      for (const field of data.fields.filter(item => item.key.startsWith('concentration_'))) { const entry = node('div', 'iw-liquid-entry'); entry.append(node('span', '', field.species || field.label), node('strong', '', `${compact(row[field.key])} ${field.unit}`)); liquid.append(entry); }
      scene.setAttribute('aria-label', `Isometric aggregate occupancy schematic at ${exact(row.time_s)} ${data.timeUnit}. ${occupancy.map(item => `${item.label}: ${exact(item.value)} dimensionless`).join('; ')}. Glyph positions and palette are symbolic.`);
    }
    function update() {
      if (disposed) return; const row = data.rows[index].row, field = data.fields.find(item => item.key === selectedKey);
      slider.value = String(index); slider.setAttribute('aria-valuetext', `Sample ${data.rows[index].index + 1}, ${exact(row.time_s)} ${data.timeUnit}`);
      timestamp.textContent = `t = ${exact(row.time_s)} ${data.timeUnit}`; sampleCounter.textContent = `Sample ${data.rows[index].index + 1} / ${simulation.series.length}`;
      readoutName.textContent = field.label; readoutValue.textContent = exact(row[selectedKey]); readoutUnit.textContent = field.unit;
      previous.disabled = index === 0; next.disabled = index === data.rows.length - 1; play.disabled = !data.validPlayback;
      tableRows.forEach((tableRow, at) => { tableRow.dataset.current = String(at === index); tableRow.setAttribute('aria-current', at === index ? 'true' : 'false'); });
      for (const species of data.species) { const box = speciesValues.get(species.id); box.replaceChildren(); const keys = speciesFields(data, species.id);
        for (const key of keys) box.append(node('p', '', `${humanize(key)}: ${exact(row[key])} ${simulation.units?.[key] || 'unit unavailable'}`));
        if (!keys.length) box.append(node('p', '', species.special_species === 'electron' ? 'External electron exchange is accounted for by signed current and charge; no electron concentration is supplied.' : 'No finite-pool concentration is assigned to this species. Inspect declared reservoir accounting.'));
      }
      drawPlot(); updateScene(row);
    }
    function pause() { if (timer !== null) clearTimeout(timer); timer = null; play.textContent = '▶ Play samples'; play.setAttribute('aria-pressed', 'false'); }
    function move(value) { pause(); index = clamp(Math.round(value), 0, data.rows.length - 1); update(); }
    function tick() { if (disposed || !root.isConnected || document.hidden) { pause(); return; } if (index >= data.rows.length - 1) { pause(); return; } index++; update(); if (index >= data.rows.length - 1) pause(); else timer = setTimeout(tick, 1000 / Number(speed.value)); }
    function toggle() { if (timer !== null) { pause(); return; } if (!data.validPlayback || disposed) return; if (index === data.rows.length - 1) index = 0; play.textContent = 'Ⅱ Pause'; play.setAttribute('aria-pressed', 'true'); update(); timer = setTimeout(tick, 1000 / Number(speed.value)); }
    const onVisibility = () => { if (document.hidden) pause(); }, onReduced = () => pause();
    document.addEventListener('visibilitychange', onVisibility); reduced?.addEventListener?.('change', onReduced);
    selector.addEventListener('change', () => { pause(); selectedKey = selector.value; update(); }); slider.addEventListener('input', () => move(Number(slider.value))); speed.addEventListener('change', pause);
    hydrogenToggle.addEventListener('change', () => { hydrogens = hydrogenToggle.checked; for (const { graphHost, species } of graphHosts) graphHost.replaceChildren(speciesGraph(species, hydrogens)); });
    play.setAttribute('aria-pressed', 'false'); update();
    return { dispose() { pause(); disposed = true; document.removeEventListener('visibilitychange', onVisibility); reduced?.removeEventListener?.('change', onReduced); }, pause,
      getState: () => ({ index: data.rows[index].index, selectedKey, playing: timer !== null, disposed }) };
  }
  return { LIMITS, prepare, speciesFields, fractionBins, csv, exactJSON, exportDocument, graphIssue, graphPositions, create };
});
