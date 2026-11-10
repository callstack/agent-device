# Audit: SLICE CAP2 — capture-kit / selectors / kernel, second pass

## Coverage

Read-only audit. No gates, tests, or builds were run. One throwaway `node --experimental-strip-types` script reproduced CAP2-2 and was deleted. All paths are relative to `/home/user/agent-device`. Findings in `capture-selectors-kernel.md` (CAP-1..23) are not repeated.

Read fully in this pass (production source):

- `packages/capture-kit/src`:
  - Network: `network-traffic.ts`, `network-traffic-android.ts`, `network-traffic-value.ts`.
  - Screenshot diff: `screenshot-diff.ts`, `screenshot-diff-pixels.ts`, `screenshot-diff-regions.ts`, `screenshot-diff-components.ts`, `screenshot-diff-region-split.ts`, `screenshot-diff-region-overlay.ts`, `screenshot-diff-overlay-matches.ts`.
  - Screenshot overlay: `screenshot-overlay.ts`.
  - PNG: `png.ts`, `png-format.ts`, `png-encode.ts`, `png-predictor.ts`, `png-crop-bytes.ts`, `png-region-decode.ts`, `png-resize.ts`, `png-size.ts`, `png-rgb-difference.ts`, `png-worker.ts`, `png-worker-contract.ts`, `screenshot-image.ts`, `screenshot-image-size.ts`, `screenshot-density.ts`.
  - App log: `app-log-runtime.ts`, `app-log-pid-runtime.ts`, `app-log-pid-monitor.ts`, `app-log-pid-process.ts`, `app-log-process-recovery.ts`, `app-log-live-handle.ts`, `provider-app-log.ts`, `provider-app-log-poller.ts`.
  - Audio probe: `audio-probe-runtime.ts`, `audio-probe-recovery.ts`, `audio-probe-status.ts`.
  - Durable capture: `durable-capture/{definition,store,fence,session-binding,finish-recovered,transitions,adoption}.ts`.
  - Recording: `recording/{video,mp4-atoms,mp4-duration,swift-cache,stop-sequence,stop-checkpoints,recording-facts,telemetry,output-path,artifact-paths}.ts`.
  - Scroll edge: `snapshot/scroll-edge-state.ts`, `snapshot/scroll-edge-state/selection.ts`.
  - iOS snapshot engine: `ios-snapshot-engine/{engine,tree}.ts` only.
- `packages/selectors/src`: `parameterized-recorded-fill.ts`, `target-evidence.ts`, `keyboard-occlusion.ts`.
- `packages/kernel/src`: `device.ts`, `contracts.ts` (both complete).

Rough share of the unread remainder now covered: capture-kit about 9k of 21k unread production lines (capture-kit total about 55% with the first pass); selectors about 80% total; kernel about 95% total.

Not reached:

- `capture-kit/src/durable-capture/{recovery,recovery-authority}.ts`.
- All of `capture-kit/src/capture-admission/*` (only grepped `durable-capture-start-preflight.ts`).
- `capture-kit/src/recording/{contact-sheet*,overlay,video-webm}.ts`.
- `capture-kit/src/ios-snapshot-engine/*` except `engine.ts` and `tree.ts` (about 3.4k lines: geometry, rows, noise-*, action-shelf, invariants, runner-presentation, conformance-*).
- `capture-kit/src/snapshot/snapshot-freshness/*`, `alert-tree-driver.ts`, `react-native-overlay.ts`, `audio-probe-descriptor.ts`, `durable-resource-envelope.ts`, `durable-json.ts`, `screen-recording-*.ts`, `screenshot-overlay-{draw,rects,android}.ts`.
- `selectors/src/{absence-observation*,interaction-touch-point,press-retarget,selector-pipeline-policy,interaction-positionals}.ts`.
- Test files: none read in depth. A grep for skipped, todo, or `.only` tests in the three packages found none.

Checked and found clean (no finding):

- `parameterized-recorded-fill.ts`: every key in its structural allowlists still has a producer elsewhere in the repo (24 keys sampled).
- `audio-probe-status.ts` reads: the macOS helper writes the status file atomically (`apple/macos-helper/Sources/AgentDeviceMacOSHelper/AudioProbe.swift:185`), so no torn-read bug.
- `recording/output-path.ts` against the `.webm` name dispatch in `video.ts`: `packages/platform-web/src/recording/runtime.ts:73` refuses a non-`.webm` web output path first.

