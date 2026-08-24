# B1 result — Android tap-readiness dumpsys dedup + IME batch promotion

Branch `tier2/android-dumpsys-ime`, not pushed, no PR.

Four commits:

1. one dumpsys read answers every window question
2. text entry batches whenever the device is on the helper IME
3. stop asking a dumpsys variant that never answers (from live tracing)
4. rebase onto `origin/main` + the `REVIEW.md` F1-F4 fixes

The last commit is the adversarial review's verdict applied. It rebased Part 2 onto `main`'s
`text-input.ts` (#1974), narrowed the focused-window predicate, tiered the demotion memo, made an
unanswerable dump an explicit `unknown`, and **removed the readiness observation reuse** — see
"Post-review revisions" below.

Gates: `pnpm format`, `tsc`, `oxlint`, `pnpm check:layering`, `pnpm check:fallow`,
`pnpm check:affected --run` (277 files / 1797 tests) all pass. Live-verified on `Pixel_7_review`
(Android 16, API 36) with the Android helper backend confirmed active
(`androidSnapshot.backend=android-helper`, `helperVersion=0.20.10` == `package.json`).

## Results

Per tap on a clear screen, `dumpsys` reads:

| | unit (mocked adb, 3 taps) |
| --- | --- |
| before | 12 |
| after | 6 |

Both readiness checks around a tap now cost one dump each instead of two, because the focused-window
line answers the blocking-dialog question and the second variant fires only on the miss it exists
for. The live Android 16 trace (6 dumps ≈351 KB per tap before, 2 dumps ≈128 KB after) was taken on
the pre-review build; the mechanism it measured — one dump per check — is unchanged, the
pre-dispatch reuse it also included is gone.

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

**2. Readiness caching — attempted, then withdrawn (review F3).** A 1 s per-session record let the
previous command's post-dispatch observation answer the next command's pre-dispatch check. It is
gone: see "Post-review revisions".

**3. Alternating ANR probes — not implemented as written, because sharing beats alternating.** The
brief asked to alternate the focus and app-state probes across ticks. One shared reader gives both
signals from one dump: 1 spawn per tick instead of an alternation's 1.5 average, and both answers
come from the same instant instead of two dumps an adb round trip apart disagreeing about what is
on screen.

## Part 2

`ANDROID_INPUT_TEXT_CHUNK_SIZE` stays at **8**, and now carries the reason in code: it is the #531
truncation fix, not a tuning knob.

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
pure assertion so one read answers both questions. This lives in `text-input.ts`, the module #1974
extracted for exactly this code, and keeps that PR's warm-helper threading (`fillAndroid`'s
`helper: AndroidHelperSessionOptions`) intact.

**Not done, needs approval:** auto-activating the helper on a real device that is *not* already on
it. That switches the user's keyboard on their phone, which is why it is opt-in today; promoting it
is a policy change, not a performance fix.

## Red-first evidence

Every claim below was observed failing against the pre-fix code before the fix landed.

| test | pre-fix |
| --- | --- |
| `window-state.test.ts` — clear screen costs one variant | `['…window windows', '…window']`, expected one |
| `interaction-touch-android-readiness-spawns.test.ts` — 3 taps | 12 dumps, expected 6 |
| `text-input-test-ime.test.ts` — `type` on a helper-IME device | 0 broadcasts, expected 1 |
| `text-input-test-ime.test.ts` — `fill` on a helper-IME device | fill verification failed |

The review's four fixes were each observed red first against this branch's own pre-fix tree:

| test | pre-fix |
| --- | --- |
| `window-state.test.ts` — app-token-only dump (F1) | reported a clear screen, asked one variant |
| `window-state.test.ts` — silent window transition (F2) | `com.agentdevice.tester` from the activity dump, expected `com.android.settings` from the window dump |
| `android-dialog-readiness.test.ts` — ANR between commands (F3) | `{ status: 'clear' }`, expected `{ status: 'recovered', warning }` |
| `android-dialog-readiness.test.ts` — unanswerable dump (F4) | 0 `android_blocking_dialog_unobserved` events, expected 1 |

