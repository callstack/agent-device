# Audit report: command packages (SLICE CMD)

Slice: `packages/command-runtime/`, `packages/command-surface/`, `packages/command-registry/`, `packages/command-output/`, `packages/device-selection/`, `packages/host-kit/`, `packages/provision-kit/` (~77k lines incl. tests), plus `docs/agents/cli-flags.md`.

## Coverage

Roughly 35-40% of production source read line by line; the rest skimmed or not reached. Tests were sampled, not audited.

- **Read fully:**
  - `command-output`: everything except `perf/output.ts`, `output/snapshot.ts`, `output/diff.ts`, `output/error.ts`.
  - `host-kit`: `internal/exec.ts`, `host-process.ts`, `process-lock.ts`, `owner-identity.ts`, `owned-process-reaper.ts`, `atomic-file.ts`, `path-resolution.ts`, `request-cancel.ts`, `retry.ts`, `runtime-slots.ts`, `session-paths.ts`, and the facades `process.ts` / `file.ts` / `host-file.ts` / `command.ts`.
  - `command-registry`: `flag-registry.ts`, `flag-types.ts`, `flag-groups.ts`, `catalog.ts`, `cli-command-aliases.ts`, `command-schema.ts`, `command-text.ts`, `derive.ts`, `parse-timeout.ts`, `wait-positionals.ts`, `batch.ts`, `timeout-policy.ts`.
  - `command-surface`: `index.ts`, `command-surface.ts`, `cli-grammar/common.ts`, `cli-grammar/registry.ts`, `family/types.ts`, `input-readers.ts`, `capture/wait.ts`, `schema/command-overrides.ts`.
  - `device-selection`: `dispatch-resolve.ts`, `device-selection-resolver.ts`.
  - `provision-kit`: `install-source.ts`, `install-source-download.ts`, `install-source-network.ts`, `install-source-network-transport.ts`.
  - `command-runtime`: `runtime.ts`, `index.ts`, `commands/index.ts`, `runtime-factory.ts`, `runtime-common.ts`, `wait-polling.ts`, `recording.ts`, `apps.ts`.
- **Skimmed (outline or grep only):** `command-registry/registry.ts` and `descriptors/*`, the four `flag-definitions-*.ts` files, `host-kit/internal/diagnostics.ts`, `owned-process-record.ts`, `verified-file.ts`, `command-surface` observability / interactions / selectors / snapshot / alert readers, about 25 small registry tests.
- **Not reached:**
  - `command-runtime` interaction runtime (settle, stable-capture, moving-target-gate, selector-read, gestures, resolution), `capture/runtime/snapshot.ts`, `diff-screenshot.ts`.
  - `command-surface` `system/`, `interaction/index.ts`, `replay/`, `command-input.ts`, `schema/cli-config.ts`, `option-schema.ts`.
  - `provision-kit` `provider-lease-table.ts`, `boot-diagnostics.ts`, `install-source-archive.ts`.
  - `host-kit` archive extraction, code-signature, exec-trace, version.
  - `device-selection/composed-inventory-gateways.ts`.

Checks that came back clean (not findings):
- **Flag wiring.** All 169 declared flag keys have at least one non-test reader outside the declaration files.
- **Schema-only CLI commands.** The flags each implementation in `src/cli/commands/*` reads match its `allowedFlags` / `supportedFlags`.
- **Malformed numeric positionals.** `network dump abc`, `events abc`, `scroll down abc`, `audio probe start abc`, `find … wait abc` produce `NaN` in the CLI reader, but `metadata.readInput` rejects it before the client call (probed by running the readers through `runCommand` with a stub client).
- **Dependency placement.** `undici`, `ipaddr.js`, `tar-stream`, `yauzl` sit in devDependencies but the product is bundled, so this is not a defect.

## Findings