## Findings

### CAP2-1: `captureScrollEdgeState` turns every failure, including cancellation, into a generic `COMMAND_FAILED`
- Category: broken
- Severity: medium     Confidence: high (wrapping verified); medium (how often a typed error passes through)
- Evidence:
  - `packages/capture-kit/src/snapshot/scroll-edge-state.ts:79-89` — the `try` covers `captureNodes` and the `catch` rethrows `buildScrollEdgeVerificationError(edge, scope, error)` for any error.
  - `scroll-edge-state.ts:357-381` — the replacement error is `COMMAND_FAILED` with a "run snapshot -i" hint and no `reason`; the original survives only as `cause`.
  - `packages/daemon/src/execution/scroll-runtime.ts:380-386` — the `captureNodes` callback calls `context.signal?.throwIfAborted()` and `runtime.operations.captureSnapshot(...)`. A request cancel, or a typed capture error (device gone, runner refusal with its own `reason`), therefore reaches the client as "Failed to verify scroll bottom state".
  - `scroll-edge-state.ts:84` — the unscoped retry runs inside the same `try`. Its already-wrapped error is wrapped again by the outer `catch` as "…for scoped container" with a hint about the scope, although the failing capture was the unscoped one.
- Fix: rethrow `AppError` and abort errors unchanged; wrap only non-`AppError` failures. Move the unscoped retry out of the `try` (return it after the block). File: `scroll-edge-state.ts`.
- Effort: S
- Model: sonnet
- Verify: add cases to `packages/capture-kit/src/snapshot/__tests__/scroll-edge-state-pass-orchestration.test.ts`: (a) `captureNodes` rejects with an `AppError` carrying `details.reason` and the same error comes out; (b) an aborted signal comes out as the cancel error; (c) a failing unscoped retry is not labelled "scoped container".

### CAP2-2: PID-scoped app-log capture stops for good after one failed PID poll
- Category: broken
- Severity: medium     Confidence: medium (control flow verified; that a timed-out `host.commands.run` rejects is inferred from `runCmd`)
- Evidence:
  - `packages/capture-kit/src/app-log-pid-monitor.ts:105-106` — `pollActiveProcessPid` awaits `input.resolvePid()` every 500 ms with no `try`.
  - `app-log-pid-monitor.ts:50-56` — a rejection leaves `settleActiveProcess` through its `finally`, which disposes the active stream, and then leaves `monitorPidScopedProcess`.
  - `packages/capture-kit/src/app-log-pid-process.ts:87-89` — the only handler is `.catch(() => { state = 'failed'; })`. Nothing restarts the monitor, and the error is not recorded.
  - `packages/platform-android/src/logs/runtime.ts:106-108` — the poll is `adb shell pidof` with `allowFailure: true, timeoutMs: 5_000`. `allowFailure` covers a non-zero exit, not a timeout: `packages/capture-kit/src/recording/video.ts:134-141` shows `runCmd` rejecting on timeout with `allowFailure: true`.
  - Net effect: one adb stall in a long session ends log capture silently. `logs` and `network dump` then read a file that no longer grows.
- Fix: treat a rejected `resolvePid` like an empty PID: set `recovering`, sleep, and retry. Keep the last error for `inspect()`. Files: `app-log-pid-monitor.ts`, `app-log-pid-process.ts`.
- Effort: S
- Model: opus (lifecycle and cleanup ordering)
- Verify: in `packages/capture-kit/src/app-log-pid-process.test.ts`, make `resolvePid` reject once, then succeed, and assert that the state returns to `active` and a second process starts.

