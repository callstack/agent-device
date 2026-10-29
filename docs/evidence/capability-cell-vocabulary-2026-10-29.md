# Capability cell vocabulary: bounded retain evidence

The [decision in #4056](https://github.com/callstack/agent-device/issues/4056#issuecomment-6499398178) retains the compile-checked duplicate declarations.
The experiment did not reduce file or package coordination.
This record supports the accepted retention decision and rejection of the single-source table in [ADR 0028](../adr/0028-capability-family-cell-vocabulary.md).
It does not establish that a whole capability addition was replayed.

## Source identity and comparison

The audit examined the last 200 overall commits at `144bd59890277fd4717995588ad817597c9d6552` (2026-10-17 through 2026-10-29).
The disposable experiment used `be22676ace3f6a11d23af23a45c588a474e514be`.
`platform-runtime-unavailable.ts` is identical at both source commits.

The prototype changed only that module's input type, local table and comment.
It replaced 34 authored input properties and the compile-exhaustive key table with one table containing `required` or `optional` values.
Two key-remapped mapped types derived the input contract.
Patch inspection confirmed the same 34 keys in order: 26 required and eight optional.
The runtime functions, fact projection, lifecycle authority and existing optional-cell `network` fallback were untouched.

A controlled comparison removed and reintroduced only the `systemButton` cell vocabulary.
The intermediate pre-addition fixtures were incomplete measurement inputs, not release baselines.

| Scope | Existing | Inverted prototype |
| --- | --- | --- |
| Cell vocabulary re-addition | Two declarations; one file, one package | One row; one file, one package |
| Adoption diff | Baseline | 49 added, 77 deleted lines; net −28 in one file |
| Discovered eager entries | 427 | 427, with identical members, counts and weights |

The prototype removed one authored declaration and saved zero files or packages for this cell.
It also removed the `settings` contract comment without relocation.
The explicit owner-facing input shape became an intersection of mapped types.
The table's required/optional values were not read at runtime.
These costs do not justify adoption without a coordination benefit.

## Historical context

The following whole-commit counts include tests, documentation and backend changes.
They are not measurements of the local vocabulary substitution.

| Commit | Scope | Whole-commit files / packages | Unavailable-cell change |
| --- | --- | --- | --- |
| `c41dc3a6e33c5ef65d36ea5c0685571a35412e9d` | Hardware button; inside the audited window | 65 / 10 | None; used `systemButton` |
| `fc596209325dbf1175def58263f4554def91fa00` | Action Button; before family consolidation and outside the window | 76 / 12 | Two vocabulary declarations in one file |
| `62a1ff1235` | Telephony; outside the window | 64 / 13 | Two vocabulary lines in one file |
| `e8da1e10d6` | Fold; outside the window | 84 / 11 | Two vocabulary lines in one file |

The helper changed once in the audited window, in `f6fc99fbc9`, for an `unlock` projection.
There were no cell-key additions in that window.
A per-cell fact projection remains necessary after the proposed inversion.
Owner availability facts and the other operation declarations also remain necessary under ADR 0019.
The historical fan-out does not show that the duplicate key list caused the cross-package edits.

## Checks and limits

The disposable checkout had its own frozen install and baseline build.
Before and after the prototype, `pnpm typecheck` and the two existing unavailable-facts smoke tests passed.
The compile probe checked mutual assignability against a copied baseline type.
It was not mutation-tested.
Mutual assignability does not prove optional-key membership; the separate patch comparison supplied that observation.
The two runtime tests exercise a few facts and do not prove backend behavior.

All 427 entry ids had identical closure membership, counts and module-scope weight before and after.
Total weight was 124,989 in each arm.
The helper appeared only in its own entry (28 modules, weight 460) and root platform runtime (41 modules, weight 648).
The named-baseline growth comparison had no findings.
This result is expected for a substitution with no added import, module or top-level statement.
It supplies loading evidence, not an ergonomic benefit.

`pnpm check:layering` passed on the prototype.
The eager-closure and closure-growth suites passed 872 tests.
Their actual gate merge base was `144bd59890277fd4717995588ad817597c9d6552`; the explicit before/after comparison used `be22676ace3f6a11d23af23a45c588a474e514be`.
Build and declaration emission were not rerun after the prototype.
Lint, format, Fallow and affected validation were not run on it.
The prototype was removed with its disposable checkout; the reviewed source stayed clean.

This is a bounded cell-level surrogate.
ADR 0028's literal next-capability-family experiment was not performed.
No whole-feature after-state, backend behavior change, eight-package saving or coordination gain is claimed.
The proposal is rejected as a solution to the measured fan-out.
A different vocabulary design needs its own representative evidence.
