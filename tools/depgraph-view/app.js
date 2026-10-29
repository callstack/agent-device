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
    const [graphResponse, entriesResponse] = await Promise.all([
      fetch('/dependency-graph/graph.json'),
      fetch('/dependency-graph/entries.json'),
    ]);
    if (!graphResponse.ok || !entriesResponse.ok) throw new Error('Graph data unavailable');
    [raw, entryManifest] = await Promise.all([graphResponse.json(), entriesResponse.json()]);
  } catch {
    document.getElementById('stats').textContent = 'Could not load the graph. Reload to try again.';
    return;
  }

  // ---------- graph model ----------

  const zones = raw.zones.map((z, i) => ({ ...z, index: i }));
  const nodes = raw.nodes.map((n, i) => ({
    ...n,
    index: i,
    r: 2.5 + Math.min(12, Math.sqrt(n.in + n.out) * 0.55),
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    fx: null,
    fy: null,
    entry: null,
    slot: null,
  }));

  // collapse parallel file-pair edges so all three kinds of a pair stay one drawable line
  const pairMap = new Map();
  for (const [a, b, kind, flags] of raw.edges) {
    const key = a < b ? a * nodes.length + b : b * nodes.length + a;
    let pair = pairMap.get(key);
    if (!pair) {
      pair = { a, b, counts: [0, 0, 0], redundantValue: 0, display: -1 };
      pairMap.set(key, pair);
    }
    pair.counts[kind]++;
    // bit 2: the target is also reachable at distance >= 2, which the graph sets on value edges
    // only because the transitive reduction that defines it is undefined on a value cycle
    if (kind === 0 && flags & 2) pair.redundantValue++;
  }
  const pairs = [...pairMap.values()];
  const nodePairs = nodes.map(() => []);
  pairs.forEach((p, i) => {
    nodePairs[p.a].push(i);
    nodePairs[p.b].push(i);
  });

  function refreshPairKinds(enabledKinds) {
    for (const p of pairs) {
      p.display = -1;
      for (const k of [0, 1, 2]) {
        if (p.counts[k] <= 0 || !enabledKinds.has(k)) continue;
        // a value edge the transitive reduction already dropped
        if (hideRedundant && k === 0 && p.redundantValue === p.counts[0]) continue;
        p.display = k;
        break;
      }
    }
  }

  // ---------- workspace packages: one rectangle each, subdivided by its zones ----------

  const ROOT_PKG = 'src (agent-device)';
  const pkgOfId = (id) => {
    const m = /^packages\/([^/]+)\//.exec(id);
    return m ? `packages/${m[1]}` : ROOT_PKG;
  };

  const hubs = zones.map((z, i) => ({ x: 0, y: 0, zone: i }));
  const zoneRect = zones.map(() => ({ x: 0, y: 0, w: 0, h: 0 }));
  const zoneNeighbors = zones.map(() => new Map());
  const firstNodeOfZone = zones.map(() => null);
  for (const n of nodes) if (firstNodeOfZone[n.z] === null) firstNodeOfZone[n.z] = n.id;
  const pkgOfZone = zones.map((z, i) => pkgOfId(firstNodeOfZone[i]));

  const packages = new Map();
  zones.forEach((z) => {
    const name = pkgOfZone[z.index];
    if (!packages.has(name)) packages.set(name, { name, zones: [] });
    packages.get(name).zones.push(z.index);
  });
  const pkgList = [...packages.values()];
  const pkgRect = new Map();
  // declared package.json exports are the boundary every cross-package edge already lands on,
  // so those files become the package's entry points and ride its perimeter
  const entryNodes = new Map();
  for (const [pkgName, list] of Object.entries(entryManifest)) {
    if (!packages.has(pkgName)) continue;
    for (const { id, subpath } of list) {
      const idx = nodes.findIndex((n) => n.id === id);
      if (idx < 0 || nodes[idx].entry) continue;
      nodes[idx].entry = subpath;
      if (!entryNodes.has(pkgName)) entryNodes.set(pkgName, []);
      entryNodes.get(pkgName).push(idx);
    }
  }
  for (const list of entryNodes.values())
    list.sort((a, b) => nodes[a].entry.localeCompare(nodes[b].entry) || a - b);

  for (const [a, b] of raw.edges) {
    const za = nodes[a].z,
      zb = nodes[b].z;
    if (za === zb) continue;
    zoneNeighbors[za].set(zb, (zoneNeighbors[za].get(zb) || 0) + 1);
    zoneNeighbors[zb].set(za, (zoneNeighbors[zb].get(za) || 0) + 1);
  }
  const bySize = (a, b) => b.files - a.files || a.index - b.index;
  const ranks = zones.filter((z) => z.rank != null).map((z) => z.rank);
  const minRank = Math.min(...ranks);
  const maxRank = Math.max(...ranks);

  // ranked zones keep their rank; unranked ones inherit the weighted mean rank of ranked
  // neighbours, so a package sits at the layer its imports actually live in
  const bandOfZone = (z) => {
    if (z.rank != null) return z.rank;
    let sum = 0,
      wsum = 0;
    for (const [nb, w] of zoneNeighbors[z.index]) {
      if (zones[nb].rank != null) {
        sum += zones[nb].rank * w;
        wsum += w;
      }
    }
    const mean = wsum ? sum / wsum : (minRank + maxRank) / 2;
    return Math.max(minRank, Math.min(maxRank, Math.round(mean)));
  };
  const zoneBand = zones.map(bandOfZone);

  /** Squarified treemap: lays `items` into `rect` so each box's area is `area(item)`. */
  function treemap(items, rect, area, put) {
    if (!items.length) return;
    const total = items.reduce((sum, i) => sum + area(i), 0);
    if (total <= 0) return;
    let { x, y, w, h } = rect;
    const scale = (w * h) / total;
    let i = 0;
    const worst = (row, side) => {
      let sum = 0,
        max = 0,
        min = Infinity;
      for (const it of row) {
        const a = area(it) * scale;
        sum += a;
        max = Math.max(max, a);
        min = Math.min(min, a);
      }
      return Math.max((side * side * max) / (sum * sum), (sum * sum) / (side * side * min));
    };
    while (i < items.length) {
      const side = Math.min(w, h);
      const row = [items[i++]];
      while (i < items.length && worst(row, side) >= worst([...row, items[i]], side))
        row.push(items[i++]);
      const rowArea = row.reduce((sum, it) => sum + area(it), 0) * scale;
      if (w >= h) {
        const rw = rowArea / h;
        let ry = y;
        for (const it of row) {
          const rh = (area(it) * scale) / rw;
          put(it, x, ry, rw, rh);
          ry += rh;
        }
        x += rw;
        w -= rw;
      } else {
        const rh = rowArea / w;
        let rx = x;
        for (const it of row) {
          const rw = (area(it) * scale) / rh;
          put(it, rx, y, rw, rh);
          rx += rw;
        }
        y += rh;
        h -= rh;
      }
    }
  }

  const ZONE_GAP = 6;
  const ENTRY_R = 4;

  /** Perimeter a package needs to seat its entry dots with a visible gap between them. */
  function ringArc(pkg) {
    const list = entryNodes.get(pkg.name);
    if (!list) return 0;
    return list.reduce((sum, idx) => sum + 2 * Math.max(ENTRY_R, nodes[idx].r) + 10, 0);
  }

  /** Point at arc-length fraction `t` walking the rectangle clockwise from its top-left. */
  function perimeterPoint(r, t) {
    const perim = 2 * (r.w + r.h) || 1;
    let d = (((t % 1) + 1) % 1) * perim;
    if (d < r.w) return { x: r.x + d, y: r.y };
    d -= r.w;
    if (d < r.h) return { x: r.x + r.w, y: r.y + d };
    d -= r.h;
    if (d < r.w) return { x: r.x + r.w - d, y: r.y + r.h };
    d -= r.w;
    return { x: r.x, y: r.y + r.h - d };
  }

  function placeRing(pkg, rect) {
    const list = entryNodes.get(pkg.name);
    if (!list || !list.length) return;
    // start on the top edge, centred, so the ring reads left-to-right by subpath
    const start = rect.w / 2 / (2 * (rect.w + rect.h));
    list.forEach((idx, i) => {
      const p = perimeterPoint(rect, start + i / list.length);
      nodes[idx].slot = { x: p.x, y: p.y };
    });
  }

  function placeLayout(spread, snap = false) {
    const s = spread / 14;
    const areaOfZone = (zi) => Math.max(9000, zones[zi].files * 1700 * s * s);
    // a package holding several zones needs slack so the inner tiles stay readable
    const areaOfPkg = (pkg) =>
      pkg.zones.reduce((sum, zi) => sum + areaOfZone(zi), 0) +
      (pkg.zones.length > 1 ? 7500 * s : 0);

    // total area drives the band width; bands themselves decide the vertical extent
    const totalArea = pkgList.reduce((sum, p) => sum + areaOfPkg(p), 0);
    const rowWidth = Math.sqrt(totalArea * 2.2) * (0.7 + 0.3 * s);

    // packages are grouped into horizontal bands so the stack reads top-down by layer.
    // Within a band every package shares one height and gets the width its area needs,
    // floored at a label-readable width so a small package never becomes a sliver.
    const pkgBand = (pkg) => {
      let sum = 0,
        wsum = 0;
      for (const zi of pkg.zones) {
        sum += zoneBand[zi] * zones[zi].files;
        wsum += zones[zi].files;
      }
      return sum / wsum;
    };
    const minPkgWidth = 210 * s;
    const estWidth = (pkg) => Math.max(minPkgWidth, ringArc(pkg) / 2) + Math.sqrt(areaOfPkg(pkg));
    const bandRows = [];
    let bandRow = [],
      bandEst = 0;
    for (const pkg of [...pkgList].sort(
      (a, b) => pkgBand(b) - pkgBand(a) || areaOfPkg(b) - areaOfPkg(a),
    )) {
      if (bandRow.length && bandEst + estWidth(pkg) > rowWidth) {
        bandRows.push(bandRow);
        bandRow = [];
        bandEst = 0;
      }
      bandRow.push(pkg);
      bandEst += estWidth(pkg);
    }
    if (bandRow.length) bandRows.push(bandRow);

    function putZone(zi, x, y, w, h) {
      // never grow a tile past its slot: an enlarged box would spill out of the package
      zoneRect[zi] = {
        x: x + ZONE_GAP / 2,
        y: y + ZONE_GAP / 2,
        w: Math.max(2, w - ZONE_GAP),
        h: Math.max(2, h - ZONE_GAP),
      };
      hubs[zi].tx = zoneRect[zi].x + zoneRect[zi].w / 2;
      hubs[zi].ty = zoneRect[zi].y + zoneRect[zi].h / 2;
    }
    function putPkg(pkg, x, y, w, h) {
      pkgRect.set(pkg.name, { x, y, w, h });
      const inset = entryNodes.get(pkg.name)?.length ? 26 * s : 7;
      const inner = {
        x: x + inset,
        y: y + inset,
        w: Math.max(20, w - inset * 2),
        h: Math.max(20, h - inset * 2),
      };
      if (pkg.zones.length === 1) {
        putZone(pkg.zones[0], inner.x, inner.y, inner.w, inner.h);
      } else {
        const list = pkg.zones
          .slice()
          .sort((a, b) => zoneBand[b] - zoneBand[a] || bySize(zones[a], zones[b]));
        treemap(list, inner, areaOfZone, putZone);
      }
      placeRing(pkg, { x, y, w, h });
    }

    const rowGap = 68 * s;
    let y = 0;
    for (const row of bandRows) {
      const area = row.reduce((sum, p) => sum + areaOfPkg(p), 0);
      // One shared height per band. A package widens with its area, but never below the label
      // floor, and never below what its entry ring needs: perimeter 2*(w+h) must seat every dot.
      const need = (pkg, h) =>
        Math.max(minPkgWidth, areaOfPkg(pkg) / h, (ringArc(pkg) * 1.25) / 2 - h);
      let lo = area / (rowWidth * 4),
        hi = area / (row.length * minPkgWidth);
      for (let i = 0; i < 40; i++) {
        const mid = (lo + hi) / 2;
        const used = row.reduce((sum, p) => sum + need(p, mid), 0);
        if (used > rowWidth) lo = mid;
        else hi = mid;
      }
      const height = Math.max(150 * s, (lo + hi) / 2);
      const widths = row.map((p) => need(p, height));
      const total = widths.reduce((a, b) => a + b, 0);
      let x = -total / 2;
      row.forEach((pkg, i) => {
        putPkg(pkg, x, y, widths[i], height);
        x += widths[i];
      });
      y += height + rowGap;
    }

    if (snap)
      for (const z of zones) {
        hubs[z.index].x = hubs[z.index].tx;
        hubs[z.index].y = hubs[z.index].ty;
      }
  }

  function seedPositions() {
    for (const n of nodes) {
      if (n.entry != null) {
        if (n.slot) {
          n.x = n.slot.x;
          n.y = n.slot.y;
        }
        continue;
      }
      const r = zoneRect[n.z];
      const pad = Math.min(n.r + 3, r.w / 2 - 0.5, r.h / 2 - 0.5);
      n.x = r.x + pad + Math.random() * Math.max(0.1, r.w - pad * 2);
      n.y = r.y + pad + Math.random() * Math.max(0.1, r.h - pad * 2);
    }
  }

  function zoneColor(z) {
    if (z.classification !== 'ranked') return PALETTE[z.index % PALETTE.length];
    const t = (z.rank - minRank) / Math.max(1, maxRank - minRank);
    const hue = 225 - t * 155;
    return hsl(hue, 72, 64);
  }

  function hsl(h, s, l) {
    l /= 100;
    const a = (s * Math.min(l, 1 - l)) / 100;
    const f = (n) => {
      const k = (n + h / 30) % 12;
      const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
      return Math.round(255 * c);
    };
    const hex = (v) => v.toString(16).padStart(2, '0');
    return `#${hex(f(0))}${hex(f(8))}${hex(f(4))}`;
  }

  // ---------- force simulation ----------

  const sim = { alpha: 1, targetAlpha: 0.02, alphaDecay: 0.9825, running: true };
  let spread = 14;

  function tick() {
    const a = sim.alpha;
    const cell = 30;
    const grid = new Map();
    for (const n of nodes) {
      const key = Math.floor(n.x / cell) + ':' + Math.floor(n.y / cell);
      let bucket = grid.get(key);
      if (!bucket) grid.set(key, (bucket = []));
      bucket.push(n);
    }
    for (const n of nodes) {
      const gx = Math.floor(n.x / cell);
      const gy = Math.floor(n.y / cell);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const bucket = grid.get(gx + dx + ':' + (gy + dy));
          if (!bucket) continue;
          for (const m of bucket) {
            if (m === n) continue;
            let ddx = n.x - m.x,
              ddy = n.y - m.y;
            let d2 = ddx * ddx + ddy * ddy;
            if (d2 > cell * cell * 2 || d2 === 0) {
              if (d2 === 0) {
                ddx = (Math.random() - 0.5) * 2;
                ddy = (Math.random() - 0.5) * 2;
                d2 = 4;
              } else continue;
            }
            const ideal = n.r + m.r + 6;
            if (d2 < ideal * ideal * 6) {
              const d = Math.sqrt(d2);
              const push = ((ideal * 3 - d) / d) * 0.08 * a;
              n.vx += ddx * push;
              n.vy += ddy * push;
            }
          }
        }
      }
    }
    for (const p of pairs) {
      if (p.display < 0) continue;
      const s = nodes[p.a],
        t = nodes[p.b];
      // boxes are fixed, so only edges that can be honoured inside one package steer the layout
      if (pkgOfZone[s.z] !== pkgOfZone[t.z]) continue;
      const dx = t.x - s.x,
        dy = t.y - s.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const ideal = s.r + t.r + 30;
      const k = (((d - ideal) / d) * 0.045 * a) / Math.min(s.out + s.in, t.out + t.in);
      s.vx += dx * k;
      s.vy += dy * k;
      t.vx -= dx * k;
      t.vy -= dy * k;
    }
    for (const z of zones) {
      const hub = hubs[z.index];
      const r = zoneRect[z.index];
      hub.x = r.x + r.w / 2;
      hub.y = r.y + r.h / 2;
    }
    for (const n of nodes) {
      // entry points ride the package perimeter, not the interior zone tile
      if (n.entry != null) {
        if (n.slot) {
          n.x = n.slot.x;
          n.y = n.slot.y;
        }
        n.vx = 0;
        n.vy = 0;
        continue;
      }
      const r = zoneRect[n.z];
      const pad = Math.min(n.r + 3, r.w / 2 - 0.5, r.h / 2 - 0.5);
      const clampX = (v) => Math.max(r.x + pad, Math.min(r.x + r.w - pad, v));
      const clampY = (v) => Math.max(r.y + pad, Math.min(r.y + r.h - pad, v));
      if (n.fx != null) {
        n.fx = clampX(n.fx);
        n.fy = clampY(n.fy);
        n.x = n.fx;
        n.y = n.fy;
        n.vx = 0;
        n.vy = 0;
        continue;
      }
      // walls contain the cluster, so gravity stays negligible and packing fills the box
      const hub = hubs[n.z];
      n.vx += (hub.x - n.x) * 0.0015 * a;
      n.vy += (hub.y - n.y) * 0.0015 * a;
      n.vx = Math.max(-30, Math.min(30, n.vx * 0.82));
      n.vy = Math.max(-30, Math.min(30, n.vy * 0.82));
      n.x = clampX(n.x + n.vx);
      n.y = clampY(n.y + n.vy);
    }
    if (sim.alpha > sim.targetAlpha) sim.alpha *= sim.alphaDecay;
  }

  function reheat(value) {
    sim.alpha = Math.max(sim.alpha, value);
    sim.running = true;
  }

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
    const k = Math.min(
      2,
      Math.min((W - pad * 2) / (maxX - minX || 1), (H - pad * 2) / (maxY - minY || 1)),
    );
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
  let hideRedundant = false;
  let cycleNodes = new Set();
  let focusNodes = new Set();
  let focusPairs = new Set();
  let visiblePairCount = 0;
  let dirty = true;

  function recomputeFocus() {
    focusNodes = new Set();
    focusPairs = new Set();
    if (cycleMode) {
      for (const n of nodes) if (n.cyc >= 0) focusNodes.add(n.index);
      for (let i = 0; i < pairs.length; i++) {
        const p = pairs[i];
        if (focusNodes.has(p.a) && focusNodes.has(p.b)) focusPairs.add(i);
      }
    } else if (selected != null) {
      focusNodes.add(selected);
      for (const pi of nodePairs[selected]) {
        const p = pairs[pi];
        if (p.display < 0) continue;
        focusPairs.add(pi);
        focusNodes.add(p.a);
        focusNodes.add(p.b);
      }
    } else if (selectedZone != null) {
      for (const n of nodes) if (n.z === selectedZone) focusNodes.add(n.index);
      for (let i = 0; i < pairs.length; i++) {
        const p = pairs[i];
        if (p.display >= 0 && (nodes[p.a].z === selectedZone || nodes[p.b].z === selectedZone))
          focusPairs.add(i);
      }
    }
    dirty = true;
    updateStatus();
  }

  function recomputeCycles() {
    cycleNodes = new Set();
    for (const c of raw.cycles || []) for (const i of c.path) cycleNodes.add(i);
  }

  function pairVisible(p) {
    return p.display >= 0 && zoneVisible[nodes[p.a].z] && zoneVisible[nodes[p.b].z];
  }

  function applyFilters() {
    refreshPairKinds(enabledKinds);
    visiblePairCount = pairs.filter(pairVisible).length;
    if (selected != null && !zoneVisible[nodes[selected].z]) {
      selected = null;
      renderDetails();
    }
    if (selectedZone != null && !zoneVisible[selectedZone]) selectedZone = null;
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
    for (const pkg of pkgList) {
      if (!pkgVisible(pkg.name) || pkg.zones.length < 2) continue;
      for (const zi of pkg.zones) drawZoneBox(c, zi, selectedZone === zi);
    }
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

  function drawEdges(c) {
    // any selection — node, zone, or cycle mode — lights up its own edges and dims the rest
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
      for (const i of cycleNodes) {
        const n = nodes[i];
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

  function drawLabels(c) {
    c.save();
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.textAlign = 'left';
    for (const pkg of pkgList) {
      if (!pkgVisible(pkg.name)) continue;
      const r = pkgRect.get(pkg.name);
      if (!r) continue;
      const sx = r.x * view.k + view.x;
      const sy = r.y * view.k + view.y;
      const wpx = r.w * view.k;
      const hpx = r.h * view.k;
      if (sx > W || sy > H || sx + wpx < 0 || sy + hpx < 0) continue;
      const active = selectedZone != null && pkg.zones.includes(selectedZone);
      const count = `${pkg.zones.reduce((s, zi) => s + zones[zi].files, 0)} files`;
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
      if (pkg.zones.length < 2) continue;
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
    if (view.k > 0.5 || labelMinIn <= 8) {
      c.font = '10px ui-monospace, Menlo, monospace';
      c.fillStyle = 'rgba(215,220,230,0.75)';
      c.textAlign = 'center';
      for (const n of nodes) {
        if (!zoneVisible[n.z] || n.in < labelMinIn || n.entry != null) continue;
        if (focusNodes.size && !focusNodes.has(n.index)) continue;
        const sx = n.x * view.k + view.x;
        const sy = n.y * view.k + view.y;
        if (sx < 0 || sy < 0 || sx > W || sy > H) continue;
        c.fillText(n.id.split('/').pop(), sx, sy - n.r * view.k - 4);
      }
    }
    if (view.k > 1.15) {
      const focusing = (focusMode || cycleMode) && focusNodes.size > 0;
      c.font = '9.5px ui-monospace, Menlo, monospace';
      c.textAlign = 'center';
      for (const n of nodes) {
        if (n.entry == null || !zoneVisible[n.z]) continue;
        if (focusing && !focusNodes.has(n.index)) continue;
        const sx = n.x * view.k + view.x;
        const sy = n.y * view.k + view.y;
        if (sx < -80 || sy < -12 || sx > W + 80 || sy > H + 12) continue;
        c.fillStyle = hexAlpha(zoneColor(zones[n.z]), 0.95);
        c.fillText(n.entry, sx, sy - Math.max(ENTRY_R, n.r) - 5);
      }
    }
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
        `${n.id}<br><span class="t-zone">${z.id}${z.rank != null ? ' · rank ' + z.rank : ''}` +
        ` · ${n.loc} loc · in ${n.in} · out ${n.out} · level ${n.lvl}` +
        `${n.cyc >= 0 ? ' · cycle ' + n.cyc : ''}</span>`;
    } else {
      tooltip.style.display = 'none';
    }
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
    if (document.activeElement === searchInput) return;
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
        <label for="z${z.index}">${z.id}${z.rank != null ? ` <span class="count">r${z.rank}</span>` : ''}</label>
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
  function dominatorsOf(entry) {
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
    const order = post.slice().reverse();
    const postRank = new Map(order.map((n, i) => [n, i]));

    const preds = new Map(order.map((n) => [n, []]));
    for (const n of order) for (const next of valueOut[n]) preds.get(next).push(n);

    const idom = new Map([[entry, entry]]);
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = 1; i < order.length; i++) {
        const n = order[i];
        let candidate = -1;
        for (const p of preds.get(n)) {
          if (!idom.has(p)) continue;
          candidate = candidate < 0 ? p : intersect(candidate, p);
        }
        if (candidate < 0 || idom.get(n) === candidate) continue;
        idom.set(n, candidate);
        changed = true;
      }
    }
    function intersect(finger1, finger2) {
      while (finger1 !== finger2) {
        while (postRank.get(finger1) > postRank.get(finger2)) finger1 = idom.get(finger1);
        while (postRank.get(finger2) > postRank.get(finger1)) finger2 = idom.get(finger2);
      }
      return finger1;
    }

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

  function buildAnalysis() {
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
        select(idx);
        const k = Math.max(view.k, 1);
        animateTo({ k, x: W / 2 - nodes[idx].x * k, y: H / 2 - nodes[idx].y * k });
        return;
      }
      const zoneRow = e.target.closest('[data-zone]');
      if (zoneRow) {
        const zi = Number(zoneRow.dataset.zone);
        if (zi < 0) return;
        selected = null;
        selectedZone = selectedZone === zi ? null : zi;
        recomputeFocus();
        renderDetails();
      }
    });
    renderDominator(initial);
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
        `<h2>Zone · ${z.id}</h2><div class="meta">${z.classification}` +
        `${z.rank != null ? ` · rank ${z.rank}` : ''} · ${z.files} files · ${z.loc} loc</div>`;
      return;
    }
    const n = nodes[selected];
    const out = [],
      inc = [];
    for (const pi of nodePairs[selected]) {
      const p = pairs[pi];
      if (p.display < 0) continue;
      if (p.a === selected) out.push([p.b, p]);
      else inc.push([p.a, p]);
    }
    out.sort(
      (a, b) => b[1].counts.reduce((s, c) => s + c, 0) - a[1].counts.reduce((s, c) => s + c, 0),
    );
    inc.sort(
      (a, b) => b[1].counts.reduce((s, c) => s + c, 0) - a[1].counts.reduce((s, c) => s + c, 0),
    );
    const list = (items, dir) =>
      items
        .slice(0, 40)
        .map(([i, p]) => {
          const kinds = KIND_NAMES.map((_, k) => (p.counts[k] ? kindBadge(k) : '')).join('');
          return `<div class="dep" data-node="${i}">${dir === 'out' ? '→ ' : '← '}${nodes[i].id}${kinds}</div>`;
        })
        .join('') +
      (items.length > 40 ? `<div class="hint">… ${items.length - 40} more</div>` : '');
    el.innerHTML = `<h2>Selection</h2>
      <div class="file">${n.id}</div>
      <div class="meta">${zones[n.z].id} · ${n.loc} loc · fan-in ${n.in} · fan-out ${n.out} · level ${n.lvl}${n.cyc >= 0 ? ` · in cycle ${n.cyc}` : ''}</div>
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
      dl.innerHTML = hits.map((n) => `<option value="${n.id}">`).join('');
    };
    searchInput.addEventListener('input', () => fill(searchInput.value));
    searchInput.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const q = searchInput.value.trim().toLowerCase();
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
  document.getElementById('redundant').addEventListener('change', (e) => {
    hideRedundant = e.target.checked;
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
  buildAnalysis();
  recomputeCycles();
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