### CMD-1: Five command-runtime families are bound but never invoked in production
- Category: unneeded
- Severity: medium     Confidence: high
- Evidence:
  - `packages/command-runtime/src/runtime.ts:10` — `createAgentDevice` is the only caller of `bindCommands` (`commands/index.ts:36-46`), which binds `system`, `apps`, `admin`, `recording`, `observability`.
  - `packages/command-runtime/src/index.ts:50-56` — the only production caller of `createAgentDevice` is `executeRecordingContactSheet`, which uses `.recording.contactSheet` alone.
  - `git grep createAgentDevice` outside the package returns nothing. The package's sole export `.` exposes only `createCommandSurfaceAgentDevice` (capture / selectors / interactions) and the contact-sheet entry.
  - Size: `commands/system/runtime/*`, `commands/management/runtime/*`, `commands/observability/runtime/*`, and `recording/runtime/recording.ts` (record / trace) total about 1.9k production lines plus about 0.9k test lines, reachable only from tests.
  - Fallow does not flag them because the bound object references them.
- Fix: delete the `system`, `management`, `observability` runtime families and `recordCommand` / `traceCommand`; reduce `bindCommands` / `AgentDevice` to capture, selectors, interactions, and `recording.contactSheet`; delete their tests. Then check which `AgentDeviceBackend` methods in `packages/contracts` lose their last caller (`openApp`, `pushFile`, `triggerAppEvent`, `startTrace`, …). If the families are kept on purpose as a future SDK surface, record that in an ADR.
- Effort: M
- Model: opus (cross-package contract fallout)
- Verify: `pnpm check:affected --run` (fallow dead-code, layering, typecheck) plus `pnpm vitest run packages/command-runtime`.

### CMD-2: `isCommandTimeoutError` matches any `COMMAND_FAILED` carrying a numeric `timeoutMs`
- Category: broken
- Severity: medium     Confidence: high
- Evidence:
  - `packages/host-kit/src/internal/exec.ts:677-683` tests only `code === 'COMMAND_FAILED' && typeof details.timeoutMs === 'number'`, while its doc comment says "True only for the COMMAND_FAILED error this module raises".
  - The same shape is produced by `request-cancel.ts:173-190` (`deadlineFailure`, `reason: 'daemon_request_timeout'`), `provision-kit/src/install-source.ts:157-161` (download timeout), and `command-runtime/.../wait-polling.ts:226` (every wait failure spreads `evidence.timeoutMs`).
  - Probed: an error thrown from `withRequestDeadline` returns `true` from `isCommandTimeoutError`.
  - Callers that swallow or reclassify on this predicate: `platform-android/src/app-lifecycle.ts:852` (returns undefined), `ime-helper.ts:146`, `observation.ts:113`, `adb-failure.ts:224,307`, `capture-kit/src/recording/video.ts:139`, `platform-apple/src/core/app-launch.ts:182`, `apple-runner/src/runner-artifact.ts:956`. A daemon request deadline firing inside those scopes is treated as a subprocess timeout.
  - This is the "typed reasons, not shape or text" rule in AGENTS.md.
- Fix: stamp `reason: 'exec_timeout'` (or a symbol-keyed marker) in `createTimeoutError` (`exec.ts:651`) and the `runCmdSync` ETIMEDOUT branch (`exec.ts:426`), and have `isCommandTimeoutError` test that marker. Update `packages/apple-runner/src/__tests__/runner-startup-failure-fixtures.ts:480`, which hand-builds the shape.
- Effort: S
- Model: sonnet
- Verify: new unit test in `packages/host-kit/src/internal/exec.test.ts` asserting `isCommandTimeoutError(deadlineFailure-shaped error) === false`; `pnpm vitest run packages/host-kit packages/platform-android packages/apple-runner`.

