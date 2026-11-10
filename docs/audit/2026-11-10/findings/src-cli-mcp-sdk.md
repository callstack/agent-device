# Audit: SRC slice (root `src/`, `bin/`, package `exports`)

## Coverage

Slice: 495 files, ~85k lines (about 35k non-test, 50k test/fixture).

- Read fully (about 35% of non-test lines): `bin/agent-device.mjs`, `src/bin.ts`, `src/cli.ts`, `src/cli/entry.ts`, `process-entry.ts`, `process-exit.ts`, `resolve-cli-options.ts`, `session-binding.ts`, `failure-output.ts`, `update-check*.ts`, `auth-session.ts`, `browser-launch.ts`, `cloud-response.ts`, `src/cli/parser/args.ts`, `src/cli/commands/{router,router-types,generic,shared,client-backed,daemon,device,screenshot,recording,replay,plugins,auth,web,agent-cdp,react-devtools}.ts`, all of `src/mcp/*.ts` except `tool-ref-pins.ts`, `src/ai-sdk/index.ts`, every non-test file in `src/sdk/`, `src/client/client-types.ts`, `src/host.ts`, `src/daemon.ts`, `src/daemon-composition.ts`, `src/io.ts`, `src/finders.ts`, `src/builtin-provider-{ids,plugins}.ts`, `src/commands/{cli-runner,command-progress,provider-plugin-catalog,post-action-observation-client-options}.ts`, `src/commands/interaction/fill-text-stdin.ts`, `src/commands/schema/usage.ts`, `src/core/{interactors,platform-plugin-registry}.ts`.
- Skimmed (about 10%): `src/cli/commands/connection.ts` (first 160 lines), `src/provider-device-runtime.ts`, `src/platform-runtime-{runtime-hints,app-log-process,resource-cleanup,daemon-lifecycle}.ts`, `src/cli/replay-test/trace.ts`, `src/cli/parser/command-suggestions.ts`.
- Not reached: about 45 `src/platform-runtime-*-host.ts` files and the gateway, `src/core/interactors/limrun-*`, `src/cli/connection/*`, `connection-lease-transaction.ts`, `proxy*.ts`, `takeover.ts`, the replay-test reporters, `cli-help*.ts` text, `command-explain.ts`, `tool-ref-pins.ts`, and nearly all test bodies (tests were only scanned for placement, assertion-free files and skips; none were assertion-free).
- `package.json` `exports` vs `scripts/build-entries.ts` vs `src/sdk/`: all 15 subpaths map to an existing build entry and source file; no missing or extra entry. Drift found only in the tsdown chunk groups (SRC-9) and the docs (SRC-21).
- Runtime checks used the existing `dist/` build with `--daemon-base-url http://127.0.0.1:1` so no daemon was spawned. Side effect: a few diagnostics `.ndjson` files under `~/.agent-device/logs/default/2026-11-10/`, plus scratch scripts `src-loadtrace.mjs`, `src-aisdk-probe.mjs`, `src-unused.mjs` and an `sd/` dir beside this report.
- CLI startup cost is healthy and is not a finding: `--version` 75-95 ms (6 files), `help` about 115 ms, parse-error path about 170 ms, a normal command loads about 98 files / 670 KB minified (node baseline 40 ms). The lazy module table in `entry.ts` and `router.ts` works.

## Findings

### SRC-1: MCP stdin decoder stalls or drops requests after a blank or malformed line
- Category: broken
- Severity: high     Confidence: high
- Evidence: `src/mcp/server.ts:135-153` — `tryReadLineMessage` returns `undefined` for an empty line (line 152), which `push` treats as "no more lines" and breaks; and a `JSON.parse` throw in `emit` (line 158) escapes the loop with complete lines still buffered. Reproduced on `dist`: `printf '\n{"jsonrpc":"2.0","id":1,"method":"ping"}\n'` is answered only when the next chunk arrives 2 s later; `printf 'bad\n{"id":5,"method":"ping",...}\n'` followed by EOF never answers id 5 (only the -32700 is written).
- Fix: in `push`, loop while a newline exists; skip empty lines with `continue`; wrap each `emit` in its own try/catch that writes -32700 and continues. On `end`, flush a non-empty trailing buffer. Files: `src/mcp/server.ts`, `src/mcp/__tests__/server-validation.test.ts`.
- Effort: S
- Model: sonnet
- Verify: new vitest cases feeding `"\n{...}\n"` and `"bad\n{...}\n"` as one chunk and asserting both responses before the next chunk; `printf 'bad\n{"jsonrpc":"2.0","id":5,"method":"ping"}\n' | node bin/agent-device.mjs mcp` prints two lines.

