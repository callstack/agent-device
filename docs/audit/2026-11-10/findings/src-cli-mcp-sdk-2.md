# Audit: SRC2 slice (root `src/` parts the first SRC agent did not reach)

## Coverage

Scope: the "Not reached" list of `src-cli-mcp-sdk.md` (about 13k non-test lines). Findings SRC-1..SRC-24 are not repeated.

- Read fully (about 80% of the non-test lines in scope):
  - All top-level wiring: `src/platform-runtime.ts`, `platform-runtime-gateway.ts`, `platform-runtime/request-providers.ts`, `platform-runtime-operation-host.ts`, and every `src/platform-runtime-*.ts` non-test file except the three the first agent skimmed (`runtime-hints`, `daemon-lifecycle`, and the `daemon-services` file is read). That is 45 files, including `app-log-process`, `app-log-output`, `app-log-android-transport`, `perf-capture-host`, `perf-host`, all nine `screen-recording-*` files, `android-adb-host`, `network-host`, `audio-probe-host`, `resource-cleanup`, `open-target`, both `*-application-tools`, `claim-recovery`, `device-*`.
  - `src/provider-{limrun-credentials,limrun-runtime,plugin-policy,webdriver,credential-fingerprint,device-runtimes}.ts`, `src/sdk/limrun-runtime-dependencies.ts`.
  - All of `src/core/interactors/` non-test files (`limrun-ios-{runner,runner-products,runner-errors,files,tools,app-logs,application-tools}.ts`, `android.ts`, `register-builtins.ts`) and `src/core/limrun-download-file.ts`.
  - All of `src/cli/connection/*.ts`, and `src/cli/commands/{connection,connection-lease-transaction,connection-runtime,connection-metro-runtime,connection-previous-lease,connection-context,connection-lease-policy,proxy-lease-device,proxy,takeover}.ts`.
  - `src/cli/replay-test/reporting.ts`, `reporters/{registry,custom,junit}.ts`.
- Skimmed: `src/cli/commands/connection-presentation.ts` (call sites only), `src/cli/command-explain.ts` (first 60 lines), `src/platform-runtime-runtime-hints.ts`.
- Not reached: `src/cli/replay-test/{progress,trace}.ts`, `reporters/{default,format,progress,spec}.ts`, `src/commands/schema/cli-help*.ts` text, `src/mcp/tool-ref-pins.ts`, the `*.fixtures.ts` bodies.
- Tests (`src/__tests__` and co-located, 1898 test cases): scanned mechanically, not read. Scans run: `.skip/.only/.todo` (only platform/uid `skipIf`, all justified), tautological asserts (none), try/catch-only asserts (5 hits, each guarded by a preceding `toThrow` or an `assert.fail` that the catch body rejects), real sleeps of 100 ms or more (3 files, each needs a real child process), duplicate test titles (none found). I read the tests beside each finding to see what is pinned. No weak or dead test is reported; test placement is already SRC-22.
- No commands were run except `grep`, `git log`, `wc`. Two scratch dumps sit beside this report: `src2-conn.txt`, `src2-hosts.txt`.

## Findings

### SRC2-1: Android recording writer scan spawns three `adb shell` calls for every process on the device
- Category: inefficient
- Severity: medium     Confidence: high (code path); medium (size of the effect on a real device)
- Evidence: `src/platform-runtime-screen-recording-android-host.ts:84-104` — `probeRunningWriters` runs `ps -A -o pid=`, then calls `inspectAndroidScreenRecordingProcess` for every pid inside one `Promise.all`. Each inspection (lines 158-186) runs `test -d /proc/<pid>`, `cat /proc/<pid>/stat`, `cat /proc/<pid>/cmdline` as separate `adb shell` processes with a 5 s timeout. A device with 400 processes gives about 1200 `adb` spawns, 400 at once. Any one that times out returns `uncertain`, which sets `conclusive: false` for the whole scan (line 102). Callers: `packages/platform-android/src/recording/start-reconciliation.ts:105` and `cleanup.ts:96,107` (every record start reconciliation and cleanup).
- Fix: filter on the device in one shell call, for example `ps -A -o pid=,args=` (or `pgrep -f screenrecord`), keep only rows whose executable basename is `screenrecord` and whose last argument is `remotePath`, and inspect only those pids. File: `src/platform-runtime-screen-recording-android-host.ts` and its test.
- Effort: S
- Model: opus (device-facing; needs an emulator run per `docs/agents/device-verification.md`)
- Verify: `src/platform-runtime-screen-recording-android-host.test.ts` with a fake shell that counts calls: the count must not grow with the number of pids. Then `record start` / `record stop` on an emulator.

