# Audit report: SLICE ANDR2 — `packages/platform-android/` (parts the ANDR pass did not reach)

## Coverage

Read-only audit. No gates, builds, or tests were run; every finding comes from reading code and grep. Findings of the first report (ANDR-1 … ANDR-19) are not repeated.

- **Read fully (production):** all of `recording/` (16 modules: `runtime`, `launch`, `chunks`, `finalize`, `recovery`, `cleanup`, `start-reconciliation`, `manifest`, `manifest-validation`, `manifest-store`, `recorder-status`, `captured-window`, `chunk-path`, `live-snapshot`, plus `fixtures.ts`); `logs/*`; `network/runtime.ts`; `telephony/*`; `shutdown/runtime.ts`; `foldable/pose.ts`, `foldable/runtime.ts`; `readiness/runtime.ts`; `deployment/runtime.ts`, `deployment/native.ts`; `app-deployment.ts`, `app-deployment-resolution.ts`, `install-artifact.ts`, `notifications.ts`; `lifecycle.ts`; `emulator-lifecycle.ts`; `inventory.ts`, `inventory-parsers.ts`, `inventory-config.ts`; `device-boot.ts`; `logcat.ts`; `sdk.ts`; `doctor.ts`; `alert.ts`; `manifest.ts`; `ui-hierarchy-builder.ts`; `ime-lifecycle.ts`, `ime-state.ts`, `ime-restore.ts`, `ime-rebind.ts`, `ime-activation.ts`, `ime-settings-record.ts`, `ime-recovery-marker.ts`; `runtime.ts`; `settings.ts`, `settings-global-toggle.ts`, `settings-airplane.ts`, `settings-bluetooth.ts`; `index.ts`; `mechanics.ts`; `clipboard-shell-response.ts`.
- **Partial:** `settings-permission.ts` (outline plus the pm-skip classifier, photos and notification paths, about 35%); `alert-detection.ts` (first 140 of 399 lines).
- **Read outside the slice only to trace call paths:** `src/platform-runtime-screen-recording-android-host.ts`, `src/platform-runtime-android-emulator-host.ts`, `src/platform-runtime-android-tool-host.ts` (clipboard probe), `packages/daemon/src/sessions/handlers/session-app-deployment.ts`, `packages/contracts/src/screen-recording-runtime-host.ts`, `packages/contracts/src/telephony-input.ts`.
- **Tests:** read in full or in large part: `recording/fixtures.ts`, `recording/recovery.test.ts` (3 cases), `recording/cleanup.test.ts` (1 case), `recording/chunks.test.ts` (2 cases), `recording/finalize.test.ts` (2 cases), `recording/runtime.test.ts` (1 case), `manifest.test.ts` (property section), `runtime-facade.test.ts`, `logs/package-name.test.ts`, `telephony/runtime.test.ts`, `perf/runtime.test.ts`, `__tests__/snapshot-helper-runtime.test.ts`, `__tests__/alert.test.ts` (2 cases). All other tests got mechanical scans only (skip/only/todo: none; duplicate titles: one harmless; real sleeps; fake-timer use; importers of dead modules).
- **Not reached:** `perf/`, `perf-*.ts`, `snapshot-presentation*.ts`, `permission-grant-state.ts`, `ui-hierarchy-{inclusion,scope,visibility,node}.ts`, `launch-observation.ts`, `open-target*.ts`, `app-helpers.ts`, `app-control.ts`, `device-sdk-int.ts`, `audio-runtime.ts`, `gesture-viewport.ts`, `touch-plan-lowering.ts`, `touch-executor.ts`, `fill-diagnostics.ts`, Gradle/native code, and the body of roughly 85% of test files.
- **Rough share:** about 9,000 of the ~11,500 production lines the first pass left unread (~78%); about 10% of test lines read closely.
- **Checked and found clean (no finding):** telephony console injection (number is validated to `^\+?\d{1,15}$` and SMS text has control characters refused upstream, `packages/contracts/src/telephony-input.ts`); recording marker path validation (`manifest-validation.ts:11-13` pins both directories and the file-name grammar); the binary-XML parser bounds checks in `manifest.ts`; the IME activation ordering (record → marker → switch) and the flush-window accounting in `ime-state.ts`.

## Findings

