# ADR 0016: Active-Session Script Publication

## Status

Accepted.
This ADR is implemented on `main`, including the #1349 identity-level destination-guard amendment.

Implementation owners are `packages/daemon/src/sessions/handlers/session-script-publication.ts` and `packages/daemon/src/core/session-script-active-publication.ts`.

## Rules at a glance

This section is a normative summary.
[Decision](#decision) contains the binding contracts and refusal cases.

- `session save-script [path] [--force]` publishes the current ordinary script recording without closing the app or the session.
  The session stays live at the destination.
- Recording lifecycle:
  - Only the initial `open --save-script` of a new session establishes **ARMED**.
  - From ARMED, a second successful plain `open` causes **ABORTED**.
  - From ARMED, only a successful atomic `session save-script` establishes **PUBLISHED**.
  - ABORTED and PUBLISHED are terminal until the session is destroyed.
  - A filesystem or target failure leaves the recording ARMED and retryable.
- Publication requires exactly one initial recorded `open`, a portable selector-`wait` destination guard after the last descriptor-classified mutating action, and no unresolved session-local `@ref`.
  Since #1349, the `target-v1` annotation of the guard must be `verification: "verified"`.
  Every refusal happens before filesystem work and names its recovery.
- Repair transactions (ADR 0012) are disjoint from this lifecycle.
  A session with `saveScriptBoundary` set refuses this action without a change to repair state.
- `ReplayCommandResult.sessionActive` comes from the daemon's session store, never from a re-parse of the script.
  This signal lets a one-shot client keep the daemon alive on a close-less handoff.
- Sensitive `fill` inputs must be recorded as placeholders through `fill --record-as <VAR>` (ADR 0017, shipped for #1348).
  Unparameterized `fill`/`type` values persist literally into the artifact, so a secret entered without `--record-as` is published.
  The protection is scoped to the recording session (ADR 0017's #1398 amendment).
  A later action's own recorded evidence can never re-serialize an app-rendered echo of an already-parameterized value either.

## Context

The replay repair study found that re-recording a drifted journey was cheaper than repairing it in two of the three measured drift classes.
The immediate reusable unit is an **open-to-destination script**.
This self-contained `.ad` script opens the app, performs the complete journey to screen X, and verifies a destination landmark.
It leaves the app session active there, so an agent can continue with new work.

Ordinary script recording currently combines two concerns.
`open --save-script[=<path>]` arms recording before the first interaction.
Thus, selector chains and ADR 0012 `target-v1` identity evidence are captured at action time.
`close` publishes the accumulated script, records a terminal `close`, and tears down the session.
That artifact is suitable as a closed test flow, but not as a live starting state.

Publication only at the end of an ordinary unarmed session is insufficient.
Session history retains the commands.
But the resolved target tree that `target-v1` evidence needs is deliberately discarded after each action.
Late publication can serialize selector text, but it cannot reconstruct which element the action actually targeted.
Unconditional identity capture for every session would change normal interaction execution.
Recording disables direct selector fast paths when evidence requires a capture-backed route.
That performance and data-retention change has not been measured.

Issue [#1346](https://github.com/callstack/agent-device/issues/1346) and the disposable [`session-save-script` prototype](https://github.com/callstack/agent-device/tree/agent/prototype-session-save-replay/scripts/prototypes/session-save-script) record the motivating workflow and API trial.
Composable lifecycle-free fragments remain a separate decision in [#1336](https://github.com/callstack/agent-device/issues/1336).

## Decision

Add an explicit publication action for an already-armed ordinary script recording:

```sh
agent-device open com.example.app --relaunch --save-script=screen-x.ad
# perform the complete journey to screen X
agent-device wait 'role="heading" label="Screen X"'
agent-device session save-script
```

`session save-script [path] [--force]` publishes the current ordinary script recording without closing the app or deleting the session.
An explicit `path` retargets the recording under the existing target/force authorization rules.
Without it, publication uses the path armed by `open --save-script` or the existing generated default.

### Recording lifecycle

An ordinary recording eligible for active-session publication has three states:

- **ARMED**: only the initial successful `open --save-script[=<path>]` of a new session, recorded as action zero, establishes this state.
  The session records portable action inputs and fresh target identity evidence.
- **ABORTED**: another successful plain `open` while ARMED establishes this state.
  The app operation may continue.
  But the recording is no longer a single-open bootstrap, and close-time publication is disarmed.
  The successful `open` response warns that a fresh session is required to author another script.
- **PUBLISHED**: only a successful atomic `session save-script` establishes this state.
  That command commits the complete history from the sole recorded `open` through the current action.
  The session remains active at the destination, but close-time script publication is disarmed.

A filesystem or target-collision failure leaves the recording ARMED, including its path and same-target `--force` authorization.
Thus, the caller can correct the target or permissions and retry.
ABORTED and PUBLISHED are terminal until the session is destroyed.
In either state, `session save-script` fails with an explicit error and never writes.

Every existing arming entry point respects terminality.
On any existing session, `open --save-script` is rejected before app dispatch.
This includes unarmed, ARMED, ABORTED, and PUBLISHED sessions.
A later plain `open` is allowed.
It changes ARMED to ABORTED and leaves ABORTED/PUBLISHED unchanged.
In ABORTED or PUBLISHED, `close --save-script[=<path>]` is rejected before platform close or filesystem work.
Thus, the caller can retry with plain `close`.
Plain `close` tears down ABORTED/PUBLISHED without writing.
The close of an unpublished ARMED recording retains the existing close-time publication behavior.
A fresh session is the only re-arming boundary.

**Amendment (2026-08-02, shipped).** A never-armed session has no recorded `open --save-script` at all.
The lifecycle above has no fourth pre-ARMED state name for it.
Before this amendment, such a session used the same close-time write path as an ARMED recording.
`close --save-script` on it added the request to the authoring lifecycle at record time and published anyway.
Live evidence showed that this produced a script whose actions had selector fallback chains but no recording-time `target-v1` evidence.
The caller got no signal that evidence capture never ran.
Degraded replay verification is worse than an explicit refusal.
Now, `close --save-script` on a never-armed session is rejected before any teardown or filesystem work, the same way as in ABORTED/PUBLISHED.
The refusal names `open --save-script` as the recovery.
A plain `close` still tears the session down without writing.
This case is distinct from [#1533](https://github.com/callstack/agent-device/issues/1533), which concerns an already-ARMED-then-ABORTED session.
In that session, flag ingress re-enabled recording and let a *bare* `close` publish.
A bare `close` has no `--save-script` on the close itself.
The amendments below resolve that case.

**Amendment (#1533, shipped).** Before this amendment, only `abortAuthoringOnSecondOpen` enforced the ABORTED terminality above.
It cleared `session.recordSession`.
That enforcement depended on operation order, not on construction.
`recordSession` was an evidence-capture flag that several surfaces set directly.
Thus, a later `--save-script` re-armed it while the status stayed ABORTED.
A *bare* `close` then published the full session log through a writer that could refuse only repair transactions.
For `close --save-script` in ABORTED, this ADR specifies a refusal that promises the caller that plain `close` "tears down without writing".
Thus, the gap also made an existing error message untrue.

ABORTED is now terminal by construction.
`--save-script` arms recording through one rule that the publication projection owns.
That rule answers "not recording" for an ABORTED lifecycle on every surface that handles the flag.
These surfaces are the re-open builder, the close finalizer, and the recorded-action ingress.
Thus, the flag can no longer contradict the status.
The aggregate likewise answers publication authorization.
The writer asks one publication-blocked question.
That question covers not-recording, an uncommittable or committed repair, and an ABORTED authoring lifecycle alike.
Thus, every path that reaches the writer refuses: bare `close`, teardown, idle-reap, and active publication.
ARMED and PUBLISHED lifecycles and every repair transaction are unchanged.
No state name, transition, or entry point in the lifecycle above is added or altered.

**Amendment (#1533 follow-up, shipped).** The rule above still relied on a stored `SessionState.recordSession` field.
Every writer had to set that field in step with the lifecycle.
Routing the writes through one place made the two agree, but it did not make disagreement unrepresentable.
The field remained a second source of truth for a question that the aggregate already answered.

Recording is now **derived**, not stored.
`isRecordingPublication` reads it from the lifecycle, and the field is gone:

- Ordinary authoring records only while ARMED.
- A repair transaction records for its whole lifetime, terminal statuses included.

The derivation has three consequences:

- No surface can arm recording without a move of the lifecycle that authorizes it.
  Thus, the #1533 drift is unrepresentable, not only guarded against.
  `buildNextOpenSession` and the close finalizer now make no recording decision at all.
- The aggregate answers the whole publication gate of the writer.
  The separate ABORTED check of the writer is gone, because a terminal authoring lifecycle is already not recording.
  Thus, no second gate can disagree with the first about *authoring*.
- Evidence capture and publication authorization now derive from the same aggregate.
  But they deliberately remain **distinct predicates**.
  - They coincide for ordinary authoring: ARMED both records and publishes, and ABORTED and PUBLISHED do neither.
  - They do NOT coincide for repair.
    `isRecordingPublication` is true for every repair status, `committed` and `aborted` included.
    Publication additionally requires `isRepairArmedWriteBlocked` to pass.
    That check refuses a committed transaction (idempotent no-op) and a transaction that is not yet committable (ADR 0012 decision 6, C2).
  - Thus, a repair that captures evidence is not necessarily a repair that may publish.
    A merge of the two predicates would silently republish or commit a prefix.

This change is behavior-preserving.
The derivation reproduces exactly what the flag held at every transition.
This amendment deliberately does not answer one real question: should a *committed* repair still capture recording-time evidence?
The old flag said yes.
A change to that answer is a behavior change, not a derivation.

This lifecycle is distinct from the ADR 0012 repair transaction.
`session save-script` rejects a session with `saveScriptBoundary` set.
The refusal directs the caller to finish or abort the repair through its existing `replay --from` and teardown commit protocol.
Active-session publication never:

- Marks a repair COMPLETE.
- Commits a healed slice.
- Writes `# agent-device:heal-complete`.
- Changes repair tombstone semantics.

### Destination readiness and replay handoff

The destination is an authored postcondition, not the last navigation action.
Before publication, the recorded suffix after the last mutating action must contain a `wait` whose target is a portable selector or selector chain.
That selector must identify a landmark on the ready destination screen.
A duration wait, `wait stable`, or `wait @ref` does not qualify.
But `wait stable` may follow the landmark wait.
The publisher validates the serialized guard before filesystem work.
The publisher never relies on repair-only bare-ref rejection.
Without this **destination guard**, `session save-script` refuses publication and tells the author to record one.
V1 does not infer a screen identity from a snapshot or synthesize an implicit guard.

**Amendment (#1349, shipped).** The guard is now identity-level, not merely selector-level.
A selector wait recorded while ARMED captures landmark-mode `target-v1` evidence for the matched element (ADR 0012's read-only-step amendment).
A qualifying destination guard is exactly a selector wait whose annotation is `verification: "verified"`.
A selector wait on an identity-empty element (no id and no label) records no annotation and does not qualify.
Publication refuses it with a recovery hint that names a labeled/id-bearing landmark.

On replay, polling is preserved.
The wait keeps polling until a selector match carries the recorded identity (local identity + leaf-anchored ancestry prefix).
If the wait reaches its deadline with only same-selector impostors, it fails closed as an `identity-mismatch` `REPLAY_DIVERGENCE` before the wait reports success.
A provider-scenario regression covers the reshuffled-screen false-pass below.
That regression records, publishes, then replays against a reshuffled tree whose same-label node is under a different id/ancestry.

**Amendment (#1398, ADR 0017).** An identity-empty landmark is not the only case that fails to qualify.
A selector wait can have an app-rendered echo as its only identity.
If that echo is of a literal that the recording session already parameterized through `fill --record-as`, the wait also records no annotation.
This is ADR 0017's session-scoped echo protection.
Thus, that wait does not qualify as a destination guard either.
Publication refuses it with the same recovery hint and directs the author to a stable, non-value-bearing landmark.
This refusal enforces exactly the fix that the motivating scenario of issue #1398 applied by hand.

The original selector-level caveat is retained as context.
The guard proved that an element that matches its selector exists.
It did not prove that the element is the same landmark element observed while authoring.
Thus, a reshuffled screen with the same weak label elsewhere could false-pass.
[#1349](https://github.com/callstack/agent-device/issues/1349) owned the identity design for waits and remaining read-only steps.
That design preserves polling.
ADR 0012's pre-action `target-v1` verification cannot be attached to a wait unchanged, because a not-yet-present landmark is the expected starting condition.
Thus, the identity check runs after the wait's selector resolves and before the wait reports success.
ADR 0012's #1349 amendment defines the mechanism and the read-only-step coverage classification.

The phrase "last mutating action" derives from a request-sensitive recording-effect trait on the central `CommandDescriptor`.
Every command that records session actions requires this trait, and a completeness test guards it.
It is not a publisher-local command-name set.
The trait distinguishes app-state mutation from observation for subcommands, such as read-only versus mutating `find`, `keyboard`, and `alert` actions.
The existing conservative `refFrameEffect: may-invalidate` classification is not precise enough for this boundary.

On consumption, a script without `close` preserves the existing replay behavior.
The named session stays active, and the successful `ReplayCommandResult` returns its `session` id.
The caller binds subsequent commands to that returned id.
Replay reports success only after the destination guard completes.
The absence of `close` changes neither action dispatch nor when replay reports success.

**Response shape (issue #1384).** `ReplayCommandResult` carries a required `sessionActive: boolean`.
The daemon computes it when it builds the response, from whether `session` still exists in the daemon's own store.
The daemon never computes it by a re-parse of the script for `close`.
This field lets the real CLI/IPC client (not only the in-process handler) actually honor "the session stays active".
Before this field, the response had no explicit signal.
The one-shot `replay`/`test` teardown of the client had no way to distinguish a still-active handoff from a finished one.
It tore the owning daemon down regardless (`src/daemon-client/daemon-client-lifecycle.ts`).
`sessionActive` is `true` for every close-less run, including a `--from` resume.
It is `false` once the terminal `close` of the script, or the deferred equivalent of a repair-armed run, has executed.

### Sensitive inputs

Executable `.ad` artifacts serialize ordinary action inputs literally.
Diagnostic and event-log redaction cannot protect an input that replay must later execute.
ADR 0017 resolves #1348 for explicit sensitive fills.
`fill ... --record-as PASSWORD` sends the live text to the app while it records only `${PASSWORD}`.
Replay receives the value through `AD_VAR_PASSWORD` or `--env PASSWORD=<value>`.

This protection is opt-in and fill-only.
Unparameterized fill/type inputs remain literal artifact content.
Thus, authors must use ADR 0017 for each sensitive fill and avoid secret-bearing `type` steps.
CLI help states both the safe workflow and the remaining literal-input warning next to publication guidance.

ADR 0017's #1398 amendment extends this protection to the whole recording session.
A later, unrelated recorded action can no longer re-serialize an app-rendered echo of an already-parameterized literal into its own result or `target-v1` evidence.
Thus, a value protected once by `--record-as` stays protected for every action recorded after it in the same session, not only in its own originating fill.

### Artifact contract

The published `.ad`:

- Contains exactly one recorded `open` as its first action, and every recordable action through the publication request.
- Contains a portable selector/selector-chain destination guard after its last descriptor-classified mutating action.
- Does not append or serialize `session save-script` or `close`.
- Uses the ordinary session context header, selector-chain optimization, and canonical `target-v1` annotations captured while ARMED.
- Fails with an explicit error instead of emitting an unresolved session-local `@ref`.
  It also fails with an explicit error instead of dropping target evidence that ADR 0012 requires for an element-targeting recorded action.
- Uses the existing same-directory atomic publication primitive.
  It refuses every existing target unless `--force` authorizes atomic replacement.

The success response identifies the final path and session and reports the number of serialized actions.
The command must fail before writing in each of these cases:

- There is no active session.
- Recording was not armed.
- The recording is ABORTED or PUBLISHED.
- The history does not contain exactly one initial `open`.
- No portable destination guard exists.
- A repair transaction owns the session.

Every failure explains the recovery action.
No failure degrades to `{ written: false }` success.

### Surface and naming

V1 extends the existing `session` command and the typed session client surface.
It does not introduce `script start/stop`, marks, or a second replay engine.
CLI help makes the two phases explicit:

1. The existing `--save-script` flag arms evidence capture.
2. `session save-script` publishes without teardown.

This ADR does not rename or deprecate `--save-script`.
The flag and the session action name the same persisted artifact.
`open --save-script` configures the eventual target of the armed recording.
`session save-script` requests publication now.
`save-replay` is rejected, because replay is the act of executing that script, not the artifact being saved.

## Consequences

- Agents can record onboarding or deep navigation as one self-contained starting state, replay it from scratch, and continue from the resulting live session.
- The workflow has two explicit moments.
  Evidence must be armed before the first target action.
  The destination is known only when the caller publishes.
- Normal unarmed interactions keep their current fast paths and retention behavior.
- A successful active-session publication cannot collide with a later close-time auto-save.
- A second successful open abandons the in-flight artifact instead of silently publishing a multi-open bootstrap.
  Authoring resumes only in a fresh session.
- Intermediate lifecycle-free fragments, entry guards, include semantics, composed digests, and shared fragment pinning remain entirely under #1336.
- Secret-bearing fill authoring uses ADR 0017's explicit `--record-as <VAR>` contract.
  Unparameterized fill/type inputs remain literal script content.
  Arbitrary history ranges remain out of scope.
- On consumption (issue #1384), a `replay` whose script has no terminal `close` leaves a live daemon and app session behind.
  This includes the owned/ephemeral daemon of the ordinary one-shot `replay` invocation.
  The client keeps that daemon alive and reports a `--state-dir` address hint for it instead of a teardown.
  Thus, an unattended close-less replay (for example, in CI) leaks a session exactly like a session opened interactively.
  Ordinary idle-reap or an explicit `close` bounds it, never the process lifetime of the one-shot command.
  This is the intended shape of "the caller owns close", not an accident.
  Recorded test flows already end with `close`, so `test` runs are unaffected.

## Alternatives Considered

- **Save any session history at the end.** Rejected, because target identity evidence cannot be reconstructed after the interaction.
  The resulting artifact would weaken ADR 0012's provenance model.
- **Capture full target evidence in every session.** Rejected until its direct-path latency, capture count, memory, and event-log costs are measured.
  It would alter ordinary interaction behavior to make one authoring command shorter.
- **`close --no-close` or `--save-script --no-close`.** Rejected, because a command named for teardown would conditionally preserve the session.
  It also would not solve late arming.
- **General `script start/stop` or history marks.** Rejected, because the accepted v1 boundary is exactly one recorded `open` through one destination.
  Arbitrary slices require entry-state semantics and belong with fragment design.
- **`replay save`.** Rejected, because `replay <path>` consumes an artifact while publication consumes a live session.
  The session owns the source data and lifecycle.
- **Infer a destination fingerprint at publication.** Rejected for v1, because screen identity and readiness are app semantics.
  A caller-authored target wait is explicit, already recordable, and fails at the correct point during cold replay.

## Validation Required for Implementation

- An unarmed session refuses publication before filesystem work and names `open --save-script` as the recovery.
- An armed session without a destination guard refuses publication before filesystem work and names a selector-targeted `wait` as the recovery.
  `wait @ref`, duration waits, and `wait stable` are covered refusal cases.
- A second successful plain `open` changes ARMED to ABORTED and disables all publication.
  `open --save-script` on an existing session is rejected before app dispatch.
- An armed session publishes `open` plus target-annotated actions without `close`.
  It returns the final path, remains active, and can continue to accept commands.
- The artifact replays from a cold start, completes its destination guard, returns the live session id, and accepts a subsequent command on that session.
- Every action in ADR 0012's existing target-binding command set has canonical identity evidence, and no unresolved `@ref` reaches disk.
  Since #1349, the destination guard additionally requires verified recorded landmark identity.
  A reshuffled-screen false-pass regression proves that replay fails closed.
- Existing-target refusal preserves the original bytes.
  `--force` replaces atomically.
  A failed publish remains retryable.
- After PUBLISHED, later ordinary actions remain usable, and a repeated `session save-script` fails.
  Plain `open --relaunch` cannot re-arm.
  `open --save-script` is rejected before app dispatch.
- In ABORTED/PUBLISHED, `close --save-script[=<other>]` is rejected before platform close.
  Plain `close` tears down without writing.
  The close of an unpublished ARMED recording preserves the current close-time publication behavior.
- On a never-armed session (2026-08-02 amendment), `close --save-script` is likewise rejected before platform close or filesystem work.
  The refusal names `open --save-script` as the recovery.
  Plain `close` still tears down without writing.
  The rejected request does not delete the session.
- Descriptor completeness tests classify the mutation effect of every recordable request, including request-sensitive read-only/mutating subcommands.
  Destination-guard ordering consumes only that trait.
- Repair-armed sessions refuse this action without a change to repair state.
- CLI help documents ADR 0017's `--record-as` workflow.
  CLI help warns that unparameterized fill/type inputs remain literal script content.
- Provider-backed integration scenarios cover the public daemon route.
  Live iOS and Android runs prove the saved artifact and the post-save session behavior on real backends.
