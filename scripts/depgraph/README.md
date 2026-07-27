# Dependency graph report

```sh
pnpm depgraph                       # -> .tmp/depgraph/graph.json + a text summary
pnpm depgraph --out /tmp/graph.json
pnpm depgraph:test
```

Emits the dependency graph of every production file under `src/` (tests excluded) as JSON,
plus a short summary of what the layering gate does not enforce. There is no renderer: the
productive artifact is the JSON, queried directly.

## When to reach for this

It pays for itself on three questions, and misleads on a fourth.

**"What am I about to break?"** `nodes[].in` is the dependent count — blast radius. Size the
nodes by dependents and the files you should touch carefully are the big ones. Faster than
grepping, and it counts type-only and dynamic edges that a grep for `from '...'` misses.

**"Where is the debt actually concentrated?"** Zone-level counts (`zoneEdges`) answer "which
boundary carries the most traffic" in one query. The pass that produced ADR-adjacent findings
started here.

**"What is wrong that the gate does not enforce?"** This is the part CI cannot give you. The
gate rejects value-import cycles (R4) and spine back-edges (R5); the graph additionally reports:

- **transitively redundant value edges** — the target is still reachable from the source at
  distance >= 2, so the direct import changes nothing about what the module can see. A
  _candidate_, not a defect: a direct import is often clearer than a re-export chain. There are
  ~1300 of these, so treat it as a place to look, never a work list.
- **type-only and dynamic cycles** — 8 of them, all outside R4 by design (a type-only import is
  free at runtime, a dynamic one is a deliberate cold-start seam). Worth reading when a module
  feels hard to reason about.

**Where it misleads: a cluster's size is not its difficulty.** This is worth stating plainly
because it already cost a day. The `commands -> client` cluster looked like the obvious win — 28
type-only inversions, all pointing at one file. Moving that file down took the gate from **42 to
48**, because the vocabulary it holds *depends on* `commands/`, `metro/`, `core/` and `remote/`;
declaring it in `contracts/` made the foundation depend on the layers above it. The picture shows
you an edge's weight, not whether it can be reversed.

So: use the render to find a candidate, then answer "can this move?" numerically before planning
anything. The question is always *what does the target itself import, and what rank is that?*

```sh
pnpm depgraph
# Zone pairs that invert the ranked spine, by type-only edge count. Reproduces the gate's R6
# breakdown from the JSON alone — if these disagree with TYPE_INVERSION_BASELINE, regenerate.
node -e "const j=require('./.tmp/depgraph/index.json');
  const rank=Object.fromEntries(j.zones.map(z=>[z.id,z.rank]));
  j.zoneEdges
    .filter(e=>rank[e.from]!=null && rank[e.to]!=null && rank[e.from]<rank[e.to])
    .map(e=>({pair:e.from+' -> '+e.to, typeOnly:e.count-e.valueCount}))
    .filter(e=>e.typeOnly>0).sort((a,b)=>b.typeOnly-a.typeOnly)
    .forEach(e=>console.log(String(e.typeOnly).padStart(4), e.pair));"
```

Note `zoneEdges[].backEdge` flags **R5 value** back-edges only, and there are none — filtering on
it returns an empty list, which is the gate passing, not a broken query.


## What is authoritative

`pnpm check:layering` is. This reads the same model, so the numbers should agree — its R6
count matching `TYPE_INVERSION_BASELINE` is a useful self-check — but if they ever diverge, the
gate is right and the graph is stale. Nothing here runs in CI, and nothing here should gate a
merge: it is an instrument, not a rule.

## Why it reuses the layering gate

The graph is extracted with `scripts/layering/model.ts`, the same module
`scripts/layering/check.ts` uses in CI. File set, zone partition, edge kinds
(value / type-only / dynamic), and cycle definition are therefore identical to the rules
the gate enforces — a separate extractor with its own resolution behaviour would draw a
graph nobody is enforcing. Cross-checked once against `dependency-cruiser` 3.1.1 (at the commit it was written): same
modules and edges, plus 88 dynamic/type-only edges dependency-cruiser fails to resolve.

## What the JSON carries

- `zones[]` — id, spine `rank` (`null` when intentionally unranked), `classification`, file
  count, LOC.
- `zoneEdges[]` — per zone pair: total `count`, `valueCount`, and `backEdge` (R5 value
  back-edges only — see the note above).
- `nodes[]` — per file: zone index, LOC, `in`/`out` degree, `lvl` (longest path to a sink over
  value edges; R4 guarantees that subgraph is a DAG), and `cyc` (index into `cycles`, or `-1`).
- `edges[]` — index-addressed `[from, to, kind, flags]`. Kind: `0` value, `1` type-only, `2`
  dynamic. Flags bitfield: `1` spine back-edge, `2` transitively redundant, `4` type-only
  inversion.
- `cycles[]` — each with `kind` (`value` / `type` / `dynamic`) and its node path.

A "redundant" edge means the target is still reachable from the source at distance >= 2 over
value edges, so removing the direct import would not change what the module can see. That makes
it a _candidate_, not a defect: plenty of direct imports are clearer than relying on a re-export
chain.
