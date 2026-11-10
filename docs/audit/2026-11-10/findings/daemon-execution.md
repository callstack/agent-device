# DEXEC audit: `packages/daemon/src/execution/` and `packages/daemon/src/resources/`

## Coverage

Slice: 225 files, ~49.9k lines. About 92 production files (~14k lines) and about 133 test/fixture files (~36k lines).

- Read fully (production, ~65% of production lines): all of `resources/` (lease-registry, lease-registry-scope, lease-in-flight-work, lease-release, provider-session-ownership, human-control-contract, macos-app-lease, artifact-tracking, app-log*, session-device-resolution, device/*). In `execution/`: request-generic-dispatch, generic-runtime-execution, generic-settle, request-dispatch-disclosure, scroll-movement, scroll-runtime, scroll-until, android-system-dialog, android-foreground-surface, android-snapshot-timeout-evidence, snapshot-timeout-evidence, screenshot-runtime, screenshot-crop, screenshot-crop-target, sparse-fallback-screenshot, selector-runtime, selector-runtime-backend, selector-capture-runtime, selector-capture-binding, session-snapshot, wait-runtime, wait-current-surface, internal-observation, and the small runtimes (apps, viewport, runtime-policy, runtime-artifacts, ref-positionals, ref-snapshot-flag-policy, type-target-warning).
- Read with comments/imports stripped (~25%): keyboard, system-button, type-text, selector-text, app-events, app-event-runtime, offscreen-target-probe, selector-match-errors, back/focus/fold/orientation/telephony/tv-remote runtimes, screenshot-runtime-binding, all four `handlers/*`, `interaction/index.ts`, and in `interaction/internal/`: interaction.ts, interaction-runtime, find, find-target-capture, find-match-resolution, find-match-ranking, interaction-gesture, interaction-touch-runtime, interaction-touch-fill, interaction-touch-press, interaction-common, interaction-touch-android-readiness, interaction-android-escape, interaction-touch-android-freshness, interaction-touch-prepare, and the tiny helpers.
- Not reached (~10% of production): `interaction/internal/` interaction-touch-response, interaction-touch-targets, interaction-touch-press-admission, interaction-touch-direct-ios, interaction-touch-payload, interaction-touch-reference-frame, interaction-ref-policy, interaction-snapshot, interaction-recorded-input, interaction-gesture-response, interaction-response-data-transform; interaction-ios-tap-outcome only lines 160-230.
- Tests: scanned heuristically only (skip/only markers, assertion density, four small tests read). No test bodies were audited in depth. No `.skip`/`.only`/`.todo` found in the slice.

Nothing was executed (no builds, tests or gates). All findings come from reading code and grepping the whole repo.

## Findings

### DEXEC-1: `type` rejects legitimate text that starts with `@el…`, `@node…`, `@ref…` or `@name9`
- Category: broken
- Severity: medium     Confidence: high
- Evidence: `packages/daemon/src/execution/type-target-warning.ts:1-11` — the body regexes `/^[A-Za-z_-]*\d[\w-]*$/` and `/^(?:ref|node|element|el)[\w-]*$/i` match `@elena`, `@eleven`, `@nodejs`, `@refund`, `@john99`. `packages/daemon/src/execution/type-text-runtime.ts:67-77` throws `INVALID_ARGS` for any of them, with no escape hatch. The same executor runs for `find … type <value>` at `interaction/internal/find.ts` (`handleFindType` → `executeBoundTypeText`), where the value is unambiguously text, and it runs after the focus tap was already dispatched. The only test is the positive `@e5` case (`execution/__tests__/type-text-runtime.test.ts:136-139`).
- Fix: match only the real ref grammar (`@e<digits>` with optional `~s<n>`; reuse `splitRefGenerationSuffix` / the kernel ref grammar). Skip the check in `handleFindType`. Add negative tests (`@elena hi`, `@john99`). Files: type-target-warning.ts, type-text-runtime.ts, find.ts.
- Effort: S
- Model: sonnet
- Verify: new unit cases in `execution/__tests__/type-text-runtime.test.ts`; `pnpm vitest run packages/daemon/src/execution/__tests__/type-text-runtime.test.ts`

### DEXEC-2: a rejected `type @e5 …` expires the ref frame, so its own hint ("Use fill @e5") cannot work
- Category: broken
- Severity: medium     Confidence: high
- Evidence: `packages/daemon/src/execution/interaction/internal/interaction.ts:163-167` calls `expireRefFrame(session)` and only then `boundTypeText(...)`. The `INVALID_ARGS` validations (mistargeted ref, "type requires text", `delay-ms` range) live inside that call (`type-text-runtime.ts:67-79`). The hint at `type-text-runtime.ts:73` tells the caller to run `fill @e5 "text"`, but ref mutations reject an expired-frame ref (`session-snapshot.ts:263-266`). Same shape in `find.ts` `handleFindType`: `expireRefFrame` precedes `executeBoundTypeText`.
- Fix: split validation from execution in `executeBoundTypeText` (parse first, return a thunk). Validate before `expireRefFrame` and before the Android dialog probe/bind. Files: type-text-runtime.ts, interaction.ts, find.ts.
- Effort: S
- Model: sonnet
- Verify: new test: session with an active frame, `type @e5 x` returns INVALID_ARGS and `refFrameState(session)` is still `active`.

### DEXEC-3: `trigger-app-event` reads the Android URL template for web/Linux/HarmonyOS and hints an env var nobody reads
- Category: inconsistent
- Severity: medium     Confidence: high
- Evidence: `packages/daemon/src/execution/app-events.ts:102-113` — any device that is not iOS-family or macOS falls into `env.AGENT_DEVICE_ANDROID_APP_EVENT_URL_TEMPLATE`. `packages/platform-web/src/runtime.ts` advertises `triggerAppEvent`, so a web session uses the Android template. The refusal hint at `app-events.ts:55` prints `AGENT_DEVICE_${platform.toUpperCase()}_APP_EVENT_URL_TEMPLATE` (for example `AGENT_DEVICE_WEB_…`), which the reader never consults. Docs (`website/docs/docs/commands.md:721`, `configuration.md:129`) list only the generic, IOS, MACOS and ANDROID variables.
- Fix: make the per-platform lookup a table keyed by `publicPlatformString(device)`; read the Android variable only for Android. Either add per-platform variables for the others or hint only the generic variable. Files: app-events.ts, app-events.test.ts, docs if variables are added.
- Effort: S
- Model: sonnet
- Verify: `app-events.test.ts` cases for a web device with only the Android variable set (expect UNSUPPORTED_OPERATION) and for hint text naming a variable that is read.

### DEXEC-4: a sessionless duration wait (`wait 500`) resolves a target device before sleeping
- Category: inefficient (and broken when no device is selectable)
- Severity: medium     Confidence: medium
- Evidence: `packages/daemon/src/execution/wait-runtime.ts:50` calls `resolveSessionDevice` unconditionally. `packages/daemon/src/core/snapshot-session.ts:23-24` runs `resolveRequestTargetDevice` (device inventory) when there is no session. The sleep branch at `wait-runtime.ts:67-77` binds nothing (`bindWaitOperations` returns `undefined` for `sleep`), and the device is used only for `platform: publicPlatformString(device)` in `selector-runtime-backend.ts:216`. A pure sleep therefore pays inventory discovery and fails with DEVICE_NOT_FOUND or an ambiguous-device error when none is selectable. Not confirmed: whether the CLI short-circuits sleeps before the daemon.
- Fix: parse first; for `kind === 'sleep'` skip device resolution (sleep in the daemon directly, or build the runtime with a placeholder platform). Files: wait-runtime.ts.
- Effort: S
- Model: sonnet
- Verify: unit test: sessionless `wait 50` with a `resolveRequestTargetDevice` spy asserts zero calls.

### DEXEC-5: Android screen recording adds a full accessibility snapshot before every generic command and every `type`, beside a second ANR detector
- Category: inefficient
- Severity: medium     Confidence: medium
- Evidence: `packages/daemon/src/execution/request-generic-dispatch.ts:291-322` (`ensureGenericCommandReady`) calls `recoverAndroidBlockingSystemDialog` whenever `session.screenRecording` is set. That function does `observation.readSnapshotNodes` (`android-system-dialog.ts:69-71`), a full UI dump, to regex for "isn't responding". The same dispatch then runs `ensureNoAndroidBlockingDialogReady` before (`:86`) and after (`:160`), which already detects the app ANR through the focused-window probe (`android-system-dialog.ts:180-223`). `interaction.ts:105-108` repeats the pattern for `type`. Each scroll/back/home/screenshot/type during recording costs one extra full snapshot plus two focus probes, and the two detectors use different evidence (English text match vs. window focus) and different recovery sequences (`recoverAndroidBlockingSystemDialog` waits for dismissal; `recoverAppOwnedAndroidBlockingSystemDialog` does not).
- Fix: gate the snapshot-based recovery on the cheap `readBlockingDialog` probe returning `dialog`, and merge the two recovery routines into one. Files: android-system-dialog.ts, request-generic-dispatch.ts, interaction.ts.
- Effort: M
- Model: opus
- Verify: `execution/__tests__/android-system-dialog*.test.ts` plus a live Android recording run per `docs/agents/device-verification.md`; count `readSnapshotNodes` calls per command in a unit test.

### DEXEC-6: listing downloadable artifacts builds a `tar czf` archive of every directory artifact
- Category: inefficient
- Severity: medium     Confidence: high
- Evidence: `packages/daemon/src/resources/artifact-tracking.ts:246-275` — `listDownloadableArtifacts` calls `prepareArtifactPayloadForInventory` for each entry, which reaches `ensureDirectoryArchive` → `createDirectoryArchive` (`:386-447`, spawns `tar` with a 15-minute timeout) only to fill `sizeBytes`/`filename`. It also uses `fs.statSync` per entry on the request path. Callers: `server/downloadable-artifact-http.ts:176` and `sessions/handlers/lease.ts:467`. An inventory GET of N directory artifacts blocks on N gzip runs and leaves N temp archives for artifacts that may never be downloaded.
- Fix: report directory artifacts in the inventory without archiving (omit `sizeBytes` or mark it lazy); archive on first download only. Use `fs.promises.stat`. Files: artifact-tracking.ts, artifact-tracking.test.ts, possibly the `DaemonArtifactInventoryEntry` contract.
- Effort: M
- Model: opus (contract change touches client)
- Verify: `resources/artifact-tracking.test.ts` — list with a directory artifact asserts `runCmd` not called.

### DEXEC-7: `alert` subaction handling disagrees between the daemon handler and the registry
- Category: inconsistent
- Severity: medium     Confidence: high
- Evidence: `packages/daemon/src/execution/handlers/snapshot-alert.ts:147-150` — `normalizeAlertAction` is case-sensitive and maps anything unknown to `'get'`. `packages/command-registry/src/descriptor-request-policy.ts:122-130` lowercases the same positional and treats anything outside `{get, wait}` as mutating. So `alert ACCEPT` or `alert acceptt` (raw daemon requests, batch steps, replay scripts) is classified `may-invalidate` and recorded as a mutation, the ref frame is expired (`snapshot-alert.ts:113-115`), and the handler performs a read instead of accepting, with no error. `keyboard` lowercases and rejects unknown actions (`keyboard-runtime.ts:50-62`).
- Fix: parse with `ALERT_ACTIONS` (lowercased); return INVALID_ARGS for an unknown subaction, as keyboard and clipboard do. Files: snapshot-alert.ts and its test.
- Effort: S
- Model: sonnet
- Verify: `handlers/__tests__/snapshot-alert.test.ts` — `alert bogus` returns INVALID_ARGS; `alert ACCEPT` calls `acceptAlert`.

### DEXEC-8: any failed `is`/`wait` on Android can be rewritten as a "foreground surface" failure, including argument errors
- Category: broken
- Severity: low     Confidence: high
- Evidence: `packages/daemon/src/execution/selector-runtime.ts:354-380` — `maybeAndroidForegroundBlockerResponse` runs for every `!response.ok` with no reason gate. It does two adb reads (`readAppFocus`, `readAppState`) and, if the launcher/settings/systemui is foreground, replaces the message with "`wait failed because … is foreground`" while keeping the original code. `wait-runtime.ts:205` passes every failure through it, including the `INVALID_ARGS` thrown inside the task by `toRefWaitTarget` (`:255-257`) and `toTextWaitTarget` (`:262-263`). An argument error is reported as a foreground blocker.
- Fix: gate on typed reasons (the `WAIT_REASONS` / selector-not-found family) the way `maybeWaitTimeoutSurfaceResponse` does at `wait-current-surface.ts:66-68`; never decorate `INVALID_ARGS`. Files: selector-runtime.ts, wait-runtime.ts.
- Effort: S
- Model: sonnet
- Verify: unit test: Android session, launcher foreground, `wait @e1` without a snapshot keeps the original INVALID_ARGS message and makes no observation calls.

### DEXEC-9: a failed `screenshot <path> --crop-on` leaves the uncropped full-frame image at the caller's path
- Category: broken
- Severity: low     Confidence: high
- Evidence: `packages/daemon/src/execution/screenshot-runtime.ts:380-413` writes the capture to `outPath`, then runs `assertScreenshotCropCapture` and `cropScreenshotToSelector`, which throw for not-found, ambiguous, sparse or empty-intersection targets (`screenshot-crop.ts:69-93,116-139`). The command surface calls `reserved.cleanup?.()` on failure (`packages/command-runtime/src/commands/capture/runtime/screenshot.ts:60-61`), but the daemon adapter supplies `cleanup` only for minted temp paths (`screenshot-runtime.ts:438-444`). With an explicit path, the failed command leaves or overwrites a file that is not the requested crop.
- Fix: capture to a temp file when a crop is bound and move it to `outPath` only after the crop succeeds, or unlink `outPath` on crop failure. Files: screenshot-runtime.ts.
- Effort: S
- Model: sonnet
- Verify: `execution/screenshot-runtime-execution.test.ts` — crop target not found leaves no file at `outPath`.

### DEXEC-10: `react-native dismiss-overlay` loses the dispatched tap when the verification capture throws, and reports `dismissed: true` while the overlay is still detected
- Category: broken
- Severity: low     Confidence: medium
- Evidence: `packages/daemon/src/execution/handlers/react-native.ts:165-168` — after `tapPoint(...)`, `verifyReactNativeOverlayDismissal` runs a capture. A throw there reaches the outer `catch` at `:84-86` and returns an error response without `finalizeTouchInteraction`, so the mutation is neither recorded nor marked for deferred outcome. Separately, `:179-181` always sets `dismissed: true`, even when `verified: false` because the overlay "is still detected after dismissal" (`:226-231`).
- Fix: wrap verification in its own try/catch that degrades to `verified: false` with a warning. Derive `dismissed` from the verification result, or rename it to `dismissActionSent`. Files: react-native.ts, `handlers/__tests__/react-native.test.ts`.
- Effort: S
- Model: sonnet
- Verify: test with a capture that throws on the second call asserts `recordAction` was called and the response is ok with `verified: false`.

### DEXEC-11: several commands validate arguments only after binding the device or after Android dialog work
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence: the stated convention is "an invalid command is rejected before any device work" (`scroll-runtime.ts:98-102`), which fold, tv-remote, orientation, focus and viewport follow. Exceptions:
  - `type-text-runtime.ts:67-79` — validation inside the bound executor.
  - `app-event-runtime.ts:38-39` — `parseTriggerAppEventArgs` / `resolveAppEventUrl` run in `execute`, after `admitRuntimeUse`.
  - `handlers/session-clipboard.ts:77-79,90-92` — arity checks after bind.
  - `interaction/internal/interaction-gesture.ts` `dispatchGestureInteraction` — runs `ensureAndroidBlockingSystemDialogReady`, which can tap "Close app" and relaunch the app, before `readGesturePayload` / `readSwipeInput` validate.
  - `wait-runtime.ts:54-60` — binds before the ref-suffix parse in `normalizeWaitPositionals`.
  - `handlers/snapshot-alert.ts:123` — `alertWaitTimeoutMs` throws after bind.
- Fix: hoist the parse of each into its `resolveBound*` step (parse, then admit, then return a thunk). Files: the six above.
- Effort: M
- Model: sonnet
- Verify: per-command unit test asserting `bindDevice` and observation spies have zero calls on INVALID_ARGS.

### DEXEC-12: Android snapshot-timeout evidence leaves a temp directory per timeout
- Category: broken (resource leak)
- Severity: low     Confidence: high
- Evidence: `packages/daemon/src/execution/android-snapshot-timeout-evidence.ts:84-87` creates `agent-device-android-snapshot-timeout-*` with `fs.mkdtemp`. On success the PNG path is returned in error details and nothing tracks or expires it (it is not registered with `trackDownloadableArtifact`, so a remote client cannot fetch it either). On capture failure the `catch` at `:118-126` returns `snapshotTimeoutCaptureFailed` without removing the directory.
- Fix: remove the directory in the failure path. Register the success artifact with artifact tracking (which gives a 15-minute TTL and remote download) or write under the session state dir. Files: android-snapshot-timeout-evidence.ts, caller `sessions/snapshot-command-runtime.ts`.
- Effort: S
- Model: sonnet
- Verify: unit test with a throwing `captureScreenshot` asserts the temp dir no longer exists.

### DEXEC-13: Android dialog recovery polls ignore request cancellation
- Category: broken
- Severity: low     Confidence: high
- Evidence: `packages/daemon/src/execution/android-system-dialog.ts:389-417` — `waitForBlockingDialogToDismiss` and `waitForAndroidAppFocus` each loop 12 × `sleep(500)` with no `AbortSignal`, and the entry points take none. A cancelled request can keep driving the device (snapshots, `openApp`) for up to about 13 s. Other loops in the slice pass `signal` to `sleep` (`scroll-runtime.ts:426`, `interaction-gesture.ts` `runGestureRepetitions`).
- Fix: thread the request signal (`getRequestSignal(requestId)`) into both entry points and into `sleep`. Files: android-system-dialog.ts and its three callers.
- Effort: S
- Model: sonnet
- Verify: unit test aborts the signal mid-poll and asserts no further `readSnapshotNodes` calls.

### DEXEC-14: `putHostLease` breaks the "issued lease id is never reused" invariant and marks a tenant before validation
- Category: inconsistent
- Severity: low     Confidence: medium
- Evidence: `packages/daemon/src/resources/lease-registry.ts:52-56` documents that an issued id "must never name one again", enforced in `allocateLease` at `:90-94`. `putHostLease` (`:110-138`) never consults `issuedLeaseIds`, so a host PUT after the lease expired or was released re-issues the same id. This may be the intended host re-pin flow, but then the comment is wrong. Separately, `:127` adds to `macOsAppTenantIds` before the run-binding and capacity checks at `:128-133` can throw. A refused allocation therefore permanently flips `hasHeldMacOsAppLease` and denies that tenant request diagnostics (`macos-app-lease.ts:435-441`), although "ever allocated" is the documented meaning (`lease-registry.ts:312`).
- Fix: move the `macOsAppTenantIds.add` after `issueLease`. Either enforce `issuedLeaseIds` in `putHostLease` or document the host exception on the field. Files: lease-registry.ts, lease-registry.test.ts.
- Effort: S
- Model: opus (lease semantics)
- Verify: `resources/__tests__/lease-registry.test.ts` — refused `putHostLease` leaves `hasHeldMacOsAppLease` false.

### DEXEC-15: the Android "tap escaped the app" failure is recognised by the shape of its details, not a typed reason
- Category: inconsistent (AGENTS.md: typed reasons)
- Severity: low     Confidence: high
- Evidence: `packages/daemon/src/execution/interaction/internal/interaction-android-escape.ts:24-37` — the thrown `AppError` carries the raw `AndroidEscapeSurface` as details with no `reason`. `isAndroidEscapeError` tests `typeof details.expectedPackage === 'string' && typeof details.foregroundPackage === 'string'`. `selector-runtime.ts:370-379` spreads the same surface object into unrelated `is`/`wait` failures, so the shape is not unique to the escape error. `interaction-touch-runtime.ts` (`if (isAndroidEscapeError(appError)) throw appError`) branches on it.
- Fix: add an `INTERACTION_ERROR_REASONS` entry (for example `android_tap_escaped_app`) and test `details.reason`. Files: interaction-android-escape.ts, the reason table in contracts, tests.
- Effort: S
- Model: sonnet
- Verify: `interaction-touch-android-readiness.test.ts` asserts `details.reason`.

### DEXEC-16: duplicate and pass-through helpers
- Category: unneeded
- Severity: low     Confidence: high
- Evidence:
  - `interaction/internal/interaction-response.ts:3-16` `interactionErrorResponse` re-implements kernel `errorResponse` (used across the same directory); only two callers (`interaction-flags.ts:14`, `interaction-ref-policy.ts:17`).
  - `internal-observation.ts:138-148` `normalizeRefBodies` re-implements `session-snapshot.ts:81-85` `normalizeRefBody`; both hand-roll what `splitRefGenerationSuffix` (kernel) parses.
  - `screenshot-runtime.ts:181-185` `screenshotExecutionFromContext` is a pure alias of `runtimeExecutionFromContext`, kept, per its own comment, to "preserve this module's callers" (3 call sites).
  - `resources/lease-registry-scope.ts:72-88` `LeaseScopeMatchRequest` and `NormalizedLeaseScopeMatchRequest` are identical types.
  - `android-system-dialog.ts:331-336,424-431,385-387` `readAndroidSnapshotNodes`, `isAndroidAppFocused`, `isTouchableDialogNode` are one-line pass-throughs.
  - `execution/apps-runtime.ts` (two one-line wrappers, 2 callers) and `resources/app-log-start-preflight.ts` (one wrapper, 1 production caller) add a file each for a single forwarded call.
  - `request-generic-dispatch.ts:245` and `generic-settle.ts:85` both check `commandSupportsSettleObservation`.
- Fix: delete the wrappers and call the owner directly; reuse `normalizeRefBody` (export it) or `splitRefGenerationSuffix`. Move Fallow baseline entries if files are removed.
- Effort: S
- Model: sonnet
- Verify: `pnpm check:affected --run` (lead runs it).

### DEXEC-17: migration-history comments throughout the slice
- Category: unneeded (AGENTS.md: comments only for public APIs, tool directives, or constraints code cannot show)
- Severity: low     Confidence: high
- Evidence: `rg -c "retired|\bR[0-9]{2}\b"` over production files in the slice gives 53 lines in 24 files. Examples: `scroll-runtime.ts:101,174,215,430` ("as the retired leaf had them"), `generic-runtime-execution.ts:25-29` ("R58 retired the last legacy dispatcher"), `selector-runtime-backend.ts:139-148`, `handlers/session-clipboard.ts:51-52,69,107`, `keyboard-runtime.ts:49`, `orientation-runtime.ts:22`, `tv-remote-runtime.ts:17`, `focus-runtime.ts:15` ("still-legacy touch siblings"), `request-generic-dispatch.ts:296-300`. They describe code that no longer exists and refactor step ids with no referent in the repo.
- Fix: delete or reduce to the invariant (for example "admission happens in resolveGenericRuntimeExecution").
- Effort: S
- Model: sonnet
- Verify: `pnpm format` and `rg -c "retired" packages/daemon/src/execution` reduced.

### DEXEC-18: best-effort paths swallow errors with bare `catch` and emit no diagnostic
- Category: broken (undebuggable degradations)
- Severity: low     Confidence: medium
- Evidence: `generic-settle.ts:170-172` (`createGenericSettleRuntime` → `undefined`, so `--settle` silently returns no observation), `sparse-fallback-screenshot.ts:108-113`, `scroll-movement.ts:459-463` (`captureSurface`), `selector-runtime.ts:366-368`, `wait-current-surface.ts:80` (`.catch(() => null)`), `selector-capture-runtime.ts:185-187`, `offscreen-target-probe.ts:36-38`. Sibling degradations in the same files do log (`scroll_movement_unobserved`, `android_ref_snapshot_refresh_failed`), so these failures are invisible in the request diagnostics that the rest of the slice relies on.
- Fix: emit a `debug`/`warn` `emitDiagnostic` with a phase name in each catch. No behavior change.
- Effort: S
- Model: sonnet
- Verify: unit tests assert the diagnostic phase on a thrown capture.

### DEXEC-19: directional scroll analyses the same trees for the scroll edge up to four times per command
- Category: inefficient
- Severity: low     Confidence: medium
- Evidence: `scroll-runtime.ts:150-154` → `readScrollTargetContainer` runs `readScrollEdgeState` on the stored tree (`scroll-movement.ts:199`). `baselineEndsInDirection` runs it again on the same baseline nodes with a point (`:378`). `claimMoved` (`:491-493`) or `decideEdgeVerdict` (`:568`) runs it on the observed tree. `planScrollMovement` and `readScrollTargetContainer` each recompute `storedSurfaceStaleness`. Each call is a whole-tree pass on the scroll hot path. The cost of `readScrollEdgeState` was not measured.
- Fix: compute the baseline edge state once in `planScrollMovement` and carry `containerRect` / `canScroll` on `ScrollSurfaceBaseline` (the pointed variant still needs one pass when the midpoint is known). Files: scroll-movement.ts, scroll-runtime.ts.
- Effort: M
- Model: opus (evidence semantics are subtle)
- Verify: `execution/__tests__/scroll-movement.test.ts`, `scroll-runtime.test.ts`.

### DEXEC-20: `session-snapshot.ts` claims a single write choke point but has three writers with different invariants
- Category: inconsistent
- Severity: low     Confidence: low
- Evidence: `packages/daemon/src/execution/session-snapshot.ts:19-27` calls `setSessionSnapshot` "the single daemon-side write choke point". `setCommandSnapshot` (`:47-64`) writes the same fields with its own generation rule, and `clearSessionSnapshot` (`:42-44`, one caller: `sessions/session-lifecycle/internal/session-open-state.ts:56`) sets only `snapshot = undefined`, leaving `snapshotScopeSource`, `lastComparisonSafeSnapshot` and `snapshotGeneration` from the previous app. Whether the retained fields are read after a re-open was not traced.
- Fix: decide the invariant; have `clearSessionSnapshot` also clear `snapshotScopeSource` (and `lastComparisonSafeSnapshot` if it must not survive an app switch), and correct the comment.
- Effort: S
- Model: opus (needs tracing of `lastComparisonSafeSnapshot` consumers)
- Verify: `execution/__tests__/session-snapshot.test.ts` plus session-open tests.