### CMD-3: Waiting on a process lock spawns the host process tool synchronously on every 100 ms poll
- Category: inefficient
- Severity: medium     Confidence: high
- Evidence:
  - `process-lock.ts:315-327` — `acquireProcessLockAcquisition` loops `tryAcquireProcessLock` every `DEFAULT_LOCK_POLL_MS = 100` (`:17`).
  - Each attempt runs `judgeStandingClaim` (`:262`), then `classifyOwnerLiveness` (`owner-identity.ts:69-81`), then `readHostProcessIdentityObservations`, which is `runCmdSync(ps …)` (`host-process.ts:226-232`). On Windows it is `powershell.exe Get-CimInstance` with a 2 s budget (`:14`).
  - A 30 s wait behind a live owner is therefore up to 300 blocking spawns on the daemon event loop. On Windows the loop is blocked almost continuously.
  - An async variant already exists and its own comment states this hazard (`host-process.ts:171-176`).
- Fix: in the async acquire loop, take the owner observation with `readHostProcessIdentityObservationsAsync` and pass it to `classifyOwnerLivenessFromObservation`. Keep the sync path only for `tryAcquireProcessLock`. Optionally reuse a "live, same claimToken" verdict for N polls.
- Effort: M
- Model: opus (lock correctness, concurrency)
- Verify: `pnpm vitest run packages/host-kit/src/internal/process-lock*.test.ts` plus a new test counting `ps` spawns across a 1 s contended wait.

### CMD-4: The process-lock reclaim mutex has no owner and no recovery path
- Category: broken
- Severity: medium     Confidence: medium
- Evidence:
  - `process-lock.ts:484-494` — `holdReclaimMutex` creates `<stem>.reclaim.lock` with `openSync(..., 'wx')` and writes nothing into it.
  - `:509` — release is a plain `unlinkSync`.
  - A process that dies (SIGKILL, OOM, power loss) between the two, in the guarded section of `tryAcquireProcessLock` (`:140-160`) or of `release()` (`:371-377`), leaves the file behind.
  - Every later `tryAcquireProcessLock` then returns `busy` (`:147-149`) until the 30 s timeout, and the only remedy is the manual-removal hint in `staleLockHint` (`:399`).
  - The main lock reclaims provably dead owners; this guard does not, so the "automatically reclaims provably dead owners" property stated in AGENTS.md does not hold for it.
  - The window is a handful of sync fs calls, so the event is rare, but it is permanent when it happens.
- Fix: write `{pid, startTime}` into the mutex file and let a contender reclaim it when `classifyOwnerLiveness` proves the holder dead or reused (same proof rule as the main lock).
- Effort: M
- Model: opus (concurrency)
- Verify: new test in `process-lock.test.ts` that plants an orphaned `.reclaim.lock` owned by a dead pid and expects acquisition to succeed.

### CMD-5: Install-source download has a fixed 120 s whole-transfer timeout against a 2 GiB cap
- Category: broken
- Severity: medium     Confidence: medium
- Evidence:
  - `provision-kit/src/install-source.ts:48,127-128` — `AbortSignal.timeout(120_000)` is passed as the request signal and so also aborts the body `pipeline` (`install-source-download.ts`, `writeResponse`).
  - `host-kit/src/internal/artifact-limits.ts:1` allows `MAX_ARTIFACT_COMPRESSED_BYTES = 2 GiB`.
  - `command-registry/src/timeout-policy.ts:14-15` sets a 600 s envelope "for install-from-source URL materialization".
  - Any artifact needing more than 120 s (below about 17 MB/s for the full 2 GiB, or about 500 MB on a 30 Mbit link) fails with "App source download timed out", although both the byte cap and the envelope allow it.
  - I did not find a test that pins 120 s as intended for the body.
- Fix: bound connect/headers and idle time (stall timeout) rather than the whole body, or derive the whole-transfer budget from the request envelope. Touches `install-source.ts`, `install-source-download.ts`.
- Effort: S-M
- Model: sonnet
- Verify: extend `packages/provision-kit/src/install-source-download.test.ts` with a slow-but-progressing body past the old limit.

