# Other iOS interaction and image paths — 2026-10-19

Profiling found a four-second readiness wait on an already-focused input and avoidable PNG encoding work. Two changes are retained: corroborate focus on the chosen input and use the existing fast PNG encoder for worker jobs and their inline execution path. The earlier rejected clearing shortcuts remain excluded.

## Measurements

Conventional medians, milliseconds. Native probes used the unchanged `dev.e2e.benchmark` app on iPhone 17 Pro, iOS 27.0, `BC54AC11-CD86-4C10-8C4E-5101C773FFEB`. Base source: `8a3931a9c4fd8188636b7f5a36d5e56b6b97b038`. Each native command group has four rounds. Image groups have 20 observations after two warmups; every output was decoded or compared against the original resampler, with identical RGBA pixels. Builds, tests, and benchmarks ran sequentially.

| Path | Base | Candidate | Scope |
| --- | ---: | ---: | --- |
| Native selector tap on an input | 5,469.25 | 667.24 | Explicit selector route; focus confirmed and value unchanged |
| Native empty fill, 19 characters | 2,046.05 | 2,068.56 | Same command entrypoint and independent value check |
| Native replacement fill, 19 characters | 3,337.75 | 3,342.05 | Same command entrypoint and independent value check |
| PNG worker encode, 402 × 874 | 10.65 | 3.30 | Same captured pixels, including worker round trip |
| PNG worker encode, 1206 × 2622 | 89.83 | 24.13 | Same captured pixels, including worker round trip |
| Box resize, 1206 × 2622 → 402 × 874 | 10.78 | 8.20 | Rejected candidate; whole-pixel 3× reduction |
| Box resize, 1206 × 2622 → 603 × 1311 | 13.41 | 10.89 | Rejected candidate; whole-pixel 2× reduction |
| Box resize, 1206 × 2622 → 481 × 1047 | 15.07 | 15.90 | Rejected candidate; fractional control slowed |

The selector result applies to the native selector route used by the narrow Maestro compatibility path. Ordinary CLI presses use canonical capture and coordinate dispatch; their baseline median was 770.09 ms. This is not a general tap or full-suite speed claim. Ordinary fills were effectively unchanged. The pixel-stage savings do not establish a total screenshot latency improvement.

## What changed and why it is safe

`waitForTextEntryReadinessAfterTap` called an app-wide focus lookup that deliberately always returns nil on iOS. It therefore waited out two readiness windows and tapped again. The new wait corroborates the already-chosen input through `keyboardFocusConfirmed`; it does not select a target from the focus query. The same corroboration can finish pre-typing stabilization after the existing keyboard-transition check. Unknown focus retains the bounded wait and fresh-frame retry. Snapshot-based attribute reads prevent a departed handle from recording a post-tap XCTest failure.

The regression test starts with an independently focused UIKit responder and requires readiness to return before one two-second window. Base took 4,491.55 ms and failed; the instrumented candidate took 27.20 ms. Existing hidden-keyboard, different-target, removed-input, and replaced-input checks remain in the native selection.

PNG worker encoding and inline encoding now call `encodePngPixels` with four channels. Worker scheduling, transfer rules, error routing, image dimensions, and RGBA contents are preserved. Compression bytes change. Tests decode with `pngjs` and compare every channel, including transparent pixels, through both execution paths.

An isolated resampling candidate assigned weight one when both scale ratios were integers. All pixels matched the original resampler. The approximately 2.5 ms integer gain came with a fractional slowdown and breached the complexity gate for `resizePngBox` (cognitive complexity 24). The final change excludes this fast path and its two added tests. The candidate's independent expected-value tests passed; forcing whole-pixel weights on fractional geometry failed one test. These measurements and the mutation result describe the rejected candidate only.

## Where the remaining time goes

Instrumented empty fills made one point lookup (265 ms median), eight target resolutions (206 ms combined), and three target/frame bindings (106 ms combined). Five observation calls also read snapshots. These are nested diagnostics; their totals must not be added into a command budget. Combining identity, geometry, and value from one fresh observation is the next common interaction opportunity. The final stability window still needs to observe app write-back.

