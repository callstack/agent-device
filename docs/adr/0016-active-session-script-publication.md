# ADR 0016: Active-Session Script Publication

## Status

Accepted.

Completed process history is in git history.

Implementation owners are `packages/daemon/src/sessions/handlers/session-script-publication.ts` and `packages/daemon/src/core/session-script-active-publication.ts`.

## Rules at a glance

[Decision](#decision) contains binding contracts and refusal cases.

- `session save-script [path] [--force]` publishes ordinary script recording without closing the app or session.
  The session remains live at the destination.
- Only a new session's initial `open --save-script` establishes **ARMED**.
  A second successful plain `open` causes **ABORTED**.
  Successful save causes **PUBLISHED**.
  ABORTED and PUBLISHED remain terminal until session destruction.
  Filesystem/target failure leaves ARMED retryable.
- Publication requires exactly one initial recorded `open`, no unresolved session-local `@ref`, and a portable selector-`wait` destination guard after the last descriptor-classified mutation.
  The guard's `target-v1` annotation must have `verification: "verified"` (#1349).
  Every refusal precedes filesystem work and names recovery.
- A session with `saveScriptBoundary` refuses this action without repair-state changes (ADR 0012).
- The daemon session store supplies `ReplayCommandResult.sessionActive`.
  Clients use this signal to retain the daemon after a close-less handoff.
- Sensitive `fill` values must use `fill --record-as <VAR>` (ADR 0017, #1348).
  Unparameterized `fill`/`type` values persist literally, so an entered secret without `--record-as` is published.
  Protection applies across the recording session (#1398).
  Later actions cannot serialize app-rendered echoes of already-parameterized values.

## Context

The replay repair study found complete re-records cheaper than repairs in two of three measured drift classes.
The immediate reusable unit is an **open-to-destination script**.
This self-contained `.ad` script opens an app, reaches screen X, verifies a destination landmark, and leaves the session active for further work.

Ordinary recording combines two concerns.
`open --save-script[=<path>]` arms recording before the first interaction.
It captures selector chains and ADR 0012 `target-v1` identity evidence at action time.
`close` publishes accumulated actions, adds terminal `close`, and tears down the session.
That artifact serves closed test flows, not live starting states.

Late publication from an ordinary unarmed session is insufficient.
History retains commands but intentionally discards the resolved target tree after each action.
Late publication can serialize selector text but cannot reconstruct the actual target identity.
Unconditional identity capture would change normal execution.
Recording disables direct selector fast paths when evidence requires a capture-backed route.
This performance and data-retention change remains unmeasured.

Issue [#1346](https://github.com/callstack/agent-device/issues/1346) and the disposable [`session-save-script` prototype](https://github.com/callstack/agent-device/tree/agent/prototype-session-save-replay/scripts/prototypes/session-save-script) record the workflow and API trial.
Composable lifecycle-free fragments remain a separate decision in [#1336](https://github.com/callstack/agent-device/issues/1336).

## Decision

Add explicit publication for an already-armed ordinary recording:

```sh
agent-device open com.example.app --relaunch --save-script=screen-x.ad
# perform the complete journey to screen X
agent-device wait 'role="heading" label="Screen X"'
agent-device session save-script
```

`session save-script [path] [--force]` publishes without app close or session deletion.
An explicit `path` retargets recording under existing target/force authorization rules.
Without it, publication uses the path from `open --save-script` or the existing generated default.

### Recording lifecycle

An eligible ordinary recording has three states:

- **ARMED**: only a new session's initial successful `open --save-script[=<path>]`, recorded as action zero, establishes this state.
  The session records portable inputs and fresh target identity evidence.
- **ABORTED**: another successful plain `open` while ARMED establishes this state.
  The app operation may continue.
  The recording no longer represents a single-open bootstrap, and close-time publication is disarmed.
  The successful `open` warns that another script requires a fresh session.
- **PUBLISHED**: successful atomic `session save-script` commits complete history from the sole recorded `open` through the current action.
  The session remains active at the destination, with close-time publication disarmed.

Filesystem or target-collision failure preserves ARMED, path, and same-target `--force` authorization.
The caller can correct target or permissions and retry.
ABORTED and PUBLISHED remain terminal until session destruction.
In either state, `session save-script` fails explicitly without a write.

Every arming entry point respects terminality.
On any existing session, `open --save-script` rejects before app dispatch.
This includes unarmed, ARMED, ABORTED, and PUBLISHED sessions.
A later plain `open` is permitted.
It changes ARMED to ABORTED and preserves ABORTED/PUBLISHED.
In ABORTED or PUBLISHED, `close --save-script[=<path>]` rejects before platform close or filesystem work.
The caller can retry plain `close`.
Plain `close` tears down those states without a write.
Close of unpublished ARMED recording retains existing close-time publication.
Only a fresh session permits re-arming.

**Amendment (2026-08-02).** A never-armed session has no fourth pre-ARMED state name here.
Late close-time arming can produce selector fallback chains without recording-time `target-v1` evidence.
Live evidence showed that callers received no signal that identity capture never ran.
Degraded replay verification is worse than explicit refusal.
Thus, `close --save-script` on never-armed sessions rejects before teardown or filesystem work.
It names `open --save-script` as recovery.
Plain `close` still tears down without a write.
This differs from [#1533](https://github.com/callstack/agent-device/issues/1533), which concerns an ARMED-then-ABORTED session.

**Amendment (#1533).** A mutable `recordSession` evidence flag could disagree with ABORTED lifecycle state.
A later `--save-script` could enable evidence capture while status remained ABORTED.
A bare `close` could then publish through a writer that refused only repair transactions.
This contradicted the promised plain-close behavior after `close --save-script` refusal.
Clearing the flag in `abortAuthoringOnSecondOpen` depended on operation order instead of state construction.

**Amendment (#1533 follow-up).** Recording is **derived**, not stored.
Routing flag writes through one owner still allowed a second source of truth to disagree with lifecycle state.
The stored `SessionState.recordSession` field is removed.
`isRecordingPublication` derives evidence capture from lifecycle:

- Ordinary authoring records only while ARMED.
- Repair transactions record throughout their lifetime, including terminal statuses.

Consequences of this derivation are:

- No surface can arm recording without a lifecycle transition that authorizes it.
  `buildNextOpenSession` and the close finalizer make no recording decision.
- The aggregate answers the writer's publication gate.
  Every write path uses that gate, including bare `close`, teardown, idle-reap, and active publication.
  A separate ABORTED check is unnecessary because terminal authoring already means no recording.
- Evidence capture and publication authorization share the aggregate but remain **distinct predicates**.
  For ordinary authoring, ARMED records and publishes; ABORTED/PUBLISHED do neither.
  For repair, `isRecordingPublication` remains true even for `committed` and `aborted`.
  Publication additionally requires `isRepairArmedWriteBlocked` to permit the write.
  It refuses committed transactions as idempotent no-ops and transactions not yet committable (ADR 0012 decision 6, C2).

A repair that captures evidence cannot necessarily publish.
Combining these predicates could republish committed transactions or commit an incomplete prefix.
The derivation preserves the former flag's behavior at every transition.
Whether committed repairs should still capture recording-time evidence remains unanswered.
The former flag permitted it.
Changing it would change behavior, not merely derive state.

This lifecycle is distinct from ADR 0012 repair transactions.
If `saveScriptBoundary` is set, `session save-script` rejects.
Recovery uses the existing `replay --from` and teardown commit protocol to finish or abort repair.
Active publication never:

- Marks repair COMPLETE.
- Commits a healed slice.
- Writes `# agent-device:heal-complete`.
- Changes repair tombstone semantics.

### Destination readiness and replay handoff

The destination is an authored postcondition, not the last navigation action.
After the last mutating action, the recorded suffix must contain a portable selector or selector-chain `wait` for a ready-screen landmark.
Duration waits, `wait stable`, and `wait @ref` do not qualify.
`wait stable` may follow the landmark wait.
Before filesystem work, the publisher validates the serialized guard.
It never relies on repair-only bare-ref rejection.
Without this **destination guard**, `session save-script` refuses and tells the author to record one.
V1 neither infers screen identity from snapshots nor synthesizes implicit guards.

**Amendment (#1349).** The guard requires identity, not only a selector.
A selector wait recorded while ARMED captures landmark-mode `target-v1` evidence (ADR 0012's read-only-step amendment).
Only a selector wait with `verification: "verified"` qualifies.
An identity-empty element without id or label records no annotation and cannot qualify.
Publication refuses it with a recovery hint for a labeled/id-bearing landmark.

Replay retains polling until a selector match has the recorded local identity and leaf-anchored ancestry prefix.
If only same-selector impostors exist at deadline, it fails closed with `identity-mismatch` `REPLAY_DIVERGENCE` before wait success.
A provider regression records, publishes, then replays against a rearranged tree whose same-label node has different id/ancestry.
It proves rejection of that false success.

**Amendment (#1398, ADR 0017).** Echo-only identity also cannot qualify.
If a selector wait's only identity echoes a literal already parameterized through `fill --record-as`, it records no annotation.
Publication uses the same refusal hint and directs the author to a stable non-value-bearing landmark.
This enforces the manual correction in #1398's motivating scenario.

The original selector-only guard proved existence, not landmark identity.
A rearranged screen could pass with the same weak label elsewhere.
[#1349](https://github.com/callstack/agent-device/issues/1349) owns identity design for waits and remaining read-only steps.
ADR 0012's pre-action verification cannot apply unchanged because an absent landmark is an expected initial wait condition.
The identity check therefore runs after selector resolution and before wait success.
ADR 0012's #1349 amendment defines the mechanism and read-only coverage classification.

A request-sensitive recording-effect trait on central `CommandDescriptor` defines the last mutating action.
Every command that records session actions requires this trait under a completeness test.
The publisher has no local command-name set.
For `find`, `keyboard`, and `alert`, the trait distinguishes read-only from mutating subcommands.
Conservative `refFrameEffect: may-invalidate` is insufficiently precise here.

Consumption preserves existing close-less replay behavior.
The named session remains active, and successful `ReplayCommandResult` returns its `session` id.
The caller binds subsequent commands to that id.
Replay reports success only after guard completion.
Absence of `close` changes neither action dispatch nor success timing.

**Response shape (issue #1384).** `ReplayCommandResult` requires `sessionActive: boolean`.
Response construction computes it from the daemon store's current existence of `session`, never from script parse.
This enables the real CLI/IPC client to retain active handoff sessions.
Without it, one-shot `replay`/`test` teardown could not distinguish live handoff from completed work and stopped the owning daemon.
The client owner is `src/daemon-client/daemon-client-lifecycle.ts`.
`sessionActive` is true for every close-less run, including `--from` resume.
It becomes false after terminal `close` or the deferred equivalent in repair-armed runs.

### Sensitive inputs

Executable `.ad` artifacts serialize ordinary action inputs literally.
Diagnostic/event-log redaction cannot protect inputs that replay must execute.
ADR 0017 resolves #1348 for explicit sensitive fills.
`fill ... --record-as PASSWORD` sends live text to the app but records only `${PASSWORD}`.
Replay receives the value through `AD_VAR_PASSWORD` or `--env PASSWORD=<value>`.

This behavior is opt-in and fill-only.
Unparameterized fill/type inputs remain literal artifact content.
Authors must use ADR 0017 for each sensitive fill and avoid secret-bearing `type` steps.
CLI help places the safe workflow and literal-input warning beside publication guidance.

ADR 0017's #1398 amendment protects the whole recording session.
Later unrelated actions cannot serialize an already-parameterized literal's app-rendered echo in their result or `target-v1` evidence.
A value protected once remains protected for all subsequent recorded actions in that session.

### Artifact contract

The published `.ad`:

- Contains exactly one initial recorded `open` and every recordable action through publication request.
- Contains a portable selector/selector-chain destination guard after its last descriptor-classified mutation.
- Appends neither `session save-script` nor `close`.
- Uses ordinary session context header, selector-chain optimization, and canonical `target-v1` annotations captured while ARMED.
- Fails explicitly on unresolved session-local `@ref` or missing target evidence required by ADR 0012.
- Uses the existing same-directory atomic publication primitive.
  Every existing target is refused unless `--force` authorizes atomic replacement.

Success identifies final path and session and reports serialized action count.
Before any write, the command must fail if:

- No active session exists.
- Recording was not armed.
- Recording is ABORTED or PUBLISHED.
- History lacks exactly one initial `open`.
- No portable destination guard exists.
- A repair transaction owns the session.

Every failure explains recovery.
None becomes `{ written: false }` success.

### Surface and naming

V1 extends existing `session` and the typed session client surface.
It adds no `script start/stop`, marks, or second replay engine.
CLI help makes both phases explicit:

1. `--save-script` arms evidence capture.
2. `session save-script` publishes without teardown.

This ADR neither renames nor deprecates `--save-script`.
The flag and session action identify the same artifact.
`open --save-script` configures the armed recording's eventual target.
`session save-script` requests immediate publication.
`save-replay` is rejected because replay executes the script instead of naming the saved artifact.

## Consequences

- Agents can record onboarding or deep navigation as a self-contained starting state, replay it from the start, and continue in the live session.
- The workflow needs two explicit phases.
  Evidence capture must start before the first target action.
  The destination becomes known only at publication.
- Ordinary unarmed interactions retain fast paths and retention behavior.
- Successful active publication cannot conflict with later close-time auto-save.
- A second successful open abandons the current artifact instead of silently publishing a multi-open bootstrap.
  Only a fresh session resumes authoring.
- Intermediate lifecycle-free fragments, entry guards, includes, composed digests, and shared fragment pins remain under #1336.
- Sensitive fills use ADR 0017 `--record-as <VAR>`.
  Unparameterized fill/type inputs remain literal script content.
  Arbitrary history ranges remain outside scope.
- Close-less `replay` leaves a live daemon and app session (#1384).
  This includes the ordinary one-shot invocation's owned/ephemeral daemon.
  The client retains it and reports a `--state-dir` address hint.
  Unattended close-less replay therefore retains a session like interactive open.
  Ordinary idle reap or explicit `close` bounds its lifetime, not the one-shot process.
  This intentionally assigns close ownership to the caller.
  Recorded test flows already end with `close`, so `test` runs remain unaffected.

## Alternatives Considered

- **Save any session history at the end.** Rejected because target identity cannot be reconstructed after interaction.
  The artifact would violate ADR 0012 provenance.
- **Capture full target evidence in every session.** Rejected until direct-path latency, capture count, memory, and event-log costs are measured.
  It would change ordinary interaction behavior merely to shorten one authoring command.
- **`close --no-close` or `--save-script --no-close`.** Rejected because a teardown-named command would conditionally retain sessions.
  It also would not solve late arming.
- **General `script start/stop` or history marks.** Rejected because v1 covers exactly one recorded `open` through one destination.
  Arbitrary slices need entry-state semantics and belong to fragment design.
- **`replay save`.** Rejected because `replay <path>` consumes artifacts, while publication consumes live sessions.
  The session owns source data and lifecycle.
- **Infer destination fingerprints at publication.** Rejected for v1 because screen identity and readiness are app semantics.
  Caller-authored waits are explicit, recordable, and fail at the correct point in cold replay.

## Validation Required for Implementation

- Unarmed sessions refuse publication before filesystem work and name `open --save-script` as recovery.
- Armed sessions without destination guards refuse before filesystem work and name selector-targeted `wait` as recovery.
  Tests include `wait @ref`, duration waits, and `wait stable` refusals.
- A second successful plain `open` changes ARMED to ABORTED and disables all publication.
  Existing-session `open --save-script` rejects before app dispatch.
- Armed sessions publish `open` and annotated actions without `close`.
  They return final path, remain active, and accept further commands.
- Cold replay completes the guard, returns the live session id, and accepts a later command in that session.
- Every action in ADR 0012's target-binding set has canonical identity evidence.
  No unresolved `@ref` reaches disk.
  Destination guards require verified landmark identity (#1349).
  A rearranged-screen regression proves closed replay failure.
- Existing-target refusal preserves original bytes.
  `--force` replaces atomically.
  Failed publication remains retryable.
- After PUBLISHED, ordinary actions remain usable and repeated `session save-script` fails.
  Plain `open --relaunch` cannot re-arm.
  `open --save-script` rejects before app dispatch.
- In ABORTED/PUBLISHED, `close --save-script[=<other>]` rejects before platform close.
  Plain `close` tears down without a write.
  Unpublished ARMED close preserves existing publication behavior.
- On never-armed sessions, `close --save-script` rejects before platform close or filesystem work and names `open --save-script` as recovery.
  Plain `close` still tears down without a write.
  The rejected request does not delete the session.
- Descriptor completeness tests classify every recordable request's mutation effect, including request-sensitive subcommands.
  Only that trait controls destination-guard order.
- Repair-armed sessions refuse this action without repair-state changes.
- CLI help documents `--record-as` and literal unparameterized fill/type content.
- Provider-backed integration scenarios cover the public daemon route.
  Live iOS and Android runs prove artifact contents and post-save session behavior on real backends.
