# ADR 0032: Layering Graph Engine — Keep the Custom Edge Model

## Status

Accepted (2026-10-07). Decision spike for #3278 (umbrella #3276, workstream 2), measured at
`7dda0c2bf`. No rule moves. The spike's harness is temporary; see [Deletion](#deletion).

## Rules at a glance

- R2, R4, R5, R6, R77, R78, R14 and R71 stay on the `resolveImportEdges` edge model. Neither
  dependency-cruiser 18.5 nor fallow 3.32 replaces them.
- Every layering rule reads one edge model. Do not enforce a subset from a second import graph: both
  engines disagree with it (tables below), and about 20 AST and ownership rules keep it alive.
- Do not upgrade fallow to 3.x to get `boundaries`.
- Fix the custom gap at the shared parser: `parseImports` misses TypeScript `import('x').T` type
  positions (9 file pairs). The fix may move the R9 type-cycle ratchet.
- Revisit when a [trigger](#revisit-triggers) fires, re-running the harness first.

## Measured

`scripts/layering/boundary-engine-spike.ts` produces every number below (usage in its header). It
generates both engine configs from `TARGET_DAG_RANK` and the rule tables, and refuses to run unless
the production roots hold exactly the tracked tree (1,837 files, 41 zones). Recorded R6 and R78
edges go to each engine's known-violations baseline.

### Edge-set diff against `resolveImportEdges`

| | custom | dependency-cruiser 18.5 | fallow 3.32 |
| --- | --- | --- | --- |
| file pairs | 9,775 | 9,784 | 9,784 |
| custom pairs missing | — | 0 | 0 |
| extra pairs | — | 9 | the same 9 |
| kind disagreement | — | 46 pairs | 0 on value vs type |
| dynamic kind | 280 pairs | 234 pairs | not represented |

The 9 extra pairs are `import('./x').T` type positions custom misses; both engines are right.

The 3.1.1 cross-check missed 88 dynamic and type-only edges; 18.5 misses none but mislabels 46 pairs
(33 dynamic → type, 8 dynamic+type → type, 5 dynamic+value → value, with tsc or swc). It deduplicates
a file's dependencies on `(specifier, moduleSystem, type-only flag)` (`getDependencyUniqueKey`, not
configurable), so `typeof import('./x').f` and `await import('./x')` keep whichever comes first.

fallow's value-versus-type split matches custom exactly (6,136 runtime pairs each), with no dynamic
kind. Its boundary check follows `export type *` barrels to the declaring module, so
`src/commands/cli-runner.ts → src/agent-device-client.ts` counts as `commands → client`: one more R6
finding. Clean-tree findings: custom 0, depcruise 10 (3 R6 survivors, 7 recorded R78 edges), fallow 11.

### Planted-violation parity

`flag` rows must be reported; `pass` rows are the closest negative the custom rule admits. ✗ is a
miss on `flag` or a false positive on `pass`.

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

Medians of 5 runs after a warm-up, on a shared host (load average about 9):

| | custom | depcruise | fallow |
| --- | --- | --- | --- |
| graph build | 0.75 s, shared and kept | 1.63 s (tsc), 1.66 s (swc) | 3.26 s standalone |
| the eight rules | 0.10 s | included | included |
| marginal CI cost | 0.10 s | +1.6 s, a second graph | +0.26 s in the repo's dead-code run (3.27 → 3.53 s) |

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

About 1,224 lines, half of them tests; a migration adds about 110 lines of generated config. An
exact-edge R6 baseline also changes policy: it rejects swapping one inversion for another within a
pair, which the per-pair count ratchet admits.

## Decision

Keep custom. Each engine measured worse than the custom rules on these rules, and neither removes
the custom graph:

- **dependency-cruiser** matches custom on R2, R4, R5 and R71. It mislabels 46 pairs, lets a lazy
  `import()` hide behind a type position (the R77 miss), cannot see non-TS paths, needs a wrapper to
  fail on stale entries, and needs `typescript@<7` or `@swc/core` beside TypeScript 7 (+1.6 s).
  Adopting it for four rules would delete about 430 lines and put two disagreeing import graphs
  behind one gate.
- **fallow** is already a dependency, adds about 0.3 s, and has the best stale gate. It has no
  dynamic kind, so R5's and R77's lazy-seam exemption becomes violations or misses. Its boundary
  findings carry no rule id or hint, its rule packs skip files no entry point reaches, and 3.x rejects
  the 73 `comment` fields in `.fallowrc.json`.

## Revisit triggers

- dependency-cruiser keys deduplication on the dependency type, and it can parse with TypeScript 7
  or the repository already ships swc.
- fallow boundaries gain a dynamic-import kind and per-rule ids and messages.
- The AST and ownership rules stop consuming `resolveImportEdges`, so one engine can own the graph.

## Deletion

`scripts/layering/boundary-engine-spike.ts` is not a gate, and nothing keeps it compiling. The change
that evaluates a revisit trigger re-runs it, updates the tables here, and deletes it together with
any migrated rule's code from the deletion table.