The installed `0.21.25` CLI's request logs put screenshot acquisition at 428.5 ms median and the fresh display probe at 95.5 ms. Complete daemon screenshots took 607.5 ms; launcher-inclusive calls took 764.79 ms. Native pixel acquisition and fresh display facts are the larger remaining screenshot candidates. Preserve app/screen scope, panel identity, rotation, density, and secure masking when changing that boundary.

## Validation and reproduction

The [samples, instrumentation, manual native probe, and exact commands](ios-other-paths-latency-2026-10-19.json) support this report. `*MsCsv` fields preserve observations in time order. The native comparison uses the same diagnostic instrumentation on both builds. The final source removes that instrumentation and the upstream-app-dependent test.

- Final source: 22 native tests passed, zero failures or skips. iOS and macOS builds passed.
- PNG worker, encoder, fallback, and unchanged resize suites: 26 tests passed.
- The source screenshot pipeline captured the live upstream app at densities 1, 1.25, and 3 with the expected dimensions and portrait metadata. Resized captures used the optimized None-filter encoder.
- Ordinary CLI smoke: two rounds, 12 successful operations, with independent fill/append read-back.
- A four-step Maestro focus/type/assert flow passed after CLI navigation to the form. Diagnostics recorded selector dispatch. A separate full-navigation flow reached `Sticky Chrome Target` and failed before the input tap; its cause is unproven and it is excluded from the comparison.

An initial native probe used an incorrect cell query; a later harness compared an empty field's placeholder with an empty string. Those attempts are preserved locally and excluded. The accepted probe uses the production prepared-command entrypoint for fills and handles the app's known placeholder. No physical-device or full upstream-suite run was performed.

The disposable checkout is removed. Task-owned sessions are closed and the simulator is shut down. The local evidence directory is `.tmp/other-paths/`.

## Review follow-up and daemon rebase

The review follow-up adds native masked-input removal and replacement cases. Five focused tests passed, with no skips. An isolated stale-handle warmup mutation produced two failures and three passes: the new masked-removal test caught the recorded XCTest failure; replacement cases remained passing. The initial control launch was killed before test bootstrap. A simulator reset preceded the successful control; the initial cause is unproven.

[Coverage failed](https://github.com/callstack/agent-device/actions/runs/39261898948/job/118091424006) on nine eager-closure assertions. The inline encoder's static import added existing code to consumer import closures. Loading that encoder inside its async inline callback fixes the regression; all 851 eager-closure checks and 16 focused encoding tests passed. The worker path is unchanged.

The branch rebased onto `b5f47e7542e274fc84a193c4e111e6c73ac3b1f3`, including daemon ownership/shutdown PRs #3806 and #3797. All five patches matched in range-diff. Native and capture-kit contents matched across the rebase; the subsequent encoder-loading fix is the only runtime delta in this follow-up. Matched source-daemon measurements compare `806dfa9d71fbba4ca70fc640d8b2d99794f3f721` with `1acc564ff0e55c4ef5a86af57e60cca009b78c4a`.

All 54 timed device operations passed, with independent fill/append read-back. Before → after medians were: empty fill 2,466 → 2,448 ms; replacement fill 3,760 → 3,718 ms; input press 829 → 816 ms; append 1,569 → 1,613 ms; snapshot 324 → 329 ms; screenshot 902 → 768 ms. The two-step Maestro assertion/tap flow measured 1,413 → 1,259 ms. These use the same installed CLI and native artifact, with explicit HTTP overrides to separate source daemons; they are not timings of the installed host daemon.

Alternating daemon runs pooled 200 samples per revision after warmup: raw TCP 0.480 → 0.437 ms; SDK 9.482 → 8.166 ms. Individual SDK run medians varied from 5.70 to 11.84 ms before and 7.95 to 8.40 ms after. Sequential PNG worker medians were 3.584 → 3.586 ms at 402×874 and 25.436 → 24.888 ms at 1206×2622, with every decoded pixel equal. No repeatable loss of the existing gains was observed. The small device sample and host variation do not prove statistical equivalence or a new speedup. All task-owned sessions and source daemons were closed, and disposable checkouts were removed.
