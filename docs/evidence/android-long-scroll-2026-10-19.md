# Android long-list search experiment, 2026-10-19

The largest actionable cost in the retained Android suite is repeated list search. An explicit longer budget lets the existing verified `scroll --until` loop reach row 512 in one request. The controlled workflow median fell from 44.510 s to 27.581 s: 16.929 s saved, or 38.0%. Both routes used 55 gestures and activated the exact target.

This is an opt-in workflow improvement. Separate `scroll` and `snapshot` requests retain their behavior. The external e2e adapter must adopt the loop to obtain this gain. This experiment does not establish a new 42-case suite total or a comparison against the experimental e2e engine.

[Machine-readable results](android-long-scroll-2026-10-19-results.json) include samples, APK digests, source revisions, host loads, helper metadata, and correctness results.

## Where the suite spent time

The retained 42-case run began at 17:33:33 UTC and passed in 273.989 s. These request totals are attribution from that earlier run, not measurements of the new head:

| Operation | Calls | Total | Median |
| --- | ---: | ---: | ---: |
| snapshot | 756 | 63.493 s | 53 ms |
| open | 43 | 38.720 s | 857 ms |
| scroll | 69 | 34.307 s | 519 ms |
| press | 97 | 12.901 s | 63 ms |
| fill | 15 | 4.635 s | 254 ms |
| longpress | 3 | 3.375 s | 1,253 ms |

These are request totals, not additive explanations of the entire run. Adapter checks, fixture setup and authored waits also contribute. Steady snapshots and taps are usually below the 100 ms optimization threshold. The expensive path combines a roughly half-second gesture command with another stabilized snapshot after every page. A required 1,200 ms long press and the e2e negative-assertion grace interval are authored semantics, not latency to remove.

Temporary native phase instrumentation attributed scroll cost to acknowledged input delivery, the gesture duration, idle observation and repeated post-gesture capture. Viewport discovery was usually zero milliseconds and at most 24 ms in that sample. Instrumented timings are diagnostic only; all instrumentation was removed before the controlled comparison.

## Controlled comparison

Pixel_7_CI, Android API 36, emulator-5554, Android helper 0.21.29-dev. No task-owned builds or tests ran beside timing. Host load was retained for each sample. The installed APK hashes were freshly verified by pulling the installed packages.

Base: `507ef2376621d78aa76cf531bedc5abdf30e7a5a`. Feature timing head: `b5f7e70590`. The later request-signal wiring fix at `ce71f344a3` was verified separately below.

| Order | Route | Gestures | Search, snapshot and target press |
| --- | --- | ---: | ---: |
| A | separate public SDK scroll/snapshot requests, base | 55 | 44.850 s |
| B | public SDK scroll with until and maxPasses 90 | 55 | 27.530 s |
| B | public SDK scroll with until and maxPasses 90 | 55 | 27.632 s |
| A | separate public SDK scroll/snapshot requests, base | 55 | 44.170 s |

Each run relaunched `dev.e2e.benchmark`, opened Huge Virtualized List, searched for `row-512`, pressed its fresh ref and asserted `Found Row 0512`. App/menu setup and the final semantic read are outside both timing intervals. The external loop also checked that observed row ranges overlap between pages. All four processes exited zero; no failed or setup-only run enters the table.

The loop reuses each fresh capture to decide target visibility, readable capture, end of content and no progress. It avoids the extra public per-page snapshot/stabilization path. It does not omit the loop's safety observations or speed up native input delivery. Gesture duration remains 300 ms and input acknowledgements are unchanged.

The changed public call is:

```js
await client.interactions.scroll({
  direction: 'down',
  until: 'id="row-512"',
  maxPasses: 90,
});
```

The comparison route repeatedly calls `client.interactions.scroll({ direction: 'down' })` and `client.capture.snapshot({ interactiveOnly: true })` until that snapshot contains `row-512`. It reuses the last loop snapshot for the target press. The until route takes an interactive snapshot after the search. Both press the target with that snapshot's generation-pinned ref. This reproduces the request boundary under comparison without including app launch.

## Rejected primitive changes

A 300/150/150/300 ms ABBA experiment made shorter individual gestures faster, but the shorter gestures needed 61 passes instead of 55. Whole-search medians were 45.795 s at 300 ms and 47.315 s at 150 ms. All four exact-target assertions passed. The default duration was therefore retained.

An asynchronous intermediate-MOVE prototype did not show a reliable workflow gain. A controlled release-tail prototype moved cost into the following capture. Neither is included in the change. There is no claim that unrelated host load alone caused their results.

## Safety and final-source verification

The default budget stays at 12 gestures. Explicit budgets accept integers from 1 to 200 and require an until selector. Request timeouts remain independent and can end a search before it spends its gesture budget. Cancellation reads the real registered request signal through context construction and checks it before the next capture or gesture.

At `ce71f344a3`:

- The live benchmark search, final snapshot and correct target press took 27.942 s. Recording preserved `--max-passes 90`.
- The recorded `.ad` replay passed all six steps in 33.5 s with zero healing. The harness closed its surviving session.
- The installed Release test-app opened its catalog, reached `details-seasonal-footer`, pressed it and read the exact product name `Seasonal Footer Pick`. Both routes used seven gestures. Separate requests took 5.927 s; the loop took 4.027 s. This single pair corroborates behavior and is not a statistical estimate.
- A test-app search with maxPasses 1 failed with typed `scroll_until_pass_limit` and passes 1.
- Live test-app snapshots reported `android-helper`, version 0.21.29-dev, with invalidated accessibility cache.

