export function createSimulation({ nodes, pairs, zones, hubs, zoneRect, pkgOfZone }) {
  const sim = { alpha: 1, targetAlpha: 0.02, alphaDecay: 0.9825, running: true };

  function repelNode(n, m, cell, a) {
    if (m === n) return;
    let ddx = n.x - m.x,
      ddy = n.y - m.y;
    let d2 = ddx * ddx + ddy * ddy;
    if (d2 > cell * cell * 2 || d2 === 0) {
      if (d2 === 0) {
        ddx = (Math.random() - 0.5) * 2;
        ddy = (Math.random() - 0.5) * 2;
        d2 = 4;
      } else return;
    }
    const ideal = n.r + m.r + 6;
    if (d2 < ideal * ideal * 6) {
      const d = Math.sqrt(d2);
      const push = ((ideal * 3 - d) / d) * 0.08 * a;
      n.vx += ddx * push;
      n.vy += ddy * push;
    }
  }

  function repelNeighbors(n, grid, cell, a) {
    const gx = Math.floor(n.x / cell);
    const gy = Math.floor(n.y / cell);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = grid.get(gx + dx + ':' + (gy + dy));
        if (!bucket) continue;
        for (const m of bucket) repelNode(n, m, cell, a);
      }
    }
  }

  function repelNodes(a) {
    const cell = 30;
    const grid = new Map();
    for (const n of nodes) {
      const key = Math.floor(n.x / cell) + ':' + Math.floor(n.y / cell);
      let bucket = grid.get(key);
      if (!bucket) grid.set(key, (bucket = []));
      bucket.push(n);
    }
    for (const n of nodes) repelNeighbors(n, grid, cell, a);
  }

  function pullConnectedNodes(a) {
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
  }

  function moveNodes(a) {
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
  }

  function tick() {
    const a = sim.alpha;
    repelNodes(a);
    pullConnectedNodes(a);
    for (const z of zones) {
      const hub = hubs[z.index];
      const r = zoneRect[z.index];
      hub.x = r.x + r.w / 2;
      hub.y = r.y + r.h / 2;
    }
    moveNodes(a);
    if (sim.alpha > sim.targetAlpha) sim.alpha *= sim.alphaDecay;
  }

  function reheat(value) {
    sim.alpha = Math.max(sim.alpha, value);
    sim.running = true;
  }

  return { sim, tick, reheat };
}
