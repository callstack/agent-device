# ADR-0019 end-state: entry-to-platform hop trace

Backs the "Entry-to-platform hop count" paragraph in
[0019-request-bound-platform-runtime.md](./0019-request-bound-platform-runtime.md#end-state-proposed-2026-09-02-maintainer-decision-pending).
That paragraph cited 38 hops (`press`/Android) and 29 hops (`snapshot`/iOS) with no ordered
route, no counting definition, and no linked artifact. This file supplies all three, re-traces
both routes file-by-file at HEAD, and replaces the unauditable numbers.

## Counting definition

- **Unit**: one distinct production `.ts` file entered on the call path, counted once even if
  re-entered (a lazy `import()` of an already-counted file is not a new hop). Type-only imports
  and files that only supply types are not hops.
- **Range**: from the daemon's HTTP entry file (`src/daemon/server/http-server.ts`) through the
  file that issues the concrete platform call — `adb shell input tap` for `press`/Android,
  `fetch()` to the XCTest runner for `snapshot`/iOS — inclusive of both endpoints.
- **Per-file classification**:
  - **pass-through** — delegates to exactly one next call with no branching or transformation
    (a lazy-load indirection, a one-line re-export/delegate).
  - **thin** — a routing table, a switch on command name, or a wrapper around one admission
    check; no domain logic.
  - **substantive** — resolves a plan, binds a runtime, constructs an interactor, or otherwise
    does work a target hop count would still need somewhere.
  - **terminal** — the file that issues the platform call itself.
- **Method**: read each file, find the exported entry function reached by the caller, follow its
  first call that continues toward the platform call (not every branch — e.g. `handleSnapshotCommands`
  routes `alert`/`settings`/`diff`/`wait` too; only the `snapshot` arm is traced), record the file
  and the one line/function that hands off to the next hop.
- **Commit measured at**: `132ffe1da296717c268e836fc02558d00e61cfbd` (this branch's base,
  `origin/main` fast-forwarded; the fix in this PR does not touch any traced source file).

## `press` / Android: HTTP entry → `adb input tap`

24 files, 7 pass-through, 9 thin, 7 substantive, 1 terminal.

| # | File | Hand-off | Class |
|---|------|----------|-------|
| 1 | `src/daemon/server/http-server.ts` | parses the HTTP request, calls `handleRequest` | thin |
| 2 | `src/daemon/request-router.ts` | `createRequestHandler` → `runRequestHandlerChain` | pass-through |
| 3 | `src/daemon/request-handler-chain.ts` | routes `command: 'press'` to `runInteractionHandler`, lazy-loads `interaction/index.ts` | thin |
| 4 | `src/daemon/interaction/index.ts` | re-exports the lazy-loaded internal module's `handleInteractionCommands` | pass-through |
| 5 | `src/daemon/interaction/internal/interaction.ts` | `handleInteractionCommands` → `handleTouchInteractionCommands` | pass-through |
| 6 | `src/daemon/interaction/internal/interaction-touch.ts` | switches `press`/`click`/`longpress`/`hover` to `dispatchTargetedTouchViaRuntime` | thin |
| 7 | `src/daemon/interaction/internal/interaction-touch-press.ts` | admits the touch, tries the direct-iOS fast path (no-op on Android), calls `dispatchRuntimeInteraction` with a `run` callback that calls `runtime.interactions.press` | substantive |
| 8 | `src/daemon/interaction/internal/interaction-touch-prepare.ts` | `prepareTouchDispatch` → `resolveBoundTouchRuntime` | thin |
| 9 | `src/daemon/touch-runtime.ts` | resolves the touch plan, calls `bind(device, tapPointUse)`, wraps the result as `BoundTouchExecutor.tapPoint` | substantive |
| 10 | `src/daemon/runtime-admission.ts` | `admitRuntimeOperations` → `requireDeviceBinding(bindDevice)` | thin |
| 11 | `src/daemon/request-runtime-binding.ts` | `bindDevice` → per-device-cached `gateway.bind(...)` | substantive |
| 12 | `src/platform-runtime-gateway.ts` | composed gateway's `loadLocal`: loads the host, calls `module.loadRuntime(host)` | substantive |
| 13 | `src/platform-runtime.ts` | declared boundary (ADR §1/§2): wires `androidRuntimeModule` into `platformRuntimeModules` and supplies `loadHost` | thin |
| 14 | `src/platform-runtime-operation-host.ts` | `createPlatformRuntimeHost` builds `host`, incl. `localInteractors: createLocalApplicationInteractorHost()` | thin |
| 15 | `src/platform-runtime-local-application-interactors.ts` | `resolve()` lazy-imports `core/interactors.ts`, calls `getLocalInteractor` | pass-through |
| 16 | `src/core/interactors.ts` | `getLocalInteractor` → `getPlugin(device.platform).createInteractor` | pass-through |
| 17 | `src/core/interactors/register-builtins.ts` | plugin registry; the `android` entry lazy-imports `./android.ts` | thin |
| 18 | `src/core/interactors/android.ts` | `createAndroidInteractor` builds the `Interactor`, incl. `tap: (x, y) => pressAndroid(device, x, y)` | substantive |
| 19 | `packages/platform-android/src/index.ts` | declared boundary (ADR §2 `loadRuntime` pairing): lazy-imports `./runtime.ts`, calls `createAndroidPlatformRuntime` | pass-through |
| 20 | `packages/platform-android/src/runtime.ts` | `createAndroidPlatformRuntime`'s `bind()` builds `operations` via `androidInteractionOperations` | substantive |
| 21 | `packages/contracts/src/local-interactor-operation-set.ts` | `bindLocalInteractorOperationSet` → `bindLocalTouchInteractor` | pass-through |
| 22 | `packages/contracts/src/touch-runtime.ts` | `bindTouch`'s `tapPoint` op resolves the interactor (re-enters hop 15's `resolve`), then `executeGenericPress` calls `interactor.tap(x, y)` | substantive |
| 23 | `packages/platform-android/src/input-actions.ts` | `pressAndroid(device, x, y)` builds the adb argv, calls `runAndroidAdb` | thin |
| 24 | `packages/platform-android/src/adb.ts` | `runAndroidAdb` issues `adb shell input tap <x> <y>` | **terminal** |

