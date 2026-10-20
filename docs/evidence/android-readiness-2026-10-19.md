# Android readiness and lifecycle, 2026-10-19

The final candidate passed all 42 original Android cases without runner retries or the fixture's authored second-tap recovery. Runtime fell from 321.25 to 273.12 seconds, a 48.13-second reduction (15.0%). This measures the combined agent-device and e2e adapter changes. It does not establish parity with the experimental engine.

[Follow-up startup experiments](android-startup-experiment-2026-10-19.md) reached 229.672 seconds but failed timed-overlay safety tests. Those policies were rejected. The follow-up also reproduces a capture-to-input race near the retained timer's boundary.

The runtime is `fc612424d16cbaa6418107cb2552157f33a6e410`. The adapter runtime is `59307b157079b0b1a665b82afd0aa6b3845c2e2c`; final adapter commit `5e1d8952f4b0fd0d6a12b084ed8151e71e7cd889` changes only test assertions. The parent is `0d4b58c341bda7372d05e69a6bf58db6248e4f47`, whose runtime code is `ddba75f5b474cb4cdac11b15f75292f2870396c7`. The original app, tests, runner, and direct engine are [tester-army/e2e#1234](https://github.com/tester-army/e2e/pull/1234), commit `2593e45025edc52b2c381e809b41cb63d5878e2b`.

[Machine-readable results](android-readiness-2026-10-19-results.json) retain every selected test identity, status, duration, comparison, and validation boundary.

## Method and results

All variants used the same locally built Release APK (`dev.e2e.benchmark`), Pixel_7_CI / emulator-5554, Android 16 API 36, one worker, zero runner retries, enabled animations, and the attached Device panel stream. APK SHA-256: `b163e985ebd8340bf10447cdf6826aea37e429ee8c4382f9179c863c8c0619b2`. Each SDK checkout used its own dependencies, built native helpers, and isolated daemon state. App and test source were unchanged. The adapter benchmark config adds an opt-in environment switch.

| Variant | Passed | Failed | Source skip | Fixture recoveries | Elapsed |
| --- | ---: | ---: | ---: | ---: | ---: |
| Parent agent-device | 42 | 0 | 1 | 0 | 321.25 s |
| Final candidate plus adapter | 42 | 0 | 1 | 0 | 273.12 s |
| Experimental direct engine | 40 | 2 | 1 | 4 | 202.60 s |

Exact selected and runnable identities match. Of 45 declarations, Android selects 43: 42 run, and row containment is explicitly skipped. Two declarations are iOS-only. Counts alone were not used to establish coverage. The direct engine's failures and recovery calls prevent treating its whole-run duration as an all-passing reliability comparison.

On the 40 identities that passed on every engine, test durations total 308.199 seconds on the parent, 264.813 seconds on the candidate, and 199.428 seconds on direct. The remaining gap is 65.385 seconds. Startup transition waits and lifecycle proof remain costs; scrolling was not the source of the original comparative gap.

| Case | Parent | Candidate | Reduction |
| --- | ---: | ---: | ---: |
| Autofocus and moving focus | 9.064 s | 4.222 s | 53.4% |
| Product catalog | 8.986 s | 4.315 s | 52.0% |
| Choice controls and order | 7.833 s | 4.145 s | 47.1% |
| Modal and native alert | 7.922 s | 4.293 s | 45.8% |

These are local observations, not statistical estimates or hosted-CI measurements. The earlier broad-delegation candidates passed 42 cases in 233.26 and 229.75 seconds, but needed one and two authored fixture recoveries. Those timings are excluded from the final speedup. A passing runner summary hid the missed initial taps; the final comparison checks `tests/fixtures.ts:92` explicitly and requires zero calls.

From `apps/mobile-benchmark`, after selecting the built SDK in the adapter's dependencies:

```sh
E2E_MOBILE_DEVICE_READINESS=1 BENCH_ENGINE=agent-device \
  AGENT_DEVICE_STATE_DIR=/absolute/isolated-state \
  ANDROID_SERIAL=emulator-5554 E2E_TELEMETRY_DISABLED=1 \
  node node_modules/e2e/dist/cli/bin.js run \
  --config e2e.android.config.ts --workers 1 --retries 0 --output .e2e/readiness
```

For the parent, omit `E2E_MOBILE_DEVICE_READINESS` and select the parent SDK. For direct, omit `BENCH_ENGINE`. The app APK was installed before timing. No device boot, APK compilation, or installation time is included.

## Safety boundaries

- Complete captures that prove native cache invalidation no longer require a route change after a successful control press. Empty, sharply dropped, truncated, missing-root, and unproved captures retain their recovery checks.
- Android target motion uses a measured quiet position with a bounded transition recheck. Ref adoption requires a unique local identity with an identifier and the same known application package. Ambiguous or changed identities fail before dispatch. Ref recovery disclosure remains intact.
- Adapter delegation requires the daemon's advertised capability and an actual completed prior target press. Snapshot reads preserve this eligibility. Other command attempts and failed or cancelled mutations retire it. No-op toggles retire it. Startup, anonymous targets, inner-control rows, fill, keys, long press, and swipes retain the adapter's existing checks.
- Warm package open uses the helper only for the supported package-launch form. It preserves MAIN/DEFAULT/LAUNCHER intent semantics, quotes nested activity names, distinguishes installed-but-unlaunchable packages, and preserves multiline launch status and identity through Base64. Failed mutations are never resent.
- Existing foreground/process termination fences, IME ownership, and the documented frame-stat reset remain in place. Native stop consolidation was not shipped.

## Validation

The exact runtime commit passed `pnpm check:affected --run --base 0d4b58c341bda7372d05e69a6bf58db6248e4f47 --head fc612424d16cbaa6418107cb2552157f33a6e410`: 3,910 related tests, no failures, `exactCommit=true`, `checkoutChanged=false`. The native helper built locally. Independent reviews found no unresolved code findings.

The same focused regression command on unchanged parent production code yielded 12 failures and 6 passes; the fixed implementation yielded 18 passes. Thirty-six unrelated cases were filtered in each run. The failures cover false stale-route recovery, lost SDK capability projection, helper launch behavior, and ref reindex/ambiguity handling. Additional focused lifecycle and motion checks passed 52 cases. Adapter unit checks passed 352 cases, including startup, back, failed mutations, no-op toggles, anonymous controls, and nested controls.

The full `examples/test-app` Android suite also ran on the final runtime and rebuilt helper. All 10 scenarios passed. Its exact 41 commands and 15 behavior identities match the parent report. This includes permissions, system/Test IME restoration, keyboard dismissal, lifecycle, screenshot/recording, and retry-free replay. The Release fixture APK SHA-256 is `4f332d39e76899b86e7006cda5d43ade6211733fe85ffe4552735e3e56c867b4`. The fixture contains its bundled JavaScript and does not require Metro.

That test-app run uses fixture commit `498f939840858eb545cd8f30cc7c542c27c24c6c`. An earlier run exposed a fixed-scroll assumption in its checkout replay: the submit succeeded, but the summary remained above the viewport. One additional scroll revealed both the success card and exact expected summary without resubmitting. The replay now uses `scroll up --until 'id="form-success"'`; it retains both original summary assertions and does not retry submit. The full suite passed in 145.716 seconds. Three additional independent checkout runs also passed without retries. This fixture correction does not affect the original e2e benchmark measurements.

The final adapter passed its root `pnpm check` and all 352 mobile unit tests against its actual pinned published SDK, `agent-device@0.21.28`. Those checks validate compatibility of the default path; they do not prove the unreleased opt-in capability works with that SDK.

Coverage, native CI builds, device/provider lanes, and required checks at the pushed head remain GitHub obligations. The companion adapter PR is a draft until a released agent-device SDK preserves the capability and its pinned dependency/lockfile are updated; published `agent-device@0.21.28` drops the field. The measured runs explicitly linked the built SDK.