### ANDR2-1: `record stop` fails permanently when any chunk's recorder pid was reassigned, although every other recording path treats that as proof of termination
- Category: broken
- Severity: medium     Confidence: high (code path) / medium (how often it bites)
- Evidence: `packages/platform-android/src/recording/chunks.ts:218-238` — `stopChunk` throws `Android screenrecord ownership could not be confirmed` when `transport.stop` answers `ownership-lost`, and `chunks.ts:253-268` (`waitForStopped`) throws the same error for any state `provesAndroidScreenRecordTermination` accepts other than `missing`. `chunks.ts:97-115` (`stopOwnedChunks`) runs that for **every** committed chunk, and `finalize.ts:75` calls it on the whole evidence. The contract (`packages/contracts/src/screen-recording-runtime-host.ts:107-137`) defines `ownership-lost` and `foreign-writer` as "proof rather than doubt: the recorded process can no longer write its artifact", and the real host returns `ownership-lost` from `stop` for both (`src/platform-runtime-screen-recording-android-host.ts:63-67`). The sibling paths agree with the contract: `cleanup.ts:49-62` sets such a chunk aside as `retired`, `start-reconciliation.ts:95-96` continues, `recovery.ts:176-196` reattaches as `active` and passes `reachedLimit: provesAndroidScreenRecordTermination(running)` so the stop can disclose truncation. That last intent is unreachable with the real host: reattach succeeds, then `finish` → `stopOwnedChunks` → `ownership-lost` → throw, on every retry. The test that covers it (`recording/recovery.test.ts:103-124`) passes only because its stub answers `inspect: 'ownership-lost'` but `stop: 'uncertain'`, a pair the real host cannot produce. A multi-chunk recording keeps every rotated-out chunk's pid in the evidence for the recording's whole life, so one pid reuse among N earlier chunks makes the video unexportable; only `forceCleanup` (which deletes the chunks) still works.
- Fix: in `stopChunk`, treat a state that proves termination as "already exited" (return `true`, never signal), exactly as `cleanup.ts` does, and keep the throw only for `uncertain`. In `waitForStopped`, return `true` for any proving state. Then require the artifact to be released (`probeRunningWriters`) before pulling a chunk whose state was `foreign-writer`. Rewrite `recovery.test.ts:103` to use a consistent transport stub and update `chunks.test.ts:149`. Files: `recording/chunks.ts`, `recording/finalize.ts`, `recording/recovery.test.ts`, `recording/chunks.test.ts`.
- Effort: M
- Model: opus (recording ownership semantics, device behavior)
- Verify: new `finalize.test.ts` case: two chunks, chunk 1 `inspect`/`stop` answer `ownership-lost`, chunk 2 live → `finish` resolves `completed` and never signals pid 1; `recovery.test.ts:103` passes with `stop` answering `ownership-lost`.

### ANDR2-2: Restore and doctor read a failed `default_input_method` probe as "helper not active" and retire the recovery evidence
- Category: broken
- Severity: medium     Confidence: high (logic) / low (frequency: needs an adb failure between two reads)
- Evidence: `packages/platform-android/src/ime-settings-record.ts:21-28` — `readAndroidDefaultInputMethod` returns `''` when `settings get` exits non-zero, the same value as an unset row. The record read next to it distinguishes the two (`:133-142`, `undefined` → `unreadable`). Consumers: `ime-restore.ts:137-148` returns `helper-not-active` when `currentIme !== helper`; `ime-restore.ts:102-104` counts `helper-not-active` as "device was inspected and the helper is confirmed off it"; `ime-restore.ts:74-76` then clears the recovery marker, after `ime-restore.ts:94` already dropped the in-process ownership. A failed read therefore leaves the helper IME active with no owner and no startup-recovery marker. `doctor.ts:77-83` has the same flaw: a failed read reports `status: 'pass'` with "the device's normal IME is in use"; the `warn` branch at `:84-86` is reachable only when the executor throws.
- Fix: make `readAndroidDefaultInputMethod` return `string | undefined` (`undefined` = unreadable). In `restoreAndroidTestImeFor` return `record-unreadable` for `undefined`. In `probeAndroidTestIme` return the probe-failure check. In `ime-activation.ts:95` and `ime-rebind.ts` map `undefined` to the existing refusal paths. Files: `ime-settings-record.ts`, `ime-restore.ts`, `ime-activation.ts`, `ime-rebind.ts`, `doctor.ts`, their tests.
- Effort: S
- Model: opus (IME recovery invariants)
- Verify: `ime-restore.test.ts` case: record reads succeed, `settings get secure default_input_method` exits 1 → result `record-unreadable`, marker `clear` not called; `__tests__/doctor.test.ts` case → `status: 'warn'`.

