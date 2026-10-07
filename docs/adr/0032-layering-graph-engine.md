# ADR 0032: Layering Graph Engine — Keep the Custom Edge Model

## Status

Accepted (2026-10-07). Decision spike for #3278 (umbrella #3276, workstream 2), measured at
`7dda0c2bf`. No rule moves. The spike's harness is temporary; see [Deletion](#deletion).

## Rules at a glance

- R2, R4, R5, R6, R77, R78, R14 and R71 stay in `scripts/layering/`, on the edge model built by
  `resolveImportEdges`. Neither dependency-cruiser 18.5 nor fallow 3.32 replaces them.
- Every layering rule reads one edge model. Do not enforce a subset of the rules from a second import
  graph: both engines disagree with the custom graph and with each other (tables below), and the
  custom graph cannot go away while about 20 AST and ownership rules consume it.
- Do not upgrade fallow to 3.x to get `boundaries`. Upgrade it on its own merits.
- Fix the measured custom gap at the shared parser: `parseImports` does not read TypeScript
  `import('x').T` type positions (9 file pairs on this tree). The fix may move the R9 type-cycle
  ratchet.
- Revisit when a [trigger](#revisit-triggers) fires, re-running the harness first.

## Context

`scripts/layering/` enforces 29 rules over one import graph. Eight of them are plain graph rules:
zone direction (R2), value cycles (R4), spine back-edges (R5), the type-only spine ratchet (R6), the
Apple runner host port (R77), the daemon-client entry inventory (R78) and two retired roots (R14,
R71). The umbrella asked whether a maintained engine expresses them. dependency-cruiser was configured
from `TARGET_DAG_RANK` and the rule tables. fallow was configured with `boundaries` zones and
allowlists, `coverage.requireAllFiles`, a rule pack for R77, and `circularDependencies.ignoreLazyImports`.
Recorded R6 and R78 edges went to each engine's known-violations baseline.

## Measured

Reproduce with `scripts/layering/boundary-engine-spike.ts` (usage in its header). Production scope:
1,837 tracked files, 41 zones.

### Edge-set diff against `resolveImportEdges`

| | custom | dependency-cruiser 18.5 | fallow 3.32 |
| --- | --- | --- | --- |
| file pairs | 9,775 | 9,784 | 9,784 |
| custom pairs missing | — | 0 | 0 |
| extra pairs | — | 9 | the same 9 |
| kind disagreement | — | 46 pairs | 0 on value vs type |
| dynamic kind | 280 pairs | 234 pairs | not represented |

The 9 extra pairs are `import('./x').T` type positions that custom misses. Both engines are right
about them.

The 3.1.1 cross-check missed 88 dynamic and type-only edges; 18.5 misses none. Its remaining
defect is the 46 mislabelled pairs. depcruise deduplicates a file's dependencies on
`(specifier, moduleSystem, type-only flag)` (`getDependencyUniqueKey`, not configurable), so
`typeof import('./x').f` followed by `await import('./x')` keeps whichever comes first. This yields
33 dynamic → type, 8 dynamic+type → type and 5 dynamic+value → value. The same result holds with the
swc parser.

fallow's value-versus-type split matches custom exactly (6,136 runtime pairs each). It has no dynamic
kind. Its boundary check also follows `export type *` barrels to the declaring module.
`src/commands/cli-runner.ts → src/agent-device-client.ts` is therefore reported as
`commands → client`, which adds one R6 finding. On the clean tree, custom reports 0 findings,
depcruise 10 (3 R6 survivors and 7 recorded R78 edges) and fallow 11.

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

Messages differ as follows:

- **Custom:** `file:line`, the rule id and a hint, as ADR 0010 requires.
- **depcruise:** the rule name and an authored comment (`err-long`), without a line.
- **fallow boundaries:** "generic" in the table means a zone pair (`core → cli`) and a docs link,
  with no rule id or hint. R14 and R71 surface as "matches no zone".
- **fallow rule packs:** the R77 rows carry an id, a message and a line.

For the stale row, depcruise reports `summary.baselineStale: 1` and exits 0. fallow's
`--fail-on-stale-baseline` exits 1.

### Runtime

Medians of 5 runs on a shared host (load average about 10):

| | custom | depcruise | fallow |
| --- | --- | --- | --- |
| graph build | 0.74 s, shared and kept | 1.63 s (tsc), 1.77 s (swc) | 3.23 s standalone |
| the eight rules | 0.10 s | included | included |
| marginal CI cost | 0.10 s | +1.6 s, a second graph | ≈0 inside a full dead-code run (3.30 → 3.22 s) |

The whole layering gate (`scripts/layering/check.ts`, 29 rules plus the merge-base tree) takes 9.58 s.

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

The total is about 1,224 lines, roughly half of them tests. The R6 baseline would also change the
policy: an exact-edge baseline rejects swapping one inversion for another within a pair that the
per-pair count ratchet admits. A migration adds about 110 lines of config generated from
`TARGET_DAG_RANK`.

## Decision

Keep custom. Each engine measured worse than the custom rules on these rules, and neither removes
the custom graph:

- **dependency-cruiser.** It matches custom on R2, R4, R5 and R71, but it:
  - mislabels 46 pairs;
  - lets a lazy `import()` hide behind a type position, the only R77 miss in the table;
  - cannot see non-TS paths;
  - needs a wrapper to fail on stale entries;
  - needs `typescript@<7` or `@swc/core` alongside the repository's TypeScript 7;
  - adds 1.6 s for a second graph.

  Adopting it for four rules would delete about 430 lines and put two disagreeing import graphs
  behind one gate.
- **fallow.** It is already a dependency, its marginal runtime is zero and its stale gate is the best
  of the three, but:
  - it has no dynamic kind, so it would turn the deliberate lazy-seam exemption of R5 and R77 into
    violations or misses;
  - boundary findings carry no rule id or hint;
  - rule packs skip files no entry point reaches;
  - 3.x rejects the 73 `comment` fields in `.fallowrc.json`.

## Revisit triggers

- dependency-cruiser keys deduplication on the dependency type, and it can parse with TypeScript 7
  or the repository already ships swc.
- fallow boundaries gain a dynamic-import kind and per-rule ids and messages.
- The AST and ownership rules stop consuming `resolveImportEdges`. A single engine could then own
  the whole graph.

## Deletion

`scripts/layering/boundary-engine-spike.ts` is not a gate, and nothing keeps it compiling. Delete it
in the change that evaluates a revisit trigger: re-run it, update the tables here, then remove it
together with any migrated rule's code from the deletion table. Its outputs live under the gitignored
`.tmp/boundary-engine-spike/`.