### SRC2-2: Managed-process identity reads block the daemon event loop with synchronous `ps`
- Category: inefficient
- Severity: medium     Confidence: high
- Evidence: `src/platform-runtime-screen-recording-process-host.ts:48-57` — `resolveManagedProcessIdentity` wraps `readProcessStartTime` and `readProcessCommand` in `Promise.all([Promise.resolve(...), Promise.resolve(...)])`. Both are `runCmdSync('ps', ...)` with a 1 s timeout (`packages/host-kit/src/internal/host-process.ts:144-150,282-294`), so the two reads run one after the other on the event loop. The same file says at lines 24-29 that identity reads "run off the event loop"; that holds only for `readOwnershipEvidence`. Sync callers: `resolveManagedProcessTree` (line 64, two `ps` per tree member, after `listHostProcesses` already returned each command), `inspectManagedProcess` / `markerMatches` (lines 91-97, 217-229, three `ps` per marker, called per marker in `markerSetExits` for each of three signals), `waitForManagedProcessIdentity` in `platform-runtime-screen-recording-apple-simulator-host.ts:99-119` (poll every 25 ms, up to 80 times), `platform-runtime-audio-probe-host.ts:49,59`, `platform-runtime-perf-capture-host.ts:73,211,230`, and the app-log twin `platform-runtime-app-log-process.ts:293-311,405-438`. The daemon serves all sessions on this loop, so one `record stop` stalls every other session for the sum of these spawns.
- Fix: make `resolveManagedProcessIdentity` and `inspectManagedProcess` use `readProcessIdentityFacts` (already async, one call for start time, command and state). Reuse the `command` from `listHostProcesses` in `resolveManagedProcessTree`. Do the same in `platform-runtime-app-log-process.ts`. Correct the comment.
- Effort: M
- Model: opus (process ownership fencing; a wrong answer signals a foreign pid)
- Verify: `src/platform-runtime-screen-recording-process-host.test.ts` and `platform-runtime-app-log-process.test.ts`; add a test that `runCmdSync` is not called on the start/stop path.

### SRC2-3: `app.log` rotates only when the sink opens; docs say it rotates at 5 MB; `network dump` reads the whole file synchronously
- Category: inconsistent
- Severity: medium     Confidence: high
- Evidence: `src/platform-runtime-app-log-output.ts:14` calls `ensureAppLogPath` once in `openAppLogOutput`; that is the only place `rotateAppLogIfNeeded` runs on this path (`packages/capture-kit/src/capture-admission/app-log-files.ts:15-27`; the only other caller is `packages/daemon/src/resources/app-log.ts:30`, also at open). A `logs start` stream that stays open therefore grows past `AGENT_DEVICE_APP_LOG_MAX_BYTES` without limit. `website/docs/docs/commands.md:1111` states "`logs start` appends to `app.log` and rotates at 5 MB". `src/platform-runtime-network-host.ts:41-60` (`readRecentAppLogLines`) then does `fs.readFileSync` of the whole file and `split('\n')` to keep at most 20000 lines, on the daemon event loop, on every Android/Apple `network dump` (`packages/platform-android/src/network/runtime.ts:23`, `platform-apple/src/network/runtime.ts:20`). The same slice already has a bounded reader, `readAppLogOutputTail` (`app-log-output.ts:59-84`). Also `app-log-output.ts:37-42` awaits one `stream.write` callback per line, and `platform-runtime-app-log-process.ts:202-222` chains each chunk on one promise with no backpressure, so a fast logcat queues chunks in memory.
- Fix: check the size in the sink (count bytes written, rotate when the cap is crossed, reopen the descriptor). In `readRecentAppLogLines` read backwards in blocks until `maxScanLines` newlines or a byte cap. Write the redacted lines of one chunk with one `stream.write`. Files: `src/platform-runtime-app-log-output.ts`, `src/platform-runtime-network-host.ts`, their tests.
- Effort: M
- Model: opus (file ownership checks via `openVerifiedFileForAppend`, rotation while a child writes)
- Verify: a unit test that writes more than the cap through one sink and asserts `app.log` stays under it and `app.log.1` exists; a test of `readRecentAppLogLines` on a 50 MB file that asserts bytes read.

