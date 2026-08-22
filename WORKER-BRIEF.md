# Worker brief — B1: Android tap-readiness dumpsys dedup + IME batch promotion (audit V2 + A8)

Read AGENTS.md first and obey it. Branch `tier2/android-dumpsys-ime` is checked out. Commit; DO NOT
push or open a PR. Write RESULT.md when done.

## Part 1 — dumpsys dedup (verified, understated)

The no-dialog common case runs BOTH `dumpsys window windows` AND `dumpsys window` per phase — 4
heavy spawns per tap (`src/daemon/handlers/interaction-touch-android-readiness.ts:37-63` calls
`ensureAndroidBlockingSystemDialogReady` before AND after dispatch; each call is
`getAndroidBlockingDialogFocus` in `src/platforms/android/app-lifecycle.ts:126-133`, which runs two
dumpsys variants). The `requireNoBlockingDialog` wait loop (`android-system-dialog.ts:368-387`) can
reach ~78 adb spawns.

Required:
1. One `dumpsys window` invocation parsed once for BOTH focus and blocking-dialog signal (preserve
   the exact parse order and fallback behavior of the current two-variant approach — incident-
   derived semantics from #1832; if the second variant exists purely as fallback for older OS
   versions, keep a lazy fallback that only fires when the primary parse finds nothing).
2. Cache the post-dispatch readiness check ~1s (the pre-check ran milliseconds earlier on the same
   window state) with explicit invalidation on any state-changing command.
3. In the ANR wait loop, alternate probes instead of running both focus and app-state checks every
   500ms tick.

## Part 2 — A8 reframed: promote the IME-helper batch path

DO NOT enlarge `ANDROID_INPUT_TEXT_CHUNK_SIZE = 8` (`input-actions.ts:376`) — the 8-char chunking is
the fix for #531's on-device truncation. The right lever already exists: the test-IME helper's batch
broadcast sends whole strings in one `am broadcast`, gated behind `--test-ime`. Promote that path so
ASCII fill/type uses it without the flag where safe, keeping shell chunking as fallback. Read #531
(`gh issue view 531`) to understand the truncation failure mode before touching anything.

## Constraints

- Red-first tests (spawn counts via mocked adb) observed failing pre-fix.
- Preserve typed error classification (`isAndroidInputTextUnsupported` etc.) and incident-derived
  parse order.
- Tests mirror topology; targeted vitest + `pnpm check:affected --run`; `pnpm format`.
- Live emulator verification welcome if an AVD is free (`Pixel_7_review` preferred; NOT
  `Pixel_7_CI`); follow docs/agents/device-verification.md staleness rules; close every session.
