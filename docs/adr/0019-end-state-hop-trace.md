# ADR-0019 end-state: entry-to-platform hop trace

Backs the "Entry-to-platform hop count" paragraph in
[0019-request-bound-platform-runtime.md](./0019-request-bound-platform-runtime.md#end-state-proposed-2026-09-02-maintainer-decision-pending).
That paragraph cited 38 hops (`press`/Android) and 29 hops (`snapshot`/iOS) with no ordered
route, no counting definition, and no linked artifact. This file supplies all three.

The 23/24 tables originally recorded here at `132ffe1da` (corrected for PR #2302 in that PR)
are superseded: the routes moved ~58 commits, `snapshot`/iOS is now a dual-arm route, and the
#2278 audit re-traced both routes file-by-file at HEAD with a role vocabulary. This revision
replaces the tables and keeps the counting definition stable so the numbers remain comparable.

## Counting definition

- **Unit**: one distinct production `.ts` file entered on the call path, counted once even if
  re-entered (a lazy `import()` of an already-counted file is not a new hop). Type-only imports
  and files that only supply types are not hops.
- **Range**: from the daemon's HTTP entry file (`src/daemon/server/http-server.ts`) through the
  file that issues the concrete platform call, inclusive of both endpoints. For `press`/Android
  that is the serial-scoped `adb shell input tap` invocation; for `snapshot`/iOS it is the
  `socket.write` to the in-simulator AX bridge (primary arm) or the `fetch()` to the XCTest
  runner (fallback arm).
- **Main chain only**: follow the first call that continues toward the platform call (not every
  branch — e.g. `handleSnapshotCommands` routes `alert`/`settings`/`diff`/`wait` too; only the
  plain-`snapshot` arm is traced). Side-calls that build data records inside a hop (e.g. the
  `*RuntimeOperationFacts` builders inside the owner's per-request `inspectFacts`) are not hops;
  they are measured as admission fan-out below. Files executing only on the response path (after
  the platform call, on the way back) are not hops; they are counted separately.
- **Steady state**: the `snapshot` fallback arm is traced with the runner session already up.
  The cold-start chain (lease, xctestrun build via xcodebuild, process launch) is a fork, not
  the traced path.
- **Per-file role** (exactly one):
  - **policy** — makes an admission/limit/retry/routing decision that can refuse or redirect the request.
  - **orchestration** — coordinates multiple calls, binds/runs a runtime, or assembles the object graph the next hops need.
  - **translation** — maps values/shapes (argv construction, wire encoding, target resolution) without issuing the platform call.
  - **adapter** — wraps an external system boundary (subprocess, socket, fetch). The terminal hop is the adapter that issues the platform call itself.
  - **pass-through** — delegates to exactly one next call on the traced path with no branching or transformation (lazy-load indirection, one-line re-export/delegate, scope wrapper).
- **Deletion test** (per pass-through/translation hop): could this hop's hand-off be inlined
  into its caller and/or callee without losing admission, budget, isolation, a declared
  boundary named in an ADR, or a testability seam? The test judges the hop, not the file: a
  REMOVABLE hop is a collapse candidate, not a file to delete.
- **Method**: read each file, find the exported entry function reached by the caller, follow
  its first call that continues toward the platform call, record the file and the one
  function that hands off to the next hop.
- **Commit measured at**: `27a97ee619` (re-traced for #2278; supersedes the `132ffe1da` tables).

## `press` / Android: HTTP entry → `adb input tap`

44 files: 13 pass-through, 5 translation, 6 policy, 19 orchestration, 1 terminal (adapter).

| # | File | Hand-off | Role | Delete-test |
|---|------|----------|------|-------------|
| 1 | `src/daemon/server/http-server.ts` | parses `/rpc`, resolves the token; calls injected `handleRequest` | pass-through | KEEP — HTTP entry boundary |
| 2 | `src/daemon/server/daemon-runtime.ts` | `handleRequest`: in-flight count, cancels idle reap, `dispatchRequest` | orchestration | KEEP — request lifecycle orchestration |
| 3 | `src/daemon/server/daemon-idle-reap.ts` | `cancel()` clears the pending reap timer | pass-through | REMOVABLE — daemon liveness timer, not route depth |
| 4 | `src/daemon/request-router.ts` | auth, flag guards, scope creation, locked execution, handler chain | orchestration | KEEP — request admission + dispatch core |
| 5 | `packages/host-kit/src/internal/diagnostics.ts` | `withDiagnosticsScope` wraps the request task | pass-through | KEEP — per-request diagnostic attribution |
| 6 | `packages/host-kit/src/internal/transport.ts` | `timingSafeStringEqual` compares the auth token | pass-through | KEEP — constant-time auth comparison |
| 7 | `src/request/device-inventory-context.ts` | `withDeviceInventoryContext` wraps the task | pass-through | KEEP — request-scoped device inventory context |
| 8 | `src/core/dispatch-resolve.ts` | `withResolveTargetDeviceCacheScope` wraps the task | orchestration | KEEP — per-request target-resolution cache |
| 9 | `src/daemon/request-execution-scope.ts` | `createRequestExecutionScope`; `runLocked`/`runAdmitted` | orchestration | KEEP — scoped execution + lock/claim admission |
| 10 | `packages/host-kit/src/internal/request-cancel.ts` | `throwIfRequestCanceled` gate | policy | KEEP — request cancellation gate |
| 11 | `src/provider-device-runtime.ts` | `withProviderDeviceRuntimeScope` (`AsyncLocalStorage.run`) | pass-through | KEEP — provider-runtime scope boundary |
| 12 | `src/daemon/request-handler-chain.ts` | `runRequestHandlerChain` routes to the interaction handler | orchestration | KEEP — command routing |
| 13 | `src/daemon/interaction/index.ts` | route facade delegates to `handleInteractionCommands` | orchestration | KEEP — shared interaction route facade |
| 14 | `src/daemon/interaction/internal/interaction.ts` | switches `press` to `dispatchTargetedTouchViaRuntime` | policy | KEEP — touch command routing |
| 15 | `src/daemon/interaction/internal/interaction-touch-press.ts` | admits the touch, dispatches the runtime interaction | orchestration | KEEP — press admission + orchestration |
| 16 | `src/daemon/interaction/internal/interaction-touch-prepare.ts` | `prepareTouchDispatch` → `resolveBoundTouchRuntime` | translation | KEEP — shared admission + bind seam |
| 17 | `src/daemon/touch-runtime.ts` | resolves the plan, `bind(device, tapPointUse)` | orchestration | KEEP — tap runtime binding |
| 18 | `src/daemon/runtime-admission.ts` | `admitRuntimeOperations`: `inspectFacts`, per-op admission | policy | KEEP — per-operation admission |
| 19 | `src/daemon/request-runtime-binding.ts` | `bindDevice`: per-device-cached `gateway.bind` | orchestration | KEEP — device runtime binding |
| 20 | `src/platform-runtime-gateway.ts` | `loadLocal` → `loadHost` → `loadRuntime` | orchestration | KEEP — gateway boundary |
| 21 | `src/platform-runtime.ts` | wires the android module, supplies `loadHost` | pass-through | KEEP — declared ADR §1/§2 registry boundary |
| 22 | `src/platform-runtime-operation-host.ts` | `createPlatformRuntimeHost` assembles the host | orchestration | KEEP — host composition |
| 23 | `packages/platform-android/src/index.ts` | `loadRuntime` pairs the plugin with the runtime module | pass-through | KEEP — declared ADR §2 `loadRuntime` boundary |
| 24 | `packages/platform-android/src/runtime.ts` | `bind`: `inspectFacts` (fan-out site), builds the tap operation | orchestration | KEEP — android runtime owner |
| 25 | `packages/contracts/src/local-interactor-operation-set.ts` | `bindLocalInteractorOperationSet` → `bindLocalTouchInteractor` | translation | KEEP — tap op mapped to the interactor |
| 26 | `src/daemon/device-claim-admission.ts` | `admit`: owner claim rule; ordinary owner | policy | KEEP — device claim admission |
| 27 | `src/daemon/interaction/internal/interaction-touch-runtime.ts` | `dispatchRuntimeInteraction` → `createInteractionRuntimeForRoute` | orchestration | KEEP — interaction runtime dispatch |
| 28 | `src/daemon/interaction/internal/interaction-runtime.ts` | `createInteractionAgentDevice` with the executor backend | orchestration | KEEP — agent device construction |
| 29 | `src/runtime.ts` | `createAgentDevice`: backend + `bindCommands` | orchestration | KEEP — agent device facade |
| 30 | `src/commands/index.ts` | `bindCommands` → `bindInteractionCommands` | orchestration | KEEP — command catalog boundary |
| 31 | `src/commands/interaction/runtime/index.ts` | `bindInteractionCommands`: `press` → `pressCommand` | orchestration | KEEP — nine-command binding surface |
| 32 | `src/daemon/interaction/internal/interaction-touch-android-readiness.ts` | `runWithAndroidDialogReadinessCheck` wraps `run` | policy | KEEP — blocking-dialog readiness gate |
| 33 | `src/commands/interaction/runtime/interactions.ts` | `pressCommand` → `tapCommand`: resolve target, `backend.tap` | orchestration | KEEP — tap command execution |
| 34 | `src/commands/interaction/runtime/resolution.ts` | `resolveInteractionTarget` applies guards, returns the point | translation | KEEP — tap target resolution |
| 35 | `packages/contracts/src/interactor-operation-binding.ts` | `interactorFor` resolves the local interactor | translation | KEEP — shared interactor resolution seam |
| 36 | `src/platform-runtime-local-application-interactors.ts` | `resolve()` lazy-imports `core/interactors` | pass-through | KEEP — lazy host interactor port |
| 37 | `src/core/interactors.ts` | `getLocalInteractor` → `getPlugin(platform).createInteractor` | pass-through | KEEP — provider vs local interactor dispatch |
| 38 | `src/core/interactors/register-builtins.ts` | android plugin entry lazy-imports `./android.ts` | pass-through | KEEP — platform plugin registry |
| 39 | `src/core/interactors/android.ts` | `createAndroidInteractor`: `tap` → `pressAndroid` | orchestration | KEEP — interactor construction |
| 40 | `packages/platform-android/src/input-actions.ts` | `pressAndroid` builds the `shell input tap` argv | translation | KEEP — shared argv construction |
| 41 | `packages/platform-android/src/adb.ts` | `runAndroidAdb` → `resolveAndroidAdbExecutor` | pass-through | KEEP — single adb executor seam |
| 42 | `packages/platform-android/src/adb-provider-scope.ts` | `resolveAndroidAdbExecutor` picks the device-scoped executor | policy | KEEP — executor scoping |
| 43 | `packages/platform-android/src/adb-failure.ts` | `withAdbFailureHints` wraps the executor call | pass-through | KEEP — typed adb failure classification |
| 44 | `src/platform-runtime-android-adb-host.ts` | `execSerialAdb` issues the serial-scoped tap invocation | **terminal (adapter)** | n/a (terminal) |

The terminal's invocation is spawned through host-kit's shared `runCmd`
(`packages/host-kit/src/internal/command.ts`, the generic subprocess adapter shared with the
`snapshot` route — counted there, not a separate hop here). Precedent: at the baseline
measurement the terminal was the route-level issue point (`adb.ts`) even though the spawn lived
in the executor below it; the same boundary is `adb-host` at HEAD (the named root file bound
only by its named composition module per ADR Decision §1).

**Admission fan-out (not hops).** The android owner's per-request `inspectFacts`
(`packages/platform-android/src/runtime.ts`) executes 23 distinct
`packages/contracts/src/*-runtime.ts` `*RuntimeOperationFacts` builders as side-calls:
`application-lifecycle`, `alert`, `app-event`, `app-switcher`, `audio-probe`, `back`,
`clipboard`, `element-text`, `focus`, `gesture`, `home`, `keyboard`, `orientation`, `perf`,
`screenshot`, `scroll`, `selector-observation`, `settings`, `snapshot`, `touch`, `type-text`,
`tv-remote`, `viewport` (each `-runtime.ts`).

**Response path (not hops).** 8 files execute only after the platform call:
`src/daemon/interaction/internal/interaction-touch-response.ts`,
`src/daemon/interaction/internal/interaction-common.ts`,
`src/daemon/interaction-outcome-policy.ts`, `src/daemon/request-finalization.ts`,
`src/daemon/session-event-log.ts`, `src/daemon/session-snapshot.ts`,
`src/daemon/recording-gestures.ts`, `src/daemon/deferred-interaction-outcome.ts`.

**Forks not followed**: `request-platform-provider-context.ts` (the call is guarded by the
router's early return for a bare local daemon — zero runtimes + non-web),
`platform-runtime/request-providers.ts` (only under `requestPlatformProviders.run`, not called
for local), `lease-registry.ts` (`isHumanControlMutation` is false for an agent-surface press),
the `@ref`/direct-iOS fast paths in `interaction-touch-press.ts`, the provider-adb arm in
`adb-provider-scope.ts`, and the error-path arms in `adb-failure.ts`/`adb-host.ts`.

## `snapshot` / iOS Simulator: HTTP entry → AX bridge `socket.write` (primary) / runner `fetch` (fallback)

The route forks at `packages/platform-apple/src/snapshot-route.ts` (`route.capture`,
`isEligible` + per-generation circuit breaker): the in-simulator AX bridge is the primary arm;
the XCTest runner is the fallback (chosen when ineligible, on AX acquisition failure, or when
the single-flight target discovery — `TARGET_DISCOVERY_WAIT_MS` bounded wait in
`snapshot-target.ts` — has not settled for this capture; the probe keeps running and later
captures join it).
Shared prefix 34 files; primary arm 51 distinct (34 + 17); fallback arm 53 distinct
(34 + 19); 70 distinct files across the union.

### Shared prefix (entry → fork)

| # | File | Hand-off | Role | Delete-test |
|---|------|----------|------|-------------|
| 1 | `src/daemon/server/http-server.ts` | parses `/rpc`, resolves the token; calls injected `handleRequest` | pass-through | KEEP — HTTP entry boundary |
| 2 | `src/daemon/server/daemon-runtime.ts` | `handleRequest`: in-flight count, cancels idle reap, `dispatchRequest` | orchestration | KEEP — request lifecycle orchestration |
| 3 | `src/daemon/server/daemon-idle-reap.ts` | `cancel()` clears the pending reap timer | pass-through | REMOVABLE — daemon liveness timer, not route depth |
| 4 | `src/daemon/request-router.ts` | auth, flag guards, scope creation, locked execution, handler chain | orchestration | KEEP — request admission + dispatch core |
| 5 | `packages/host-kit/src/internal/diagnostics.ts` | `withDiagnosticsScope` wraps the request task | pass-through | KEEP — per-request diagnostic attribution |
| 6 | `packages/host-kit/src/internal/transport.ts` | `timingSafeStringEqual` compares the auth token | pass-through | KEEP — constant-time auth comparison |
| 7 | `src/request/device-inventory-context.ts` | `withDeviceInventoryContext` wraps the task | pass-through | KEEP — request-scoped device inventory context |
| 8 | `src/core/dispatch-resolve.ts` | `withResolveTargetDeviceCacheScope` wraps the task | orchestration | KEEP — per-request target-resolution cache |
| 9 | `src/daemon/request-execution-scope.ts` | `createRequestExecutionScope`; `runLocked`/`runAdmitted` | orchestration | KEEP — scoped execution + lock/claim admission |
| 10 | `packages/host-kit/src/internal/request-cancel.ts` | `throwIfRequestCanceled` gate | policy | KEEP — request cancellation gate |
| 11 | `src/provider-device-runtime.ts` | `withProviderDeviceRuntimeScope` (`AsyncLocalStorage.run`) | pass-through | KEEP — provider-runtime scope boundary |
| 12 | `src/daemon/request-handler-chain.ts` | `runRequestHandlerChain` routes `snapshot` to `runSnapshotHandler` | orchestration | KEEP — command routing |
| 13 | `src/daemon/handlers/snapshot.ts` | `handleSnapshotCommands` routes the plain arm | policy | KEEP — snapshot command routing |
| 14 | `src/daemon/snapshot-runtime.ts` | `dispatchSnapshotViaRuntime` → `params.execute` | pass-through | KEEP — snapshot execute seam (route tests pin it) |
| 15 | `src/daemon/snapshot-command-runtime.ts` | resolves the bound capture; wires session/backend; runs the op | orchestration | KEEP — capture wiring + recording |
| 16 | `src/daemon/deferred-interaction-outcome.ts` | `resolveDeferredInteractionOutcome` before a fresh capture | policy | KEEP — pending-outcome settlement (may short-circuit) |
| 17 | `src/daemon/snapshot-capture.ts` | `resolveSnapshotScope` + the capture attempt | orchestration | KEEP — capture attempt + scope resolution |
| 18 | `src/daemon/snapshot-session.ts` | `resolveSessionDevice` for the capture | translation | KEEP — snapshot session/device resolution |
| 19 | `src/daemon/session-snapshot-freshness.ts` | `clearAndroidSnapshotFreshness`; `platform !== 'android'` → return | translation | REMOVABLE — Android-only; inert on iOS |
| 20 | `src/daemon/snapshot-runtime-binding.ts` | `resolveBoundSnapshotCaptureRuntime`: admit-then-bind | policy | KEEP — ADR 0019 §9 admit-then-bind seam |
| 21 | `src/daemon/session-runtime-admission.ts` | `admitRuntimePlan` (fan-out site) / `requireRuntimeBinding` | policy | KEEP — runtime plan fact admission |
| 22 | `src/daemon/request-runtime-binding.ts` | `bindDevice`: per-device-cached `gateway.bind` | orchestration | KEEP — device runtime binding |
| 23 | `src/platform-runtime-gateway.ts` | `loadLocal` → `loadHost` → `loadRuntime` | orchestration | KEEP — gateway boundary |
| 24 | `src/platform-runtime.ts` | wires the apple module, supplies `loadHost` | pass-through | KEEP — declared ADR §1/§2 registry boundary |
| 25 | `src/platform-runtime-operation-host.ts` | `createPlatformRuntimeHost` assembles the host | orchestration | KEEP — host composition |
| 26 | `packages/platform-apple/src/index.ts` | `loadRuntime` pairs the plugin with the runtime module | pass-through | KEEP — declared ADR §2 `loadRuntime` boundary |
| 27 | `packages/platform-apple/src/runtime.ts` | `bind` → `bindAppleSnapshotRuntime` | orchestration | KEEP — apple runtime owner |
| 28 | `packages/platform-apple/src/runtime-snapshot.ts` | `bindAppleSnapshotRuntime` wires the AX + fallback closures | orchestration | KEEP — AX/runner wiring (tests pin it) |
| 29 | `packages/platform-apple/src/snapshot-route.ts` | `createAppleSnapshotRoute`; `isEligible` + circuit breaker | policy | KEEP — AX/runner route + breaker (the fork) |
| 30 | `src/runtime.ts` | `createAgentDevice`: the bound runtime object | orchestration | KEEP — agent device facade |
| 31 | `src/commands/index.ts` | `bindCommands` binds the command catalog | orchestration | KEEP — command catalog boundary |
| 32 | `src/commands/runtime-types.ts` | `bindRuntimeCommands` wraps the runtime into closures | pass-through | REMOVABLE — thin closure wrapper; depth lives in the commands |
| 33 | `src/commands/capture/runtime/snapshot.ts` | `snapshotCommand`: parses input, calls `runtime.backend.captureSnapshot` | orchestration | KEEP — capture command implementation |
| 34 | `packages/contracts/src/snapshot-runtime.ts` | the `captureSnapshot` op → AX route or interactor fallback | pass-through | KEEP — cross-layer contract seam (ownership refusal + signal join) |

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
| 16 | `packages/host-kit/src/internal/host-file.ts` | socket/bridge dir file ops | adapter | KEEP — bridge socket file ops |
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
| 18 | `packages/platform-apple/src/runner/runner-startup-transport.ts` | `waitForRunner` → `tryRunnerRoute` → `tryRunnerEndpoints` | orchestration | KEEP — readiness wait (network route) |
| 19 | `packages/platform-apple/src/runner/runner-transport.ts` | `fetchWithTimeout` → `fetch` to the runner at :90 | **terminal (adapter)** | n/a (terminal) |

Re-entry: arm B #4 enters `packages/platform-apple/src/index.ts` (shared #26) via
`applePlugin.createInteractor` — counted once.

**Admission fan-out (not hops).** The apple owner's per-request `inspectFacts`
(`packages/platform-apple/src/runtime.ts`) executes the same 23
`packages/contracts/src/*-runtime.ts` `*RuntimeOperationFacts` builders as the android owner
above, as side-calls of the admission step.

**Response path (not hops).** 22 files execute only after the platform call:
`src/daemon/ref-frame.ts`, `src/daemon/session-action-recorder.ts`,
`src/daemon/snapshot-quality-latch.ts`, `src/daemon/request-finalization.ts`,
`src/daemon/session-event-request.ts`, `src/daemon/session-snapshot.ts` (lineage),
`src/daemon/sparse-fallback-screenshot.ts`, `src/core/snapshot-state.ts`,
`packages/contracts/src/capture.ts`, `packages/platform-apple/src/runner/snapshot-presentation.ts`,
`src/snapshot/ios-snapshot-runtime.ts`, the `packages/capture-kit/src/ios-snapshot-engine/`
modules (engine, invariants, geometry, geometry-policy, projection, graph,
runner-presentation), `packages/capture-kit/src/ios-snapshot-planning.ts`,
`packages/capture-kit/src/snapshot-quality-verdict.ts`,
`packages/contracts/src/snapshot-scope.ts`,
`packages/platform-apple/src/snapshot-source/tree.ts`.

**Forks not followed**: `request-platform-provider-context.ts` (router early return for a bare
local daemon), `platform-runtime/request-providers.ts`, `lease-registry.ts`
(`isHumanControlMutation` false for an agent-surface snapshot), the `alert`/`settings`/`diff`/
`wait` arms in `handlers/snapshot.ts`, the macOS surface-capture arms, the
`selector-*`/`custom-actions-*` plan arms in `snapshot-runtime-binding.ts`, and the arm B
**cold-start chain** (steady-state session exists): `startRunnerSessionWithLease` in
`runner-session.ts` into ~15 `packages/platform-apple/src/runner/` files
(`runner-lease`, `runner-adoption`, `runner-artifact`, `runner-artifact-env`, `runner-cache`,
`runner-cache-metadata`, `runner-device-set`, `runner-process-launch`, `runner-listener-ready`,
`runner-io`, `runner-source`, `runner-session-types`, `runner-macos-products`, `runner-icon`,
`runner-xctestrun` products) plus host-kit `exec`/`atomic-file`/`host-process` — the xctestrun
build, process launch, and listener-ready observation.

## Why this differs from the ADR's 38/29

The façade PRs the plan sheet named as a candidate explanation (#2178, #2222, #2232) all merged
**before** `e624ef9d3f` — the commit the ADR cites for its 38/29 measurement — so they cannot be
why that count is higher than this one; they were already in effect when 38/29 was recorded.

This trace lands at 44 hops for `press`/Android and 51/53 (per arm) for `snapshot`/iOS. The ADR
text names no ordered chain, command/artifact, or counting definition for 38/29, so the
discrepancy cannot be resolved against it. The most likely explanation is a different counting
unit (for example, named exports or every static/type import touched rather than distinct
production files on the call path). **Treat 38 and 29 as superseded by the auditable numbers
measured here**, not as a second data point to reconcile.

## Delta vs the 23/24 measured at `132ffe1da`

Both routes kept their old files (nothing on the old routes was dropped: the snapshot
`register-builtins.ts` lookup moved from call-time to module-load registration, with
`platform-plugin-registry.ts` taking the call-time role). The growth is four clusters:

1. **Request-scope wrapper layer** (9 new spine files, both routes): `daemon-runtime.ts`,
   `daemon-idle-reap.ts`, host-kit `diagnostics`/`transport`/`request-cancel`,
   `device-inventory-context.ts`, `dispatch-resolve.ts`, `request-execution-scope.ts`,
   `provider-device-runtime.ts`. The old 3-file router spine
   (`http-server` → `request-router` → `request-handler-chain`) is now 12 files: diagnostics
   scoping, auth, inventory/resolution contexts, execution scope/locks, cancellation, and
   provider-scope isolation moved into the router's request path.
2. **AgentDevice command layer** (press rows 27–33, snapshot shared 30–33): commands now
   execute through the bound AgentDevice surface (`src/runtime.ts`, `src/commands/**`,
   `interaction-runtime.ts`) between the daemon dispatch and the platform interactor.
3. **adb host split + claim gate** (press rows 26, 42–44): `device-claim-admission.ts`,
   `adb-provider-scope.ts`, `adb-failure.ts`, and the named-root `platform-runtime-android-adb-host.ts`
   terminal (the package `adb.ts` is now a pass-through executor seam).
4. **Snapshot dual arms** (snapshot): the in-simulator AX bridge became the primary capture
   path (arm A: `snapshot-source/*`, target/process/simctl resolution, host-kit process
   adapters), the XCTest runner demoted to fallback (arm B), and the runner protocol deepened
   (`runner-command-traits`, `runner-contract`, `runner-recycle-ledger`,
   `runner-startup-transport`) while the presentation work moved to the response path
   (capture-kit engine).

## The ≤14 target

Re-derived at HEAD under the same collapsing logic the earlier revision applied (fold every
pass-through hop with no kept depth):

- **`press`/Android — no longer plausible.** The fixed request spine alone (rows 1–12) is 12
  files, and every one of them either passes the deletion test with kept depth (diagnostics
  attribution, auth, inventory/resolution context, execution scope, cancellation, provider
  scope) or is a declared boundary. The only REMOVABLE hop on the route is row 3
  (`daemon-idle-reap`, liveness): 44 → 43. Every remaining pass-through hop keeps depth
  (declared boundaries, the interactor resolution seam, the adb executor seam and typed
  failure classification), so reaching ≤14 would require cutting 29 further files that are
  cross-cutting daemon concerns or load-bearing bindings, not press-specific waste.
- **`snapshot`/iOS — not reachable.** The shared prefix alone is 34 files, and the primary arm
  adds 16 non-terminal hops of the AX-bridge protocol (binary cache, session lock, wire codec,
  deadline budgets); the fallback arm's runner protocol (retry, contract, recycle ledger,
  readiness) remains load-bearing. The only REMOVABLE hops are shared rows 3 and 19 (liveness
  timer; Android-only freshness clear) and row 32 (thin closure wrapper): 51/53 → 48/50.

**Verdict: the ≤14 target is superseded.** The audited routes at `27a97ee619` are 44
(`press`/Android) and 51/53 (`snapshot`/iOS per arm), and the deletion test proves only three
distinct removable hops across both routes (`daemon-idle-reap`, `session-snapshot-freshness`,
`commands/runtime-types.ts`). Collapsing those three is the only hop-depth reduction the audit
endorses; any further target needs a decision to fold cross-cutting request-scope wrappers,
which is outside this route's ownership. Treat 14 as a historical discussion anchor, not as a
derived number.
