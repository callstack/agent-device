# XCTest cost profile and lane policy

This evidence follows the [initial fixture reuse experiment](ios-xctest-fixture-reuse-2026-10-19.md).
It records a full local run of the selected native regressions and the subsequent scheduling change.

## Attribution

The first complete baseline is `431a94cb96014cb4bdf91f51a5a1eb76440f6e96`.
It executes all 118 then-selected methods.
While this work was running, main merged `fa4890aac6` through #3820.
That commit fixes the same always-nil iOS focus polling found by this profile.
The rebased candidate preserves that upstream production implementation without a diff.
The full comparison therefore includes upstream readiness improvements as well as this PR's fixture changes.
It does not isolate this PR's incremental speedup.

## Setup

The device is a dedicated iPhone 17 Pro simulator running iOS 26.2.
Its UDID is `74DBE486-DB09-47B3-B3C5-0637D740930D`.
The toolchain is `/Applications/Xcode-26.2.0.app/Contents/Developer`.
The package manager is pnpm 11.17.0.
The candidate has its own frozen installation and package build in a disposable checkout.
The baseline reuses the clean native build previously verified at its exact SHA.
Both native builds include `AGENT_DEVICE_XCUITEST_INCLUDE_UNIT_TESTS=1`.
Both full invocations run `test-without-building` with parallel testing disabled.
They select the same 118 identifiers and run sequentially on the same simulator.
The candidate starts after notification authorization and simulator caches are warm.
No broad gate or other test process runs beside either full native invocation.

## Full selected-suite comparison

The candidate source is `19573d42b0` on base `a661e43d83735fc74a02118b5698e5d45e03ee21`.
Both logs contain the exact same 118 identifiers once, with zero unexpected failures or skips.
Each xcresult summary records 117 passed methods and one existing expected-failure method.

| Measurement | Baseline | Rebased candidate |
| --- | ---: | ---: |
| Command wall time | 718.284 s | 484.579 s |
| Sum of method durations | 680.147 s | 464.813 s |
| Fixture launches | 81 | 81 |
| Observed existence-poll gaps | 111 / 113.340 s | 1 / 1.010 s |

Wall time falls by 32.5%; method time falls by 31.7%.
These are local results, with the attribution and warm-state limits above.
They do not predict a hosted Apple job speedup.
[Every matched method](ios-xctest-cost-profile-2026-10-19.csv) retains its individual status and duration.

## Findings

The baseline completes 118 methods with no unexpected failures or skips.
Their durations sum to 680.147 seconds.
The command takes 718.284 seconds wall time.
There are 81 fixture launches.
XCTest activity timestamps expose 111 existence-poll gaps totalling 113.340 seconds.
Those gaps include all observed existence waits; they are not a count of modified call sites.
An already-focused selector tap still waits twice for two seconds and dispatches a second tap.
The polled app-wide focus lookup always returns nil on iOS.
Upstream #3820 fixes that route by corroborating the chosen input through safe snapshots.

This PR checks `exists` before calling the same bounded fixture existence wait.
It retains the original timeout and fallback wait when the fixture is not present.
It does not change app-launch behavior or disable animations, diagnostics, caches or failure deadlines.
The identical-replacement alert still waits for its full uncertainty deadline.
Those expensive native failure contracts remain valuable and run nightly.

## Isolated fixture timing and regression proof

The disposable source is `7bb347f771`.
With only the fixture fast check removed, the same three methods pass in 14.081 seconds of method time.
With the fast check present, they pass in 9.909 seconds.
The difference is 4.172 seconds in this single local comparison.
The hardware-keyboard method changes from 6.937 to 3.706 seconds.
Window resolution changes from 4.181 to 3.072 seconds.
The unchanged activation-predicate control changes from 2.963 to 3.131 seconds.
The patch changes only `exists || waitForExistence(...)` to `waitForExistence(...)`.
Both variants retain the same timeout and pass all three methods.

A six-method unmodified control passes focus, recovery, both disappearing-input tap routes,
moving-input replacement and upstream latency coverage.
The following five production mutants each build successfully and fail their selected method with exit 65.
Each mutant executes one method, with one failure and no skips.