### SRC2-4: App-log redaction patterns break on a comma and fail silently on an invalid regex
- Category: broken
- Severity: medium     Confidence: high
- Evidence: `src/platform-runtime-app-log-output.ts:95-107` — `AGENT_DEVICE_APP_LOG_REDACT_PATTERNS` is split on every `,`, and each part that does not compile is dropped inside `catch { return []; }`. A pattern with a bounded quantifier such as `token=\w{8,32}` becomes `token=\w{8` (compiles, matches the literal text `{8`) and `32}`; neither redacts the secret. A typo in one pattern removes that pattern with no diagnostic. In both cases the secret is written to `app.log` and the user believes it is redacted. The test (`platform-runtime-app-log-output.test.ts:122-127`) covers only `secret-\d+`.
- Fix: fail `logs start` with `INVALID_ARGS` naming the pattern that does not compile (or at least emit a `warn` diagnostic). Document and implement an escape for commas, or accept a JSON array as an alternative form. Files: `src/platform-runtime-app-log-output.ts`, `website/docs/docs/commands.md`.
- Effort: S
- Model: sonnet
- Verify: new cases in `src/platform-runtime-app-log-output.test.ts` for `x{2,3}` and for `(`.

### SRC2-5: `disconnect` hides a failed lease release and deletes the only local record of the lease
- Category: broken
- Severity: medium     Confidence: high
- Evidence: `src/cli/commands/connection.ts:344-365` — both `client.sessions.close` and `releaseRemoteConnectionLease` sit in `catch {}` blocks; `removeRemoteConnectionState` then runs unconditionally. The text output (`renderDisconnectOutput`, lines 406-415) prints `Disconnected remote session "<s>".` with no mention that the release failed; only `--json` carries `released: false`. A network or auth failure therefore leaves a rented device (cloud, Limrun instance) running until its TTL with no lease id left on disk. The forced-reconnect path in the same family does the opposite: `connection-previous-lease.ts:127-146` returns an "unreleased" notice that names the lease, tenant, run and endpoint ("surface the failure instead of hiding it").
- Fix: when `state.leaseId` is set and the release throws (other than the typed inactive-lease reason from `isInactiveLeaseError`), print the same notice shape as `buildUnreleasedPreviousLeaseNotice` and add `leaseId` plus a `releaseError` field to the JSON. Keep removing the state. File: `src/cli/commands/connection.ts`, `connection-presentation.ts`.
- Effort: S
- Model: sonnet
- Verify: `src/__tests__/remote-connection.test.ts` with a client whose `leases.release` rejects; assert the text output names the lease.