The new runtime cases failed on unchanged base: six failures covering a budget above 12, a smaller budget and invalid inputs. Recording admission and round-trip tests failed twice before the recording fix. Cancellation tests that use the real context builder and request registry failed twice before request-signal wiring, then passed. Focused recording/scroll/visibility tests passed 141 cases; the final context/socket/HTTP/scroll group passed 50 cases. These overlapping groups are not summed.

Provider integration now tests arrival after 13 gestures with maxPasses 14 and refusal after one gesture with maxPasses 1. The same test file reports two failures and three passes on unchanged base production code: the longer search stops at 12, and the smaller budget is ignored. The feature passes all five cases. The visible page label changes with each capture so the longer search proves real progress through the existing no-progress detector.

The pass loop's sparse-capture refusal, edge detection, no-progress detection and visibility predicates remain in place. No gesture retry or recovery tap was added. Live verification covers the local Android helper, not Appium, HarmonyOS or Apple devices. The serialized affected gate and hosted CI remain separate validation obligations.

## Shared platform and provider applicability

Source inspection confirms that the search policy already lives above platform execution. `resolveScrollRuntimePlan` requires both `scrollDirection` and `captureSnapshot`; `executeUntilScroll` applies the same budget, visibility, readability, edge, progress and request-cancellation decisions to the admitted binding. No Android branch owns this policy.

Apple, web and Linux local runtimes use `bindLocalScrollInteractor`. WebDriver and Limrun bindings use `bindProviderScrollInteractor`. Both delegate one gesture through the same `bindScrollDirection` owner, preserving the selected backend's options and request signal. These bindings establish a common adoption path, not measured performance parity. Backend snapshots must still supply usable visibility and scroll geometry.

The transferable optimization is to let that bounded loop inspect its captures instead of adding a public snapshot/stabilization request after every page. The external adapter can adopt the existing shared API for eligible local or provider targets. Android's 300 ms pacing, idle handling and input transport are not a cross-platform default to copy. The rejected 150 ms experiment also shows why whole-search progress matters more than individual gesture latency.

The first hosted Coverage job failed an existing import-budget assertion before coverage thresholds ran: flag metadata pulled `scroll-command.ts` and its execution helpers into the eager flag-registry closure, increasing it from 30 to 31 modules. A type-only policy link now checks the static schema bound against `SCROLL_UNTIL_MAX_PASSES` without evaluating that module. The existing eager-import test reproduces the failure before the fix and passes afterward. No tests were added for this correction.

## Review follow-up, 2026-10-20

Production head `dd287d874a7a4bae1216dfdaccf280a0a33f23ce` is rebased onto `620228b8ca67a69a108fa4fc5041fdd88880b792`. The range comparison preserves all earlier changes. Its only conflict moved main's physical-iOS gesture guidance into the extracted help topic.

Cancellation now belongs to `runScrollPasses`, shared by target searches and edge scrolling. It checks before each observation and gesture, and after awaited work. Edge discovery retries and settling captures also check cancellation. The settling sleep wakes on abort. This preserves the request's typed cancellation reason and prevents another pass from starting.

The signal-consumer audit distinguishes context types. Only the scroll runtime newly reads the signal populated by `contextFromFlags`. `runtimeExecutionFromContext` excludes that field. Existing Apple runner/native-helper contexts get their signal from platform request bindings. Backend capture contexts get theirs from the command surface. Limrun allocation gets its separate `LeaseLifecycleContext.signal` from the lease handler. Maestro and replay contexts also have their own construction paths. These consumers do not acquire new cancellation behavior from this change. Native macOS helper shutdown already sends SIGTERM with a one-second grace so its handler can release a held button.

Live verification used the same Pixel_7_CI and APK hashes above. The emulator restored an older development-build snapshot; the checksum-verified Release fixture and benchmark APK were restored before verification. The PR's built SDK and isolated state directory `/private/tmp/agent-device-scroll-review-20261020` exercised this source; the Device panel's installed CLI predates the flag.

- Exact benchmark search: 55 gestures, then a fresh target press and exact `Found Row 0512` assertion. Search, snapshot and press took 28.229 s in one run. This is a smoke measurement, not a new controlled comparison.
- Our Release app: both routes reached and opened `Seasonal Footer Pick` in seven gestures. A one-pass search failed with `scroll_until_pass_limit` and `passes: 1`.
- Canceling target search and `scroll bottom` after 1.6 seconds returned `request_canceled`. Request logs show three gestures for the target search and one for the edge search before cancellation. Both accepted a readable follow-up snapshot; all sessions closed.
- Existing checks passed: 916 focused scroll/eager-import cases; 83 shared-loop, macOS helper and Limrun cases; eight Apple runner cancellation cases. No tests were added or changed in this follow-up.
- Independent Opus review found no defects in the rebase, cancellation, signal-consumer audit, API-neutral validation text, or the 90-second timeout guidance.

Raw outputs and request logs remain in the task's temporary artifacts. The earlier controlled ABBA measurements remain attributed to their original heads above.