### SRC-2: MCP server handles every request strictly serially, so `ping` and cancellation wait behind a running tool call
- Category: broken
- Severity: medium     Confidence: high (code path); medium (client impact)
- Evidence: `src/mcp/server.ts:50-58` chains every payload on one `pending` promise; `src/mcp/router.ts:97-98` keeps `ping` "the keepalive legacy clients rely on". A `tools/call` for `test`, `wait`, `record` or `replay` ("Streams progress; no fixed client timeout", `command-tools.ts:498`) blocks the answer to any `ping` and `tools/list` until it ends. No file in `src/mcp/` references `cancel` or `AbortSignal` (grep), so `notifications/cancelled` is dropped and a tool call cannot be aborted.
- Fix: answer `ping`, `server/discover`, `initialize` and `tools/list` outside the queue; keep only `tools/call` serialized (per session if possible). Track in-flight calls by request id and abort on `notifications/cancelled` through the client's request signal. Files: `src/mcp/server.ts`, `src/mcp/router.ts`, `src/mcp/command-tools.ts`.
- Effort: M
- Model: opus
- Verify: vitest with a `handlePayload` stub whose `tools/call` never resolves; assert a later `ping` is written.

### SRC-3: Session lock policy exists only in the CLI; MCP and the AI SDK ignore `AGENT_DEVICE_SESSION_LOCK` / `sessionLock`
- Category: inconsistent
- Severity: medium     Confidence: high
- Evidence: the only producers of `lockPolicy` are `src/cli.ts:535-536` and `src/cli/session-binding.ts` (grep `lockPolicy` over `src/` and `packages/*/src`). `src/mcp/command-tools.ts:267-291` (`readClientConfig`) builds the client config from `stateDir`, `includeCost`, `responseLevel` only; `packages/command-registry/src/flag-groups.ts:60-63` states `sessionLock` "never become[s] structured command input". The daemon returns early when `meta.lockPolicy` is absent (`packages/daemon/src/server/request-lock-policy.ts:49-52`). `website/docs/docs/sessions.md:63-70` documents the lock (and "Setting `AGENT_DEVICE_SESSION` turns on the lock in `reject` mode") with no CLI-only caveat.
- Fix: move `resolveBindingSettings` to a shared owner (command-surface or client) and call it from the MCP executor with the captured host env and config defaults; or document the lock as CLI-only. Files: `src/cli/session-binding.ts`, `src/mcp/command-tools.ts`, `website/docs/docs/sessions.md`.
- Effort: M
- Model: opus
- Verify: executor test with `AGENT_DEVICE_SESSION=s AGENT_DEVICE_SESSION_LOCK=strip` in the host and an injected `createClient` asserting `config.lockPolicy === 'strip'`.

### SRC-4: `AGENT_DEVICE_PLATFORM` is validated against a stale 3-value list, breaking every command that has no `--platform` flag
- Category: broken
- Severity: medium     Confidence: high
- Evidence: `src/cli/session-binding.ts:76-87` accepts only `ios|android|apple`; the real enum is `PLATFORM_SELECTORS` (`apple, android, harmonyos, vega, linux, web, ios, macos`, `packages/kernel/src/device.ts:43`). The check runs when the command dropped the env-backed `platform` default. Reproduced: `AGENT_DEVICE_PLATFORM=web agent-device auth status` fails with `Invalid AGENT_DEVICE_PLATFORM: web. Use ios, android, or apple.`, while `AGENT_DEVICE_PLATFORM=web agent-device devices` is accepted. A user who exports the variable for a web, macOS or Linux project cannot run `auth`, `plugins` and similar commands.
- Fix: delete `readConfiguredPlatform`; the flag registry already validates the env value for commands that read it. If a default is still needed, check against `PLATFORM_SELECTORS`. Files: `src/cli/session-binding.ts` and its test.
- Effort: S
- Model: sonnet
- Verify: `AGENT_DEVICE_PLATFORM=web node bin/agent-device.mjs auth status` prints `Not authenticated.`.

