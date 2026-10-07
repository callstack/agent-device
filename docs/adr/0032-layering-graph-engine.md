# ADR 0032: Layering Graph Engine — Retain the Current Engine

## Status

Accepted (2026-10-07). Spike for #3278 (umbrella #3276). Every measurement is pinned to `d9959f510`,
whose production tree is `7dda0c2bf`'s; the harness lives only at that commit
([Deletion](#deletion)). No rule moves.

## Rules at a glance

- R2, R4, R5, R6, R77, R78, R14 and R71 stay on the current engine. Neither dependency-cruiser 18.5
  nor fallow 3.32 replaces them.
- Graph-based checks share one normalized import model, today built by `parseImports` and
  `resolveImportEdges`. Do not enforce a subset of them from a second, disagreeing import graph.
- The model's implementation remains replaceable. Besides these eight rules, it must supply
  resolved edges with value, type-only and dynamic kinds to R9/R10, R19, R73–R76 and
  `scripts/depgraph/`; named symbols and the binding residue of dynamic imports to R76; and raw
  specifier sites to R11 and R13. Eleven other registry entries read source ASTs or text only, and
  one reads paths only.
- Fix the demonstrated parser gap in #3293: `parseImports` misses TypeScript `import('x').T` type
  positions (9 file pairs). It already parses an OXC AST for dynamic imports but scans static
  imports with regexes; read both from that AST, `TSImportType` included, keeping symbol and
  edge-kind semantics, rather than adding a second extractor.
- Do not upgrade fallow to 3.x for `boundaries`; revisit on a [trigger](#revisit-triggers).

## Measured

The edge-set, parity, clean-tree and runtime numbers are the output of the spike harness run at
`d9959f510`. Retrieve it with `git show d9959f510:scripts/layering/boundary-engine-spike.ts`, after
`git fetch origin pull/3286/head` if the commit is not local; usage is in its header. It derives
both engines' R5 and R6 rules from `model.ts`'s `RANKED_ZONES` and `zoneRank`, writes the other
rules' paths inline (R77's from `RUNNER_SUBTREE`), runs only on exactly the tracked production tree
(1,837 files, 41 zones), and gives recorded R6 and R78 edges to each engine's known-violations
baseline. The deletion table and the `.fallowrc.json` field count are counts of files at the same
commit.

### Edge-set diff against `resolveImportEdges`

| | custom | dependency-cruiser 18.5 | fallow 3.32 |
| --- | --- | --- | --- |
| file pairs | 9,775 | 9,784 | 9,784 |
| custom pairs missing | — | 0 | 0 |
| extra pairs | — | 9 | the same 9 |
| kind disagreement | — | 46 pairs | 0 on value vs type |
| dynamic kind | yes | yes, 46 pairs mislabelled | not represented |

The 9 extra pairs are `import('./x').T` type positions custom misses; both engines are right.

The umbrella's 3.1.1 cross-check missed 88 dynamic and type-only edges; 18.5 misses none but
mislabels 46 pairs (33 dynamic → type, 8 dynamic+type → type, 5 dynamic+value → value): its
hardcoded `getDependencyUniqueKey` dedupes on `(specifier, moduleSystem, type-only flag)`, so
`typeof import('./x').f` and `await import('./x')` keep whichever comes first.

fallow's value-versus-type split matches custom on every pair, with no dynamic kind. Its boundary
check follows `export type *` barrels to the declaring module: the import
`src/commands/cli-runner.ts → src/agent-device-client.ts` counts as `commands → client`, one more R6
finding. Clean tree: custom 0, depcruise 10 (3 R6 survivors, 7 recorded R78 edges), fallow 11.

### Planted-violation parity

`pass` rows are the closest negative custom admits; ✗ is a missed `flag` or a flagged `pass`.

| Plant | Expect | custom | depcruise | fallow |
| --- | --- | --- | --- | --- |
| R2 daemon value-imports commands | flag | ✓ | ✓ | ✓ generic |
| R2 core type-imports commands | flag | ✓ | ✓ | ✓ generic |
| R2 commands imports commands/schema | flag | ✓ | ✓ | ✓ generic |
| R4 value cycle | flag | ✓ | ✓ | ✓ |
| R4 type-only cycle | pass | ✓ | ✓ | ✓ |
| R4 cycle closed by a lazy `import()` | pass | ✓ | ✓ | ✓ |
| R5 core value-imports cli | flag | ✓ | ✓ | ✓ generic |
| R5 static re-export after an `import()` type | flag | ✓ | ✓ | ✓ generic |
| R5 core lazy-imports cli | pass | ✓ | ✓ | ✗ flagged |
| R6 new type-only inversion pair | flag | ✓ | ✓ | ✓ generic |
| R77 named import, reachable module | flag | ✓ | ✓ | ✓ |
| R77 re-export, reachable module | flag | ✓ | ✓ | ✓ |
| R77 lazy `import()`, reachable module | flag | ✓ | ✓ | ✗ |
| R77 named import, orphan module | flag | ✓ | ✓ | ✗ |
| R77 runner test file | flag | ✓ | ✓ | ✓ |
| R77 lazy `import()` after an `import()` type | flag | ✓ | ✗ | ✗ |
| R77 type-only import | pass | ✓ | ✓ | ✓ |
| R78 client value-imports daemon | flag | ✓ | ✓ | ✓ generic |
| R78 unrecorded client type import | flag | ✓ | ✓ | ✓ generic |
| R78 recorded edge removed (stale) | flag | ✓ | exit 0 | ✓ exit 1 |
| R14 orphan `.ts` under `src/utils` | flag | ✓ | ✓ | ✓ generic |
| R14 non-TS file under `src/utils` | flag | ✓ | ✗ | ✗ |
| R71 file under `src/replay` | flag | ✓ | ✓ | ✓ generic |

Custom prints `file:line`, rule id and hint (`report()` in `scripts/layering/check.ts`); depcruise
the rule name and an authored comment, without a line. "Generic" means a fallow zone pair
(`core → cli`) and a docs link, with no rule id or hint; R14 and R71 surface as "matches no zone".
fallow's R77 rule pack carries an id, message and line. On the stale row, depcruise reports
`summary.baselineStale: 1` and exits 0; fallow's `--fail-on-stale-baseline` exits 1.

### Runtime

Medians of 5 runs after a warm-up, on a shared host (load average 9–17):

| | custom | depcruise | fallow |
| --- | --- | --- | --- |
| graph build | 0.74 s, shared and kept | 1.66 s (tsc), 1.56 s (swc) | 3.04 s standalone |
| the eight rules | 0.10 s | included | included |
| marginal CI cost | 0.10 s | +1.6 s, a second graph | none measurable in the repo's dead-code run (3.23 → 3.13 s) |

### Lines deletable

Rule plus test lines a full migration would delete. The resolver and the R4/R5/R6 pair helpers that
`scripts/depgraph/` reads stay either way.

| Rule | Code deleted | Lines | depcruise parity | fallow parity |
| --- | --- | --- | --- | --- |
| R2 | `zone-policy.ts`, `commands-schema-boundary.ts`, `checkLayeringRules` | 302 | full | generic message |
| R4 | `checkCycles` | 22 | full | full; also scans tests |
| R5 | `checkBackEdges`, `collectBackEdges`, model tests | 90 | full | flags lazy seams |
| R6 | `type-inversion-ratchet.ts`, `typeInversionCounts` | 166 | exact-edge baseline | exact-edge baseline |
| R77 | `apple-runner-host-port-policy.ts` | 141 | masking miss | misses `import()`, orphans |
| R78 | `daemon-client-entry.ts` | 260 | stale needs a wrapper | generic message |
| R14, R71 | `retired-paths-policy.ts` | 218 | TS only (R14 gap) | TS only, generic |
| shared | registry, imports, success line in `check.ts` | ≈25 | | |

About 1,224 lines, half of them tests; a migration adds a generator like the harness's
`depcruiseConfig` and helpers (122 lines at `d9959f510`). An exact-edge R6 baseline also changes
policy: it rejects swapping one inversion for another within a pair, which the per-pair count
ratchet admits.

## Decision

Retain the current engine because the evaluated replacements do not provide sufficient semantic
parity and net simplification. Graph-based checks share one normalized import model; its
implementation remains replaceable. Continue replacing generic algorithms and compiler-enforceable
rules with maintained tools. Fix the demonstrated parser gap.

The semantic blockers are the correctness gaps in the parity table:

- **dependency-cruiser** deduplicates a file's dependencies on a key that omits the dynamic and
  `import()`-type kinds. That mislabels 46 pairs and lets a lazy `import()` hide behind an
  `import()` type of the same target, the R77 miss.
- **fallow** has no dynamic-import kind, so it flags the lazy seams R5 admits and misses R77's
  `import()`. Its rule packs skip files no entry point reaches, so it also misses an orphan runner
  module.

Simplification is limited. dependency-cruiser matches custom on R2, R4, R5 and R71, where migration
would delete about 430 lines. The shared model stays for its other consumers, so the gate would read
two import graphs that disagree.

The rest are migration costs, which would not decide the question on their own:

- dependency-cruiser needs `typescript@<7` or `@swc/core` beside TypeScript 7 (+1.6 s), and a
  wrapper that fails on `summary.baselineStale`. Its diagnostics carry no line.
- fallow 3.x rejects the 73 `comment` fields in `.fallowrc.json`, and its boundary findings carry no
  rule id or hint. It adds no measurable time and has the best stale gate.
- R14 and R71 are filesystem-placement policies. A non-TS path under `src/utils` needs a path check
  with either engine; that is not a failure of an import engine.

## Revisit triggers

- dependency-cruiser keys deduplication on the dependency type.
- fallow boundaries gain a dynamic-import kind, and its rule packs cover files no entry point
  reaches.
- An engine can supply the shared import model above to the existing consumers with less total
  machinery than `parseImports` and `resolveImportEdges`. The source-only AST checks do not have to
  change first.

## Deletion

The harness is not in the tree. It imports internal symbols from six layering modules (`check.ts`,
`model.ts`, `package-boundaries.ts`, `ratchet-reference.ts`, `apple-runner-host-port-policy.ts`,
`tracked-sources.ts`), and no gate would keep it compiling: `tsconfig.json` does not include
`scripts/layering/`, and fallow ignores it. The change that evaluates a revisit trigger retrieves
the harness from `d9959f510`, ports it to the internals of its own tree, re-runs it, updates the
tables here, and deletes any migrated rule's code listed in the deletion table.
