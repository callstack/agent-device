# The android press-escape guard's 200 ms settle, on the Redmi MIUI 14 unit, 2026-11-24

Live evidence for #5043 (the post-tap foreground read settled past the app
transition). Device: Redmi (model 2312DRAABC, MIUI V816 / HyperOS 1.0.6.0,
Android 14), USB serial `5p4hqglvpzxshiuw`. Fixture app
`com.ad.fixturescape` (a one-button debug APK whose only button fires
`Settings.ACTION_SETTINGS`), installed through adb with the MIUI per-install
confirmation accepted. Runs through `node bin/agent-device.mjs` after
`pnpm build` + `pnpm build:android` in each worktree, isolated state dirs
(`/tmp/ad5043-base-state`, `/tmp/ad5043-head-state`). Base = `ecb2089`
(pre-settle), head = `d79b1f308` (the PR's code head).

## The measured transition explains every number

With the fixture foreground and the tap driven by raw adb
(`input tap 540 314`, the button's own coordinates), polling
`dumpsys window | grep mCurrentFocus` every ~33 ms:

```
trial0 911ms   trial1 787ms   trial2 843ms   trial3 824ms
trial4 1096ms  trial5 1167ms  trial6 880ms   trial7 895ms
```

The Settings focus lands 0.79–1.17 s after the tap on this unit — far past
the reporter's Pixel 9 AVD (~150 ms) and past this PR's 200 ms settle. The
immediate read at base therefore still names the fixture and passes
(the #5034 bug), and head's settled read names Settings far more often.

## Escape-route evidence — press on the Settings-opening button

Fresh `snapshot` → `press @ref` on `OPEN SETTINGS`, three presses per side
(and a second 5-press round to show the rates), focus re-checked 1.5 s after
the CLI answer:

| run | base `ecb2089` | head `d79b1f308` |
|-----|----------------|------------------|
| 1   | `Tapped @e20` (focus = Settings → stale pass) | `Error (COMMAND_FAILED): press @e20 left com.ad.fixturescape and foregrounded com.android.settings` |
| 2   | `Tapped @e20` (focus = Settings → stale pass) | `Error (COMMAND_FAILED)` (same text) |
| 3   | `Error (COMMAND_FAILED)` (escape text) | `Error (COMMAND_FAILED)` (same text) |
| 4–5 (2nd round) | `Tapped` / `Error (COMMAND_FAILED)` | `Error (COMMAND_FAILED)` ×2 |

A second round with a fresh `open` before every press confirms the pattern —
head 4/4 `COMMAND_FAILED` with `foregroundPackage=com.android.settings`
(4/4 escape-route), base 3/4 `Tapped` where the focus read 1.5 s later names
`com.android.settings` (3/4 stale passes, one genuine escape detection):

```
head  roundB: ESCAPED ×4 (every failure text: press @eN left com.ad.fixturescape
      and foregrounded com.android.settings. The tap likely escaped the app.)
base  roundB: ESCAPED run1 (genuine), TAPPED runs 2–4 with
      focus_after=com.android.settings (stale passes).
```

Full transcripts (first round):

```
base ecb2089:
run1: Tapped @e20 (540, 314)                      wall=791ms
run2: Tapped @e19 (540, 314)                      wall=667ms
run3: Error (COMMAND_FAILED): press @e20 left com.ad.fixturescape and
      foregrounded com.android.settings. The tap likely escaped the app.
                                                  wall=923ms
follow-up proof that the passes were stale: focus 1.5 s after each base
answer — run1 ESCAPED-cli but focus=com.android.settings, run2 TAPPED-cli but
focus=com.android.settings (the exact #5034 failure), run3 ESCAPED-cli and
focus=com.android.settings.

head d79b1f308 (5 presses):
run1: Tapped @e20 (540, 314)                      wall=672ms
run2..5: Error (COMMAND_FAILED): press @eN left com.ad.fixturescape and
      foregrounded com.android.settings. The tap likely escaped the app.
```

Base prints `Tapped` on presses that actually escaped (verified by the
focus read after the answer) — the bug the issue reports. Head's failures
carry `foregroundPackage=com.android.settings` in the error text, so the
escape route (not the null-focus route) fired: the message is the
`assertAndroidPressStayedInApp` throw, reachable only when the post-settle
read resolved a foreground package. On this unit the transition outlasts the
200 ms settle in most runs, so the settled read usually names Settings; the
one head pass (run1) is a transition faster than settle+read — the constant
targets warm transitions and this MIUI unit is slower than that target.

## Plain in-app press wall time (+200 ms)

`press @e1` (the fixture's title text node) in a fresh session, 6 presses per
side, `date +%s` wall around the CLI call:

```
base ecb2089: 1473, 647, 653 ms (warm median ~650 ms)
head d79b1f308: 899, 953, 999, 976, 1733, 839 ms (median ~976 ms)
```

The delta between warm medians is ~+320 ms — the 200 ms settle plus the
extra dispatch overhead of the settled read; the first press of each session
pays session/daemon warm-up and is not comparable. Every press stayed in the
fixture (focus = `com.ad.fixturescape` after each).

## The 200 ms constant

`ESCAPE_GUARD_SETTLE_MS` already carries the comment this review asked for:
it names the measured transitions (~150 ms on the reporter's Pixel 9 AVD,
+223 ms plain-press wall on this Redmi unit at 2026-11-23) and states it
targets warm transitions, with the reason polling cannot replace the wait.
This run adds the raw numbers above: on MIUI the transition can reach
~1.2 s, so 200 ms is a floor for warm transitions, not a bound on cold ones —
the guard still reads the truth after its settle, and when the transition
outlasts it the error names the escape surface instead of passing the tap.