### ANDR2-3: `deployApp` discards the device that readiness returns; the comment that justifies the call contradicts the daemon
- Category: inconsistent
- Severity: medium     Confidence: high
- Evidence: `packages/platform-android/src/deployment/runtime.ts:111-113` and `:135-137` call `await ensureAndroidReady(host, device, …)` and drop the result, then run `resolveAppPackage`, `adb uninstall`, `pm list packages`, and `adb install` against the original `device`. A stopped AVD has `id: <AVD name>` (`inventory.ts:267-274`), and `ensureEmulatorReady` returns a new `DeviceInfo` with the `emulator-NNNN` serial (`readiness/runtime.ts:60-63`). The uninstall sibling in the same file does it correctly (`:75-78`, `ready = …`; test `deployment/runtime.test.ts:234` pins "on the device readiness returns"). The comment at `:130-132` says the rule lives here "rather than reviving a daemon readiness adapter", but the daemon does exactly that for the local owner: `packages/daemon/src/sessions/handlers/session-app-deployment.ts:99-110` calls `ensureReady` and re-binds with the returned device. So for the local owner the in-runtime call is dead duplication, and for any other owner that reaches this code with an unbooted device (`createAndroidAppDeploymentOperations` is also consumed by `src/sdk/limrun-runtime-dependencies.ts:35-37`) it boots through the local emulator host and then installs to the stale id. `deployment/runtime.test.ts:106-133` covers only a device whose id does not change.
- Fix: choose one owner. Either delete both `ensureAndroidReady` calls and the comment (daemon owns readiness), or use the returned device for every later call as `uninstallAndroidApp` does and delete the daemon block. Files: `deployment/runtime.ts`, `deployment/runtime.test.ts`, possibly the daemon handler (outside slice).
- Effort: S
- Model: opus (cross-module ownership decision)
- Verify: `deployment/runtime.test.ts` case with `ensureAndroidReady` resolving a different id → every `runAdb`/`installPackage` call receives the new id (or `ensureAndroidReady` is never called).

### ANDR2-4: `record stop` rejects after the export was served when the device reports a failed chunk removal
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence: `packages/platform-android/src/recording/finalize.ts:218-243` — after the completion marker is persisted and the export exists, `cleanupChunks` (`chunks.ts:144-158`) throws when `transport.remove` answers `false`, so `finish` rejects. The lines that follow (`:234-241`) and the doc comment state the opposite contract: a removal "stays owed" and is reported as `nativePathDisposition: 'retirable'`. Only the "device said yes but kept the file" case reaches that code (`finalize.test.ts:160-181`); an `rm` that exits non-zero or an adb drop after the pull turns a finished recording into a failed `record stop`.
- Fix: catch the `cleanupChunks` failure in `recordCompletionAndDisposeChunks` and answer from `nativeChunksDisposition` (which already returns `retirable` on any non-`false` probe). Files: `recording/finalize.ts`, `recording/finalize.test.ts`.
- Effort: S
- Model: sonnet
- Verify: new `finalize.test.ts` case with `remove: async () => false` → `status: 'completed'`, `nativePathDisposition: 'retirable'`.

### ANDR2-5: First-chunk launch has a `/data/local/tmp` fallback that an unwritable `/sdcard` never reaches
- Category: broken
- Severity: low     Confidence: medium
- Evidence: `packages/platform-android/src/recording/launch.ts:29-35` — for each candidate directory the pending marker is written first, and that `persistNativeManifest` call is outside the `try` at `:38-52`. A marker write that fails (`printf … > /sdcard/….tmp` exits non-zero, `src/platform-runtime-screen-recording-android-host.ts:136-147`) throws out of the loop, so the second candidate from `chunks.ts:33-41` is tried only when `screenrecord` itself fails after a successful `/sdcard` write. An unwritable `/sdcard` is the case the fallback list exists for. No test in `recording/launch.test.ts` covers a first-candidate marker-write failure.
- Fix: treat a failed pre-launch marker write as a failed candidate (nothing was launched, so `continue` after confirming the marker is absent); keep the abort path. Files: `recording/launch.ts`, `recording/launch.test.ts`.
- Effort: S
- Model: opus (recording start transaction)
- Verify: `launch.test.ts` case: `writeManifest` rejects for `/sdcard/…`, resolves for `/data/local/tmp/…` → the chunk starts under `/data/local/tmp`.

