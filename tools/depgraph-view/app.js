import { escapeHtml } from './html.js';
import { createLayout, fitScale } from './layout.js';
import { createSimulation } from './simulation.js';
import { buildAnalysis } from './analysis.js';
import { createGraphModel, refreshPairKinds, visibleCycleFocus } from './graph-model.js';

/* agent-device dependency-graph explorer
 * Canvas force view over the JSON emitted by scripts/depgraph/build.ts.
 * Nodes = files, edges = imports (value / type-only / dynamic), clustered per zone.
 */
(async () => {
  'use strict';

  const KIND_NAMES = ['value', 'type', 'dynamic'];
  const KIND_COLORS = ['#7aa2f7', '#bb9af7', '#9ece6a'];
  const PALETTE = [
    '#f7768e',
    '#ff9e64',
    '#e0af68',
    '#9ece6a',
    '#73daca',
    '#2ac9de',
    '#7aa2f7',
    '#bb9af7',
    '#f7768e',
    '#c0caf5',
    '#b4f9f8',
    '#9d7cd8',
  ];
  const DIM_ALPHA = 0.04;

  // ---------- payload ----------

  let raw;
  let entryManifest;
  try {
    const response = await fetch('/dependency-graph/graph.json');
    if (!response.ok) throw new Error('Graph data unavailable');
    raw = await response.json();
    entryManifest = raw.entries;
  } catch {
    document.getElementById('stats').textContent = 'Could not load the graph. Reload to try again.';
    return;
  }

  const { zones, nodes, pairs, nodePairs } = createGraphModel(raw);

  const {
    hubs,
    zoneRect,
    pkgOfZone,
    packages,
    pkgList,
    pkgRect,
    bySize,
    ENTRY_R,
    placeLayout,
    seedPositions,
    zoneColor,
  } = createLayout({ zones, nodes, raw, entryManifest, PALETTE });

  // ---------- force simulation ----------

  const { sim, tick, reheat } = createSimulation({
    nodes,
    pairs,
    zones,
    hubs,
    zoneRect,
    pkgOfZone,
  });
  let spread = 14;

  // ---------- view / canvas ----------

  const canvas = document.getElementById('canvas');
  const ctx = canvas.getContext('2d');
  const bloom = document.createElement('canvas');
  const bctx = bloom.getContext('2d');
  const BLOOM_SCALE = 0.3;
  const view = { x: 0, y: 0, k: 0.35, anim: null };
  let dpr = 1,
    W = 0,
    H = 0;

  function resize() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    const rect = canvas.parentElement.getBoundingClientRect();
    W = rect.width;
    H = rect.height;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    bloom.width = Math.round(W * BLOOM_SCALE);
    bloom.height = Math.round(H * BLOOM_SCALE);
    dirty = true;
  }
  window.addEventListener('resize', resize);

  const toWorld = (sx, sy) => ({ x: (sx - view.x) / view.k, y: (sy - view.y) / view.k });

  function fitView(pad = 80, immediate = false) {
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const pkg of pkgList) {
      if (!pkgVisible(pkg.name)) continue;
      const r = pkgRect.get(pkg.name);
      if (!r) continue;
      minX = Math.min(minX, r.x);
      maxX = Math.max(maxX, r.x + r.w);
      minY = Math.min(minY, r.y - 22);
      maxY = Math.max(maxY, r.y + r.h);
    }
    if (!Number.isFinite(minX)) return;
    const k = fitScale(W, H, pad, maxX - minX, maxY - minY);
    const target = { k, x: W / 2 - ((minX + maxX) / 2) * k, y: H / 2 - ((minY + maxY) / 2) * k };
    if (immediate) {
      Object.assign(view, target, { anim: null });
      return;
    }
    animateTo(target);
  }

  function animateTo(target, ms = 450) {
    const start = { ...view, anim: null };
    const t0 = performance.now();
    view.anim = () => {
      const t = Math.min(1, (performance.now() - t0) / ms);
      const e = 1 - Math.pow(1 - t, 3);
      view.k = Math.exp(Math.log(start.k) + (Math.log(target.k) - Math.log(start.k)) * e);
      view.x = start.x + (target.x - start.x) * e;
      view.y = start.y + (target.y - start.y) * e;
      if (t >= 1) view.anim = null;
    };
  }

  // ---------- state ----------

  const zoneVisible = zones.map(() => true);
  const enabledKinds = new Set([0, 1, 2]);
  let selected = null;
  let selectedZone = null;
  let hovered = null;
  let focusMode = false;
  let cycleMode = false;
  let edgeAlpha = 0.1;
  let labelMinIn = 45;
  let hideReachable = false;
  let focusNodes = new Set();
  let focusPairs = new Set();
  let visiblePairCount = 0;
  let dirty = true;

  function focusCycles() {
    ({ focusNodes, focusPairs } = visibleCycleFocus(raw.cycles || [], pairs, nodes, zoneVisible));
  }

  function focusSelection() {
    focusNodes.add(selected);
    for (const pi of nodePairs[selected]) {
      const p = pairs[pi];
      if (!pairVisible(p)) continue;
      focusPairs.add(pi);
      focusNodes.add(p.a);
      focusNodes.add(p.b);
    }
  }

  function focusZone() {
    for (const n of nodes) if (n.z === selectedZone) focusNodes.add(n.index);
    for (let i = 0; i < pairs.length; i++) {
      const p = pairs[i];
      if (pairVisible(p) && (nodes[p.a].z === selectedZone || nodes[p.b].z === selectedZone))
        focusPairs.add(i);
    }
  }

  function recomputeFocus() {
    focusNodes = new Set();
    focusPairs = new Set();
    if (cycleMode) focusCycles();
    else if (selected != null) focusSelection();
    else if (selectedZone != null) focusZone();
    dirty = true;
    updateStatus();
  }

  function pairVisible(p) {
    return p.display >= 0 && zoneVisible[nodes[p.a].z] && zoneVisible[nodes[p.b].z];
  }

  function applyFilters() {
    refreshPairKinds(pairs, enabledKinds, hideReachable);
    visiblePairCount = pairs.filter(pairVisible).length;
    if (selected != null && !zoneVisible[nodes[selected].z]) {
      selected = null;
    }
    if (selectedZone != null && !zoneVisible[selectedZone]) selectedZone = null;
    renderDetails();
    recomputeFocus();
    dirty = true;
  }

  // ---------- rendering ----------

  const pkgVisible = (name) => packages.get(name).zones.some((zi) => zoneVisible[zi]);

  function roundRect(c, x, y, w, h, r) {
    const rad = Math.min(r, w / 2, h / 2);
    c.beginPath();
    c.moveTo(x + rad, y);
    c.arcTo(x + w, y, x + w, y + h, rad);
    c.arcTo(x + w, y + h, x, y + h, rad);
    c.arcTo(x, y + h, x, y, rad);
    c.arcTo(x, y, x + w, y, rad);
    c.closePath();
  }

  function drawPackageZones(c) {
    for (const pkg of pkgList) {
      if (!pkgVisible(pkg.name) || pkg.zones.length < 2) continue;
      for (const zi of pkg.zones) drawZoneBox(c, zi, selectedZone === zi);
    }
  }

  function drawPackageLayer(c) {
    c.save();
    c.translate(view.x, view.y);
    c.scale(view.k, view.k);
    for (const pkg of pkgList) {
      if (!pkgVisible(pkg.name)) continue;
      const r = pkgRect.get(pkg.name);
      if (!r) continue;
      const active = selectedZone != null && pkg.zones.includes(selectedZone);
      c.fillStyle = hexAlpha(pkgColor(pkg), active ? 0.07 : 0.035);
      roundRect(c, r.x, r.y, r.w, r.h, 10);
      c.fill();
      c.strokeStyle = hexAlpha(pkgColor(pkg), active ? 0.6 : 0.3);
      c.lineWidth = (active ? 1.6 : 1) / view.k;
      c.stroke();
    }
    drawPackageZones(c);
    c.restore();
  }

  function drawZoneBox(c, zi, active) {
    const r = zoneRect[zi];
    if (!r || r.w < 30) return;
    c.strokeStyle = hexAlpha(zoneColor(zones[zi]), active ? 0.55 : 0.28);
    c.setLineDash([6 / view.k, 5 / view.k]);
    c.lineWidth = 1 / view.k;
    roundRect(c, r.x, r.y, r.w, r.h, 6);
    c.stroke();
    c.setLineDash([]);
  }

  function pkgColor(pkg) {
    const ranked = pkg.zones
      .map((zi) => zones[zi])
      .filter((z) => z.rank != null)
      .sort(bySize);
    if (ranked.length) return zoneColor(ranked[0]);
    return zoneColor(pkg.zones.map((zi) => zones[zi]).sort(bySize)[0]);
  }

  function hexAlpha(hex, a) {
    const v = Number.parseInt(hex.slice(1), 16);
    return `rgba(${(v >> 16) & 255},${(v >> 8) & 255},${v & 255},${a})`;
  }

  function edgeGroups() {
    const focusing = focusPairs.size > 0;
    const groups = new Map();
    for (let i = 0; i < pairs.length; i++) {
      const p = pairs[i];
      if (!pairVisible(p)) continue;
      const hot = focusing && focusPairs.has(i);
      const dim = focusing && !hot;
      const alpha = dim ? DIM_ALPHA : hot ? 0.9 : edgeAlpha;
      const g = `${p.display}|${alpha.toFixed(2)}`;
      let arr = groups.get(g);
      if (!arr) groups.set(g, (arr = []));
      arr.push(p);
    }
    return groups;
  }

  function drawEdges(c) {
    // any selection — node, zone, or cycle mode — lights up its own edges and dims the rest
    const groups = edgeGroups();
    for (const [g, arr] of groups) {
      const [kind, alpha] = g.split('|');
      c.strokeStyle = KIND_COLORS[kind];
      c.globalAlpha = Number(alpha);
      c.lineWidth = (alpha === '0.90' ? 1.7 : 1) / view.k;
      c.beginPath();
      for (const p of arr) {
        const s = nodes[p.a],
          t = nodes[p.b];
        c.moveTo(s.x, s.y);
        c.lineTo(t.x, t.y);
      }
      c.stroke();
    }
    c.globalAlpha = 1;
  }

  function drawBloom() {
    if (focusPairs.size === 0) return false;
    bctx.clearRect(0, 0, bloom.width, bloom.height);
    bctx.save();
    bctx.translate(view.x * BLOOM_SCALE, view.y * BLOOM_SCALE);
    bctx.scale(view.k * BLOOM_SCALE, view.k * BLOOM_SCALE);
    bctx.strokeStyle = 'rgba(255,240,190,0.45)';
    bctx.lineWidth = 2.4 / view.k;
    bctx.beginPath();
    for (const i of focusPairs) {
      const p = pairs[i];
      bctx.moveTo(nodes[p.a].x, nodes[p.a].y);
      bctx.lineTo(nodes[p.b].x, nodes[p.b].y);
    }
    bctx.stroke();
    // cycle mode marks membership; a selection keeps its own colours and only glows the edges
    if (cycleMode) {
      bctx.fillStyle = 'rgba(255,235,170,0.95)';
      for (const i of focusNodes) {
        const n = nodes[i];
        if (!focusNodes.has(i) || !zoneVisible[n.z]) continue;
        bctx.beginPath();
        bctx.arc(n.x, n.y, n.r * 1.4, 0, 7);
        bctx.fill();
      }
    }
    bctx.restore();
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'lighter';
    ctx.filter = `blur(${5 * dpr}px)`;
    ctx.globalAlpha = 0.8;
    ctx.drawImage(bloom, 0, 0, canvas.width, canvas.height);
    ctx.restore();
    return true;
  }

  function drawEntryNodes(c, focusing) {
    // entry points sit on the package border, so they draw last and read as ports
    for (const n of nodes) {
      if (n.entry == null || !zoneVisible[n.z]) continue;
      const dim = focusing && !focusNodes.has(n.index);
      const r = Math.max(ENTRY_R, n.r) / Math.max(0.55, Math.sqrt(view.k));
      c.globalAlpha = dim ? 0.12 : 1;
      c.beginPath();
      c.arc(n.x, n.y, r, 0, 7);
      c.fillStyle = hexAlpha(zoneColor(zones[n.z]), 0.95);
      c.fill();
      c.lineWidth = 1.3 / view.k;
      c.strokeStyle = dim ? 'rgba(255,255,255,0.15)' : 'rgba(255,255,255,0.8)';
      c.stroke();
    }
  }

  function drawNodes(c) {
    // node dimming stays opt-in; edge highlighting follows any selection
    const focusing = (focusMode || cycleMode) && focusNodes.size > 0;
    for (const n of nodes) {
      if (!zoneVisible[n.z] || n.entry != null) continue;
      const dim = focusing && !focusNodes.has(n.index);
      c.globalAlpha = dim ? 0.1 : 1;
      c.beginPath();
      c.arc(n.x, n.y, n.r, 0, 7);
      c.fillStyle = hexAlpha(zoneColor(zones[n.z]), 0.85);
      c.fill();
      if (n.fx != null) {
        c.strokeStyle = 'rgba(255,255,255,0.7)';
        c.lineWidth = 1.4 / view.k;
        c.stroke();
      }
    }
    drawEntryNodes(c, focusing);
    c.globalAlpha = 1;
    if (selected != null && zoneVisible[nodes[selected].z]) {
      const n = nodes[selected];
      c.beginPath();
      c.arc(n.x, n.y, n.r + 4 / view.k, 0, 7);
      c.strokeStyle = '#fff';
      c.lineWidth = 1.6 / view.k;
      c.stroke();
    }
    if (hovered != null && hovered !== selected) {
      const n = nodes[hovered];
      c.beginPath();
      c.arc(n.x, n.y, n.r + 3 / view.k, 0, 7);
      c.strokeStyle = 'rgba(255,255,255,0.55)';
      c.lineWidth = 1.2 / view.k;
      c.stroke();
    }
  }

  function drawZoneLabels(c, pkg) {
    if (pkg.zones.length < 2) return;
    c.font = '600 10px ui-monospace, Menlo, monospace';
    for (const zi of pkg.zones) {
      const zr = zoneRect[zi];
      const zx = zr.x * view.k + view.x + 5;
      const zy = zr.y * view.k + view.y + 12;
      if (zr.w * view.k < 52 || zr.h * view.k < 18) continue;
      if (zx > W || zy > H || zx < -150 || zy < -12) continue;
      c.fillStyle =
        selectedZone === zi ? 'rgba(255,255,255,0.95)' : hexAlpha(zoneColor(zones[zi]), 0.9);
      c.fillText(clipText(c, zones[zi].id, zr.w * view.k - 10), zx, zy);
    }
  }

  function drawPackageHeading(c, pkg, sx, sy, wpx, active, count) {
    if (wpx > 90) {
      const withCount = wpx > 260;
      c.font = '10px ui-monospace, Menlo, monospace';
      const countW = c.measureText(count).width;
      c.font = '700 11.5px ui-monospace, Menlo, monospace';
      const name = clipText(c, pkg.name, wpx - 12 - (withCount ? countW + 8 : 0));
      const nameW = c.measureText(name).width;
      c.fillStyle = active ? 'rgba(255,255,255,0.95)' : 'rgba(215,220,230,0.85)';
      c.fillText(name, sx + 2, sy - 7);
      if (withCount) {
        c.font = '10px ui-monospace, Menlo, monospace';
        c.fillStyle = 'rgba(139,147,167,0.75)';
        c.fillText(count, sx + 2 + nameW + 8, sy - 7);
      }
    }
  }

  function drawPackageLabel(c, pkg) {
    if (!pkgVisible(pkg.name)) return;
    const r = pkgRect.get(pkg.name);
    if (!r) return;
    const sx = r.x * view.k + view.x;
    const sy = r.y * view.k + view.y;
    const wpx = r.w * view.k;
    const hpx = r.h * view.k;
    if (sx > W || sy > H || sx + wpx < 0 || sy + hpx < 0) return;
    const active = selectedZone != null && pkg.zones.includes(selectedZone);
    const count = `${pkg.zones.reduce((s, zi) => s + zones[zi].files, 0)} files`;
    drawPackageHeading(c, pkg, sx, sy, wpx, active, count);
    drawZoneLabels(c, pkg);
  }

  function drawPackageLabels(c) {
    for (const pkg of pkgList) drawPackageLabel(c, pkg);
  }

  function drawFileLabel(c, n) {
    if (!zoneVisible[n.z] || n.in < labelMinIn || n.entry != null) return;
    if (focusNodes.size && !focusNodes.has(n.index)) return;
    const sx = n.x * view.k + view.x;
    const sy = n.y * view.k + view.y;
    if (sx < 0 || sy < 0 || sx > W || sy > H) return;
    c.fillText(n.id.split('/').pop(), sx, sy - n.r * view.k - 4);
  }

  function drawFileLabels(c) {
    if (view.k > 0.5 || labelMinIn <= 8) {
      c.font = '10px ui-monospace, Menlo, monospace';
      c.fillStyle = 'rgba(215,220,230,0.75)';
      c.textAlign = 'center';
      for (const n of nodes) drawFileLabel(c, n);
    }
  }

  function drawEntryLabel(c, n) {
    if (n.entry == null || !zoneVisible[n.z]) return;
    if ((focusMode || cycleMode) && focusNodes.size > 0 && !focusNodes.has(n.index)) return;
    const sx = n.x * view.k + view.x;
    const sy = n.y * view.k + view.y;
    if (sx < -80 || sy < -12 || sx > W + 80 || sy > H + 12) return;
    c.fillStyle = hexAlpha(zoneColor(zones[n.z]), 0.95);
    c.fillText(n.entry, sx, sy - Math.max(ENTRY_R, n.r) - 5);
  }

  function drawEntryLabels(c) {
    if (view.k > 1.15) {
      c.font = '9.5px ui-monospace, Menlo, monospace';
      c.textAlign = 'center';
      for (const n of nodes) drawEntryLabel(c, n);
    }
  }

  function drawLabels(c) {
    c.save();
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.textAlign = 'left';
    drawPackageLabels(c);
    drawFileLabels(c);
    drawEntryLabels(c);
    c.restore();
  }

  function clipText(c, text, maxW) {
    if (c.measureText(text).width <= maxW) return text;
    let cut = text.length;
    while (cut > 1 && c.measureText(text.slice(0, cut) + '…').width > maxW) cut--;
    return text.slice(0, cut) + '…';
  }

  function render() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0d1017';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawPackageLayer(ctx);
    ctx.save();
    ctx.translate(view.x, view.y);
    ctx.scale(view.k, view.k);
    drawEdges(ctx);
    ctx.restore();
    if (drawBloom()) {
      /* bloom already composited additively */
    }
    ctx.save();
    ctx.translate(view.x, view.y);
    ctx.scale(view.k, view.k);
    drawNodes(ctx);
    ctx.restore();
    drawLabels(ctx);
  }

  // ---------- interaction ----------

  let drag = null;
  const tooltip = document.getElementById('tooltip');

  function nodeAt(sx, sy) {
    const w = toWorld(sx, sy);
    let best = null,
      bestD = 16 / view.k;
    for (const n of nodes) {
      if (!zoneVisible[n.z]) continue;
      const dx = n.x - w.x,
        dy = n.y - w.y;
      const d = Math.sqrt(dx * dx + dy * dy) - n.r;
      if (d < bestD) {
        bestD = d;
        best = n;
      }
    }
    return best;
  }

  function zoneAt(sx, sy) {
    const w = toWorld(sx, sy);
    let best = null,
      bestArea = Infinity;
    for (const z of zones) {
      if (!zoneVisible[z.index]) continue;
      const r = zoneRect[z.index];
      if (w.x < r.x || w.x > r.x + r.w || w.y < r.y || w.y > r.y + r.h) continue;
      const area = r.w * r.h;
      if (area < bestArea) {
        bestArea = area;
        best = z.index;
      }
    }
    return best;
  }

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    const n = nodeAt(e.offsetX, e.offsetY);
    if (n) drag = { mode: 'node', node: n, moved: false };
    else drag = { mode: 'pan', x: e.offsetX, y: e.offsetY, vx: view.x, vy: view.y, moved: false };
  });

  canvas.addEventListener('pointermove', (e) => {
    if (drag) {
      if (drag.mode === 'pan') {
        view.x = drag.vx + (e.offsetX - drag.x);
        view.y = drag.vy + (e.offsetY - drag.y);
        if (Math.abs(e.movementX) + Math.abs(e.movementY) > 1) drag.moved = true;
        canvas.classList.add('panning');
      } else {
        const w = toWorld(e.offsetX, e.offsetY);
        drag.node.fx = w.x;
        drag.node.fy = w.y;
        drag.moved = true;
        reheat(0.25);
      }
      dirty = true;
      return;
    }
    const n = nodeAt(e.offsetX, e.offsetY);
    hovered = n ? n.index : null;
    if (n) {
      const z = zones[n.z];
      tooltip.style.display = 'block';
      tooltip.style.left = Math.min(W - 430, e.offsetX + 14) + 'px';
      tooltip.style.top = e.offsetY + 14 + 'px';
      tooltip.innerHTML =
        `${escapeHtml(n.id)}<br><span class="t-zone">${escapeHtml(z.id)}${z.rank != null ? ' · rank ' + z.rank : ''}` +
        ` · ${n.loc} loc · in ${n.in} · out ${n.out} · level ${n.lvl}` +
        `${n.cyc >= 0 ? ' · cycle ' + n.cyc : ''}</span>`;
    } else {
      tooltip.style.display = 'none';
    }
    dirty = true;
  });

  canvas.addEventListener('pointercancel', () => {
    drag = null;
    canvas.classList.remove('panning');
    dirty = true;
  });

  canvas.addEventListener('pointerup', (e) => {
    canvas.classList.remove('panning');
    if (!drag) return;
    if (drag.mode === 'node' && !drag.moved) {
      drag.node.fx = drag.node.fy = null;
      select(selected === drag.node.index ? null : drag.node.index);
    } else if (drag.mode === 'pan' && !drag.moved) {
      const z = zoneAt(e.offsetX, e.offsetY);
      selected = null;
      selectedZone = z === null || z === selectedZone ? null : z;
      recomputeFocus();
      renderDetails();
    }
    if (drag.mode === 'node') reheat(0.15);
    drag = null;
    dirty = true;
  });

  canvas.addEventListener('dblclick', (e) => {
    const n = nodeAt(e.offsetX, e.offsetY);
    if (n) {
      const k = Math.max(view.k, 1.4);
      animateTo({ k, x: W / 2 - n.x * k, y: H / 2 - n.y * k });
      select(n.index);
    } else {
      fitView();
    }
  });

  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * 0.0014);
      const k = Math.min(12, Math.max(0.02, view.k * factor));
      const w = toWorld(e.offsetX, e.offsetY);
      view.k = k;
      view.x = e.offsetX - w.x * k;
      view.y = e.offsetY - w.y * k;
      view.anim = null;
      dirty = true;
    },
    { passive: false },
  );

  window.addEventListener('keydown', (e) => {
    if (e.target.closest('input, select, textarea, button, [contenteditable="true"]')) return;
    if (e.key === 'f' || e.key === 'F') fitView();
    if (e.key === 'l' || e.key === 'L') {
      labelMinIn = labelMinIn > 1 ? 1 : 45;
      labelMin.value = labelMinIn;
      dirty = true;
    }
    if (e.key === 'Escape') {
      select(null);
      selectedZone = null;
      recomputeFocus();
    }
  });

  function select(index) {
    selected = index;
    selectedZone = null;
    recomputeFocus();
    renderDetails();
  }

  // ---------- UI ----------

  const statsEl = document.getElementById('stats');
  const statusEl = document.getElementById('status');
  const searchInput = document.getElementById('search');
  const labelMin = document.getElementById('labelMin');

  function totalEdges() {
    return raw.edges.length;
  }
  statsEl.textContent = `${nodes.length} files · ${totalEdges()} edges · ${zones.length} zones · ${raw.generated.commit}`;

  function buildZoneList() {
    const el = document.getElementById('zones');
    const sorted = [...zones].sort((a, b) => b.files - a.files);
    el.innerHTML = sorted
      .map(
        (z) => `
      <div class="row" data-zone="${z.index}">
        <input type="checkbox" id="z${z.index}" checked />
        <span class="swatch" style="background:${zoneColor(z)}"></span>
        <label for="z${z.index}">${escapeHtml(z.id)}${z.rank != null ? ` <span class="count">r${z.rank}</span>` : ''}</label>
        <span class="count">${z.files}</span>
      </div>`,
      )
      .join('');
    el.addEventListener('change', (e) => {
      const row = e.target.closest('.row');
      const zi = Number(row.dataset.zone);
      zoneVisible[zi] = e.target.checked;
      row.classList.toggle('dim', !e.target.checked);
      applyFilters();
      updateStatus();
    });
    el.addEventListener('click', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'LABEL') return;
      const row = e.target.closest('.row');
      if (!row) return;
      const zi = Number(row.dataset.zone);
      selectedZone = selectedZone === zi ? null : zi;
      selected = null;
      recomputeFocus();
      renderDetails();
    });
  }

  function buildKindList() {
    const el = document.getElementById('kinds');
    el.innerHTML = KIND_NAMES.map(
      (name, k) => `
      <div class="row"><input type="checkbox" id="k${k}" checked />
      <span class="swatch" style="background:${KIND_COLORS[k]}"></span>
      <label for="k${k}">${name} imports</label></div>`,
    ).join('');
    el.addEventListener('change', (e) => {
      const k = Number(e.target.id.slice(1));
      if (e.target.checked) enabledKinds.add(k);
      else enabledKinds.delete(k);
      e.target.closest('.row').classList.toggle('dim', !e.target.checked);
      applyFilters();
      recomputeFocus();
      updateStatus();
      reheat(0.3);
    });
  }

  function updateStatus() {
    statusEl.textContent =
      focusNodes.size > 0
        ? `${focusNodes.size} files in focus · ${focusPairs.size} edges highlighted`
        : `${nodes.length} files · ${visiblePairCount} file-pair edges shown`;
  }

  function kindBadge(k) {
    return `<span class="kind" style="background:${hexAlpha(KIND_COLORS[k], 0.25)};color:${KIND_COLORS[k]}">${KIND_NAMES[k]}</span>`;
  }

  function renderDetails() {
    const el = document.getElementById('details');
    if (selected == null && selectedZone == null) {
      el.innerHTML =
        '<h2>Selection</h2><div class="hint">Click a node to inspect its dependencies, or a zone label to isolate one.</div>';
      return;
    }
    if (selected == null) {
      const z = zones[selectedZone];
      el.innerHTML =
        `<h2>Zone · ${escapeHtml(z.id)}</h2><div class="meta">${escapeHtml(z.classification)}` +
        `${z.rank != null ? ` · rank ${z.rank}` : ''} · ${z.files} files · ${z.loc} loc</div>`;
      return;
    }
    const n = nodes[selected];
    const out = [],
      inc = [];
    for (const pi of nodePairs[selected]) {
      const p = pairs[pi];
      if (!pairVisible(p)) continue;
      if (p.a === selected) out.push([p.b, p]);
      else inc.push([p.a, p]);
    }
    const list = (items, dir) =>
      items
        .map(([i, p]) => {
          const kinds = kindBadge(p.kind);
          return `<div class="dep" data-node="${i}">${dir === 'out' ? '→ ' : '← '}${escapeHtml(nodes[i].id)}${kinds}</div>`;
        })
        .join('');
    el.innerHTML = `<h2>Selection</h2>
      <div class="file">${escapeHtml(n.id)}</div>
      <div class="meta">${escapeHtml(zones[n.z].id)} · ${n.loc} loc · fan-in ${n.in} · fan-out ${n.out} · level ${n.lvl}${n.cyc >= 0 ? ` · in cycle ${n.cyc}` : ''}</div>
      <h3>Imports (${out.length})</h3>${out.length ? list(out, 'out') : '<div class="hint">none</div>'}
      <h3>Imported by (${inc.length})</h3>${inc.length ? list(inc, 'in') : '<div class="hint">none</div>'}`;
  }

  document.getElementById('details').addEventListener('click', (e) => {
    const row = e.target.closest('.dep');
    if (!row) return;
    const idx = Number(row.dataset.node);
    select(idx);
    const k = Math.max(view.k, 1);
    animateTo({ k, x: W / 2 - nodes[idx].x * k, y: H / 2 - nodes[idx].y * k });
  });

  function buildSearch() {
    const dl = document.getElementById('files');
    // 1853 <option> nodes make the page hostile to assistive tech and automation, so the list is
    // filled from what is typed and capped; the full node set stays searchable by Enter.
    const fill = (q) => {
      const needle = q.trim().toLowerCase();
      const hits = needle
        ? nodes.filter((n) => n.id.includes(needle)).slice(0, 60)
        : nodes.slice(0, 0);
      dl.innerHTML = hits.map((n) => `<option value="${escapeHtml(n.id)}">`).join('');
    };
    searchInput.addEventListener('input', () => fill(searchInput.value));
    searchInput.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const q = searchInput.value.trim().toLowerCase();
      if (!q) return;
      const hit =
        nodes.find((n) => n.id === searchInput.value) ||
        nodes.find((n) => n.id.toLowerCase().includes(q));
      if (hit) {
        select(hit.index);
        const k = Math.max(view.k, 1.2);
        animateTo({ k, x: W / 2 - hit.x * k, y: H / 2 - hit.y * k });
      }
    });
  }

  document.getElementById('edgeAlpha').addEventListener('input', (e) => {
    edgeAlpha = Number(e.target.value) / 100;
    dirty = true;
  });
  labelMin.addEventListener('input', (e) => {
    labelMinIn = Number(e.target.value);
    dirty = true;
  });
  document.getElementById('focus').addEventListener('change', (e) => {
    focusMode = e.target.checked;
    recomputeFocus();
    updateStatus();
  });
  document.getElementById('cycles').addEventListener('change', (e) => {
    cycleMode = e.target.checked;
    recomputeFocus();
    updateStatus();
  });
  document.getElementById('reachable').addEventListener('change', (e) => {
    hideReachable = e.target.checked;
    applyFilters();
    reheat(0.3);
  });
  document.getElementById('spread').addEventListener('input', (e) => {
    spread = Number(e.target.value);
    placeLayout(spread);
    reheat(0.8);
  });
  document.getElementById('reheat').addEventListener('click', () => reheat(1));
  document.getElementById('fit').addEventListener('click', () => fitView());

  // ---------- boot ----------

  resize();
  buildZoneList();
  buildKindList();
  buildSearch();
  buildAnalysis({
    nodes,
    raw,
    zones,
    zoneColor,
    hexAlpha,
    selectNode: (idx) => {
      select(idx);
      const k = Math.max(view.k, 1);
      animateTo({ k, x: W / 2 - nodes[idx].x * k, y: H / 2 - nodes[idx].y * k });
    },
    selectZone: (zi) => {
      selected = null;
      selectedZone = selectedZone === zi ? null : zi;
      recomputeFocus();
      renderDetails();
    },
  });
  placeLayout(spread, true);
  seedPositions();
  applyFilters();
  updateStatus();

  // boxes are fixed, so settle the packing forces before the first paint
  sim.alpha = 1;
  for (let i = 0; i < 520; i++) tick();
  sim.alpha = sim.targetAlpha;

  function loop() {
    if (sim.alpha > sim.targetAlpha * 1.02) {
      tick();
      tick();
      dirty = true;
    }
    if (view.anim) {
      view.anim();
      dirty = true;
    }
    if (dirty) {
      render();
      if (!view.anim && sim.alpha <= sim.targetAlpha * 1.02 && drag === null) dirty = false;
    }
    requestAnimationFrame(loop);
  }
  fitView(70, true);
  dirty = true;
  render();
  requestAnimationFrame(loop);
})();
