# Android startup readiness experiments, 2026-10-19

The startup early-exit experiment saved 43.450 seconds on the original 42-case suite, but it activated a covering control in timed-overlay tests. Do not promote it. Removing the framework animation wait from DOWN also failed that oracle. This follow-up changes evidence only; the published runtime and adapter policies remain unchanged.

The retained 1500 ms startup timer also failed when overlays arrived near its boundary. The timer mitigates a race; it does not establish an atomic relationship between the observed target and delivered input. A longer timer alone cannot provide that guarantee.

[Machine-readable results](android-startup-experiment-2026-10-19-results.json) retain cohort counts, native timestamps, rejected policies, and validation limits. [The previous accepted measurements](android-readiness-2026-10-19.md) remain attributed to their original commits.

## Inputs and isolation

The reviewed runtime was `d01199dcbe3e7e62a216d3ce4d071ff8b4a60ca1`. The adapter was `5e1d8952f4b0fd0d6a12b084ed8151e71e7cd889`. The direct-engine reference was `2593e45025edc52b2c381e809b41cb63d5878e2b`. Separate disposable checkouts received their own dependency installations and builds. The experiments ran sequentially on Pixel_7_CI / emulator-5554, Android 16 API 36, with one worker and zero runner retries.

The benchmark APK and its 42 runnable Android tests were unchanged. Its SHA-256 remains `b163e985ebd8340bf10447cdf6826aea37e429ee8c4382f9179c863c8c0619b2`. The test-app APK remains `4f332d39e76899b86e7006cda5d43ade6211733fe85ffe4552735e3e56c867b4`.

The adapter experiment replaced only the startup path with no prior action tree. It required a complete same-app observation, one uniquely matching target, unchanged surface and keyboard facts, and at least three equal target rectangles spanning 100 ms. It polled every 50 ms within the remaining transition budget. Missing, ambiguous, or unsettled targets refused. The existing device press guards still ran afterward. The zero-wait control skipped this startup observation policy; it retained the remaining runtime guards.

## Performance result, rejected for safety

| Run | Passed | Fixture recovery taps | Elapsed |
| --- | ---: | ---: | ---: |
| Published runtime plus adapter, retained timer | 42 | 0 | 273.122 s |
| Startup measured-readiness experiment | 42 | 0 | 229.672 s |
| Test-app affected workflows, timer | 3 | 0 | 21.449 s |
| Test-app affected workflows, measured | 3 | 0 | 18.209 s |

The full benchmark selected the same identities: 43 selected, 42 executed and passed, and one authored skip. The startup experiment reduced elapsed time by 15.9%. This is one local measurement, not a statistical or CI claim. A timer/measured/measured/timer pilot preceded the full run.

The three test-app workflows checked startup form navigation and exact controlled values, checkout submission and the exact submitted summary, and startup settings navigation. These runs exercise the changed adapter route. They do not replace the previously recorded full test-app verification at the unchanged runtime.

Passing app suites did not prove the startup policy safe. The additional fixture below falsified it without relying on runner status or an authored recovery tap.

## Activation oracle and counterexamples

A separate native fixture, `dev.agentdevice.readinessprobe`, exposes target and decoy handler counters plus a per-trial identity. Disturbances begin after the first accessibility read of the target. Each trial makes one requested action, reads the counters after 800 ms, and checks the trial identity. There are no action retries. A valid activation must produce exactly one target hit and zero decoy hits. Refusals with zero activations remain separate outcomes.

The first cohort contains 13 cells repeated three times: static, immediate and delayed slides, overlays, remounts, an instant shift, keyboard movement, duplicate identities, and continuous target motion.

| Policy | Correct activations | Refused, no activation | Wrong activations | Silent misses |
| --- | ---: | ---: | ---: | ---: |
| Retained timer | 30 | 9 | 0 | 0 |
| Measured startup | 27 | 12 | 0 | 0 |
| Zero startup wait | 13 | 3 | 17 | 6 |
| Original direct engine | 20 | 3 | 9 | 7 |

The timer and measured policies initially appeared safe. A wider sweep changed that conclusion:

| Falsification cohort | Trials | Correct | Refused | Wrong target |
| --- | ---: | ---: | ---: | ---: |
| Measured startup, overlay delays 200–650 ms | 50 | 19 | 27 | 4 |
| Retained timer, overlay delays 1300–1900 ms | 30 | 15 | 12 | 3 |
| Measured startup, native input instrumentation | 15 | 8 | 6 | 1 |
| Measured startup, app touch instrumentation | 15 | 9 | 4 | 2 |
| Measured startup, DOWN-only animation-wait bypass | 15 | 10 | 3 | 2 |

