# Audit report: SLICE ANDR — `packages/platform-android/` + native `android/`

## Coverage

Read-only audit; no gates, builds, or tests were run. All findings come from reading code and grep.

- **Read fully (production):** `android/ime-helper` Java (100%); `android/snapshot-helper` main Java ~75% (`SnapshotInstrumentation`, `HelperProtocol`, `SessionResponseWriter`, `AutomationCommandHandler`, `AccessibilityTreeCapture`, `TouchCommandHandler`, `ApplicationCommandHandler`, `TouchPlan`, `TouchPlanInjector`, `GestureViewportReader`, `BoundedUiAutomationConnection`, `AccessibilityCaptureStabilizer`, most of `AccessibilityReadBatch`; escaper of `AccessibilityTreeXml`). TS: `snapshot.ts`, `snapshot-helper-session-protocol.ts`, `snapshot-helper-session.ts`, `snapshot-helper-session-lifecycle.ts`, `snapshot-helper-capture.ts` (to line 375), `snapshot-helper-install.ts`, `snapshot-helper-types.ts`, `helper-package-install.ts`, `automation-helper.ts`, `automation-helper-artifact.ts`, `touch-helper.ts`, `input-actions.ts`, `text-input.ts`, `ime-helper.ts`, `app-lifecycle.ts`, `app-state.ts`, `screenshot.ts`, `adb.ts`, `adb-executor.ts`, `adb-provider-scope.ts`, `adb-host.ts`, `adb-shell-protocol.ts`, `adb-transfer.ts`, `adb-port-reverse.ts`, `emulator-lifecycle.ts`, `emulator-console.ts`, `device-boot.ts`.
- **Skimmed / partial:** `adb-transport.ts` (types + grammar head), `ui-hierarchy.ts` (tokenizer/parser), `snapshot-content-recovery.ts` (entry + summarizer), `window-state.ts` (dump reader + foreground parse), `device-input-state.ts` (first 220 lines), `instrumentation-helper.ts` (output assembler), `perf-native-*.ts` (shell-fragment builders only), `snapshot-helper-retirement.ts` (one function), `observation.ts` (adapter), `fill-verification.ts` (grep only), remaining native classes (`PointerEventSchedule`, `DisplayExtent`, `AccessibilityNodeReads`, `UiAutomationInputDispatcher`, rest of `AccessibilityTreeXml`), both READMEs (grep only).
- **Not reached:** `recording/`, `logs/`, `network/`, `telephony/`, `deployment/`, `readiness/`, `shutdown/`, `foldable/`, `perf/`, `runtime.ts`, `lifecycle.ts`, `mechanics.ts`, `index.ts`, `settings*.ts`, `manifest.ts`, `inventory*.ts`, `doctor.ts`, `alert*.ts`, `ui-hierarchy-builder.ts`, `snapshot-presentation*.ts`, `ime-lifecycle/restore/rebind/activation/state/settings-record`, `logcat.ts`, `notifications.ts`, `permission-grant-state.ts`, `sdk.ts`, Gradle/build scripts, native unit tests, and nearly all TS tests (only a mechanical "tests with fewer assertions than cases" scan plus one file opened; nothing found).
- **Rough share of slice read closely:** ~25% of production TS lines, ~80% of native Java. Shell-quoting was checked slice-wide by grepping every `shellFragment(` use (6 sites, all quote interpolated values with `shellQuote` or interpolate constants) — no injection finding. All other `adb shell` argv goes through `deviceShellArgv`, enforced by `assertDeviceShellArgv` guards.

## Findings

