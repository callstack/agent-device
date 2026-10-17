# ADR-0023: end-state entry-to-platform hop trace

## Status

Reference trace for the entry-to-platform hop counts in ADR 0019 and the coupling audit in ADR 0022.

## Rules at a glance

- Count each distinct production `.ts` file once on the main path, including both endpoints.
- Exclude type-only imports, files that supply only types, side-calls, response-only files, and untraced forks from hop counts.
- Trace the snapshot runner fallback with an existing runner session.
- Assign exactly one role to each file.
- Apply the deletion test to each pass-through/translation hop.
- Treat 38/29 and the ≤14 target as superseded.
  The audit endorses only the collapse of the proven removable `commands/runtime-types.ts` hop.
  Any further target requires a decision to fold cross-cutting request-scope wrappers.

This trace supports the "Entry-to-platform hop count" paragraph in
[0019-request-bound-platform-runtime.md](./0019-request-bound-platform-runtime.md#end-state-proposed-2026-09-02-maintainer-decision-pending).
That paragraph cited 38 hops for `press`/Android and 29 for `snapshot`/iOS without an ordered route, definition, or linked artifact.
This file supplies all three.

This revision replaces the superseded 23/24 tables recorded at `132ffe1da`.
It keeps the counting definition stable so the numbers remain comparable.

## Counting definition

- **Unit:** one distinct production `.ts` file entered on the call path.
  Count each file once, even on re-entry.
  A lazy `import()` of an already-counted file adds no hop.
  Type-only imports and files that supply only types add no hops.
- **Range:** from daemon HTTP entry `packages/daemon/src/server/http/http-server.ts` to the file that issues the concrete platform call.
  Include both endpoints.
  For `press`/Android, the terminal call is the serial-scoped `adb shell input tap` invocation.
  For `snapshot`/iOS, it is AX bridge `socket.write` on the primary arm or XCTest runner `fetch()` on the fallback arm.
- **Main chain only:** follow the first call that continues toward the platform call.
  Do not trace every branch.
  `handleSnapshotCommands` also routes `alert`/`settings`/`diff`/`wait`; this trace follows only plain `snapshot`.
  Side-calls that construct records within a hop do not count.
  For example, `*RuntimeOperationFacts` builders inside per-request owner `inspectFacts` appear separately as admission fan-out.
  Request-spine guards and liveness side effects also do not count:
  - `timingSafeStringEqual` compares the auth token.
  - `throwIfRequestCanceled` gates cancellation.
  - `cancel()` resets the idle-reap timer.
  - Android freshness guard/clear maintains freshness state.
  These are sibling statements of the continuation, not calls that advance toward the platform.
  Files that execute only after the platform call appear separately as response-path files.
  The freshness clear is one such response call.
- **Steady state:** trace the snapshot fallback with an existing runner session.
  The cold-start lease, xctestrun build through xcodebuild, and process launch form a separate fork.
- **Per-file role:** assign exactly one role:
  - **policy:** decides admission, limits, retry, or routes and can refuse or redirect a request.
  - **orchestration:** coordinates multiple calls, binds/runs a runtime, or assembles the object graph needed by later hops.
  - **translation:** maps values/shapes without issuing the platform call, such as argv construction, wire encoding, or target resolution.
  - **adapter:** encapsulates an external system boundary, for example a subprocess, a socket, or a fetch.
    The terminal adapter issues the platform call.
  - **pass-through:** delegates to exactly one next call on the path without a branch or transformation.
    Examples include lazy-load indirection, a one-line re-export/delegate, and a scope wrapper.
- **Deletion test:** apply this test to each pass-through/translation hop.
  Can the caller, the callee, or both inline the handoff of the hop without loss of admission, budget, isolation, a declared boundary named in an ADR, or a testability seam?
  The test evaluates the hop, not the file.
  A REMOVABLE hop is a collapse candidate, not a file to delete.
- **Method:** use this sequence:
  1. Read the file.
  2. Find the exported entry function that the caller reaches.
  3. Follow its first call that continues toward the platform call.
  4. Record the file and the one function that hands control to the next hop.
- **Commit measured at:** `27a97ee619`, re-traced for #2278.
  It supersedes the `132ffe1da` tables.

## `press` / Android: HTTP entry → `adb input tap`

41 files: 11 pass-through, 5 translation, 5 policy, 19 orchestration, 1 terminal (adapter).

The request spine also executes side-calls on every request.
They do not continue toward the platform boundary and therefore are not hops:

- `packages/daemon/src/sessions/server/daemon-idle-reap.ts`: `cancel()` resets the liveness timer beside `dispatchRequest`.
- `packages/host-kit/src/internal/transport.ts`: `timingSafeStringEqual` compares the auth token before continuation.
- `packages/host-kit/src/internal/request-cancel.ts`: `throwIfRequestCanceled` gates the `task()` continuation inside `runLocked`/`runAdmitted`.

| # | File | Hand-off | Role | Delete-test |
|---|------|----------|------|-------------|
| 1 | `packages/daemon/src/server/http/http-server.ts` | Parses `/rpc`. Resolves the token. Calls injected `handleRequest` | pass-through | KEEP — HTTP entry boundary |
| 2 | `packages/daemon/src/server/http/daemon-runtime.ts` | `handleRequest`: counts in-flight requests; cancels idle reap; calls `dispatchRequest` | orchestration | KEEP — request lifecycle orchestration |
| 3 | `packages/daemon/src/server/request-router.ts` | auth, flag guards, scope creation, locked execution, handler chain | orchestration | KEEP — request admission + dispatch core |
| 4 | `packages/host-kit/src/internal/diagnostics.ts` | `withDiagnosticsScope` calls the task within the request scope | pass-through | KEEP — per-request diagnostic attribution |
| 5 | `src/request/device-inventory-context.ts` | `withDeviceInventoryContext` calls the task within the scope | pass-through | KEEP — request-scoped device inventory context |
| 6 | `src/core/dispatch-resolve.ts` | `withResolveTargetDeviceCacheScope` calls the task within the scope | orchestration | KEEP — per-request target-resolution cache |
| 7 | `packages/daemon/src/server/request-execution-scope.ts` | `createRequestExecutionScope`; `runLocked`/`runAdmitted` | orchestration | KEEP — scoped execution + lock/claim admission |
| 8 | `src/provider-device-runtime.ts` | `withProviderDeviceRuntimeScope` (`AsyncLocalStorage.run`) | pass-through | KEEP — provider-runtime scope boundary |
| 9 | `packages/daemon/src/sessions/request-handler-chain.ts` | `runRequestHandlerChain` routes to the interaction handler | orchestration | KEEP — command routing |
| 10 | `packages/daemon/src/execution/interaction/index.ts` | route facade delegates to `handleInteractionCommands` | orchestration | KEEP — shared interaction route facade |
| 11 | `packages/daemon/src/execution/interaction/internal/interaction.ts` | switches `press` to `dispatchTargetedTouchViaRuntime` | policy | KEEP — touch command routing |
| 12 | `packages/daemon/src/execution/interaction/internal/interaction-touch-press.ts` | admits the touch, dispatches the runtime interaction | orchestration | KEEP — press admission + orchestration |
| 13 | `packages/daemon/src/execution/interaction/internal/interaction-touch-prepare.ts` | `prepareTouchDispatch` → `resolveBoundTouchRuntime` | translation | KEEP — shared admission + bind seam |
| 14 | `packages/daemon/src/core/touch-runtime.ts` | resolves the plan, `bind(device, tapPointUse)` | orchestration | KEEP — tap runtime binding |
| 15 | `packages/daemon/src/core/runtime-admission.ts` | `admitRuntimeOperations`: `inspectFacts`, per-op admission | policy | KEEP — per-operation admission |
| 16 | `packages/daemon/src/core/request-runtime-binding.ts` | `bindDevice`: per-device-cached `gateway.bind` | orchestration | KEEP — device runtime binding |
| 17 | `src/platform-runtime-gateway.ts` | `loadLocal` → `loadHost` → `loadRuntime` | orchestration | KEEP — gateway boundary |
| 18 | `src/platform-runtime.ts` | connects the Android module, supplies `loadHost` | pass-through | KEEP — declared ADR §1/§2 registry boundary |
| 19 | `src/platform-runtime-operation-host.ts` | `createPlatformRuntimeHost` assembles the host | orchestration | KEEP — host composition |
| 20 | `packages/platform-android/src/index.ts` | `loadRuntime` pairs the plugin with the runtime module | pass-through | KEEP — declared ADR §2 `loadRuntime` boundary |
| 21 | `packages/platform-android/src/runtime.ts` | `bind`: `inspectFacts` (fan-out site), builds the tap operation | orchestration | KEEP — Android runtime owner |
| 22 | `packages/contracts/src/local-interactor-operation-set.ts` | `bindLocalInteractorOperationSet` → `bindLocalTouchInteractor` | translation | KEEP — tap op mapped to the interactor |
| 23 | `packages/daemon/src/resources/device/device-claim-admission.ts` | `admit`: owner claim rule; ordinary owner | policy | KEEP — device claim admission |
| 24 | `packages/daemon/src/execution/interaction/internal/interaction-touch-runtime.ts` | `dispatchRuntimeInteraction` → `createInteractionRuntimeForRoute` | orchestration | KEEP — interaction runtime dispatch |
| 25 | `packages/daemon/src/execution/interaction/internal/interaction-runtime.ts` | `createInteractionAgentDevice` with the executor backend | orchestration | KEEP — agent device construction |
| 26 | `src/runtime.ts` | `createAgentDevice`: backend + `bindCommands` | orchestration | KEEP — agent device facade |
| 27 | `src/commands/index.ts` | `bindCommands` → `bindInteractionCommands` | orchestration | KEEP — command catalog boundary |
| 28 | `src/commands/interaction/runtime/index.ts` | `bindInteractionCommands`: `press` → `pressCommand` | orchestration | KEEP — nine-command binding surface |
| 29 | `packages/daemon/src/execution/interaction/internal/interaction-touch-android-readiness.ts` | `runWithAndroidDialogReadinessCheck` wraps `run` | policy | KEEP — blocking-dialog readiness gate |
| 30 | `src/commands/interaction/runtime/interactions.ts` | `pressCommand` → `tapCommand`: resolve target, `backend.tap` | orchestration | KEEP — tap command execution |
| 31 | `src/commands/interaction/runtime/resolution.ts` | `resolveInteractionTarget` applies guards, returns the point | translation | KEEP — tap target resolution |
| 32 | `packages/contracts/src/interactor-operation-binding.ts` | `interactorFor` resolves the local interactor | translation | KEEP — shared interactor resolution seam |
| 33 | `src/platform-runtime-local-application-interactors.ts` | `resolve()` lazy-imports `core/interactors` | pass-through | KEEP — lazy host interactor port |
| 34 | `src/core/interactors.ts` | `getLocalInteractor` → `getPlugin(platform).createInteractor` | pass-through | KEEP — provider vs local interactor dispatch |
| 35 | `src/core/interactors/register-builtins.ts` | android plugin entry lazy-imports `./android.ts` | pass-through | KEEP — platform plugin registry |
| 36 | `src/core/interactors/android.ts` | `createAndroidInteractor`: `tap` → `pressAndroid` | orchestration | KEEP — interactor construction |
| 37 | `packages/platform-android/src/input-actions.ts` | `pressAndroid` builds the `shell input tap` argv | translation | KEEP — shared argv construction |
| 38 | `packages/platform-android/src/adb.ts` | `runAndroidAdb` → `resolveAndroidAdbExecutor` | pass-through | KEEP — single adb executor seam |
| 39 | `packages/platform-android/src/adb-provider-scope.ts` | `resolveAndroidAdbExecutor` picks the device-scoped executor | policy | KEEP — executor scoping |
| 40 | `packages/platform-android/src/adb-failure.ts` | `withAdbFailureHints` wraps the executor call | pass-through | KEEP — typed adb failure classification |
| 41 | `src/platform-runtime-android-adb-host.ts` | `execSerialAdb` issues the serial-scoped tap invocation | **terminal (adapter)** | n/a (terminal) |

The terminal invokes host-kit's shared `runCmd` in `packages/host-kit/src/internal/command.ts`.
The snapshot route counts this generic subprocess adapter; this route adds no separate hop for it.
The baseline likewise ended at the route-level issue point, `adb.ts`, although the executor below it spawned the process.
At the traced HEAD, the equivalent boundary is `adb-host`.
Only its named composition module binds this named root file, per ADR Decision section 1.

**Admission fan-out (not hops).**
The Android owner's per-request `inspectFacts` in `packages/platform-android/src/runtime.ts` calls 23 distinct `*RuntimeOperationFacts` builders as side-calls.
Each name below has a `-runtime.ts` suffix under `packages/contracts/src/`:

- `application-lifecycle`
- `alert`
- `app-event`
- `app-switcher`
- `audio-probe`
- `back`
- `clipboard`
- `element-text`
- `focus`
- `gesture`
- `home`
- `keyboard`
- `orientation`
- `perf`
- `screenshot`
- `scroll`
- `selector-observation`
- `settings`
- `snapshot`
- `touch`
- `type-text`
- `tv-remote`
- `viewport`

**Response path (not hops).** These 8 files execute only after the platform call:

- `packages/daemon/src/execution/interaction/internal/interaction-touch-response.ts`
- `packages/daemon/src/execution/interaction/internal/interaction-common.ts`
- `packages/daemon/src/core/interaction-surface-signature.ts`
- `packages/daemon/src/server/request-finalization.ts`
- `packages/session-journal/src/session-event-log.ts`
- `packages/daemon/src/execution/session-snapshot.ts`
- `packages/daemon/src/core/recording-gestures.ts`
- `packages/daemon/src/core/deferred-interaction-outcome.ts`

**Forks not followed:**

- `request-platform-provider-context.ts`: the router returns early for a bare local daemon with zero runtimes and a non-web target.
- `platform-runtime/request-providers.ts`: only `requestPlatformProviders.run` calls it; local execution does not.
- `lease-registry.ts`: `isHumanControlMutation` is false for an agent-surface press.
- `interaction-touch-press.ts`: the `@ref` and direct-iOS fast paths.
- `adb-provider-scope.ts`: the provider-adb arm.
- `adb-failure.ts`/`adb-host.ts`: error-path arms.

## `snapshot` / iOS Simulator: HTTP entry → AX bridge `socket.write` (primary) / runner `fetch` (fallback)

The route branches at `packages/platform-apple/src/snapshot-route.ts` through `route.capture`, `isEligible`, and the per-generation circuit breaker.
The in-simulator AX bridge is primary.
The XCTest runner is fallback under any of these conditions:

- `isEligible` returns false.
- AX acquisition fails.
- Single-flight target discovery has not settled within this capture's `TARGET_DISCOVERY_WAIT_MS` wait in `snapshot-target.ts`.

The discovery probe continues. Later captures join it.
The shared prefix contains 30 files.
The primary arm contains 47 distinct files: 30 + 17.
The fallback arm contains 49 distinct files: 30 + 19.
The union contains 66 distinct files.

Idle-reap reset, auth comparison, cancellation, and Android freshness guard/clear are side-calls on the prefix.
They execute beside the continuation and do not count as hops.
`packages/daemon/src/core/session-snapshot-freshness.ts` reads the guard, and after capture it clears the guard.
The clear has no effect on iOS.

### Shared prefix (entry → fork)

| # | File | Hand-off | Role | Delete-test |
|---|------|----------|------|-------------|
| 1 | `packages/daemon/src/server/http/http-server.ts` | Parses `/rpc`. Resolves the token. Calls injected `handleRequest` | pass-through | KEEP — HTTP entry boundary |
| 2 | `packages/daemon/src/server/http/daemon-runtime.ts` | `handleRequest`: counts in-flight requests; cancels idle reap; calls `dispatchRequest` | orchestration | KEEP — request lifecycle orchestration |
| 3 | `packages/daemon/src/server/request-router.ts` | auth, flag guards, scope creation, locked execution, handler chain | orchestration | KEEP — request admission + dispatch core |
| 4 | `packages/host-kit/src/internal/diagnostics.ts` | `withDiagnosticsScope` calls the task within the request scope | pass-through | KEEP — per-request diagnostic attribution |
| 5 | `src/request/device-inventory-context.ts` | `withDeviceInventoryContext` calls the task within the scope | pass-through | KEEP — request-scoped device inventory context |
| 6 | `src/core/dispatch-resolve.ts` | `withResolveTargetDeviceCacheScope` calls the task within the scope | orchestration | KEEP — per-request target-resolution cache |
| 7 | `packages/daemon/src/server/request-execution-scope.ts` | `createRequestExecutionScope`; `runLocked`/`runAdmitted` | orchestration | KEEP — scoped execution + lock/claim admission |
| 8 | `src/provider-device-runtime.ts` | `withProviderDeviceRuntimeScope` (`AsyncLocalStorage.run`) | pass-through | KEEP — provider-runtime scope boundary |
| 9 | `packages/daemon/src/sessions/request-handler-chain.ts` | `runRequestHandlerChain` routes `snapshot` to `runSnapshotHandler` | orchestration | KEEP — command routing |
| 10 | `packages/daemon/src/sessions/handlers/snapshot.ts` | `handleSnapshotCommands` routes the plain arm | policy | KEEP — snapshot command routing |
| 11 | `packages/daemon/src/sessions/snapshot-runtime.ts` | `dispatchSnapshotViaRuntime` → `params.execute` | pass-through | KEEP — snapshot execute seam (route tests pin it) |
| 12 | `packages/daemon/src/sessions/snapshot-command-runtime.ts` | resolves the bound capture; wires session/backend; runs the op | orchestration | KEEP — capture wiring + recording |
| 13 | `packages/daemon/src/core/deferred-interaction-outcome.ts` | `resolveDeferredInteractionOutcome` before a fresh capture | policy | KEEP — pending-outcome settlement (may short-circuit) |
| 14 | `packages/daemon/src/core/snapshot-capture.ts` | `resolveSnapshotScope` + the capture attempt | orchestration | KEEP — capture attempt + scope resolution |
| 15 | `packages/daemon/src/core/snapshot-session.ts` | `resolveSessionDevice` for the capture | translation | KEEP — snapshot session/device resolution |
| 16 | `packages/daemon/src/core/snapshot-runtime-binding.ts` | `resolveBoundSnapshotCaptureRuntime`: admit-then-bind | policy | KEEP — ADR 0019 §9 admit-then-bind seam |
| 17 | `packages/daemon/src/core/session-runtime-admission.ts` | `admitRuntimePlan` (fan-out site) / `requireRuntimeBinding` | policy | KEEP — runtime plan fact admission |
| 18 | `packages/daemon/src/core/request-runtime-binding.ts` | `bindDevice`: per-device-cached `gateway.bind` | orchestration | KEEP — device runtime binding |
| 19 | `src/platform-runtime-gateway.ts` | `loadLocal` → `loadHost` → `loadRuntime` | orchestration | KEEP — gateway boundary |
| 20 | `src/platform-runtime.ts` | connects the Apple module, supplies `loadHost` | pass-through | KEEP — declared ADR §1/§2 registry boundary |
| 21 | `src/platform-runtime-operation-host.ts` | `createPlatformRuntimeHost` assembles the host | orchestration | KEEP — host composition |
| 22 | `packages/platform-apple/src/index.ts` | `loadRuntime` pairs the plugin with the runtime module | pass-through | KEEP — declared ADR §2 `loadRuntime` boundary |
| 23 | `packages/platform-apple/src/runtime.ts` | `bind` → `bindAppleSnapshotRuntime` | orchestration | KEEP — Apple runtime owner |
| 24 | `packages/platform-apple/src/runtime-snapshot.ts` | `bindAppleSnapshotRuntime` wires the AX and fallback closures | orchestration | KEEP — AX/runner wiring (tests pin it) |
| 25 | `packages/platform-apple/src/snapshot-route.ts` | `createAppleSnapshotRoute`; `isEligible` + circuit breaker | policy | KEEP — AX/runner route + breaker (the fork) |
| 26 | `src/runtime.ts` | `createAgentDevice`: the bound runtime object | orchestration | KEEP — agent device facade |
| 27 | `src/commands/index.ts` | `bindCommands` binds the command catalog | orchestration | KEEP — command catalog boundary |
| 28 | `src/commands/runtime-types.ts` | `bindRuntimeCommands` wraps the runtime into closures | pass-through | REMOVABLE — thin closure wrapper; depth lives in the commands |
| 29 | `src/commands/capture/runtime/snapshot.ts` | `snapshotCommand`: parses input, calls `runtime.backend.captureSnapshot` | orchestration | KEEP — capture command implementation |
| 30 | `packages/contracts/src/snapshot-runtime.ts` | the `captureSnapshot` op → AX route or interactor fallback | pass-through | KEEP — cross-layer contract seam (ownership refusal + signal join) |

### Arm A — primary (in-simulator AX bridge), 17 files

| # | File | Hand-off | Role | Delete-test |
|---|------|----------|------|-------------|
| 1 | `packages/platform-apple/src/snapshot-target.ts` | `resolveTarget`: simctl + device-list probe | translation | KEEP — target identity/generation contract |
| 2 | `packages/platform-apple/src/core/apps-simctl.ts` | `runSimctl`: simctl argv + execution | translation | KEEP — shared simctl argv convention |
| 3 | `packages/platform-apple/src/core/simctl.ts` | `buildSimctlArgsForDevice`: device-set arg scoping | translation | KEEP — simulator device-set args |
| 4 | `packages/platform-apple/src/core/tool-provider.ts` | `runXcrun`: scoped tool executor | adapter | KEEP — scoped tool-execution injection seam |
| 5 | `packages/platform-apple/src/os/macos/host-provider.ts` | `createLocalAppleMacOsHostProvider` at module init | adapter | KEEP — local macOS tool provider |
| 6 | `packages/platform-apple/src/snapshot-process.ts` | `readSnapshotTargetProcessStartTime` via `ps` | pass-through | KEEP — stale-target staleness guard |
| 7 | `packages/platform-apple/src/snapshot-source-facade.ts` | lazy-imports `snapshot-source/adapter.ts`; `acquire` closure | pass-through | KEEP — lazy-load startup isolation |
| 8 | `packages/platform-apple/src/snapshot-source/adapter.ts` | `acquire`: validate, prepare, `manager.request` | orchestration | KEEP — AX bridge acquisition pipeline |
| 9 | `packages/platform-apple/src/snapshot-source/limits.ts` | `resolveSnapshotSourceLimits` per acquire | policy | KEEP — acquisition limit budgets |
| 10 | `packages/platform-apple/src/snapshot-source/deadline.ts` | `createSnapshotSourceDeadline` per acquire | policy | KEEP — acquisition deadline budget |
| 11 | `packages/platform-apple/src/snapshot-source/cache.ts` | `ensureSnapshotBridgeBinary`: cache admit, cold clang compile | policy | KEEP — bridge binary cache + cold compile |
| 12 | `packages/platform-apple/src/snapshot-source/lifecycle.ts` | per-udid session lock; `ensureSession`, `exchange` | orchestration | KEEP — bridge session lifecycle + lock |
| 13 | `packages/platform-apple/src/snapshot-source/protocol.ts` | frame encode/decode; envelope parse | translation | KEEP — wire frame codec (tests pin frames) |
| 14 | `packages/host-kit/src/internal/command.ts` | `runCmd`/`runCmdBackground`: bridge spawn | adapter | KEEP — shared subprocess adapter |
| 15 | `packages/host-kit/src/internal/process.ts` | `hostProcessId`/`readProcessStartTime`: lock ownership | adapter | KEEP — lock owner process identity |
| 16 | `packages/host-kit/src/internal/host-file.ts` | file operations for socket/bridge directories | adapter | KEEP — bridge socket file operations |
| 17 | `packages/platform-apple/src/snapshot-source/transport.ts` | `roundTripSnapshotBridge`: `socket.write` at :107 | **terminal (adapter)** | n/a (terminal) |

### Arm B — fallback (XCTest runner, steady state), 19 files

| # | File | Hand-off | Role | Delete-test |
|---|------|----------|------|-------------|
| 1 | `src/platform-runtime-local-application-interactors.ts` | `resolve()` lazy-imports `core/interactors` | pass-through | KEEP — lazy host-port seam |
| 2 | `src/core/interactors.ts` | `getLocalInteractor` → `getPlugin(platform).createInteractor` | pass-through | KEEP — local-owner authority vs provider scoping |
| 3 | `src/core/platform-plugin-registry.ts` | `getPlugin` lookup; throws `UNSUPPORTED_PLATFORM` | policy | KEEP — platform plugin registry |
| 4 | `packages/platform-apple/src/interactor.ts` | `captureAppleRunnerSnapshot` builds the command payload | orchestration | KEEP — interactor contract implementation |
| 5 | `packages/platform-apple/src/core/runner-client.ts` | re-export entry for the runner client | pass-through | KEEP — client composition root |
| 6 | `packages/platform-apple/src/runner/client.ts` | `createAppleRunnerClient` at module init | orchestration | KEEP — runner client factory |
| 7 | `packages/platform-apple/src/runner/runner-client.ts` | `runAppleRunnerCommand`: read-only retry, `waitForRunner` | policy | KEEP — runner command dispatch + retry |
| 8 | `packages/platform-apple/src/runner/host.ts` | `bindAppleRunnerHost`: retry/diagnostic/Deadline delegates | adapter | KEEP — injected host seam (runner tests stub it) |
| 9 | `packages/platform-apple/src/runner/runner-command-traits.ts` | `isReadOnlyRunnerCommand`: snapshot is read-only | policy | KEEP — command trait classification |
| 10 | `packages/platform-apple/src/runner/runner-contract.ts` | command id, request signal, active assertion | policy | KEEP — runner request contract |
| 11 | `packages/host-kit/src/internal/retry.ts` | `retryWithPolicy`: bounded retry loop | policy | KEEP — retry policy |
| 12 | `packages/kernel/src/keyed-lock.ts` | `withKeyedLock` for session/lease locks | policy | KEEP — named lock primitive |
| 13 | `packages/platform-apple/src/runner/runner-lifecycle.ts` | `executeRunnerCommand`: session snapshot, `ensureRunnerSession` | orchestration | KEEP — runner command execution |
| 14 | `packages/platform-apple/src/runner/runner-session.ts` | steady `resolveReusableRunnerSession` → `executeRunnerCommandWithSession` | orchestration | KEEP — session reuse + preflight |
| 15 | `packages/platform-apple/src/runner/runner-recycle-ledger.ts` | ledger key, touched-session check/mark | policy | KEEP — recycle budget ledger |
| 16 | `packages/platform-apple/src/runner/runner-disposal.ts` | `isRunnerProcessAlive` liveness check | policy | KEEP — lease liveness + cleanup |
| 17 | `packages/platform-apple/src/runner/runner-command-route.ts` | `resolveRoute`: loopback/usbmux endpoint | translation | KEEP — usbmux/network route model |
| 18 | `packages/platform-apple/src/runner/runner-startup-transport.ts` | `waitForRunner` → `tryRunnerRoute` → `postRunnerCommandOverRoute` | orchestration | KEEP — readiness wait (network route) |
| 19 | `packages/platform-apple/src/runner/runner-transport.ts` | `fetchWithTimeout` → `fetch` to the runner at :90 | **terminal (adapter)** | n/a (terminal) |

Arm B #4 re-enters `packages/platform-apple/src/index.ts`, shared #22, through `applePlugin.createInteractor`.
The file counts once.

**Admission fan-out (not hops).**
The Apple owner's per-request `inspectFacts` in `packages/platform-apple/src/runtime.ts` calls the same 23 builders listed for Android.
The builders are in `packages/contracts/src/*-runtime.ts`. They are side-calls of the admission step.

**Response path (not hops).** These 22 files execute only after the platform call:

- `packages/daemon/src/core/ref-frame.ts`
- `packages/daemon/src/core/session-action-recorder.ts`
- `packages/daemon/src/sessions/snapshot-quality-latch.ts`
- `packages/daemon/src/server/request-finalization.ts`
- `packages/session-journal/src/session-event-request.ts`
- `packages/daemon/src/execution/session-snapshot.ts` for lineage.
- `packages/daemon/src/execution/sparse-fallback-screenshot.ts`
- `src/core/snapshot-state.ts`
- `packages/contracts/src/capture.ts`
- `packages/platform-apple/src/runner/snapshot-presentation.ts`
- `src/snapshot/ios-snapshot-runtime.ts`
- Modules under `packages/capture-kit/src/ios-snapshot-engine/`:
  - engine
  - invariants
  - geometry
  - geometry-policy
  - projection
  - graph
  - runner-presentation
- `packages/capture-kit/src/ios-snapshot-planning.ts`
- `packages/capture-kit/src/snapshot-quality-verdict.ts`
- `packages/contracts/src/snapshot-scope.ts`
- `packages/platform-apple/src/snapshot-source/tree.ts`

**Forks not followed:**

- `request-platform-provider-context.ts`: the router returns early for a bare local daemon.
- `platform-runtime/request-providers.ts`.
- `lease-registry.ts`: `isHumanControlMutation` is false for an agent-surface snapshot.
- `handlers/snapshot.ts`: `alert`/`settings`/`diff`/`wait` arms.
- macOS surface-capture arms.
- `snapshot-runtime-binding.ts`: `selector-*`/`custom-actions-*` plan arms.
- Arm B's **cold-start chain**, because a steady-state session exists.
  `startRunnerSessionWithLease` in `runner-session.ts` enters approximately 15 files under `packages/platform-apple/src/runner/`:
  - `runner-lease`
  - `runner-adoption`
  - `runner-artifact`
  - `runner-artifact-env`
  - `runner-cache`
  - `runner-cache-metadata`
  - `runner-device-set`
  - `runner-process-launch`
  - `runner-listener-ready`
  - `runner-io`
  - `runner-source`
  - `runner-session-types`
  - `runner-macos-products`
  - `runner-icon`
  - `runner-xctestrun` products.
  It also enters host-kit `exec`/`atomic-file`/`host-process` for the xctestrun build, process launch, and listener-readiness observation.

## Why this differs from the ADR's 38/29

The plan sheet suggested façade PRs #2178, #2222, and #2232 as a possible explanation.
All merged before `e624ef9d3f`, the commit cited for the ADR's 38/29 measurement.
Thus, they cannot explain why that count is higher than this one.
They were already in effect when 38/29 was recorded.

This trace measures 41 hops for `press`/Android and 47/49 per arm for `snapshot`/iOS.
The ADR supplies no ordered chain, command/artifact, or definition for 38/29.
The discrepancy cannot be resolved against that text.
A different unit is the most likely explanation: perhaps named exports or all static/type imports instead of distinct files on the path.
**Treat 38 and 29 as superseded by these auditable measurements.**
They are not another data point for reconciliation.

## Delta vs the 23/24 measured at `132ffe1da`

Both routes retain their old files.
The snapshot `register-builtins.ts` lookup moved from call time to module-load registration.
`platform-plugin-registry.ts` took its call-time role.
Four groups explain the growth:

1. **Request-scope wrapper layer:** six new spine files on both routes:
   - `daemon-runtime.ts`
   - host-kit `diagnostics`
   - `device-inventory-context.ts`
   - `dispatch-resolve.ts`
   - `request-execution-scope.ts`
   - `provider-device-runtime.ts`
   The former three-file spine, `http-server` → `request-router` → `request-handler-chain`, now contains nine files.
   Diagnostics scopes, inventory/resolution contexts, execution scope/locks, and provider-scope isolation moved into the request path.
   Auth comparison, cancellation, and idle-reap reset remain side-calls, not hops.
2. **AgentDevice command layer:** press rows 24–30 and snapshot shared rows 26–29.
   Commands now use the bound AgentDevice surface between daemon dispatch and the platform interactor.
   This includes `src/runtime.ts`, `src/commands/**`, and `interaction-runtime.ts`.
3. **adb host split and claim gate:** press rows 23 and 39–41.
   The additions are `device-claim-admission.ts`, `adb-provider-scope.ts`, `adb-failure.ts`, and named-root terminal `platform-runtime-android-adb-host.ts`.
   Package `adb.ts` is now a pass-through executor seam.
4. **Snapshot dual arms:** the in-simulator AX bridge became primary and the XCTest runner became fallback.
   Arm A adds `snapshot-source/*`, target/process/simctl resolution, and host-kit process adapters.
   Arm B adds runner protocol depth through `runner-command-traits`, `runner-contract`, `runner-recycle-ledger`, and `runner-startup-transport`.
   Presentation moved to the response path in the capture-kit engine.

## The ≤14 target

This section re-derives the target at HEAD with the collapse rule that the earlier revision applied: fold every pass-through hop without kept depth.

- **`press`/Android: no longer plausible.**
  The fixed request spine, rows 1–9, already contains nine files.
  Each of them passes the deletion test with kept depth (diagnostics attribution, inventory/resolution context, execution scope, or provider scope), or is a declared boundary.
  Every remaining pass-through hop keeps depth: declared boundaries, the interactor resolution seam, the adb executor seam, and typed failure classification.
  A ≤14 target would require removal of 27 files with cross-cutting daemon responsibilities or necessary bindings.
  They are not unnecessary press-specific layers.
- **`snapshot`/iOS: not reachable.**
  The shared prefix contains 30 files.
  The primary arm adds 16 non-terminal hops of the AX-bridge protocol (binary cache, session lock, wire codec, deadline budgets).
  The runner protocol of the fallback arm (retry, contract, recycle ledger, readiness) remains load-bearing.
  Only shared row 28, `commands/runtime-types`, is REMOVABLE.
  The collapse of this thin closure wrapper changes 47/49 to 46/48.

**Verdict: the ≤14 target is superseded.**
At `27a97ee619`, the audited routes contain 41 hops for `press`/Android and 47/49 per arm for `snapshot`/iOS.
Only one distinct hop is proven removable across both routes: `commands/runtime-types.ts`.
The audit endorses only this reduction.
Any further target requires a decision to fold cross-cutting request-scope wrappers.
That decision is outside this route's ownership.
Treat 14 as a historical discussion reference, not a derived number.
