# Device evidence checklist

Live evidence the coordinator runs serially on the connected iPhone. Each item names the exact
command, the environment it needs, and the rendered error that proves the change. Do not paraphrase
the JSON: paste it. Record the commit SHA the build under test was made from.

## #2680 — typed build-failure reasons

Build the CLI first, then stop any warm daemon so the run is on this commit:

```sh
pnpm build && pnpm clean:daemon
node --experimental-strip-types src/bin.ts daemon stop --all || true
```

### 1. Signing with no team configured -> `signing_no_development_team`

```sh
env -u AGENT_DEVICE_IOS_TEAM_ID -u AGENT_DEVICE_IOS_PROVISIONING_PROFILE \
  node --experimental-strip-types src/bin.ts --json \
  prepare ios-runner --platform ios --device "<physical iPhone name>"
```

Expected: exit non-zero, one error object with

```json
{
  "code": "COMMAND_FAILED",
  "message": "xcodebuild build-for-testing failed",
  "hint": "Configure signing in Xcode or set AGENT_DEVICE_IOS_TEAM_ID for physical-device runs.",
  "details": { "reason": "signing_no_development_team" }
}
```

`hint`, `logPath` and `diagnosticId` are top-level, never inside `details`. Also record the Xcode
version (`xcodebuild -version`) so the `signing_no_development_team` fixture in
`packages/platform-apple/src/runner/__tests__/runner-startup-failure-fixtures.ts` can move from
`shipped-sniff-trigger` to `captured` and its `xcodeVersion` from `unobserved` to that version.
Paste the whole error so the fixture's `output` can become the capture and its `command` can be
recorded.

### 2. A bundle identifier somebody else already owns -> `bundle_identifier_already_registered`

```sh
env AGENT_DEVICE_IOS_TEAM_ID="<your team id>" \
  AGENT_DEVICE_IOS_BUNDLE_ID="com.apple.TestFlight" \
  node --experimental-strip-types src/bin.ts --json \
  prepare ios-runner --platform ios --device "<physical iPhone name>"
```

Expected: same envelope shape with
`details.reason: "bundle_identifier_already_registered"` and a hint naming
`AGENT_DEVICE_IOS_BUNDLE_ID`. A registered-but-foreign identifier may surface the `Failed registering
bundle identifier` line or the `App Identifier ... is not available` line; both rules produce this
one reason, so record which line xcodebuild printed.

### 3. Reasons with no device exposure (host-side or configuration-only)

These do not need the iPhone, but do need a real xcodebuild run; record output with the Xcode
version so the matching fixture's `provenance` can be upgraded:

```sh
# devtools_security_developer_mode_disabled (macOS admin state, no device work)
DevToolsSecurity -status

# signing_provisioning_profile_missing: point the runner build at a profile that is not installed,
# then read the reason off the same prepare command as above.
env AGENT_DEVICE_IOS_TEAM_ID="<your team id>" \
  AGENT_DEVICE_IOS_PROVISIONING_PROFILE="no-such-profile-installed" \
  node --experimental-strip-types src/bin.ts --json \
  prepare ios-runner --platform ios --device "<physical iPhone name>"
```

