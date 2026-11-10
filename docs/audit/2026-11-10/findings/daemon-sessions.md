# DSESS audit: `packages/daemon/src/sessions/`

## Coverage

- Slice: 250 files. 88 production files (~15k lines), 162 test files plus fixtures (~30k lines).
- Production source: read in full, about 97% of production lines. All of `handlers/`, `session-lifecycle/internal/`, `session-observability/internal/`, `server/daemon-idle-reap.ts`, and every top-level module.
- Tests: about 5% read. I read `dispatch-payload.test.ts`, `__tests__/session-teardown-budget.test.ts`, `handlers/__tests__/session.test.ts` and the head of `session-open-foreground.test.ts`. The rest got heuristic scans only (skip/only/todo markers: none; assertion-per-test ratio: no file with zero assertions). Fixture files were not read. Weak or duplicate tests are therefore under-reported.
- Outside the slice I read only what was needed to trace call paths: `core/session-store.ts`, `core/session-script-writer.ts`, `resources/lease-release.ts`, `server/request-execution-scope.ts`, `server/remote-host-input-policy.ts`, `src/daemon.ts`, `kernel/errors.ts`, and the flag registry.
- Nothing was run except `git grep` and one `node -e` check for DSESS-1. No gates, builds or tests.

Line numbers are file line numbers at the audited checkout.

## Findings

### DSESS-1: Inline `push` JSON longer than 255 bytes fails with "Unable to read Push payload file"
- Category: broken
- Severity: medium     Confidence: high
- Evidence:
  - `packages/daemon/src/sessions/payload-input.ts:30-48` — `resolvePayloadInput` calls `fs.statSync` on the raw argument before it checks `looksLikeInlineJson`. Any errno other than `ENOENT`/`EACCES`/`EPERM` becomes `COMMAND_FAILED "Unable to read Push payload file"`.
  - Verified: `node -e "fs.statSync('{\"aps\":{\"alert\":\"'+'a'.repeat(300)+'\"}}')"` throws `ENAMETOOLONG`. An inline payload with a path component over NAME_MAX (255 bytes, no `/` in that stretch) never reaches the inline branch.
  - `packages/daemon/src/sessions/handlers/session-app-deployment.ts:150-154,324-331` plus `packages/daemon/src/sessions/dispatch-payload.ts:6-11` — the local path resolves the argument twice. `resolvePushPayload` runs `resolvePayloadInput` with cwd expansion, then `readNotificationPayload` runs it again on the result with no cwd, so inline text is stat'ed a second time against the daemon cwd.
  - `packages/daemon/src/sessions/dispatch-payload.test.ts:33-48` — inline cases only use payloads under 30 bytes.
- Fix: in `payload-input.ts`, treat `ENAMETOOLONG` (and `ENOTDIR`) like `ENOENT`, or test `looksLikeInlineJson` first and stat only when it is false or the path exists. Have `resolvePushPayload` return the `ResolvedPayloadInput` and let `dispatch-payload.ts` take it, so the argument is resolved once. Files: `payload-input.ts`, `dispatch-payload.ts`, `handlers/session-app-deployment.ts`.
- Effort: S
- Model: sonnet
- Verify: add a test to `dispatch-payload.test.ts` with a 400-byte inline object; `pnpm vitest run packages/daemon/src/sessions/dispatch-payload.test.ts`.

### DSESS-2: Suite-owned test-session close never calls the lease provider
- Category: broken
- Severity: medium     Confidence: medium
- Evidence:
  - `packages/daemon/src/sessions/handlers/session-replay-command.ts:56-74` — `handleReplayTestCommand` does not destructure `leaseLifecycleProvider`, although `SessionCommandParams` carries it.
  - `session-replay-command.ts:211-236` — `closeReplayTestSession` calls `handleSessionCloseCommands` without `leaseLifecycleProvider`.
  - `packages/daemon/src/sessions/lease-lifecycle.ts:184-191,249-255` — with no provider, `closeLeaseDecision` returns `local-release`, and `releaseLease(registry, undefined, …)` drops the registry record without `provider.release`.
  - `packages/daemon/docs/remote-device-lease-contracts.md:43` — the contract says closing a session ends its lease unless it is `retainOnClose`. For a non-retained provider lease, the first test file's cleanup removes the registry lease while the provider instance keeps running and billing, and later files lose lease admission.
  - Not verified: whether suite sessions on provider leases always use `retainOnClose` in practice. If they do, the effect is latent.
