# B1 result — Android tap-readiness dumpsys dedup + IME batch promotion

Branch `tier2/android-dumpsys-ime`, three commits, not pushed, no PR.

| | |
| --- | --- |
| `25d6f42e7` | one dumpsys read answers every window question; readiness observation reuse |
| `5e772d91d` | text entry batches whenever the device is on the helper IME |
| `50f69154c` | stop asking a dumpsys variant that never answers (from live tracing) |

Gates: `pnpm format`, `tsc`, `oxlint`, `pnpm check:layering`, `pnpm check:fallow`,
`pnpm check:affected --run` (277 files / 1797 tests) all pass. Live-verified on `Pixel_7_review`
(Android 16, API 36) with the Android helper backend confirmed active
(`androidSnapshot.backend=android-helper`, `helperVersion=0.20.10` == `package.json`).

## Results

Per tap on a clear screen, `dumpsys` reads:

| | unit (mocked adb, 3 taps) | live, Android 16, per tap |
| --- | --- | --- |
| before | 12 | 6 (≈351 KB) |
| after | 4 | 2 (≈128 KB) |

The ANR recovery poll (`waitForAndroidAppFocus` with `requireNoBlockingDialog`) goes from up to
4 dumps per 500 ms tick to 1 — the brief's ~78-spawn ceiling becomes 13.

Text entry, live, session opened with `--no-test-ime` on a device already carrying the helper IME:

| | before | after |
| --- | --- | --- |
| `fill @e2 "filed the expense"` | `input text` × 3 + `KEYCODE_MOVE_END` + `KEYCODE_DEL` batch, per attempt | 2 `am broadcast`, 0 `input text`, 0 delete keys |
| `type " report"` | `input text` × 1 | 1 `am broadcast` |

Both landed: the field read `filed the expense`, then `filed the expense report`. The
`android_text_injection` diagnostic reports `backend: test-ime` on both.

## Part 1

**1. One dumpsys read, parsed once.** `src/platforms/android/window-state.ts` now owns the dump
sequence for both questions the daemon asks of a window dump — which app is foreground, and whether
a blocking dialog owns the focus.

