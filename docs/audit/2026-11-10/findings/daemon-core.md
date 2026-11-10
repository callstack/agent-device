# DCORE audit: `packages/daemon/src/core/`

## Coverage

Slice: `packages/daemon/src/core/` (136 files, ~25k lines; ~9.6k production, the rest tests and fixtures). This pass covers what `daemon-server-core.md` (DSRV) did not reach. DSRV findings are not repeated.

- Read fully (production): `recording-gestures.ts`, `recording-gesture-events.ts`, `recording-timing.ts`, `recording-values.ts`, `gesture-runtime.ts`, `touch-runtime.ts`, `fill-backend-result.ts`, `snapshot-capture.ts`, `snapshot-runtime-capture-input.ts`, `snapshot-runtime-binding.ts`, `snapshot-session.ts`, `session-snapshot-freshness.ts`, `settle-observation-capture.ts`, `ref-frame.ts`, `ref-frame-slot.ts`, `session-script-writer.ts`, `session-script-publication-state.ts`, `session-script-active-publication.ts`, `session-script-publication-capability.ts`, `session-replay-transaction.ts`, `session-action-recorder.ts`, `selector-recording.ts`, `composite-resource-admission.ts`, `session-selector.ts`, `session-recovery-hints.ts`, `deferred-interaction-outcome.ts`, `interaction-surface-signature.ts`, `runtime-admission.ts`, `session-runtime-admission.ts`, `request-runtime-binding.ts`, `session-state.ts`, `capture-disclosure.ts`, `capture-output-ownership.ts`, `direct-ios-selector.ts`, `runtime-session.ts`, `runtime-operation-effects.ts`, `session-capture-binding.ts`, `lease-context.ts`, `request-device-resolution.ts`, `explicit-session-resolution.ts`, `ios-app-session-hint.ts`, `device/device-ready.ts`, `device/device-selector-intent.ts`, `platform-owner-lifecycle.ts`, `platform-resource-cleanup.ts`, `interaction/internal/interaction-touch-direct-ios-eligibility.ts`.
- Skimmed: `dispatch-context.ts` (type and key list only).
- Not read: `selector-operation-binding.ts`, `interaction/internal/types.ts`, `platform-services.ts`.
- Tests: only `__tests__/recording-gestures.test.ts` (titles and one case), `__tests__/deferred-interaction-outcome.test.ts` (one case), `__tests__/lease-context.test.ts` (one case), and `__tests__/session-script-writer.test.ts` (grep) were inspected. The other ~50 test files and the composite-admission test and fixture files were not read.
- Out-of-slice files were read only to trace call paths (`sessions/session-lifecycle/internal/session-close*.ts`, `session-open*.ts`, `execution/request-generic-dispatch.ts`, `execution/interaction/internal/interaction-gesture*.ts`, `execution/handlers/react-native.ts`, `host-kit` atomic-file, `contracts` async-lifecycle, `apple-runner` runner-sequence).
- Rough coverage: ~95% of `core/` production lines when combined with DSRV's ~20%; ~5% of `core/` test lines. Nothing was executed. Every finding is from reading code and grep.

## Findings

