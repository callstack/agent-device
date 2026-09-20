# #2682 physical-device checklist — `thymikee-iphone` (coordinator-owned)

Simulator evidence is recorded in `DECISION.md`. This is the same scenario on the physical lane.
Use a purpose-specific session name; close it afterwards. Do not reuse another lane's session.

```sh
UDID=<thymikee-iphone udid from: agent-device devices --platform ios>
S="--platform ios --udid $UDID --session apex2682-physical"
bin/agent-device.mjs open com.callstack.agentdevicelab $S --foreground
```

The fixture must show its own surface (Metro/dev-client per `examples/test-app/README.md`); an
already-installed bundle id is not evidence.

## Sequence

1. `bin/agent-device.mjs screenshot --out /tmp/2682-1-app.png $S` → fixture app.
2. Hand off inside the app (prefer a real in-app handoff; the AccessorySetupKit/permission or an
   external link surface both qualify). Fallback that exercises the identical runner path:
   `xcrun devicectl handle URL`/a user tap that opens Safari or Settings.
3. `bin/agent-device.mjs screenshot --out /tmp/2682-2-foreign.png $S`
4. `bin/agent-device.mjs snapshot -i $S | tee /tmp/2682-3-snapshot.txt`
5. `bin/agent-device.mjs snapshot -i $S` (again, app already foreground)
6. `bin/agent-device.mjs close $S`

## Expected BEFORE (`main`, no disclosure)

- Step 3 shows the other app; step 4 shows the fixture app's tree.
- Nothing in either output says why. The only record is in the session's `runner.log`:
  `AGENT_DEVICE_RUNNER_ACTIVATE bundle=com.callstack.agentdevicelab state=<2|3> reason=<reason>`.
- A run where step 3 still shows the fixture app is not evidence — the handoff must be visible.

## Expected AFTER (PR1 head)

- Step 4 carries, as a warning line and as `data.targetActivation` from PR2:
  `The session app was not foreground when this command arrived (prior state runningBackground), so
  the runner activated it before answering (reason
  <stale_target|bundle_changed|missing_after_wait|interaction_foreground_guard>). Any capture taken
  earlier in this session described the only app other than the session app with an active
  accessibility session (pid <N>), not the session app. Re-capture now that the session app answers,
  or drive the other app in its own session.`
- Step 5 carries no disclosure — the fact belongs to the command that activated.
- `<N>` is a **liveness** claim and the sentence is written to claim no more: `otherActiveApplicationPid`
  is present only when exactly one application other than the session app held an active accessibility
  session. `activeApplications` exposes no ordering, so nothing here proves which app owned the screen.
  A pid that is not an AX-active application of the session is a bug; an absent pid is not.

## Proving the disclosure comes from activation, not a later state read

`priorState` is read at `RunnerTests+Lifecycle.swift` inside `activateTarget` **before**
`XCUIApplication.activate()` runs, and the fact is stamped only in the branch where `activate()` is
actually called. Assert the pair on the same device run:

- `runner.log`: `AGENT_DEVICE_RUNNER_ACTIVATE_FACT bundle=... reason=... priorState=2
  otherActiveApplicationPid=<N>` — the same line's `priorState` is what the response must carry;
  `state=` on the preceding `AGENT_DEVICE_RUNNER_ACTIVATE` must be non-foreground.
- The response can therefore never report `priorState: runningForeground`. Both directions are pinned
  in the runner unit lane (`UnitTests/RunnerTests+LifecycleCacheTests.swift`): the already-foreground
  call asserts `pendingTargetActivation == nil` and the backgrounded call asserts the stamped
  `priorState` equals `XCUIApplication.State.runningBackground.rawValue`.
- Correlate `<N>` with the app from step 3: `xcrun devicectl list processes --device $UDID` (or the
  physical-lane equivalent of the simulator's `ps`) should find that pid alive. Confirming it is
  AX-active is what the runner probed; confirming it *owned the screen* is not what this fact claims.
  On a physical device `proc_pidpath`-style resolution is deliberately NOT attempted.

## Still to prove on this lane (PR1 risk list)

- Whether `activeApplications` reports more than the session app while a foreign app is foreground
  on real hardware (decides how often `otherActiveApplicationPid` is present at all).
- That screenshot stays lifecycle, #2438 in-place system-host serving still applies (Apple Pay sheet
  from **Automation lab → Open Apple Pay**), and ADR 0005 `targetReset` on external relaunch is
  untouched.

## Not covered by the disclosure shipped in PR2

`press <x> <y>` and `press @ref` answered from a live ref frame consume no capture, so they carry no
disclosure even though the runner may have re-activated the app to serve them. Treat a silent
interaction as "unknown", never as "no repair". Follow-up: callstack/agent-device#2694.

## PR2 simulator lane — daemon disclosure (apex-2682-proto, iOS 26.2)

Driven with `bin/agent-device.mjs` after `pnpm build && pnpm clean:daemon`, session `apex2682-pr3`,
off-app handoff via `xcrun simctl openurl <UDID> https://example.com` before each command. Every
command below re-activated the session app, and each answered with `targetActivation` plus the
appended warning:

| Command | Result |
| --- | --- |
| `snapshot -i` | warning first in `warnings`, ahead of the AX-backend warning; `targetActivation` carried |
| `snapshot -i --level digest` | `targetActivation` survives the digest projection |
| `find "Tab Bar" --first` | disclosed on the matched response |
| `press 'label="INFO"'` | disclosed on the interaction response |
| `wait 'label="INFO"' 8000` | disclosed on the satisfied response |

`otherActiveApplicationPid` on the simulator was the Safari process, consistent across commands (pid 33878).

### Proof the review asked for on this lane

The false-attribution class is covered by unit tests rather than a device run, because the device
cannot show a cache hit on command: `src/daemon/__tests__/capture-disclosure-target-activation.test.ts`
pins that a cache-reused tree discloses nothing, and
`src/daemon/interaction/internal/__tests__/interaction-target-activation-disclosure.test.ts` pins that
a press which consumed no capture is not disclosed against an older tree.

## Why the live activation lane is manual

`test/integration/smoke-ios-target-activation.test.ts` is env-gated and deliberately absent from the
`ios.yml` / `replays-manual.yml` test lists. On GitHub-hosted simulators the runner reads its own
target as `.runningForeground` while a foreign app is provably on screen (uploaded artifact of
https://github.com/callstack/agent-device/actions/runs/35460535722/job/105943468492: rendered app
screenshot, Settings screenshot, 31 captures in ~450 ms each, no repair). The runner is then correct
to activate nothing, so a CI assertion on the disclosure measures `XCUIApplication.state` on that
host rather than this feature. Tracked as callstack/agent-device#2696.

Manual evidence stands in for it, and both are reproducible:
- local simulator (`apex-2682-proto`), first capture after the handoff: the shared sentence in
  `data.warnings`, printed under the snapshot node count and naming a non-foreground prior state and the
  pid probe — `The session app was not foreground when this command
  arrived (prior state runningBackground), so the runner activated it before answering (reason
  stale_target). Any capture taken earlier in this session described the only app other than the
  session app with an active accessibility session (pid 33878), not the session app. Re-capture now
  that the session app answers, or drive the other app in its own session.` — and, on this head, the
  typed fact beside it as `data.targetActivation`:
  `{"reason":"stale_target","priorState":"runningBackground","otherActiveApplicationPid":33878}`.
  PR1 alone carries the sentence only; the typed field is this PR's daemon seam. Either way the
  following capture reports neither.
- the physical device sequence in this file, which the coordinator runs.
