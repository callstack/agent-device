export function createDominatorAnalyzer(nodes, edges) {
  // value edges directed importer -> imported: the eager-load relation, exactly the subgraph R4
  // keeps acyclic and the one computeDominatorSummary walks.
  const valueOut = nodes.map(() => []);
  for (const [a, b, kind] of edges) {
    if (kind === 0) valueOut[a].push(b);
  }

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

  /**
   * Dominator tree of `entry` over value edges (Cooper–Harvey–Kennedy, walking reverse postorder):
   * every file in `d`'s dominated set stops being reachable from `entry` when `d` disappears, so
   * its size is the branch moving `d` behind `import()` would cut. Same query as
   * computeDominatorSummary, run live so any file can be the entry.
   */
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

  return dominatorsOf;
}
