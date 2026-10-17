# ADR 0032: Layering Graph Engine — Retain the Current Engine

## Status

Accepted (2026-10-07). This evaluation addresses #3278 under umbrella #3276.
Every measurement refers to `d9959f510`, with the same production tree as `7dda0c2bf`.
The harness exists only at that commit; see [Deletion](#deletion).
No rule moves.

## Rules at a glance

- R2, R4, R5, R6, R77, R78, R14, and R71 retain the current engine.
  Neither dependency-cruiser 18.5 nor fallow 3.32 replaces them.
- Graph-based checks share one normalized import model, currently from `parseImports` and `resolveImportEdges`.
  Do not enforce some checks through a second, inconsistent graph.
- The model implementation remains replaceable.
  In addition to these eight rules, it must supply these outputs:
  - Resolved value, type-only, and dynamic edges for R9/R10, R19, R73–R76, and `scripts/depgraph/`.
  - Named symbols for R75.
  - Raw specifier sites for R11 and R13.
  Eleven other registry entries read only source ASTs or text.
  One reads only paths.
- Fix #3293's demonstrated parser gap: `parseImports` misses TypeScript `import('x').T` type positions (nine file pairs).
  `parseImports` already uses an OXC AST for dynamic imports but regexes for static imports.
  Read both from that AST, including `TSImportType`.
  Preserve symbol and edge-kind semantics.
  Do not add a second extractor.
- Do not upgrade fallow to 3.x for `boundaries`.
  Revisit on a [trigger](#revisit-triggers).

## Measured

The harness run at `d9959f510` supplies edge-set, parity, clean-tree, and runtime measurements.
If the commit is absent locally, first run `git fetch origin pull/3286/head`.
Retrieve the harness with `git show d9959f510:scripts/layering/boundary-engine-spike.ts`.
Its header gives usage.
It derives both engines' R5/R6 rules from `model.ts`'s `RANKED_ZONES` and `zoneRank`.
It declares other rules' paths inline, with R77 paths from `RUNNER_SUBTREE`.
It runs only on exactly the tracked production tree: 1,837 files and 41 zones.
It supplies recorded R6/R78 edges to each engine's known-violations baseline.
The deletion table and `.fallowrc.json` field count also refer to files at that commit.

### Edge-set diff against `resolveImportEdges`

| | custom | dependency-cruiser 18.5 | fallow 3.32 |
| --- | --- | --- | --- |
| file pairs | 9,775 | 9,784 | 9,784 |
| custom pairs missing | — | 0 | 0 |
| extra pairs | — | 9 | the same 9 |
| kind disagreement | — | 46 pairs | 0 on value vs type |
| dynamic kind | yes | yes, 46 pairs mislabelled | not represented |

The nine extra pairs are `import('./x').T` type positions missed by the custom engine.
Both replacement engines correctly detect them.

The umbrella's 3.1.1 cross-check missed 88 dynamic and type-only edges.
Version 18.5 misses none of these edges but mislabels 46 pairs:

- 33 dynamic → type.
- 8 dynamic+type → type.
- 5 dynamic+value → value.

Its hardcoded `getDependencyUniqueKey` deduplicates by `(specifier, moduleSystem, type-only flag)`.
Thus, `typeof import('./x').f` and `await import('./x')` retain whichever appears first.

Fallow agrees with custom on value/type classification for every pair but has no dynamic kind.
Its boundary check follows `export type *` barrels to the declaring module.
`src/commands/cli-runner.ts → src/agent-device-client.ts` therefore counts as `commands → client`. This adds one more R6 finding.
Clean-tree findings are custom 0, depcruise 10, and fallow 11.
Depcruise's ten are three R6 survivors and seven recorded R78 edges.

### Planted-violation parity

`pass` rows are the nearest negative cases that custom permits.
✗ means a missed `flag` or incorrectly flagged `pass`.

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

_R78 no longer records edges._
_The `LOGICAL_MODULE_POLICIES` client-import rule in R10 now prohibits direct daemon imports._
_R78 follows reachability from CLI entries._
_The "unrecorded" and "stale" rows describe the dated evaluation, not shipped rules._

Custom `report()` in `scripts/layering/check.ts` prints `file:line`, rule ID, and hint.
Depcruise prints rule name and an authored comment without a line.
"Generic" denotes a fallow zone pair, such as `core → cli`, and a documentation link without rule ID or hint.
R14/R71 appear as "matches no zone".
Fallow's R77 rule pack supplies an ID, message, and line.
For the stale row, depcruise reports `summary.baselineStale: 1` and exits 0.
Fallow's `--fail-on-stale-baseline` exits 1.

### Runtime

These are medians from five runs after warm-up on a shared host with load average 9–17:

| | custom | depcruise | fallow |
| --- | --- | --- | --- |
| graph build | 0.74 s, shared and kept | 1.66 s (tsc), 1.56 s (swc) | 3.04 s standalone |
| the eight rules | 0.10 s | included | included |
| marginal CI cost | 0.10 s | +1.6 s, a second graph | none measurable in the repo's dead-code run (3.23 → 3.13 s) |

### Lines deletable

A complete migration would delete the rule and test lines below.
The resolver and the R4/R5/R6 pair helpers that `scripts/depgraph/` reads remain with either engine.

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

Approximately 1,224 lines are deletable, half in tests.
Migration adds a generator such as harness `depcruiseConfig` and helpers, which total 122 lines at `d9959f510`.
An exact-edge R6 baseline also changes policy.
It prohibits replacement of one inversion with another inside a pair.
The current per-pair count ratchet permits that replacement.

## Decision

Retain the current engine, because the evaluated replacements lack sufficient semantic parity and net simplification.
Graph-based checks share one normalized import model.
Its implementation remains replaceable.
Continue replacement of generic algorithms and compiler-enforceable rules with maintained tools.
Fix the demonstrated parser gap.

The parity table identifies these correctness blockers:

- **Dependency-cruiser** deduplicates without dynamic or `import()`-type kinds in the key.
  It mislabels 46 pairs.
  A same-target `import()` type can hide a lazy `import()`, which causes the R77 miss.
- **Fallow** lacks a dynamic-import kind.
  It flags the lazy seams that R5 permits and misses R77 `import()`.
  Rule packs skip unreachable files and therefore miss an orphan runner module.

Simplification is limited.
Dependency-cruiser matches custom for R2, R4, R5, and R71, which would delete approximately 430 lines.
Other consumers still need the shared model.
The gate would therefore read two inconsistent graphs.

These additional migration costs do not independently decide the outcome:

- Dependency-cruiser needs `typescript@<7` or `@swc/core` beside TypeScript 7, with +1.6 s runtime.
  It needs a wrapper that fails on `summary.baselineStale`.
  Diagnostics lack a line.
- Fallow 3.x rejects 73 `comment` fields in `.fallowrc.json`.
  Boundary findings lack a rule ID and hint.
  It adds no measurable runtime and provides the best stale-baseline gate.
- R14/R71 govern filesystem placement.
  Both engines still need a path check for non-TS paths under `src/utils`.
  This is not an import-engine failure.

## Revisit triggers

- Dependency-cruiser includes dependency type in its deduplication key.
- Fallow boundaries gain a dynamic-import kind and rule packs cover unreachable files.
- An engine can supply the shared import model above to the existing consumers with less total machinery than `parseImports` and `resolveImportEdges`.
  Source-only AST checks do not need to change first.

## Deletion

The harness is absent from the tree.
It imports internals from six layering modules:

- `check.ts`
- `model.ts`
- `package-boundaries.ts`
- `ratchet-reference.ts`
- `apple-runner-host-port-policy.ts`
- `tracked-sources.ts`

No gate would verify that it still compiles.
`tsconfig.json` does not include `scripts/layering/`, and fallow ignores it.
A change that evaluates a revisit trigger follows this sequence:

1. Retrieve the harness from `d9959f510`.
2. Adapt it to the current tree's internals.
3. Run it again.
4. Update these tables.
5. Delete migrated rule code listed in the deletion table.