### CMD-6: host-kit has three TERM-then-KILL escalations that disagree; the reaper mislabels a kill timeout
- Category: inconsistent
- Severity: medium     Confidence: medium
- Evidence:
  - `host-process.ts:684-699` `stopProcessAndConfirmExit` — identity-proved, with typed verdicts.
  - `host-process.ts:810-819` `stopPidsWithEscalation` — best-effort, no identity check.
  - `owned-process-reaper.ts:158-211` `reapOwnedProcess` / `escalateOwnedProcess` — its own copy, with a private `signalBestEffort` (`:214`) duplicating `signalPidsBestEffort`.
  - `owned-process-reaper.ts:196` returns `'ownership-lost'` for any non-exit after SIGKILL. A process that is still provably ours (`owned-alive`) is reported in `ownershipLost` / `ownershipLostPids`, where `stopProcessAndConfirmExit` would say `exit-timeout`.
  - `inspectOwnedProcess` (`:176-181`) reports `'ownership-lost'` when `ps` simply did not answer, where `stopProcessAndConfirmExit` says `identity-unverified`.
- Fix: implement the reaper on `stopProcessAndConfirmExit`, with `identity = {startTime, matches: cmd => cmd === record.command}` and a parameter for the initial signal (SIGINT for `simctl-screen-recording`). Map the verdicts into the summary and add an `unconfirmed` / `survived` bucket.
- Effort: M
- Model: opus (process ownership semantics)
- Verify: `pnpm vitest run packages/host-kit/src/internal/host-process-stop-confirm.test.ts` and the reaper tests.

### CMD-7: `readProcessIdentityFacts` spawns `ps` three times per pid and does not leave the executor override
- Category: inefficient
- Severity: low     Confidence: high
- Evidence:
  - `host-process.ts:129-141` runs three concurrent `ps -p <pid> -o <field>` processes (`lstart=`, `command=`, `state=`), although `HOST_PROCESS_IDENTITY_PS_ARGS` (`:209`) already reads several fields in one call.
  - It is called twice per pid in `stopProcessAndConfirmExit` (`:714`, `:786`) and twice per record in the startup reaper (`owned-process-reaper.ts:178,205`). That is 6 spawns per stopped or reaped process.
  - `readProcessFieldAsync` (`:296-310`) and `isAppleSiliconMac` (`:871`) call `runCmd` inside any active `CommandExecutorOverride`. `readHostProcessIdentityObservationsAsync` (`:187`) deliberately wraps in `withoutCommandExecutorOverride` because "what a host says about a pid is never a toolchain command to route elsewhere".
  - `hostPsCommand()` (`:81-89`) repeats `fs.accessSync` on every probe.
- Fix: one `ps -p <pid> -o state=,lstart=,command=` call (command last, since it contains spaces) parsed like `parseHostProcessIdentityRows`; wrap it in `withoutCommandExecutorOverride`; memoize `hostPsCommand`.
- Effort: S
- Model: sonnet
- Verify: `pnpm vitest run packages/host-kit/src/internal/host-process*.test.ts`.

### CMD-8: `runCmdDetached` returns pid 0 on spawn failure and discards the error
- Category: broken
- Severity: low     Confidence: high
- Evidence:
  - `exec.ts:487` — `const pid = child.pid ?? 0`. `runCmdDetached` (`:465-471`) returns only `.pid` and drops the `exited` promise, which holds the ENOENT message.
  - Two callers compensate with their own `pid <= 0` check and a generic message that loses TOOL_MISSING: `react-native/src/metro/client-metro.ts:411`, `react-native/src/companion/client-companion-tunnel.ts:412`.
  - `src/platform-runtime-android-emulator-host.ts:48-58` does not check. A missing `emulator` binary yields pid 0, which is passed to the osascript helper and returned to the caller.