### ANDR-1: `input text` fallback silently turns a literal `%s` in user text into a space
- Category: broken
- Severity: medium     Confidence: high
- Evidence: `packages/platform-android/src/text-input.ts:544-547` — `encodeAndroidInputText` only does `text.replaceAll(' ', '%s')`; `:532-542` admits `%` (0x25) as supported shell text; `:586-594` chunks purely by code-point count. Android's `input text` rewrites every `%s` to a space and has no escape for a literal one, so typing `100%sure` yields `100 ure`. The existing test `__tests__/text-input.test.ts:60` (`'50%%scomp'`) only covers `%` followed by an encoded space. `typeAndroid` (`:57-84`) has no post-write verification, so the corruption is silent; `fillAndroid` would surface it only as an unconfirmed fill.
- Fix: in `chunkAndroidInputText` (or a step planner wrapper) force a chunk boundary between a literal `%` and a following `s`, so the two never share one `input text` argument. Add a regression test with `%s`, `%%s`, and `%` at a chunk edge. Files: `text-input.ts`, `__tests__/text-input.test.ts`.
- Effort: S
- Model: sonnet
- Verify: new unit test asserting the argv sequence for `typeAndroid(device, 'a%sb')` never contains `%s` except as an encoded space; manual `agent-device type '100%sure'` on an emulator without the test IME.

### ANDR-2: Test-IME text entry reports success when the IME committed nothing (or truncated)
- Category: broken
- Severity: medium     Confidence: high (code path) / medium (how often it bites)
- Evidence: `android/ime-helper/src/main/java/com/callstack/agentdevice/imehelper/TestInputMethodService.java` `handleAction` returns silently on protocol mismatch and on `getCurrentInputConnection() == null`; `decodeBase64Text` drops payloads over `MAX_TEXT_LENGTH * 2` base64 chars; `commitValidatedText` truncates at 32,000 chars — all only `Log.w`. The receiver never sets a broadcast result. Host: `packages/platform-android/src/ime-helper.ts:197-222` checks only the `am broadcast` exit code, which is 0 in every one of those cases. `text-input.ts:70-73,278-294` (`typeAndroid` → `typeAndroidImeHelper`) does no verification and, with `delayMs === 0`, sends the whole text as one broadcast (`planAndroidTextSteps(text, Infinity, …)`), so large non-ASCII text (≈16k CJK chars → >64k base64) is dropped entirely with a success result.
- Fix: have the receiver report an outcome through the ordered-broadcast result (`setResultCode`/`setResultData` with committed length or a reason) and have `sendAndroidImeHelperBroadcast` parse `Broadcast completed: result=…, data=…` into a typed failure; chunk host-side below the native limit. Files: `TestInputMethodService.java`, `ime-helper.ts`, `text-input.ts`, IME helper version bump + README.
- Effort: M
- Model: opus (native/host protocol change, device behavior)
- Verify: unit test for the result parser; on device, `type` with no focused field must fail instead of returning success.

### ANDR-3: Persistent helper session listens on an unauthenticated device-loopback TCP port, with no read timeout
- Category: broken
- Severity: medium     Confidence: medium
- Evidence: `android/snapshot-helper/.../SnapshotInstrumentation.java:181-248` — `new ServerSocket(sessionPort, 1, 127.0.0.1)` accepts any local connection and executes `input` (tap/key/set-text), `screenshot`, `app` (shell `am start`), `gesture` with no token. Any app on the device holding `INTERNET` can drive UiAutomation while a session is warm. The IME helper explicitly gates senders (`TestInputMethodService.java`, `REQUIRED_SENDER_PERMISSION` comment), so the two helpers disagree on trust model. Separately, the loop is single-threaded and calls `readLine()` with no `setSoTimeout`: one connected-but-silent client blocks every later request until the host times out, and a timeout on a reused session permanently disables the persistent transport for that identity (`snapshot-helper-session-lifecycle.ts:276-283`, `failedSessions().set(identity, Number.POSITIVE_INFINITY)`).
- Fix: generate a random session token host-side, pass it as `-e sessionToken`, require it as the first word of every session command; add `socket.setSoTimeout(...)` on accepted sockets. Files: `SnapshotInstrumentation.java`, `snapshot-helper-session-lifecycle.ts`, `snapshot-helper-session-protocol.ts`, `snapshot-helper-session.ts`, README, helper version bump.
- Effort: M
- Model: opus
- Verify: native unit/instrumentation check that a command without the token is rejected; existing `snapshot-helper-session*.test.ts` updated; manual `adb shell nc 127.0.0.1 <port>` while a session is warm.