### SRC-5: A failing `test` run exits through bare `process.exit`, the truncation bug #1596 fixed everywhere else
- Category: broken
- Severity: medium     Confidence: medium
- Evidence: `src/cli/commands/generic.ts:56-62` calls `process.exit(exitCode)` right after `renderReplayTestResponse` writes the suite summary. `src/cli/process-exit.ts:5-14` and `src/cli.ts:666-670` document that this drops queued stdout/stderr when the CLI is piped. The only non-zero producer is `test`, whose final failure summary is what a piped agent reads.
- Fix: return the exit code from `runGenericClientBackedCommand` up to `runCli` (or call `exitAfterFlush(exitCode)`). Files: `src/cli/commands/generic.ts`, `src/cli/commands/router-types.ts`, `src/cli.ts`.
- Effort: S
- Model: sonnet
- Verify: extend `test/integration/daemon-replace-exit-flush.test.ts` (or `src/__tests__/cli-exit-paths.test.ts`) with a failing suite piped through a slow reader; assert the last summary line arrives.

### SRC-6: Every CLI command against a cloud daemon makes an extra token-refresh HTTP round trip
- Category: inefficient
- Severity: medium     Confidence: high
- Evidence: `src/cli.ts:446-454` calls `resolveRemoteAuthForCli` for every command except six. With a stored CLI session and no token, `src/cli/auth-session.ts:347-367` always calls `refreshAgentToken` (POST `/api/control-plane/cli-session/refresh`, 15 s timeout, lines 369-387). The returned `expiresAt` (line 389) is never read and the access token is never cached, so each `press`/`snapshot` in an agent loop pays one more sequential network call.
- Fix: cache `{accessToken, expiresAt}` beside `auth/cli-session.json` (mode 0600) and reuse it until shortly before expiry; refresh on 401. Files: `src/cli/auth-session.ts`, `src/cli/__tests__` auth tests.
- Effort: M
- Model: opus (credential storage)
- Verify: unit test with injected `io.fetch` and `io.now`: two consecutive `resolveRemoteAuth` calls make one refresh request.

### SRC-7: `agent-device mcp <anything>` silently ignores its arguments; flags before `mcp` are rejected
- Category: inconsistent
- Severity: medium     Confidence: high
- Evidence: `src/cli/entry.ts:73-75` routes to the server whenever `argv[0] === 'mcp'` and no help flag is present. Reproduced: `agent-device mcp --state-dir ./sd --bogus-flag x` starts the server with exit 0 and no warning, while `agent-device --state-dir ./sd mcp` fails with `Flag --state-dir is not supported for command mcp`. `stateDir` is an operator-only key in MCP (`src/mcp/tool-control-fields.ts:24-30`), so an operator who puts it in `args` believes the server is pinned when it is not.
- Fix: take the MCP fast path only for `argv.length === 1`; send everything else through the parser so it fails with the existing INVALID_ARGS text. Files: `src/cli/entry.ts`, its test.
- Effort: S
- Model: sonnet
- Verify: `node bin/agent-device.mjs mcp --state-dir x </dev/null` exits non-zero with INVALID_ARGS.

### SRC-8: `plugins` resolves the state dir without the host, so a relative `--state-dir` fails only for this command
- Category: broken
- Severity: low     Confidence: high
- Evidence: `src/cli/commands/plugins.ts:34` calls `resolveDaemonPaths(flags.stateDir)` with no `{cwd, env}`; every other caller passes them (`daemon.ts:29`, `auth.ts:9`, `cli.ts:380`). Reproduced: `agent-device plugins list --state-dir ./sd` fails with `State dir "./sd" is relative and no working directory was given`; `agent-device daemon status --state-dir ./sd` works. The same file reads `process.env` (lines 29, 33) although `host` is in its params.
- Fix: destructure `host` and pass `{ cwd: host.cwd, env: host.env }`; pass `host.env` to `changePlugin`/`listPlugins`. File: `src/cli/commands/plugins.ts`.
- Effort: S
- Model: sonnet
- Verify: `node bin/agent-device.mjs plugins list --state-dir ./sd` succeeds; add a case to `src/cli/commands/__tests__/plugins.test.ts`.