## `snapshot` / iOS Simulator (XCTest): HTTP entry → runner fetch

24 files, 5 pass-through, 7 thin, 11 substantive, 1 terminal.

| # | File | Hand-off | Class |
|---|------|----------|-------|
| 1 | `src/daemon/server/http-server.ts` | parses the HTTP request, calls `handleRequest` | thin |
| 2 | `src/daemon/request-router.ts` | `createRequestHandler` → `runRequestHandlerChain` | pass-through |
| 3 | `src/daemon/request-handler-chain.ts` | routes `command: 'snapshot'` to `runSnapshotHandler`, lazy-loads `handlers/snapshot.ts` | thin |
| 4 | `src/daemon/handlers/snapshot.ts` | `handleSnapshotCommands` routes the plain-snapshot arm to `dispatchSnapshotViaRuntime` | thin |
| 5 | `src/daemon/snapshot-runtime.ts` | `dispatchSnapshotViaRuntime` → `dispatchSnapshotRuntimeCommand` | pass-through |
| 6 | `src/daemon/snapshot-command-runtime.ts` | resolves the bound capture, wires session/backend, calls `params.execute` | substantive |
| 7 | `src/daemon/snapshot-runtime-binding.ts` | `resolveBoundSnapshotCaptureRuntime` → `admitAndBindSnapshotCapture` → `bindSnapshotCaptureRuntime` → `bind(device, plan.use)` on the `active-app` arm | substantive |
| 8 | `src/daemon/session-runtime-admission.ts` | `admitRuntimePlan` / `requireRuntimeBinding` | thin |
| 9 | `src/daemon/request-runtime-binding.ts` | `bindDevice` → per-device-cached `gateway.bind(...)` | substantive |
| 10 | `src/platform-runtime-gateway.ts` | composed gateway's `loadLocal`: loads the host, calls `module.loadRuntime(host)` | substantive |
| 11 | `src/platform-runtime.ts` | declared boundary: wires `appleRuntimeModule`, supplies `loadHost` | thin |
| 12 | `src/platform-runtime-operation-host.ts` | `createPlatformRuntimeHost` builds `host`, incl. `localInteractors` | thin |
| 13 | `packages/platform-apple/src/index.ts` | declared boundary (`loadRuntime` pairing): lazy-imports `./runtime.ts`, calls `createApplePlatformRuntime`; also holds `applePlugin.createInteractor`, entered once and reused at hop 20 | pass-through |
| 14 | `packages/platform-apple/src/runtime.ts` | `createApplePlatformRuntime`'s `bind()` calls `bindAppleSnapshotRuntime` when `captureSnapshot` is admitted | substantive |
| 15 | `packages/platform-apple/src/runtime-snapshot.ts` | `bindAppleSnapshotRuntime` branches macOS-surface vs. app-snapshot, resolves the local interactor | substantive |
| 16 | `packages/contracts/src/snapshot-runtime.ts` | `bindLocalSnapshotInteractor`'s `captureSnapshot` op resolves the interactor (hop 17), calls `interactor.snapshot(options)` | substantive |
| 17 | `src/platform-runtime-local-application-interactors.ts` | `resolve()` lazy-imports `core/interactors.ts` | pass-through |
| 18 | `src/core/interactors.ts` | `getLocalInteractor` → `getPlugin('apple').createInteractor` (the package-owned `applePlugin`) | pass-through |
| 19 | `src/core/interactors/register-builtins.ts` | plugin registry; the `apple` entry is `applePlugin`, imported directly from the package | thin |
| 20 | `packages/platform-apple/src/interactor.ts` | `createAppleInteractor`'s `snapshot` calls `captureAppleSnapshot` → `captureAppleRunnerSnapshot` | substantive |
| 21 | `packages/platform-apple/src/runner/runner-client.ts` | `runAppleRunnerCommand` resolves the runner provider, applies the read-only retry policy, calls `provider.runCommand` | substantive |
| 22 | `packages/platform-apple/src/runner/runner-lifecycle.ts` | `executeRunnerCommand`: recycle-budget/session bookkeeping, calls `ensureRunnerSession` then `executeRunnerCommandWithSession` | substantive |
| 23 | `packages/platform-apple/src/runner/runner-session.ts` | `executeRunnerCommandWithSession` → `sendRunnerCommandOnce` | substantive |
| 24 | `packages/platform-apple/src/runner/runner-transport.ts` | issues `fetch(url, ...)` to the XCTest runner process | **terminal** |