### ANDR-4: Two disagreeing "foreground app" readers; the runtime `appState` operation uses the one that always pays a dump that cannot answer on Android 16
- Category: inconsistent
- Severity: medium     Confidence: high (duplication) / medium (result divergence)
- Evidence: `packages/platform-android/src/app-state.ts:5-43` — fixed order `dumpsys window windows` → `dumpsys window` → `dumpsys activity activities` → `dumpsys activity`, marker-priority parse via `parseAndroidFocusSegment`. `window-state.ts:138-147,250-261` — `getAndroidAppState` uses adaptive `orderAndroidWindowDumps` plus document-order `parseLegacyAndroidForegroundApp`; its own comment (`window-state.ts:81-84`) says asking `dumpsys window windows` first on Android 16 "costs a ~50 KB transfer that structurally cannot answer". `runtime.ts:462` and `index.ts:43-47` (→ `src/platform-runtime.ts:73`) still call the `app-state.ts` reader; `app-lifecycle.ts:782` and `open-target-resolution.ts:43` call the other. The component regex is duplicated verbatim (`app-state.ts:50`, `window-state.ts:253`).
- Fix: make `readAndroidAppStateWithExecutor` a thin adapter over the `window-state.ts` reader (executor-injected) and delete the second parse/ordering. Files: `app-state.ts`, `window-state.ts`, `runtime.ts`, `app-state.test.ts`.
- Effort: M
- Model: opus (device behavior across API levels)
- Verify: `app-state.test.ts` + `__tests__/window-state.test.ts` run against the shared implementation; adb call-count assertion for an Android-16-shaped fixture.

### ANDR-5: `open <package>` fails with a warm helper session where the adb path would fall back
- Category: inconsistent
- Severity: medium     Confidence: medium
- Evidence: `packages/platform-android/src/app-lifecycle.ts:252-269` — when the helper answers `component-unavailable` and the package is installed, `stdout` is `''`, so neither `Status: ok` nor the dispatched-timeout branch matches and the code throws `Android helper could not launch the application`. Nothing was dispatched in that case (`ApplicationCommandHandler.java` `open` returns before `am start`). The adb path (`:413-457`) instead tries `am start … -p` and then `resolveAndroidLaunchComponent` with `includeFallbackCategories: true` (`:554-584`). The same command therefore succeeds cold and fails warm for packages whose launcher is not resolvable under `LAUNCHER` alone.
- Fix: return `undefined` from `tryAndroidHelperLaunch` for `component-unavailable` when the package is installed, so `startAndroidApp` continues to the adb path. Files: `app-lifecycle.ts`, `__tests__/app-lifecycle-open.test.ts`.
- Effort: S
- Model: sonnet
- Verify: new test in `app-lifecycle-open.test.ts`: helper returns `componentUnavailable=true`, `pm path` succeeds → adb `am start` is issued.

### ANDR-6: A helper-reported, non-dispatched failure tears down the warm session
- Category: inefficient
- Severity: medium     Confidence: medium
- Evidence: `packages/platform-android/src/automation-helper.ts:91-106` — for any error that is non-mutating or `dispatched === 'no'`, it calls `stopAndroidSnapshotHelperSession(deviceKey)` before falling back. Transport failures are already retired inside `runAndroidSnapshotHelperSessionTouchCommand` (`snapshot-helper-session.ts:158-166`); what reaches line 97 with a live session is a healthy helper answering `ok=false` — e.g. `No editable field at the fill point` / `Multiple editable fields…` with `injected=false` (`AutomationCommandHandler.java` `fill`), or a `screenshot`/`focus` refusal. The next snapshot/tap then pays a full `am instrument` start plus UiAutomation connect. Fill on a point the helper cannot resolve is a normal fallback trigger, so this turns each such fill into a session restart.
- Fix: stop the session only when the failure is not a well-formed helper answer (distinguish via a typed detail set where `headers.ok !== 'true'` at `snapshot-helper-session.ts:167-177`). Files: `automation-helper.ts`, `snapshot-helper-session.ts`, `automation-helper*.test.ts`.
- Effort: S
- Model: opus (session lifecycle semantics; confirm the stop is not load-bearing for a wedged UiAutomation)
- Verify: `automation-helper-fallback.test.ts` case asserting no `quit` is sent after an `injected=false` answer.