### SRC2-6: `connect limrun` mints a time-based run id, so a second connect of the same session is always "a different connection"; generated profiles are never removed
- Category: inconsistent
- Severity: medium     Confidence: medium
- Evidence: `src/cli/connection/limrun-profile.ts:62` sets `runId: flags.runId ?? \`cli-${Date.now().toString(36)}\``. The profile is hashed into the file name (`generated-config.ts:24-27`), so each run writes a new `remote-connections/generated/limrun-<hash>.json`. `assertCompatibleConnectionOrForce` compares `remoteConfigPath`, `remoteConfigHash` and `runId` (`connection.ts:502-513`), so `agent-device connect limrun --platform ios --session s` run twice fails the second time with "A different remote connection is already active… --force", and `--force` releases the live instance (`cleanupForcedPreviousConnection`). Proxy, cloud and plugin providers derive the run id from the stable client id (`proxy-profile.ts:31`, `cloud-profile.ts:56`, `connect-provider-adapters.ts:174`), so their reconnect is idempotent. Nothing deletes a generated profile: the only reference to the `generated` directory is the writer (`grep remote-connections` over `src` and `packages/*/src`), and `disconnect` removes only the state file.
- Fix: derive the Limrun run id as the others do (`limrun-${buildConnectClientId('limrun', stateDir, session)}`), and remove the generated profile in `disconnect` when no other session record points at it. Files: `src/cli/connection/limrun-profile.ts`, `src/cli/commands/connection.ts`.
- Effort: S
- Model: opus (lease identity; the run id reaches the provider)
- Verify: `src/__tests__/cli-config-limrun.test.ts`: two `connect limrun` calls with the same `--session` succeed and write one generated file.

### SRC2-7: `finalize.complete` declares and forwards an abort signal that the finalizer drops
- Category: broken
- Severity: low     Confidence: high
- Evidence: contract `packages/contracts/src/screen-recording-runtime-host.ts:251-262` has `complete(input, signal?)`. `src/platform-runtime-screen-recording-host.ts:52-56` forwards `signal`. `src/platform-runtime-screen-recording-finalizer-host.ts:24` is `complete: async (input) => await finalizeScreenRecording(host, input)`; the signal is never read, and `waitForStableFile`, `waitForPlayableVideo` and the ffmpeg overlay run to their own deadline. None of the five callers passes a signal (`grep "finalize.complete("` in `packages/*/src`). So `record stop` finalization cannot be cancelled by request abort, and the parameter is dead.
- Fix: either thread the signal into `waitForStableFile` / `waitForPlayableVideo` / `overlayRecordingTouches` and pass the request signal from the callers, or delete the parameter from the contract and the host. Files: the two `src` files above, the contract, capture-kit `recording-video`.
- Effort: S (delete) or M (thread through)
- Model: sonnet (delete) / opus (thread through)
- Verify: `src/platform-runtime-screen-recording-finalizer-host.test.ts` with an aborted signal.

### SRC2-8: Public `agent-device/android-adb` loads all six platform packages for one function; `limrun-runtime-dependencies.ts` "lazy" imports are not lazy
- Category: inefficient
- Severity: low     Confidence: high
- Evidence: `src/sdk/android-adb.ts:29-33` and `src/sdk/limrun-runtime-dependencies.ts:63` do `await import('../platform-runtime.ts')` to call `getAndroidAppStateWithAdb`, a one-line wrapper around `readAndroidAppStateWithExecutor` (`src/platform-runtime.ts:69-74`). `platform-runtime.ts:26-54` statically imports the root entries of platform-apple, -android, -harmonyos, -vega, -linux and -web and builds `androidObservation` at module load. These two are the only callers of the wrapper (grep). In `limrun-runtime-dependencies.ts`, lines 9-14 statically import `@agent-device/platform-android/mechanics` (and line 8 imports `core/interactors/android.ts`, which imports it too), yet nine methods (lines 25, 35, 45, 50, 54, 71, 76, 81, 89, 101) `await import()` the same specifier, and line 100 says error construction is async "so the platform helper remains lazy". The module is already loaded.
- Fix: import `readAndroidAppStateWithExecutor` from `@agent-device/platform-android` in both SDK files and delete the wrapper from `platform-runtime.ts`. In `limrun-runtime-dependencies.ts` use the static import everywhere and drop the false comment (or make all of it lazy, including line 8, if laziness is wanted).
- Effort: S
- Model: sonnet
- Verify: `src/sdk/android-adb.test.ts`, `src/sdk/limrun-runtime-dependencies.test.ts`, `src/__tests__/cli-startup-import-closure.test.ts`; `pnpm check:affected --run`.