### DCORE-1: Ordinary `close --save-script` reports success when the script write fails with a filesystem error
- Category: broken
- Severity: medium     Confidence: high
- Evidence: `packages/daemon/src/core/session-script-writer.ts:204-229` — for a session that is neither repair-armed nor an active publication, `handleSessionScriptWriteFailure` rethrows only `AppError` and returns `{ written: false }` with no `error` for anything else (line 228). `publishFileSync` (`packages/host-kit/src/internal/atomic-file.ts:18-36`) and `fs.mkdirSync` (writer line 135) throw raw `ErrnoException` for EACCES, ENOSPC, EROFS, ENOTDIR, so every such failure takes that branch. The caller `packages/daemon/src/sessions/session-lifecycle/internal/session-close-script.ts:83-107` (`finalizeOrdinaryCloseScript`) treats a non-written result as nothing to report and returns `undefined`; its `catch` branch for non-`AppError` errors (`toOrdinaryCloseSaveScriptFailure`, lines ~122-126) is therefore unreachable. `buildCloseSuccessResponse` (`session-close.ts:489-527`) then answers `Closed: <session>` with no warning. The session is retired, so the recording is lost with only a `warn` diagnostic (`session_script_write_failed`). The repair and active-publication paths surface the same error (`toRepairCommitFailure`, `toActivePublicationFailure`).
- Fix: make the ordinary path return `{ written: false, error }` (or throw a wrapped `AppError` with a typed reason) for filesystem failures, so `finalizeOrdinaryCloseScript` reports "session closed, script not saved". Delete the now-redundant quiet-skip branch. Files: `core/session-script-writer.ts`, `sessions/session-lifecycle/internal/session-close-script.ts`, `core/__tests__/session-script-writer.test.ts` (cases at lines 696/859/873 pin `{ written: false }`; check which of them are filesystem failures).
- Effort: S
- Model: opus (changes a close-time contract; idle-reap and shutdown teardown reach the same writer through `SessionStore.finalizeRepairTeardown`/`writeSessionLog`)
- Verify: new writer test: armed authoring session, target directory read-only, assert the result carries an error; new close test asserting the response is a failure naming the path.

### DCORE-2: Ordinary `bindDevice` has no late-binding cleanup; a bind that completes after request disposal is never disposed
- Category: broken
- Severity: medium     Confidence: medium
- Evidence: `packages/daemon/src/core/request-runtime-binding.ts:127-145` — the cached path runs `gateway.bind(...).then((binding) => cleanups.use(binding))`. `AsyncCleanupStack.use` throws `TypeError('Cannot register cleanup after disposal has begun')` once the stack is disposing or disposed (`packages/contracts/src/async-lifecycle.ts:10-18,44-48`). In that case the freshly published binding is dropped without `[Symbol.asyncDispose]()`. The exact-owner path in the same file handles exactly this case: `adoptExactBinding` (lines 170-191) disposes the binding and emits `request_runtime_late_binding_cleanup_failed`. The two paths of one function family disagree, and only the exact path has a test (`__tests__/request-runtime-binding.test.ts:360`). Confidence is medium because I did not prove a production sequence where the request scope disposes while an ordinary bind is still in flight; the existence of the exact-path guard shows the authors consider it reachable.
- Fix: route the ordinary path through the same adopt helper (`adoptExactBinding(cleanups, binding, params.scope)`), then rename the helper. File: `core/request-runtime-binding.ts`.
- Effort: S
- Model: opus (request-scope lifetime and concurrency)
- Verify: new case in `core/__tests__/request-runtime-binding.test.ts`: dispose the bindings while `gateway.bind` is pending, resolve the bind, assert the binding's dispose ran and `bindDevice` rejected.