| Mutant | Observed detection |
| --- | --- |
| Focus poll never confirms | The real tap observer counts two dispatches instead of one. |
| Readiness claims focus before delivery | A dropped first tap is never recovered; count is one and the field lacks focus. |
| Remove the recovery tap | The dropped first tap leaves the field unfocused and the count at one. |
| Accept another element's focus | The unrelated-element negative assertion fails. |
| Admit non-tap commands to the activation bypass | Retained drag, scroll and sequence negatives fail after the duplicate drag row is removed. |

The observer forwards to the original coordinate-tap implementation, except for the deliberately dropped first event.
It restores the method and removes its implementation block with deferred cleanup.
The focus implementation is inherited from #3820; these mutations establish the retained tests' value.
Every source patch is restored before the next experiment.
The final clean rebuild passes hardware focus, dropped-tap recovery and activation preflight, three of three.
Intentional failing invocations disable diagnostic collection only, to avoid XCTest's 600-second simulator diagnosis.
CI diagnostics and assertion failures remain enabled.

## Native reach verification

The 118-method comparison uses `19573d42b0`.
A complementary 331-method invocation uses `7bb347f771` after the duplicate drag row was removed.
Those runs cover all 449 nightly identifiers exactly once across their disjoint selections.
Their xcresult summaries total 448 passed, one expected failure, zero unexpected failures and zero skips.
The expected failure belongs to the existing optional-issue containment test.
The four PR methods are included in the 118-method run.
A separate final-code PR invocation passes all four methods in 4.436 seconds wall time.
Its xcresult summary passes the new source-derived count check: four executed of four expected.
This is coverage across two invocations, not a claim that the whole nightly workflow ran locally.
The changed preflight test also runs in the final-source controls and mutation below.

## Xcode 27 verification

Xcode 27.1 builds the final code at `7bb347f771` and passes all 15 selected methods with no skips.
The selection includes focus/tap-count recovery, disappearing and moving inputs, masked-input failures,
upstream latency, the three original fixture consolidations and the four PR platform checks.
It runs on the same iOS 26.2 simulator.

## Coverage policy

At the rebased source, discovery reaches 338 host methods, four PR simulator methods and 449 nightly methods.
No method is dark, and no lane reaches the command server entry point.

PRs retain the macOS host decision suite, generated shared platform checks on the simulator, and public CLI E2E smoke.
Nightly and manual dispatch retain the full native iOS bundle, excluding only the command server entry point.
The optional-probe completion marker moves with its test to nightly.
The PR result summary now checks the source-derived execution count.
The selector still rejects dark tests, unknown skips and a reachable server entry point.
Native injected failures can consequently be discovered after merge rather than on every PR.

Existing E2E does not establish equivalence for hidden-keyboard one-shot witnesses, penalized replacement,
dropped Select All, identical replacement alerts, blocked queries or optional XCTest issue containment.
Ordinary successful fill/alert scenarios are insufficient deletion proof.
These cases are retained, rather than removed as duplicates.

## Raw evidence

The local bundle is `/private/tmp/pr3824-full-profile`.
It contains commands, logs, result bundles, per-method profiles, mutation patches and build logs.
The comparison CSV preserves every matched method and its before/after status and duration.
To reproduce the full comparison selection, read its first column into `-only-testing:` flags.
Run `xcodebuild test-without-building -xctestrun "$XCTESTRUN_PATH"` with those flags,
`-destination "platform=iOS Simulator,id=$TEST_SIMULATOR_UDID"`, `-parallel-testing-enabled NO`
and a fresh `-resultBundlePath`.
The current `--ios-pr-tests` selector intentionally produces the smaller PR lane instead.

Historical focused measurements retain their original source SHAs in the initial experiment report.

## Cleanup

The owned simulator and disposable checkout are removed after verification.
The implementation checkout and its existing edits are preserved.
The raw logs, result bundles, comparison commands and mutation patches remain in the local evidence bundle.