### SRC-9: Two tsdown public-SDK chunk groups match no file since the package split
- Category: unneeded
- Severity: low     Confidence: high
- Evidence: `tsdown.config.ts:48-57` — `sdk-android-adb` tests `src/platforms/android/adb-executor.ts` and `sdk-app-inventory` tests `src/contracts/app-inventory.ts`. Neither path exists; the files are `packages/platform-android/src/adb-executor.ts` and `packages/contracts/src/app-inventory.ts`. `dist/src` contains `adb-executor.js` and `app-inventory.js` and no `sdk-android-adb*` / `sdk-app-inventory*`, so the stable chunk names these groups were meant to pin are not produced. No test references the names (grep).
- Fix: either repoint the regexes at the package paths (if stable chunk names for published `.d.ts` still matter) or delete both groups. File: `tsdown.config.ts`.
- Effort: S
- Model: sonnet
- Verify: `pnpm build && ls dist/src | grep -E 'sdk-(android-adb|app-inventory)'` matches the decision.

### SRC-10: Cloud endpoints map every non-2xx status to `UNAUTHORIZED`
- Category: broken
- Severity: low     Confidence: high
- Evidence: `src/cli/cloud-response.ts:24-29` throws `AppError('UNAUTHORIZED', …)` for any `!response.ok`, including 404, 429 and 5xx. Callers (`auth-session.ts:461`) then tell the user or agent to log in again for a server outage; the typed code is what agents branch on.
- Fix: use `UNAUTHORIZED` for 401/403 only; `COMMAND_FAILED` with `details.status` (and `retriable` for 429/5xx) otherwise. Files: `src/cli/cloud-response.ts`, auth tests.
- Effort: S
- Model: sonnet
- Verify: unit test with a 503 `Response` asserting `code !== 'UNAUTHORIZED'`.

### SRC-11: `replay export` on a missing file reports `UNKNOWN: Unexpected internal error`
- Category: broken
- Severity: low     Confidence: high
- Evidence: `src/cli/commands/replay.ts:42` calls `fs.readFileSync(sourcePath)` with no handling. Reproduced: `agent-device replay export nope.ad` prints `Error (UNKNOWN): ENOENT … Next: Unexpected internal error. Read the diagnostics log, and report it`. The same class of read in `src/cli.ts:719-727` (`--steps-file`) is wrapped as `INVALID_ARGS`, and help (`src/commands/schema/cli-help.ts:155`) promises "a missing script fails immediately, naming the path you typed".
- Fix: wrap the read and throw `INVALID_ARGS` naming the typed path. File: `src/cli/commands/replay.ts`.
- Effort: S
- Model: sonnet
- Verify: `node bin/agent-device.mjs replay export nope.ad --json` returns `error.code === "INVALID_ARGS"`.

### SRC-12: `isDaemonStartupFailure` keeps an error-text fallback next to the typed reason
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence: `src/cli.ts:732-737` first checks `details.kind === 'daemon_startup_failed'`, then falls back to `error.message.toLowerCase().includes('failed to start daemon')`. The only producer of that message (`packages/daemon-client/src/daemon-client-startup.ts:297-298`) always sets the kind. This violates the AGENTS rule "Use typed reasons and details for behavior. Do not match error text."
- Fix: delete lines 735-736. File: `src/cli.ts`.
- Effort: S
- Model: sonnet
- Verify: `src/__tests__/cli-close.test.ts` passes.

### SRC-13: Retired-command handling is split; `runtime` is a hard-coded stub in the dispatcher
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence: `packages/command-registry/src/cli-command-aliases.ts:30-41` owns `RETIRED_CLI_COMMANDS` (`rotate`, the perf alias), consulted by the parser (`src/cli/parser/args.ts:475-479`). `runtime` is instead a special branch in `src/cli.ts:605-609`, reached only after binding, connection defaults, remote auth and possibly materialization have run. Observed: `agent-device runtime show` prints "runtime command was removed…", but `agent-device help runtime` prints "Unknown command: runtime".
- Fix: add `runtime` to `RETIRED_CLI_COMMANDS` with the same message, delete the `cli.ts` branch and the `'runtime'` entry at `packages/command-registry/src/batch-policy.ts:39` if it only keeps the stub reachable. Files: `src/cli.ts`, `cli-command-aliases.ts`.
- Effort: S
- Model: sonnet
- Verify: `node bin/agent-device.mjs runtime show` fails at parse with the retired message and no remote auth attempt.

