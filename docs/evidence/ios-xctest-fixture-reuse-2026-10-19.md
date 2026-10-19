# iOS XCTest fixture reuse

This report records the initial fixture reuse batch at its named historical SHAs.
The [full-suite profile and nightly policy](ios-xctest-cost-profile-2026-10-19.md) record the later work.

## Scope

The base is `b5f47e7542e274fc84a193c4e111e6c73ac3b1f3`.
The test-source commit is `cefec4dd1ffe62537991f124ac8d26e94fa5505a`.
The change groups ten native methods into three methods.
It changes no production runner code, deadline, retry, or workflow selection policy.

| Retained method | Preserved contracts |
| --- | --- |
| `testAlertActivationConfirmsBeforeDeadlineWithoutHandlingTheNotificationBanner` | A real notification banner exists. Activation consults no interruption monitor. The response succeeds before its deadline. The original action occurs once. The replacement action never occurs. |
| `testSkipAppActivationPreflightRequiresCachedForegroundCoordinateOnlyTap` | Missing cached targets refuse tap and scroll. A foreground cached coordinate tap bypasses activation. Selector tap, drag, scroll and mixed or coordinate gesture sequences retain activation. A changed bundle refuses the bypass. A terminated cached target refuses the bypass. |
| `testRunnerWindowResolutionReadsOnlyThroughTheFirstUsableWindow` | Two real windows exist before the frame probe is installed. The first usable window costs one frame read. An empty first window costs two reads. All empty windows produce no selected window and a zero app-frame fallback after three reads. The probe resets between rows. |

The activation predicate runs its destructive termination input last.
Its former “background” method used `terminate()`.
The retained method names that state accurately.
The retained banner test also observes the interruption opt-out during native dispatch.
It uses the existing synthesis stub for a nonperforming probe.
It restores the original implementation before the real activation.
The process-wide frame implementation is restored with `defer`.
Each method terminates its fixture and clears the state that it owns.

## Selection

Source-derived PR selection changes from 125 to 118 methods.
All 115 unaffected identifiers remain.
The ten superseded identifiers are absent.
All three retained identifiers are present.
No declaration becomes unreachable.
The production `RunnerTests/testCommand` entrypoint remains excluded.
The macOS host selection remains 338 methods.

## Local measurement

The runs use Xcode 26.2, iOS 26.2 and a dedicated iPhone 17 Pro simulator.
The simulator UDID is `DB573A6D-FA35-4516-B5BB-478D8EFC8C5F`.
Dependencies use pnpm 11.17.0 with the frozen lockfile.
Each checkout is installed and built separately.
Native builds include `AGENT_DEVICE_XCUITEST_INCLUDE_UNIT_TESTS=1`.
All test invocations use `test-without-building` and disable parallel testing.
The base and candidate run in sequence on the same simulator.
No broad gate runs during the native experiments.

| Sample | Executed / passed / failed / skipped | Sum of method durations |
| --- | --- | ---: |
| First base run | 10 / 10 / 0 / 0 | 58.044 s |
| Warm base run | 10 / 10 / 0 / 0 | 38.213 s |
| Warm candidate run with the strengthened interruption oracle | 3 / 3 / 0 / 0 | 18.523 s |

The warm comparison reduces method time by 19.690 s, or 51.5%.

| Contract group | Warm base | Warm candidate |
| --- | ---: | ---: |
| Banner activation | 13.813 s | 11.450 s |
| Window resolution | 12.425 s | 4.089 s |
| Activation preflight | 11.975 s | 2.984 s |

Observed fixture launches change from nine to three.
The first base run includes fresh simulator and notification setup.
Use the warm comparison for the headline result.
These are local focused measurements.
They do not predict the complete hosted Apple job duration.
Build, simulator boot and Xcode invocation overhead are outside the method sum.

The command shape is:

```sh
DEVELOPER_DIR=/Applications/Xcode-26.2.0.app/Contents/Developer \
xcodebuild test-without-building \
  -xctestrun "$XCTESTRUN_PATH" \
  -destination "platform=iOS Simulator,id=$TEST_SIMULATOR_UDID" \
  -parallel-testing-enabled NO \
  -resultBundlePath "$RESULT_BUNDLE" \
  -only-testing:AgentDeviceRunnerUITests/RunnerTests/testAlertActivationConfirmsBeforeDeadlineWithoutHandlingTheNotificationBanner \
  -only-testing:AgentDeviceRunnerUITests/RunnerTests/testSkipAppActivationPreflightRequiresCachedForegroundCoordinateOnlyTap \
  -only-testing:AgentDeviceRunnerUITests/RunnerTests/testRunnerWindowResolutionReadsOnlyThroughTheFirstUsableWindow
```

The base uses the ten original identifiers from the diff.
Each log is checked for the exact expected identifier set.
Count equality alone does not establish discovery.

## Interruption oracle

At the first test-source commit, `cb5360a045c1f8b4061bc01750e5bc6c22d264ed`,
a mutation that enabled interruption handling passed.
The empty callback list did not establish that the opt-out flag was set.
That survivor was not accepted as detection evidence.
The current test observes the flag inside the existing native synthesis stub.
It still requires the real banner, monitor, successful activation, deadline and action counts.
The current timing includes that additional probe.

An initial deliberately failing run started a simulator diagnostic collection with a 600-second timeout.
That collection was interrupted after the assertion failures were recorded.
That interrupted run is excluded from mutation completion counts.
Subsequent mutation invocations add `-collect-test-diagnostics never`.
They retain test logs, result bundles, exact identifier checks and failure exit status.
CI diagnostics remain unchanged.

## Mutation proof

The disposable checkout starts at the test-source commit named above.
The superseded methods are absent from that checkout.
The unmodified retained suite passes all three selected methods.
Each production mutation is then built and tested separately.
Each mutant runs only its relevant retained method.
All nine builds succeed.
Each test run reports zero passed, one failed and zero skipped methods, with exit 65.
The source edit is restored before the next mutation.

| Production mutation | Intended retained assertion |
| --- | --- |
| Return no activation outcome for alert accept | Native dispatch observation is absent. The real response fails. The original action count remains zero. |
| Set `doesNotHandleUIInterruptions` to false | The native dispatch probe observes false instead of true. |
| Read past all windows and return only the app-frame fallback | First usable-window selection and one-read witness fail. |
| Accept an empty window frame | Empty-first and all-empty controls fail their read count, frame or window-presence assertions. |
| Reject every command after the cached-target guard | The foreground cached coordinate-tap positive fails. |
| Accept every command after the cached-target guard | Drag, scroll and gesture-sequence negatives fail. |
| Remove the cached-target guard | Missing, changed-bundle and terminated-target negatives fail. |
| Accept every requested bundle after the foreground check | The changed-bundle negative fails. |
| Remove the foreground-state check | The terminated cached-target negative fails. |

The implementation checkout contains none of these production edits.
The disposable checkout is clean after the experiments.
The raw logs, mutation patches and result bundles are retained locally.
This report records completed runs, not predicted detection.

## Publication obligations

The local measurements do not establish a hosted speedup.
Apple smoke, Integration Tests and Coverage remain CI obligations at the PR head.
The source-derived selection check and packaged-runner check remain required local gates.