### CAP2-3: Screenshot overlay label resolution is quadratic and walks parents without a cycle guard
- Category: inefficient (plus a latent hang)
- Severity: medium     Confidence: high for the cost shape; low that a cyclic tree reaches it
- Evidence, all in `packages/capture-kit/src/screenshot-overlay.ts`:
  - `:76-103` — `buildScreenshotOverlayRefs` loops over every node and calls `resolveOverlayLabel`.
  - `:204-214` then `:314-329` — for a node that is its own target, or a source with no label, `findDescendantOverlayLabel` loops over all nodes again and calls `isDescendantOf` for each.
  - `:331-344` — `isDescendantOf` walks to the root for every pair. Total cost is O(n squared x depth) for each `screenshot --overlay-refs` and each `diff screenshot` with overlay.
  - `:336-342` — the walk uses `nodes[current.parentIndex]` (array position, not an index map) and has no visited set. A node whose `parentIndex` is its own position never terminates. Other walkers in this package guard this, for example `snapshot/scroll-edge-state/selection.ts:150` and `:320`.
- Fix: build a `childrenByParent` map once (or reuse `collectChildrenByParent` from `ios-snapshot-engine/tree.ts:15`) and collect each target's best descendant label by a subtree walk; memoize per target ref. Add a step bound or visited set. File: `screenshot-overlay.ts`.
- Effort: S
- Model: sonnet
- Verify: `pnpm vitest run packages/capture-kit/src/screenshot-overlay.test.ts` with output unchanged; add a 2k-node timing case and a self-parent case that returns.

### CAP2-4: Provider app-log poller ends permanently on one slow read, and `finish` cannot interrupt a read or a sleep
- Category: inconsistent
- Severity: medium     Confidence: medium (behaviour verified; intent of the permanent stop is not documented)
- Evidence, all in `packages/capture-kit/src/provider-app-log-poller.ts`:
  - `:76-79` — a read that exceeds `READ_TIMEOUT_MS` sets `state = 'failed'` and returns from the loop. The reader stays open until `finish`.
  - `:85-88` — a read that throws sets `recovering` and retries on the next tick. A transient 5 s stall is therefore fatal while a hard error is not.
  - `:89` — `host.clock.sleep(POLL_INTERVAL_MS)` takes no signal, and `:98-99` — `finish` sets `stopped` and awaits `polling`. A stop therefore waits for the current read (up to 5 s) plus the rest of a 1 s sleep.
- Fix: on timeout, set `recovering` and continue, or dispose the reader and document the stop as final. Give the loop an `AbortController` that `finish` aborts, and pass its signal to `boundedRead` and the sleep.
- Effort: S
- Model: opus (decides capture behaviour for remote providers)
- Verify: `pnpm vitest run packages/capture-kit/src/provider-app-log-poller.test.ts` with new cases for timeout-then-recover and for `finish` during a pending read.

### CAP2-5: Diff region analysis and image resize run on the daemon event loop, next to a comment that says the CPU work is on the worker
- Category: inefficient
- Severity: medium     Confidence: medium (cost model from reading; not profiled)
- Evidence:
  - `packages/capture-kit/src/screenshot-diff.ts:127-128` says per-pixel comparison "runs on the PNG worker thread".
  - `screenshot-diff.ts:138-147` then calls `summarizeDiffRegions` in-process. It allocates a `Uint8Array` and an `Int32Array` of the full pixel count (`screenshot-diff-components.ts:24-25`) and runs an 8-neighbour flood fill with a closure call for each differing pixel (`:38`, `screenshot-diff-regions.ts:95`). When the two screens differ everywhere (the common "navigated" case) that is every pixel of a 3-4 MP capture.
  - `screenshot-diff.ts:113-119` runs `resizePngBox` (`png-resize.ts:42-79`, a four-deep float loop over all source pixels) in-process when the widths differ. `png-resize.ts:8-11` calls that "cheap enough to stay inline".
  - `screenshot-diff.ts:110` and `:114` use `await import()` for two small sibling modules that the same package already loads statically elsewhere (`screenshot-image.ts:4`).
- Fix: extend the `diff-pixels` worker job to return the region summary, and add a `resize` job (or run the resize inside `decode-image`). Files: `png-worker.ts`, `png-worker-contract.ts`, `png-worker-client.ts`, `screenshot-diff.ts`.
- Effort: M
- Model: sonnet
- Verify: `pnpm vitest run packages/capture-kit/src/screenshot-diff.test.ts packages/capture-kit/src/png-worker*.test.ts`; measure event-loop block for a 1290x2796 full-change diff before and after.