- Fix: in `runCmdDetachedMonitored`, when `child.pid` is undefined, throw `TOOL_MISSING` / `COMMAND_FAILED` built from the pending `error` event, or make `runCmdDetached` async and await the first of `spawn` / `error`. Remove the caller-side `pid <= 0` checks.
- Effort: S
- Model: sonnet
- Verify: `pnpm vitest run packages/host-kit/src/internal/exec.test.ts` with a new case for a nonexistent absolute path.

### CMD-9: Graceful-kill escalation is cancelled when the direct child exits, so detached-group descendants never get SIGKILL
- Category: broken
- Severity: low     Confidence: medium
- Evidence:
  - `exec.ts:940-956` — with `options.kill`, `killProcessTree` sends the grace signal to the group, arms a SIGKILL timer, then `child.once('exit', () => clearTimeout(escalation))`.
  - If the direct child honours SIGTERM while a descendant in the same detached group ignores it, the group SIGKILL is never sent.
  - The non-grace path SIGKILLs the whole group (`:945`). A kill requested after the child already exited does fire the timer, because no further `exit` event arrives. So the three orderings behave differently, against the comment at `:939`.
  - Current `kill:` users: `platform-apple/src/foldable/fold-helper.ts:78`, `platform-apple/src/os/macos/helper.ts:338`. I did not confirm whether they pass `detached`.
- Fix: for `detached` runs, do not cancel the escalation on child exit; let it SIGKILL the group (it is a no-op when the group is empty). Keep the cancel for non-detached runs.
- Effort: S
- Model: opus (signal and process-group behaviour)
- Verify: new case in `packages/host-kit/src/internal/exec-kill-settle.test.ts`: a detached parent exits on SIGTERM while a grandchild traps it.

### CMD-10: Device-resolution cache key omits `appleSimulatorAppTarget` and serializes the whole environment
- Category: inconsistent
- Severity: low     Confidence: medium
- Evidence:
  - `device-selection/src/dispatch-resolve.ts:306-320` drops `appleSimulatorAppTarget` from the key.
  - That option changes which simulator is selected before the result is cached: `resolveLocalAppleDeviceSelection` passes it to `resolveAppInstalledSimulatorSelection` (`device-selection-resolver.ts`, reason `single-app-installed-local`).
  - Within one request scope (`daemon/src/server/request-router.ts:288`, which includes batch and replay composites), a resolve with app target B after one with app target A or none returns A's cached device.
  - `appDeviceTarget` and `webSession` are correctly applied after the cache read; the app target is not.
  - `cacheOptions` still contains `env`, so every resolve `JSON.stringify`s the full environment into the key.
- Fix: include `appleSimulatorAppTarget` in the key; replace `env` with the env-derived values that matter (already folded into `request.iosSimulatorSetPath` / `androidSerialAllowlist`) or drop it.
- Effort: S
- Model: sonnet
- Verify: new case in `packages/device-selection/src/__tests__/dispatch-resolve.test.ts`: two booted simulators, two app targets, one cache scope.

### CMD-11: `snapshot --timeout` replaces the client envelope with no margin, and the derived daemon budget goes negative
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence:
  - `command-registry/src/registry.ts:450-452` — the comment says "--timeout widens the envelope", but `budget: { source: 'flag' }` takes the default `bound` branch at `timeout-policy.ts:153` (`return flags.timeoutMs`).
  - `snapshot --timeout 5000` therefore shrinks the client envelope from 90 s to exactly 5 s with no result margin. `--timeout 200000` gives client and daemon the same number, so the "daemon's own timeout result wins the race" rule at `timeout-policy.ts:17-19` does not hold.
  - `resolveCommandDaemonBudgetMs` (`:114-120`) then returns `timeoutMs - 30000`, i.e. -25 000 for 5 s. `daemon/src/core/daemon-command-registry.ts:49-55` turns that into a result deadline already in the past.
  - That deadline is currently read only by `daemon/src/sessions/application-lifecycle-execution.ts:40`, so this is latent for snapshot.
  - `src/__tests__/command-descriptor-timeout-policy.test.ts:119` pins snapshot as the only `bound` command, so the mode is deliberate. The comment and the negative budget are the defects.
