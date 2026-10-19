# iOS text entry and daemon latency — 2026-10-19

Three changes reduce measured overhead while retaining the first-character split: overlap the two fresh system-surface scans, defer an irrelevant keyboard query, and stop polling a password value that accessibility has already classified as unreadable. Removing the split itself is unsafe: a native regression sent `23456` into the next screen's input and reported success.

This follows the [PR #1236 investigation](ios-e2e-engine-pr1236-2026-10-19.md). It uses the same `dev.e2e.benchmark` app from [tester-army/e2e#1236](https://github.com/tester-army/e2e/pull/1236), including the previously documented native-host adaptation. No benchmark screen or credential validator changed.

## Measured results

Times are conventional medians, including the mean of the two central values for even sample counts. Device runs were sequential, without competing builds. Every successful ordinary fill/append had an independent accessibility read-back outside its timer. Every accepted password sample reached the app's successful-login state outside its timer.

| Measurement | Before | Implemented | Evidence |
| --- | ---: | ---: | --- |
| Warm full home snapshot | 91.5 ms | 75.8 ms | 30 timed captures each; same 34 nodes; no fallback |
| Fresh system-host presence probe | 44.8 ms | 24.6 ms | 30 timed probes each; every result `absent` |
| Replace a nonempty password, 12 characters | 3,316.8 ms | 3,043.5 ms | Four each; all eight logins succeeded |
| Password first-character observation phase | 454.5 ms | 71.2 ms | Same four measured replacements per version |
| Fill an empty ordinary field, 19 characters | 2,039.1 ms | 2,028.5 ms | Eight before, four after |
| Replace an ordinary field, 19 characters | 3,235.8 ms | 3,212.2 ms | Eight before, four after |
| Append ten characters | 1,205.4 ms | 1,189.7 ms | Eight before, four after |

The ordinary-text differences are small relative to run variation. They do not establish an isolated latency benefit for the deferred keyboard query. The password's native observation phase supplies stronger attribution: it removes about 383 ms of polling; the complete command improves by about 273 ms. Secure fields still return unverified text evidence.

The two capture/probe warmups are excluded from their 30-sample groups. The capture harness primes the runner, relaunches the app, and measures fresh captures in the new process generation. The complete tree size is checked on every sample. Both capture groups use the same external runner artifact.

## What changed

`packages/platform-apple/src/system-surface-presence.ts` starts both `pgrep` scans together and waits for their results. It retains host priority, device-scoped environment reads, conservative `unknown` handling, and the positive-only memo. Every absent capture still scans afresh. No process-generation check was removed.

`RunnerTests+SynthesizedTextEntry.swift` makes `softwareKeyboardVisible` an autoclosure. The owning predicate evaluates it only for a bare Return key after a witnessed tap. Ordinary fills and appends no longer perform a native keyboard query whose result cannot affect their route. The visible/hidden keyboard decisions remain covered by the existing policy and live tests.

`RunnerTests+TextEntry.swift` gives the existing typed `TextValueRead` a warmup decision. A readable mismatch and `.unavailable` remain pending. An exact match is ready. `.unreadable` cannot confirm a literal character, so it no longer waits for that impossible observation. `RunnerTests+TextTyping.swift` takes the existing short poll pause for this case, then continues through the same target resolution and final verification. The split, 12-character synthesis pace, delivery budget, binding, and repair policy remain intact.

## Why the split stays

An isolated candidate changed only the main typing plan to `peelsWarmupCharacter: false`.

| Ordinary form operation | Original | One burst | Samples per version |
| --- | ---: | ---: | ---: |
| Empty fill | 2,039.1 ms | 1,701.6 ms | 8 |
| Replacement fill | 3,235.8 ms | 2,941.1 ms | 8 |
| Append | 1,205.4 ms | 1,024.7 ms | 8 |

All form samples read back correctly. The stronger native test boundary rejected the candidate: four scenarios passed and two failed. Removing or replacing the input after its first character returned success instead of `TEXT_INPUT_NOT_FOCUSED`. In the replacement scenario, the successor input held `23456` instead of remaining empty.

The split therefore contributes delivery evidence as well as readiness. Between the first post and the rest, the runner can refuse a different input. A single XCTest typing call can continue delivering events after navigation. Final verification cannot distinguish that from an input that correctly auto-submitted after receiving its last character. The final implementation passes both navigation regressions and retains successful auto-submit behavior.

The two navigation failures were reproduced again from the final native source plus the one-line candidate patch. The separate test-detection experiment changed `.unreadable` back to pending: its control passed and its mutant failed. The control's native source fingerprint matched the production build. All experiments ran in a disposable checkout.

## Raw daemon cost

Fifty alternating requests to the same local daemon measured:

| Path | Median |
| --- | ---: |
| Authenticated loopback TCP `session_list` request and response | 0.346 ms |
| Public SDK `sessions.list()` | 6.865 ms |

The raw path includes transport, token authorization, command routing, and response serialization for this cheap read-only command. It is a lower bound; it does not measure device admission or native work for other commands.

The SDK path performs registration/owner inspection, current code compatibility checks, and reachability work before sending. Instrumentation recorded one `/bin/ps` invocation per SDK call, including its untimed first call. The raw path bypasses that client lifecycle work. These measurements do not justify removing ownership checks or changing cancellation and ambiguous-delivery behavior to save a fraction of a millisecond in the transport.

The larger common cost remains fresh host process facts around captures. Parallel scans save about 16 ms in the complete warmed capture here. The target resolver and bridge manager still make their process-birth checks. Consolidating those facts in their owning native/protocol boundary remains a larger candidate; absence caching and dropping PID-generation checks are not part of this patch.

## Kept failures and comparison limits

One final-code text run hit `foreground-owner-unverified` after a cold startup AX timeout. The source circuit disabled that process generation and used XCTest. All 24 text checks passed, but command medians rose to 2,293/3,477/1,412 ms for empty fill/replacement/append. Those samples remain a separate fallback cohort. A warmed new generation used the bridge and supplied the four-sample final text comparison above.

An unchanged-baseline capture run also hit a cold-start foreground-owner failure and used XCTest: 156.7 ms median and a 37-node tree. It is retained separately from the two 34-node bridge-backed capture groups. Neither cold cohort is averaged into the warm speed claim. These observations establish the startup fallback on both versions; they do not establish its root cause or frequency.

The first text baseline was interrupted by this investigation's cleanup and contains canceled samples. Two password-harness attempts did not handle the system `Save Password?` sheet and failed to reach their assertion. Those attempts are excluded, with their failures preserved. The corrected harness dismisses `Not Now` and validates the app result. It never saves the test credentials.

This follow-up does not rerun the full upstream 42-case suite or test a physical device. It does not establish a general speed lead over the Swift engine. The earlier cross-engine report remains the comparison for the full suite and screenshots. Field clearing still costs about 1.1–1.2 seconds in these samples; it is the larger remaining text-entry cost.

## Follow-up: can replacement reach two seconds?

The next experiment replaced the caret edge-tap and delete burst with public, element-scoped XCTest calls: `typeKey("a", modifierFlags: .command)` followed by one delete. The warmup split, binding, and final read-back stayed unchanged. The candidate ran only in a disposable checkout. No further runtime optimization was accepted.

This follow-up used T3's installed `0.21.25` CLI, with explicit runner artifact paths, on the same upstream app and simulator. It therefore has a separate baseline from the SDK measurements above. Four baseline password replacements had a median of 3,219.0 ms, and all four reached successful login. Their median native clearing phase was 1,097.7 ms. A confirmed fresh candidate runner returned one replacement in 2,553.4 ms, with a 709.9 ms clearing phase. The next snapshot was routed to `com.apple.SafariViewService` and failed with an `invalid-viewport` timeout, so login was not verified. The evidence does not establish why that surface was selected. That timer is provisional and does not establish a successful-fill speed improvement.

The native safety comparison rejected the shortcut independently of that capture failure. A masked, prefilled fixture ignored Select All and exposed a separate app-owned exact-match indicator. The candidate returned success while that indicator showed that stale text remained. The candidate passed the existing two early-navigation regressions but failed the new whole-value replacement case: **2 passed, 1 failed**. The same fixture, test selection, and environment with the current clearing implementation passed **3 of 3**. This control's runtime source matched commit `6a47e6177bf91be8ce1896b5dc789d1fe1ba9e4b` byte-for-byte.

The [samples, phase timings, complete candidate/probe patch, and reproduction command](ios-fill-clear-latency-2026-10-19.json) preserve this result. An initial harness attempt omitted noninteractive success text; another candidate attempt reused the retained baseline runner. Both are excluded. The valid candidate was confirmed by its fresh xcodebuild artifact path and logged Command-A dispatches. The simulator was restarted between artifacts and shut down after the experiments.

There is no demonstrated safe two-second replacement here. Select All does not prove that a masked input was cleared, and final literal verification cannot supply that proof. The next design work is an identity-bound clear operation with observable completion, plus consolidating duplicate native reads within each observation. Keep the existing opaque-field clearing path until that evidence exists. Removing the first-character guard or globally increasing typing speed does not address these failures.

## Validation and reproduction

Base: `8f3eb3d2efde3654a560fddb39127d556e068352`, with the preserved implementation patch. Device: iPhone 17 Pro, iOS 27.0, `BC54AC11-CD86-4C10-8C4E-5101C773FFEB`. Host: M4 Pro, Xcode 27.1, Node 26.11.1. The live runs used the worktree patch; the PR records the published validation commit.

- The capture/routing suites passed: 43 tests.
- The final simulator runner selection passed: 17 tests, zero failures or skips. It includes hidden-keyboard Return/type, early input disappearance/replacement, last-character auto-submit, app-owned write-back, masked delivery, formatting, moving inputs, and the new policies.
- iOS and macOS native builds passed.
- `pnpm check:quick` passed lint and TypeScript checks.
- Full-repository formatting, the package build, layering, XCTest selection, and packaged Swift checks are recorded in the evidence bundle.
- Presence regression proof: 13 passed/1 failed on the sequential source; 14 passed with overlapping scans.
- Deferred keyboard regression proof: the enhanced policy test failed on the eager source with seven unexpected reads; it passed in the final selection.
- Unreadable-value policy proof: one control test passed; changing unreadable to pending made it fail.
- The final-source burst candidate failed both early-navigation tests; the final implementation passed them.

The [committed samples and native verification command](ios-text-daemon-latency-2026-10-19.json) support the measurements above. The complete local reproducibility bundle is `.tmp/text-daemon-speed-evidence.zip`. Its source directory is `.tmp/text-daemon-speed/`. It contains raw samples, phase logs, exact test commands, candidate patches, selected startup diagnostics, test summaries, and build/check logs. It excludes daemon registration files and credentials. Configure `SPEED_XCTESTRUN_FILE` and `SPEED_RUNNER_PATH` to select an explicitly built artifact. Configure `SPEED_CLIENT_ENTRY` for the capture comparison. Run each benchmark sequentially with its own state directory. The report's upstream app setup is in the preceding investigation.

Task-owned sessions and daemons are closed after verification. The disposable checkout is removed. The test simulator is shut down.