### DCORE-3: `swipe --count N` recording overlays are anchored at the last repetition when native gesture timing is present
- Category: broken
- Severity: medium     Confidence: medium
- Evidence: `packages/daemon/src/execution/interaction/internal/interaction-gesture.ts:432-453` — `runGestureRepetitions` returns only the LAST repetition's result. `interaction-gesture-response.ts:41` spreads that result's `backendResult` (which carries `gestureStartUptimeMs`/`gestureEndUptimeMs` on the Apple runner) into the response data that `finalizeTouchInteraction` hands to `recordTouchVisualizationEvent`. In `packages/daemon/src/core/recording-gestures.ts:64-69`, `tMs` is then the offset of the last swipe's start, and `buildSwipeEvents` (lines 297-323) lays out all `count` events forward from it: `startTime = tMs + index * (durationMs + pauseMs)`. For N repetitions every overlay is drawn `(N-1) * (duration + pause)` late: the first N-1 real swipes show no overlay, and N-1 overlays play after the gestures ended. Without native timing (`fallbackStartedAtMs`) the anchor is the request start and the layout is correct, so the two timing sources disagree. The same anchor error applies to `gesture tap --count` (`recording-gesture-events.ts:70-88`, comment "a repeated series shows its first touch"). No test covers `count > 1` for swipe (`__tests__/recording-gestures.test.ts`: the only `count` is line 465). Not reproduced on a device.
- Fix: either have `runGestureRepetitions` return the first repetition's start timing (first `gestureStartUptimeMs`, last `gestureEndUptimeMs`, as `apple-runner/src/runner-sequence.ts:76-85` does for press series) and derive per-repetition duration in `buildSwipeEvents`, or record one visualization event per repetition. Files: `execution/interaction/internal/interaction-gesture.ts`, `core/recording-gestures.ts`.
- Effort: M
- Model: opus (device timing behavior; needs a recorded iOS run to confirm)
- Verify: new test in `core/__tests__/recording-gestures.test.ts`: `swipe` with `count: 3`, `pauseMs`, and native uptime fields; assert the first event's `tMs` equals the first repetition's start. Manual: `record start`, `swipe ... --count 3`, `record stop` on an iOS simulator and compare overlay timing.

### DCORE-4: A recorded `fill <target> ""` (clear) with a resolved selector chain is rejected as "never resolved to a selector"
- Category: broken
- Severity: medium     Confidence: medium
- Evidence: `packages/daemon/src/core/session-script-writer.ts:401-407` — `optimizeFillAction` returns `undefined` when `inferFillText(action)` is empty, although the action has a `selectorChain`. `buildOptimizedActions` (lines 325-332) then treats the action as unoptimized: for a repair-armed session or an active publication it calls `assertNoUnresolvedRefFallback` (lines 349-366), which throws `Cannot write recorded step "fill @eN" ... it never resolved to a selector` for a ref-targeted fill. For an ordinary close it writes a bare `fill @eN ""` line, which the same file calls "meaningless outside the session that minted it". An empty text is a supported request: `execution/interaction/internal/interaction-touch-targets.ts:94-141` says `''` "is the explicit clear request", and `formatFillActionLine` (writer lines 517-529) says "Preserve explicit empty-string fill arguments". The error message is also false: the selector did resolve.
- Fix: in `optimizeFillAction`, return `{ ...action, positionals: [selectorExpr, text] }` whenever the action carries a text argument, including `''`; distinguish "no text recorded" from "empty text" by `action.positionals.length`/`typeof action.result?.text`. File: `core/session-script-writer.ts`.
- Effort: S
- Model: sonnet
- Verify: new case in `core/__tests__/session-script-writer.test.ts`: repair-armed session with a `fill @e3 ""` action whose result has `selectorChain` and `text: ''`; assert the script line is `fill <selector> ""` and no error is returned.