### SRC2-9: Each Limrun XCTest launch re-reads and re-hashes the whole `Runner.app`
- Category: inefficient
- Severity: low     Confidence: high
- Evidence: `src/core/interactors/limrun-ios-runner.ts:151-155` — `launch` calls `uploadLimrunRunnerProducts(directory, …, ['Runner.xctestrun'])` to send one small file. `limrun-ios-runner-products.ts:182-206` first walks the full directory and, for every file, does `fs.readFile` of the whole file into memory plus a sha256, because the sync metadata lists all files. The app bundle does not change after `prepareLimrunRunnerProducts`. The same full-buffer hashing is used for the release archive at lines 77-79.
- Fix: compute the file manifest once in `prepareProducts`, keep it beside `directory`, and on relaunch re-hash only `Runner.xctestrun`. Hash with a stream. Files: `limrun-ios-runner.ts`, `limrun-ios-runner-products.ts`.
- Effort: S
- Model: sonnet
- Verify: `src/core/interactors/limrun-ios-runner-products.test.ts` with a read counter; `limrun-ios-runner.test.ts`.

### SRC2-10: Replay-test reporters: one failing `onSuiteEnd` skips the reporters after it; `test --json` prints `success: true` with a non-zero exit
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence: `src/cli/replay-test/reporters/registry.ts:34-42` runs `onSuiteEnd` in sequence with no isolation, while live hooks in the same file (lines 44-67) catch and report each reporter's error. With `--reporter ./custom.js --reporter junit:out.xml`, a throw in the custom reporter means the JUnit file is never written and the suite result is replaced by the reporter error. `src/cli/replay-test/reporting.ts:40-45` prints `{ success: true, data: suite }` and returns the failing exit code (same class as SRC-17, different command). `reporters/custom.ts:51-54` resolves the module path with `process.cwd()` and `os.homedir()`, not the captured host.
- Fix: run every `onSuiteEnd`, collect errors, then throw the first (or report on stderr and set exit code 1). Decide one rule for `success` versus exit code and apply it to `test` and `web doctor`. Pass `host.cwd` into `createCustomReplayTestReporter`.
- Effort: S
- Model: sonnet
- Verify: `src/cli/replay-test/reporters/__tests__/registry.test.ts` with a throwing first reporter and a spy second reporter.

### SRC2-11: Provider capability lookups read `process.env` in 12 call sites while 5 pass the captured host
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence: `src/cli/connection/provider-policy.ts:40,48,57,107` default `env` to `process.env`. Callers that pass the host: `connection.ts:67,444`, `connect-provider-adapters.ts:116,124`, `ended-lease.ts:32`. Callers that do not: `connection.ts:150,388`, `connection-runtime.ts:88,221`, `connection-lease-transaction.ts:119`, `connection-lease-policy.ts:23,47`, `connection-presentation.ts:37,236,249,270,349`. Plugin capabilities come from the plugin store that the env selects, so inside one `connect` the provider can be resolved against two different environments when the CLI runs with a captured host (MCP executor, tests, SDK).
- Fix: remove the defaults so the compiler lists every caller; thread `host.env` (the policy factories can take it once). Files: the six listed.
- Effort: S
- Model: sonnet
- Verify: `tsc` after removing the defaults; `src/cli/connection/provider-policy.test.ts`.

### SRC2-12: Host-process termination paths with no escalation or no cancel
- Category: broken
- Severity: low     Confidence: medium
- Evidence: `src/platform-runtime-audio-probe-host.ts:53-56` — `terminate` sends one `SIGTERM` and awaits `probe.wait` with no timeout; a helper that ignores `SIGTERM` (or holds its pipes open) hangs the stop forever. Every sibling escalates: `platform-runtime-app-log-process.ts:245-264` (SIGINT, 2 s, SIGKILL, then destroy pipes) and `terminateManagedProcessSet` (SIGINT/SIGTERM/SIGKILL). The start result also omits `marker` when identity resolution fails (line 51), so that capture has no durable owner record. `src/platform-runtime-device-shutdown-host.ts:69` builds `new AbortController().signal` for the close-triggered shutdown, a signal nothing can abort, while the `apple`/`android` members take the caller's signal.
- Fix: reuse `terminateManagedProcessSet([marker], probe)` (or the app-log termination helper) in the audio probe; fail the start when no marker can be read, as `startApplePerfCapture` does. Give `DeviceShutdownCloseCapability.shutdownTarget` a signal parameter.
- Effort: S
- Model: opus (process lifecycle, device-facing)
- Verify: `src/platform-runtime-audio-probe-host.test.ts` with a child that traps SIGTERM.

