export function createGraphModel(raw) {
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

  const pairs = raw.edges.map(([a, b, kind, flags]) => ({ a, b, kind, flags, display: -1 }));
  const nodePairs = nodes.map(() => []);
  pairs.forEach((p, i) => {
    nodePairs[p.a].push(i);
    nodePairs[p.b].push(i);
  });

  return { zones, nodes, pairs, nodePairs };
}

export function refreshPairKinds(pairs, enabledKinds, hideReachable) {
  for (const pair of pairs) {
    const hidden = hideReachable && pair.kind === 0 && (pair.flags & 2) !== 0;
    pair.display = enabledKinds.has(pair.kind) && !hidden ? pair.kind : -1;
  }
}

export function visibleCycleFocus(cycles, pairs, nodes, zoneVisible) {
  const pairByDirection = new Map(pairs.map((pair, index) => [`${pair.a}:${pair.b}`, index]));
  const focusNodes = new Set();
  const focusPairs = new Set();
  for (const cycle of cycles) {
    const pathPairs = [];
    for (let i = 1; i < cycle.path.length; i++) {
      const from = cycle.path[i - 1];
      const to = cycle.path[i];
      const index = pairByDirection.get(`${from}:${to}`);
      if (index === undefined || !zoneVisible[nodes[from].z] || !zoneVisible[nodes[to].z]) break;
      if (pairs[index].display < 0) break;
      pathPairs.push(index);
    }
    if (pathPairs.length !== cycle.path.length - 1 || !pathPairs.length) continue;
    for (const index of pathPairs) {
      focusPairs.add(index);
      focusNodes.add(pairs[index].a);
      focusNodes.add(pairs[index].b);
    }
  }
  return { focusNodes, focusPairs };
}