These deliberately selected timing distributions are different. They demonstrate counterexamples; they do not estimate production failure rates or establish a relative reliability rate. A tap delivered successfully before a future overlay appears is valid. The wrong-target rows instead contain actual decoy handler activations.

An unrelated background ticker produced two correct activations and one readiness refusal in three trials. Static controls activated in all three companion trials. Continuous target motion refused in all three. Target-scoped readiness therefore still needs a budget and capture-cost check; global visual quiet would also penalize unrelated updates.

Four negative controls each failed the oracle for the intended reason: empty-point input produced `target=0, decoy=0`; explicit decoy input produced `0,1`; duplicate input produced `2,0`; and a replaced activity returned a different trial identity. Setup errors and the earlier harness classification correction are excluded from the cohort totals.

## Native delivery trace

One instrumented wrong-target trial provides this sequence on the shared device uptime clock:

| Event | Uptime | Since final target read |
| --- | ---: | ---: |
| Final target accessibility read | 1558666275 ms | 0 ms |
| Native DOWN injection begins | 1558666291 ms | 16 ms |
| Overlay disturbance begins | 1558666304 ms | 29 ms |
| Covering control receives DOWN | 1558666312 ms | 37 ms |
| Covering control receives UP | 1558666314 ms | 39 ms |
| Decoy click handler increments | 1558666334 ms | 59 ms |

The preceding instrumentation cohort measured DOWN injection at 7–21 ms, median 12 ms. Its wrong-target trial waited 17 ms. This does not support a large global animation wait as the source of this failure or of the remaining suite-wide gap.

The DOWN-only bypass reused the existing three-argument dispatcher. Logs confirm 12 three-argument calls and zero fallback calls; three trials refused before injection. DOWN took 6–25 ms, median 15.5 ms. Two decoy activations falsified the bypass as a solution. No speed or compatibility claim follows from this small diagnostic cohort.

Android's connection code synchronizes input transactions before DOWN and after UP, passing through the animation-wait policy. Disabling that policy still leaves transaction synchronization and synchronous event delivery. See [AOSP Android 16 UiAutomationConnection](https://github.com/aosp-mirror/platform_frameworks_base/blob/android16-release/core/java/android/app/UiAutomationConnection.java#L126-L163). This is consistent with the measured short waits and surviving race.

## Disposition and next experiment

Three public-source review rounds with Claude Opus challenged delayed motion, identity, window transforms, input ordering, and negative-control quality. The review corrected an overbroad claim about future animations: success is judged at input delivery, not against a later final rectangle. It also distinguished native target handles from unique selector resolution. These reviews were design and source challenges, not approval of the complete unpublished patch.

Reject both experimental policies. Keep their measured performance attributed to rejected candidates. Preserve complete same-app observations, unique target identity, offscreen and cover checks, keyboard checks, typed refusals, and dispatch provenance.

The next useful experiment is one native operation that refreshes the resolved target, validates its current input surface, and dispatches with the smallest possible gap. It must measure actual app-side delivery, not just RPC completion. This is a hypothesis to test, not a demonstrated fix. Use the timed overlays, incoming windows, IME transitions, and the oldest supported Android API as falsification cases. Avoid reintroducing nearest-match selection or a global quiet requirement.

The other large opportunity remains repeated full-tree capture and readiness polling. Moving those observations closer to the native target could remove round trips without weakening freshness. The earlier cost audit measured 50.111 seconds of first-tap idle, 36.222 seconds of other locator idle, and 58.802 seconds across 736 daemon snapshot requests on the shared passing cases. These categories can overlap and must not be added together.

The local archive retains patches, fixture source and APKs, harnesses, reports, logs, and per-file checksums: `android-startup-experiment-2026-10-19.tar.gz`, SHA-256 `9d7a7cda4f2c465069ad640efb90182127ae60d5c86f492355bb5eefecc7decd`. It is a local handoff artifact, not a repository-hosted download. Twenty-two owned daemon states were stopped. Both disposable checkouts were removed. The reviewed SHA and clean tracked status were verified before these evidence-only edits. No runtime candidate was promoted.

[The edited-field follow-up](android-edited-field-experiment-2026-10-19.md) rejects a same-field timer shortcut and retains a guarded clear-verification fix.