### SRC2-13: Latent busy loop in `cachedProducts` after an abort that loses the race with a successful upload
- Category: broken
- Severity: low     Confidence: low
- Evidence: `src/core/interactors/limrun-ios-runner.ts:96-135`. Line 130 aborts `preparationController` when the last waiter is cancelled and `prepared` is still false. If `prepareProducts` then still resolves (the abort lands after the last `await` that observes the signal, for example during `await compression` at `limrun-ios-runner-products.ts:272-275`), `products` stays set, `prepared` becomes true and the controller stays aborted. Every later call takes the branch at line 101 (`products && preparationController?.signal.aborted`), awaits an already resolved promise and recurses, forever, in microtasks: the daemon loop never yields. I could not produce the interleaving; the window is a few microtasks wide.
- Fix: change line 101 to `if (products && !prepared && preparationController?.signal.aborted)`. File: `limrun-ios-runner.ts`.
- Effort: S
- Model: sonnet
- Verify: unit test in `limrun-ios-runner.test.ts` that resolves the preparation after the controller was aborted, then calls `prepareCache` again and expects it to return.

### SRC2-14: Small dead or duplicated wiring
- Category: unneeded
- Severity: low     Confidence: high (each item checked by grep)
- Evidence:
  - `src/platform-runtime/request-providers.ts:119-121,322-326` computes `hasConfiguredResolvers` through `hasPlatformProviderResolvers`; the only consumer of the composed object, `src/platform-runtime.ts:195-201`, computes its own value (line 196) and calls only `.run`. The inner field and helper are never read.
  - `src/platform-runtime-perf-host.ts:15-21`: `loadAndroidPerf`, `loadAndroidFramePerf`, `loadAndroidNativePerf` are three aliases of `loadAndroidMechanics`; `loadApplePerf`, `loadApplePerfMechanics`, `loadAppleXctrace` are three identical importers of `@agent-device/platform-apple/perf`. `platform-runtime-perf-capture-host.ts:36-37` repeats two of them.
  - `src/platform-runtime-android-observation-host.ts:24-27` wraps `loadAndroidMechanics` in a dynamic import of a 15-line module that 12 sibling files import statically.
  - `src/platform-runtime-resource-cleanup.ts:38,41` imports `@agent-device/platform-web` twice in one function.
  - Three copies of the Limrun platform/backend table: `packages/kernel/src/contracts.ts:69-73`, `src/provider-limrun-credentials.ts:34-37`, `src/cli/connection/limrun-profile.ts:88`. The kernel comment at lines 75-79 already says the `connect limrun` copy "is tracked for follow-up".
  - `src/core/interactors/limrun-ios-files.ts:155-171`: the `readInfoPlist` cache lives in `createLimrunSimulatorFiles`, which is rebuilt for every tool-provider scope (`limrun-ios-runner.ts:42-45` creates a provider per wrapped method call), so it caches almost nothing and can return a stale `null` inside one install-then-read scope. The same file reports HTTP status as `details.status` (line 79) while `limrun-download-file.ts:46` uses `details.statusCode`; the 404 checks at lines 104 and 199 depend on that difference.
  - `connect` parses the same remote config file four times in one run: `connect-provider-adapters.ts:110` (or `generated-config.ts:45`), `connection.ts:315`, `connection-context.ts:31` (hash), `connection.ts:587`.
- Fix: delete the unused field and helper, collapse the loader aliases, import the loader statically, keep one platform/backend table exported from kernel, move the plist cache to the runner (or drop it), use one status key, pass the resolved profile along in `connect`.
- Effort: S
- Model: sonnet
- Verify: `pnpm check:fallow`; `pnpm check:affected --run`.