- Fix: pass `leaseLifecycleProvider` through `handleReplayTestCommand` into `closeReplayTestSession` and on to `handleSessionCloseCommands`. Add a test with a non-retained provider lease that asserts `release` is called once. Files: `handlers/session-replay-command.ts`, a test under `__tests__/replay-suite/`.
- Effort: S
- Model: opus (lease and billing semantics; confirm the intended suite contract first)
- Verify: new test in `__tests__/replay-suite/session-test-suite.test.ts`; `pnpm vitest run packages/daemon/src/sessions/__tests__/replay-suite`.

### DSESS-3: Ordinary `close` reports success when the script write fails with a filesystem error
- Category: broken
- Severity: medium     Confidence: medium
- Evidence:
  - `packages/daemon/src/sessions/session-lifecycle/internal/session-close-script.ts:83-107` — `finalizeOrdinaryCloseScript` only handles a thrown error or `result.written === true`. A `{ written: false }` result returns `undefined`.
  - `packages/daemon/src/core/session-script-writer.ts:135,221-228` — for a session that is neither repair-armed nor an active publication, a non-`AppError` failure (for example `mkdirSync` `EACCES` or `ENOSPC`) returns `{ written: false }` with no error.
  - `packages/daemon/src/sessions/session-lifecycle/internal/session-close.ts:481,489-527` — the close then answers `Closed: <session>`. The only trace is a `session_script_write_failed` diagnostic in the daemon log. The session is retired, so the recording is lost.
  - The repair path (`session-close-script.ts:52-57`) and `session save-script` (`handlers/session-script-publication.ts:55-63`) both surface this case.
