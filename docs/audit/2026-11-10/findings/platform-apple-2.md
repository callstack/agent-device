# SLICE APPLE2 — `packages/platform-apple/` (second pass: what APPLE did not reach)

## Coverage

Read after `platform-apple.md`; nothing below repeats APPLE-1..18.

- Read in full (every code line): `snapshot-source/{lifecycle,tree,protocol,bridge-source,adapter,transport,process,host,depth-hints,limits,deadline}.ts`, `detached-attempt.ts` (re-read for the lifecycle trace), `interactions.ts`, `runtime.ts`, `recording/{runtime,recovery,completion}.ts`, `core/perf.ts`, `core/perf-xctrace.ts`, `core/perf-target.ts`, `core/perf-xml.ts`, `core/perf-time-profile.ts`, `core/perf-process-identity.ts`, `perf/runtime.ts`, `core/debug-symbols.ts`, `core/debug-symbols/{crash-artifact,dsym,symbolication,utils}.ts`, `launch-confirmation.ts`, `os/macos/launch-services-registration.ts`, `system/runtime.ts`, `network/runtime.ts`, `logs/runtime.ts`, `logs/log-predicate.ts`, `snapshot-observability.ts`, `runtime-snapshot.ts`, `runner-snapshot-bridge.ts`, `snapshot-target.ts`, `snapshot-process.ts`, `core/app-device-io.ts`, `lifecycle.ts:500-652`.
- Read with comments stripped: `interactor.ts:60-556`, `snapshot-source/preparation.ts`.
- Tests: mechanical scans over all 150 test files (skip/only/todo: none; duplicate titles: none that matter; files without assertions: 4, all assert through helpers or `expectTypeOf`, and `tsconfig.json` type-checks `src`; real-timer sleeps; wall-clock assertions; weak matchers). Read in part: `core/__tests__/perf.test.ts`, `__tests__/alert.test.ts`, `snapshot-source/{protocol,preparation,adapter,lifecycle-fixtures,depth-hints}.test.ts`, `lifecycle.test.ts`, `core/__tests__/runner-host-types.test.ts`, `__tests__/simctl-facade.test.ts`. Roughly 5% of test lines read line by line.
- Not reached: `snapshot-presentation.ts`, `core/perf-frame.ts`, `core/debug-symbols/report.ts`, `navigation/runtime.ts` (first 30 lines only), `foldable/{pose,orientation,runner-panel,runtime}.ts`, `core/scroll.ts`, `os/macos/native-app-interactor.ts`, `runner-demand.ts`, `runner-interaction-facts.ts`, `gesture-facts.ts`, `logs/{start,doctor,descriptor}.ts`, `snapshot-source/{cache-identity,errors,types}.ts`, the Objective-C fixtures, `recording/validation.ts`, `doctor.ts`, and most test bodies.
- Combined with the first pass: about 75% of production lines read line by line.

Not verified on a device or a Mac: this container is Linux. Findings that need hardware say so.

## Findings

### APPLE2-1: An idle guest-bridge socket has no `error` listener, and the daemon exits on any uncaught exception
- Category: broken
- Severity: medium     Confidence: medium
- Evidence:
  - `packages/platform-apple/src/snapshot-source/host.ts:117-125` — on connect, `connectSnapshotBridge` removes its `error` and `close` listeners and hands the bare socket back.
  - `snapshot-source/transport.ts:124-134` — `roundTripSnapshotBridge` adds `error`/`close`/`data` listeners for one request and removes all of them in `finish`.
  - `snapshot-source/lifecycle.ts:36,221-225,335` — the session keeps that socket between requests, so it is listener-free whenever no request is in flight (and between connect and the first request).
  - `src/daemon.ts:58` — `process.on('uncaughtException', failFatally)`.
  - A Node `net.Socket` that emits `error` with no listener throws. The bridge is started with `--idle-timeout 60` (`host.ts:16,60-61`) and dies with its simulator, so the peer does go away while the socket is idle. A clean EOF is harmless; an `ECONNRESET` is not. I did not reproduce the reset on macOS, hence medium confidence.