### SRC-14: Argument parser leftovers: silent `-c`, int flags that accept non-integers, a dead branch
- Category: broken
- Severity: low     Confidence: high
- Evidence: `src/cli/parser/args.ts`: (a) lines 91-93 and 135-137 silently swallow `-c` on `snapshot`/`diff` ("legacy ignored"); no help or doc mentions `-c` (grep), so it is an unrequested compat path. (b) Lines 315-328: `int` flags go through `Number()` then `Math.floor`, so `--depth 1.9`, `--timeout 0x10` and `1e3` are accepted and silently changed (reproduced: `snapshot --depth 1.9 --timeout 0x10` parses). (c) Line 101 `if (!command) command = arg;` is unreachable because `shouldTreatUnknownDashTokenAsPositional` returns false when `command` is null (line 363). (d) `parseRawArgs` never pushes to `warnings` (line 59), so the field is always empty at that layer.
- Fix: remove the `-c` exemption; reject non-integer text for `int` with `/^-?\d+$/`; delete the dead branch and the raw `warnings` field. File: `src/cli/parser/args.ts` and its tests.
- Effort: S
- Model: sonnet
- Verify: `src/cli/parser/__tests__/args-validation.test.ts` with new cases; `pnpm fuzz:parsers`.

### SRC-15: `auth status` reports an expired session as authenticated
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence: `src/cli/auth-session.ts:331-344` returns `authenticated: true` plus `expired: true`; `src/cli/commands/auth.ts:49-60` prints "Authenticated with cloud CLI session." then `status=expired`. `resolveCliSessionAccess` (`auth-session.ts:354`) treats the same record as no session. A `--json` caller that reads `authenticated` gets the wrong answer.
- Fix: set `authenticated: !expired` (keep `expired` and the session fields) and change the headline. Files: `src/cli/auth-session.ts`, `src/cli/commands/auth.ts`.
- Effort: S
- Model: sonnet
- Verify: unit test with `now` past `expiresAt`.

### SRC-16: AI SDK `platform` pin on the returned client does nothing
- Category: broken
- Severity: low     Confidence: medium
- Evidence: `src/ai-sdk/index.ts:92-95` builds the returned `client` with `lockPlatform: platform` and no `lockPolicy`. The daemon ignores `lockPlatform` unless `lockPolicy` is set (`packages/daemon/src/server/request-lock-policy.ts:49-52`). The doc comment (lines 27-31) says every tool call is pinned; that holds for tools only because `execute` injects `platform` into the input (line 122). `client.apps.open(...)` through the returned client is not pinned.
- Fix: drop `lockPlatform` (and say the client is unpinned) or also pass `lockPolicy: 'reject'`. File: `src/ai-sdk/index.ts`, `website/docs/docs/ai-sdk.md`.
- Effort: S
- Model: sonnet
- Verify: `src/ai-sdk/__tests__/index.test.ts` asserting the request meta the client sends.

### SRC-17: `web doctor --json` prints `success: true` and exits non-zero
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence: `src/cli/commands/web.ts:27-37` and `58-64`: `printWebResult` always writes `{success: true, data}` and the command returns `result.exitCode`, which `src/cli.ts:188-194` passes to `exitAfterFlush`. Every other command pairs a non-zero exit with `success: false`.
- Fix: emit `success: false` with a normalized error (doctor data in `details`) when `exitCode !== 0`, or exit 0 and carry health in `data`. File: `src/cli/commands/web.ts`.
- Effort: S
- Model: sonnet
- Verify: `src/__tests__/cli-web.test.ts` with a failing doctor stub.

### SRC-18: `--debug` tails the daemon log into stdout
- Category: inconsistent
- Severity: low     Confidence: medium
- Evidence: `src/cli.ts:930-963` (`startDaemonLogTail`) writes the tail with `process.stdout.write` (line 947). Every other diagnostic uses stderr (progress `command-progress.ts:17`, warnings `cli.ts:283`, failure tail `failure-output.ts:48`). `snapshot --debug > out.txt` therefore interleaves daemon log lines with the command's parseable output. The tail also polls with `existsSync` + `statSync` + open/read every 200 ms.
- Fix: write the tail to stderr; use `fs.watchFile` or one persistent descriptor. File: `src/cli.ts`.
- Effort: S
- Model: sonnet
- Verify: `src/__tests__/cli-diagnostics.test.ts` asserting stdout holds only command output under `--debug`.