- Fix: clamp `resolveCommandDaemonBudgetMs` at `>= 0`, or for `bound` return the daemon budget as `timeoutMs` and the envelope as `timeoutMs + margin`. Correct the registry comment.
- Effort: S
- Model: sonnet
- Verify: `pnpm vitest run src/__tests__/command-descriptor-timeout-policy.test.ts` with a new assertion that the daemon budget is non-negative for `snapshot` with `timeoutMs: 5000`.

### CMD-12: `wait` positional numbers use loose `Number()`; `wait stable` silently drops garbage; `parseTimeout` exists three times
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence:
  - `command-registry/src/parse-timeout.ts:1-5` uses `Number(value)`.
  - Probed through `readInputFromCli` + `runCommand`: `wait 0x10` sleeps 16 ms, `wait " "` sleeps 0 ms, and `-5` passes as `durationMs: -5` if it reaches the reader. The MCP schema declares `durationMs` / `timeoutMs` / `quietMs` as `integerField()` (`command-surface/src/capture/wait.ts:66-74`).
  - `wait-positionals.ts:48-53` — `wait stable abc` runs with no quiet window and `wait stable 500 2000 junk` ignores `junk`. The structured path refuses the equivalent (`wait.ts`: "wait stable requires quietMs before timeoutMs").
  - Byte-identical copy at `packages/selectors/src/internal/find.ts:286-290`; a third, different `parseTimeout` at `packages/react-native/src/metro/client-metro.ts:244`.
  - `cli-grammar/common.ts:255-259` — `readFiniteNumber('')` returns 0 (`alert wait ""` gives `timeoutMs: 0`), while the sibling `isFiniteNumberString` rejects blanks.
- Fix: one strict non-negative-integer parser (`/^\d+$/`) exported from `@agent-device/selectors` or kernel and used by both wait and find; make `parseStableKeyword` return `invalid` for non-numeric or extra tokens; have `readFiniteNumber` reject blank strings.
- Effort: S
- Model: sonnet
- Verify: `pnpm vitest run packages/command-registry/src/wait-positionals.test.ts packages/command-surface/src/capture`.

### CMD-13: Human text output omits or mangles data the JSON output carries
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence:
  - `command-output/src/recording/output.ts:33-41` — single-file `record stop` text never prints `telemetryPath`, which the daemon always returns (`daemon/.../record-runtime-response.ts:73`). Only the chunked branch does (`:17`). The chunked branch omits `sessionStateDir`. Start and stop render identically (bare path).
  - `management/output.ts:35` — `devices` with zero devices prints an empty string, while `apps` prints "No apps found." (`:64-69`).
  - `metro/output.ts:9` — reload prints "Reloaded React Native apps via undefined" when `reloadUrl` is absent.
  - `management/output.ts:87` — `session list` text is the JSON document itself.
  - `output/result-serialization.ts` (`formatDeliveredArtifactLines`) — truncates to 3 artifacts with no "N more" indicator.
- Fix: print the telemetry and session-state lines in both record branches; add an empty-list line for `devices`; guard `reloadUrl`.
- Effort: S
- Model: sonnet
- Verify: `pnpm vitest run packages/command-output`.

### CMD-14: `withSettledNotes` discards `jsonData` and `stderr` from the formatter it wraps
- Category: broken
- Severity: low     Confidence: high (latent)
- Evidence:
  - `command-output/src/settle-output.ts:36-41` returns `{ data, text }` only.
  - `withSettleCapableNotes` wraps every settle-capable formatter (click, press, fill, longpress, hover, scroll, back). Any of them that starts returning `stderr` or `jsonData` loses it silently.
  - No wrapped formatter sets those fields today, so nothing is lost yet.
- Fix: `return { ...output, text: appendResponseNotes(...) }`.
- Effort: S
- Model: sonnet
- Verify: add a case to `packages/command-output/src/settle-output.test.ts` with a formatter that returns `stderr`.

