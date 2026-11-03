# Surface geometry review evidence, 2026-11-03

Source under test: `451ba0e7cdedd6773d85ac7955d18304de6f1cdf`.
Base: `ec80eecb1e0251d51d93aa68071c88577f1ea7ba` (`fix/foldable-springboard-surface`, #4122).
This packet addresses [the maintainer review](https://github.com/callstack/agent-device/pull/4189#issuecomment-6604084919).
The PR remains a draft because the requested live matrix is incomplete.

## Native checks

The unit-enabled iOS runner build and mandatory isolation scan passed.
Eleven method-selected native tests passed with `AGENT_DEVICE_XCUITEST_INCLUDE_UNIT_TESTS=1` and private derived data.
The selection covers composed partial-window lookup and both dispatch routes, orientation-changing sequences, keyboard-clipped scroll dispatch, measured placed-iPad dispatch, actual native record orientation, tap deadlines, sole-display caching, windowless portrait/landscape admission, and both parent dark-window/exception regressions.
`swift test --package-path apple/snapshot-presentation` passed all 50 tests at the source SHA.

The production-boundary assertions include:

- Window `(0,80,669,871)`, panel `669x951`, orientation `3`: clipped scroll evidence is `669x508`; screen endpoints `(335,434)` and `(335,234)` dispatch as `(235,335)` and `(435,335)` on display `3`.
- Placed iPad window `(224,207,386,682)`: the production screen reader measures `1024x1366`; screen point `(300,400)` dispatches as `(624,300)` on display `1` in orientation `3`.
- A first sequence action changes orientation: later tap/hold steps refuse, completed steps remain `1`, and the native event count does not increase.
- Native record construction receives orientation `4` while the fake application's current getter reports `1`; the actual record stores `4`.

## Mutation proof

An isolated checkout ran the same five-test selection at `fe226cd7becf0b63ebde0009b2a0d4792b9df1e3`.
Each mutation built successfully and failed the relevant assertions with xcodebuild exit `65`.
The baseline and restored runs each passed all five tests.

| Deliberate production defect | Failed assertions |
| --- | ---: |
| Rotate using the window box | 14 |
| Remove sequence orientation refusal | 16 |
| Rotate drag using the keyboard-clipped box | 2 |
| Skip sole-display measurement | 3 |
| Read orientation again during native record creation | 1 |
| Add window origin again to touch evidence | 4 |

After correcting the placed-window query fake, its one-test baseline, missing-measurement mutation, and restored run were repeated at `451ba0e7`: pass, three assertion failures, pass.
The reviewed checkout remained clean during the experiments.
One initial failing run stalled while collecting diagnostics after its suite finished; the entire experiment was rerun with supported `-collect-test-diagnostics never` and normal failing exits.

## Live observations and limits

Only Duo `4F879835-4AB3-4046-B033-5AB769209DD4` and iPhone `DBEA214F-555F-4DDA-B62B-E34285CE63DB` were used.
Every UI command used the device-bound command returned by `device_open`.
That installed `0.21.31` client connected to this worktree's `0.21.37-dev` daemon through a private authenticated HTTP config and `--state-dir /private/tmp/agent-device-surface-4189`.
The daemon restarted with `AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH=$PWD/.tmp/surface-live-4189-derived` and rebuilt the runner from this checkout.
Its cache records source fingerprint `f4aeca12f9da03f67581231f3feb28c76d3030602255fc119ae10fdd5b376721`.

The Tester ran from this worktree's Metro on port `8199`.
`fold open` reported hinge `180` and native lit panel `669x951`.
The command sequence was `orientation <pose>`, `press 'label="Form"'`, `fill 'id="field-name"' '<text>'`, and `get text 'id="field-name"'`.
The portrait request read back `Geometry portrait 451ba0e7`; the right request read back `Geometry right 451ba0e7`.
A left request first refused a keyboard-covered Form target and reported `TEXT_ENTRY_MISMATCH` on fill; the advised retry with `--delay-ms 80` read back `Geometry left 451ba0e7`.
A fresh snapshot and lit capture succeeded; the capture was `951x669` logical points.
The requested rotations did not consistently match application orientation, so these runs do not prove the three-orientation matrix.
The portrait-request tap logged native point `(617,515)`, reference `(0,0,871,669)`, display `3`, orientation `4`.
The right-request tap logged native point `(334,52)`, reference `(0,80,669,871)`, display `3`, orientation `2`.

On iPhone, `open com.apple.Preferences`, `snapshot`, and `press 'label="General"'` succeeded.
The visible screen changed to General; the native record logged display `1`, orientation `1`, point `(220,319)`, reference `(0,0,440,956)`.

Missing live evidence: verified Duo orientations, half-open interaction, scoped-set coverage, explicit XCTest fallback, hold, clipped landscape scroll, sampled gesture, rotation-changing repeat, and AX-unavailable iPhone routes.
The two-device assignment excludes extra scoped clones and live iPad hardware.
The CLI offers no forced single-tap XCTest route; the composed native harness covers that route.
Cleanup reported Duo hinge `0`; both simulators shut down; the owned daemon released both claims cleanly; Metro stopped.
