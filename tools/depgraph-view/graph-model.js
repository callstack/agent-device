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

  // Group import kinds only when they have the same source and target.
  const pairMap = new Map();
  for (const [a, b, kind, flags] of raw.edges) {
    const key = a * nodes.length + b;
    let pair = pairMap.get(key);
    if (!pair) {
      pair = { a, b, counts: [0, 0, 0], redundantValue: 0, display: -1 };
      pairMap.set(key, pair);
    }
    pair.counts[kind]++;
    // Bit 2 marks reachability in the value-edge graph; value cycles leave it unset.
    if (kind === 0 && flags & 2) pair.redundantValue++;
  }
  const pairs = [...pairMap.values()];
  const nodePairs = nodes.map(() => []);
  pairs.forEach((p, i) => {
    nodePairs[p.a].push(i);
    if (p.b !== p.a) nodePairs[p.b].push(i);
  });

  return { zones, nodes, pairs, nodePairs };
}

export function refreshPairKinds(pairs, enabledKinds, hideRedundant) {
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

export function visibleKinds(pair, enabledKinds, hideRedundant) {
  return [0, 1, 2].filter(
    (kind) =>
      pair.counts[kind] > 0 &&
      enabledKinds.has(kind) &&
      !(hideRedundant && kind === 0 && pair.redundantValue === pair.counts[0]),
  );
}
