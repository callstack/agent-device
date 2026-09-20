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