- Fix: keep one permanent `error` listener for the socket's life (in `connectSnapshotBridge` after connect, or where the manager stores `session.socket`) that destroys the socket and emits a diagnostic. Files: `snapshot-source/host.ts` or `snapshot-source/lifecycle.ts`.
- Effort: S
- Model: opus (concurrency, daemon lifetime)
- Verify: unit test in `snapshot-source/host.test.ts` — connect, then `socket.emit('error', new Error('ECONNRESET'))` with no request in flight, and assert no throw and `socket.destroyed`.

### APPLE2-2: `network dump` fails outright when the optional simulator recovery pass takes longer than 4 s
- Category: broken
- Severity: medium     Confidence: medium
- Evidence:
  - `packages/platform-apple/src/network/runtime.ts:107-111` — `recoverSimulatorTraffic` runs `simctl spawn <udid> log show … --last 5m` (or `--start`) with `allowFailure: true, timeoutMs: 4_000` and no `try/catch`.
  - `packages/host-kit/src/internal/exec.ts:650-670` — a timeout throws `COMMAND_FAILED "… timed out after Nms"` regardless of `allowFailure`.
  - `network/runtime.ts:29-32` — the caller treats recovery as best effort (`if (recovery) …`), but the throw escapes `dumpAppleNetworkTraffic`, so the scan it already has is lost. The pass only runs when the primary scan found nothing, which is exactly when the user gets an error instead of "no entries".
  - Medium confidence because I did not trace `host.appleTools.run` (outside the slice) to confirm it keeps the exec timeout semantics; `network/runtime.test.ts:45,83` only asserts the `timeoutMs` value and has no timeout case.
- Fix: catch `isCommandTimeoutError` in `recoverSimulatorTraffic`, return `undefined`, and add a note that recovery timed out. Files: `network/runtime.ts`.
- Effort: S
- Model: sonnet
- Verify: new case in `network/runtime.test.ts` where `appleTools.run` rejects with a timeout error; expect a result with `entries: []` and a note.

### APPLE2-3: The recovery `log show` predicate is a stale copy of the live-stream predicate and drops the executable-name clauses
- Category: inconsistent
- Severity: medium     Confidence: medium
- Evidence:
  - `network/runtime.ts:131-139` `buildPredicate` is a copy of `logs/log-predicate.ts:5-12,58-60` (`buildAppleLogPredicate` with no executable).
  - The live simulator stream resolves the executable and adds `process == "<exe>"` and four image-path clauses (`logs/start.ts:167-170`, `log-predicate.ts:13-22`). The recovery pass does not.
  - The recovery predicate's `processImagePath ENDSWITH "/<bundleId>"` only matches when the executable is named like the bundle id. CFNetwork request lines carry the `com.apple.CFNetwork` subsystem, so without `process == "<exe>"` the pass that exists to find HTTP lines mostly cannot match them. Needs a simulator run to confirm the miss rate.
  - Same file, `:176-180`: on a simulator with an inactive log stream the note says "The iOS simulator recovery path scanned recent simctl log history" even when `canRecoverSimulator` was false and nothing was scanned.
- Fix: call `buildAppleLogPredicate(appBundleId, executableName)` from the recovery pass (resolve the executable the way `logs/start.ts` does, or carry it on the app-log snapshot) and delete `buildPredicate`; make the note conditional on recovery having run. Files: `network/runtime.ts`, `logs/log-predicate.ts`.
- Effort: S
- Model: sonnet
- Verify: `network/runtime.test.ts` asserting the predicate argv equals `buildAppleLogPredicate(...)`; simulator run of `network dump` after `logs` stream stop.

### APPLE2-4: Each simulator bridge snapshot spawns `ps -p <pid> -o lstart=` three times
- Category: inefficient
- Severity: medium     Confidence: high
- Evidence:
  - `packages/platform-apple/src/snapshot-process.ts:3-14` — the start-time read is a `ps` spawn.
  - `snapshot-target.ts:83-93` — `resolveTarget` verifies the cached target with one spawn on every capture (the router calls it per capture: `packages/capture-kit/src/snapshot-router/router.ts:420,441`; this channel sets `resolutionVerifiesIdentity: true` at `snapshot-route.ts:54`).
  - `snapshot-source/lifecycle.ts:122` → `readTargetStartTime` (`:508-531`) spawns again immediately and compares against the `target.processStartTime` that was verified a moment earlier.
  - `lifecycle.ts:124` → `assertTargetStillCurrent` (`:533-550`) spawns a third time after the exchange.
  - Snapshot is the hottest path (selector polling, `wait`), and the first two reads are back to back with nothing between them that could change the answer.