### CAP2-6: `mergeNetworkScans` returns more entries than `maxEntries`
- Category: broken
- Severity: low     Confidence: high (reproduced)
- Evidence: `packages/capture-kit/src/network-traffic.ts:64-72` copies all primary entries, then pushes a secondary entry before it tests `entries.length >= maxEntries`. A full primary plus one new secondary entry gives `maxEntries + 1`. A one-off script with `maxEntries: 2` and two disjoint two-entry scans returned 3 entries while `dump.limits.maxEntries` said 2. Both callers pass a full primary in the normal case: `packages/platform-apple/src/network/runtime.ts:69`, `packages/platform-android/src/network/runtime.ts:44`. The existing test at `network-traffic.test.ts:73` only merges 1 + 1 into a limit of 2.
- Fix: seed with `primary.dump.entries.slice(0, maxEntries)` and test the limit before the push.
- Effort: S
- Model: sonnet
- Verify: add a test in `packages/capture-kit/src/network-traffic.test.ts` that merges two full scans and asserts `entries.length === maxEntries`.

### CAP2-7: The PID monitor spawns a `pidof` process twice a second for the life of every app-log stream
- Category: inefficient
- Severity: low     Confidence: medium
- Evidence: `packages/capture-kit/src/app-log-pid-monitor.ts:103-110` and `:118` — `waitForPidPoll` sleeps 500 ms and then `resolvePid` runs, for as long as the stream is active. On Android and HarmonyOS each call is one `adb shell pidof` / `hdc shell pidof` host process (`packages/platform-android/src/logs/runtime.ts:106`, `packages/platform-harmonyos/src/logs/runtime.ts:39`). A session that stays open for an hour spawns about 7,200 processes to detect an app restart, which the log stream's own exit already signals (`app-log-pid-monitor.ts:85-95`).
- Fix: poll at a longer interval (for example 2-5 s) while the stream process is alive, or poll only after the stream exits. Make the interval a named constant.
- Effort: S
- Model: opus (changes how fast a relaunch is detected on device)
- Verify: `pnpm vitest run packages/capture-kit/src/app-log-pid-process.test.ts`; then a manual Android relaunch with `logs` running.

### CAP2-8: Audio probe `finish` overwrites the helper's own stop time and reason
- Category: inconsistent
- Severity: low     Confidence: medium (overwrite verified; whether callers rely on it is not)
- Evidence:
  - `packages/capture-kit/src/audio-probe-status.ts:62-69` — `finalizeStatus` spreads the helper status and then always sets `stoppedAt: new Date().toISOString()` and `reason`.
  - `packages/capture-kit/src/audio-probe-runtime.ts:132-139` — `finish` passes the status it read, which is already `stopped` when the helper ran its full duration. The helper writes its own `stoppedAt` and `reason` (`apple/macos-helper/Sources/AgentDeviceMacOSHelper/AudioProbe.swift:87-92,173`).
  - `audio-probe-runtime.ts:150-152` — `status()` returns the helper's values unchanged for the same file. A probe that ended at T and is stopped at T+60 s reports two different stop times depending on the call.
  - `audio-probe-runtime.ts:132-138` also reads the status before it terminates the helper and never reads it again, so anything the helper writes in `finish(reason:)` on termination is not in the result.
- Fix: in `finalizeStatus`, keep `stoppedAt`, `reason`, and `elapsedMs` when `status.state === 'stopped'`. In `finish`, re-read the status file after `process.wait`.
- Effort: S
- Model: sonnet
- Verify: `pnpm vitest run packages/capture-kit/src/audio-probe-runtime.test.ts` with a case where the status file is already `stopped` with a fixed `stoppedAt`.

### CAP2-9: Scroll edge analysis has no reuse: each caller pays normalize, hints, visibility index, and fingerprint to read one field
- Category: inefficient
- Severity: low     Confidence: high
- Evidence:
  - `packages/capture-kit/src/snapshot/scroll-edge-state/selection.ts:16-47` — each `analyzeScrollEdgeState` copies every node (`:53-57`), derives hidden-content hints, builds `createSnapshotVisibility`, and builds the fingerprint.
  - `selection.ts:288-303` — the fingerprint builds a second index map although `visibility.nodeByIndex` exists, runs an ancestor walk for every node (`:314-326`), then sorts and joins all descendant strings.
  - `packages/daemon/src/execution/scroll-movement.ts:199`, `:492` call `readScrollEdgeState(nodes, edge)` only for `.containerRect`; `:378` and `:568` analyze trees that the same scroll already analyzed.
  - `scroll-edge-state.ts:81,102,114` — three functions `await import('./scroll-edge-state/selection.ts')`, which makes two pure functions async.