- `readAndroidBlockingDialogFocus` reports `focusObserved`: whether the dump named the focused
  window at all. The old code could not tell "no ANR here" from "this dump says nothing", so the
  second variant ran on every clear screen. It now fires only on the miss it exists for. Marker
  order is untouched (#1832).
- An `AndroidWindowDumpReader` binds a caller to one observation instant and runs each distinct
  command at most once. It is scope-bound, not time-bound, on purpose: a reader that outlived its
  caller would feed the 500 ms recovery polls text they had already seen, and those loops would
  never observe the state change they wait for.

**Live tracing then found the bigger half of the problem**, which the brief did not name. On
Android 16 `dumpsys window windows` does **not** print `mCurrentFocus` at all — the focus section
moved into the display dump that plain `dumpsys window` prints:

```
dumpsys window windows        -> 0 focus markers   (53 KB)
dumpsys window                -> 1 focus marker    (64 KB)
```

So the first command in the sequence structurally cannot answer, and the "lazy fallback" fires
every time anyway. `window-state.ts` now records per serial whether each variant has **ever**
printed a focus section, and demotes the ones that never have. "Ever answered" rather than
"answered last time" is load-bearing: a variant that normally answers still prints nothing during a
window transition, and I watched exactly that reset the demotion in an earlier live run. A demoted
variant moves to the back of the sequence and is still asked when nothing ahead of it answers, so a
wrong record costs ordering, never an answer.

**2. Readiness caching — inverted from the brief, deliberately.** The brief asked to cache the
*post-dispatch* check. Implemented literally, that removes the only detection of "this command
caused an ANR", which is the entire purpose of the `after-command` phase.

`src/daemon/android-dialog-readiness-observation.ts` does the same work the other way round: the
post-dispatch check always re-observes the device, and **its** result answers the *next* command's
pre-dispatch check. Same saving, detection intact. Two conditions bound it:

- The session runtime revision (`ref-frame.ts`) must be unchanged. That counter already advances at
  every device side-effect seam under ADR 0014, so any command that could provoke a dialog
  invalidates the record by construction — no argv allowlist to keep in sync, and a new mutating
  path is covered the moment it expires the ref frame like every other one.
- The record must be under 1 s old, because a system ANR can surface with no adb traffic at all.

Only `after-command` writes and only `before-command` reads, so the skip is fail-closed: a dispatch
path that forgot to declare its side effect still gets a fresh post-dispatch observation.

**Accepted cost:** a blocking dialog that appears within 1 s of a clear post-dispatch observation,
with zero intervening device mutation, is not caught by the next command's *pre*-check. That
command's *post*-check catches it. Stored per session in a `WeakMap` (the `ref-frame.ts` pattern),
not on `SessionState`, so no R7/R10 layering entries were needed.

**3. Alternating ANR probes — not implemented as written, because sharing beats alternating.** The
brief asked to alternate the focus and app-state probes across ticks. One shared reader gives both
signals from one dump: 1 spawn per tick instead of an alternation's 1.5 average, and both answers
come from the same instant instead of two dumps an adb round trip apart disagreeing about what is
on screen.

## Part 2

`ANDROID_INPUT_TEXT_CHUNK_SIZE` stays at **8**, and now carries the reason in code: it is the #531
truncation fix, not a tuning knob. A unit test pins the value to that reason.

**The brief's premise is half right.** The helper's batch broadcast is not gated behind
`--test-ime` in general — `shouldActivateAndroidTestIme` makes it default-on for emulators, so
ASCII `type`/`fill` already batched there. The real gap was that `isAndroidTestImeActive` asks a
*per-daemon-process* cache, while the active IME is a property of the **device**. A device carrying
the helper as its active input method with an empty process cache — a crashed run, a second daemon
on the same emulator, `open --no-test-ime` — silently fell back to `ceil(n/8)` shell spawns.

`typeAndroid`/`fillAndroid` now read the active input method from the `dumpsys input_method` probe
the shell path already runs, and route to the batch channel when that input method *is* the helper.
Zero extra spawns: the read that picks the channel is the read that already decided IME ownership.
The broadcast targets the observed package, so the promoted route does not depend on a packaged
artifact being on disk. Typed classification (`isAndroidInputTextUnsupported`, the `ime_capture`
`failureReason`) is unchanged — `assertAndroidShellInputIsAppOwned` just split into a probe and a
pure assertion so one read answers both questions.

**Not done, needs approval:** auto-activating the helper on a real device that is *not* already on
it. That switches the user's keyboard on their phone, which is why it is opt-in today; promoting it
is a policy change, not a performance fix.

## Red-first evidence

Every claim below was observed failing against the pre-fix code before the fix landed.

| test | pre-fix |
| --- | --- |
| `window-state.test.ts` — clear screen costs one variant | `['…window windows', '…window']`, expected one |
| `interaction-touch-android-readiness-spawns.test.ts` — 3 taps | 12 dumps, expected 4 |
| `android-dialog-readiness-observation.test.ts` — pre-check reuse | 2 dumps, expected 1 |
| `input-actions-test-ime.test.ts` — `type` on a helper-IME device | 0 broadcasts, expected 1 |
| `input-actions-test-ime.test.ts` — `fill` on a helper-IME device | fill verification failed |

The four other observation tests (post-dispatch always re-observes, side effects invalidate, TTL
ages out, a dialog is never recorded clear) pass both before and after — they are the guards on the
safety properties, not the change.

## Notes

- **Test topology.** `getAndroidAppState`/`getAndroidBlockingDialogFocus` moved out of
  `app-lifecycle.ts` (603 lines) into `window-state.ts`; shell text-entry mechanics moved out of
  `input-actions.ts` (502 lines, over the extract-before-500 rule) into `text-entry.ts`. Both new
  modules have mirroring test files. 15 test files that mocked the old module paths were re-pointed.
  `parseAndroidBlockingDialogFocus` was deleted rather than left as a wrapper.
- **Not touched:** `getAndroidAppStateWithAdb` in `app-helpers.ts` and
  `packages/platform-android/src/app-state.ts` run their own copies of this dump sequence with
  different (marker-major vs text-order) parse semantics. Consolidating them is a behavior change
  and a separate task.
- **Follow-up (small).** With the helper IME active but unowned, non-ASCII `type`/`fill` still
  refuse before the probe runs, so the refusal message is wrong in that case. Moving the ASCII gate
  after the probe fixes it but makes the refusal path spawn adb, which the existing unit tests
  correctly rely on it not doing. ASCII — what the brief asked for — is promoted.
- **`pnpm check:production-exports`** reports 37 inherited unused exports (contracts façade,
  maestro internals, `scripts/fuzz`). None are in files this branch touches and the count is
  unchanged; `pnpm check:fallow`, the changed-files gate, is clean.
- **Docs/skills: no changes.** Nothing here alters a CLI surface, flag, help text, or error
  message. `--test-ime` help and the unsupported-text hint stay accurate — the hint only fires when
  the helper is *not* the active IME.
- **Device hygiene.** Every session opened during verification is closed (`session list` returns
  `[]` for all five state dirs used). The emulator IME was restored to LatinIME and the
  `agent_device_ime_helper_previous_ime` record is clear. The `Pixel_7_review` emulator I booted is
  left running — other workers share this host and killing a device another run may have adopted is
  worse than an idle AVD. `Pixel_7_CI` was never used.