### ANDR2-6: Clipboard-support verdict is cached per serial for the owner's lifetime, and the probe runs without signal or timeout on every fact inspection of an unreachable device
- Category: broken
- Severity: low     Confidence: high (cache) / medium (cost)
- Evidence: `packages/platform-android/src/runtime.ts:281-292` — `clipboardShell` is keyed by `device.id` and never invalidated; the comment's premise ("cannot change while the device is up") does not hold across the daemon's life, because an emulator serial such as `emulator-5554` is reused by the next AVD (a different API level) on the same port. An `unsupported` verdict then refuses clipboard on the new image until the daemon restarts. `runtime.ts:248-255` calls `probe.call(host.androidTools, device)` without the request signal, and the host implementation (`src/platform-runtime-android-tool-host.ts:17-29`) passes no `timeoutMs`. `probe-failed` is deliberately not cached, and `inspectFacts` runs inside every `bind` (`runtime.ts:439`) as well as before it, so a stopped AVD (id = AVD name) or offline device pays one failing `adb shell cmd clipboard get text` per inspection and per bind for every command, clipboard-related or not.
- Fix: skip the probe when `device.booted !== true` (answer `clipboardShellUnknown`); key the cache by serial plus a boot identity (`observeAndroidBootTimeMs` already exists in `device-boot.ts`) or clear the entry on `shutdownTarget`/`ensureReady`; pass the scope signal and a short timeout. Files: `runtime.ts`, `runtime.test.ts`, `src/platform-runtime-android-tool-host.ts` (outside slice).
- Effort: S
- Model: sonnet
- Verify: `runtime.test.ts` cases: unbooted device → probe mock not called; verdict re-probed after a readiness transition.

### ANDR2-7: Rotation timer is anchored after the previous recorder is stopped, so a chunk can pass Android's 180 s limit without disclosure
- Category: broken
- Severity: low     Confidence: medium
- Evidence: `packages/platform-android/src/recording/runtime.ts:30` (`ROTATE_AFTER_MS = 170_000`) and `:249-250` — `schedule()` runs after `await stopChunk(transport, previous)`. The new chunk was launched before the marker write and before that stop, and `stopChunk` may take the full graceful window (`chunks.ts:10-11`, 10 s at 1 s polls, then a forced stop). The new chunk's age at its own replacement is therefore 170 s plus launch, commit and stop time: nominally 172–175 s, and above 180 s when the previous recorder is slow to exit. The recorder then ends on its own; rotation ignores the `alreadyExited` result at `:249`, and the limit warning is raised only for the last chunk (`chunks.test.ts:99` pins "omits the 180s limit warning when only a rotated-out chunk exited"). The result is a silent gap in a multi-chunk video.
- Fix: record the launch instant of each chunk and arm the next timer at `launchAt + ROTATE_AFTER_MS`; carry a "rotated-out chunk had already exited" fact into the finalization warning. Files: `recording/runtime.ts`, `recording/finalize.ts`, `recording/runtime.test.ts`.
- Effort: S
- Model: opus (timing, device behavior)
- Verify: fake-timer test in `recording/runtime.test.ts`: previous stop takes 9 s → the next launch still starts ≤ 170 s after the current chunk's launch.

### ANDR2-8: `notifications.ts` is a dead second implementation of the push broadcast
- Category: unneeded
- Severity: low     Confidence: high
- Evidence: `packages/platform-android/src/notifications.ts:12-66` (`pushAndroidNotification`, `appendBroadcastExtra`) duplicates `deployment/native.ts:55-89,201-212`. Its only production importer is the barrel re-export `mechanics.ts:211`; `grep -rw pushAndroidNotification` over every tracked file outside the package returns nothing, and the runtime uses the `deployment/native.ts` copy (`deployment/runtime.ts:22,63`). `__tests__/notifications.test.ts` (115 lines) tests only the dead copy. The two copies already differ (`native.ts` asserts the exit code and uses a 15 s timeout; `notifications.ts` relies on `runAndroidShell` throwing).
- Fix: delete `notifications.ts`, its test, and the `mechanics.ts:211` export; move any unique test case onto `deployment/native.test.ts`. Remove the Fallow baseline entry if one names the file.
- Effort: S
- Model: sonnet
- Verify: `pnpm check:affected --run`; `grep -rn "notifications.ts" packages/platform-android/src` returns nothing.

