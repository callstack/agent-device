# Physical iOS runner handoff - device verification checklist (#2681)

Automated tests cover the gates and the lane predicate. What they cannot prove is that a real
`xcodebuild build-for-testing` process on a cabled iPhone survives the daemon that started it and
serves the next daemon. Every claim below needs a physical iOS 17+ device.

Not run by the implementing agent: this phase had no device access. Nothing here is assumed proven.

## Preconditions

- [ ] Cabled iPhone, iOS 17+, unlocked, developer mode on, visible to `xcrun devicectl list devices`.
- [ ] `pnpm install --frozen-lockfile && pnpm build && pnpm build:xcuitest && pnpm clean:daemon`
      (the daemon does not self-reload; `clean:daemon` drops retained simulator evidence).
- [ ] `pnpm daemon:state-dir` -> note as `$STATE_DIR`. Daemon lifecycle diagnostics: `$STATE_DIR/daemon.log`.
- [ ] `node bin/agent-device.mjs device list --json` -> note the physical iOS entry as `$DEVICE_ID`
      (its lease file is named after it) and confirm `iosPhysicalDeviceBackend` is `coredevice`.
- [ ] Lease root: `~/.agent-device/apple-runner/leases/$DEVICE_ID.json` unless
      `AGENT_DEVICE_IOS_RUNNER_LEASE_DIR` is set. Note as `$LEASE`.
- [ ] `jq -r .runnerLogPath $LEASE` -> note as `$RUNNER_LOG`. This is the file the runner's own
      standard output and error were redirected into at spawn, and the path the next daemon keeps
      writing to after adoption.

Read-only PID inspection below is evidence gathering. It is not the recovery path: ownership
recovery stays on `device status --stale` / `device release --stale` (see
`docs/agents/device-verification.md`).

## 1. Detach on graceful shutdown (the new path)

- [ ] `node bin/agent-device.mjs open <app> --platform ios --udid <UDID> --session p2681 --foreground -i --json`
      -> snapshot returns nodes. This is what publishes the session `ready`; without it there is nothing to hand off.
- [ ] Record `$RUNNER_PID`, `$RUNNER_PORT`, `$OWNER_TOKEN` from `$LEASE` (`jq .runnerPid,.port,.ownerToken $LEASE`).
- [ ] `node bin/agent-device.mjs daemon stop` (graceful; never `kill -9`).
- [ ] `$LEASE` `ownerToken` now matches `^detached-owner-`.
- [ ] `grep '"phase":"ios_runner_session_detached"' "$STATE_DIR/daemon.log"` -> one line with
      `"lane":"physical_coredevice"`, the recorded `runnerPid`, and `runnerLogPath` equal to `$RUNNER_LOG`.
      A handoff whose diagnostics are missing is a finding even when the runner survives: diagnostics
      are how the next engineer sees why a handoff did or did not happen.
- [ ] `ps -p $RUNNER_PID -o pid,etime,comm` -> the same `xcodebuild`/runner process is alive and its
      elapsed time spans the restart.

## 2. Output still reaches the log after the handoff

The handoff closes only this daemon's copy of the log descriptor. A runner that dies on its next
write would look like a healthy adoption and then fail minutes later, which is the failure this
section exists to catch.

- [ ] Nothing a client sends forces `xcodebuild` to write on demand, so take the two moments it does:
      unplug the cable for 10 s and replug it, and later (step 3) close the session so the runner
      tears itself down. Both make the process write to the descriptor it inherited at spawn.
- [ ] After the replug: `wc -c "$RUNNER_LOG"` grew and `tail -40 "$RUNNER_LOG"` shows new output while
      `ps -p $RUNNER_PID -o pid,etime` shows the same process, undisturbed by the handoff.
- [ ] After step 3's `close --session p2681`: the same file ends with the runner's own teardown line.
- [ ] If the runner vanished instead: capture `$RUNNER_LOG` and `daemon.log`, and treat it as the
      SIGPIPE regression the file-backed stdio restructure was written to remove.

## 3. Adoption by the next daemon

- [ ] `node bin/agent-device.mjs snapshot -i --json --session p2681 --platform ios --udid <UDID>` (or `open` again).
- [ ] In that request's `$STATE_DIR/sessions/p2681/requests/<requestId>.ndjson`:
  - [ ] `"phase":"ios_runner_lease_adopted"` with `"lane":"physical_coredevice"` and `runnerPid` equal to `$RUNNER_PID`.
  - [ ] No `xctestrun` build phase and no second `launch_xcodebuild` for this request:
        `"phase":"ios_runner_session_startup_timings"` carries `data.timings` with
        `adopt_detached_runner` and without `build_xctestrun` or `launch_xcodebuild`.
  - [ ] Wall time is a reclaim, not a rebuild: compare against a cold physical start on this device
        (`AGENT_DEVICE_IOS_RUNNER_DETACH=0` on the daemon, then repeat 1 and 3 and time the first command).
- [ ] `ps -p $RUNNER_PID` unchanged across both daemons.
- [ ] Then `node bin/agent-device.mjs close --session p2681`, and at least five interaction
      round-trips (`press`/`snapshot -i`) on a fresh session to prove the adopted transport is usable
      for repeated writes, not only one read.

## 4. Cold CoreDevice tunnel probe budget

The physical lane retries the uptime probe after the tight 500 ms probe fails, because a cabled
tunnel wakes lazily and a Wi-Fi-only CoreDevice device is invisible to usbmuxd. The two caps are the
`runner-adoption.ts` constants `RUNNER_ADOPTION_PROBE_TIMEOUT_MS` (500 ms) and
`RUNNER_ADOPTION_COLD_TUNNEL_PROBE_TIMEOUT_MS` (5000 ms), both clamped to whatever the request's
startup phase budget has left.

