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
      `"lane":"physical_coredevice"` and the recorded `runnerPid`.
- [ ] `ps -p $RUNNER_PID -o pid,etime,comm` -> the same `xcodebuild`/runner process is alive and its
      elapsed time spans the restart. If it died, this is the SIGPIPE risk the checklist exists for:
      capture `$STATE_DIR/sessions/p2681/runner.log` and stop.

## 2. Adoption by the next daemon

- [ ] `node bin/agent-device.mjs snapshot -i --json --session p2681 --platform ios --udid <UDID>` (or `open` again).
- [ ] In that request's `$STATE_DIR/sessions/p2681/requests/<requestId>.ndjson`:
  - [ ] `"phase":"ios_runner_lease_adopted"` with `"lane":"physical_coredevice"` and `runnerPid` equal to `$RUNNER_PID`.
  - [ ] No `xctestrun` build phase and no second `launch_xcodebuild` for this request.
  - [ ] Wall time is a reclaim, not a rebuild: compare against a cold physical start on this device
        (`AGENT_DEVICE_IOS_RUNNER_DETACH=0` on the daemon, then repeat 1-2 and time the first command).
- [ ] `ps -p $RUNNER_PID` unchanged across both daemons.
- [ ] Then `node bin/agent-device.mjs close --session p2681`, and one interaction round-trip
      (`press`/`snapshot -i`) on a fresh session to prove the adopted transport is usable for writes, not only reads.

## 3. Cold CoreDevice tunnel probe budget

The physical lane retries the uptime probe with `RUNNER_ADOPTION_COLD_TUNNEL_PROBE_TIMEOUT_MS`
(5000 ms) after the tight 500 ms probe fails, because a cabled tunnel wakes lazily.

- [ ] Repeat 1-2 after the Mac has been idle long enough to drop the tunnel (or after unplug/replug).
- [ ] Request ndjson shows `"phase":"ios_runner_lease_adoption_probe"` twice with `"timeoutMs":500`
      then `"timeoutMs":5000`, and adoption still succeeds.
- [ ] If the second probe also fails: `"phase":"ios_runner_lease_adoption_skipped"` with a typed
      reason, and the next command starts a fresh runner. That is the designed outcome, not a failure -
      record the timings and the reason.
- [ ] `.device-evidence/devicectl-info-details.json` is the tunnel/route capture this budget was
      sized against - `xcrun devicectl device info details --device <id> --json-output <file>` on a
      cabled iPhone 17 Pro (iOS 26.6.2, `tunnelState: connected`, `tunnelTransportProtocol: tcp`),
      trimmed to the connection, OS, and hardware fields and with the identifiers redacted. Refresh it
      if the reproduction differs.

## 4. Gates that must keep the runner on the kill path

- [ ] Mid-startup shutdown: with a cold runner cache (`rm -rf ~/Library/Developer/Xcode/DerivedData/AgentDeviceRunner*`),
      `open ...` and run `daemon stop` while xcodebuild is still building. Expect
      `"reason":"runner_never_served_a_command"` in `daemon.log`, no `detached-` token in `$LEASE`,
      and `$RUNNER_PID` gone.
- [ ] Occupied main thread: start a long-running request (a `replay` or a `--settle` interaction) and
      `daemon stop` while it is in flight. Expect `"reason":"main_thread_occupied"`, or
      `runner_never_served_a_command` if it had not answered yet - never a handoff of a busy runner.
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

## 5. Lanes

- [ ] `pnpm gate replay-ios-device` (needs the `IOS_UDID` the lane is configured with).
- [ ] `pnpm check:affected --run` - coordinator/CI owns this; it was not run in the implementing phase.

## Reporting

For each unchecked box, report the command, the diagnostic `phase`/`reason` seen, and the log path
(`daemon.log`, `runner.log`, or the request ndjson). Do not mark a box from unit-test coverage.