### ANDR2-9: `app-deployment.ts` is a dead second install pipeline, with a second diverging `inferAndroidAppName`
- Category: unneeded
- Severity: low     Confidence: high
- Evidence: `packages/platform-android/src/app-deployment.ts:115-126` (`installAndroidInstallablePath`) is referenced only by `mechanics.ts:72` and `__tests__/app-deployment.test.ts`; no tracked file outside the package imports it (the single outside hit, `scripts/__tests__/vitest-slow-test-reporter.test.ts`, is a string). The live install path is `deployment/native.ts:11-34,112-178` through `host.androidTools`. The dead file carries its own bundletool resolver with a module-level cache (`app-deployment.ts:19-52`), a second `.aab` flow (`:67-96`), and a `waitForAndroidBoot` call (`:122`). Seven of the twelve cases in `__tests__/app-deployment.test.ts` (414 lines) exercise only this path. Related duplication: `inferAndroidAppName` exists twice with different tokenization (`deployment/native.ts:91-110` capitalizes the first letter of one token; `app-deployment-resolution.ts:109-139` also splits on non-alphanumerics and title-cases each part), and both are live (`deployment/runtime.ts:189` vs `app-lifecycle.ts:62`, `app-helpers.ts:29`, `src/sdk/limrun-runtime-dependencies.ts:50`), so `install` and `apps` can name the same package differently.
- Fix: delete `app-deployment.ts` and the `installAndroidInstallablePath` cases; keep the `resolveAndroidApp`/cache cases (move them to an `app-deployment-resolution.test.ts`). Make `deployment/native.ts` import the single `inferAndroidAppName` from `app-deployment-resolution.ts`. Files: `app-deployment.ts`, `mechanics.ts`, `deployment/native.ts`, `deployment/runtime.ts`, tests.
- Effort: S
- Model: sonnet
- Verify: `pnpm check:affected --run`; `grep -rn "installAndroidInstallablePath" packages src` returns nothing.

### ANDR2-10: The `mechanics.ts` barrel exports 127 names that nothing outside the package references
- Category: unneeded
- Severity: low     Confidence: high (count) / medium (which ones are safe to drop)
- Evidence: `packages/platform-android/src/mechanics.ts:8-374` lists 260 exported names. A word-boundary grep of each name over every tracked `.ts/.tsx/.mts/.js/.mjs` file outside `packages/platform-android/` finds no reference for 127 of them (70 functions or values, the rest types and constants). Examples: `parseAndroidHelperManifest` (`:294`, an alias with zero references anywhere, including inside the package), `getAndroidScreenSize`, `setAndroidTestImeActiveForTests`, `resetAndroidTestImeActivationCacheForTests`, `resetAndroidWindowDumpFocusMemoForTests` (test seams published on the production facade), `captureAndroidSnapshotWithHelper`, `ensureAndroidSnapshotHelper`, `executeAndroidTouchHelperPlan`, `lowerAndroidTouchPlan`, `readInstrumentationResultBoolean`, `verifyAndroidHelperApkChecksum`. Because `./mechanics` is a `package.json` export, the dead-code gate treats each one as used; this is what keeps ANDR2-8 and ANDR2-9 alive.
- Fix: remove every export with no consumer outside the package; let in-package tests import from the defining module. Then run the dead-code gate to surface what becomes unused. Files: `mechanics.ts`, any definitions the gate then reports.
- Effort: M
- Model: sonnet (mechanical; the gate reports the fallout)
- Verify: `pnpm check:affected --run` (typecheck plus Fallow); the same grep script reports 0 unreferenced names.