### SRC-19: Two "legacy" recoveries run on every daemon start with no removal condition
- Category: unneeded
- Severity: low     Confidence: low (needs owner decision on the support window)
- Evidence: `src/platform-runtime-daemon-lifecycle.ts:20-34` wires `restoreLegacyXctestDeviceSetRedirectRuntime` (`src/platform-runtime-resource-cleanup.ts:21-28`, "an older agent-device could have redirected") into `configureForDaemonLock`, and `recoverLegacyAppLogMarkersAfterDaemonLock` (`src/platform-runtime-app-log-process.ts:79-112`), which does a sync `readdirSync` plus two `existsSync` per session directory on each start and derives a device identity by regex over a recorded command string (lines 114-135). AGENTS: "During a migration, remove superseded paths."
- Fix: decide the last version that wrote marker-only sessions / redirected `XCTestDevices`; if out of support, delete both paths, the `PlatformOwnerLifecycle` members, and the re-export at `src/platform-runtime-operation-host.ts:147`. Otherwise record the removal version beside each.
- Effort: M
- Model: opus (daemon lifecycle, device-facing)
- Verify: `pnpm check:affected --run`; daemon start on macOS with the old-layout fixture.

### SRC-20: Android runtime hints always read and write a speculative `ReactNativeDevPrefs.xml`
- Category: inefficient
- Severity: low     Confidence: medium
- Evidence: `src/platform-runtime-runtime-hints.ts:13-18,77-79` — the comment says React Native reads `<package>_preferences.xml` and the second file is "kept in case some RN fork/version reads it". `applyAndroidRuntimeHints` and `clearAndroidRuntimeHints` (lines 81-111) therefore run one extra `adb run-as` read on each `open`/`close` with hints and write a file into the app sandbox that no known reader uses. AGENTS: "Add compatibility or fallback behavior only on explicit request or approval."
- Fix: drop `ANDROID_LEGACY_DEV_PREFS_PATH` from `androidDevPrefsPaths` (keep removing it in `clear` for one release if desired). Files: `src/platform-runtime-runtime-hints.ts`, `src/__tests__/platform-runtime-runtime-hints.test.ts`.
- Effort: S
- Model: opus (device-facing; needs a device run per `docs/agents/device-verification.md`)
- Verify: the hints unit test, plus `open` of a debug RN app on an emulator with `--metro-host`.

### SRC-21: Public exports missing from the API reference
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence: exported but named nowhere under `website/docs` or `README.md` (grep count 0): `ShellWord` (`src/sdk/android-adb.ts:20`, the element type of the documented `runAdbShell(executor, words)`), `LimrunInstanceAccess` (`src/sdk/limrun.ts:4`), `AgentArtifactsResult` and `CloudProviderSessionResult` (`src/sdk/index.ts:29-32`), and from `src/sdk/plugins.ts:9-27` `AgentDevicePlugin`, `PluginSetupResult`, `PluginWebDriverSetup`, `PluginConnection`, `PluginConnectionContext`, `PluginConnectionResolution`, `PluginCredentials`, `PluginPlatformModule`, `PluginProviderRuntime`, `PluginRuntimeSetup` (`plugins.md` names only `AgentDevicePluginFactory`, `ProviderPluginHost`, `WebDriverPluginOptions`). Also `examples/sdk/tsconfig.json:8-19` maps 12 of the 15 subpaths (no `limrun`, `plugins`, `plugins/webdriver`), and `.fallowrc.json:17-29` lists 12 of the 14 SDK entry files (no `src/sdk/batch.ts`, `src/sdk/limrun.ts`).
- Fix: add the names to `website/docs/docs/build-an-integration.md` / `plugins.md` / `client-api.md`, or stop exporting the ones not meant to be public; complete the two config lists.
- Effort: S
- Model: sonnet
- Verify: a small repo-guard test that diffs each entry's export names against the API-reference bullets.