- Fix: build the fingerprint lazily (a getter or a separate `scrollSurfaceFingerprintOf(state)`), reuse `visibility.nodeByIndex`, mark descendants with one pass from the container down, and memoize the analysis per `(nodes, edge, target)` in a `WeakMap` keyed on the nodes array.
- Effort: S
- Model: sonnet
- Verify: `pnpm vitest run packages/capture-kit/src/snapshot/__tests__/scroll-edge-state-*.test.ts` and the daemon scroll suites.

### CAP2-10: `ScreenshotDiffResult` keeps two fields and two types that nothing emits
- Category: unneeded
- Severity: low     Confidence: high
- Evidence: `packages/capture-kit/src/screenshot-diff.ts:15-41` (types `ScreenshotOcrSummary`, `ScreenshotNonTextDelta`) and `:64-67` (`ocr`, `nonTextDeltas`, each marked "@deprecated Retained for source compatibility; … no longer emitted"). A repo grep finds no writer. The only other references are `src/__tests__/cli-diff.test.ts:208-209`, which assert that the output does not have these keys. AGENTS.md says to add compatibility only on request and to remove superseded paths.
- Fix: delete the two fields and the two types. Check the public SDK type re-export of `ScreenshotDiffResult` and note the removal in the changelog if it is public.
- Effort: S
- Model: sonnet
- Verify: `pnpm typecheck`; `pnpm vitest run packages/capture-kit/src/screenshot-diff.test.ts src/__tests__/cli-diff.test.ts`.

### CAP2-11: Failed-adoption recovery writes the durable record outside the fence that claims to be the only writer
- Category: inconsistent
- Severity: low     Confidence: high for the contradiction; low for a reachable race
- Evidence:
  - `packages/capture-kit/src/durable-capture/fence.ts:11` — "it is the only way a run may write that record"; `:28-41` — admission is "re-checked at every write".
  - `packages/capture-kit/src/durable-capture/adoption.ts:39` (first write), `:130` and `:134-140` (tombstones), `:238-253` (`confirmFailedAdoption` reads, then writes `completed` or `open`) all call `definition.store.write` directly. None takes `serializeResource` for the path.
  - `confirmFailedAdoption` is a read-modify-write that can set `lifecycle: 'completed'`. A fenced run on the same path (recovery of the same fence) is not excluded from the gap between its read and its write.
  - The start preflight (`capture-admission/durable-capture-start-preflight.ts:23,60-72`) blocks a start over an open record, so the first write is guarded by policy, not by the fence.
- Fix: route `confirmFailedAdoption` through `withDurableCaptureResourceFence` (it already has the expected fence), and either add a fenced "create" entry for the first write or correct the claim in `fence.ts`.
- Effort: M
- Model: opus (ADR 0024 concurrency contract)
- Verify: `pnpm vitest run packages/capture-kit/src/durable-capture` plus a new test that runs a fenced transition between the read and the write of `confirmFailedAdoption`.

### CAP2-12: `kernel/device.ts` documents the pre-collapse platform model and keeps leaf-string paths that no producer feeds
- Category: inconsistent
- Severity: low     Confidence: high for the comments; medium for "no producer"
- Evidence, all in `packages/kernel/src/device.ts`:
  - `:15-18` and `:25-28` say `Platform` no longer carries `ios`/`macos`. `:348-350` says "tvOS is modeled as the `ios` platform … (ADR-0009 defers the `Platform` collapse)".
  - `:309-317` — the comment on `isMobilePlatform` says it "preserves the pre-collapse `ios || android` set exactly"; the code also returns true for `harmonyos`.
  - `:358-359` — `isTvOsDevice` reads only `target === 'tv'`. `:372` — `runnerSynthesizesTap` excludes tvOS through that target test but excludes visionOS through `appleOs`. A device with `appleOs: 'tvos'` and no `target` passes as tap-synthesizing.
  - `:269` and `:380` — `(device.platform as string) === 'macos'` casts for "persisted pre-collapse records". A grep for `platform: 'macos'` in non-test source finds no `DeviceInfo` producer. `decodeDeviceIdentity` already refuses an Apple record without `appleOs` (`:469-470`), so durable records cannot carry the legacy shape.
  - `:385-388` marks `isPlatform` "@internal … exposed for unit tests"; it has production callers (`:449` and others outside this file).
