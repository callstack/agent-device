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

Expected: `details.reason` is `signing_provisioning_profile_missing`. If a different reason appears,
say which one did and treat the fixture as unconfirmed rather than editing the rule to fit.

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

Expected: either `signing_provisioning_profile_missing` (xcodebuild complained about the profile
first) or `build_failed_unclassified`. Paste the error and the `xcodebuild -version` either way: a
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
the Xcode version. `packages/platform-apple/src/core/__tests__/fixtures/ios-device-info-details.json`
holds this payload with its device identifiers, hostnames and capture path masked, and
`packages/platform-apple/src/runner/__tests__/runner-startup-failure-fixtures.ts` records the two
state pairings as `tool-error-shape`. Paste the raw values so both can move to `captured`. Also
record the `tunnelState` and `tunnelIPAddress` from the same file, which is the transport data the
parser reads.

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

### 5. A device that cannot be read claims nothing

Unplug the iPhone (or shut it down) after a session exists, then rerun the `prepare ios-runner`
command.

Expected: the failure names whatever the transport could not reach, and no `details.reason` of
`device_developer_mode_disabled` or `device_developer_disk_image_unavailable` appears anywhere in the
error. An unreadable device is never diagnosed.

### 6. Log evidence belongs to the command that wrote it (optional, needs a crash repro)

Run any command that crashes the app under test, then a second command that fails for its own
reason (for example a selector that no longer exists).

Expected: the second error carries no `details.runnerFailureReason`. Before this change it inherited
`target_app_axruntime_coretext_crash` from the first command's lines in `runner.log`. If the repro
is not reachable, say so; the pairing is covered by
`packages/platform-apple/src/runner/__tests__/runner-failure-diagnostics.test.ts`.
