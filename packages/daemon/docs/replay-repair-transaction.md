# Replay repair transaction

These contracts supplement [ADR 0012](../../../docs/adr/0012-interactive-replay.md) decision 6.
The daemon owns the repair transaction: its recording, its lifetime, and its publication.
The [divergence and resume contract](../../ad-replay/docs/divergence-and-resume.md) owns `resume` and the corrective watermark.

## Healed script source

The healed script is `session.actions`.
`session.actions` accumulates executed actions throughout session lifetime.
The session action recorder pushes them unconditionally.
The divergence refusal is pre-dispatch, so a divergent step is never pushed.
Across a repair session, original steps that verified and dispatched enter `session.actions`.
The corrective interactive actions of the agent enter `session.actions`.
Corrective actions receive fresh `target-v1` evidence because recording is armed.
Armed recording also disables the direct-iOS fast path, which permits evidence computation.
`formatSessionScript` serializes actions from the repair boundary onward (R6).

## Sub-flows

A `selector-miss` with `matchCount: 0` can mean a renamed label or an entirely incorrect screen.
The daemon distinguishes the sub-flows with R3's `repairHint`.
Only the enum crosses the wire.
`record-and-heal` selects selector-drift repair; `state-repair` selects app-state repair.
The agent follows the hint.
Only if the case is ambiguous does it override routing after a fresh `screen.refs` read or one `snapshot -i`.

1. **Selector drift:** the expected screen has a renamed or moved control.
   The agent presses the correct actionable `screen.refs` target without `--no-record`.
   This action and its fresh evidence replace the failed step in the healed script.
   `replay --from N+1 --plan-digest <original>` then continues after the manually performed step.
   A later divergence repeats the loop.
2. **App-state divergence:** the script is correct, but the app state is incorrect.
   The agent restores expected state with `--no-record` actions.
   These one-time setup actions must not enter the healed script.
   `replay --from N --plan-digest <original>` then repeats unchanged step N.

## Protocol rules

- **R1 — recording starts with the first replay.** `replay <file>.ad --save-script[=<out>]` sets `session.recordSession = true` before step 1.
  It must not wait for divergence.
  The repair replay re-executes prefix steps.
  Recording from the start supplies fresh `target-v1` evidence for those steps.
  Late activation creates a hybrid healed script: an annotated corrective step with a bare, unannotated prefix.
  That script diverges again on its own next replay.
  Interaction dispatch attaches evidence only when `recordSession` was true at execution.
- **R2 — continuation uses `--from`.** After divergence at N and correction, the agent must use `replay --from k --plan-digest <original>`.
  It must never repeat full replay on that session.
  Full replay appends prefix `1..N-1` again because the recorder pushes unconditionally.
  Replay dispatch does not inject `noRecord`.
  App-state repair uses `k = N` to repeat the unchanged step.
  Selector-drift repair uses `k = N + 1` because the agent already performed N.
