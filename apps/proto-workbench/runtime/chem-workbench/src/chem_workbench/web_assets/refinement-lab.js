/* Server-validated refinement views and an explicitly approved host workflow. */
(function (root, factory) {
  const api = factory(root, typeof module === 'object' && module.exports ? require('./geometry-view-model.js') : root.ChemGeometryView);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ChemRefinementLab = api;
})(typeof globalThis === 'object' ? globalThis : this, function (root, geometryModel) {
  'use strict';
  const mounted = new WeakMap(), SVG = 'http://www.w3.org/2000/svg';
  const decimal = value => typeof value === 'string' && /^(?:0|-?(?:[1-9]\d*(?:\.\d*[1-9])?|0\.\d*[1-9]))$/.test(value) && Number.isFinite(Number(value));
  const vector = value => Array.isArray(value) && value.length === 3 && value.every(decimal);
  const hash = value => typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
  const human = value => value === null ? 'Unknown' : String(value).replaceAll('_', ' ');
  const originLabels = { worker_record: 'Worker-recorded evidence', synthetic_validation: 'Synthetic validation', imported_unverified: 'Unverified imported evidence' };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  function requireValue(condition, message) { if (!condition) throw Error(message); }

  const responseTexts = new WeakMap();
  const workflowKeys = new Set(['version', 'reference', 'selection', 'source', 'source_hash', 'attachments', 'orchestration_ref', 'resolved_plan_hash', 'state', 'plan', 'job', 'result', 'refinement_view', 'failure']);
  const privateKeys = new Set(['approvaltoken', 'token', 'accesstoken', 'refreshtoken', 'bearertoken', 'authorization', 'authorizationheader', 'password', 'secret', 'apikey', 'runnonce', 'launchnonce']);
  function parseWorkflowResponse(text) {
    requireValue(typeof text === 'string' && text.length <= 20 * 1024 ** 2 && new root.TextEncoder().encode(text).byteLength <= 20 * 1024 ** 2, 'Refinement response exceeds its export size limit.');
    const value = JSON.parse(text);
    requireValue(value?.version === 'refinement-workflow/v1' && Object.keys(value).every(key => workflowKeys.has(key)), 'An expected safe refinement workflow response is required.');
    // JSON.parse checks syntax but discards duplicate members. Inspect original
    // tokens before retaining bytes; decoded key checks also cover escaped keys.
    let at = 0;
    const whitespace = () => { while (at < text.length && /[\t\n\r ]/.test(text[at])) at++; };
    function stringToken() {
      const start = at++;
      while (at < text.length) {
        const character = text[at++];
        if (character === '\\') at++;
        else if (character === '"') return text.slice(start, at);
      }
      throw Error('Invalid refinement JSON string.');
    }
    function walk(depth) {
      requireValue(depth <= 128, 'Refinement response exceeds its nesting limit.');
      whitespace();
      if (text[at] === '{') {
        at++; whitespace(); const keys = new Set();
        if (text[at] === '}') { at++; return; }
        for (;;) {
          whitespace(); const key = JSON.parse(stringToken());
          requireValue(!keys.has(key), 'Duplicate JSON key in refinement response.');
          requireValue(!privateKeys.has(key.replace(/[^a-z0-9]/gi, '').toLowerCase()), 'Authorization fields are not permitted in refinement evidence.');
          keys.add(key); whitespace(); at++; walk(depth + 1); whitespace();
          if (text[at++] === '}') return;
        }
      }
      if (text[at] === '[') {
        at++; whitespace();
        if (text[at] === ']') { at++; return; }
        for (;;) { walk(depth + 1); whitespace(); if (text[at++] === ']') return; }
      }
      if (text[at] === '"') { stringToken(); return; }
      const start = at;
      while (at < text.length && !/[\t\n\r ,\]}]/.test(text[at])) at++;
      const token = text.slice(start, at);
      requireValue(['true', 'false', 'null'].includes(token) || Number.isFinite(Number(token)), 'Nonfinite refinement JSON number.');
    }
    walk(0);
    function freeze(item) {
      if (item && typeof item === 'object') { for (const child of Object.values(item)) freeze(child); Object.freeze(item); }
    }
    freeze(value); responseTexts.set(value, text); return value;
  }
  function downloadEvidence(text) {
    requireValue(root.document?.body && typeof root.Blob === 'function' && typeof root.URL?.createObjectURL === 'function' && typeof root.URL.revokeObjectURL === 'function', 'This browser cannot download retained refinement evidence.');
    const blob = new root.Blob([text], { type: 'application/json;charset=utf-8' });
    const url = root.URL.createObjectURL(blob);
    let requested = false, link = null;
    try {
      link = root.document.createElement('a');
      requireValue(typeof link.click === 'function', 'The browser download action is unavailable.');
      link.href = url; link.download = 'workbench.refinement-evidence.json'; link.hidden = true;
      root.document.body.append(link); link.click(); requested = true;
    } finally {
      try { link?.remove(); }
      finally {
        if (requested) root.setTimeout(() => root.URL.revokeObjectURL(url), 30000);
        else root.URL.revokeObjectURL(url);
      }
    }
  }

  function coordinateRows(geometry, scale = 1) {
    const rows = geometryModel.rows(geometry, scale);
    if (geometry.coordinate_table === undefined) return rows;
    const table = geometry.coordinate_table;
    requireValue(geometry.projection?.kind === 'binary64_rendering_only' && geometry.projection.display_scale === 1 &&
      Array.isArray(table) && table.length === rows.length, 'Exact coordinate table requires its rendering projection.');
    const ids = new Set();
    return rows.map((row, index) => {
      const exact = table[index];
      requireValue(exact?.index === index && exact.id === row.id && !ids.has(row.id) && exact.element === row.element &&
        vector(exact.position_angstrom) && vector(exact.gradient_hartree_per_bohr) &&
        exact.position_angstrom.every((value, axis) => Number(value) === row.position[axis]),
      'Exact coordinate table does not match the rendered atom identity and projection.');
      ids.add(row.id);
      return { ...row, position: [...exact.position_angstrom], gradient: [...exact.gradient_hartree_per_bohr] };
    });
  }
  function coordinateCSV(geometry, scale = 1) {
    if (geometry.coordinate_table === undefined) return geometryModel.csv(geometry, scale);
    const quote = value => '"' + String(value ?? '').replaceAll('"', '""') + '"';
    const text = value => quote(/^[\s]*[=+@\-]|^[\t\r\n]/u.test(String(value ?? '')) ? "'" + value : value);
    const header = ['atom_id', 'element', 'base_x_A', 'base_y_A', 'base_z_A', 'display_x_A', 'display_y_A', 'display_z_A', 'gradient_x_Eh_per_bohr', 'gradient_y_Eh_per_bohr', 'gradient_z_Eh_per_bohr', 'oxidation_state', 'sublattice'];
    return [header.map(quote).join(','), ...coordinateRows(geometry, scale).map(row =>
      [text(row.id), text(row.element), ...row.position.map(quote), ...row.displayed_position.map(value => quote(geometryModel.numericText(value))),
        ...row.gradient.map(quote), text(row.oxidation_state), text(row.sublattice)].join(','))].join('\r\n') + '\r\n';
  }

  function prepare(view) {
    requireValue(view?.version === 'molecular-refinement-view/v1' && hash(view.view_hash) && hash(view.spec_hash) && hash(view.result_hash), 'A versioned, server-validated refinement view is required.');
    requireValue(['worker_record', 'synthetic_validation', 'imported_unverified'].includes(view.evidence_origin), 'Unknown refinement evidence origin.');
    requireValue(['succeeded', 'incomplete', 'failed', 'cancelled', 'resource_limit'].includes(view.state) &&
      ['satisfied', 'not_satisfied', 'not_checked'].includes(view.convergence?.geometry_status) && view.convergence.minimum_status === 'not_evaluated' &&
      [true, false, null].includes(view.convergence.optimizer_reported_converged), 'Unsupported refinement state or convergence record.');
    requireValue(view.execution_authority === false && view.scope?.minimum_certified === false && view.scope.physical_trajectory === false &&
      view.scope.material_appearance_predicted === false && view.scope.scientific_accuracy_inferred === false, 'Unsupported scientific or execution claim.');
    requireValue(view.timing?.clock === 'wall' && decimal(view.timing.elapsed_seconds) && Number(view.timing.elapsed_seconds) >= 0 && view.timing.physical_duration_seconds === null &&
      view.playback?.clock === 'evaluation_index' && view.playback.mode === 'discrete_frames_only' && view.playback.interpolation === null && view.playback.physical_duration_seconds === null,
    'Only discrete evaluations and computation wall time are supported.');
    const frames = view.frames, chart = view.trajectory_chart;
    requireValue(Array.isArray(frames) && frames.length <= 4000 && chart?.interpolation === null && chart.physical_time_s === null &&
      Array.isArray(chart.points) && chart.points.length === frames.length && view.playback.sample_count === frames.length, 'Invalid retained evaluation inventory.');
    let previousWall = 0;
    for (const [index, frame] of frames.entries()) {
      const point = chart.points[index], scene = frame.scene;
      requireValue(frame.evaluation_index === index && (frame.optimizer_iteration === null || Number.isSafeInteger(frame.optimizer_iteration) && frame.optimizer_iteration >= 0) &&
        ['initial', 'accepted', 'rejected', 'unknown', 'reevaluation'].includes(frame.step_status) && frame.physical_time_s === null &&
        decimal(frame.elapsed_wall_seconds) && Number(frame.elapsed_wall_seconds) >= previousWall && Number(frame.elapsed_wall_seconds) <= Number(view.timing.elapsed_seconds) && decimal(frame.energy_hartree), 'Invalid evaluation order, clock or energy.');
      previousWall = Number(frame.elapsed_wall_seconds);
      requireValue(hash(frame.frame_hash) && hash(frame.evaluated_geometry_hash) && frame.spec_hash === view.spec_hash && frame.result_hash === view.result_hash &&
        frame.source_hash === view.source_binding?.source_hash && frame.atom_identity_hash === view.source_binding.atom_identity_hash &&
        scene?.provenance === 'evaluated_geometry' && scene.evidence_origin === view.evidence_origin && scene.refinement_binding?.frame_hash === frame.frame_hash &&
        scene.refinement_binding.spec_hash === view.spec_hash && scene.refinement_binding.result_hash === view.result_hash &&
        scene.refinement_binding.raw_input_artifact_id === frame.raw_input_artifact_id && scene.refinement_binding.raw_result_artifact_id === frame.raw_result_artifact_id &&
        typeof frame.raw_input_artifact_id === 'string' && typeof frame.raw_result_artifact_id === 'string', 'Evaluation provenance does not match its view.');
      coordinateRows(scene);
      requireValue(same(frame.coordinate_table, scene.coordinate_table) && frame.gradient_summary?.units === 'hartree/bohr' &&
        decimal(frame.gradient_summary.maximum_absolute_component) && decimal(frame.gradient_summary.rms_component), 'Exact evaluation table or gradient summary is invalid.');
      requireValue(point?.evaluation_index === index && point.frame_hash === frame.frame_hash && point.optimizer_iteration === frame.optimizer_iteration &&
        point.step_status === frame.step_status && point.energy_hartree === frame.energy_hartree && point.elapsed_wall_seconds === frame.elapsed_wall_seconds && point.physical_time_s === null &&
        point.plot_projection?.energy_hartree === Number(frame.energy_hartree) && point.plot_projection.elapsed_wall_seconds === Number(frame.elapsed_wall_seconds), 'Chart projection does not match its evaluated frame.');
    }
    requireValue(view.final_frame_hash === (frames.length ? frames[frames.length - 1].frame_hash : null), 'Final evaluated-frame binding is invalid.');
    if (['failed', 'cancelled', 'resource_limit'].includes(view.state)) requireValue(view.failure && typeof view.failure.message === 'string' && view.failure.last_evaluated_frame_hash === view.final_frame_hash, 'Terminal failure evidence is required.');
    if (view.state === 'succeeded') requireValue(frames.length > 0 && view.failure === null && view.convergence.geometry_status === 'satisfied' && view.convergence.optimizer_reported_converged === true, 'Successful state requires recorded convergence.');
    // The host verifies scientific records and content hashes. JS only checks display consistency.
    return structuredClone(view);
  }

  function node(tag, text, className) {
    const element = root.document.createElement(tag);
    if (text !== undefined) element.textContent = String(text);
    if (className) element.className = className;
    return element;
  }
  function svg(tag, attributes, text) {
    const element = root.document.createElementNS(SVG, tag);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
    if (text !== undefined) element.textContent = String(text);
    return element;
  }
  function detail(label, value) {
    const item = node('details', undefined, 'rl-detail'); item.append(node('summary', label), node('pre', JSON.stringify(value, null, 2))); return item;
  }
  function metric(label, value) {
    const item = node('div', undefined, 'rl-metric'); item.append(node('dt', label), node('dd', value)); return item;
  }
  function table(headers, values, caption) {
    const result = node('table'), head = node('thead'), row = node('tr'), body = node('tbody');
    for (const label of headers) { const cell = node('th', label); cell.setAttribute('scope', 'col'); row.append(cell); }
    head.append(row);
    for (const valuesRow of values) { const tr = node('tr'); for (const value of valuesRow) tr.append(node('td', value)); body.append(tr); }
    result.append(node('caption', caption), head, body); return result;
  }
  function energyChart(view, axis, selected, choose) {
    const chart = svg('svg', { viewBox: '0 0 660 260', role: 'group', 'aria-label': 'Discrete recorded electronic energies. Use the evaluation selector or focus a point to select a frame.' });
    chart.append(svg('text', { x: 60, y: 20, fill: 'currentColor' }, 'Recorded electronic energy / hartree'));
    const points = view.trajectory_chart.points;
    if (!points.length) { chart.append(svg('text', { x: 60, y: 100, fill: 'currentColor' }, 'No evaluated energies.')); return chart; }
    const xs = points.map(point => axis === 'evaluation_index' ? point.evaluation_index : point.plot_projection.elapsed_wall_seconds), ys = points.map(point => point.plot_projection.energy_hartree);
    const xmin = Math.min(...xs), xmax = Math.max(...xs), ymin = Math.min(...ys), ymax = Math.max(...ys);
    const x = value => xmin === xmax ? 345 : 100 + (value - xmin) / (xmax - xmin) * 490;
    const y = value => ymin === ymax ? 123 : 205 - (value - ymin) / (ymax - ymin) * 155;
    chart.append(svg('line', { x1: 100, x2: 590, y1: 205, y2: 205, stroke: 'currentColor' }),
      svg('text', { x: 100, y: 226, fill: 'currentColor' }, xmin), svg('text', { x: 590, y: 226, 'text-anchor': 'end', fill: 'currentColor' }, xmax),
      svg('text', { x: 345, y: 250, 'text-anchor': 'middle', fill: 'currentColor' }, axis === 'evaluation_index' ? 'Gradient evaluation index' : 'Elapsed computation wall time / s'),
      svg('text', { x: 10, y: 48, fill: 'currentColor' }, ymax), svg('text', { x: 10, y: 202, fill: 'currentColor' }, ymin));
    points.forEach((point, index) => {
      const mark = svg('circle', { cx: x(xs[index]), cy: y(ys[index]), r: index === selected ? 7 : 5, fill: index === selected ? '#087f73' : '#657e9e', stroke: 'currentColor', tabindex: 0, role: 'button', 'aria-pressed': index === selected,
        'aria-label': `Evaluation ${index}, ${human(point.step_status)}, energy ${point.energy_hartree} hartree, wall time ${point.elapsed_wall_seconds} seconds` });
      mark.append(svg('title', {}, `Evaluation ${index} · ${point.energy_hartree} hartree · ${point.elapsed_wall_seconds} s wall time`));
      mark.addEventListener('click', () => choose(index)); mark.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(index); } }); chart.append(mark);
    });
    return chart;
  }

  function renderRefinementView(host, supplied) {
    mounted.get(host)?.dispose(); host.replaceChildren();
    let view;
    try { view = prepare(supplied); }
    catch (error) { const message = node('p', 'Refinement view unavailable: ' + error.message); message.setAttribute('role', 'alert'); host.append(message); throw error; }
    let disposed = false, ownedScene = null, selected = view.frames.length ? view.frames.length - 1 : null, axis = 'evaluation_index';
    const panel = node('section', undefined, 'refinement-lab-panel'), content = node('div', undefined, 'rl-body'); panel.setAttribute('data-state', view.state); panel.append(content); host.append(panel);
    const heading = node('div', undefined, 'rl-heading'), identity = node('div'), state = node('span', `State: ${human(view.state)}`, 'rl-state');
    identity.append(node('p', originLabels[view.evidence_origin], 'rl-origin'), node('h2', 'Molecular refinement evaluations')); heading.append(identity, state);
    const metrics = node('dl', undefined, 'rl-metrics');
    metrics.append(metric('Retained gradient evaluations', view.frames.length), metric('Computation wall time / s', view.timing.elapsed_seconds),
      metric('Geometry convergence', human(view.convergence.geometry_status)), metric('Optimizer reported convergence', view.convergence.optimizer_reported_converged === null ? 'Unknown' : view.convergence.optimizer_reported_converged ? 'Yes' : 'No'));
    content.append(heading, metrics, node('p', 'Minimum: not evaluated; no Hessian certification. No physical-time trajectory is recorded.', 'rl-note'));
    if (view.failure) {
      const failure = node('div', undefined, 'rl-failure'), summary = node('p', `Failure during ${human(view.failure.phase)} · ${view.failure.code}`, 'rl-failure-title'); summary.setAttribute('role', 'status');
      const raw = node('details', undefined, 'rl-detail rl-failure-detail'); raw.append(node('summary', 'Original failure message'), node('pre', view.failure.message));
      failure.append(summary, node('p', view.frames.length ? `Last retained evaluation: ${view.frames.length - 1}. The original failure message is preserved below.` : 'No successful gradient evaluation was retained. The original failure message is preserved below.'), raw); content.append(failure);
    }
    const controls = node('div', undefined, 'rl-controls'), label = node('label', 'Recorded evaluation ', 'rl-evaluation-label'), selector = node('select'); selector.setAttribute('aria-label', 'Recorded refinement evaluation'); label.append(selector);
    for (const frame of view.frames) { const option = node('option', `Evaluation ${frame.evaluation_index} · ${human(frame.step_status)} · optimizer ${human(frame.optimizer_iteration)}`); option.value = String(frame.evaluation_index); selector.append(option); }
    const previous = node('button', 'Previous evaluation'), next = node('button', 'Next evaluation'), show = node('button', 'Show evaluation in 3D', 'rl-show');
    for (const button of [previous, next, show]) button.type = 'button'; controls.append(label, previous, next, show); content.append(controls);
    const notice = node('p', undefined, 'rl-notice'); notice.setAttribute('role', 'status'); content.append(notice);
    const selectedHost = node('div', undefined, 'rl-selected'), chartHost = node('div', undefined, 'rl-chart'), axisLabel = node('label', 'Chart horizontal axis ', 'rl-axis-label'), axisSelect = node('select'); axisSelect.setAttribute('aria-label', 'Refinement chart horizontal axis');
    for (const [value, text] of [['evaluation_index', 'Gradient evaluation index'], ['elapsed_wall_seconds', 'Computation wall time / s']]) { const option = node('option', text); option.value = value; axisSelect.append(option); }
    axisLabel.append(axisSelect); content.append(selectedHost, axisLabel, chartHost,
      node('p', 'Chart points and 3D positions use numeric rendering projections. Tables retain full recorded decimal strings. Points are discrete; no motion is interpolated. Element colors and sphere sizes are display conventions.', 'rl-note'),
      node('p', 'This view contains one refinement result. It does not rank different compositions, authenticate imported evidence, grant execution approval or establish scientific accuracy.', 'rl-note'),
      detail('Source, result and runtime bindings', { view_hash: view.view_hash, source_binding: view.source_binding, spec_hash: view.spec_hash, result_hash: view.result_hash, runtime_binding_hash: view.runtime_binding_hash, basis_binding_hash: view.basis_binding_hash, final_frame_hash: view.final_frame_hash }),
      detail('Recorded convergence, failure and raw artifact references', { evidence_origin: view.evidence_origin, convergence: view.convergence, failure: view.failure, timing: view.timing, raw_artifacts: view.raw_artifacts, scope: view.scope }));
    function refresh() {
      if (disposed) return;
      selector.disabled = selected === null; selector.value = selected === null ? '' : String(selected);
      axisLabel.hidden = selected === null; axisSelect.disabled = selected === null;
      previous.disabled = selected === null || selected === 0; next.disabled = selected === null || selected === view.frames.length - 1; show.disabled = selected === null;
      selectedHost.replaceChildren();
      if (selected === null) selectedHost.append(node('p', 'No successful gradient evaluations were retained. No geometry or energy is fabricated.', 'rl-empty'));
      else {
        const frame = view.frames[selected], wrap = node('div', undefined, 'rl-coordinate-wrap');
        selectedHost.append(node('h3', `Evaluation ${selected} · ${human(frame.step_status)}`),
          node('p', `Optimizer iteration: ${human(frame.optimizer_iteration)} · Elapsed computation wall time: ${frame.elapsed_wall_seconds} s · Physical time: not recorded.`),
          node('p', `Recorded electronic energy: ${frame.energy_hartree} hartree. Maximum absolute gradient component: ${frame.gradient_summary.maximum_absolute_component} hartree/bohr. RMS gradient component: ${frame.gradient_summary.rms_component} hartree/bohr.`));
        if (frame.reevaluates_frame_hash) selectedHost.append(node('p', 'Reevaluation of accepted frame: ' + frame.reevaluates_frame_hash));
        wrap.append(table(['Atom', 'Element', 'x / Å', 'y / Å', 'z / Å', 'Gradient x / Eh bohr⁻¹', 'Gradient y / Eh bohr⁻¹', 'Gradient z / Eh bohr⁻¹'],
          frame.coordinate_table.map(row => [row.id, row.element, ...row.position_angstrom, ...row.gradient_hartree_per_bohr]), 'Exact recorded coordinates and Cartesian gradients'));
        selectedHost.append(wrap, detail('Selected evaluated-frame bindings and projection', { ...frame.scene.refinement_binding, scene_hash: frame.scene.geometry_hash, projection: frame.scene.projection, gradient_summary: frame.gradient_summary }));
      }
      chartHost.replaceChildren(...(selected === null ? [] : [energyChart(view, axis, selected, selectEvaluation)]));
    }
    function selectEvaluation(index) {
      if (disposed) return false;
      requireValue(Number.isSafeInteger(index) && index >= 0 && index < view.frames.length, 'Select a retained evaluation index.');
      selected = index; notice.textContent = 'Selected evaluation ' + index + '. Use Show evaluation in 3D to update the shared viewport.'; refresh(); return true;
    }
    selector.addEventListener('change', () => selectEvaluation(Number(selector.value)));
    previous.addEventListener('click', () => { if (selected > 0) selectEvaluation(selected - 1); });
    next.addEventListener('click', () => { if (selected !== null && selected < view.frames.length - 1) selectEvaluation(selected + 1); });
    axisSelect.addEventListener('change', () => { if (disposed) return; requireValue(['evaluation_index', 'elapsed_wall_seconds'].includes(axisSelect.value), 'Unknown chart axis.'); axis = axisSelect.value; refresh(); });
    show.addEventListener('click', () => {
      if (disposed || selected === null) return;
      try {
        requireValue(typeof root.displayGeometry === 'function', 'The shared 3D viewport is unavailable.');
        const frame = view.frames[selected]; root.displayGeometry(structuredClone(frame.scene), 1);
        requireValue(root.getDisplayedGeometry?.()?.geometry.geometry_hash === frame.scene.geometry_hash, 'The shared viewport could not display this evaluation.');
        ownedScene = root.getDisplayedGeometry();
        notice.textContent = `Evaluation ${selected} displayed in the shared 3D viewport. Atom positions are its recorded numeric projection.`;
      } catch (error) { notice.textContent = '3D unavailable: ' + error.message; }
    });
    const controller = { selectEvaluation, dispose() {
      disposed = true;
      // The viewer returns its current object. A later display, even of identical
      // coordinates, is another owner's scene and must survive this disposal.
      if (ownedScene && root.getDisplayedGeometry?.() === ownedScene) root.clearGeometry?.('Select a current candidate or retained refinement evaluation.');
      ownedScene = null;
      if (mounted.get(host) === controller) { mounted.delete(host); host.replaceChildren(); }
    } };
    mounted.set(host, controller); refresh(); return controller;
  }

  function createWorkflow(host, { request }) {
    requireValue(typeof request === 'function', 'The host workflow transport is required.');
    const running = value => ['queued', 'running'].includes(value?.state);
    const selectionKey = value => value ? `${value.run_ref}/${value.candidate_hash}` : '';
    let candidate = null, current = null, currentText = null, currentVerified = false, generation = 0, pending = false, timer = null;
    let viewController = null, viewHash = null, visible = true, disposed = false, historyGeneration = 0;
    host.replaceChildren(); host.className = 'refinement-workflow';
    const heading = node('div', undefined, 'rw-heading'), intro = node('div');
    intro.append(node('p', 'SELECTED ORGANIC CANDIDATE', 'eyebrow'), node('h3', 'Molecular refinement'));
    const state = node('span', 'No candidate', 'rw-state'); state.id = 'refinement-workflow-state'; heading.append(intro, state);
    const subject = node('p', undefined, 'rw-subject'); subject.id = 'refinement-workflow-subject';
    const modeLabel = node('label', 'Calculation scope '), mode = node('select'); mode.id = 'refinement-workflow-mode';
    for (const [value, label] of [['gradient', 'One analytic gradient'], ['optimization', 'Bounded geometry optimization']]) {
      const option = node('option', label); option.value = value; mode.append(option);
    }
    mode.value = 'gradient'; modeLabel.append(mode);
    const actions = node('div', undefined, 'rw-actions'), buttons = {};
    for (const [key, label] of [['prepare', 'Prepare refinement'], ['approve', 'Approve this plan'], ['submit', 'Run approved plan'], ['cancel', 'Cancel run'], ['refresh', 'Refresh status'], ['export', 'Export evidence']]) {
      const button = node('button', label); button.type = 'button'; button.id = `refinement-workflow-${key}`; buttons[key] = button; actions.append(button);
    }
    buttons.prepare.className = 'primary';
    const historyLabel = node('label', 'Saved refinements for this candidate '), history = node('select'); history.id = 'refinement-workflow-history'; historyLabel.append(history);
    const status = node('p', undefined, 'rw-status'); status.id = 'refinement-workflow-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const exportStatus = node('p', undefined, 'rl-note'); exportStatus.id = 'refinement-workflow-export-status'; exportStatus.setAttribute('role', 'status');
    const planHost = node('div', undefined, 'rw-plan'), resultHost = node('div', undefined, 'rw-result');
    planHost.id = 'refinement-workflow-plan'; resultHost.id = 'refinement-workflow-result';
    host.append(heading, subject, node('p', 'ωB97X-D3BJ / def2-TZVPPD · neutral singlet. Preparation retains the selected coordinates and shows the host resource limits before approval.', 'rl-note'),
      modeLabel, actions, historyLabel, status, exportStatus, planHost, resultHost);

    function clearView() { viewController?.dispose(); viewController = null; viewHash = null; resultHost.replaceChildren(); }
    function invalidate() { generation++; pending = false; exportStatus.textContent = ''; if (timer !== null) root.clearTimeout(timer); timer = null; }
    function valid(token) { return !disposed && visible && token === generation; }
    function updateControls() {
      const available = !disposed && visible && !!candidate && !pending;
      mode.disabled = !available || running(current);
      buttons.prepare.disabled = !available || running(current);
      buttons.approve.disabled = !available || !currentVerified || !current || running(current) || current.state === 'approved';
      buttons.submit.disabled = !available || !currentVerified || current?.state !== 'approved';
      buttons.cancel.disabled = !available || current?.state !== 'running';
      buttons.refresh.disabled = !available;
      buttons.export.disabled = !available || !currentVerified || !current?.result || currentText === null;
      history.disabled = !available;
    }
    function reset(message) {
      invalidate(); historyGeneration++; current = null; currentText = null; currentVerified = false; clearView(); planHost.replaceChildren();
      state.textContent = candidate ? 'Ready to prepare' : 'No candidate'; status.textContent = message;
      history.replaceChildren(); const placeholder = node('option', 'Select a saved refinement'); placeholder.value = ''; history.append(placeholder);
      updateControls();
    }
    function assertRecord(value, reference = null, expectedMode = null) {
      requireValue(value?.version === 'refinement-workflow/v1' && hash(value.reference) && (!reference || value.reference === reference) &&
        selectionKey(value.selection) === selectionKey(candidate?.selection) && value.plan?.kind === 'molecular_refinement' &&
        value.plan.version === 'governed-refinement-plan/v1' && value.plan.resolved_plan_hash === value.resolved_plan_hash &&
        selectionKey(value.plan.subject?.selection) === selectionKey(candidate?.selection) &&
        ['gradient', 'optimization'].includes(value.plan.mode) && (!expectedMode || value.plan.mode === expectedMode),
      'The returned refinement does not match this candidate, plan or calculation scope.');
      requireValue(['wall_seconds', 'memory_bytes', 'cpu_seconds', 'threads', 'max_output_bytes'].every(key => Number.isSafeInteger(value.plan.resource_ceilings?.[key]) && value.plan.resource_ceilings[key] > 0) &&
        value.plan.method_profile_id === 'psi4.wb97x_d3bj.def2_tzvppd.optimize.v1' && value.plan.disk_budget,
      'The host method and resource policy must be available before approval.');
      requireValue(Object.hasOwn(value, 'refinement_view'), 'The host refinement projection is missing.');
      if (value.result) requireValue(value.result.mode === value.plan.mode && value.result.resolved_plan_hash === value.resolved_plan_hash,
        'The returned execution result does not match this plan and calculation scope.');
      if (value.refinement_view !== null) {
        requireValue(value.result?.scientific_result && value.refinement_view.spec_hash === value.plan.spec?.spec_hash &&
          value.refinement_view.result_hash === value.result.scientific_result.result_hash &&
          value.refinement_view.source_binding?.source_hash === value.plan.spec.source_binding.source_hash &&
          value.result.resolved_plan_hash === value.resolved_plan_hash,
        'The returned scientific view does not match the committed result and plan.');
        prepare(value.refinement_view);
      }
      return value;
    }
    function show(value) {
      current = structuredClone(value); currentText = responseTexts.get(value) ?? null; currentVerified = true; mode.value = current.plan.mode; state.textContent = `Run: ${human(current.state)}`;
      exportStatus.textContent = current.result && currentText === null ? 'Evidence export unavailable: original HTTP response text was not retained. Refresh this record.' : '';
      const plan = current.plan, resources = plan.resource_ceilings;
      planHost.replaceChildren(node('h4', 'Plan to review'), node('p', `Scope: ${plan.mode === 'gradient' ? 'one analytic gradient; no optimization' : 'bounded geometry optimization'}. Approval applies to this saved plan and its current host checks.`),
        node('p', `Host limits: ${resources.wall_seconds} s wall time · ${resources.cpu_seconds} CPU s · ${resources.threads} threads · ${resources.memory_bytes / 1024 ** 3} GiB memory · ${resources.max_output_bytes / 1024 ** 2} MiB captured output.`, 'rw-limits'),
        detail('Method, resource limits and optimizer policy', { method_profile_id: plan.method_profile_id, mode: plan.mode, resources: plan.resource_ceilings, disk_budget: plan.disk_budget, optimizer_settings: plan.spec?.optimizer_settings, execution_contract: plan.prepared_input?.execution_contract || plan.execution_contract }),
        detail('Selected source and plan bindings', { selection: current.selection, source_hash: current.source_hash, spec_hash: plan.spec?.spec_hash, resolved_plan_hash: current.resolved_plan_hash, worker: plan.worker }));
      const result = current.result;
      if (result) {
        status.textContent = `Runner: ${human(current.state)}. Host execution: ${human(result.execution_status ?? null)}. Evidence eligible: ${result.evidence_eligible === true ? 'yes' : 'no'}. Scientific state: ${human(result.scientific_state ?? null)}. ${result.summary || ''}`;
        planHost.append(detail('Retained execution result and diagnostics', result));
      } else if (current.failure || ['failed', 'timeout', 'cancelled', 'interrupted', 'output_limit'].includes(current.state)) {
        status.textContent = `Runner: ${human(current.state)}. No committed scientific result. ${current.failure || current.job?.failure || 'Inspect the retained job diagnostics.'}`;
        planHost.append(detail('Retained workflow failure and job diagnostics', { failure: current.failure, job: current.job }));
      } else status.textContent = current.state === 'approved' ? 'Plan approved. Use Run approved plan to start the governed worker.' : running(current) ? 'The governed job is active. Evaluations appear only after the host commits a scientific result. No numerical progress is inferred.' : 'Review the selected source, method and resource limits, then approve this plan.';
      if (current.refinement_view !== null) {
        if (viewHash !== current.refinement_view.view_hash) {
          clearView(); viewController = renderRefinementView(resultHost, current.refinement_view); viewHash = current.refinement_view.view_hash;
        }
      } else { clearView(); resultHost.append(node('p', result ? 'No committed scientific evaluations are available. Inspect the retained execution diagnostics.' : 'No evaluated energies or gradients have been returned.', 'rl-empty')); }
      if (![...history.options].some(option => option.value === current.reference)) { const option = node('option', `${human(current.plan.mode)} · ${human(current.state)} · ${current.reference.slice(7, 15)}`); option.value = current.reference; history.append(option); }
      history.value = current.reference; updateControls();
    }
    function fail(error, token) {
      if (!valid(token)) return;
      status.textContent = 'Refinement request stopped: ' + error.message;
      // A rejected or unreadable response cannot leave its old scene presented
      // as current evidence. Retained raw diagnostics remain in the plan panel.
      clearView(); currentText = null; currentVerified = false; pending = false; updateControls();
    }
    async function refreshHistory() {
      if (!candidate || !visible || disposed) return;
      const token = generation, sequence = ++historyGeneration, key = selectionKey(candidate.selection);
      try {
        const values = await request('/api/workflows');
        if (!valid(token) || sequence !== historyGeneration || key !== selectionKey(candidate?.selection)) return;
        requireValue(Array.isArray(values), 'Saved refinement history is unavailable.');
        const saved = current?.reference || ''; history.replaceChildren();
        const placeholder = node('option', 'Select a saved refinement'); placeholder.value = ''; history.append(placeholder);
        for (const value of values) {
          if (value.version !== 'refinement-workflow/v1' || selectionKey(value.selection) !== key) continue;
          const option = node('option', `${human(value.plan?.mode)} · ${human(value.state)} · ${value.reference.slice(7, 15)}`); option.value = value.reference; history.append(option);
        }
        if (saved && ![...history.options].some(option => option.value === saved)) { const option = node('option', `Current refinement · ${saved.slice(7, 15)}`); option.value = saved; history.append(option); }
        history.value = saved;
      } catch (error) { if (valid(token) && sequence === historyGeneration) status.textContent = 'Saved refinements unavailable: ' + error.message; }
    }
    function schedule(token) {
      if (!valid(token) || !running(current)) return;
      timer = root.setTimeout(() => { timer = null; read(current.reference, token); }, 1000);
    }
    async function read(reference, inheritedToken = null) {
      if (!candidate || !visible || disposed) return;
      if (inheritedToken === null) invalidate();
      const token = inheritedToken ?? generation; pending = true; updateControls();
      try {
        const value = await request('/api/workflow/read', { reference });
        if (!valid(token)) return;
        assertRecord(value, reference); pending = false; show(value); schedule(token);
      } catch (error) { fail(error, token); }
    }
    async function mutate(action) {
      if (buttons[action].disabled) return;
      const selectedMode = mode.value, reference = current?.reference;
      invalidate(); const token = generation; pending = true; updateControls();
      status.textContent = ({ prepare: 'Preparing the selected candidate with the host policy…', approve: 'Checking this plan and recording approval…', submit: 'Submitting the approved governed job…', cancel: 'Requesting cancellation and waiting for process-tree teardown…' })[action];
      try {
        const url = action === 'prepare' ? '/api/workflow/refinement/prepare' : action === 'approve' ? '/api/workflow/refinement/approve' : '/api/workflow/' + action;
        const payload = action === 'prepare' ? { selection: structuredClone(candidate.selection), mode: selectedMode } : { reference };
        const value = await request(url, payload);
        if (!valid(token)) return;
        if (action === 'cancel') { pending = false; await read(reference, token); return; }
        assertRecord(value, action === 'prepare' ? null : reference, selectedMode);
        pending = false; show(value); schedule(token); refreshHistory();
      } catch (error) { fail(error, token); }
    }
    for (const action of ['prepare', 'approve', 'submit', 'cancel']) buttons[action].addEventListener('click', () => mutate(action));
    buttons.refresh.addEventListener('click', () => { if (buttons.refresh.disabled) return; return current ? read(current.reference) : refreshHistory(); });
    buttons.export.addEventListener('click', () => {
      if (buttons.export.disabled) return;
      const token = generation, reference = current.reference, text = currentText;
      try {
        requireValue(valid(token) && currentVerified && typeof text === 'string', 'Current retained evidence is unavailable.');
        const retained = parseWorkflowResponse(text);
        assertRecord(retained, reference, current.plan.mode);
        requireValue(same(retained, current) && valid(token), 'Displayed refinement evidence changed; refresh before exporting.');
        downloadEvidence(text);
        exportStatus.setAttribute('role', 'status');
        exportStatus.textContent = 'Evidence download requested for this ' + human(current.state) + ' record. Original HTTP JSON text is preserved; host and scientific status are unchanged.';
      } catch (error) {
        if (!valid(token)) return;
        exportStatus.setAttribute('role', 'alert'); exportStatus.textContent = 'Evidence export failed: ' + error.message;
      }
    });
    history.addEventListener('change', () => { if (!history.disabled && history.value) return read(history.value); });
    mode.addEventListener('change', () => { if (!mode.disabled) { reset('Calculation scope changed. Prepare a new plan for this scope.'); refreshHistory(); } });
    const controller = {
      setCandidate(value) {
        if (disposed) return;
        if (value !== null) requireValue(hash(value?.selection?.run_ref) && hash(value.selection.candidate_hash) && typeof value.label === 'string' && Number.isSafeInteger(value.atom_count) && value.atom_count > 0, 'Select an organic candidate from a saved Design study.');
        const unchanged = selectionKey(value?.selection) === selectionKey(candidate?.selection);
        candidate = value === null ? null : structuredClone(value);
        subject.textContent = candidate ? `${candidate.label} · ${candidate.atom_count} atoms · candidate ${candidate.selection.candidate_hash.slice(7, 19)}` : 'Select an organic candidate from a saved Design study.';
        if (!unchanged) { reset(candidate ? 'Prepare this candidate to inspect its exact method and resource policy.' : 'No candidate is selected.'); refreshHistory(); }
      },
      setVisible(value) {
        if (disposed || visible === value) return;
        visible = value; invalidate(); clearView(); updateControls();
        if (visible) { if (current) read(current.reference); else refreshHistory(); }
      },
      dispose() { if (disposed) return; disposed = true; invalidate(); historyGeneration++; clearView(); host.replaceChildren(); }
    };
    reset('Select an organic candidate from a saved Design study.'); return controller;
  }
  return { prepare, coordinateRows, coordinateCSV, renderRefinementView, createWorkflow, parseWorkflowResponse };
});
