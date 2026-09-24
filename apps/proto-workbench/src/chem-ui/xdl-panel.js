/* Existing Chem XDL parser surface. No compile or execution action is exposed. */
(() => {
  const SAMPLE = '<Synthesis>\n  <Hardware/>\n  <Reagents/>\n  <Procedure>\n    <Wait time="1 s"/>\n  </Procedure>\n</Synthesis>\n';
  const MAX_BYTES = 200 * 1024;

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function mount(host) {
    if (host.dataset.xdlMounted) return;
    host.dataset.xdlMounted = 'true';
    host.classList.add('xdl-workspace');
    host.innerHTML = `
      <header class="xdl-heading">
        <div><p class="xdl-eyebrow">LANGUAGE WORKSPACE</p><h1>XDL design</h1><p>Inspect chemical procedure source and preserve it through XML and JSON.</p></div>
        <span class="xdl-runtime" role="status">Checking XDL parser…</span>
      </header>
      <div class="xdl-toolbar">
        <button type="button" data-xdl="import">Import XDL / JSON</button>
        <button type="button" data-xdl="sample">Parser sample</button>
        <label class="xdl-format-label">Format <select data-xdl="format" aria-label="XDL source format"><option value="xml">XDL / XML</option><option value="json">JSON</option></select></label>
        <span class="xdl-toolbar-spacer"></span>
        <button type="button" data-xdl="inspect" class="xdl-primary">Inspect source</button>
        <button type="button" data-xdl="export-xml" disabled>Export XDL</button>
        <button type="button" data-xdl="export-json" disabled>Export JSON</button>
        <input type="file" data-xdl="file" accept=".xdl,.xml,.json,application/xml,application/json,text/xml" hidden>
      </div>
      <div class="xdl-panels">
        <section class="xdl-source-panel" aria-label="XDL source editor">
          <div class="xdl-panel-title"><strong data-xdl="filename">Untitled.xdl</strong><span data-xdl="source-state">Not inspected</span></div>
          <label class="xdl-editor-label" for="chem-xdl-source">Source</label>
          <textarea id="chem-xdl-source" data-xdl="source" spellcheck="false" autocapitalize="off" autocomplete="off" aria-label="XDL source" placeholder="Import a procedure or open the parser sample."></textarea>
          <div class="xdl-editor-footer"><span data-xdl="source-size">0 lines · 0 bytes</span><span>PlaceholderPlatform · source inspection</span></div>
        </section>
        <section class="xdl-inspector" aria-label="XDL inspection results">
          <div class="xdl-panel-title"><strong>Inspection</strong><span data-xdl="result-state">No result</span></div>
          <div data-xdl="result" class="xdl-result" aria-live="polite"><div class="xdl-empty"><h2>Keep the source in view.</h2><p>Inspect the document with Chem’s installed XDL parser. Parsed steps, source identity and serialization checks will appear here.</p><p>Compilation and procedure execution are not part of this existing parser workflow.</p></div></div>
        </section>
      </div>`;

    const get = (name) => host.querySelector(`[data-xdl="${name}"]`);
    const source = get('source');
    const format = get('format');
    const result = get('result');
    const inspectButton = get('inspect');
    const exportXml = get('export-xml');
    const exportJson = get('export-json');
    let inspection = null;
    let inspectedSource = null;
    let inspectedFormat = null;
    let filename = 'Untitled.xdl';
    let pending = false;

    function sourceChanged() {
      const bytes = new TextEncoder().encode(source.value).length;
      get('source-size').textContent = `${source.value ? source.value.split('\n').length : 0} lines · ${bytes.toLocaleString()} bytes`;
      const current = inspection?.ok && source.value === inspectedSource && format.value === inspectedFormat;
      exportXml.disabled = !current;
      exportJson.disabled = !current;
      get('source-state').textContent = current ? 'Inspected source' : inspection ? 'Changed since inspection' : 'Not inspected';
      inspectButton.disabled = pending || !source.value.trim();
      if (!current && inspection?.ok) get('result-state').textContent = 'Earlier source';
      if (current) get('result-state').textContent = 'Parsed · uncompiled';
    }

    function errorMessage(type, message) {
      result.replaceChildren();
      const block = node('div', 'xdl-error');
      block.setAttribute('role', 'alert');
      block.append(node('h2', '', 'Inspection could not finish'), node('code', '', type), node('pre', '', message));
      result.append(block);
      get('result-state').textContent = 'Error';
    }

    function renderInspection(report) {
      result.replaceChildren();
      const summary = node('div', 'xdl-summary');
      for (const [name, count] of Object.entries(report.counts)) {
        const metric = node('div');
        metric.append(node('strong', '', String(count)), node('span', '', name));
        summary.append(metric);
      }
      result.append(summary);
      const boundary = node('p', 'xdl-boundary', `XDL ${report.version} · ${report.platform} · uncompiled · not executed`);
      result.append(boundary);
      const checks = node('div', 'xdl-roundtrips');
      for (const type of ['xml', 'json']) {
        const check = report.roundtrip[type];
        checks.append(node('span', '', `${type.toUpperCase()} round trip · ${check.ok && check.equivalent ? 'verified' : 'not verified'}`));
      }
      result.append(checks, node('h2', 'xdl-section-heading', 'Parsed procedure'));
      if (report.steps.length === 0) result.append(node('p', 'xdl-muted', 'This document has no procedure steps.'));
      report.steps.forEach((step, index) => {
        const card = node('article', 'xdl-step');
        card.append(node('h3', '', `${String(index + 1).padStart(2, '0')}  ${step.name}`));
        const properties = node('dl', 'xdl-properties');
        Object.entries(step.properties || {}).forEach(([name, value]) => {
          if (value === '' || value === null || value === undefined) return;
          properties.append(node('dt', '', name), node('dd', '', typeof value === 'object' ? JSON.stringify(value) : String(value)));
        });
        card.append(properties);
        if (step.children?.length) card.append(node('pre', 'xdl-child-steps', JSON.stringify(step.children, null, 2)));
        result.append(card);
      });
      const identity = node('details', 'xdl-identity');
      identity.append(node('summary', '', 'Source & serialization identity'));
      const fields = node('dl', 'xdl-properties');
      fields.append(node('dt', '', 'Source SHA-256'), node('dd', '', report.source.sha256));
      for (const type of ['xml', 'json']) fields.append(node('dt', '', `${type.toUpperCase()} SHA-256`), node('dd', '', report.roundtrip[type].sha256));
      identity.append(fields);
      result.append(identity);
    }

    async function inspect() {
      if (pending || !source.value.trim()) return;
      const submitted = source.value;
      const submittedFormat = format.value;
      const body = JSON.stringify({ source: submitted, format: submittedFormat });
      if (new TextEncoder().encode(body).length > MAX_BYTES) {
        errorMessage('InputLimit', 'The source and its JSON request envelope must fit within 200 KiB.');
        return;
      }
      pending = true;
      inspection = null;
      sourceChanged();
      inspectButton.textContent = 'Inspecting…';
      get('result-state').textContent = 'Parsing source';
      try {
        const response = await fetch('/api/xdl/inspect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
        const report = await response.json();
        if (!response.ok || !report.ok) {
          throw Object.assign(new Error(report.error?.message || report.message || `XDL service returned ${response.status}.`), { name: report.error?.type || 'InspectionError' });
        }
        inspection = report;
        inspectedSource = submitted;
        inspectedFormat = submittedFormat;
        renderInspection(report);
      } catch (error) {
        errorMessage(error.name || 'InspectionError', error.message || String(error));
      } finally {
        pending = false;
        inspectButton.textContent = 'Inspect source';
        sourceChanged();
      }
    }

    function download(type) {
      if (!inspection?.ok || source.value !== inspectedSource || format.value !== inspectedFormat) return;
      const url = URL.createObjectURL(new Blob([inspection.exports[type]], { type: type === 'xml' ? 'application/xml;charset=utf-8' : 'application/json;charset=utf-8' }));
      const link = node('a');
      link.href = url;
      link.download = `${filename.replace(/\.(?:xdl|xml|json)$/i, '') || 'procedure'}.roundtrip.${type === 'xml' ? 'xdl' : 'json'}`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    get('import').addEventListener('click', () => get('file').click());
    get('file').addEventListener('change', async (event) => {
      const file = event.target.files?.[0];
      if (!file) return;
      try {
        if (file.size > MAX_BYTES) throw new Error('The XDL import limit is 200 KiB.');
        const text = await file.text();
        source.value = text;
        format.value = /\.json$/i.test(file.name) || text.trimStart().startsWith('{') ? 'json' : 'xml';
        filename = file.name;
        get('filename').textContent = filename;
        sourceChanged();
      } catch (error) {
        errorMessage('ImportError', error.message || String(error));
      } finally { event.target.value = ''; }
    });
    get('sample').addEventListener('click', () => {
      source.value = SAMPLE;
      format.value = 'xml';
      filename = 'parser-sample.xdl';
      get('filename').textContent = 'parser-sample.xdl · software fixture';
      sourceChanged();
      source.focus();
    });
    source.addEventListener('input', sourceChanged);
    format.addEventListener('change', sourceChanged);
    inspectButton.addEventListener('click', inspect);
    exportXml.addEventListener('click', () => download('xml'));
    exportJson.addEventListener('click', () => download('json'));
    sourceChanged();
    fetch('/api/xdl/status').then(async (response) => {
      const status = await response.json();
      const ready = response.ok && status.ok && status.available;
      host.querySelector('.xdl-runtime').textContent = ready ? `XDL ${status.version} · parser available` : 'XDL parser unavailable';
      if (!ready) host.querySelector('.xdl-runtime').title = status.error?.message || status.reason || 'The separately installed Chem XDL environment is unavailable.';
    }).catch((error) => {
      host.querySelector('.xdl-runtime').textContent = 'XDL parser unavailable';
      host.querySelector('.xdl-runtime').title = error.message;
    });
  }

  window.ChemXDL = { mount };
})();
