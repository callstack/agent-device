# Physical iOS runner handoff - device verification checklist (#2681)

Automated tests cover the gates and the lane predicate. What they cannot prove is that a real
`xcodebuild build-for-testing` process on a cabled iPhone survives the daemon that started it and
serves the next daemon. Every claim below needs a physical iOS 17+ device.

The implementing agent had no device access and proved nothing here. A coordinator with a cabled
iPhone has since run part of this checklist, at head `3a31b6a691` (the two-phase probe); those results
are recorded inline below with that SHA. Anything collected before a code change is re-owed at the
head being merged, so each backfilled section also carries an unchecked re-verification box.

Device used for the runs below: `thymikee-iphone`, iPhone 17 Pro, iOS 27.0 (build `24A437`),
CoreDevice UUID `50F8E1E1-7658-5550-BB4D-3D2C741AD85A`, hardware UDID
`00008150-001849640CF8401C`, Xcode 26.2 (Build `17C52`).

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
- [x] `grep '"phase":"ios_runner_session_detached"' "$STATE_DIR/daemon.log"` -> one line with
      `"lane":"physical_coredevice"`, the recorded `runnerPid`, and `runnerLogPath` equal to `$RUNNER_LOG`.
      A handoff whose diagnostics are missing is a finding even when the runner survives: diagnostics
      are how the next engineer sees why a handoff did or did not happen.
- [x] `ps -p $RUNNER_PID -o pid,etime,comm` -> the same `xcodebuild`/runner process is alive and its
      elapsed time spans the restart.

> **Result, `3a31b6a691`.** One `ios_runner_session_detached` line with `"lane":"physical_coredevice"`
> and the recorded `runnerPid` (50471); `ps` showed the same `xcodebuild` alive across the restart with
> elapsed time spanning it. `ownerToken` prefix and `runnerLogPath` equality were not separately
> asserted in that run, so both stay unchecked.
> **Re-verified at `378d4dbfa3` (all four).** `ownerToken` went `owner-61991-fe098769` ->
> `detached-owner-61991-fe098769`; one `ios_runner_session_detached` line carried
> `"lane":"physical_coredevice"`, `runnerPid` 62408 and a `runnerLogPath` equal to the lease's; `ps`
> showed the same `xcodebuild` alive with elapsed time spanning the restart.
> - [x] Re-run at the head being merged, asserting all four observations.

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
> **Negative result at `af55e2746b`, so this section is not satisfied by a cable cycle.** Across the
> unplug/replug above, `runner.log` went 78516 -> 78516 bytes: the runner survived, was adopted, and
> wrote nothing. Nothing here disproves the SIGPIPE regression this section guards, but it also does not
> prove output reaches a handed-off log.

- [ ] If the runner vanished instead: capture `$RUNNER_LOG` and `daemon.log`, and treat it as the
      SIGPIPE regression the file-backed stdio restructure was written to remove.

## 3. Adoption by the next daemon

- [ ] `node bin/agent-device.mjs snapshot -i --json --session p2681 --platform ios --udid <UDID>` (or `open` again).
- [ ] In that request's `$STATE_DIR/sessions/p2681/requests/<requestId>.ndjson`:
  - [x] `"phase":"ios_runner_lease_adopted"` with `"lane":"physical_coredevice"` and `runnerPid` equal to `$RUNNER_PID`.
  - [x] No `xctestrun` build phase and no second `launch_xcodebuild` for this request:
        `"phase":"ios_runner_session_startup_timings"` carries `data.timings` with
        `adopt_detached_runner` and without `build_xctestrun` or `launch_xcodebuild`.
  - [x] Wall time is a reclaim, not a rebuild: compare against a cold physical start on this device
        (`AGENT_DEVICE_IOS_RUNNER_DETACH=0` on the daemon, then repeat 1 and 3 and time the first command).
- [x] `ps -p $RUNNER_PID` unchanged across both daemons.
- [ ] Then `node bin/agent-device.mjs close --session p2681`, and at least five interaction
      round-trips (`press`/`snapshot -i`) on a fresh session to prove the adopted transport is usable
      for repeated writes, not only one read.