- [ ] Repeat 1 and 3 after the Mac has been idle long enough to drop the tunnel (or after unplug/replug).
- [ ] Request ndjson shows `"phase":"ios_runner_lease_adoption_probe"` twice with
      `"probePhase":"tight"` then `"probePhase":"cold_tunnel"`, and record for each: `timeoutMs`,
      `budgetCapMs`, and `durationMs`.
- [ ] The 5000 ms cold cap is sized against a real cold `devicectl` tunnel lookup on this device.
      Record the measured `durationMs` of the tight probe and of the cold probe here, so the next
      change to either cap is a measurement and not a guess. The capture is the request ndjson itself;
      no separate `devicectl device info details` export is kept.
- [ ] If the second probe also fails: `"phase":"ios_runner_lease_adoption_skipped"` with a typed
      reason (`probe_failed`, or `probe_budget_exhausted` when the request's own budget was already
      spent), and the next command starts a fresh runner. That is the designed outcome, not a failure -
      record the timings and the reason.

## 5. A device that changed while the runner was orphaned

Between detach and adopt the runner is owned by nobody, and the transport it was started on may have
been rebuilt underneath it. Adoption must fail closed into a rebuild rather than hang or half-work.

- [ ] Unplug the cable after step 1, wait 10 s, replug, then run step 3. Expect the probe to refuse
      (`probe_failed`) and the next command to start a fresh runner. Total time to a working snapshot
      must be bounded by the probe caps plus one cold start - never an unbounded wait.
- [ ] Reboot the iPhone after step 1 and bring it back unlocked, then run step 3. Same expectation.
- [ ] Force a Developer Mode / DDI remount (reboot into a state where `devicectl` re-pairs the
      developer disk image), then run step 3. Same expectation.
- [ ] After any of the three: `grep '"phase":"ios_runner_lease_adopted"' "$STATE_DIR/daemon.log"` shows
      no adoption for the dead generation, and `$LEASE` was replaced rather than left `detached-` forever.

## 6. The orphaned runner must not block the toolchain

A detached runner holds a device session for as long as it lives. That is affordable only if it does
not make the ordinary toolchain paths wait.

- [ ] With a detached runner alive and nothing else running, `xcrun devicectl device install app
      --device <UDID> <Some.app>` completes in its normal time.
- [ ] Same state, `xcrun devicectl device uninstall app --device <UDID> <bundleId>` completes.
- [ ] Same state, an unrelated `xcodebuild` for a second scheme/target on the same Mac completes;
      the runner does not hold a lock the build waits on.
- [ ] Same state, `node bin/agent-device.mjs device list --json` still lists the device, and an
      `open` on a *different* app on the same device is either a normal cold start or a typed
      `DEVICE_IN_USE` with the documented recovery - not a timeout.

## 7. Gates that must keep the runner on the kill path

- [ ] Mid-startup shutdown: with a cold runner cache (`rm -rf ~/Library/Developer/Xcode/DerivedData/AgentDeviceRunner*`),
      `open ...` and run `daemon stop` while xcodebuild is still building. Expect
      `"reason":"runner_never_served_a_command"` in `daemon.log`, no `detached-` token in `$LEASE`,
      and `$RUNNER_PID` gone.
- [ ] Occupied main thread: start a long-running request (a `replay` or a `--settle` interaction) and
      `daemon stop` while it is in flight. Expect `"reason":"main_thread_occupied"`, or
      `runner_never_served_a_command` if it had not answered yet - never a handoff of a busy runner.
- [ ] Command abandoned mid-flight: cancel a request after the runner accepted it (Ctrl-C during a
      long `replay`) and then `daemon stop`. Expect `"reason":"command_in_flight"` - a refusal based on
      work the runner still owes, which the completed-exchange occupancy mirror alone cannot see.
- [ ] Kill switch: start the daemon with `AGENT_DEVICE_IOS_RUNNER_DETACH=0` in its environment,
      repeat 1. Expect no `ios_runner_session_detached` line and the runner killed.
- [ ] Scoped simulator set is unaffected: repeat the same two checks on a simulator with
      `--simulator-set-path` and expect `"reason":"simulator_set_redirect"`.
- [ ] `xctest` backend (needs an iOS < 17 device, or one reported with `iosPhysicalDeviceBackend: "xctest"`):
      expect `"reason":"xctest_backend"` and the pre-#2681 kill-and-rebuild behaviour.
- [ ] Physical tvOS or visionOS device, if available: expect `"reason":"physical_non_ios_os"`.
- [ ] macOS host target: expect `"reason":"macos_host"`, even though it is `kind: device`.
- [ ] Repeated `daemon stop` with no runner at all stays clean, and a daemon killed with `SIGKILL`
      still leaves a stale lease the next daemon takes over (unchanged takeover path).
- [ ] Early-exit diagnosis still reads the log: kill the runner's app process so `xcodebuild` exits
      with a failure, and confirm the raised error quotes the tail of `$RUNNER_LOG` rather than an
      empty `stdout`.

## 8. Lanes

- [ ] `pnpm gate replay-ios-device` (needs the `IOS_UDID` the lane is configured with).
- [ ] `pnpm check:affected --run` - coordinator/CI owns this; it was not run in the implementing phase.

## Reporting

For each unchecked box, report the command, the diagnostic `phase`/`reason` seen, and the log path
(`daemon.log`, `$RUNNER_LOG`, or the request ndjson). Do not mark a box from unit-test coverage.