## Why this differs from the ADR's 38/29

The façade PRs the plan sheet named as a candidate explanation (#2178, #2222, #2232) all merged
**before** `e624ef9d3f` — the commit the ADR cites for its 38/29 measurement — so they cannot be
why that count is higher than this one; they were already in effect when 38/29 was recorded.

This trace lands at 24 hops for both routes. The ADR text names no ordered chain, command/artifact,
or counting definition for 38/29, so the discrepancy cannot be resolved against it. The most likely
explanation is a different counting unit (for example, named exports or every static/type import
touched rather than distinct production files on the call path). **Treat 38 and 29 as superseded by
the auditable 24/24 measured here**, not as a second data point to reconcile.

## The ≤14 target

Splitting each traced route into stages:

- **Router spine** (shared by every command): hops 1-3, `http-server.ts` → `request-router.ts` →
  `request-handler-chain.ts`. 3 files, fixed.
- **Admission/binding** (resolve the session's device, admit the plan, obtain a bound
  capture/tap closure): press hops 4-11 (8 files, 2 substantive); snapshot hops 4-9 (6 files, 3
  substantive).
- **Gateway resolution** (the declared `platform-runtime.ts` boundary and its `loadRuntime`
  pairing): hops 12-14/10-13 (3 files, 2 substantive) on both routes — these files are pinned as
  boundaries by Decision §1/§2 and do not collapse regardless of target.
- **Interactor resolution** (the local-interactor plugin lookup, a second object graph parallel
  to the operations bind above): 3 pass-through/thin files on both routes.
- **Platform glue + terminal call**: press hops 18-24 (7 files, 4 substantive incl. terminal);
  snapshot hops 20-24 (5 files, 5 substantive incl. terminal, because the XCTest runner protocol
  — session lifecycle, recycle budget, transport — has no Android equivalent to `adb`'s
  single-process-call shape).

Collapsing every pass-through and thin file in the admission/binding and interactor-resolution
stages down to one hop each (folding `interaction-touch-prepare.ts` into `interaction-touch-press.ts`,
`runtime-admission.ts` into `touch-runtime.ts`, the interactor-resolution three-file chain into
one lookup, etc.) removes roughly 10 files from `press` (24 → ~14) and roughly 9 from `snapshot`
(24 → ~15), leaving mostly the substantive hops plus the fixed spine and declared boundaries.

That arithmetic makes ≤14 plausible for `press`/Android under an aggressive but not obviously
wrong collapsing plan. For `snapshot`/iOS it lands at ~15, and closing that last gap means cutting
into the runner-protocol's substantive hops (`runner-client.ts` / `runner-lifecycle.ts` /
`runner-session.ts` / `runner-transport.ts`), which carry retry policy, session-recycle budgeting,
and session-cache bookkeeping that is not obviously waste. No accepted plan collapses those four
into fewer files today.

**Verdict: ≤14 is a proposed target, unverified.** It is in the right neighborhood for `press`
under a plausible (not yet accepted) collapsing plan, and is not clearly reachable for `snapshot`
without a decision to fold runner-protocol mechanics that are load-bearing, not incidental. Treat
14 as a discussion anchor for the maintainer decision this ADR section defers to, not as a derived
number.
