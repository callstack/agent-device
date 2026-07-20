# ADR 0016: Active-Session Script Publication

## Status

Proposed

## Context

The replay repair study found re-recording a drifted journey cheaper than repairing it in two of the
three measured drift classes. The immediate reusable unit is an **open-to-destination script**: a
self-contained `.ad` script that opens the app, performs the complete journey to screen X, verifies a
destination landmark, and leaves the app session active there so an agent can continue with new work.

Ordinary script recording currently combines two concerns. `open --save-script[=<path>]` arms
recording before the first interaction so selector chains and ADR 0012 `target-v1` identity evidence
are captured at action time. `close` publishes the accumulated script, records a terminal `close`, and
tears down the session. That artifact is suitable as a closed test flow, but not as a live starting
state.

Publishing only at the end of an ordinary unarmed session is insufficient. Session history retains the
commands, but the resolved target tree needed for `target-v1` evidence is deliberately discarded after
each action. Late publication can serialize selector text; it cannot reconstruct which element was
actually acted on. Making identity capture unconditional for every session would change normal
interaction execution: recording disables direct selector fast paths when a capture-backed route is
required for evidence. That performance and data-retention change has not been measured.

Issue [#1346](https://github.com/callstack/agent-device/issues/1346) and the throwaway
[`session-save-replay` prototype](https://github.com/callstack/agent-device/tree/agent/prototype-session-save-replay/scripts/prototypes/session-save-replay)
record the motivating workflow and API trial. Composable lifecycle-free fragments remain a separate
decision in [#1336](https://github.com/callstack/agent-device/issues/1336).

## Decision

Add an explicit publication action for an already-armed ordinary script recording:

```sh
agent-device open com.example.app --relaunch --save-script=screen-x.ad
# perform the complete journey to screen X
agent-device wait 'role="heading" label="Screen X"'
agent-device session save-replay
```

`session save-replay [path] [--force]` publishes the current ordinary script recording without
closing the app or deleting the session. An explicit `path` retargets the recording using the existing
target/force authorization rules. Without it, publication uses the path armed by `open --save-script`
or the existing generated default.

### Recording lifecycle

Ordinary script recording gains a two-state publication lifecycle:

- **ARMED**: established by `open --save-script[=<path>]` before target-bearing actions run. The session
  records portable action inputs and fresh target identity evidence.
- **PUBLISHED**: reached only after `session save-replay` atomically commits the complete history from
  the recorded `open` through the current action. The session remains active at the destination, but
  close-time script publication is disarmed.

A publication failure leaves the recording ARMED, including its path and same-target `--force`
authorization, so the caller can correct the target or permissions and retry. PUBLISHED is terminal for
that recording: later actions are ordinary session work and a later `close` performs teardown only. V1
does not re-arm or publish multiple open-to-destination artifacts from one session.

This lifecycle is distinct from ADR 0012's repair transaction. `session save-replay` rejects a session
with `saveScriptBoundary` set and directs the caller to finish or abort the repair through its existing
`replay --from` and teardown commit protocol. Active-session publication never marks a repair COMPLETE,
commits a healed slice, writes `# agent-device:heal-complete`, or changes repair tombstone semantics.

### Destination readiness and replay handoff

The destination is an authored postcondition, not the last navigation action. Before publication, the
recorded suffix after the last mutating action must contain a target-bearing `wait` for a landmark that
identifies the ready destination screen. A duration wait or `wait stable` alone does not qualify, though
`wait stable` may follow the landmark wait. `session save-replay` refuses publication without this
**destination guard** and tells the author to record one. V1 does not infer a screen identity from a
snapshot or synthesize an implicit guard.

On consumption, a script without `close` preserves the existing replay behavior: the named session stays
active and the successful `ReplayCommandResult` returns its `session` id. The caller binds subsequent
commands to that returned id. Replay reports success only after the destination guard completes; the
absence of `close` changes neither action dispatch nor the success response shape.

### Sensitive inputs

Executable `.ad` artifacts serialize action inputs literally. A recorded `fill` therefore writes its
text to the published file; diagnostic and event-log redaction cannot protect an input that the replay
engine must later execute. V1 does not claim secret-bearing login flows are safe to publish.

Native `.ad` replay already supports late-bound `${VAR}` values, but ordinary recording cannot yet
execute with a real value while publishing only its placeholder. That safe-authoring capability is
tracked in [#1348](https://github.com/callstack/agent-device/issues/1348). Until it ships, authors must not
record a journey that enters a secret: use pre-authenticated test state or deliberately non-secret fixture
credentials that are safe to persist. CLI help must state this warning next to the authoring workflow.

### Artifact contract

The published `.ad`:

- contains one recorded `open` and every recordable action through the publication request;
- contains a destination guard after its last mutating action;
- does not append or serialize `session save-replay` or `close`;
- uses the ordinary session context header, selector-chain optimization, and canonical `target-v1`
  annotations captured while ARMED;
- fails loudly rather than emitting an unresolved session-local `@ref` or dropping target evidence that
  ADR 0012 requires for an element-targeting recorded action; and
- uses the existing same-directory atomic publication primitive, refusing every existing target unless
  `--force` authorizes atomic replacement.

The success response identifies the final path and session and reports the number of serialized actions.
The command must fail before writing when there is no active session, recording was not armed, no
recorded `open` or destination guard exists, or a repair transaction owns the session. Every failure
explains the recovery action; none degrades to `{ written: false }` success.

### Surface and naming

V1 extends the existing `session` command and typed session client surface. It does not introduce
`script start/stop`, marks, or a second replay engine. CLI help makes the two phases explicit: the
existing `--save-script` flag arms evidence capture, while `session save-replay` publishes without
teardown.

This ADR does not rename or deprecate `--save-script`. Renaming the arming flag is a separate compatibility
decision; `--save-replay` would be misleading if it only armed capture, while `--record-replay` would add
new vocabulary without improving the v1 workflow.

## Consequences

- Agents can record onboarding or deep navigation as one self-contained starting state, replay it from
  scratch, and continue from the resulting live session.
- The workflow has two explicit moments because evidence must be armed before the first target action and
  the destination is known only when the caller publishes.
- Normal unarmed interactions keep their current fast paths and retention behavior.
- A successful active-session publication cannot collide with a later close-time auto-save.
- Intermediate lifecycle-free fragments, entry guards, include semantics, composed digests, and shared
  fragment pinning remain entirely under #1336.
- Secret-bearing authoring remains unsafe until #1348; the initial workflow is limited to journeys that
  do not enter secrets. Arbitrary history ranges remain out of scope.

## Alternatives Considered

- **Save any session history at the end:** rejected because target identity evidence cannot be
  reconstructed after the interaction and the resulting artifact would undercut ADR 0012's provenance
  model.
- **Capture full target evidence in every session:** rejected until its direct-path latency, capture
  count, memory, and event-log costs are measured. It would alter ordinary interaction behavior to make
  one authoring command shorter.
- **`close --no-close` or `--save-script --no-close`:** rejected because a command named for teardown
  would conditionally preserve the session and because it would not solve late arming.
- **General `script start/stop` or history marks:** rejected because the accepted v1 boundary is exactly
  one recorded `open` through one destination. Arbitrary slices require entry-state semantics and belong
  with fragment design.
- **`replay save`:** rejected because `replay <path>` consumes an artifact while publication consumes a
  live session; the session owns the source data and lifecycle.
- **Infer a destination fingerprint at publication:** rejected for v1 because screen identity and
  readiness are app semantics. A caller-authored target wait is explicit, already recordable, and fails
  at the correct point during cold replay.

## Validation Required for Implementation

- An unarmed session refuses publication before filesystem work and names `open --save-script` as the
  recovery.
- An armed session without a destination guard refuses publication before filesystem work and names a
  target-bearing `wait` as the recovery.
- An armed session publishes `open` plus target-annotated actions without `close`, returns the final path,
  remains active, and can continue accepting commands.
- The artifact replays from a cold start, completes its destination guard, returns the live session id,
  and accepts a subsequent command on that session.
- Every supported element-targeting action has canonical identity evidence and no unresolved `@ref`
  reaches disk.
- Existing-target refusal preserves the original bytes; `--force` replaces atomically; a failed publish
  remains retryable.
- Closing after successful publication performs no second write, while closing an unpublished ARMED
  ordinary recording preserves current close-time publication behavior.
- Repair-armed sessions refuse this action without changing repair state.
- CLI help warns that literal `fill` inputs are persisted and tells authors not to record secret-bearing
  journeys until #1348's parameterized-input mechanism is available.
- Provider-backed integration scenarios cover the public daemon route, and live iOS and Android runs
  prove the saved artifact and post-save session behavior on real backends.