### CMD-15: host-kit helpers are re-implemented elsewhere and inside host-kit
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence (all sites depend on host-kit, or are inside it):
  - **Executable check.** `src/platform-runtime-host.ts:50-57` and `capture-kit/src/recording/swift-cache.ts:245-252` vs `host-kit` `isExecutablePath` (`exec.ts:839`). The `src/` copy checks neither file-ness nor the win32 mode.
  - **Sleep.** `capture-kit/src/audio-probe-runtime.ts:259`, `platform-android/src/recording/chunks.ts:270`, `provider-webdriver/src/webdriver-interactor.ts:59`, `src/cli/auth-session.ts:600` vs `host-kit` `sleep` (`retry.ts:256`, abortable).
  - **Home expansion.** `src/cli/replay-test/reporters/custom.ts:51-53` re-implements `~/` with `os.homedir()` where `expandUserHomePath` honours `env.HOME`.
  - **Env truthiness.** `retry.ts:56` `isEnvTruthy` duplicates `kernel/src/source-value.ts:12` `BOOLEAN_TRUE_VALUES`.
  - **Inside host-kit.** `diagnostics.ts:346` `sanitizePathPart` equals `session-paths.ts:3` `safeSessionName`; `atomic-file.ts:156` has a private `lstatIfPresent` equal to the exported `verified-file.ts:136`.
  - **Durable publish.** `owned-process-record.ts:61-75` hand-rolls `publishDurableFileSync` (open wx 0600, fsync, safety check, rename) but without the directory fsync that `atomic-file.ts:66` does. Its record is therefore less durable than the helper it copies.
  - **In command-runtime.** `management/runtime/apps.ts:357-367` `toAppBackendContext` is a verbatim copy of `runtime-common.ts:4-14`; `wait-polling.ts:425` duplicates `runtime-common.ts` `now`.
- Fix: replace each copy with the host-kit / kernel export; have `owned-process-record.ts` call `publishDurableFileSync`, adding an "assert before rename" hook if its symlink check differs.
- Effort: M (many small edits)
- Model: sonnet
- Verify: `pnpm check:affected --run`.

### CMD-16: Home-directory resolution contradicts itself inside host-kit
- Category: inconsistent
- Severity: low     Confidence: medium
- Evidence:
  - `host-file.ts:10-20` says callers must "never fall back to `os.homedir()`, because the process home is an ambient read that #3753 forbids".
  - `path-resolution.ts:11-13` falls back to `os.homedir()` in `resolveHomeDirectory`.
  - `resolveDeviceClaimRoot` (`path-resolution.ts:50-52`) uses `os.homedir()` directly and ignores `env.HOME` and `AGENT_DEVICE_HOME`. `resolveUserConfigPath` (`:42-48`), in the same file, honours both.
  - A daemon started with a captured env that names a different HOME therefore gets its config from one home and its device claims from another.
- Fix: decide the rule and apply it once. If the claims directory must be host-global, document that on `resolveDeviceClaimRoot`. Remove the `os.homedir()` fallback in `resolveHomeDirectory` or correct the comment.
- Effort: S
- Model: opus (touches the device-claim sharing contract)
- Verify: `pnpm vitest run packages/host-kit/src/internal/path-resolution.test.ts`.

### CMD-17: `safeSessionName` is lossy, so distinct session names share one state directory
- Category: broken
- Severity: low     Confidence: low
- Evidence:
  - `host-kit/src/session-paths.ts:3-5` maps every character outside `[A-Za-z0-9._-]` to `_`. `"my app"`, `"my_app"`, and `"my:app"` all resolve to `sessions/my_app`.
  - Consumers: `daemon-contracts/src/session-artifact-paths.ts:73`, `daemon/src/core/session-store.ts:496`, `react-native/src/metro/metro-session-hints.ts:37`, `capture-kit/.../durable-capture-resource.ts:54`.
  - I did not find an upstream validator restricting `--session` to the safe alphabet. I did not trace every entry point, hence low confidence.