### ANDR2-11: The `.aab` manifest candidate cannot parse a real bundle, and the `aapt` fallback cannot either
- Category: unneeded
- Severity: low     Confidence: high
- Evidence: `packages/platform-android/src/manifest.ts:33` tries `base/manifest/AndroidManifest.xml`. A real `.aab` stores that entry as protobuf, so `parseAndroidManifestPackageName` (`:64-73`) sends it to the binary-XML parser, which refuses at `:141` (first u16 is not `RES_XML_TYPE`). The test file states this itself: `manifest.test.ts:121-122` — "A real `.aab` carries a protobuf manifest there and resolves to undefined; this proves the candidate itself still parses a binary XML manifest" — a case no real artifact produces. The fallback at `:324-339` runs `aapt dump badging`, which reads only APK layout. Every `.aab` therefore costs two `unzip` spawns and one `aapt` spawn to return `undefined`, and `deployment/native.ts:18,31-33` falls back to the before/after `pm list packages` diff.
- Fix: delete the second entry candidate and its test case, and return `undefined` for `.aab` before spawning anything; or implement the bundle read properly (`bundletool dump manifest --xpath /manifest/@package`, already resolvable through `host.androidDeployment.bundletoolJar`). Files: `manifest.ts`, `manifest.test.ts`, `install-artifact.ts`.
- Effort: S (delete) / M (implement)
- Model: sonnet
- Verify: `manifest.test.ts` green without the "bundle layout" case; an `.aab` install spawns no `unzip`.

### ANDR2-12: Device inventory spends 6 adb round trips per device on TV detection, and emulator readiness re-runs the full inventory every second
- Category: inefficient
- Severity: medium     Confidence: high
- Evidence: `packages/platform-android/src/inventory.ts:222-245` — `resolveTarget` runs `getprop ro.build.characteristics`, then four `cmd package has-feature` calls (`TV_FEATURES`, `:32-40`), then `pm list features`. For every non-TV device (the common case) all six run, and the final list alone answers all four feature checks (`androidFeatureListDeclares`). With `isBooted`, `readDeviceDescription`, and up to three AVD-name probes (`:182-194`), one emulator costs up to 11 process spawns per discovery. `readiness/runtime.ts:98-113` (`waitForDiscovery`) calls `host.deviceReadiness.androidEmulator.discover` in a 1 s loop; that is the full local inventory (`src/platform-runtime-android-emulator-host.ts:36-41`), and `inventoryRequest` (`readiness/runtime.ts:150-159`) does not set `androidAvdSelection: 'running-only'`, so each poll also spawns `emulator -list-avds` (`inventory.ts:247-258`) and re-probes every other attached device. One cold boot runs the inventory at `:45`, once per poll second, and again at `:61`. Secondary (confidence low): `resolveTarget` is the only probe in `probeRunningDevice` that is not best-effort; a timeout there rejects the whole inventory (`inventory.ts:290-309`), while `isBooted` and `readDeviceDescription` degrade.
- Fix: in `resolveTarget` run one `pm list features` after the characteristics check and drop the four `has-feature` calls (or keep `has-feature` only when the list fails). In `waitForDiscovery` request `androidAvdSelection: 'running-only'`, and reuse the discovered entry instead of the third full discovery. Files: `inventory.ts`, `readiness/runtime.ts`, `inventory.test.ts`, `readiness/runtime.test.ts`.
- Effort: S
- Model: sonnet (opus if the has-feature calls guard a known device quirk; check `git log -S has-feature`)
- Verify: `inventory.test.ts` asserting ≤ 2 target-probe commands for a mobile device; `readiness/runtime.test.ts` asserting the polling request carries `running-only`.

### ANDR2-13: Two boot waiters disagree on timeout, reason, cancellation, and transport
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence: `packages/platform-android/src/readiness/runtime.ts:16,114-134` — 120 s default, `host.commands.run`, `reason: 'boot_timeout'` (`BOOT_TIMEOUT_REASON`), message "Android device failed to finish booting", cancellable. `emulator-lifecycle.ts:27-97,150-166` — 60 s default, `runAndroidHostAdb`, reasons from `classifyBootFailure` (`ANDROID_BOOT_TIMEOUT`, `ADB_TRANSPORT_UNAVAILABLE`), message "Android device did not finish booting in time". Callers of the second: `app-lifecycle.ts:207` and `:614` (`if (!device.booted) await waitForAndroidBoot(device.id)` with no signal, so an uncancellable wait of up to 60 s), `app-deployment.ts:122` (dead, ANDR2-9), `src/platform-runtime-device-ready.ts:25`. The open path already ran the first waiter (`lifecycle.ts:56-63`), so the same condition surfaces under two reason vocabularies depending on which layer notices it. Small duplicates in the same area: `readiness/runtime.ts:175-181` re-implements `isAndroidEmulatorSerial` and `normalizeAndroidDeviceName` from `inventory-parsers.ts:3-9`, and `ime-restore.ts:233` inlines the prefix test a third time.
- Fix: keep one waiter (the readiness one, which takes a deadline and a signal), make `emulator-lifecycle.ts` a thin adapter or delete it, and import the two parsers from `inventory-parsers.ts`. Files: `readiness/runtime.ts`, `emulator-lifecycle.ts`, `app-lifecycle.ts`, `ime-restore.ts`.
- Effort: M
- Model: opus (error-contract change visible to callers)
- Verify: `__tests__/emulator-lifecycle.test.ts`, `readiness/runtime.test.ts`, `lifecycle.test.ts`; grep shows one `sys.boot_completed` poll loop.

