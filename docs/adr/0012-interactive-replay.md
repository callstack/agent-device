# ADR 0012: Interactive Replay (agent-in-the-loop repair, resolution disclosure, retiring silent `--update` healing, and agent-supervised re-record repair)

## Status

Accepted (2026-07-10). Implemented, including the amendments folded into the decisions below (#1264, #1269, #1271 stage 2, #1280, #1349, #1385, and the 2026-08-07 mutating-ambiguity amendment).
Only the replay benchmark extension of decision 5 remains deferred.

## Context

Deterministic replay of an `.ad` script costs zero model turns on the happy path.
An agent-driven flow costs one model turn for each step.
Replay therefore pays only where reality diverged from the recording.
At acceptance, replay had three gaps:

- `--update` healing retried only the recorded selector text, so it could not rescue a renamed id or label. When it acted, it rewrote the `.ad` file in place and disclosed only a count.
- Ordinary selector resolution silently chose a winner among several matches by visibility, depth, and area. Responses disclosed neither the match count nor the tiebreak. Replay used the same resolution, so a moved target could bind to a different node.
- A failed replay reported the step and selector but not the current screen. Only a full replay from step 1 was available, and Maestro step indices did not map to source lines.

## Decision

### 1. Retire `--update` healing as an actor; repurpose its candidate machinery as ranked suggestions

`--update`/`-u` does not rewrite `.ad` files.
Replay uses the recorded-selector candidate machinery only to fill the bounded, ranked, node-deduplicated `suggestions` list in a divergence report (decision 4).
The order is identity components, then the same `scrollRegion` for a verified `target-v1` annotation, then document order.
Response levels affect only report content, never file behavior.
No unattended repair path exists.
The [divergence construction contract](../../packages/replay-port/docs/replay-divergence.md#suggestions) owns the ranking.

### 2. Disclose daemon-tree disambiguation and identify fast-path responses

Every element resolution discloses how it resolved, in the additive `resolution` response field:

- `runtime`/`unique`;
- `runtime`/`disambiguated` (`matchCount`, `tiebreak`, up to 5 alternatives);
- `ref`/`exact` or `ref`/`label-fallback`;
- `direct-ios`/`not-observed`.

Several runtime matches succeed only if they form one ancestor–descendant wrapper chain for the same actionable node (`tiebreak: "structural-equivalence"`).
Distinct subtrees fail before mutation with `AMBIGUOUS_MATCH` and at most five candidates.
Geometry never selects among distinct mutating targets.
Successful structural-collapse alternatives are pre-action diagnostics and issue no refs.
A distinct-subtree rejection issues a partial ref frame for immediate retry.
Label recovery of a stale `@ref` must never claim exact ref provenance.
The direct-iOS fast path has no daemon tree, so it must never invent a unique-match or identity claim.
Coordinate dispatches and executed Maestro coordinate fallbacks carry no `resolution`.
The executed dispatch, not permission to fall back, determines that cell.
ADR 0011's `resolutionDisclosure` guarantee row enforces this decision.
The [resolution disclosure contract](../../packages/command-runtime/docs/resolution-disclosure.md) owns the shapes and the matrix cells.

### 3. Versioned `.ad` target-binding evidence

Recording writes one versioned JSON comment, `# agent-device:target-v1 {...}`, immediately before each action that resolves an element target.
An action that resolves two elements writes one `targets-v1` annotation with `source` and `destination`, and replay refuses the whole action if either endpoint fails.
The payload has three tiers:

- identity, compared exactly: unique id, else role+label, plus a leaf-anchored ancestry prefix;
- disambiguation signals, consulted only when several nodes share the identity: `sibling`, then region-scoped `viewportOrder`;
- diagnostics, never compared: `rect`.

Absolute geometry is not part of identity.
Scroll offset, rotation, dynamic type, window resizing, and layout shifts move rects between healthy runs, and identical siblings can share a rect.
No absolute-coordinate tolerance exists in v1. A future tolerance must carry measured evidence.
An inserted or removed wrapper ancestor changes identity.

Replay classifies every annotated step before dispatch through six exact verification paths.
Only a verified result sends the action.
Anything that the evidence cannot isolate is an `identity-unverifiable` divergence, never a silent pick.
The recorder must never emit a payload that its parser rejects. The writer downgrades oversized evidence to `verification: "unverifiable"` and drops its rect. If the payload still exceeds the serialized limit after dropping the rect (escape-heavy values), the writer measures again and writes no annotation; that action replays without a target check.
The format is additive. Old readers ignore the comment, and new readers run unannotated actions without the check.
An annotation binds only to the next physical action line.

Amendments:

- A non-unique id demotes to role+label (#1269).
- A press on an identity-empty container records its first labeled descendant only if two fail-closed guards permit it. The live response still describes the dispatched container (#1280).
- Each evidence-carrying command declares its verification phase with the `targetIdentityVerification` descriptor trait. `wait` verifies landmark identity during polling, and `is` uses pre-dispatch verification (#1349).
- The pre-dispatch verification capture retries a content-quality `capture-failed`/`sparse-snapshot` verdict with a bounded delay budget, to survive an app-launch race. This retry is opt-in for each call site (#1385).

The [target annotation contract](../../packages/ad-script/docs/target-annotation.md) owns the format, normalization, bounds, record-time write, and verification paths.
The [divergence construction contract](../../packages/replay-port/docs/replay-divergence.md#pre-dispatch-capture-retry) owns the launch-race retry.

### 4. Divergence wire contract and replay-only resume

Divergence is a structured error, not success data.
Action failure and target-binding mismatch both return `ok:false`, code `REPLAY_DIVERGENCE`, and `details.divergence` v1.
`kind` is `action-failure`, `selector-miss`, `identity-mismatch`, or `identity-unverifiable`.
The report carries a bounded `screen`, ranked `suggestions`, one `repairHint` enum, and `resume`.

- `screen` uses the same capture scope as plain `snapshot`. An agent must never see a healthier `screen` in a divergence report than a plain `snapshot` would show it (#1264). Only an available screen issues refs, as a partial ref frame under ADR 0014.
- Capture failure never replaces or conceals the original replay cause.
- Serialized ceilings are 8/24/64 KiB for the compact, default, and full response levels. Overflow goes to a redacted session-scoped artifact.
- Entered text is never serialized. Native `.ad` replay replaces expanded variable values with `<var:NAME>` in human-readable divergence fields.
- Every surface (daemon text, JSON, Node client `AppError`, MCP `structuredContent`) preserves the structured error. No surface may reduce divergence to text and discard repair data.

Resume is `replay --from N --plan-digest <sha>`.
`N` is a 1-based index into the fully expanded executable plan.
`test` rejects `--from`, because a suite run must remain full and deterministic.
`planDigest` covers the canonical expanded plan, including identity evidence and the effective target, so an edit cannot silently change ordinal N's target.
Resume reconstructs no state. Maestro preflight rejects a resume that skips an `outputEnv` producer or enters runtime control flow.
`resume.allowed` describes plan resumability only. `resume.repairSessionHeld` is the only session-lifetime signal.
`resume.alternateFrom` offers the recorded-correction ordinal for dual-path hints.

The loop is:

1. Run the replay.
2. Read the divergence.
3. Repair the app state.
4. Replay with the reported plan digest and index.
   If you completed the failed action as a recorded action, use the next index: `from` for `record-and-heal`, or `alternateFrom` for `caution`/`manual`.

An edited script requires a fresh full replay and a new digest.
The [divergence and resume contract](../../packages/ad-replay/docs/divergence-and-resume.md) owns the fields, bounds, redaction, surfaces, ordinals, watermark, and digest.

### 5. Mandatory validation

Benchmark evidence alone does not establish acceptance.
Automated coverage gates acceptance: guarantee-matrix cells, parser/writer round trips, all six verification paths, wire-projection parity, `--update` no-write, and the decision 6 transaction rules.
Each owner contract lists its required coverage.
Extend the settle benchmark with a replay arm only after these contracts pass.
That arm measures clean replay and one induced divergence repaired through the `--from` loop.

### 6. Agent-supervised re-record repair ("heal-by-doing")

Decision 1 retires silent rewrites. This decision adds explicit agent-driven repair without restoring unattended selector application.
Models should not edit `.ad` text.
For selector drift, the agent instead performs the failed step's intent through fresh actionable refs from the divergence `screen`.
The CLI produces a healed `.ad` from the session's actual successful execution path.
This requires neither text edits nor silent similarity-based repair.
The healed script is the session's recorded actions from the repair boundary onward. No new splice engine exists.

The daemon computes a mechanical `repairHint` that routes the repair:

- `record-and-heal`: selector drift. The agent performs the step as a recorded action and resumes at N + 1.
- `state-repair`: app-state divergence. The agent fixes state with `--no-record` actions and resumes at N.
- `caution`: `identity-mismatch`. Something matched the recorded selector, so a blind re-press may repeat the mistake.
- `manual`: unverifiable identity, missing evidence, unavailable capture, or any case not proven safe.

Repair is opt-in: `replay --save-script` opens a persisted `ARMED` → `COMPLETE` → `COMMITTED` transaction.
Explicit activation preserves decision 1's prohibition on silent rewrites.
The loop keeps the original file unchanged in one live session, so its original digest remains stable.
Seven normative rules govern it:

- **R1:** recording is armed from step 1, so the prefix gets fresh evidence.
- **R2:** continuation uses `--from`, never another full replay on the same session.
- **R3:** the daemon computes `repairHint`; the agent never computes it.
- **R4:** the writer must refuse a persisted bare `@ref` with a nonzero error.
- **R5:** the source script must start with a recorded `open`.
- **R6:** the `saveScriptBoundary` watermark bounds the healed slice to the repair run.
- **R7:** the transaction persists on the live session until commit or abort. If the implementation cannot preserve lifetime, armed replay must fail before step 1.

Every teardown commits if and only if the state is `COMPLETE`.
Before `COMPLETE`, teardown publishes nothing, and idle-reap or shutdown leaves a `REPAIR_SESSION_EXPIRED` tombstone.
An armed replay skips a terminal source `close` and marks the transaction `COMPLETE`.
Publication writes `<original-stem>.healed.ad` beside the original unless the caller names a path. The original is never overwritten in place.
One exclusive `linkSync` publishes the file and refuses every pre-existing target, for repair and ordinary `--save-script` recording alike.

Inside an armed repair segment, out-of-band observation-only commands are excluded from the healed script by default.
Plan-step provenance (`internal.replayPlanStep`) keeps authored observations.
`--record` is the opt-in for a corrective read, on `snapshot`, `get`, `is`, and read-only `find` only (#1271 stage 2).

The [repair transaction contract](../../packages/daemon/docs/replay-repair-transaction.md) owns the rules, state machine, publication, tombstone, and observation exclusion.
The [divergence construction contract](../../packages/replay-port/docs/replay-divergence.md#repair-hint-computation) owns the `repairHint` mapping.

## Rationale

- An agent can accept, reject, or edit a proposed repair in one inexpensive model turn. This costs less than detection of a silent incorrect repair later.
- Selector agreement does not prove target identity. Only verified identity evidence can bind a recorded step to the same target.
- Disclosure lets an agent see when a heuristic chose the target. Elsewhere, the repository refuses ambiguous input and gives hints.
- Structural equivalence keeps the common React Native case, where one label sits on a row, button, and text wrapper chain, without a geometric guess.
- Plan-bound resume keeps steps `1..N-1` from running again. Non-idempotent scripts would otherwise repeat their side effects.
- Heal-by-doing records evidence fresh from the node that the agent actually pressed, so nothing re-matches a stale selector.

## Rejected alternatives

- **New guarded-sequence batch engine.** Replay already sequences steps with progress and failure reports. It needs disclosure, verification, and resume, not a second engine.
- **`--agent`/agent-mode replay flag.** The richer divergence report can be the default error shape. Deterministic CI can ignore additional error data.
- **Retain `--update` auto-heal with target verification.** Decision 3 verifies resolved targets without retry-and-rewrite behavior. Reconsider only if agentless CI needs a separately specified and testable repair policy.
- **Auto-heal tiers (safe tier applied, risky tier surfaced): deferred, not rejected.** No evidence base shows which heals are safe. Reconsider if agentless CI demand for self-repair appears.
- **Hand-edit `.ad` text (status quo).** It is hostile to models: a measured small-model repair run corrupted escaped selector chains to `INVALID_ARGS`.
- **Silent automatic rewrite.** It risks incorrect binding, because selector agreement does not prove target identity.
- **Geometric disambiguation of mutating targets.** It bound the wrong element in a measured case. Blanket rejection of every multi-match is also unsuitable, because it breaks wrapper chains.
- **An absolute rect tolerance in identity.** No measured drift distribution justifies any constant.
- **A publish lock that protects only complete healed files.** It adds lock, lease, and reclaim races for a partial file. Exclusive `linkSync` decides the winner instead.
- **Infer a corrective read from its position relative to the later `--from`.** The daemon records actions immediately and cannot know their future resume role, so the inference would retrospectively reinterpret intent. `--record` marks the corrective read explicitly.
- **One flag helper with an `allowRecord` policy argument.** A changed literal could let a mutating reader forward `--record` with no schema change. Two named helpers make the capability the helper's name.

## Consequences

- `--from` makes app state the caller's responsibility. The daemon never infers app state. Resume requires a matching digest and proof that variables and control flow do not depend on skipped execution.
- `--from` must never repeat steps `1..N-1`. This is a hard constraint on the semantics of the flag.
- Agentless callers lose CI self-repair. A nightly run that formerly patched a selector now remains failed. This is accepted because heal had limited utility and silent target-binding risk.
- Successful structural collapse adds bounded diagnostics. Direct-iOS unique responses add only `not-observed`.
- Identity evidence is an additive `.ad` format change. A duplicate that structural evidence cannot distinguish causes a pre-action unverifiable divergence instead of a guess.
- Decision 6 retains ordinary interactive risk: an agent can press an incorrect visible ref, and live interactive commands have no target-binding verification. This is not a new failure class.
- Default and full `screen.refs` hold at most 20 entries. If the required control is absent, one additional `snapshot -i` retrieves it. This cost is bounded and disclosed.
- A healed script is a new script for future runs, with the same non-idempotency risk as any hand-written `.ad`.
- A clean armed one-shot replay defers publication until teardown, so scripted callers see the healed file later (#1384).

## Open gaps

- Deterministic state reconstruction for resume needs a separate specification and tests.
- The replay benchmark arm of decision 5 is deferred.
- Automatic versioned healed names are out of scope.
- Read-only coverage stays deferred for `is exists`, `is absent`, `wait absent`, read-only `find`, and `wait` forms without an element target.
