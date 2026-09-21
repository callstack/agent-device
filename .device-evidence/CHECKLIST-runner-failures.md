# Runner-failure evidence checklist (#2680, #2683)

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

## Results — coordinator run, 2026-09-20

Built from `15808ae228` on `thymikee-iphone` (iPhone 17 Pro, iOS 27.0, build 24A437), cabled.

```
$ xcodebuild -version
Xcode 26.2
Build version 17C52
```

Section 3 is captured. A device build pointed at a team with no certificate, on a fresh derived
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

Sections 1 and 2 are blocked on this account, and the mechanism is worth recording because it is the
same for all of them: against a signed-in account with a valid identity, `xcodebuild` is invoked with
`-allowProvisioningUpdates`, so the build either signs successfully or dies earlier than the
diagnostic a row keys on.

- Unsetting `AGENT_DEVICE_IOS_TEAM_ID` **succeeds** — automatic signing resolves the team from the
  installed identity and reuses an installed team profile. So section 1's `signing_no_development_team`
  cannot be induced here; it needs an account signed in with no development team.
- `AGENT_DEVICE_IOS_BUNDLE_ID=com.apple.TestFlight` **succeeds** for the same reason, and a bogus
  `AGENT_DEVICE_IOS_PROVISIONING_PROFILE` is repaired rather than honoured. So section 2's
  `bundle_identifier_already_registered` needs an app id owned by a different team that automatic
  signing cannot register.
- The same gating applies to `bundle_identifier_unavailable` (`App Identifier` + `not available`),
  `profile-does-not-cover-app-id` (`Provisioning profile` + `doesn't include`) and `profile-expired`
  (`Provisioning profile` + `has expired`): each needs a profile or app id already claimed elsewhere,
  which this account will not produce. Recorded beside the fixtures in
  `runner-startup-failure-fixtures.ts` so the rows read as host-gated, not unexamined.

Section 4 needs a build that fails for an unrelated reason while naming no signing fact; the
classifier's behaviour there is pinned by `runner-startup-failure-reasons.test.ts` and needs no
device claim to hold.