### ANDR2-14: Sibling settings follow three different contracts for verification and cancellation
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence: `packages/platform-android/src/settings.ts:97-150` — `bluetooth` and `mobile-data` go through `setAndroidGlobalToggle` (read-back poll, typed `not-applied`/`unreadable` reasons, `dispatched` disclosure, signal; `settings-global-toggle.ts:39-96`); `airplane` reads back but takes no signal and discloses no dispatch state (`settings-airplane.ts:20-36`); `wifi` runs `svc wifi enable|disable` and returns nothing (`settings.ts:98-100`), although `settings-global-toggle.ts:13-17` documents that `svc` "can exit 0 before the row changes, or without changing it". `location`, `animations`, `appearance`, and `text-size` are also unverified. The `signal` parameter of `setAndroidSetting` (`settings.ts:91`) reaches only two of eleven branches. The function is also suppressed twice for complexity: inline at `settings.ts:84` (`fallow-ignore-next-line complexity`) and in `fallow-baselines/health.json` (`"packages/platform-android/src/settings.ts:complexity"`).
- Fix: route `wifi` through `setAndroidGlobalToggle` (row `wifi_on`); pass `signal` to every `runAndroidShell` in the switch; split the switch into one handler per setting in a typed table (as `ANDROID_READABLE_SETTINGS` already does at `:241-243`), then delete both suppressions. Files: `settings.ts`, `settings-airplane.ts`, `__tests__/settings.test.ts`, `fallow-baselines/health.json`.
- Effort: M
- Model: opus for the wifi read-back (device behavior); sonnet for the table split
- Verify: `__tests__/settings.test.ts` case: `svc wifi` exits 0 and `wifi_on` stays `0` → typed `wifi-not-applied`; Fallow health passes with the baseline entry removed.

### ANDR2-15: SDK tool resolution has two root lists, and `doctor` probes a different adb than the one in the supplied environment
- Category: inconsistent
- Severity: low     Confidence: medium
- Evidence: `packages/platform-android/src/sdk.ts:29-41` resolves `ANDROID_SDK_ROOT`, `ANDROID_HOME`, `~/Library/Android/sdk` (macOS), `~/Android/Sdk`. `inventory.ts:64-73,107-118` resolves `config.sdkRoots` (the two variables captured at composition, `src/platform-runtime.ts:94`) plus `~/Android/Sdk` only, then `which`. The macOS Studio root is missing from the second list, and the root that `ensureAndroidSdkPathConfigured` detects is never fed back, so inventory works on macOS only through the `PATH` mutation that `host.toolchains.prepare('android')` performs first. `doctor.ts:30-39` takes an `environment` parameter for the SDK root and license but runs `commandOutput('adb', ['version'])`, which takes no environment (`packages/provision-kit/src/toolchain-probe.ts:11-18`); it can report "adb not found on PATH" or a different binary than the one inventory selected under `<sdkRoot>/platform-tools`.
- Fix: have inventory call `resolveAndroidSdkRoots` (one list), and have `androidToolchainCheck` resolve adb through the same function and run that path. Files: `inventory.ts`, `doctor.ts`, `sdk.ts`, `index.ts` (drop the `sdkRoots` config if it becomes unused).
- Effort: S
- Model: sonnet
- Verify: `inventory.test.ts` case with only `~/Library/Android/sdk/platform-tools/adb` executable on `darwin`; `__tests__/doctor.test.ts` asserting the probed executable path.