- Fix: drop the pre-exchange read when the resolver has just verified (pass the verified start time, or a "verified at" stamp, on the target), keeping only the post-exchange check. Files: `snapshot-source/lifecycle.ts`, `snapshot-target.ts`, `snapshot-source/types.ts`.
- Effort: S
- Model: opus (identity/staleness semantics)
- Verify: `snapshot-route.test.ts` or `snapshot-source/lifecycle.test.ts` counting `readTargetProcessStartTime` calls per capture (expect 2, then 1 if the resolver's read is reused).

### APPLE2-5: The "simulator runtime did not provide `ps`" memgraph branch is unreachable, and its test fakes an exec behavior production cannot produce
- Category: broken
- Severity: medium     Confidence: high
- Evidence:
  - `packages/platform-apple/src/core/perf.ts:627-637,642-650` — `isMissingIosSimulatorProcessToolError` needs a thrown `AppError` whose args contain `simctl spawn … ps` and whose text contains "no such file".
  - `core/perf-target.ts:174-183` — the only `simctl spawn ps` call uses `allowFailure: true`, so a non-zero exit returns a result and the function falls back to host `ps`. It never throws a process-exit error. The other call in that `try` is `get_app_container`, whose args do not contain ` ps `.
  - `core/__tests__/perf.test.ts:332-362` — the mock throws an `AppError` with `processExitError: true` for the simulator `ps` call, ignoring `allowFailure`. The test passes against a state the real exec seam cannot reach.
  - The host-`ps` fallback in `perf-target.ts:179-183` is also why `buildAppleMemorySamplingMetadata` says "with host ps fallback" (`perf.ts:337`); AGENTS.md allows fallbacks only on request.
- Fix: decide which behavior is wanted. Either delete the unreachable branch and its test, or remove the host-`ps` fallback and return a typed "process tools missing" result from `readAppleProcessSamples` (no text match). Files: `core/perf.ts`, `core/perf-target.ts`, `core/__tests__/perf.test.ts`.
- Effort: S
- Model: sonnet
- Verify: make the test mock honor `allowFailure` (return `{ exitCode: 2, … }`); the current test then fails, proving the branch is dead.

### APPLE2-6: Launch-confirmation handling is skipped on iPad simulators
- Category: broken
- Severity: medium     Confidence: low
- Evidence: `packages/platform-apple/src/lifecycle.ts:626-635` — `confirmableLaunchUrl` returns `undefined` unless `device.appleOs === 'ios'`. iPad simulators are classified `ipados` (`inventory-classification.ts:73`), so a custom-scheme launch URL on an iPad simulator gets no `Open in "<App>"?` answer. The same file's `isIosSimulator` (`:645-647`) uses `isIosFamily`, and `hasSimulatorBridge` uses `isHandheldAppleSimulator` (iPhone and iPad). The physical-device `appleOs === 'ios'` checks at `:449,589` have a test that pins iPadOS as deliberate (`lifecycle.test.ts:160`); this one has no test and no doc saying iPad is excluded. Low confidence: it may be an unverified-leaf decision; needs an iPad simulator run.
- Fix: use `isHandheldAppleSimulator(device)` if iPadOS shows the prompt, or add a test and a one-line constraint comment if the exclusion is deliberate. Files: `lifecycle.ts`, `lifecycle-launch-confirmation.test.ts`.
- Effort: S
- Model: opus (device behavior)
- Verify: `open <app> --url myscheme://…` on an iPad simulator per `docs/agents/device-verification.md`.

### APPLE2-7: Perf on macOS resolves the bundle with Spotlight and then demands an exact executable-path match
- Category: broken
- Severity: medium     Confidence: medium
- Evidence:
  - `packages/platform-apple/src/core/perf-target.ts:94-115` — `resolveMacOsBundlePath` runs `mdfind kMDItemCFBundleIdentifier == …` and takes the first `.app` line.
  - `core/perf-process-identity.ts:3-21` — when `executablePath` is set, a process matches only if its command starts with that exact path.
  - With two copies of an app on disk (a dev build plus `/Applications`, the case `os/macos/launch-services-registration.ts:38-43` documents), Spotlight's first hit can be the copy that is not running, and `perf memory`, `perf memory snapshot` and `perf cpu` report "No running process found". It also fails on hosts with Spotlight indexing off. The rest of the package resolves macOS apps without Spotlight (`os/macos/apps.ts:34`, `host-provider.ts`).
- Fix: resolve from the running process instead (`listHostProcesses` + the bundle-path parse already in `launch-services-registration.ts:204-210`), or try every `mdfind` hit. Files: `core/perf-target.ts`.
- Effort: M
- Model: opus (macOS host behavior)
- Verify: `core/__tests__/perf.test.ts` case with two `mdfind` lines where only the second is running.

### APPLE2-8: Recording invalidation logic is dead on the simulator path and inverted against its own comment; the daemon keys it on a string literal
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence:
  - `packages/daemon/src/sessions/request-recording-health.ts:40-44` — `invalidate` is only called when `recording.backend === 'runner AVAssetWriter' && recording.showTouches !== false`.
  - `packages/platform-apple/src/recording/completion.ts:27-29` and `:86-88` — both throw `recording invalidated` only when `invalidatedReason && !showTouches`, a state that producer cannot create. The comment at `:84-85` describes refusing when an overlay was promised, which is the opposite condition.
  - `completion.ts:72-118` `finalizeAppleRecordingFromCollected` is called only for `simctl` recordings (`recording/runtime.ts:185,252`), whose backend label is `'simctl recordVideo'`, so `snapshot.invalidatedReason` is never set there and `:86-89` is dead.
  - The label `'runner AVAssetWriter'` is an inline literal at `recording/runtime.ts:345`; the daemon matches the same literal. No shared constant, no test tying them together.
- Fix: delete the unreachable throws and the simulator-side `invalidatedReason` handling; export the runner backend label (or a typed `recorderKind`) from contracts and use it on both sides. Files: `recording/completion.ts`, `recording/runtime.ts`, `packages/daemon/src/sessions/request-recording-health.ts`.
- Effort: S
- Model: sonnet
- Verify: `recording/completion.test.ts` and `runtime.test.ts` still pass; `pnpm check:affected --run`.

### APPLE2-9: Runner-backed recording cleanup throws where every other cleanup returns `cleanup-pending`
- Category: inconsistent
- Severity: low     Confidence: medium
- Evidence: `packages/platform-apple/src/recording/runtime.ts:365-368` — the live handle's `cleanup` is `await stopRunner(); return { status: 'cleaned' }`, so a refused stop rejects. The simulator live cleanup maps failure to `{ status: 'cleanup-pending', reason: 'transport-failed' }` (`:432-445`), and so does the recovered runner cleanup (`recovery.ts:199-228`). `packages/capture-kit/src/screen-recording-live-handle.ts:54-60` passes the implementation's result through, so the caller sees a rejection for one backend and a typed outcome for the others. Medium confidence: I did not trace how the daemon treats a rejected `forceCleanup`.
- Fix: wrap `stopRunner()` in the same `try/catch` shape as `cleanupAppleSimulatorProcess`. Files: `recording/runtime.ts`.
- Effort: S
- Model: sonnet
- Verify: `recording/runtime.test.ts` case where the runner `stop` rejects; expect `cleanup-pending`.

### APPLE2-10: Race timers are never cleared: 45 s after every xctrace stop, and up to the full capture budget after every bridge request
- Category: inefficient
- Severity: low     Confidence: high
- Evidence:
  - `packages/platform-apple/src/core/perf-xctrace.ts:496-505` — `waitForAppleXctraceExit` races `wait` against a bare `setTimeout(resolve, timeoutMs)`; a graceful stop leaves a ref'd 45 s timer (`APPLE_XCTRACE_STOP_GRACE_TIMEOUT_MS`, `:45,464`). Same shape at `:450-457` (500 ms).
  - `snapshot-source/lifecycle.ts:591-605` — `waitForSimulatorTurn` races the queue against `waitForSnapshotSourceDelay(…, stop)`, but `stop` is the turn's close signal, so when `previous` wins nothing ends the delay. Each request leaves one timer plus two `abort` listeners on the caller's signal for the rest of `maxDurationMs` (5 s default, 120 s max). `bridgeExitOrClose` in the same file does this correctly with a `stopWaiting` controller (`:415-434`).
  - `lifecycle.ts:618-626` `waitForProcess`: same, 500 ms.
- Fix: clear the timer in a `finally` (or pass a local stop controller as `bridgeExitOrClose` does). Files: `core/perf-xctrace.ts`, `snapshot-source/lifecycle.ts`.
- Effort: S
- Model: sonnet
- Verify: `vi.getTimerCount() === 0` after a resolved request in `snapshot-source/lifecycle.test.ts` and after a stop in `core/__tests__/perf.test.ts`.

### APPLE2-11: The wire-vocabulary parity test pins constants that production code does not use
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence:
  - `packages/platform-apple/src/snapshot-source/protocol.ts:9-54` exports `SNAPSHOT_SOURCE_WIRE_KEYS`, `…_RESPONSE_KEYS`, `…_ATTRIBUTE_KEYS`. Their only reader is `protocol.test.ts:202-221`, and `.fallowrc.json:333-339` exempts them as test-only exports.
  - The code that actually builds requests uses its own literals (`protocol.ts:222-240`), and the code that decodes nodes uses a second copy of the attribute list (`tree.ts:14-27`, under a `fallow-ignore-next-line code-duplication`).
  - So there are three hand-kept lists (fixture JSON, constants, production literals) and the test compares the first two with the Objective-C source. Renaming a key in `createSnapshotBridgeDescribeRequest` or in `tree.ts` `ATTRIBUTE` leaves the parity test green.
  - The lists are also not the whole vocabulary: the runner transport reads `envelope.processStartTime` and sends `expectedPid`/`expectedProcessStartTime` (`runner-snapshot-bridge.ts:137-138,206`), none of which are listed.
- Fix: make production the source: derive `NODE_KEYS` in `tree.ts` from the exported attribute list, and have the test compare `Object.keys(createSnapshotBridgeDescribeRequest(fullInput))` with the fixture; then drop the fallow exemption and the duplication ignore. Files: `snapshot-source/protocol.ts`, `snapshot-source/tree.ts`, `snapshot-source/protocol.test.ts`, `.fallowrc.json`.
- Effort: S
- Model: sonnet
- Verify: rename one key in `createSnapshotBridgeDescribeRequest` locally and confirm `protocol.test.ts` fails.

### APPLE2-12: `tree.ts` decoder has an unreachable limit check, a triple `truncated` validation and per-node repeated work
- Category: unneeded
- Severity: low     Confidence: high
- Evidence:
  - `packages/platform-apple/src/snapshot-source/tree.ts:201-206` — `nodes.length > limits.maxNodes` cannot be true: `visitNode` throws at `nodes.length >= limits.maxNodes` before each push (`:241-245`).
  - `typeof truncated !== 'boolean'` is checked at `protocol.ts:298-300`, again at `bridge-source.ts:222-225`, and again at `tree.ts:213-215`; the `envelope` parameter of `decodeSnapshotBridgeTree` exists only for that third check.
  - `tree.ts:293-307` evaluates `elementTypeName(...)`, `optionalString(label)`, `optionalScalar(value)` and `optionalString(identifier)` twice per node, and `:326` does a linear `includes` over the 84-entry type table per node (up to 10 000 nodes per capture).
  - The depth bound is only checked after the whole tree is walked (`:207-212`), so a too-deep tree is fully decoded before it is refused.
- Fix: delete the dead check and the redundant `truncated` checks (keep the one in `acceptSnapshotBridgeEnvelope`), bind each computed value once, use a `Set` for the type names, and move the depth check into `visitNode`. Files: `snapshot-source/tree.ts`, `snapshot-source/bridge-source.ts`.
- Effort: S
- Model: sonnet
- Verify: `snapshot-source/tree.test.ts` (829 lines) stays green.

### APPLE2-13: `perf memory snapshot` reports two different method names for the same capture, one of them not a real tool
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence: `packages/platform-apple/src/perf/runtime.ts:64-69` returns `sampling.method: 'xcrun memgraph'`. The artifact and the support block in the same response carry `method: 'leaks-output-graph'` (`core/perf.ts:42,185,359`). There is no `xcrun memgraph` command; the capture is `leaks --outputGraph` (`perf.ts:199-211`).
- Fix: use `APPLE_MEMGRAPH_SNAPSHOT_METHOD` in `perf/runtime.ts` (export it through the perf host or contracts). Files: `perf/runtime.ts`, `core/perf.ts`.
- Effort: S
- Model: sonnet
- Verify: grep shows one method string; update the matching assertion in the perf runtime test.

### APPLE2-14: The xctrace background capture bypasses the Apple tool provider that the rest of perf uses
- Category: inconsistent
- Severity: low     Confidence: medium
- Evidence: `packages/platform-apple/src/core/perf-xctrace.ts:133` starts the capture with `runCmdBackground('xcrun', args, …)`. The timed record (`:274`) and every export (`:321`) go through `runXcrun`, which honors a scoped `AppleToolProvider` (`core/tool-provider.ts:88-91`). Target PIDs come from provider-scoped reads (`perf-target.ts`), so under a scoped provider `perf cpu start` would attach a local `xctrace` to PIDs from another host. Same file, `:340-345`: an "is not supported on Android" guard inside the Apple package, where `ownsDevice` already guarantees an Apple device (`runtime.ts:253`). Medium confidence: I did not check whether any scoped provider admits `perfNativeCapture`.
- Fix: add a background-spawn method to the tool provider, or refuse `startAppleXctracePerfCapture` when `hasScopedAppleToolProvider()`; delete the Android guard. Files: `core/perf-xctrace.ts`, `core/tool-provider.ts`.
- Effort: M
- Model: opus (provider boundary)
- Verify: `core/__tests__/perf.test.ts` under a scoped provider asserts no local `xcrun` spawn.

### APPLE2-15: The injected-runner interactor guards `readClipboard` but not `writeClipboard`
- Category: inconsistent
- Severity: low     Confidence: medium
- Evidence: `packages/platform-apple/src/interactor.ts:503-536` rejects `open`, `openDevice`, `close`, `screenshot`, `readClipboard`, `setSetting` and `readSetting` when no scoped tool provider exists, because they use local `simctl`/`devicectl`. `writeClipboard` is not in the list, yet on tvOS it runs `ensureBootedSimulator` plus `simctl pbcopy` locally (`core/app-device-io.ts:38-49`). On other simulators it goes through the runner, which is why the gap is tvOS only.
- Fix: guard `writeClipboard` when `isTvOsDevice(device)`. Files: `interactor.ts`.
- Effort: S
- Model: sonnet
- Verify: `__tests__/interactor-runner-provider.test.ts` case for a tvOS simulator.

### APPLE2-16: A frame-health sample runs three `xctrace export` processes one after another
- Category: inefficient
- Severity: low     Confidence: medium
- Evidence: `packages/platform-apple/src/core/perf.ts:414-422` awaits `exportIosDevicePerfTable` for `hitches`, `hitches-frame-lifetimes` and `device-display-info` in sequence; each is an `xcrun xctrace export` with a 15 s bound (`perf-xctrace.ts:41,320-324`) reading the same trace into different output files. `writeAppleXctracePerfReport` does the same for its two exports (`perf-xctrace.ts:215-228`). `xctrace export` start-up cost was not measured here.
- Fix: `Promise.all` the exports (they write distinct files), or one export with an XPath union. Files: `core/perf.ts`, `core/perf-xctrace.ts`.
- Effort: S
- Model: sonnet
- Verify: physical-device `perf frames` wall time before and after; unit tests unchanged.

### APPLE2-17: Stale and orphaned doc comments left by rewrites
- Category: unneeded
- Severity: low     Confidence: high
- Evidence:
  - `packages/platform-apple/src/recording/recovery.ts:270-275` and `:276-282` — two JSDoc blocks for `reattachSimulatorRecording`; the first is the superseded wording.
  - `recovery.ts:356-360` and `:361-365` — same for `recordingRemains`.
  - `recovery.ts:40-48` — a JSDoc for the coordinates type sits above a second JSDoc and a `const`, so it documents nothing.
  - `runtime.ts:482-486` — a JSDoc at end of file for a helper ("One helper so the binding below reads as a list…") that now lives in contracts as `whenAdmitted`.
  - `system/runtime.ts:92-96` — a "Read and write share one cell" JSDoc stranded above an unrelated constant's JSDoc.
- Fix: delete the stale block of each pair and the orphans. Files as listed.
- Effort: S
- Model: sonnet
- Verify: `pnpm format` and `pnpm lint`.

### APPLE2-18: Bridge timing and log bounds are repeated as bare literals with different units
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence:
  - The 2 s readiness wait appears as `2000` at `snapshot-source/adapter.ts:45`, `lifecycle.ts:95` and `lifecycle.ts:237`, and as the named `SNAPSHOT_BRIDGE_PREPARATION_WAIT_BUDGET_MS` in `preparation.ts`.
  - The 10 s session-start bound is `10000` twice in `lifecycle.ts:298-300`, once as a `setTimeout` and once as a deadline, so one bound is enforced by two mechanisms; the named neighbors are at `:26-29`.
  - `MAX_PROCESS_LOG_BYTES = 64 * 1024` is defined in `host.ts:17`, where it bounds UTF-16 code units (`:152-157`), and in `process.ts:7`, where it bounds bytes (`:38-42`) of the string the host already trimmed.
- Fix: name the two durations once in `snapshot-source/limits.ts`; drop the second expiry timer; keep one log bound. Files: `snapshot-source/{adapter,lifecycle,host,process,limits}.ts`.
- Effort: S
- Model: sonnet
- Verify: `snapshot-source/*.test.ts`.

### APPLE2-19: `interactions.ts` carries duplicate command builders and an injection parameter with one constant caller
- Category: unneeded
- Severity: low     Confidence: high
- Evidence:
  - `packages/platform-apple/src/interactions.ts:120-130` (`doubleTap` override) and `:291-302` (`runSingleApplePress` double-tap branch) build and parse the same one-step sequence command.
  - `:98-100` (`tap`) and `:146-148` (`focus`) are the same call.
  - `runAppleScroll` (`:430-437`) and `runMacosDesktopScroll` (`os/macos/desktop-scroll.ts:18`) take a `runRunnerCommand` parameter; the only call site passes the module's own `runAppleRunnerCommand` (`:183-190`) and no test passes anything else (grep across `src`).
- Fix: one `runDoubleTap(device, ctx, runnerOpts, point)` helper used by both; `focus: overrides.tap`; drop the parameter. Files: `interactions.ts`, `os/macos/desktop-scroll.ts`.
- Effort: S
- Model: sonnet
- Verify: `interactions.test.ts` and `__tests__/interactions-*-runner-requests.test.ts`.

### APPLE2-20: A few tests assert on wall-clock time
- Category: broken
- Severity: low     Confidence: medium
- Evidence:
  - `packages/platform-apple/src/snapshot-source/preparation.test.ts:135-142` — a real `delay(150)` followed by `Date.now() - joined < 500`.
  - `snapshot-source/lifecycle.test.ts:168-174` — a real 10 ms abort timer followed by `Date.now() - startedAt < 100`.
  - `snapshot-source/adapter.test.ts:290` — `performance.now() - startedAt` on real timers.
  - `lifecycle.test.ts:447-456` — a real 500 ms `setTimeout` race standing in for "did not await runner readiness".
  - The module under test already takes an injected clock (`preparation.ts` `now`, `detached-attempt.ts` `now`), and the neighboring tests use `vi.useFakeTimers` (`adapter.test.ts:352`, `lifecycle.test.ts:339`). These pass or fail by host load, not by behavior.
- Fix: use fake timers or the injected clock and assert on call counts or ordering. Files: the four tests above.
- Effort: S
- Model: sonnet
- Verify: run each test under `stress-ng`-style load, or 50 repeats with `--retry 0`.

### APPLE2-21: `debug symbols` does avoidable sequential spawns and stats
- Category: inefficient
- Severity: low     Confidence: high
- Evidence: `packages/platform-apple/src/core/debug-symbols/symbolication.ts:96-101` awaits `xcrun --find dwarfdump` and then `xcrun --find atos`; `:12-17` runs one `atos` per image group in sequence (30 s bound each); `dsym.ts:42-55` stats every directory that `readHostDirectory(..., { withFileTypes: true })` has already reported as a directory. This is a one-shot CLI workflow, so the cost is seconds, not a hot path.
- Fix: `Promise.all` the two `--find` calls and the `atos` groups (bounded); skip the per-entry stat below the root. Files: `core/debug-symbols/{symbolication,dsym}.ts`.
- Effort: S
- Model: sonnet
- Verify: `core/__tests__/debug-symbols.test.ts`.
