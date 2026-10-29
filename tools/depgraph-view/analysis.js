export function buildAnalysis({
  nodes,
  raw,
  entryManifest,
  zones,
  zoneColor,
  hexAlpha,
  selectNode,
  selectZone,
}) {
  // ---------- structural analysis (report-only summaries from scripts/depgraph) ----------

  // node ids drop the root's `src/` prefix (scripts/depgraph/build.ts), so summaries that name
  // files must be mapped the same way before they can be looked up here.
  const nodeIdOf = (file) => nodes.find((n) => n.id === file.replace(/^src\//, ''));

  // value edges directed importer -> imported: the eager-load relation, exactly the subgraph R4
  // keeps acyclic and the one computeDominatorSummary walks.
  const valueOut = nodes.map(() => []);
  for (const [a, b, kind] of raw.edges) {
    if (kind === 0) valueOut[a].push(b);
  }

  /**
   * Dominator tree of `entry` over value edges (Cooper–Harvey–Kennedy, walking reverse postorder):
   * every file in `d`'s dominated set stops being reachable from `entry` when `d` disappears, so
   * its size is the branch moving `d` behind `import()` would cut. Same query as
   * computeDominatorSummary, run live so any file can be the entry.
   */
  function reversePostorder(entry) {
    // iterative DFS -> postorder; reverse postorder is the fixpoint iteration order
    const post = [];
    const state = new Set([entry]);
    const stack = [{ node: entry, edge: 0 }];
    while (stack.length) {
      const top = stack.at(-1);
      const next = valueOut[top.node][top.edge];
      top.edge++;
      if (next === undefined) {
        post.push(top.node);
        stack.pop();
        continue;
      }
      if (state.has(next)) continue;
      state.add(next);
      stack.push({ node: next, edge: 0 });
    }
    return post.reverse();
  }

  function immediateDominators(entry, order) {
    const postRank = new Map(order.map((n, i) => [n, i]));

    const preds = new Map(order.map((n) => [n, []]));
    for (const n of order) for (const next of valueOut[n]) preds.get(next).push(n);

    const idom = new Map([[entry, entry]]);
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = 1; i < order.length; i++) {
        const n = order[i];
        const candidate = findDominator(preds.get(n));
        if (candidate < 0 || idom.get(n) === candidate) continue;
        idom.set(n, candidate);
        changed = true;
      }
    }
    function findDominator(predecessors) {
      let candidate = -1;
      for (const predecessor of predecessors) {
        if (!idom.has(predecessor)) continue;
        candidate = candidate < 0 ? predecessor : intersect(candidate, predecessor);
      }
      return candidate;
    }
    function intersect(finger1, finger2) {
      while (finger1 !== finger2) {
        while (postRank.get(finger1) > postRank.get(finger2)) finger1 = idom.get(finger1);
        while (postRank.get(finger2) > postRank.get(finger1)) finger2 = idom.get(finger2);
      }
      return finger1;
    }

    return idom;
  }

  function dominatorsOf(entry) {
    const order = reversePostorder(entry);
    const idom = immediateDominators(entry, order);

    // dominated sets bottom-up: the dominator parent always precedes its subtree in reverse
    // postorder, so walking `order` backwards fills a node's set before it rolls into its parent
    const sizes = new Map(order.map((n) => [n, { files: 1, loc: nodes[n].loc }]));
    for (let i = order.length - 1; i > 0; i--) {
      const n = order[i];
      const parent = idom.get(n);
      const own = sizes.get(n);
      const accumulated = sizes.get(parent);
      accumulated.files += own.files;
      accumulated.loc += own.loc;
    }
    return {
      reachable: order.length,
      reachableLoc: sizes.get(entry).loc,
      bottlenecks: order
        .filter((n) => n !== entry)
        .map((n) => ({ index: n, ...sizes.get(n) }))
        .sort((a, b) => b.files - a.files || nodes[a.index].id.localeCompare(nodes[b.index].id)),
    };
  }

  function renderAnalysis() {
    const el = document.getElementById('analysis');
    const dom = raw.dominatorSummary;
    const cohesion = raw.cohesionSummary;
    const scc = raw.zoneSccSummary;
    if (!dom && !cohesion) {
      el.innerHTML = '<h2>Structure</h2><div class="hint">no summaries in this payload</div>';
      return;
    }

    const entryChoices = () => {
      const hot = nodes
        .filter((n) => n.in > 0)
        .sort((a, b) => b.in + b.out - (a.in + a.out))
        .slice(0, 300)
        .map((n) => n.id);
      const declared = new Set(
        Object.values(entryManifest)
          .flat()
          .map((e) => e.id),
      );
      return [...new Set([...declared, ...hot])].filter((id) => nodes.some((n) => n.id === id));
    };
    const initial = dom ? dom.entry.replace(/^src\//, '') : 'daemon.ts';
    const options = entryChoices();
    if (!options.includes(initial)) options.unshift(initial);

    el.innerHTML =
      `<h2>Eager closure</h2>
      <div class="slider-row"><span>entry</span><select id="domEntry">${options
        .map((id) => `<option${id === initial ? ' selected' : ''}>${id}</option>`)
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
          <div class="top"><span>${z.zone}</span><span class="count">${pct}%</span></div>
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
          ? scc.components.map((c) => `<div class="hot">${c.zones.join(' → ')} → …</div>`).join('')
          : `none across ${scc.zones} zones (R4 is file-level; this checks zone level)`
      }</div>`
        : '');

    function renderDominator(id) {
      const entry = nodeIdOf(id);
      const summary = el.querySelector('#domSummary');
      const top = el.querySelector('#domTop');
      if (!entry) {
        summary.textContent = `${id} is not a production source file in this graph`;
        top.innerHTML = '';
        return;
      }
      const t0 = performance.now();
      const { reachable, reachableLoc, bottlenecks } = dominatorsOf(entry.index);
      const ms = performance.now() - t0;
      summary.textContent = `${reachable} of ${nodes.length} files loaded eagerly (${Math.round(
        (reachable / nodes.length) * 100,
      )}%) · ${reachableLoc} loc · ${ms.toFixed(0)}ms`;
      top.innerHTML = bottlenecks
        .slice(0, 8)
        .map(
          (r) => `<div class="bar-row" data-node="${r.index}">
          <div class="top"><span>${nodes[r.index].id}</span>
          <span class="count">${r.files} files</span></div>
          <div class="bar"><i style="width:${Math.round(
            (r.files / (bottlenecks[0]?.files || 1)) * 100,
          )}%;background:${hexAlpha(zoneColor(zones[nodes[r.index].z]), 0.85)}"></i></div></div>`,
        )
        .join('');
      // both numbers come from the same payload, so a divergence means this traversal disagrees
      // with scripts/depgraph/structure-summary.ts rather than that the data is stale
      if (dom && id === dom.entry.replace(/^src\//, '') && dom.reachableFiles !== reachable) {
        summary.textContent += ` · ⚠ report says ${dom.reachableFiles} of ${dom.totalFiles} / ${dom.reachableLoc} loc`;
      }
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
        if (zi < 0) return;
        selectZone(zi);
      }
    });
    renderDominator(initial);
  }

  renderAnalysis();
}