- **R3 — a mechanical `repairHint` on the divergence payload determines the sub-flow; no LLM-only routing.**
  The [divergence construction contract](../../replay-port/docs/replay-divergence.md#repair-hint-computation) owns the mapping.
- **R4 — corrective actions must materialize to selectors.** The writer must refuse persisted bare `@ref` exports with an explicit error.
  `press @e12` normally resolves a `selectorChain` during touch-target resolution.
  `buildOptimizedActions` converts it to a selector line.
  Without a captured chain, the writer must refuse a bare `@ref` in persisted `.ad` output.
  A session-bound ref cannot resolve in a fresh run.
  Failure must reach the user with a nonzero exit.
  The writer must neither suppress the failure nor silently omit the line, despite existing session-write behavior.
- **R5 — repair must contain a recorded `open`.** The source script's first step must be `open --relaunch` or an explicit recorded `open`.
  This makes the healed `.ad` self-contained.
- **R6 — the healed script contains only the repair run.** `replay --save-script` records `session.actions.length` as its boundary watermark (`saveScriptBoundary`) at invocation.
  Only actions at or after that watermark are serialized.
  Earlier unrelated actions from a reused session never enter the healed script.
  The repair session itself need not be fresh.
- **R7 — the transaction persists across the live session.** The session remains addressable until commit or abort.
  `--save-script` opens a multi-invocation repair transaction persisted on the session.
  Each request does not reconstruct it from flags.
  If an armed replay returns `resume.repairSessionHeld: true`, it **MUST NOT** terminate the owning daemon or session.
  `resume.allowed` only describes plan resumability.
  It is not the lifetime signal.
  `replay --from <n> --plan-digest <sha>` continues on the same armed session **without another `--save-script`**.
  The opener is the only place where that flag appears.
  The implementation MUST use persisted transaction state for continuation and keep-alive.
  It must not depend on current-request `--save-script`.
  The R6 watermark and action slice require this one surviving session.
  Same-session continuation is therefore a lifetime guarantee, beyond R2's preference.

## Teardown and lifetime

**Every teardown commits if and only if the state is `COMPLETE`.**
Explicit `close`, idle-reap, and daemon shutdown otherwise abort without publication, including any prefix.
Idle-reap/shutdown of an incomplete transaction also leaves the [tombstone](#tombstone).
Explicit `close` of an incomplete transaction simply discards it.
A persistent-daemon precondition is explicitly rejected.
If the implementation cannot preserve lifetime, armed replay must fail before step 1 with actionable guidance.
It must not proceed and later fail `--from` with `SESSION_NOT_FOUND`.

A clean armed replay reaches `COMPLETE` and skips terminal source `close` (issue #1384).
Its session therefore survives.
Once client keep-alive uses `ReplayCommandResult.sessionActive` independently of repair state, it also preserves this daemon.
Publication remains deferred until explicit `close`/`close --save-script` or ordinary idle-reap tears down the session.
This preserves R7's post-repair inspection opportunity.
It changes timing for scripted callers that previously saw the healed sibling immediately after one-shot client exit.

## Terminal lifecycle steps

Target-binding verification applies only to annotated resolved targets.
A source `close` or any step without `target-v1` `targetEvidence` is exempt from target-binding divergence.
A real dispatch failure can still produce `action-failure`.
Absent evidence alone never causes `selector-miss`, `identity-mismatch`, or `identity-unverifiable`.

A **terminal source `close`** means the source plan's last action is `close`.
An armed replay or resume **skips it without dispatch**.
Dispatch would delete the session mid-transaction, and R7 keeps that session alive.
Thus the terminal source `close` must never run under an armed repair.
Reaching this step instead marks the transaction `COMPLETE`.
The next teardown, normally the agent's `close`/`close --save-script`, commits it.

## Digest during repair

The repair loop keeps the original file unchanged and operates in one live session.
Its original digest remains stable.
`--from k --plan-digest <original>` permits manual correction followed by continuation.
Steps `1..k-1` never re-run, so the non-idempotency guarantee of resume holds by construction.
The healed script is published only at repair completion and teardown.

## Activation and output path

- Before step 1, `replay <file>.ad --save-script[=<out>]` sets `session.recordSession = true` and records the R6 boundary.
  This follows the existing session-close `saveScript` handling.
  Without the flag, replay retains existing behavior: no recording and no repair publication.
  Explicit activation preserves ADR 0012 decision 1's prohibition on silent rewrites.
- A teardown at `COMPLETE` publishes the healed `.ad`.
  The usual trigger is `close`/`close --save-script <out>`, but every completed-transaction teardown commits.
  `SessionScriptWriter.write` serializes only the post-watermark slice.
  Without `<out>`, publication uses the **`<original-stem>.healed.ad` sibling** beside the original.
  For example, `login.ad` becomes `login.healed.ad`.
  The original is never overwritten in place without an explicit `<out>` path.
  A human reviews the diff and promotes the result.

## Commit state machine

R6 defines the *slice*.
This machine defines *when the slice may be published*, as a machine-enforceable state, not a heuristic:

- **`ARMED`:** starts immediately when `replay --save-script` activates the transaction before step 1.
  The slice accumulates and MUST NOT be published.
- **`COMPLETE`:** all executable source steps have executed or been repaired, with no outstanding divergence.
  The terminal source `close` is excluded from executable steps.
  Reaching it changes `ARMED` to `COMPLETE`.
  Only `COMPLETE` permits publication.
- **`COMMITTED`:** atomic publication succeeded.
  This state is terminal.

Explicit `close`/`close --save-script`, idle-reap, or shutdown commits if and only if the state is `COMPLETE`.
Before that state, teardown aborts, discards the slice, and publishes nothing, including a prefix.
Reaching `COMPLETE` alone writes no file.
It makes the next teardown commit instead of abort.
Publication therefore occurs once, after both completion and transaction end.
Any teardown can preserve the completed artifact without a specific finalization command.
After `COMMITTED`, teardown is idempotent and never republishes.
It cannot double-commit or trigger no-clobber refusal again.

## Publication

Commit serializes the healed slice with a final `close` line for self-contained output.
It creates a temp file **in the final target's directory**.
An explicit target can be on another mount, and `linkSync` requires the same filesystem.
One exclusive `linkSync(temp, target)` then publishes with create-if-absent, first-writer-wins semantics.
Readers never see partial output.
Aborted repair leaves no partial file.

Publication refuses every pre-existing target.
This applies to complete/partial files and default/explicit paths.
`EEXIST` occurs if and only if a file already exists at the target, irrespective of its content.
The caller must remove it or select another `replay --save-script=<path>`.
The existing file is never silently replaced.
There is no lock, lease, ownership transfer, or overwrite.
`# agent-device:heal-complete` remains a trailing marker of a complete, reviewable artifact.
It does not affect publication permission.
Automatic versioned names, such as `.healed.2.ad`, remain out of scope as a separate naming change.

The refusal applies to repair and ordinary recording.
`publishHealedScriptAtomically` is the one publication primitive used by `SessionScriptWriter.write` for every `--save-script` target.
It has no repair/ordinary branch.
Repair sets `saveScriptBoundary`; ordinary `open --save-script`/`close --save-script` recording does not.
Both use the same exclusive `linkSync`.
An ordinary recording with an existing target receives the same `AppError` for `EEXIST`.
The existing bytes remain unchanged.
The caller must remove the file or select another path.
Neither path has a `--force`/`--overwrite` override.
Issue #1258 tracks that future work.

## Tombstone

Idle-reap or shutdown before `COMPLETE` aborts without publication and must leave a tombstone.
Teardown at `COMPLETE` commits instead and needs no tombstone.
The tombstone uses the owner-scoped **session key** addressed by continuation.
It records owner and expiry and persists for a bounded period after reap.
During that period, every command on the key receives `REPAIR_SESSION_EXPIRED`, never `SESSION_NOT_FOUND`.
This includes resume, interactive correction, and `close`.
The error guides the caller to restart from the original script.
A new `replay --save-script` on the key clears the tombstone and starts a fresh `ARMED` transaction.
After bounded expiry, the tombstone disappears and the key is free.

## Observation exclusion

Inside an armed repair segment, out-of-band observation-only commands are excluded from the healed script by default (#1271 stage 2).
`--record` is the opt-in for a corrective read.
This supersedes the stage 1 (#1287) guidance to pass `--no-record` by hand on each diagnostic.

**1. Exclusion depends on provenance.** Both conditions must hold:

- The command is observation-only: `snapshot`, `get`, `is`, or read-only `find` (`exists`, `wait`, `get_text`, `get_attrs`).
  Mutating `find … click|fill|focus|type` remains a corrective action like `press`/`fill` and always records.
  The top-level `wait` command is deliberately **not** in this set.
  It is flow timing/synchronization, not observation, so it must keep recording unconditionally.
  Silent removal of timing steps would change replay behavior.
- The agent dispatches the observation **out of band** during repair.
  It is not a step from the `.ad` plan under repair.

Plan steps use the ordinary request path and enter `session.actions`.
The healed script is `buildOptimizedActions` over `session.actions.slice(saveScriptBoundary)`.
A command-only exclusion would execute an authored `is visible` and silently remove its assertion from the healed script.
The repaired flow would then stop checking what the original checked.
For a deterministic QA suite, that is the worst possible failure mode.
**Authored prefix/suffix observations must survive automatically without `--record`.**
Only provenance distinguishes authored observations from interactive diagnostics using the same command.

`invokeResolvedReplayAction` in `@agent-device/replay-port` stamps `internal.replayPlanStep` at the one dispatch point for every annotated or unannotated plan step.
`internal` is daemon-only.
`toDaemonRequest` never copies it from the wire.
A client therefore cannot forge authored provenance.
`replayTargetGuard` and `findResolvedTarget` use the same channel.
`isInteractiveObservation` defines the rule once for both recording call sites.

**2. A corrective read requires explicit inclusion.**
The failed step itself can be `get`.
Its corrective `get` must enter the healed script.
Blanket exclusion would silently remove the repaired step.
`--record` identifies the corrective read explicitly, irrespective of position.

**3. Explicit recording remains possible.**
`--record` forces an out-of-band observation into the healed script.
Its purpose is an interactive corrective read.
Outside repair, it has no effect because no default exclusion applies.
Authored plan steps need no flag because provenance preserves them.

`--record` is not a common flag.
Universal `--no-record` covers every recordable command, including mutations, through `COMMON_COMMAND_SUPPORTED_FLAG_KEYS`.
`--record` applies only where observation exclusion is possible.
Each `snapshot`, `get`, and `is` schema lists it in `allowedFlags`.
Acceptance on `press`/`fill`/`click` would be misleading.
The grammar rejects every unsupported use before projection.
`find` selects observation/mutation through a positional, so grammar permits the flag.
`handleFindCommands` dynamically rejects it on mutating `find … click|fill|focus|type` with `INVALID_ARGS` before device work.
Both routing and validation use shared `isReadOnlyFindAction` from `@agent-device/selectors`.
Their classifications therefore cannot differ.
`--record` and `--no-record` are mutually exclusive.
Every surface rejects both together with `INVALID_ARGS` before execution.
Neither silently overrides the other.

**4. CLI/Node/MCP use the same rule.**
`isExcludedRepairSegmentObservation` in `recordActionEntry` is the single daemon enforcement point.
It requires `session.saveScriptBoundary !== undefined` and the entry's `interactiveObservation` marker.
Only repair-armed `replay --save-script` sets that boundary.
Ordinary non-repair authoring never sets it.
Both recording call sites, selector recording for `get`/`is`/read-only `find` and the snapshot runtime for `snapshot`, compute the marker with shared `isInteractiveObservation`.
Every surface reaches that same daemon function.
The flags retain their different scopes:

- Common `--no-record` belongs to `COMMON_COMMAND_SUPPORTED_FLAG_KEYS`.
  Every recordable reader forwards it with `noRecordInputFromFlags`.
- Scoped `--record` is not common.
  Only `snapshot`/`get`/`is` and dynamically validated `find` permit it.
  Only their readers use `observationRecordInputFromFlags`.

Two named helpers express the capability, not one helper with an `allowRecord` policy argument.
The capability is then the NAME of the helper, so a mutating reader physically cannot forward `--record`.
A policy argument would let a future mutating reader opt in through a changed literal, with no schema change.
That fail-open is what the split prevents.
Both flags then use the ordinary typed path:

- Node forwards them through `buildRequestFlags`/`buildFlags`.
  Sources are `InternalRequestOptions`, `GetOptions`, `IsOptions`, `FindOptions`, and `CaptureSnapshotOptions`.
- MCP exposes `record`/`noRecord` on `get`/`is`/`find`/`snapshot` tools through `CommandMetadata.inputSchema` plus `readMetadataCommandFlags`, as for other typed fields.

There is no separate per-surface recording contract.

**5. The existing resume watermark detects missing corrections.**
Exclusion occurs before `session.actions`, at the same point as `--no-record`.
Excluded reads never increase `session.actions.length`.
`describeUnperformedRecordAndHeal` already compares this count with `actionsCountAtDivergence`, using the `pendingRecordAndHeal` watermark.
Count growth proves a corrective action before a `record-and-heal`-shaped resume.
A segment with only excluded diagnostics fails the existing guard like an empty segment.
No new state is necessary.
The guard's message adds `--record` beside `--no-record` because correction can be a read:
"no corrective action was recorded in this repair segment; press the correct control via a blessed `@ref` … — or, if your corrective action was a read, re-run it with `--record` … — before resuming."

## Required coverage

- A healed sibling `.ad` replays completely in a **fresh session**.
  Every selector step has an annotation.
  There is no bare `@ref`.
- Daemon-side `repairHint` computation covers all four hints and all four divergence kinds.
  The tests prove that the mapping is total.
  Missing `targetEvidence` defaults to `manual`, including PR #1223's unannotated `action-failure`.
  Sparse/unavailable capture also defaults to `manual`.
  The post-response-capture container test for `action-failure` is included.
- `--no-record` state-fix actions are excluded from the healed script.
  The corrective selector-drift action is included in the healed script.
- When recording is armed from step 1, prefix steps are re-annotated with fresh `target-v1` evidence (R1).
- `--from` continuation never duplicates the recorded prefix through another full replay on the same session (R2).
- The boundary watermark excludes the pre-invocation actions of a reused session from the healed script (R6).
- A bare `@ref` without a materializable selector causes a nonzero writer error instead of silent omission (R4).
- `resume.repairSessionHeld: true` keeps the repair session addressable for a later `--from`.
  A non-armed divergence with only `resume.allowed: true` does not keep the session live.
  Continuation uses persisted transaction state without another `--save-script`.
- A reaped incomplete transaction returns `REPAIR_SESSION_EXPIRED` through a session-key tombstone, never `SESSION_NOT_FOUND`.
  A fresh `replay --save-script` on that key clears the tombstone.
  An implementation that cannot preserve session lifetime fails before step 1 (R7).
- Every teardown (`close`, idle-reap, shutdown) commits atomically at `COMPLETE`.
  Before `COMPLETE`, it aborts without any publication, including a prefix.
  Idle-reap/shutdown at `COMPLETE` commits instead of creating a tombstone.
  After `COMMITTED`, teardown is idempotent and never republishes.
- An armed replay skips its terminal source `close` without session deletion.
- The temp file uses the target directory.
  One exclusive `linkSync` publishes it with create-if-absent, first-writer-wins semantics.
- Publication refuses **every** existing target and preserves its bytes.
  This includes complete/partial files, the default healed sibling, and explicit `--save-script=<path>`.
  It also includes ordinary non-repair `open`/`close --save-script` recording.
- Observation exclusion:
  out-of-band diagnostic reads are omitted by default within an armed repair segment;
  an authored `is visible` survives without `--record` through provenance, and a command-only exclusion fails this test;
  corrective press/fill actions remain included;
  a corrective `get` with `--record` remains included;
  the healed script replays cleanly in a fresh session;
  mutating `find … click --record` returns `INVALID_ARGS`;
  the empty-segment guard refuses blind resume with actionable `--record` guidance;
  ordinary `open --save-script` authoring still records reads without a flag and never sets `session.saveScriptBoundary`.
