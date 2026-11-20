# Native iOS accessibility audit evidence

## Review revision

The review revision replaces native snapshot annotations with one admitted `accessibilityAudit` operation after heuristic capture. Unknown Apple names map to `unknown:<name>`. Unique native frame matches include a pinned snapshot ref, role, and accessible name. Text geometry rounds to one decimal. Native `hitRegion` and heuristic `small-target` overlap is documented.

## Read-only type set and overlap

Same device and screen (iOS Settings), branch-built `node bin/agent-device.mjs`, at the commit that adds this section.

Per-type cost of `performAccessibilityAudit`, measured inside the runner over three runs, with a temporary timing build that is not committed:

| Types | Time | Issues |
| --- | --- | --- |
| `contrast`, `elementDetection`, `hitRegion`, `sufficientElementDescription`, `trait` together | 459–530 ms | 5 |
| `dynamicType` with `textClipped` | 1971–1992 ms | 0 |
| `.all` | 2245–2604 ms | 5 |

Screenshots taken during the `dynamicType` and `textClipped` pass showed the app re-laid out at a larger text size twice. The audit therefore requests only the five types in the first row.

Whole-command time over five warm runs: `audit --native` took 2.8–3.2 s before this change and 0.98–1.10 s after it. Plain `audit` took 0.27–0.37 s. The first `audit --native` after a runner build took 19.4 s; the first one in a new session with the runner already up took 1.3 s.

Output after the change: [read-only-native.txt](read-only-native.txt), 8 warnings and 1 observation, identical over the five runs. The native `hitRegion` finding on the "Dictate" frame is no longer printed, because `small-target` reports both buttons on that frame.

`testReadOnlyAuditTypesLeaveOutTheChecksThatResizeText`, `testNativeAuditTypeNamesPreserveAppleTypes`, and `testNativeAuditPayloadEncodesPointsAndMissingElement` passed on this device with the unit-test runner build: 3 executed, 0 failures.

A system alert over the app makes Apple's audit fail with `Invalid target app <pid>`; `audit --native` then exits 1. Plain `audit` is not affected.

The six focused XCTest tests below passed again with the review revision's unit-test runner. Provider scenarios exercise native audit before an explicit snapshot command, capture ordering, repeated native calls, unknown names, and native-only ref publication. The exact final commit and affected-gate receipt are recorded in the PR comment.

## Final-head capture

Source/build SHA: `6e391357c5bee1fd28dc386a098c79590ba7d21e`. Device: `audit-platform-ios` (`420E5A71-7424-4EB0-B5E7-F3CDC9DD26A2`), iPhone 17, iOS 26.2. All commands used this checkout's branch-built `node bin/agent-device.mjs` with its own daemon and isolated state.

- `open com.apple.Preferences --relaunch`, then `audit --native` as the first command with no snapshot before it. It returned heuristic and native findings together, exit 0: [final-head-native.txt](final-head-native.txt).
- Native contrast findings carry the matched snapshot ref, role and name, with rounded rects, for example `@e46~s755880 text "StandBy"  [29.7,756 106.7×29]`.
- The native `hitRegion` frame matches both "Dictate" buttons, so it prints no ref under the unique-match rule.
- `audit --native --json`: [final-head-native.json](final-head-native.json). Plain `audit` on the same screen: [final-head-heuristic.txt](final-head-heuristic.txt) (4 warnings, 1 observation, against 9 warnings, 1 observation with `--native`).

The historical files below are attributed to their original SHA.

## Historical capture

Source/build SHA: `1c77d4badd62b16a916864d83e33eb82865d5ffe`.

Device: `audit-platform-ios`, `420E5A71-7424-4EB0-B5E7-F3CDC9DD26A2`, host `local`, iPhone 17, iOS 26.2. T3 `device_open` displayed this reserved simulator. All app commands used this checkout's CLI and isolated state. No other device was used.

## Build and tests

```sh
pnpm install --frozen-lockfile
pnpm build
AGENT_DEVICE_XCUITEST_DESTINATION='platform=iOS Simulator,id=420E5A71-7424-4EB0-B5E7-F3CDC9DD26A2' AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH=$PWD/.tmp/native-audit/derived AGENT_DEVICE_XCUITEST_INCLUDE_UNIT_TESTS=1 pnpm build:xcuitest:ios
```

The iOS unit-test build passed. `xcodebuild test-without-building` on that xctestrun and device passed six focused tests: `testNativeAuditTypeNamesPreserveAppleTypes`, `testNativeAuditPayloadEncodesPointsAndMissingElement`, `testEveryCommandDeclaresEveryRunnerSideDecisionTogether`, `testEveryRunnerCommandTypeHasAProductionRequest`, `testRunnerSurfacePreparationMatchesTheSharedPolicyFixture`, and `testQueuedReadOnlyTraitsMatchTheDaemonParityFixture`. Result: 6 executed, 0 failures.

Then the production iOS runner was rebuilt with the same destination and derived path, without `AGENT_DEVICE_XCUITEST_INCLUDE_UNIT_TESTS`. The macOS production runner also built successfully with `AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH=$PWD/.tmp/native-audit/macos-derived pnpm build:xcuitest:macos`. No macOS app was driven.

Focused TS mapping, runtime, output, command projection, unsupported-target, MCP ref, runner classification, and provider-backed audit tests passed. `pnpm typecheck`, `pnpm lint`, and `pnpm check:xctest-selection` passed. The selection check found no unreachable XCTest methods.

## Live commands

```sh
export AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH=$PWD/.tmp/native-audit/derived
export AGENT_DEVICE_STATE_DIR=$PWD/.tmp/ad-state
pnpm clean:daemon
node bin/agent-device.mjs open settings --platform ios --udid 420E5A71-7424-4EB0-B5E7-F3CDC9DD26A2 --session platform-audit
node bin/agent-device.mjs audit --platform ios --udid 420E5A71-7424-4EB0-B5E7-F3CDC9DD26A2 --session platform-audit --json
node bin/agent-device.mjs audit --native --platform ios --udid 420E5A71-7424-4EB0-B5E7-F3CDC9DD26A2 --session platform-audit --json
node bin/agent-device.mjs audit --native --platform ios --udid 420E5A71-7424-4EB0-B5E7-F3CDC9DD26A2 --session platform-audit
node bin/agent-device.mjs close --shutdown --platform ios --udid 420E5A71-7424-4EB0-B5E7-F3CDC9DD26A2 --session platform-audit
```

All commands exited 0. Raw outputs: [heuristic.json](heuristic.json), [native.json](native.json), [native.txt](native.txt).

The plain audit returned three heuristic findings. Native mode returned the same three heuristic objects, verified with `assert.deepEqual`, plus five native findings: one `hitRegion`, three `contrast`, and one `trait`. The hit-region and trait issues include Apple's element frames in points. Apple supplied no element for the contrast issues; those findings omit `rect`. The native command succeeded without recording a test failure.

Cleanup returned `Closed: platform-audit`. A subsequent simulator inventory read confirmed `state: Shutdown`. The final PR head and affected-gate receipt are recorded in the PR validation section. Hosted CI and review remain separate from these local results. Physical-device behavior was not verified live.