- Fix: in `finalizeOrdinaryCloseScript`, when the session is authoring-armed and `result.written` is false, return a `COMMAND_FAILED` built by `toOrdinaryCloseSaveScriptFailure`. Better still, have the writer return `{ written: false, error }` for every armed write so no caller can drop it. Files: `session-close-script.ts`, possibly `core/session-script-writer.ts` (owned by another slice).
- Effort: S
- Model: opus (crosses into the writer's contract)
- Verify: add a case to `session-lifecycle/internal/__tests__/session-close-error-precedence.test.ts` with an unwritable target directory.

### DSESS-4: Relative paths resolve against two different working directories
- Category: inconsistent
- Severity: medium     Confidence: medium
- Evidence:
  - Daemon cwd (`host.cwd`, captured once at `src/daemon.ts:18`):
    - `packages/daemon/src/sessions/handlers/session-app-deployment.ts:81` (`install` / `reinstall` app path)
    - `packages/daemon/src/sessions/handlers/trace-runtime.ts:41-44,106` (`trace start|stop <path>`)
  - Caller cwd (`req.meta.cwd ?? host.cwd`):
    - `session-app-deployment.ts:153` (`push`)
    - `packages/daemon/src/sessions/session-observability/internal/session-perf-runtime.ts:149,189,297,444`
    - `packages/daemon/src/sessions/handlers/record-runtime.ts:376`
    - `packages/daemon/src/sessions/handlers/lease.ts:370`
  - `packages/command-surface/src/management/install.ts:211-212` forwards the install path as typed; I found no client-side absolutisation.
  - One daemon serves several workspaces (session routing hashes `req.meta.cwd`, `session-routing.ts:83`), so `install ./app.apk` from a workspace other than the one that spawned the daemon gets `App binary not found: <daemon cwd>/app.apk`.
- Fix: add one helper, for example `requestCwd(req, host)`, and use it at every `expandSessionPath` call in the slice. Files: `handlers/session-app-deployment.ts`, `handlers/trace-runtime.ts`, plus the existing call sites.
- Effort: S
- Model: sonnet (opus if the `--save-script` paths in `core/` are aligned in the same change)
- Verify: tests in `handlers/__tests__/session-reinstall.test.ts` and `handlers/__tests__/trace-runtime.test.ts` with `req.meta.cwd` different from `host.cwd`.

### DSESS-5: `--retention-ms` above 2^31-1 deletes retained paths at once while reporting a far-future expiry
- Category: broken
- Severity: low     Confidence: high
- Evidence:
  - `packages/daemon/src/sessions/materialized-path-registry.ts:72-76` — `setTimeout(..., ttlMs)` with an unbounded `ttlMs`. Node clamps a delay over 2147483647 ms (about 24.8 days) to 1 ms.
  - `materialized-path-registry.ts:90` — the response still reports `expiresAt = now + ttlMs`.
  - `packages/daemon/src/sessions/handlers/session-app-source-deployment.ts:183-194` — only `<= 0` is rejected, and the message says "positive integer" without checking integrality.
  - `packages/command-registry/src/flag-definitions-action.ts:436-445` — the flag declares `min: 1` and no `max`.
- Fix: reject `ttlMs > 2_147_483_647` and non-integers in `resolveRetention`, and add the same `max` to the flag definition. Files: `handlers/session-app-source-deployment.ts`, `command-registry/src/flag-definitions-action.ts`.
- Effort: S
- Model: sonnet
- Verify: test in `handlers/__tests__/install-source.test.ts` with `materializedPathRetentionMs: 3_000_000_000` expecting `INVALID_ARGS`.

### DSESS-6: `doctor` without `--platform` reads each platform inventory one after another
- Category: inefficient
- Severity: medium     Confidence: high
- Evidence: `packages/daemon/src/sessions/handlers/session-doctor-device.ts:132-140` — `for (const platform of LOCAL_DEVICE_INVENTORY_PLATFORM_SELECTORS) { await readDeviceInventory(...) }`. Each call spawns that platform's tooling (adb, simctl, hdc and so on), so latency is the sum across platforms, not the slowest one. A failing platform also adds its full timeout.
- Fix: `await Promise.allSettled(selectors.map(...))`, then fold results into `discoveries` and `failures` in selector order so output stays stable. File: `handlers/session-doctor-device.ts`.
- Effort: S
- Model: sonnet
- Verify: `pnpm vitest run packages/daemon/src/sessions/handlers/__tests__ -t doctor`; add a fake-timer test asserting the reads overlap.

### DSESS-7: Required dependencies are typed optional, hiding 30 runtime guards and silent no-ops
- Category: inconsistent
- Severity: medium     Confidence: high
- Evidence:
  - `packages/daemon/src/sessions/request-handler-chain.ts:62-74` — the chain requires `bindDevice`, `inspectFacts`, `bindExactDevice`, the admission ledgers, `requestScope`, `retainDeviceExecutionLock` and `throwIfCanceled`.
  - `packages/daemon/src/sessions/handlers/session-command-input.ts:29-50` — `SessionCommandInput` makes all of them optional again, along with `leaseRegistry` and `platformResourceCleanup`.
  - Consequences:
    - 30 call sites of `requireRuntimeBinding` / `requireRuntimeFacts` / "is not configured" / "not supplied by root runtime composition" in the slice (grep count). The same `INTERNAL_ERROR` string appears three times: `session-lifecycle/internal/session-close.ts:302-307`, `handlers/session-replay-command.ts:75-80`, `session-teardown.ts:181-186`.
    - Cancellation silently disabled: `throwIfCanceled ?? (() => {})` at `session-observability/internal/session-observability.ts:117,389,420`.
    - `handlers/session-replay-video-owner.ts:39-48` returns `undefined` (no test video, no error) when any of six dependencies is missing.
    - `handlers/session.ts:218` builds a fresh `new LeaseRegistry()` per request when none is supplied. That default exists only for tests.
- Fix: make these fields required in `SessionCommandInput` and the downstream param types. Have the test harness (`__tests__/support/handlers/session-command-harness.ts`) supply fakes. Delete the guards and defaults. Files: `handlers/session-command-input.ts`, `handlers/session.ts`, `handlers/session-replay-video-owner.ts`, `session-observability/internal/*.ts`, `session-teardown.ts`, `session-lifecycle/internal/session-close.ts`, `core/session-runtime-admission.ts`, test harness.
- Effort: M
- Model: opus (wide type ripple through tests and `core/`)
- Verify: `pnpm typecheck`; `pnpm check:affected --run`.

### DSESS-8: Three ways to turn an error into a response; the hand-built one skips redaction and hint lifting
- Category: inconsistent
- Severity: low     Confidence: medium
- Evidence:
  - `packages/kernel/src/errors.ts:452-481` — `normalizeError` redacts `details`, lifts `hint` / `retriable` / `diagnosticId`, and applies the default hint for the code.
  - Hand-built `{ code, message, details }` copies that bypass it:
    - `packages/daemon/src/sessions/session-lifecycle/internal/inventory.ts:170-180` (`devices`)
    - `packages/daemon/src/sessions/session-runtime.ts:296-299` (`tryResolveOpenRuntimeHints`)
    - `packages/daemon/src/sessions/session-lifecycle/internal/session-open-prepare.ts:66-72`
    - `packages/daemon/src/sessions/session-lifecycle/internal/session-open-execution.ts:309-314`
  - Other handlers in the slice either throw to the router or return `{ ok: false, error: normalizeError(e) }` (for example `handlers/record-runtime.ts:103-108`, `session-observability/internal/session-perf-runtime.ts:102-104`).
  - Not verified: whether the router re-normalises returned failures. If it does, only the duplication remains.
- Fix: replace the four hand copies with `{ ok: false, error: normalizeError(error) }`, or let the error propagate.
- Effort: S
- Model: sonnet
- Verify: assert `error.hint` is top-level in `session-lifecycle/internal/__tests__/session-devices-batch-runtime.test.ts` for a failing inventory.

### DSESS-9: `perf` stop loses the tenant that `perf` start and `record` attribute output to
- Category: inconsistent
- Severity: low     Confidence: medium
- Evidence:
  - `packages/daemon/src/sessions/session-observability/internal/session-perf-runtime.ts:253,161,199` — start, memory snapshot and profile report use `session.lease?.tenantId ?? req.meta?.tenantId`.
  - `session-perf-runtime.ts:261-270` — the envelope stores `remoteCaptureTenantId` only when `publicNetworkOnly` is set.
  - `session-perf-runtime.ts:309-312` — stop falls back to `session.lease?.tenantId` only. A tenant request with no lease, not flagged public-network, gets `tenantId: undefined` in `withCaptureOutputOwnership`.
  - `packages/daemon/src/sessions/handlers/record-runtime.ts:277,286-293` — `record` stores the tenant whenever one exists.
- Fix: in `startPerfCapture`, write `remoteCaptureTenantId` whenever `tenantId` is set, as `record` does. Or add `?? req.meta?.tenantId` on stop.
- Effort: S
- Model: sonnet
- Verify: test in `session-observability/internal/__tests__/session-perf-runtime.test.ts`.

### DSESS-10: `handleSessionCommands` destructures 26 fields and rebuilds the same object (baselined complexity debt)
- Category: unneeded
- Severity: low     Confidence: high
- Evidence:
  - `packages/daemon/src/sessions/handlers/session.ts:209-272` — the function destructures `params`, then passes an object with the same fields to `handler`. The only change is the `leaseRegistry` default.
  - `fallow-baselines/health.json:86` — `packages/daemon/src/sessions/handlers/session.ts:complexity` is baselined.
  - `session.ts:109-128,134-169,176-193` — the `doctor`, `runtime`, `clipboard` and `prepare` entries re-pick fields the handlers could take from `SessionCommandParams` directly.
- Fix: `return await handler({ ...params, leaseRegistry: params.leaseRegistry ?? new LeaseRegistry() })`, or drop the default with DSESS-7. Remove the baseline entry.
- Effort: S
- Model: sonnet
- Verify: `pnpm gate` fallow health id with the baseline line removed; `pnpm vitest run packages/daemon/src/sessions/handlers/__tests__/session.test.ts`.

### DSESS-11: Three complexity gates are suppressed inline
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence: `// fallow-ignore-next-line complexity` at:
  - `packages/daemon/src/sessions/session-lifecycle/internal/session-open-execution.ts:219` (`completeOpenCommand`, about 180 lines)
  - `packages/daemon/src/sessions/session-lifecycle/internal/session-open.ts:245` (`handleOpenCommand`, about 180 lines, with duplicated existing-session and fresh-session admission tails)
  - `packages/daemon/src/sessions/session-observability/internal/session-perf-runtime.ts:124`
  - Root `AGENTS.md`: "Resolve a gate failure at the reported invariant. Do not suppress it."
- Fix: split `handleOpenCommand` into `openExistingSession` and `openFreshSession`. Extract the response and warning assembly from `completeOpenCommand` (lines 327-368). Move the perf `profile-report` arm to its own function. Remove the directives.
- Effort: M
- Model: opus (open lifecycle ordering is device-facing)
- Verify: fallow complexity gate with the directives removed; `pnpm vitest run packages/daemon/src/sessions/session-lifecycle`.

### DSESS-12: Dead flag, dead parameter, dead re-export, fake lazy loader, unreachable branches
- Category: unneeded
- Severity: low     Confidence: high
- Evidence:
  - `packages/daemon/src/sessions/handlers/session-replay-command.ts:224` writes `internal.cleanupIntent: 'suite-owned-test-session'`. `git grep cleanupIntent` finds only this writer and the type at `core/daemon-request.ts:69`. Nothing reads it.
  - `packages/daemon/src/sessions/handlers/record-trace.ts:20` declares `logPath?`, and `request-handler-chain.ts:270` passes it. The function body never reads it.
  - `packages/daemon/src/sessions/request-handler-chain.ts:127` — `export type { DaemonCommandRoute }` has no importer; consumers take it from `core/daemon-command-registry.ts`.
  - `request-handler-chain.ts:10,115-118,136-140` — the `generic` route wraps a statically imported module in `lazyImport`, and `loadGenericRequestHandlerModule` awaits it. The module is already eagerly loaded, so the laziness is not real.
  - `packages/daemon/src/sessions/handlers/session-doctor.ts:65` and `handlers/session-script-publication.ts:22` return `null` when `req.command` is not theirs. They are only reachable through the keyed table in `handlers/session.ts:109,132`.
- Fix: delete `cleanupIntent` (writer and type), the `logPath` param, and the re-export. Export the generic module directly, or make it truly lazy. Drop the two `null` branches and narrow the return types.
- Effort: S
- Model: sonnet
- Verify: `pnpm typecheck`; `pnpm vitest run packages/daemon/src/sessions/__tests__/request-handler-catalog.test.ts packages/daemon/src/sessions/request-handler-chain-routing.test.ts`.

### DSESS-13: Snapshot handler table is not exhaustive, and the session table's comment says it is
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence:
  - `packages/daemon/src/sessions/handlers/snapshot.ts:36,168` — `SNAPSHOT_COMMAND_HANDLER_IMPLS satisfies Record<string, SnapshotCommandHandler>`. A new `daemon.route: 'snapshot'` descriptor with no handler compiles and fails at runtime with the `expectHandlerResponse` routing-mismatch error.
  - `packages/daemon/src/sessions/handlers/session.ts:94-103` — the comment claims the session table "mirrors" the snapshot table as a compile-time exhaustive check.
  - The same comment cites `DISPATCH_HANDLERS in -device/device-selection/dispatch-resolve`. The path is mangled, and `git grep DISPATCH_HANDLERS` finds no such symbol.
  - Only `DescriptorSessionRouteCommandName` exists (`packages/command-registry/src/registry.ts:92`). The lease, recordTrace and humanControl routes use `switch` / `if` chains with a `null` default.
- Fix: add `DescriptorSnapshotRouteCommandName` (and optionally the lease and recordTrace equivalents) to `command-registry/src/registry.ts`, and use `satisfies Record<…>` in `snapshot.ts`. Correct the comment in `session.ts`.
- Effort: S
- Model: sonnet
- Verify: `pnpm typecheck`; temporarily remove one snapshot handler and expect a compile error.

### DSESS-14: Android allowlist sort idiom copied five times
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence: `resolveAndroidSerialAllowlist(flag, env)` followed by `[...set].sort()` appears at:
  - `packages/daemon/src/sessions/session-lifecycle/internal/inventory.ts:254-260` (named helper) and `:379-395` (inline, same file)
  - `packages/daemon/src/sessions/handlers/session-doctor.ts:316-322`
  - `packages/daemon/src/sessions/handlers/session-boot.ts:108-114`
  - `packages/daemon/src/sessions/handlers/session-appstate-device-runtime.ts:18-24` (another named helper)
- Fix: export one `sortedAndroidSerialAllowlist(flag, env)` beside `resolveAndroidSerialAllowlist` in `@agent-device/kernel/device-isolation` and use it at all five sites.
- Effort: S
- Model: sonnet
- Verify: `pnpm typecheck`; existing handler tests.

### DSESS-15: `doctor` colour follows the daemon's stderr, not the caller's terminal
- Category: inconsistent
- Severity: low     Confidence: medium
- Evidence: `packages/daemon/src/sessions/handlers/session-doctor.ts:71` — `shouldColorStatusMarkers(params.host.env, Boolean(process.stderr.isTTY))`. `host.env` and `process.stderr` belong to the daemon process (`src/daemon.ts:18`). A detached daemon has stderr redirected to its log, so the progress lines from `handlers/session-doctor-output.ts:35-46` are never coloured for a TTY caller. They are coloured only if the daemon was spawned with `FORCE_COLOR`, whatever the caller's `NO_COLOR` says. Only an embedded runtime gets the intended behaviour.
- Fix: send uncoloured structured progress (status plus text) and let the client colour it, or carry the caller's colour preference in `req.meta`. Files: `handlers/session-doctor.ts`, `handlers/session-doctor-output.ts`, client progress renderer.
- Effort: M
- Model: sonnet
- Verify: `pnpm vitest run packages/daemon/src/sessions/handlers/session-progress.test.ts`.

### DSESS-16: `doctor` remote-scope evidence uses a hand-copied flag list
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence: `packages/daemon/src/sessions/handlers/session-doctor-options.ts:18-43` — `REMOTE_PROVIDER_FLAG_KEYS` lists 24 keys. Twenty-two of them repeat the `provider*` / `aws*` block in `packages/command-registry/src/flag-groups.ts:86-108`. A provider flag added there is not reported by `doctor --remote`, so `remote-connection` can answer "No remote … scope is configured" for a configured provider.
- Fix: export the provider and aws key group from `command-registry/src/flag-groups.ts` and derive the doctor list from it.
- Effort: S
- Model: sonnet
- Verify: `pnpm vitest run packages/daemon/src/sessions/handlers/session-doctor-options.test.ts`.

### DSESS-17: `logs` binds the device runtime twice per command, and three actions bind only to discard
- Category: inefficient
- Severity: low     Confidence: medium
- Evidence:
  - `packages/daemon/src/sessions/session-observability/internal/session-observability.ts:165` binds `appLogAdmissionUse` for every `logs` request, before the action is parsed. An invalid action still pays for a bind.
  - `:189,194,219` bind again with `plan.use`.
  - `:204,207,210` — `stop`, `mark` and `clear` do `await params.bindDevice(device, plan.use)` and drop the result.
  - `packages/daemon/src/sessions/session-observability/internal/session-network.ts:48,58` has the same double bind.
  - Not measured: the cost of a bind. It depends on the owner.
- Fix: parse the plan first. Read admission facts through `inspectFacts`, as `session-audio.ts:59` already does, and bind once with `plan.use`. Skip the bind for actions that use no operation, unless the bind is the admission (then say so in the plan type).
- Effort: S
- Model: opus (confirm the bind is not load-bearing as admission)
- Verify: `pnpm vitest run packages/daemon/src/sessions/session-observability`.

### DSESS-18: Session scope does a synchronous filesystem walk on every call, with no memo
- Category: inefficient
- Severity: low     Confidence: medium
- Evidence:
  - `packages/daemon/src/sessions/session-routing.ts:66-85,315-340` — `resolveSessionScope` calls `resolveCallerScopeRoot`, which runs `fs.realpathSync.native` and then `fs.existsSync(<dir>/.git)` for each ancestor directory.
  - There are 13 production call sites in `packages/daemon/src` (grep count), several on one request path. Examples: `resolveEffectiveSessionName`, then `isImplicitSessionScopeConflict` (`open-device-contention-wait.ts:130`), `publishOpenSession` (`session-lifecycle/internal/session-open-state.ts:61`), `snapshot-command-runtime.ts:123`, `handlers/session-shutdown.ts:68`.
- Fix: memoise `resolveCallerScopeRoot` per raw cwd in a small request-scoped or LRU map, or resolve the scope once in the router and read it from `req.internal`.
- Effort: S
- Model: sonnet
- Verify: `pnpm vitest run packages/daemon/src/sessions/__tests__/session-routing.test.ts`.

### DSESS-19: `runtime set --platform apple` is refused on an iOS session
- Category: broken
- Severity: low     Confidence: medium
- Evidence: `packages/daemon/src/sessions/handlers/session-runtime-command.ts:194-203` — `toRuntimePlatform(req.flags?.platform ?? current?.platform ?? sessionLeaf)`. The flag wins over the session leaf, and `toRuntimePlatform('apple')` is `undefined` (`session-runtime.ts:108-115`). An iOS session then gets "runtime set only supports iOS, Android, and HarmonyOS sessions". The comment at `:194-195` says the leaf platform is resolved so selectors keep matching. `apple` is an accepted `--platform` selector (`session-routing.ts:23`).
- Fix: when a session exists, derive the platform from `sessionLeaf` and use the flag only to check agreement, through `matchesPlatformSelector`.
- Effort: S
- Model: sonnet
- Verify: test in `handlers/__tests__/session-runtime-command.test.ts`.

### DSESS-20: `network` limit accepts trailing junk
- Category: broken
- Severity: low     Confidence: high
- Evidence: `packages/daemon/src/sessions/session-observability/internal/session-network.ts:112-116` — `Number.parseInt(req.positionals[1], 10)` accepts `"25abc"` as 25 and `"1e3"` as 1. The message promises "an integer in range 1..200".
- Fix: use the strict integer reader the slice already uses for `--wait` (`readOptionalInteger`, `open-device-contention-wait.ts:26-30`), or `Number(value)` with `Number.isInteger`.
- Effort: S
- Model: sonnet
- Verify: test in `session-observability/internal/__tests__/` asserting `network dump 25abc` is `INVALID_ARGS`.

### DSESS-21: Comments that narrate history or are stale
- Category: unneeded
- Severity: low     Confidence: high
- Evidence (root `AGENTS.md`: comments only for public APIs, tool directives, or constraints code cannot show):
  - `packages/daemon/src/sessions/request-handler-chain.ts:248-250` — "Before R61 this leg reached the device through the retired dispatcher…".
  - `packages/daemon/src/sessions/session-lifecycle/internal/session-close.ts:209-220` — "Live evidence (2026-08-02): … used to fold into…".
  - `packages/daemon/src/sessions/session-replay-coordinator.ts:26-43` — points to "the P4b PR description" for the ownership split.
  - `packages/daemon/src/sessions/handlers/session.ts:94-103` — cites `getSessionCommandKind`'s "former" clusters and a symbol that does not exist (see DSESS-13).
  - `packages/daemon/src/sessions/server/daemon-idle-reap.ts:80-83` — says a recording "only ever exists alongside an open session", so the guard is kept for a future path. With reapable sessions (`:72-78`), `hasActiveRecording` is now the only thing that stops a reap of a repair or kept session with a live recording. The comment understates a load-bearing check.
  - `packages/daemon/src/sessions/handlers/record-runtime-request.ts:12-13` — `IOS_DEVICE_RECORD_MIN_FPS` / `MAX_FPS` are applied to every platform's `--fps` (`:27-35`).
- Fix: delete the history narration. Rewrite the idle-reap comment to state the present constraint. Rename the fps constants to `RECORD_MIN_FPS` / `RECORD_MAX_FPS`.
- Effort: S
- Model: sonnet
- Verify: `pnpm format && pnpm typecheck`.