### ANDR2-16: Recording test fixture still translates a retired transport shape
- Category: unneeded
- Severity: low     Confidence: high
- Evidence: `packages/platform-android/src/recording/fixtures.ts:33-109` — a variable named `legacy` adapts `isRunning`, `signal`, `pull`, `findRunning`, and a `start` that returns `{ remotePid }` onto the current contract (`inspect`, `stop`, `pullPlayable`, `probeRunningWriters`, `start → { process }`). Tests still written against the old names: `isRunning` in 4 files, `signal:` in 8, `pull:` in 4, `findRunning` in 4. Two vocabularies for one transport let a stub answer combinations the real host cannot (the cause of the masked case in ANDR2-1: `inspect` and `stop` are stubbed independently). AGENTS.md: "During a migration, remove superseded paths."
- Fix: rewrite the stubs to the current transport members and delete the adapter branches. Files: `recording/fixtures.ts` and the `recording/*.test.ts` files that use the old keys.
- Effort: M
- Model: sonnet
- Verify: `grep -n "legacy\|isRunning\|findRunning" packages/platform-android/src/recording` returns nothing; the recording tests pass.

### ANDR2-17: Pure-parser property tests spawn `unzip` for every generated case; recording finalization tests wait in real time
- Category: inefficient
- Severity: low     Confidence: high (spawns) / medium (wall-clock impact, not measured)
- Evidence: `packages/platform-android/src/manifest.test.ts:26,37-47,261-290` — two `fast-check` properties with `PROPERTY_RUNS = 100` each call `resolveManifest`, which writes a ZIP and runs the production resolver; that is one or two `unzip` processes per run (the corrupt-bytes property usually takes both candidates), about 300 process spawns to test a buffer parser, and a hard dependency on a host `unzip`. The parser (`manifest.ts:64`, `parseAndroidManifestPackageName`) is not exported, which forces this. `recording/chunks.ts:116-131` (`waitForStableArtifacts`) always sleeps 250 ms once per chunk because the first sample can never equal an undefined previous size; `recording/finalize.test.ts`, `recovery.test.ts`, and `launch.test.ts` do not use fake timers (only `chunks`, `cleanup`, `recovery-cleanup`, `runtime-failed-finish`, `runtime` do), so each of their roughly 15 `finish()` calls waits at least 250 ms of real time.
- Fix: export the pure parser and run both properties on buffers; keep one ZIP-seam test per entry candidate. Run the three recording files under the existing `__tests__/test-utils/fake-timers.ts` helper. Files: `manifest.ts`, `manifest.test.ts`, the three recording test files.
- Effort: S
- Model: sonnet
- Verify: `pnpm vitest run packages/platform-android/src/manifest.test.ts packages/platform-android/src/recording` before and after; compare the reported durations.

### ANDR2-18: `buildUiHierarchySnapshot` can report `truncated` when every presentable node fit
- Category: broken
- Severity: low     Confidence: medium
- Evidence: `packages/platform-android/src/ui-hierarchy-builder.ts:268-278` — `shouldStopAndroidWalk` sets `state.truncated = true` whenever `nodes.length >= maxNodes` at the entry of any further node, before it tests `state.hidden.has(node)` and before `shouldIncludeAndroidNode` (`:309-320`) decides whether the node would be presented. A tree with exactly `maxNodes` presented nodes followed by any hidden, filtered, or folded node returns `truncated: true` although nothing was cut.
- Fix: set `truncated` at the point a node that would be appended is refused (in `appendAndroidNodeIfPresented`), and keep the early stop only as a walk cut-off. Files: `ui-hierarchy-builder.ts`, `__tests__/ui-hierarchy-builder.test.ts`.
- Effort: S
- Model: sonnet
- Verify: test: `maxNodes = N`, tree with N presented nodes plus one trailing invisible node → `truncated` undefined.

### ANDR2-19: Network dump resolves the app pid twice and without a timeout
- Category: inefficient
- Severity: low     Confidence: high
- Evidence: `packages/platform-android/src/network/runtime.ts:101` (`recoveryContext`) and `:119` (`recoverPackageTraffic`) each run `adb shell pidof <package>` in the stale-active path; the request at `:147-165` sets no `timeoutMs`, while the same request in `logs/runtime.ts:103-110` uses 5 s and the logcat read at `:122-129` uses 3 s. The pid request is defined twice (`logs/runtime.ts:103`, `network/runtime.ts:147`).
- Fix: return the current pid from `recoveryContext` and pass it on; reuse the `logs/runtime.ts` request builder. Files: `network/runtime.ts`, `logs/runtime.ts`, `network/runtime.test.ts`.
- Effort: S
- Model: sonnet
- Verify: `network/runtime.test.ts` asserting one `pidof` call in the stale-active case.