- Fix: make `isTvOsDevice` read `resolveDeviceAppleOs(device) === 'tvos'` (it needs `appleOs` in its `Pick`), correct the three comments, and delete the two leaf-string casts after a check of session-state readers in the daemon slice.
- Effort: S for comments and `isTvOsDevice`; M for the cast removal
- Model: opus (device selection and tvOS input gating)
- Verify: `pnpm typecheck`; `pnpm vitest run packages/kernel/src/device*.test.ts`; daemon device-resolution suites.

### CAP2-13: Daemon enum tuples exist once privately in kernel and again as literals in two other packages
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence:
  - `packages/kernel/src/contracts.ts:52,113,115,117` — `DAEMON_LOCK_POLICIES`, `DAEMON_SERVER_MODES`, `DAEMON_TRANSPORT_PREFERENCES`, `SESSION_ISOLATION_MODES` are module-private and used only to derive types.
  - The same value lists are typed again at `packages/command-registry/src/flag-definitions-connection.ts:61,71,110,404` and `packages/remote/src/remote-config-schema.ts:38,39,41`.
  - `contracts.ts:119` exports `NETWORK_INCLUDE_MODES`, yet `packages/contracts/src/network-runtime-plan.ts:27` and `packages/command-registry/src/flag-definitions-action.ts:382` each hold their own copy.
  - A new mode added in one place type-checks in the others, because the flag `enumValues` are plain `string[]`.
- Fix: export the four tuples and import them (and `NETWORK_INCLUDE_MODES`) at the five flag and schema sites. Check `scripts/layering` allows `command-registry -> kernel/contracts` (it already imports kernel).
- Effort: S
- Model: sonnet
- Verify: `pnpm typecheck`; `pnpm vitest run scripts/layering packages/command-registry`.

### CAP2-14: Four PNG header readers with different trust rules, and a pixel-budget error that prints the wrong reason
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence:
  - `packages/capture-kit/src/png-format.ts:50-69` — `readPngHeader` checks signature, IHDR length, and CRC.
  - `packages/capture-kit/src/png-size.ts:4-15` — `readPngSize` checks only that bytes 12-16 are `IHDR`. No signature, no CRC.
  - `packages/capture-kit/src/screenshot-image-size.ts:18-34` — `validatePngPixels` walks every chunk up to `IEND` looking for `IHDR` (which is always first) and applies no CRC. This is the allocation-budget guard.
  - The PNG signature is declared three times: `png.ts:6`, `png-format.ts:13`, `png-encode.ts:15`.
  - `screenshot-image-size.ts:13` tests two JPEG bytes; `screenshot-image.ts:13` tests three for the same decision.
  - `screenshot-image-size.ts:73-83` — one message serves three conditions. A zero-area image, or an unsafe product with no limit set, reports "is 0 pixels, which exceeds the configured maxImagePixels limit of undefined".
- Fix: make `readPngSize` and `validatePngPixels` call `readPngHeader`; export one signature constant from `png-format.ts`; split the error into "invalid dimensions" and "exceeds limit".
- Effort: S
- Model: sonnet
- Verify: `pnpm vitest run packages/capture-kit/src/png-*.test.ts packages/capture-kit/src/screenshot-image*.test.ts`.