### SRC-22: Root `src/__tests__` holds about 21 test files (about 4.4k lines) that import nothing from root `src/`
- Category: unneeded
- Severity: low     Confidence: medium
- Evidence: files with no `../` import, e.g. `src/__tests__/android-ui-hierarchy.test.ts` (926 lines; only `@agent-device/platform-android`, `selectors`, `capture-kit`), `selectors-build.test.ts` (274; `@agent-device/selectors`), `daemon-error.test.ts` (83; `@agent-device/kernel/errors` only), `android-ui-hierarchy-scope.test.ts`, `snapshot-desktop-surface.test.ts`, `kernel/snapshot-ref-grammar.test.ts`, `contracts/apple-os-resolution.test.ts`. They are leftovers from the move of the code into packages; living in the root makes affected-test selection and ownership point at the wrong place. Cross-package parity tests (`command-descriptor-*.test.ts`, `is-argument-surface-parity.test.ts`) are legitimately root-level and are not part of this finding. The root also has the same module tested from two locations: `src/platform-runtime-android-application-tools.test.ts` and `src/__tests__/platform-runtime-android-application-tools.test.ts` (same for `…apple-application-tools` and `provider-device-runtimes`).
- Fix: move single-package tests beside their package source; merge the split pairs into one file each. Follow `docs/agents/test-audit.md`.
- Effort: M
- Model: sonnet
- Verify: `pnpm check:affected --run` after the move; test count unchanged.

### SRC-23: Test-only mutable global in `provider-device-runtime.ts`; tests exercise the fallback, not the production scope
- Category: unneeded
- Severity: low     Confidence: medium
- Evidence: `src/provider-device-runtime.ts:53-61,84-86` — `activeProviderDeviceRuntimes` is written only by `setActiveProviderDeviceRuntimes` ("@internal Test isolation hook"), called only from three test files (grep). Production always goes through the `AsyncLocalStorage` scope (line 108), so in production the fallback is always `[]`. The tests in `src/core/__tests__/interactors.test.ts`, `src/daemon-composition.test.ts` and `src/__tests__/provider-device-runtime.test.ts` pass through the global, a path production never takes.
- Fix: have the tests run inside `createProviderDeviceRuntimeRequestProviders(runtimes).providerDeviceRuntimeScope(...)`; delete the global and the setter.
- Effort: S
- Model: sonnet
- Verify: the three test files pass with the setter removed.

### SRC-24: Small wiring and compat leftovers
- Category: unneeded
- Severity: low     Confidence: high (each item verified by grep)
- Evidence:
  - `bin/agent-device.mjs:9` falls back to `dist/src/bin.js`; `scripts/build-entries.ts` emits only `internal/bin`, so the candidate never exists. Same shape in `src/cli/update-check.ts:143-146` (two candidate paths; the built layout only ever has `internal/`, the source layout only the sibling).
  - `src/io.ts` (1 line) and `src/finders.ts` exist only to be re-exported by `src/sdk/io.ts` / `src/sdk/finders.ts`; their one other role is matching the tsdown regexes `src/io.ts` / `src/finders.ts`. `src/sdk/index.ts:12` imports `createLocalArtifactAdapter` through `../io.ts` too.
  - `src/cli/commands/client-backed.ts` is an alias file (`ClientBackedCliCommandName = CommandName`, `isClientBackedCliCommandName = isCommandName`) with one consumer (`router.ts`).
  - `src/daemon-composition.ts:84-88` `createDaemonRuntimeDeps` only forwards to `composeDaemonRuntimeDeps`.
  - `src/cli/commands/remote-bridge.ts` is a 5-line single-function file with one consumer (`agent-cdp.ts`).
  - `src/client/client-types.ts:37` re-exports `JsonObject` although line 20's `export type *` from the same module already covers it.
  - `src/cli.ts:578` `.map((step, _index) =>` unused parameter; `src/cli.ts:151,165` parse argv twice (`isDebugRequested` then `resolveCliOptions`).
  - `src/mcp/router.ts:128-133` `textToolResult` duplicates `src/mcp/server-guide.ts:75-77` `textResult`.
  - Three different CI detections: `auth-session.ts:187` (`CI === 'true'` or GitHub/Buildkite), `update-check.ts:94` (any non-blank `CI`), `replay-test/reporters/default.ts:106` (any truthy `process.env.CI`); the last two read `process.env` instead of the captured host.
- Fix: delete the dead candidates and alias files, inline the single-consumer helpers, share one `isCi(env)` helper from host-kit.
- Effort: S
- Model: sonnet
- Verify: `pnpm build && node bin/agent-device.mjs --version`; `pnpm check:fallow`; `pnpm check:affected --run`.