### ANDR-7: Every snapshot tokenizes and attribute-parses the helper XML twice, and builds the hierarchy twice for interactive snapshots
- Category: inefficient
- Severity: medium     Confidence: high
- Evidence: `packages/platform-android/src/snapshot.ts:621` → `classifyAndroidHelperContent` → `snapshot-content-recovery.ts:210-221` iterates `androidUiNodes(xml)` (`ui-hierarchy.ts:91-106`: regex tokenization + full `readAndroidUiNodeMetadata` per node). Then `snapshot.ts:155` runs `parseUiHierarchyTree(xml)` (`ui-hierarchy.ts:281-309`), the same tokenizer and the same per-node attribute parse. For `interactiveOnly` snapshots without scroll attributes, `snapshot.ts:289-292` additionally rebuilds the full (non-interactive) snapshot just to derive hidden-content hints. Trees go up to 5,000 nodes and this runs on every snapshot, wait poll, and fill verification (`fill-verification.ts:64` adds a third `androidUiNodes` pass).
- Fix: parse once into the tree and derive the content-recovery summary by walking it (or by a single streaming pass that feeds both). Files: `snapshot.ts`, `snapshot-content-recovery.ts`, `ui-hierarchy.ts`.
- Effort: M
- Model: opus
- Verify: existing `__tests__/snapshot-content-recovery.test.ts` and `snapshot.test.ts` unchanged and green; a micro-benchmark on `fixtures/android-qs-shade-capture.raw.json`.

### ANDR-8: Helper artifact is re-resolved from disk on every command, by two different resolvers
- Category: inefficient
- Severity: medium     Confidence: high
- Evidence: `packages/platform-android/src/snapshot.ts:816-849` (`access` + `readText` + `JSON.parse` + `access`, returns `{}`/`errorReason`, surfaces `COMMAND_FAILED`) and `helper-package-install.ts:160-185` via `automation-helper-artifact.ts:92-107` (`readText` + `JSON.parse` + `access`, throws `UNSUPPORTED_OPERATION`). Neither memoizes. `prepareAndroidAutomationHelper` (`automation-helper-artifact.ts:47-90`) runs on every tap/key/fill/screenshot/focus (`automation-helper.ts:63`) and twice per scroll (`touch-helper.ts:62,127`); `captureAndroidUiHierarchy` runs the other resolver on every snapshot (`snapshot.ts:306-312`). Same artifact, two code paths, two error contracts.
- Fix: one resolver, memoized per (project root, version) for the process lifetime; `snapshot.ts` uses it and maps the failure. Files: `snapshot.ts`, `helper-package-install.ts`, `automation-helper-artifact.ts`.
- Effort: S
- Model: sonnet
- Verify: unit test counting `files.readText` calls across two captures; `__tests__/snapshot-helper-install.test.ts`, `automation-helper*.test.ts`.

