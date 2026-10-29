export function createLayout({ zones, nodes, raw, entryManifest, PALETTE }) {
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
  function assignEntryNodes() {
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
  }
  assignEntryNodes();
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

  return {
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
  };
}