## Notes

- **Test topology.** `getAndroidAppState`/`getAndroidBlockingDialogObservation` moved out of
  `app-lifecycle.ts` (603 lines) into `window-state.ts`, which has a mirroring test file. 15 test
  files that mocked the old module path were re-pointed. `parseAndroidBlockingDialogFocus` was
  deleted rather than left as a wrapper. Part 2 needs no extraction of its own: `main` already
  extracted `text-input.ts` (#1974).
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
  message. `--test-ime` help stays accurate. The unsupported-text hint does **not** — see the
  Follow-up above; the ASCII gate runs before the probe, so a non-ASCII refusal on a helper-IME
  device still tells the user to pass `open --test-ime`. Open, not fixed here.
- **Device hygiene.** Every session opened during verification is closed (`session list` returns
  `[]` for all five state dirs used). The emulator IME was restored to LatinIME and the
  `agent_device_ime_helper_previous_ime` record is clear. The `Pixel_7_review` emulator I booted is
  left running — other workers share this host and killing a device another run may have adopted is
  worse than an idle AVD. `Pixel_7_CI` was never used.

## Post-review revisions

`REVIEW.md`'s verdict was do-not-merge on four confirmed correctness defects plus an unrebased tree.
What changed:

- **F8 — rebased onto `origin/main` first.** `main` had already moved `typeAndroid`/`fillAndroid`
  and the whole shell text path out of `input-actions.ts` into `text-input.ts` (#1974) and threaded
  a warm helper session through `fillAndroid`. Part 2's own `text-entry.ts` was that same
  extraction done differently; it is deleted, and the IME promotion is re-authored inside
  `text-input.ts` on top of #1974's threading, so no rebase resolution can revert it.
- **F1 — only `mCurrentFocus=Window{` answers the blocking-dialog question.** `focusObserved` was
  set by any focus marker, including `mFocusedApp=AppWindowToken{`, which names the focused app
  token and structurally cannot carry an ANR title. A dump naming just the app token now falls
  through to the variant that can carry one, as it did on `main`.
- **F2 — demotion is tiered and can no longer invert the sequence.** The window dumps and the
  activity dumps answer the foreground question with different authority (`mCurrentFocus` over
  `mResumedActivity`, #592). One transition-instant read demoted both window variants and let the
  activity dumps answer first, which reports an escaped press as a success. Demotion now reorders
  only WITHIN a tier, so a wrong record costs ordering and never an answer — which is what the memo
  always claimed. The memo is also per QUESTION now, because a dump that names the app token
  answers "which app is foreground" and can never answer "is a dialog blocking us".
- **F3 — the readiness observation reuse is removed.** Its cost was not "detection delayed by one
  command": on `main` the pre-dispatch check recovered a session-owned ANR and returned
  `{ status: 'recovered', warning }`, so the command proceeded and succeeded. With the reuse the
  same situation dispatched the tap into the ANR dialog's buttons and then failed the command. The
  post-check cannot recover that shape, because it cannot tell an ANR that predates the dispatch
  from one the dispatch provoked — and guessing "predates" would report a command that froze the app
  as a success. Preserving `main`'s outcome means probing before every dispatch, so the record and
  its module are gone. Two dumps per tap instead of one; still 2× better than `main`.
- **F4 — an unanswerable dump is an explicit `unknown`.** `getAndroidBlockingDialogObservation`
  returns `dialog` / `clear` / `unknown`, and `ensureAndroidBlockingSystemDialogReady` branches on
  the three. The command still proceeds on `unknown` (a failed probe has never been a refusal, on
  `main` either) but emits `android_blocking_dialog_unobserved`, and nothing about that dump can be
  carried forward as evidence.

Left open, not in this pass: **F5** (the ANR poll is attempt-bounded, so cheaper probes shortened
its wall-clock window), **F6** (the promoted `type` path has no delivery or helper-version check),
**F7** (`#1832` citations corrected to `#592` where this pass rewrote them; other `#1832`
references in the tree are unrelated), and **F9** (the promoted `fill` path taps twice).