> **Result, `3a31b6a691`.** Adoption carried `adopt_detached_runner` only (`{"adopt_detached_runner":122}`)
> with no `build_xctestrun`/`launch_xcodebuild`, same PID across both daemons, and collapsed the
> first-command health check from 6509 ms cold to 3 ms adopted. Adoption was driven by re-`prepare`
> rather than by `snapshot`, and the five post-`close` round-trips were not run, so 58 and 67 stay open.
> **Behaviour re-verified at `378d4dbfa3`.** Re-`prepare` after a graceful stop returned in **1151 ms**
> (`healthCheckMs` 6) against a cold start of **38247 ms** (`healthCheckMs` 36856 - the tunnel had gone
> cold, so this is the worst case for the comparison), with PID 62408 alive across both daemons. A
> launch cannot fit in 1151 ms, so the reclaim is real.
>
> Two boxes deliberately stay open. The `ios_runner_lease_adopted` and `ios_runner_lease_adoption_probe`
> lines were **not** captured for this run: the request records I could attribute to the device instead
> carried `"reason":"lease_absent"`, and `prepare --json` returns no request id, so matching a record to
> a request is mtime guesswork - which is how a physical record was once read as simulator evidence
> (PR #2692). Adoption demonstrably happened while the diagnostics that should show it are this hard to
> pin to a request; that is worth fixing before the probe cap in section 4 is called measured.
> - [x] Capture `ios_runner_lease_adopted` + `ios_runner_lease_adoption_probe` for a physical adoption
>       at the head being merged. Done by emptying `requests/`, running exactly one adoption, and
>       requiring one file - `--debug` is mandatory for these records to exist at all.
> - [ ] The five post-`close` interaction round-trips (needs an app installed and opened, not just a
>       runner session).

## 4. Physical-lane probe budget

The physical lane probes the detached runner once, and that one probe is capped higher than every
other lane's: `RUNNER_ADOPTION_PHYSICAL_PROBE_TIMEOUT_MS` (5000 ms) instead of
`RUNNER_ADOPTION_PROBE_TIMEOUT_MS` (500 ms), because the first byte can be preceded by a `devicectl`
tunnel-address lookup. Both are clamped down to whatever the request's startup phase budget has left.
A cap is not a sleep: a runner that answers in 8 ms answers in 8 ms under either cap, so only a
refusal can spend the difference.

**The physical cap is currently UNMEASURED on hardware.** 5000 ms is a ceiling picked to stay well
under a cold physical rebuild, not a number any device produced. The capture below is what turns it
into a measurement; until a box here is checked, no claim about tunnel wake-up time is proven.

> One hardware probe timing exists, taken at `3a31b6a691` under the two-phase design it replaced: the
> tight probe answered in **8 ms** on `physical_coredevice`. That is proximity evidence only - the cap
> it ran under is not the cap being merged, so none of the boxes below are ticked by it.

- [ ] Repeat 1 and 3 after the Mac has been idle long enough to drop the tunnel (or after unplug/replug).
- [ ] Request ndjson shows one `"phase":"ios_runner_lease_adoption_probe"` with
      `"lane":"physical_coredevice"`, and record for it: `timeoutMs`, `budgetCapMs`, and `durationMs`.
- [x] Record the measured `durationMs` of that probe here, next to a cold `devicectl` tunnel wake on
      this device. An answer that arrives near the cap means the cap is too small; one that arrives
      far below it means the cap can come down. Either way the next change to the constant is a
      measurement and not a guess. The capture is the request ndjson itself; no separate
      `devicectl device info details` export is kept.
- [ ] If the probe fails: `"phase":"ios_runner_lease_adoption_skipped"` with a typed reason
      (`probe_failed`, or `probe_budget_exhausted` when the request's own budget was already spent
      before any probe was sent), and the next command starts a fresh runner. That is the designed
      outcome, not a failure - record the timings and the reason.

> **Measured at `af55e2746b`, warm tunnel.** One probe, `"lane":"physical_coredevice"`,
> `budgetCapMs` 5000, `timeoutMs` 5000, **`durationMs` 6**, `answered` true, followed by
> `ios_runner_lease_adopted` for PID 80569; the whole `prepare` took 951 ms. Per-request records only
> exist when the command runs with `--debug` - without it `requests/` is created and left empty, which
> is why an earlier pass at this head could not attribute a record to a request at all.
>
> **The cap is wrong in the direction this section worries about.** The probe answered in 6 ms, which
> is 1/800th of the budget. But a cold first command on this same device cost **36856 ms** of health
> check, and that is the cost class the 5000 ms ceiling was raised to absorb. A tunnel that needs
> re-establishing therefore cannot be waited out inside the cap: the probe would refuse at 5 s while the
> thing it is waiting for takes ~37 s. So the physical cap is neither a measured warm-case number (6 ms
> would allow far less) nor sufficient for the cold case it exists for. Either it comes down toward the
> warm measurement and the cold path is declared a rebuild by design, or it goes up an order of
> magnitude - and that is a decision this measurement should force, not one the constant should keep
> making silently.
> - [ ] Decide and record the cap against the cold-wake cost above.

## 5. A device that changed while the runner was orphaned

Between detach and adopt the runner is owned by nobody, and the transport it was started on may have
been rebuilt underneath it. Adoption must fail closed into a rebuild rather than hang or half-work.

- [ ] Unplug the cable after step 1, wait 10 s, replug, then run step 3. Expect the probe to refuse
      (`probe_failed`) and the next command to start a fresh runner. Total time to a working snapshot
      must be bounded by the probe cap plus one cold start - never an unbounded wait.
- [x] Reboot the iPhone after step 1 and bring it back unlocked, then run step 3. Same expectation.

> **Measured at `8c5fb73a03`.** Reboot after a graceful detach: the host-side runner (`89944`) had
> already exited, and the next `prepare` skipped adoption with the typed reason
> **`runner_process_dead`** naming that pid, then started a fresh runner (`98537`) and succeeded in
> 20000 ms with `healthCheckMs` 15887 - fail-closed into a rebuild, with the device's post-reboot cost
> a second data point for the cold case above. `runner.log` grew 92592 -> 95799 bytes, but that growth
> is a *new* runner writing to the session log, so it is not evidence for section 2's post-handoff
> claim and does not tick anything there. The probe path itself spent nothing: the refusal came from the
> dead-process check, which fires first, so this row proves that guard and not probe timeout.

> **Observed at `3a31b6a691`, and it did not match the expectation above.** A short unplug/replug
> (bus loss at 21:26:27, replug 21:26:40) was followed by an adoption that *succeeded*: the probe
> answered, `prepare` completed in about 3 s with `healthCheckMs` 4, and PID 18260 was handed to the new
> daemon. A runner that survives the cable cycle and answers again is a legitimate adoption, so this is
> recorded as an expectation correction rather than a defect - but it means the box above is not
> satisfied by a fast replug, and only the reboot and remount rows can prove fail-closed rebuild here.
> - [ ] Re-run the unplug row at the head being merged with the cable out long enough that the runner is
>       genuinely unreachable, and record the typed refusal reason.
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
- [ ] That refusal is sticky: after the same cancellation, `daemon stop` again without any further
      command and expect the same refusal. Then serve one command on a fresh daemon and cancel nothing;
      the next graceful shutdown must hand the runner off, because an answered exchange is what tells
      this process the runner is serving again.
- [x] Kill switch: put `AGENT_DEVICE_IOS_RUNNER_DETACH=0` on the environment of the **first command that
      spawns the daemon** - there is no `daemon start` subcommand (`daemon` accepts only `stop`), so
      prefixing a `daemon start` invocation does nothing and the daemon is later spawned by an
      unrelated command without the flag.
      repeat 1. Expect no `ios_runner_session_detached` line and the runner killed.
- [ ] Scoped simulator set is unaffected: repeat the same two checks on a simulator with
      `--simulator-set-path` and expect `"reason":"simulator_set_redirect"`.
- [ ] `xctest` backend (needs an iOS < 17 device, or one reported with `iosPhysicalDeviceBackend: "xctest"`):
      expect `"reason":"xctest_backend"` and the pre-#2681 kill-and-rebuild behaviour.
- [ ] Physical tvOS or visionOS device, if available: expect `"reason":"physical_non_ios_os"`.
- [ ] macOS host target: expect `"reason":"macos_host"`, even though it is `kind: device`.
> **Partial, `fc57f0d39e`, simulator lane.** Kill switch verified: control run with no flag left the
> runner (`36315`) alive across `daemon stop`; with `AGENT_DEVICE_IOS_RUNNER_DETACH=0` the runner
> (`37274`) was killed. Repeated `daemon stop` with no runner at all returned clean three times. The
> `SIGKILL` stale-lease takeover clause below was not exercised, so this row is not closed.

- [ ] Repeated `daemon stop` with no runner at all stays clean, and a daemon killed with `SIGKILL`
      still leaves a stale lease the next daemon takes over (unchanged takeover path).
- [ ] Early-exit diagnosis still reads the log: kill the runner's app process so `xcodebuild` exits
      with a failure, and confirm the raised error quotes the tail of `$RUNNER_LOG` rather than an
      empty `stdout`.
- [ ] That quote is bounded to one generation: keep a `$RUNNER_LOG` left by an older failed launch,
      reproduce a different early exit on top of it, and confirm the error quotes only what this
      generation appended. An older boot failure surfacing as this launch's recovery hint means the
      generation offset was lost somewhere between spawn and the error.

## 8. Lanes

- [ ] `pnpm gate replay-ios-device` (needs the `IOS_UDID` the lane is configured with).
- [ ] `pnpm check:affected --run` - coordinator/CI owns this; it was not run in the implementing phase.

## 9. Simulator-lane timings against `main`

Sections 1-8 are physical. This section is the one AC that #2681 states as a *comparison* rather than a
behaviour: detaching and adopting on the simulator lane must not be slower than `main`, against a
threshold said out loud in advance. It was measured by the coordinator on
simulator `apex-2682-proto` (`C2748D97-B92D-4B3B-9C65-AF86494AD904`, iOS 26.2) with
**no** `--simulator-set-path`, which is what makes it eligible for handoff at all: a scoped-set
simulator is refused before any probe is sent (line 175), so a measurement taken there would prove
nothing about the adopting path.

Threshold, fixed before reading the numbers: the adopted first-command wall
(`connectAfterBuildMs` + `healthCheckMs`) must land within +50 ms **and** under 1.5x of `main`'s
median, and the cold-path total within +25% of `main`'s median. A cap-shaped comparison would be
meaningless here because adoption is a reclaim, not a wait.

Three adopted cycles per side (graceful `daemon stop`, then `prepare`), runner artifact cached on both
sides so `buildMs` is 0 throughout:

| Path | `f9a021c290` (adopt) | `be0902eaea` / `main` (adopt) |
| --- | --- | --- |
| `connectAfterBuildMs` | 26, 27, 26 -> median **26** | 37, 26 -> median **31.5** |
| `healthCheckMs` | 3, 4, 3 -> median **3** | 3, 4 -> median **3.5** |
| adopted wall | **29 ms** | **35 ms** |

| Path | `f9a021c290` (cold) | `main` (cold) |
| --- | --- | --- |
| total, ms | 5005, 3563 -> median **4284** | 4222, 3444 -> median **3833** |

- [x] Adopted wall is 29 ms against `main`'s 35 ms: 6 ms faster, inside both bounds. The simulator
      adoption path is unchanged in behaviour by #2692, which is the expected result - the branch's
      subject is the physical lane, and this row exists to prove it did not disturb the lane that
      already worked.
- [x] Cold total is 4284 ms against 3833 ms: +11.8%, inside the +25% bound.
- [x] Same PID across the restart on the simulator lane, confirmed by `pgrep` before and after
      (`96688` on both sides of `daemon stop`), with `healthCheckMs` 4 adopted against 3941 cold.

Two recording notes, so the table is read correctly:

- [x] One cold sample at this head first looked like a regression: `connectAfterBuildMs` **10729** plus
      `healthCheckMs` 5033 on the very first cold cycle after `daemon stop --clean`. It did not
      reproduce in the two cold cycles measured above (1064/3941, 1030/2533), so it is recorded as
      first-cycle variance after a clean, not a branch effect. Both medians above exclude it and the
      table shows what repeated.
- [x] `main`'s first cycle returned 1110/3082 - a cold start, not an adoption, because the preceding
      `daemon stop --clean` had killed its runner. It is kept out of the adopted median for that reason.

This section proves nothing about the physical lane: the physical probe cap in section 4, the fail-closed
rows in section 5, and both rows in section 8 remain open until a cabled device is available.

## Reporting

For each unchecked box, report the command, the diagnostic `phase`/`reason` seen, and the log path
(`daemon.log`, `$RUNNER_LOG`, or the request ndjson). Do not mark a box from unit-test coverage.
