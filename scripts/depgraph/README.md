# Dependency graph report

```sh
pnpm depgraph                       # -> .tmp/depgraph/graph.json + a text summary
pnpm depgraph --out /tmp/graph.json
pnpm depgraph:test
```

Emits the dependency graph of every production file under `src/` (tests excluded) as JSON,
plus a short summary of what the layering gate does not enforce. There is no renderer: the
productive artifact is the JSON, queried directly.

## Blast radius of one file

```sh
pnpm depgraph affected src/utils/exec.ts        # bounded text
pnpm depgraph affected src/daemon/ref-frame.ts --json --limit 25
```

Reverse reachability over the value-edge graph, plus the three lookups that used to follow it:
the `scripts/check-affected/` gate plan for the dependent set, the public commands whose handler
chain reaches the file (value + dynamic edges, because handlers load through `import()`) with
their owning live iOS scenarios when that manifest is in the tree, and the ADR 0011
guarantee-matrix cells the file implements. See docs/agents/testing.md § "Before editing a shared
module".

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

- **value edges whose target is also reachable at distance >= 2** — static module reachability,
  and *only* that. It is **not** a removability claim, and the obvious reading is wrong:
  reachability does not carry bindings (if `a` imports `{ c }` while `b` only re-exports it as
  `{ c as b }`, the path exists and deleting `a -> c` still breaks `a`), it does not preserve when
  a module's side effects run, and a direct import is often deliberately clearer than reaching
  through a barrel. Deciding whether any given edge can go needs symbol-level analysis this does
  not attempt. ~1300 of them: a place to look, never a work list.
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
# Zone pairs that invert the ranked spine. Read `typeInversions` rather than deriving it from
# `zoneEdges`: those counts come from the COLLAPSED edge list, where one edge per file pair
# survives and `dynamic` outranks `type`, so a module imported both lazily and for its types
# would drop out. `typeInversions` is counted by the gate's own rule and is what CI compares
# against TYPE_INVERSION_BASELINE.
node -e "const j=require('./.tmp/depgraph/graph.json');
  Object.entries(j.typeInversions)
    .sort((a, b) => b[1] - a[1])
    .forEach(([pair, n]) => console.log(String(n).padStart(4), pair));"
```


Note `zoneEdges[].backEdge` flags **R5 value** back-edges only, and there are none — filtering on
it returns an empty list, which is the gate passing, not a broken query.


## What is authoritative

`pnpm check:layering` is. The viewer reads the same model, so the numbers should agree — and that
agreement is now enforced rather than hoped for: the **Layering Guard job runs
`scripts/depgraph/model.test.ts`**, whose last test asserts this report's inversion count reproduces
`TYPE_INVERSION_BASELINE`. If the tree changes and only one side is updated, CI fails and names the
difference. The two cannot be green independently.

What that check proves precisely: the report's graph build, over the real tree, agrees with the
gate's baseline. It is a cross-check of the extraction and the baseline against reality, not two
independent algorithms — `typeInversionsByPair` deliberately applies the gate's counting rule (once
per file pair, over raw edges) so the numbers cannot diverge for a reason unrelated to layering. In
particular it does NOT count from the collapsed edge list, where `dynamic` outranks `type` and a
module imported both lazily and for its types would drop out.

If they ever disagree, the gate is right and the baseline or the tree is wrong.

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
  dynamic. Flags bitfield: `1` spine back-edge, `2` target also reachable at distance >= 2, `4` type-only
  inversion.
- `cycles[]` — each with `kind` (`value` / `type` / `dynamic`) and its node path.

Bit `2` means the target is reachable from the source at distance >= 2 over value edges. That is
module reachability, not removability — see the caveats above. Treat it as a question ("why is
this imported directly as well?"), never as an instruction.