### ANDR-9: Two helper-install pipelines with different caching, recovery, and version parsing
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence: Snapshot helper — `snapshot-helper-install.ts:77-190`: `Map` cache, zero adb on a cache hit (`:103-112`), uninstall-and-retry on `INSTALL_FAILED_UPDATE_INCOMPATIBLE` (`:238-279`), its own `readInstalledVersionCode`/`parsePackageListVersionCode` (`:217-236,281-…`). IME helper — `helper-package-install.ts:43-121`: `Set` cache that still spawns `cmd package list packages --show-versioncode` on every hit (`:68-71`), no signature-mismatch recovery (`:101-113` throws), a second regex parser for the same output (`:219-234`) with a different timeout (5 s fixed vs caller's 30 s). An IME helper installed with a different signing key cannot self-heal while the snapshot helper can.
- Fix: one `ensureAndroidHelperPackageInstalled` used by both (policy + recovery as options), one version-code reader. Files: `snapshot-helper-install.ts`, `helper-package-install.ts`, `ime-helper.ts`.
- Effort: M
- Model: opus
- Verify: `__tests__/snapshot-helper-install.test.ts`, `__tests__/ime-helper.test.ts`, plus a new IME case for `INSTALL_FAILED_UPDATE_INCOMPATIBLE`.

### ANDR-10: `readScreenSize` ignores `wm size` overrides and rotation; a second copy exists only for tests
- Category: broken
- Severity: low     Confidence: medium
- Evidence: `packages/platform-android/src/observation.ts:74-79` matches only `Physical size:` from `wm size`, which is the natural-orientation panel size and ignores an `Override size:` line. Its consumer `packages/daemon/src/execution/interaction/internal/interaction-touch-reference-frame.ts:47-51` caches the result as the recording's touch reference frame, so landscape or size-overridden recordings get a frame with swapped/wrong extents. `input-actions.ts:424-431` (`getAndroidScreenSize`) is a byte-for-byte duplicate whose only non-test references are the `mechanics.ts:181` re-export and daemon test fixtures.
- Fix: prefer `Override size` when present and swap by the already-available rotation probe (or use the helper's `displayWidth/Height` metadata); delete `getAndroidScreenSize` and point the fixtures at the observation adapter. Files: `observation.ts`, `input-actions.ts`, `mechanics.ts`, daemon test support.
- Effort: S
- Model: opus (device behavior)
- Verify: `observation.test.ts` cases for override and landscape output.

### ANDR-11: Session acquisition has no single-flight per device, and a forward can leak before the `try`
- Category: broken
- Severity: low     Confidence: low
- Evidence: `packages/platform-android/src/snapshot-helper-session-lifecycle.ts:168-178` — `sessions().get(deviceKey) ?? (await tryStartAndroidSnapshotHelperSession(params))` with awaits before the `sessions().set` at `:357`; two overlapping acquisitions for one device both run `am instrument` (the second force-stops the first) and the later `set` overwrites the earlier entry, orphaning its adb child and `adb forward`. Nothing in the slice serializes this (grep for locks finds only `ime-state.ts:216` and `adb-port-reverse.ts:54`). The daemon has request locks (`packages/daemon/src/server/request-execution-locks.ts`), which I did not verify cover device-scoped `command` captures from different sessions — hence low confidence. Also `:314-327`: `adb forward` succeeds, then `spawn(...)`/`recordInstrumentationProcess` run outside the `try`, so a synchronous throw leaves the forward in place.
- Fix: wrap acquire/start/stop in `withKeyedLock` keyed by `deviceKey`; move the spawn inside the `try`. Files: `snapshot-helper-session-lifecycle.ts`.
- Effort: M
- Model: opus (concurrency)
- Verify: new test in `__tests__/snapshot-helper-session-lifecycle.test.ts` issuing two concurrent `acquireAndroidSnapshotHelperSession` calls and asserting one spawn.

### ANDR-12: Port-reverse manager is rebuilt per call, so its ownership tracking and dedupe never apply to localhost opens
- Category: broken
- Severity: low     Confidence: high
- Evidence: `packages/platform-android/src/app-lifecycle.ts:119` — `createAndroidPortReverseManager(resolveAndroidAdbProvider(device))`. For a local device `resolveAndroidAdbProvider` builds a new provider each call (`adb-provider-scope.ts:252-265,277-288`) with a fresh `createExecAndroidPortReverseProvider` (`bound` map) and is re-spread by `guardProviderDeviceShell`, so `managedAndroidPortReverseProviders.has(...)` is false and a new manager with an empty `active` map is created (`adb-port-reverse.ts:44-51`). Consequences: the "already mapped → skip" branch (`:63-65`) and owner-conflict check (`:56-62`) are unreachable from this site, every `open http://localhost:PORT` spawns `adb reverse`, and nothing in the repo ever removes the `localhost-url` owner's mappings on local devices (only `provider-limrun` calls `removeAllOwned`).
- Fix: keep one manager per device serial in a runtime slot (or drop the manager here and call the exec provider directly, and state that the mapping is intentionally left in place). Files: `app-lifecycle.ts`, `adb-port-reverse.ts`.
- Effort: S
- Model: sonnet
- Verify: `adb-port-reverse.test.ts` / `app-lifecycle-open.test.ts` asserting one `reverse` call across two opens of the same localhost URL.

### ANDR-13: Boot failure classification matches the module's own error message text
- Category: inconsistent (AGENTS.md: typed reasons, not error text)
- Severity: low     Confidence: high
- Evidence: `packages/platform-android/src/emulator-lifecycle.ts:127-129` — `appError.message === 'Android device is still booting'` decides `ANDROID_BOOT_TIMEOUT`; the message is produced at `:59`. `:46` also stuffs `message: 'timeout'` into details for a downstream classifier.
- Fix: put a typed `reason` on the error thrown at `:59` (and `:42`) and branch on it. Files: `emulator-lifecycle.ts`.
- Effort: S
- Model: sonnet
- Verify: existing boot tests (`lifecycle.test.ts` / readiness tests) still green; grep shows no message comparison.

### ANDR-14: Dead native protocol surface the host never uses
- Category: unneeded
- Severity: low     Confidence: high
- Evidence: `SnapshotInstrumentation.java:55,88,288-300` — `outputPath` argument and `writeOutputFile`; no host code sends `outputPath` (`buildAndroidSnapshotHelperArgs`, `snapshot-helper-capture.ts:220-247`; repo-wide grep finds no helper-related use). `TestInputMethodService.java` `ACTION_INPUT_TEXT` (plain-text action) is registered and handled, but the host defines and sends only `ACTION_INPUT_TEXT_B64` and `ACTION_CLEAR_TEXT` (`ime-helper.ts:36-37`); it survives only in `android/ime-helper/README.md:73`. Both widen the on-device attack/maintenance surface (the first lets an instrumentation caller write a file to an arbitrary path the helper can reach).
- Fix: remove both and their README sections; bump helper versions. Files: `SnapshotInstrumentation.java`, `TestInputMethodService.java`, both READMEs.
- Effort: S
- Model: sonnet
- Verify: helper builds; `grep -rn "outputPath\|ACTION_INPUT_TEXT\b" android packages/platform-android/src` returns only the B64 action.

### ANDR-15: Helper timeout/limit constants drift between constants, defaults, native code, and diagnostics
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence: `snapshot-helper-types.ts` declares `ANDROID_SNAPSHOT_HELPER_CAPTURE_TIMEOUT_MS = 5_000`, while `snapshot-helper-capture.ts:189,205,209` default to literal `8_000` / `128` / `5_000`, duplicated again as `DEFAULT_TIMEOUT_MS = 8_000`, `DEFAULT_MAX_DEPTH`, `DEFAULT_MAX_NODES` in `SnapshotInstrumentation.java:29-33` (unreachable from the host, which always passes them). `snapshot.ts:500` reports `timeoutMs: ANDROID_SNAPSHOT_HELPER_CAPTURE_TIMEOUT_MS` (5000) for persistent-session captures that actually run with `Math.min(timeoutMs, SESSION_CAPTURE_TIMEOUT_MS = 2_000)` (`snapshot-helper-session-lifecycle.ts:63,444`), so the diagnostic misstates the budget.
- Fix: export the defaults once from `snapshot-helper-types.ts`, use them in `resolveAndroidSnapshotHelperCaptureOptions`, and report the resolved session timeout in the diagnostic. Files: `snapshot-helper-types.ts`, `snapshot-helper-capture.ts`, `snapshot.ts`.
- Effort: S
- Model: sonnet
- Verify: `__tests__/snapshot-helper-capture.test.ts`; diagnostic assertion in `snapshot-helper-session.test.ts`.

### ANDR-16: Host port round-trips into the package's own module for helper artifact/installation
- Category: unneeded
- Severity: low     Confidence: high
- Evidence: `packages/platform-android/src/adb-host.ts:85-100` declares `resolveHelperArtifact` and `ensureHelperInstalled` on `AndroidAdbHost`; the only implementation, `src/platform-runtime-android-adb-host.ts:138-146`, dynamically imports `platform-android`'s own `helper-package-install.ts` and forwards. `ime-helper.ts:51,116` goes through the port, while `automation-helper-artifact.ts:8,93` imports the same function directly. Test stubs must also carry both members (`adb-host.fixtures.ts:89-94`, `ime-host.fixtures.ts:69-75`, `__tests__/test-utils/android-host-test-setup.ts:57-63`).
- Fix: import directly in `ime-helper.ts`, drop both port members and their stubs/wiring. Files: `adb-host.ts`, `ime-helper.ts`, fixtures, `src/platform-runtime-android-adb-host.ts` (outside slice — flag to its owner).
- Effort: S
- Model: sonnet
- Verify: `pnpm check:affected --run`; layering scan (check that the direct import does not cross a boundary the port was introduced for).

### ANDR-17: Stabilized screenshot leaves `sysui_demo_allowed=1` on the device
- Category: broken
- Severity: low     Confidence: high
- Evidence: `packages/platform-android/src/screenshot.ts:49` runs `settings put global sysui_demo_allowed 1`; `disableAndroidDemoMode` (`:59-66`) only broadcasts `exit` and never restores the prior value, so each `--stabilize` screenshot permanently changes a global device setting.
- Fix: read the prior value and restore it in the `finally` (or delete the key if it was `null`). Files: `screenshot.ts`, `__tests__/screenshot.test.ts`.
- Effort: S
- Model: sonnet
- Verify: test asserting the restore command is issued after capture and after a capture failure.

### ANDR-18: `isAndroidPackageInstalled` has a dead branch
- Category: unneeded
- Severity: low     Confidence: high
- Evidence: `packages/platform-android/src/app-lifecycle.ts:522-525` — `if (looksLikeMissingAndroidPackageOutput(output)) return false;` immediately followed by `return false;`.
- Fix: delete the branch. Files: `app-lifecycle.ts`.
- Effort: S
- Model: sonnet
- Verify: `__tests__/app-lifecycle-open.test.ts`.

### ANDR-19: Key/back/home/app-switcher dispatch does not disclose dispatch state the way tap does; TV-remote duration is discarded
- Category: inconsistent
- Severity: low     Confidence: medium
- Evidence: `packages/platform-android/src/input-actions.ts:49-62` wraps the tap path in `discloseAdbInputDispatch`; `backAndroid` (`:103-107`), `homeAndroid` (`:119`), `pressAndroidEnter` (`:131`), `appSwitcherAndroid` (`:260`), `pressAndroidHardwareButton` (`:275`) and `pressAndroidTvRemote` (`:87`) call `runAndroidShell` bare, so an adb failure on those carries no `dispatched` detail (text-input's own Enter path does wrap it, `text-input.ts:405-411`). `pressAndroidTvRemote` (`:80-88`) maps any `durationMs > 0` to `--longpress` and ignores the value. I did not check whether a higher layer adds disclosure for these commands.
- Fix: route all six through one `dispatchAndroidKeyevent` helper that applies the disclosure; document or honor `durationMs`. Files: `input-actions.ts`, `__tests__/input-actions.test.ts`.
- Effort: S
- Model: sonnet
- Verify: `input-actions.test.ts` asserting `details.dispatched` on a failed `back`.
