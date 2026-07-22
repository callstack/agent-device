# ADR 0016: Active-Session Script Publication

## Status

Accepted

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
[`session-save-script` prototype](https://github.com/callstack/agent-device/tree/agent/prototype-session-save-replay/scripts/prototypes/session-save-script)
record the motivating workflow and API trial. Composable lifecycle-free fragments remain a separate
decision in [#1336](https://github.com/callstack/agent-device/issues/1336).

## Decision

Add an explicit publication action for an already-armed ordinary script recording:

```sh
agent-device open com.example.app --relaunch --save-script=screen-x.ad
# perform the complete journey to screen X
agent-device wait 'role="heading" label="Screen X"'
agent-device session save-script
```

`session save-script [path] [--force]` publishes the current ordinary script recording without
closing the app or deleting the session. An explicit `path` retargets the recording using the existing
target/force authorization rules. Without it, publication uses the path armed by `open --save-script`
or the existing generated default.

### Recording lifecycle

An ordinary recording eligible for active-session publication has three states:

- **ARMED**: established only when a new session's initial successful
  `open --save-script[=<path>]` is recorded as action zero. The session records portable action inputs
  and fresh target identity evidence.
- **ABORTED**: reached when another plain `open` succeeds while ARMED. The app operation may continue,
  but the recording is no longer a single-open bootstrap and close-time publication is disarmed. The
  successful `open` response warns that a fresh session is required to author another script.
- **PUBLISHED**: reached only after `session save-script` atomically commits the complete history from
  the sole recorded `open` through the current action. The session remains active at the destination,
  but close-time script publication is disarmed.

A filesystem or target-collision failure leaves the recording ARMED, including its path and same-target
`--force` authorization, so the caller can correct the target or permissions and retry. ABORTED and
PUBLISHED are terminal until the session is destroyed. `session save-script` in either state fails
loudly and never writes.

Every existing arming entry point respects terminality. `open --save-script` on any existing session —
unarmed, ARMED, ABORTED, or PUBLISHED — is rejected before app dispatch; a plain later `open` is allowed,
causing ARMED to become ABORTED while leaving ABORTED/PUBLISHED unchanged.
`close --save-script[=<path>]` in ABORTED or PUBLISHED is rejected before platform close or filesystem
work, so the caller can retry with plain `close`. Plain `close` tears down ABORTED/PUBLISHED without
writing; closing an unpublished ARMED recording retains the existing close-time publication behavior. A
fresh session is the only re-arming boundary.

This lifecycle is distinct from ADR 0012's repair transaction. `session save-script` rejects a session
with `saveScriptBoundary` set and directs the caller to finish or abort the repair through its existing
`replay --from` and teardown commit protocol. Active-session publication never marks a repair COMPLETE,
commits a healed slice, writes `# agent-device:heal-complete`, or changes repair tombstone semantics.

### Destination readiness and replay handoff

The destination is an authored postcondition, not the last navigation action. Before publication, the
recorded suffix after the last mutating action must contain a `wait` whose target is a portable selector
or selector chain identifying a landmark on the ready destination screen. A duration wait, `wait stable`,
or `wait @ref` does not qualify, though `wait stable` may follow the landmark wait. The publisher validates
the serialized guard before filesystem work and never relies on repair-only bare-ref rejection.
`session save-script` refuses publication without this **destination guard** and tells the author to
record one. V1 does not infer a screen identity from a snapshot or synthesize an implicit guard.

> **Amendment (#1349, shipped).** The guard is now identity-level, not merely selector-level. A
> selector wait recorded while ARMED captures landmark-mode `target-v1` evidence for the matched
> element (ADR 0012's read-only-step amendment), and a qualifying destination guard is exactly a
> selector wait whose annotation is `verification: "verified"` — a selector wait on an identity-empty
> element (no id and no label) records no annotation and does not qualify, so publication refuses it
> with a recovery hint naming a labeled/id-bearing landmark. On replay, polling is preserved: the wait
> keeps polling until a selector match carries the recorded identity (local identity + leaf-anchored
> ancestry prefix), and a deadline reached with only same-selector impostors fails closed as an
> `identity-mismatch` `REPLAY_DIVERGENCE` before the wait reports success. The reshuffled-screen
> false-pass below is covered by a provider-scenario regression (record → publish → replay against a
> reshuffled tree whose same-label node sits under a different id/ancestry).

The original selector-level caveat, retained as context: the guard proved that an element matching its
selector exists, not that it is the same landmark element observed while authoring, so a reshuffled
screen containing the same weak label elsewhere could false-pass.
[#1349](https://github.com/callstack/agent-device/issues/1349) owned the identity design for waits and
remaining read-only steps. It preserves polling: ADR 0012's pre-action `target-v1`
verification cannot be attached to a wait unchanged because a not-yet-present landmark is the expected
starting condition, so the identity check runs after the wait's selector resolves and before the wait
reports success (see ADR 0012's #1349 amendment for the mechanism and the read-only-step coverage
classification).

The phrase "last mutating action" is derived from a request-sensitive recording-effect trait on the
central `CommandDescriptor`, required for every command that records session actions and guarded by a
completeness test. It is not a publisher-local command-name set. The trait distinguishes app-state
mutation from observation for subcommands such as read-only versus mutating `find`, `keyboard`, and
`alert` actions; the existing conservative `refFrameEffect: may-invalidate` classification is not precise
enough for this boundary.

On consumption, a script without `close` preserves the existing replay behavior: the named session stays
active and the successful `ReplayCommandResult` returns its `session` id. The caller binds subsequent
commands to that returned id. Replay reports success only after the destination guard completes; the
absence of `close` changes neither action dispatch nor when replay reports success.

**Response shape (issue #1384).** `ReplayCommandResult` carries a required `sessionActive: boolean`,
computed from whether `session` still exists in the daemon's own store when the response is built — never
by re-parsing the script for `close`. This is what lets the real CLI/IPC client (not just the in-process
handler) actually honor "the session stays active": without an explicit signal in the response, the
client's one-shot `replay`/`test` teardown had no way to distinguish a still-active handoff from a
finished one, and tore the owning daemon down regardless (`src/daemon/client/daemon-client-lifecycle.ts`).
`sessionActive` is `true` for every close-less run (including a `--from` resume) and `false` once the
script's terminal `close` — or a repair-armed run's deferred equivalent — has executed.

### Sensitive inputs

Executable `.ad` artifacts serialize ordinary action inputs literally; diagnostic and event-log
redaction cannot protect an input that replay must later execute. ADR 0017 resolves #1348 for explicit
sensitive fills: `fill ... --record-as PASSWORD` sends the live text to the app while recording only
`${PASSWORD}`. Replay receives the value through `AD_VAR_PASSWORD` or `--env PASSWORD=<value>`.

This is opt-in and fill-only. Unparameterized fill/type inputs remain literal artifact content, so
authors must use ADR 0017 for each sensitive fill and avoid secret-bearing `type` steps. CLI help states
both the safe workflow and the remaining literal-input warning next to publication guidance.

### Artifact contract

The published `.ad`:

- contains exactly one recorded `open` as its first action and every recordable action through the
  publication request;
- contains a portable selector/selector-chain destination guard after its last descriptor-classified
  mutating action;
- does not append or serialize `session save-script` or `close`;
- uses the ordinary session context header, selector-chain optimization, and canonical `target-v1`
  annotations captured while ARMED;
- fails loudly rather than emitting an unresolved session-local `@ref` or dropping target evidence that
  ADR 0012 requires for an element-targeting recorded action; and
- uses the existing same-directory atomic publication primitive, refusing every existing target unless
  `--force` authorizes atomic replacement.

The success response identifies the final path and session and reports the number of serialized actions.
The command must fail before writing when there is no active session, recording was not armed, the
recording is ABORTED or PUBLISHED, the history does not contain exactly one initial `open`, no portable
destination guard exists, or a repair transaction owns the session. Every failure explains the recovery
action; none degrades to `{ written: false }` success.

### Surface and naming

V1 extends the existing `session` command and typed session client surface. It does not introduce
`script start/stop`, marks, or a second replay engine. CLI help makes the two phases explicit: the
existing `--save-script` flag arms evidence capture, while `session save-script` publishes without
teardown.

This ADR does not rename or deprecate `--save-script`. The flag and session action name the same persisted
artifact: `open --save-script` configures the armed recording's eventual target, while
`session save-script` requests publication now. `save-replay` is rejected because replay is the act of
executing that script, not the artifact being saved.

## Consequences

- Agents can record onboarding or deep navigation as one self-contained starting state, replay it from
  scratch, and continue from the resulting live session.
- The workflow has two explicit moments because evidence must be armed before the first target action and
  the destination is known only when the caller publishes.
- Normal unarmed interactions keep their current fast paths and retention behavior.
- A successful active-session publication cannot collide with a later close-time auto-save.
- A second successful open abandons the in-flight artifact instead of silently publishing a multi-open
  bootstrap; authoring resumes only in a fresh session.
- Intermediate lifecycle-free fragments, entry guards, include semantics, composed digests, and shared
  fragment pinning remain entirely under #1336.
- Secret-bearing fill authoring uses ADR 0017's explicit `--record-as <VAR>` contract. Unparameterized
  fill/type inputs remain literal script content. Arbitrary history ranges remain out of scope.
- On consumption (issue #1384), a `replay` whose script has no terminal `close` leaves a live daemon and
  app session behind — including the ordinary one-shot `replay` invocation's own owned/ephemeral daemon,
  which the client keeps alive and reports a `--state-dir` address hint for instead of tearing down. An
  unattended close-less replay (e.g. in CI) therefore leaks a session exactly like one opened
  interactively: bounded by ordinary idle-reap or an explicit `close`, never by the one-shot command's own
  process lifetime. This is the intended shape of "the caller owns close," not an accident, and recorded
  test flows already end with `close` so `test` runs are unaffected.

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
  selector-targeted `wait` as the recovery; `wait @ref`, duration waits, and `wait stable` are covered
  refusal cases.
- A second successful plain `open` transitions ARMED to ABORTED and disables all publication, while
  `open --save-script` on an existing session is rejected before app dispatch.
- An armed session publishes `open` plus target-annotated actions without `close`, returns the final path,
  remains active, and can continue accepting commands.
- The artifact replays from a cold start, completes its destination guard, returns the live session id,
  and accepts a subsequent command on that session.
- Every action in ADR 0012's existing target-binding command set has canonical identity evidence and no
  unresolved `@ref` reaches disk; since #1349 the destination guard additionally requires verified
  recorded landmark identity, with a reshuffled-screen false-pass regression proving replay fails
  closed.
- Existing-target refusal preserves the original bytes; `--force` replaces atomically; a failed publish
  remains retryable.
- After PUBLISHED, later ordinary actions remain usable, repeated `session save-script` fails, plain
  `open --relaunch` cannot re-arm, and `open --save-script` is rejected before app dispatch.
- In ABORTED/PUBLISHED, `close --save-script[=<other>]` is rejected before platform close and plain
  `close` tears down without writing; closing an unpublished ARMED recording preserves current
  close-time publication behavior.
- Descriptor completeness tests classify every recordable request's mutation effect, including
  request-sensitive read-only/mutating subcommands, and destination-guard ordering consumes only that
  trait.
- Repair-armed sessions refuse this action without changing repair state.
- CLI help documents ADR 0017's `--record-as` workflow and warns that unparameterized fill/type inputs
  remain literal script content.
- Provider-backed integration scenarios cover the public daemon route, and live iOS and Android runs
  prove the saved artifact and post-save session behavior on real backends.