### CAP2-15: Full-image crop decodes the whole PNG to answer "no crop needed"
- Category: inefficient
- Severity: low     Confidence: high
- Evidence: `packages/capture-kit/src/png-crop-bytes.ts:17-27` — when the CRC-verified header shows that the box equals the image, the fast path is skipped and `cropDecodedPng` runs `decodePng` on the whole file (`:30`) only to reach `return null` at `:32`. The doc at `:8-10` names this as the expected case.
- Fix: return `null` at once when `header !== null && isFullImageBox(...)`. Keep the general reader for `header === null`.
- Effort: S
- Model: sonnet
- Verify: `pnpm vitest run packages/capture-kit/src/png-crop-bytes.test.ts`; add a case that a full-box crop of a truecolor PNG does not call the general decoder.

### CAP2-16: `readVideoContainerKind` says it sniffs bytes and dispatches on the file name; the MP4 check opens the file twice
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence:
  - `packages/capture-kit/src/recording/video.ts:261-265` — "sniffed from its bytes rather than its name".
  - `video.ts:278-281` — a path that ends in `.webm` is checked only as WebM; every other name is checked only as MP4. A WebM under another name reads as "no container". The web runtime's `.webm` requirement currently hides this.
  - `video.ts:286-290` — `findMp4Atom` is called twice (`ftyp`, `moov`); each call opens, stats, walks, and closes the file with sync I/O (`mp4-atoms.ts:20-31`). `mp4-duration.ts:40-47` then opens it two more times.
  - `video.ts:46-61` — a failed validator compile is removed from the cache, so on a host without `xcrun` each `isPlayableVideo` repeats lock, temp directory, and spawn.
- Fix: read the first bytes once and choose by EBML magic or `ftyp`; add `findMp4Atoms(filePath, paths[])` that walks once; cache a `TOOL_MISSING` validator result per cache root.
- Effort: S
- Model: sonnet
- Verify: `pnpm vitest run packages/capture-kit/src/recording/video.test.ts packages/capture-kit/src/recording/mp4-*.test.ts`.

### CAP2-17: Recording helper scripts can resolve from the current working directory
- Category: unneeded
- Severity: low     Confidence: medium (the path is the last candidate; no evidence that an install needs it)
- Evidence: `packages/capture-kit/src/recording/swift-cache.ts:43` adds `path.resolve(cwd, 'apple/runner/AgentDeviceRunner/RecordingScripts/<name>')`, and `:47-49` documents it as a "working-directory fallback". The resolved file is compiled with `swiftc` and executed (`:90-128`). In a broken install the daemon would build and run Swift source from whatever project the user is in. AGENTS.md allows fallback behaviour only on explicit request.
- Fix: remove the `cwd` candidate and the `cwd` parameter of `resolveRecordingScriptPath` and its callers; the missing-script error already lists the searched paths.
- Effort: S
- Model: sonnet
- Verify: `pnpm vitest run packages/capture-kit/src/recording/__tests__/swift-cache-recording-scripts.test.ts packages/capture-kit/src/recording/swift-cache.test.ts`; `pnpm build` and a packaged `record` smoke run.

### CAP2-18: Two copies of the diff-region accumulator, and a nearby-merge that is not transitive
- Category: inconsistent
- Severity: low     Confidence: high for the duplicate; medium for user-visible effect of the merge
- Evidence:
  - `packages/capture-kit/src/screenshot-diff-regions.ts:100-139` (`createDiffRegion`, `addPixelToRegion`) and `packages/capture-kit/src/screenshot-diff-region-split.ts:163-199` (`createEmptyRegion`, `addPixelToSlice`) build and update the same eleven-field `MutableDiffRegion` with the same statements.
  - `screenshot-diff-regions.ts:141-156` — `mergeNearbyRegions` merges each region into the first kept region within 12 px and never re-tests kept regions against each other. Two kept regions that become adjacent after one of them grows stay separate, so the result depends on scan order.
  - `:143` sorts the caller's array in place, and `:148` uses `merged.find`, which is the quadratic step the 2,000-region cap at `:58-61` exists to bound.
- Fix: move the accumulator into `screenshot-diff-region-types.ts` and use it from both files. Replace the single pass with union-find over a uniform grid of cell size `gapPx`, which also removes the need for the cap.
- Effort: S (dedupe), M (merge)
- Model: sonnet
- Verify: `pnpm vitest run packages/capture-kit/src/screenshot-diff.test.ts`; add a three-region chain case (A near B, B near C, A not near C) that must give one region.