- Fix: reject names containing unsafe characters at admission, or make the mapping injective (percent-encode or append a short hash when the name was altered).
- Effort: S-M
- Model: opus (on-disk layout compatibility)
- Verify: unit test in `session-paths.test.ts`, plus a daemon test opening two sessions that differ only by an unsafe character.

### CMD-18: `retryWithPolicy` reports `exhausted` with `attempt = maxAttempts` when it stopped early
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence:
  - `host-kit/src/internal/retry.ts:181-190` always emits `{ event: 'exhausted', attempt: merged.maxAttempts }` at warn level.
  - The loop also exits at `:151` (`shouldRetry` returned false on attempt 1), on deadline expiry, and when `boundedDelay <= 0`.
  - Diagnostics therefore show "exhausted, attempt 3/3" for an error that was tried once and classified non-retriable.
- Fix: track the real last attempt and emit a distinct event (`not_retriable` / `deadline`) or a `stopReason` field.
- Effort: S
- Model: sonnet
- Verify: `pnpm vitest run packages/host-kit/src/internal/retry.test.ts`.

### CMD-19: `readHostCpuArch` caches a failed probe for the life of the process
- Category: broken
- Severity: low     Confidence: medium
- Evidence:
  - `host-process.ts:871-880` — `isAppleSiliconMac` returns `false` on any throw or timeout (1 s sysctl budget).
  - `:852-855` — `settleHostCpuArch` then memoizes `x86_64` (when Node runs under Rosetta) permanently.
  - One slow `sysctl` at daemon start mis-reports the host architecture to every later simulator / runner build decision.
- Fix: do not settle the cache when the probe failed (distinguish "answered 0" from "did not answer").
- Effort: S
- Model: sonnet
- Verify: `pnpm vitest run packages/host-kit/src/internal/host-process-cpu-arch.test.ts`.

### CMD-20: `--on-error` is a flag whose only legal value is its default
- Category: unneeded
- Severity: low     Confidence: medium
- Evidence:
  - `command-registry/src/flag-definitions-workflow.ts:197-201` — `--on-error` has `enumValues: ['stop']`.
  - `contracts/src/cli-flags.ts` types `batchOnError?: 'stop'`.
  - `command-registry/src/batch.ts` (`runBatch`) defaults to `'stop'` and rejects anything else.
  - The flag, its `CliFlags` key, its validation branch, and its help line can only express the default.
- Fix: remove the flag and the `batchOnError` plumbing, or leave it only if a `continue` mode is actually planned (then record that in an issue).
- Effort: S
- Model: sonnet
- Verify: `pnpm vitest run packages/command-registry/src/__tests__/batch.test.ts` plus the help-conformance gate.

### CMD-21: Nineteen single-assertion registry tests restate descriptor literals against the constants the registry imports
- Category: unneeded
- Severity: low     Confidence: medium
- Evidence:
  - `packages/command-registry/src/__tests__/registry-*-runtime-execution.test.ts` — 19 files, 378 lines.
  - Example: `registry-apps-runtime-execution.test.ts` asserts `descriptor.platformExecution` equals `{ kind: 'device-runtime', uses: [appsRuntimeUse] }`, while `registry.ts:371` is literally `uses: [appsRuntimeUse]`. `registry-trace-…` and `registry-logs-…` follow the same pattern.
  - They can fail only when someone edits the descriptor line they mirror. Each file re-imports the full registry.
  - A few carry real cross-file intent (for example click/press sharing in `registry-click-runtime-execution.test.ts`) and should stay.
- Fix: fold the pure mirrors into one table-driven test (command to expected uses); keep the ones that assert a relation between two descriptors or two constants.
- Effort: S
- Model: sonnet
- Verify: `pnpm vitest run packages/command-registry`.
