import { escapeHtml } from './html.js';

export function buildAnalysis({ nodes, raw, zones, zoneColor, hexAlpha, selectNode, selectZone }) {
  // ---------- structural analysis (report-only summaries from scripts/depgraph) ----------

  function renderAnalysis() {
    const el = document.getElementById('analysis');
    const dom = raw.dominatorSummary;
    const cohesion = raw.cohesionSummary;
    const scc = raw.zoneSccSummary;
    if (!dom && !cohesion) {
      el.innerHTML = '<h2>Structure</h2><div class="hint">no summaries in this payload</div>';
      return;
    }

    const initial = dom ? dom.entry.replace(/^src\//, '') : 'daemon.ts';
    const options = Object.keys(raw.entrySummaries);
    if (!options.includes(initial)) options.unshift(initial);

    el.innerHTML =
      `<h2>Eager closure</h2>
      <div class="slider-row"><span>entry</span><select id="domEntry">${options
        .map((id) => `<option${id === initial ? ' selected' : ''}>${escapeHtml(id)}</option>`)
        .join('')}</select></div>
      <div id="domSummary" class="hint"></div>
      <div id="domTop"></div>` +
      (cohesion
        ? `<h2 style="margin-top:12px">Zone cohesion</h2>
      <div class="hint">modularity · declared ${cohesion.modularity.declaredZones.toFixed(
        3,
      )} / detected ${cohesion.modularity.detectedCommunities.toFixed(3)}</div>
      ${cohesion.zoneCohesion
        .slice(0, 10)
        .map((z) => {
          const zi = zones.findIndex((x) => x.id === z.zone);
          const pct = Math.round(z.cohesionShare * 100);
          return `<div class="bar-row" data-zone="${zi}" title="${z.largestCommunitySize} of ${
            z.files
          } files land in one detected community">
          <div class="top"><span>${escapeHtml(z.zone)}</span><span class="count">${pct}%</span></div>
          <div class="bar"><i style="width:${pct}%;background:${hexAlpha(
            zoneColor(zones[zi]),
            0.9,
          )}"></i></div></div>`;
        })
        .join('')}`
        : '') +
      (scc
        ? `<h2 style="margin-top:12px">Zone cycles</h2>
      <div class="hint">${
        scc.components.length
          ? scc.components.map((c) => `<div>${escapeHtml(c.zones.join(', '))}</div>`).join('')
          : `none across ${scc.zones} zones (R4 is file-level; this checks zone level)`
      }</div>`
        : '');

    function renderDominator(id) {
      const summary = el.querySelector('#domSummary');
      const top = el.querySelector('#domTop');
      const data = raw.entrySummaries[id];
      if (!data) {
        summary.textContent = `${id} is not a production source file in this graph`;
        top.innerHTML = '';
        return;
      }
      const { reachableFiles, reachableLoc, bottlenecks } = data;
      summary.textContent = `${reachableFiles} of ${nodes.length} files loaded eagerly (${Math.round(
        (reachableFiles / nodes.length) * 100,
      )}%) · ${reachableLoc} loc`;
      top.innerHTML = bottlenecks
        .map((r) => {
          const node = nodes.find((n) => n.id === r.file.replace(/^src\//, ''));
          return `<div class="bar-row" data-node="${node.index}">
          <div class="top"><span>${escapeHtml(node.id)}</span>
          <span class="count">${r.files} files</span></div>
          <div class="bar"><i style="width:${Math.round(
            (r.files / (bottlenecks[0]?.files || 1)) * 100,
          )}%;background:${hexAlpha(zoneColor(zones[node.z]), 0.85)}"></i></div></div>`;
        })
        .join('');
    }

    el.querySelector('#domEntry').addEventListener('change', (e) =>
      renderDominator(e.target.value),
    );
    el.addEventListener('click', (e) => {
      const row = e.target.closest('[data-node]');
      if (row) {
        const idx = Number(row.dataset.node);
        selectNode(idx);
        return;
      }
      const zoneRow = e.target.closest('[data-zone]');
      if (zoneRow) {
        const zi = Number(zoneRow.dataset.zone);
        selectZone(zi);
      }
    });
    renderDominator(initial);
  }

  renderAnalysis();
}
