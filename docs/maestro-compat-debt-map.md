# Maestro Compatibility Architecture

This map describes the direct compatibility engine after ADR 0015. Maestro YAML has one production
route: typed parse, immutable plan compilation, typed execution, and a runtime port backed by public
agent-device commands. There is no `SessionAction` lowering, private command namespace, runtime
fallback, or second compatibility engine.

| Area | Owners | Shared boundary | Remaining risk |
| --- | --- | --- | --- |
| Program parsing | `program-ir*.ts`, `program-loader.ts` | Source-preserving typed IR | The supported Maestro subset must reject unknown syntax explicitly. Keep parser modules focused as the grammar grows. |
| Plan and resume | `replay-plan*.ts`, `replay-plan-digest.ts` | Immutable expanded plan and digest | Runtime control steps are opaque resume boundaries. Includes, static conditions, and environment inputs must remain digest-bound. |
| Execution | `engine*.ts`, `runtime-port*.ts` | Typed commands, observation generations, runtime port | Mutation must invalidate observation evidence. Scoped and output variables must not leak across flow boundaries. |
| Daemon binding | `daemon-runtime-port*.ts` | Typed calls to public daemon commands | Reuse same-generation observation snapshots only as semantic evidence for atomic iOS selector dispatch, never as coordinate geometry. Otherwise preserve one fresh target snapshot, structured target retries, and platform-independent command semantics. Never restore private compatibility dispatch or re-enter Maestro parsing. |
| Target policy | `runtime-target*.ts` | Shared snapshot model in provider order | Exact-or-regex selector behavior and visibility are compatibility policy. Default selection follows Maestro's first-match semantics; explicit `index` selects a later match. Provider normalization belongs below this layer. |
| Gestures | `runtime-port-geometry*.ts` | ADR 0013 normalized single-pointer input | Preserve authored absolute/percentage endpoints exactly. Maestro does not own multi-touch planning or injection. |
| Failure and resume reporting | `session-replay-maestro-*.ts` | ADR 0012 `REPLAY_DIVERGENCE` wire contract | Source paths, step ordinals, artifacts, scrubbed variables, screen digest, and typed resume preflight must survive nested control failures. |
| Trusted scripts | `run-script-*.ts` | Typed environment/output maps | `node:vm` is not a security sandbox. Keep execution flow-local and do not expand trust without a separate product decision. |
| Suite integration | `session-test-*.ts`, replay backend selection | Existing test lifecycle and artifacts | YAML discovery must remain backend-scoped; `.ad` continues through generic replay even inside a Maestro suite. |

## Deliberately Removed

- Generic `SessionAction` conversion and `replayControl` wrappers.
- Private `__maestro*` command routing and positional JSON decoding.
- WeakMap compatibility state and action-after-assertion replay.
- `wait`/`find` fallback chains after coordinate input.
- Selector-name heuristics for text-entry coalescing.
- Fuzzy substring matching that broadened plain Maestro text selectors.
- Duplicate-stack ranking and visible-context promotion over provider order.
- Fabricated tab-strip slots and ancestor geometry used in place of provider rectangles.
- Cached gesture frames; percentage gestures use fresh shared viewport evidence.

## Convergence Rules

1. Compatibility aliases normalize into shared public commands; they do not clone platform input.
2. Single-pointer target and viewport plans stay distinct from ADR 0013 multi-touch plans.
3. Retry policy is typed and budgeted. Infrastructure failures propagate unless a structured error is explicitly retriable.
4. Performance comparisons count provider queries, captures, retries, hierarchy bytes, and warm latency, not only daemon round trips.
5. New parity behavior needs a typed-IR fixture, an engine/runtime-port test, and live Android+iOS evidence when device behavior is involved.