### DCORE-5: `captureSnapshot` still falls back to the legacy interactor capture for callers that pass no `captureData`
- Category: inconsistent
- Severity: medium     Confidence: medium
- Evidence: `packages/daemon/src/core/snapshot-capture.ts:44-49` documents `captureData` as "Migrated callers inject the selected runtime operation; legacy consumers keep the existing interactor path until their own command descriptor cuts over", and lines 98-128 keep the fallback to `captureSnapshotWithInteractor`. Live callers of the fallback remain: `sessions/handlers/session-replay-command.ts:185-191` (no `captureData`) and `execution/interaction/index.ts:41-62` (`captureSnapshotForSession` passes `captureData` only when `boundCapture` is supplied; `execution/handlers/react-native.ts:200-207` calls it without one). `core/settle-observation-capture.ts:14-21` states the cost of exactly this split: the legacy interactor and the request-bound runtime "are two projections of one tree" on an iOS simulator (#3510). AGENTS.md: "During a migration, remove superseded paths."
- Fix: bind a capture for the remaining callers (the `capture-only` selector plan that `resolveSettleObservationCapture` already uses), make `captureData` required, and delete `captureSnapshotWithInteractor` plus `core/snapshot-interactor-capture.ts`. Files: `core/snapshot-capture.ts`, `core/snapshot-interactor-capture.ts`, `sessions/handlers/session-replay-command.ts`, `execution/interaction/index.ts`, `execution/handlers/react-native.ts`.
- Effort: M
- Model: opus (cross-module, device-facing capture behavior)
- Verify: typecheck with `captureData` required; `pnpm check:affected --run`; device run of `react-native dismiss-overlay` and a replay with a divergence capture on an iOS simulator.

### DCORE-6: `applyRecordedSaveScriptFlags` keeps an unreachable `none -> authoring` arm as a declared safety net
- Category: unneeded
- Severity: low     Confidence: high
- Evidence: `packages/daemon/src/core/session-script-publication-capability.ts:77-84` says the arm "is UNREACHABLE for `close`" and "is kept as that caller's safety net" for "a future non-close caller"; the arm is line 121 (`session.scriptPublication = armAuthoring(requested)`). The other ingress is also closed: a fresh `open --save-script` arms first through `armAuthoringOnOpen` (`sessions/session-lifecycle/internal/session-open-execution.ts:95-98`), and `open --save-script` on an existing session is refused (`session-open.ts:206-213`); `close --save-script` on an unarmed session is refused (`session-close.ts:221-235`); every other command's flag is closed at the router (per the same comment, #1501). AGENTS.md: "Add compatibility or fallback behavior only on explicit request." Related dead surface in the same file: `armAuthoringOnOpen(session, requested, hostCwd)` (lines 41-50) is only ever called with `{}`, so its `requested.path`/`force` handling and `hostCwd` parameter are dead; `markActivePublicationDone` (148-150) and `markCloseGeneratedPublicationDone` (153-160) do the same thing, because `markAuthoringPublished` already returns non-authoring states unchanged.
- Fix: replace the `none` arm with a thrown invariant error (or return), drop the unused parameters of `armAuthoringOnOpen`, and merge the two `mark*Done` functions. Files: `core/session-script-publication-capability.ts`, `sessions/session-lifecycle/internal/session-open-execution.ts`, `sessions/session-lifecycle/internal/session-close-script.ts`, `sessions/handlers/session-script-publication.ts`.
- Effort: S
- Model: sonnet
- Verify: `pnpm check:affected --run` (`session-script-publication-state.test.ts`, `session-action-recorder.test.ts`, close/open tests).

### DCORE-7: `stripInternalInteractionFlags` and the `postGestureStabilization === true` arm have no producer
- Category: unneeded
- Severity: low     Confidence: high
- Evidence: `packages/daemon/src/core/deferred-interaction-outcome.ts:401-407` strips the flag only when it is truthy. The flag definition is `setValue: false`, `recorded: false` (`packages/command-registry/src/flag-definitions-action.ts:231-245`), and every non-test producer sets only `false` (`command-surface/src/interaction/index.ts:623`, `gesture.ts:30-31`, `metadata.ts:303-304`); a repo-wide grep for `postGestureStabilization: true` finds only tests. So in production the function always returns its input (a `false` value passes through and is then dropped by `sanitizeFlags`, because the key is not recorded). The same applies to `isPostGestureStabilizingAction` line 415 (`=== true`). The only test of the function asserts the unreachable `true` case (`__tests__/deferred-interaction-outcome.test.ts:257-265`).
- Fix: delete `stripInternalInteractionFlags`, its two call sites (`execution/interaction/internal/interaction-common.ts:59`, `find.ts:504-506`), the `=== true` arm, and the test. Files as listed.
- Effort: S
- Model: sonnet
- Verify: `pnpm check:affected --run`; `find.test.ts:571` must be updated.

### DCORE-8: `deviceLease` "session compatibility input" in `lease-context.ts` has no producer
- Category: unneeded
- Severity: low     Confidence: high
- Evidence: `packages/daemon/src/core/lease-context.ts:48-51,85` — `SessionLeaseSource.deviceLease` and `session?.lease ?? session?.deviceLease`. `SessionState` has no `deviceLease` field (`core/session-state.ts`), and a repo-wide grep for `deviceLease` finds only these two lines and the test `__tests__/lease-context.test.ts:80` ("accepts deviceLease as session compatibility input"). Also, `SessionLease` (lines 37-46) duplicates the inline `SessionState.lease` shape (`session-state.ts`, same eight fields).
- Fix: remove `deviceLease` and its test; declare `SessionState.lease` as `SessionLease` (or the reverse) so one type owns the shape. Files: `core/lease-context.ts`, `core/session-state.ts`, `core/__tests__/lease-context.test.ts`.
- Effort: S
- Model: sonnet
- Verify: typecheck and `lease-context.test.ts`.

### DCORE-9: `DeferredSurface.stabilize.markedAt` is written and documented as load-bearing but never read
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence: `packages/daemon/src/core/session-state.ts:89-90` states "`markedAt` is when the mutation FINISHED, so the window waits out only what is left of it". It is written at `core/deferred-interaction-outcome.ts:144,243`, and `capturePostGestureStabilizedResult` passes only `action`, `positionals`, `baseline` to the loop (lines 364-369). A repo-wide grep for `markedAt` in non-test source finds readers only for the unrelated Android freshness window (`session-snapshot-freshness.ts:65`, `capture-kit/.../recovery.ts:47`). Either the stability loop should subtract the time already elapsed (as the comment promises) or the field is dead. In the same module, comments still name a field that no longer exists: lines 38-39 and 345-346 say this module owns and clears `postGestureStabilization`; the field is `deferredSurface`. Line 367 defends `pending.positionals ?? []` although the type says "Always set by every writer".
- Fix: decide with the owner. If elapsed time should shorten the wait, pass `markedAt` into `runPostGestureStabilityLoop`; otherwise delete the field and the sentence. Correct the stale comments. Files: `core/session-state.ts`, `core/deferred-interaction-outcome.ts`, possibly `packages/capture-kit/src/.../post-gesture-stability`.
- Effort: S
- Model: opus (changes stabilization latency if wired in)
- Verify: `core/__tests__/post-gesture-stabilization.test.ts`.

### DCORE-10: Two admission modules duplicate the gateway guards and the admission loop
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence: `packages/daemon/src/core/runtime-admission.ts:161-175` (`requireFactsInspection`, `requireDeviceBinding`) and `core/session-runtime-admission.ts:39-46,154-161` (`requireRuntimeFacts`, `requireRuntimeBinding`) are the same two functions with the same message and `reason: 'runtime-gateway-missing'`. `admitRuntimeOperations` (`runtime-admission.ts:77-93`) and `admitRuntimePlan` (`session-runtime-admission.ts:139-152`) both loop `required` over `facts.operations` and stop at the first unavailable fact; only the first one supports `subject`. `session-runtime-admission.ts` already imports from `runtime-admission.ts`, so there is no layering reason for the copy.
- Fix: export the two guards from one module and import them in the other; express `admitRuntimeOperations` on top of one shared "first unavailable fact" helper. Files: the two modules.
- Effort: S
- Model: sonnet
- Verify: `runtime-session.test.ts`, `session-runtime-admission.test.ts`, `gesture-runtime-admission.test.ts`.

### DCORE-11: Dead and constant output in the script writer
- Category: unneeded
- Severity: low     Confidence: high (items 1, 3), medium (item 2)
- Evidence: all in `packages/daemon/src/core/session-script-writer.ts`.
  1. Line 467 `if (action.flags?.noRecord) continue;` cannot be true: `recordActionEntry` returns before pushing a `noRecord` entry (`core/session-action-recorder.ts:63`), `session.actions.push` has exactly one site (recorder line 100), and the writer's synthesized scoped-snapshot action sets no such flag.
  2. Lines 461-464 write `theme=unknown` from a local constant on every `context` line. A grep for `theme` across `packages/*/src` (non-test) finds no reader. Confidence is medium: the token is part of the emitted `.ad` text, so fixtures and docs may mention it.
  3. Line 135 `if (!fs.existsSync(scriptDir)) fs.mkdirSync(scriptDir, { recursive: true })` — the `existsSync` is redundant with `recursive: true`.
- Fix: delete line 467; remove `theme=unknown` (after confirming with the owner that no external reader depends on it) and update fixtures; drop the `existsSync`. File: `core/session-script-writer.ts` plus `.ad` fixtures.
- Effort: S
- Model: sonnet
- Verify: `core/__tests__/session-script-writer.test.ts`; grep fixtures for `theme=unknown`.

### DCORE-12: `.trimEnd()` binds to the last template literal only, so the device-in-use hint ends with a space
- Category: broken
- Severity: low     Confidence: high
- Evidence: `packages/daemon/src/core/session-recovery-hints.ts:150-155` — the returned expression is `a + b + c + \`${waitForDeviceHint(options)}\`.trimEnd()`. Member access binds tighter than `+`, so only the last piece is trimmed. When `waitForDeviceHint` returns `''` (any non-`open` refusal, or after a spent `--wait`), the hint ends with `"... first run agent-device close --session X. "` including the trailing space.
- Fix: wrap the whole concatenation in parentheses before `.trimEnd()`. File: `core/session-recovery-hints.ts`.
- Effort: S
- Model: sonnet
- Verify: `core/session-recovery-hints.test.ts`: assert the hint does not end with whitespace for `offersDeviceWait: false`.

### DCORE-13: `resolveRecordingDurationMs` ranks the wall-clock fallback above explicit candidates, so its candidates and default constants are unreachable
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence: `packages/daemon/src/core/recording-values.ts:8-18` tries `[gestureDurationMs, ...candidates, fallbackDurationMs]` in order. `gestureDurationMs` comes from `resolveGestureDurationMs` (`recording-timing.ts:52-63`), whose last resort is the request's wall-clock span, which is at least 1 ms for any real command. So the candidates (`recording-gestures.ts:291` `positionals[2]`, line 310, `recording-gesture-events.ts:40,64`) and the defaults (800 at `recording-gestures.ts:292`; `DEFAULT_SWIPE_DURATION_MS = 250` at line 25, used at 311 and 354; `DEFAULT_GESTURE_TRAVEL_DURATION_MS = 250` and `DEFAULT_PINCH_DURATION_MS = 280` at `recording-gesture-events.ts:5-6`) are reached only when a command finishes in under 1 ms. Visible effect: a `longpress` with no duration and no native timing (Android) gets an overlay as long as the whole command, including target resolution, not the 800 ms the code names. `250` is also declared twice under two names.
- Fix: order the sources as native uptime span, then reported/explicit duration, then the per-kind default, and use wall-clock only for the event offset. Share one travel-duration constant. Files: `core/recording-values.ts`, `core/recording-timing.ts`, `core/recording-gestures.ts`, `core/recording-gesture-events.ts`.
- Effort: S
- Model: opus (changes visible overlay timing; check against a recorded run)
- Verify: new cases in `core/__tests__/recording-gestures.test.ts` and `recording-timing.test.ts`: longpress with no duration and a 3 s wall-clock span records 800 ms.

### DCORE-14: `interactionSurfaceSemanticKey` can never return `undefined`
- Category: unneeded
- Severity: low     Confidence: high
- Evidence: `packages/daemon/src/core/interaction-surface-signature.ts:383-396` — the joined array always ends with the literal `'hittable'` or `'not-hittable'`, so `semanticKey.replaceAll('|', '')` is never empty and the `: undefined` branch is dead; the guard `if (!semanticKey) return undefined;` in `buildInteractionSurfaceEntry` (lines 321-322) is dead too. The emptiness test that the sibling `interactionSurfaceIdentity` performs correctly (lines 352-358) is the one this function appears to intend.
- Fix: either compute the emptiness test before appending the hittable token (if anonymous, typeless nodes should be dropped) or delete the dead branch and guard and make the return type `string`. File: `core/interaction-surface-signature.ts`.
- Effort: S
- Model: opus (the first option changes which nodes enter stabilization signatures)
- Verify: `core/__tests__/interaction-surface-signature.test.ts`.

### DCORE-15: The device-readiness TTL cache has no invalidation
- Category: broken
- Severity: low     Confidence: low
- Evidence: `packages/daemon/src/core/device/device-ready.ts:8-27` caches "ready" per device for `DEVICE_READY_CACHE_TTL_MS = 5_000` in a module-level memo. The module exports no way to clear an entry, and nothing in the slice clears it when a session closes with `--shutdown` or a device is shut down. A sessionless command on that device within 5 s skips `ensureLocalDeviceReady`. I did not trace what the platform implementation does on a shut-down device, hence low confidence.
- Fix: export an invalidation and call it from the close/shutdown path (`PlatformResourceCleanup` seam), or key the entry on `device.booted`. Files: `core/device/device-ready.ts`, the shutdown caller in `sessions/session-lifecycle`.
- Effort: S
- Model: opus (device lifecycle)
- Verify: `core/device/device-ready.test.ts` new case; manual `close --shutdown` followed at once by a sessionless `snapshot`.

### DCORE-16: Comments that narrate history, name callers, or are orphaned (AGENTS.md comment rule)
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence:
  - `core/snapshot-runtime-binding.ts:91-92` — orphaned doc comment "A fact-conditional one-sided simple-selector observation." directly above another doc comment; its member was removed.
  - `core/session-script-writer.ts:186-203` — "extracted verbatim (no behavior change)", "maintainer-approved", and a paragraph on what "was before that change"; lines 251-281 repeat the same history.
  - `core/session-script-publication-capability.ts:77-84` — "live evidence (2026-08-02) showed it used to let ..." (see DCORE-6).
  - `core/gesture-runtime.ts:83-90,106-108` — "where the retired `requireGestureSupported` refused it", "every string the retired admission produced survives verbatim", "The retired admission THREW an `AppError`".
  - `core/session-script-publication-state.ts:163-177` (`isRecordingPublication` doc) — "This is what `SessionState.recordSession` used to store", "mirrors the previous flag exactly".
  - `core/session-replay-transaction.ts:14-33` — lists every caller module by name.
  - `core/deferred-interaction-outcome.ts:38-39,345-346` — names a removed field (see DCORE-9).
- Fix: reduce each to the standing constraint or delete it. Files as listed.
- Effort: S
- Model: sonnet
- Verify: `pnpm format` and lint only.

### DCORE-17: `PlatformOwnerLifecycle` still carries recovery phases for state left by older agent-device versions
- Category: unneeded
- Severity: low     Confidence: low
- Evidence: `packages/daemon/src/core/platform-owner-lifecycle.ts:27,40` — `recoverLegacyAppLogMarkers` ("recovers marker-only app-log sessions left by a prior daemon") with the `LegacyAppLogMarkerRecoveryOutcome` type, and `configureForDaemonLock`'s documented duty to put back "the host's own `XCTestDevices` where an older agent-device left it redirected". Both are migration paths for superseded on-disk formats. AGENTS.md: "During a migration, remove superseded paths." Low confidence: the implementations are outside this slice and I did not determine which released versions still write those formats.
- Fix: ask the owner which released versions still need these; if none, remove the two phases, the type, the startup call (`server/http/daemon-runtime.ts`), and the platform implementations.
- Effort: M
- Model: opus (startup recovery, cross-package)
- Verify: `server/http/daemon-runtime-lifecycle-*.test.ts`.