Expected: `details.reason` is `signing_provisioning_profile_missing`, and the profile rows only fire
when xcodebuild says what is wrong with the profile **on the same line as the profile**: its
`IDEProvisioningErrorDomain` diagnostic naming the profile, `doesn't include ...`, or `has expired`
(#2688 review). Paste the whole error and keep the line breaks — which line carried which phrase is
what promotes the `profile-xcode-signing-error`, `profile-does-not-cover-app-id` and `profile-expired`
fixtures from `invented-shape` to `captured`, and a capture that splits the two phrases across lines
belongs to `profile-note-above-an-expired-certificate` instead. A different reason is worth recording
just as much: say which one and treat the fixtures as unconfirmed rather than editing the rules to
fit.

### 4. The line that claims no reason yet -> `build_failed_unclassified`

`xcodebuild` reports a settings mismatch with a line that names a profile ("has conflicting
provisioning settings"). #2680 deliberately publishes `build_failed_unclassified` for it, because no
capture has proved which lever clears it. To reach it, pin a profile while leaving automatic signing
on:

```sh
env AGENT_DEVICE_IOS_TEAM_ID="<your team id>" \
  AGENT_DEVICE_IOS_PROVISIONING_PROFILE="match-development" \
  node --experimental-strip-types src/bin.ts --json \
  prepare ios-runner --platform ios --device "<physical iPhone name>"
```

Expected: either `signing_provisioning_profile_missing` (xcodebuild complained about the profile and
said what was wrong with it) or `build_failed_unclassified` — which is also what a run that merely
mentions the profile it used gets, since a name is not a complaint (#2688 review). Paste the error and the `xcodebuild -version` either way: a
capture of the conflicting-settings line is what would let a follow-up name the cause, and the
capture must show which build setting disagrees before any hint naming a lever is written.
## #2683 — device-readiness facts from `devicectl device info details`

Build the CLI first, and stop any warm daemon so the run is on this commit (same preamble as the
#2680 section above).

### 1. Both facts are readable, and they are two facts

```sh
xcrun devicectl device info details --device "<udid>" --json-output /tmp/device-details.json
node -e 'const d=require("/tmp/device-details.json").result.deviceProperties;console.log(JSON.stringify({developerModeStatus:d.developerModeStatus,ddiServicesAvailable:d.ddiServicesAvailable}))'
xcodebuild -version
```

Expected: `{"developerModeStatus":"enabled","ddiServicesAvailable":true}` on a healthy device, plus
the Xcode version. Also record `bootState` and `tunnelState` from the same file: those two are what
make a `ddiServicesAvailable: false` an answer at all rather than a device that was not listening.

`packages/platform-apple/src/core/__tests__/fixtures/ios-device-info-details.json` holds this payload
and `packages/platform-apple/src/runner/__tests__/runner-startup-failure-fixtures.ts` records the two
state pairings, both at `invented-shape` until this capture moves them to `captured`. Paste the raw
values rather than a summary.

The committed payload is masked, and the mask is a rule with a test, not a one-time edit:
`hardwareProperties.serialNumber` and `deviceProperties.bootedSnapshotName` carry `MASKED`,
`hardwareProperties.ecid` is `0`, and `connectionProperties.tunnelIPAddress` is a documentation-only
`fd00:` address. Everything the reader consumes — the toggle, the image, `bootState`, `tunnelState`,
OS build — stays verbatim. If you refresh this capture, apply the same mask in both the `result`
block and the mirrored `properties` block, and leave the states alone.

### 2. A healthy device is left alone

```sh
node --experimental-strip-types src/bin.ts --json   prepare ios-runner --platform ios --device "<physical iPhone name>"
```

Expected: success as before, and a `ios_runner_session_startup` diagnostic whose timings include
`verify_device_readiness`. No reason may appear on a healthy device: the probe reads, it does not
guess. Record the `verify_device_readiness` duration next to `verify_host_dev_tools_security`.

### 3. Developer Mode off on the device -> `device_developer_mode_disabled`

Turn the toggle off on a device you are willing to re-pair (Settings > Privacy & Security >
Developer Mode, then restart), and rerun the `prepare ios-runner` command above.

Expected: exit non-zero with

```json
{
  "code": "COMMAND_FAILED",
  "message": "The iOS device reports that Developer Mode is turned off",
  "details": {
    "reason": "device_developer_mode_disabled",
    "developerMode": "disabled",
    "developerDiskImage": "unavailable"
  }
}
```

`hint` is top-level and names `Settings > Privacy & Security > Developer Mode`. Record what
`developerDiskImage` says; either value is acceptable as long as the toggle stays the reason.

### 4. Developer disk image down with the toggle on -> `device_developer_disk_image_unavailable`

This is the pairing the old hint got wrong, so it is the evidence that matters. Reach it with a
device whose iOS build is newer than the installed Xcode supports, or before Xcode finishes
installing device support for a freshly paired phone, with Developer Mode on.

Expected: `details.reason` is `device_developer_disk_image_unavailable`, `details.developerMode` is
`enabled`, and the hint names device support WITHOUT mentioning `Settings > Privacy & Security`. If
the toggle reason appears here instead, that is the bug this issue exists to fix: paste the whole
error and the `/tmp/device-details.json` payload rather than adjusting a rule.

Capture the details payload at the same moment as the refusal, and check it says
`tunnelState: "connected"` and `bootState: "booted"`. A `ddiServicesAvailable: false` read any other
way is not this case: an asleep or unreachable device has the same field and no obstacle, and the run
must not name device support for it. The hint you get here is the one `core/devicectl.ts` owns and the
device report carries, so it is worded identically to the hint `devicectl` output produces for the
same complaint — paste both strings and confirm they match character for character.

### 5. A device that cannot be read claims nothing

Unplug the iPhone (or shut it down) after a session exists, then rerun the `prepare ios-runner`
command.

Expected: the failure names whatever the transport could not reach, and no `details.reason` of
`device_developer_mode_disabled` or `device_developer_disk_image_unavailable` appears anywhere in the
error. An unreadable device is never diagnosed. This is also the case that catches a sleeping phone
reporting `ddiServicesAvailable: false`: if the hint here says `Let Xcode finish preparing this
device`, the corroboration rule has been lost, and pasting the payload with its `tunnelState` and
`bootState` is the evidence — do not adjust the rule to make the run pass.

### 6. A device and a Mac that are both wrong publish the device's reason

With the iPhone's Developer Mode toggle off AND `sudo DevToolsSecurity -status` reporting the
developer-tools setting disabled, run the `prepare ios-runner` command.

Expected: one error, whose `details.reason` is `device_developer_mode_disabled`. The Mac's reason is
the other one (`devtools_security_developer_mode_disabled`) and must not be what you get: the phone's
fix needs no admin rights on the Mac, so the probe that can be acted on has to be the one that speaks.
Record which of the two appears; a captured pairing here is what would let a follow-up drop the
ordering argument.

### 7. Log evidence belongs to the command that wrote it (optional, needs a crash repro)

Run any command that crashes the app under test, then a second command that fails for its own
reason (for example a selector that no longer exists).

Expected: the second error carries no `details.runnerFailureReason`. Before this change it inherited
`target_app_axruntime_coretext_crash` from the first command's lines in `runner.log`. If the repro
is not reachable, say so; the pairing is covered by
`packages/platform-apple/src/runner/__tests__/runner-failure-diagnostics.test.ts`.

## Results — coordinator run, 2026-09-20 (both families)

Built from `15808ae228` on `thymikee-iphone` (iPhone 17 Pro, iOS 27.0, build 24A437), cabled.

```
$ xcodebuild -version
Xcode 26.2
Build version 17C52
```

#2680 §3 is captured. A device build pointed at a team with no certificate, on a fresh derived
path so no cached artifact short-circuits it, reaches signing and fails with one long `error:` line
per target:

```
.../AgentDeviceRunner.xcodeproj: error: No Accounts: Add a new account in Accounts settings. (in target 'AgentDeviceRunner' from project 'AgentDeviceRunner')
.../AgentDeviceRunner.xcodeproj: error: No profiles for 'com.callstack.agentdevice.runner' were found: Xcode couldn't find any iOS App Development provisioning profiles matching 'com.callstack.agentdevice.runner'. (in target 'AgentDeviceRunner' from project 'AgentDeviceRunner')
```

`details.reason` is `signing_provisioning_profile_missing` with the profile hint, and the fixture
`no-profiles-for-bundle-id` is now `captured` with this transcript verbatim. This is the run that
answers the wrapping question the rows were held on: the matched phrase arrives inside one `error:`
line, so the sibling rows in the same provisioning family do not split the way a wrapped line would.

The #2680 sections 1 and 2 are blocked on this account, and the mechanism is worth recording because it is the
same for all of them: against a signed-in account with a valid identity, `xcodebuild` is invoked with
`-allowProvisioningUpdates`, so the build either signs successfully or dies earlier than the
diagnostic a row keys on.

- Unsetting `AGENT_DEVICE_IOS_TEAM_ID` **succeeds** — automatic signing resolves the team from the
  installed identity and reuses an installed team profile. So section 1's `signing_no_development_team`
  cannot be induced here; it needs an account signed in with no development team.
- `AGENT_DEVICE_IOS_BUNDLE_ID=com.apple.TestFlight` **succeeds** for the same reason, and a bogus
  `AGENT_DEVICE_IOS_PROVISIONING_PROFILE` is repaired rather than honoured. So §2's
  `bundle_identifier_already_registered` needs an app id owned by a different team that automatic
  signing cannot register.
- The same gating applies to `bundle_identifier_unavailable` (`App Identifier` + `not available`),
  `profile-does-not-cover-app-id` (`Provisioning profile` + `doesn't include`) and `profile-expired`
  (`Provisioning profile` + `has expired`): each needs a profile or app id already claimed elsewhere,
  which this account will not produce. Recorded beside the fixtures in
  `runner-startup-failure-fixtures.ts` so the rows read as host-gated, not unexamined.

#2680 §4 needs a build that fails for an unrelated reason while naming no signing fact; the
classifier's behaviour there is pinned by `runner-startup-failure-reasons.test.ts` and needs no
device claim to hold.

### #2683 — what the phone actually reported

Developer Mode off, same device, `prepare ios-runner --platform ios --json`:

```
"deviceProperties": { "developerModeStatus": "disabled", "ddiServicesAvailable": true }

details.reason  device_developer_mode_disabled
details.deviceReadiness { developerMode: "disabled", developerDiskImage: "available" }
hint            Enable Developer Mode on the iOS device (Settings > Privacy & Security >
                Developer Mode), restart it when prompted, unlock it, then retry.
```

The recognised spelling is the device's own lowercase `"disabled"`, so the one refusal
`preflightIosRunnerDeviceReadiness` raises is proven rather than inferred, and an unrecognised
spelling is no longer a live risk for this state.

Image-down was reached by rebooting and holding the phone locked, watching `devicectl` until
`ddiServicesAvailable` read `false` while `bootState` was `booted`. Two findings from it:

- The state is only reachable **while locked**. `ddiServicesAvailable` flips back to `true` within
  seconds of unlock, so an unlocked image-down device does not exist on iOS 27 and the capture this
  checklist asked for cannot be produced on it.
- Inside that window `prepare` fails at the connect stage — `Runner did not accept connection
  (xcodebuild exited early)`, exit 70 — and publishes no `developerDiskImage`, because the only call
  site that attaches device states is the `launch_xcodebuild` catch. That path is what the connect
  failure now routes through, so the fact travels on the failure a locked phone actually produces.

The host-deadline invariant also held under a real device fault: on a 25s budget the same
image-down state produced `details.reason: prepare_deadline_expired` with **no** device reason and no
readiness facts, across every sample of two separate windows.
