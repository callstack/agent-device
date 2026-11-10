# PROV slice audit: providers, plugins, secondary platforms

## Coverage

Slice is ~60k lines (about 27k production, 33k tests). Roughly 35% of production source was read line by line; tests were only spot-checked where a finding depended on them (~3%).

Read fully:
- `packages/tv-cdp/src`: `runtime.ts`, `cdp.ts`, `page-interactor.ts`, `replies.ts`, `tv.ts`, `page-log.ts`, `connection.ts`, `bundle.ts`, `app-log-descriptor.ts`, `index.ts`
- `packages/provider-webos/src`: all production files
- `packages/provider-revyl/src`: `revyl-client.ts`, `revyl-session.ts`
- `packages/provider-webdriver/src`: `webdriver-transport.ts`, `webdriver-utils.ts`, `webdriver-client.ts`, `runtime-session.ts`, `runtime-deployment.ts`, `aws-device-farm.ts`, `aws-device-farm-provider.ts`, `aws-device-farm-artifacts.ts`, `browserstack.ts`, `browserstack-provider.ts`, `browserstack-connection.ts`, `providers.ts`, `request-headers.ts`, `dependencies.ts`
- `packages/provider-testmu/src`: `index.ts`, `connection.ts`, `providers.ts`, `plugin.ts`, `testmu.ts`, `testmu-webdriver.ts`, `package.json`
- `packages/plugins/src`: `registry.ts`, `store.ts`, `store-legacy.ts`, `legacy.ts`, `credential-fingerprint.ts`, `connection.ts`, `load.ts`, `host.ts`, `inventory.ts`
- `packages/platform-vega/src`: `tool-provider.ts`, `inventory.ts`, `interactor.ts`, `input-actions.ts`, `app-lifecycle.ts`, `vega-executable.ts`
- `packages/platform-linux/src`: `tool-provider.ts`, `interactor.ts`, `atspi-bridge.ts`, `screenshot.ts`, `app-lifecycle.ts`, `clipboard.ts`, `display.ts`, `linux-env.ts`
- `packages/platform-harmonyos/src`: `hdc.ts`, `interactor.ts`, `input-actions.ts`, `settings.ts`, `screenshot.ts`
- `packages/platform-web/src`: `agent-browser-tool.ts`, `agent-browser-lifecycle.ts`, `agent-browser-install.ts`, `agent-browser-install-paths.ts`, `agent-browser-network.ts`

Read partially:
- `provider-limrun/src/runtime.ts` (lines 160-720), `device-session.ts` (all), `android.ts` (60-240)
- `platform-web/src/agent-browser-provider.ts` (440-730)
- `platform-linux/src/input-actions.ts` (1-210), `linux/atspi-dump.py` (95-330)
- `platform-harmonyos/src/app-lifecycle.ts`, `snapshot.ts`, `runtime.ts` (fragments)
- `plugins/src/discovery.ts`, `manifest.ts` (about half each)

Not reached:
- Limrun: `lease-release.ts`, `ios.ts`, `app-log-*`, `network-har.ts`, `capture-lifecycle.ts`, `facts-runtime.ts`, `session-allocation.ts`, `lease-ownership.ts`, `connection-verification.ts`
- Revyl: `interactor.ts`, `runtime.ts`, `facts-runtime.ts`, `connection.ts`, `snapshot.ts`
- WebDriver: `webdriver-interactor.ts`, `platform-runtime.ts`, `webdriver-source.ts`, `capabilities.ts`, both `*-connection-verification.ts`, `*-device-features.ts`
- platform-web: `agent-browser-snapshot.ts`, `agent-browser-audio-probe.ts`, `agent-browser-process-record.ts`, `runtime.ts`, `agent-browser-select-content.ts`, `recording/`
- HarmonyOS: `runtime.ts` body, `recording/`, `logs/`, `deployment/`, `inventory.ts`, `perf*`
- Linux: `runtime.ts`, `snapshot.ts`, `role-map.ts`; Vega: `runtime.ts`, `doctor.ts`
- Almost all test files

Checked and dropped (not findings): Vega CLI adapter passing no `env` to `runCmd` (the command-host scope supplies it); HarmonyOS screenshots being JPEG (documented in `website/docs/docs/commands.md:1069`); web network dump returning `redacted: false` (redaction happens downstream in `command-runtime`).

Nothing was executed; findings 5, 9 and 24 rest on external tool behaviour I could not run and are marked accordingly.

## Findings

### PROV-1: WebDriver transport loses status, retry and dispatch disclosure when an error body is not JSON
- Category: broken
- Severity: medium     Confidence: high
- Evidence: `packages/provider-webdriver/src/webdriver-transport.ts:213` parses the body before looking at `ok`/`status`; `parseJsonResponse` (`:325-331`) throws `COMMAND_FAILED` with only `{ text }`. `isRetriableWebDriverError` (`:474-485`) needs `details.status >= 500`, and `webdriverError` (`:351-357`) is the only place `dispatched: 'unknown'` is attached to a 5xx. A hub gateway answering `502 <html>…` therefore produces an error with no `status`, is never retried even for GET, and carries no dispatch disclosure. No test covers this path (`grep "not valid JSON"` finds only the source line; the HTML-502 tests are all for the upload/details helpers).
- Fix: in `requestOnce`, on `!ok` treat an unparseable body as `payload = undefined` and go through `webdriverError(status, …)`; keep the "not valid JSON" failure only for a 2xx answer, and give that one `status` too. Touches `webdriver-transport.ts` plus a new case in `webdriver-transport.test.ts`.
- Effort: S
- Model: sonnet
- Verify: new test in `webdriver-transport.test.ts`: a `502` with an HTML body on GET is retried once and the final error has `details.status === 502` and `details.dispatched === 'unknown'`.

### PROV-2: Three lease state machines for the same job, and the same refusal has three different codes and reasons
- Category: inconsistent
- Severity: medium     Confidence: high
- Evidence: Revyl uses the shared `packages/provision-kit/src/provider-lease-table.ts` (775 lines; `provider-revyl/src/runtime.ts` is its only production importer). WebDriver hand-rolls the same allocate/take/dispose/shutdown machine in `provider-webdriver/src/runtime-session.ts:148-377`, and Limrun again in `provider-limrun/src/runtime.ts:344-651`. "Allocate after shutdown" is `COMMAND_FAILED` / `provider_session_shutdown_during_allocation` (`runtime-session.ts:726-739`), `SESSION_NOT_FOUND` / `limrun_runtime_shut_down` (`provider-limrun/src/runtime.ts:937-945`), and `COMMAND_FAILED` / `runtime-shutting-down` (`provider-revyl/src/runtime.ts:321-327`). "Lease released while allocating" is `COMMAND_FAILED` / `provider_session_released_during_allocation` (`runtime-session.ts:661-668`), `DEVICE_IN_USE` / `limrun_lease_released_mid_allocation` (`provider-limrun/src/lease-release.ts:497-501`), and `COMMAND_FAILED` / `provider-lease-releasing` (`provider-revyl/src/runtime.ts:249-254`). A caller cannot key on one typed reason across providers, and the reason naming style differs (snake with provider prefix, snake with `limrun_`, kebab).
- Fix: move WebDriver and Limrun onto `provider-lease-table`, or at minimum define the refusal codes and reasons once in `provision-kit` and use them from all three. Touches `provider-webdriver/src/runtime-session.ts`, `provider-limrun/src/runtime.ts`, `provider-limrun/src/lease-release.ts`, `provision-kit`.
- Effort: L
- Model: opus
- Verify: `pnpm check:affected --run`; a shared contract test asserting each provider's shutdown and release-during-allocate refusals carry the same `code` and `details.reason`.

### PROV-3: Web `fill` and `type` put the typed text in a child process argv and in error details
- Category: broken
- Severity: medium     Confidence: high
- Evidence: `packages/platform-web/src/agent-browser-provider.ts:130,136,139` send `['keyboard','type',text]` and `['fill', ref, text]` as CLI arguments; `agent-browser-tool.ts:174` spawns `node <entry> ...args`, so a typed password is readable in the host process table. On failure the same argv is copied into the error at `agent-browser-provider.ts:712` and `:724` (`args: cliArgs`), which travels to the client and diagnostics. The backend already takes work on stdin (`batch`, `:345`).
- Fix: route `fill` and `keyboard type` through `batch` on stdin (one-entry batch), and drop or mask the text positions in `args` on the error paths. Touches `agent-browser-provider.ts` and its tests.
- Effort: M
- Model: opus
- Verify: unit test that the `runCmd` argv for a `fill` call does not contain the text and that a failed `fill` error's `details.args` does not either; then a manual `agent-device` web `fill` run per `docs/agents/device-verification.md`.

### PROV-4: Plugin store never deletes superseded or removed installations
- Category: broken
- Severity: medium     Confidence: high
- Evidence: `packages/plugins/src/store.ts:209-260` (`changePlugin`). `remove` only deletes the config key (`:232`); `add` over an existing entry and `update` stage a new `plugins/<uuid>` tree (`stagePlugin`, `:167-207`) and overwrite the selection. The previous `plugins/<previous.installation>` directory, a full `node_modules` tree, is never removed. The only `rmSync` calls are for a failed stage (`:205`, `:256`). A repo-wide grep finds no other cleanup of installation directories.
- Fix: after `publishFileSync` succeeds, `fs.rmSync(path.join(home, 'plugins', previous.installation), { recursive: true, force: true })` when `previous` passed `validatePluginSelection`. Touches `store.ts`, `store.test.ts`.
- Effort: S
- Model: sonnet
- Verify: extend `packages/plugins/src/store.test.ts`: after `update` and after `remove`, the old installation directory no longer exists.

### PROV-5: Linux Wayland long-press and drag call `ydotool click --down/--up`, which ydotool v1 does not have
- Category: broken
- Severity: medium     Confidence: medium
- Evidence: `packages/platform-linux/src/input-actions.ts:166-169` and `:200-204` run `ydotool click --down 0xC0` / `--up 0xC0`. The file's own comment (`:93-95`) describes the v1 packed button format, where down/up are bits of the code (`0x40` down, `0x80` up, `0xC0` both) and `click` accepts only repeat/delay options. `__tests__/input-actions.test.ts` has no ydotool down/up case. Not run on a Wayland host; the ydotool CLI claim is from its documented v1 interface.
- Fix: send `ydotool click 0x40` for press and `ydotool click 0x80` for release. Touches `input-actions.ts`, `__tests__/input-actions.test.ts`.
- Effort: S
- Model: opus
- Verify: on a Wayland host with `ydotoold`, `agent-device longpress` and a swipe against a GTK app; plus a unit test pinning the argv.

### PROV-6: Linux `open <binary>` runs the app as a captured `runCmd` child for its whole lifetime
- Category: broken
- Severity: medium     Confidence: high
- Evidence: `packages/platform-linux/src/tool-provider.ts:182-191` launches the app with `runCommand(target, [], { allowFailure: true })` and does not await it. `runCmd` (`packages/host-kit/src/internal/exec.ts:203-340`) has no default timeout, pipes stdio, and appends every stdout/stderr chunk to in-memory strings until `close`. A long-running or chatty desktop app therefore grows daemon memory without bound and stays a piped child of the daemon. `runCmdDetached` exists in the same module.
- Fix: launch with `runCmdDetached` (or `captureOutput: false` plus `detached`), keeping the spawn-failure diagnostic. Touches `tool-provider.ts`, `__tests__/tool-provider.test.ts`.
- Effort: S
- Model: sonnet
- Verify: unit test that `openTarget('<binary>')` uses the detached runner; on a Linux host, open a GUI app and confirm the daemon holds no pipes to it.

### PROV-7: Hosted app upload has no deadline, untyped transport failures, and reads the whole app into memory
- Category: inconsistent
- Severity: medium     Confidence: high
- Evidence: `packages/provider-webdriver/src/webdriver-utils.ts:109-117` (`postHubAppUpload`) passes only the caller's optional `signal`; there is no timeout, a network failure surfaces as a raw `TypeError: fetch failed`, and a 401/403 becomes generic `COMMAND_FAILED` (`:120-125`). Its siblings in the same file wrap transport errors and bound the call (`fetchProviderVerificationJson` `:216-252` types 401/403 as `UNAUTHORIZED`; `fetchProviderSessionDetails` `:269-285`). `appFileUploadForm` (`:90`) does `new Blob([await readFile(appPath)])`, buffering the entire artifact; `browserstack-provider.ts:78` notes 130 MB uploads are routine. Used by both BrowserStack (`browserstack.ts:131`) and TestMu (`provider-testmu/src/testmu.ts:129`).
- Fix: wrap the fetch like the two siblings (typed `COMMAND_FAILED` with cause, `UNAUTHORIZED` for 401/403, a generous `AbortSignal.timeout` combined with the caller signal) and build the part with `fs.openAsBlob(appPath)`. Touches `webdriver-utils.ts`, `webdriver-utils.test.ts`.
- Effort: S
- Model: sonnet
- Verify: `webdriver-utils.test.ts`: a rejected fetch yields an `AppError` with a cause; a 401 yields `UNAUTHORIZED`.

### PROV-8: AWS Device Farm artifact lookup picks its region differently from the session that created the artifacts
- Category: broken
- Severity: medium     Confidence: medium
- Evidence: `packages/provider-webdriver/src/aws-device-farm-provider.ts:58-60` creates the session with `--aws-region` flag first, then env. `listArtifacts` (`:43-51`) uses env `AWS_REGION`/`AWS_DEFAULT_REGION` first and only then the region inside the session ARN, and never sees the flag. With `AWS_REGION` set to the user's usual region and `--aws-region us-west-2` on the command, the session is created and stopped in us-west-2 but `list-artifacts` runs against the env region and fails. The ARN is authoritative for where the session lives.
- Fix: prefer `readAwsDeviceFarmRegionFromArn(providerSessionId)` and fall back to env. Touches `aws-device-farm-provider.ts`, `aws-device-farm.test.ts`.
- Effort: S
- Model: sonnet
- Verify: unit test: env region `eu-west-1`, session ARN in `us-west-2` → the `list-artifacts` argv carries `--region us-west-2`.

### PROV-9: A malformed CDP frame or event throws inside the WebSocket handler
- Category: broken
- Severity: medium     Confidence: medium
- Evidence: `packages/tv-cdp/src/cdp.ts:66-73` runs `JSON.parse(String(event.data))` and every listener with no guard. The log listener (`page-log.ts:58-66`) dereferences `params.exceptionDetails` / `params.entry` without checks. An exception thrown from a Node `EventTarget` listener is rethrown as an uncaught exception, so one bad frame from an old TV Chromium can take the daemon down rather than fail one request. Not reproduced.
- Fix: wrap the handler body in try/catch, drop the frame with a debug diagnostic, and make the three `page-log` handlers tolerate missing fields. Touches `cdp.ts`, `page-log.ts`, `page-log.test.ts`.
- Effort: S
- Model: sonnet
- Verify: `page-log.test.ts`: `record('Runtime.exceptionThrown', {})` does not throw; a `cdp` test feeding a non-JSON frame leaves pending requests intact.

### PROV-10: A single transient failure on session delete leaves a billed WebDriver session
- Category: broken
- Severity: medium     Confidence: medium
- Evidence: `packages/provider-webdriver/src/webdriver-transport.ts:118,167-171` gives only GET/HEAD a retry budget, so `deleteSession` (`webdriver-client.ts:104-108`) is one attempt. `runtime-session.ts:392-410` turns any failure into `WEBDRIVER_SESSION_DELETE_FAILED` and `cleanup: 'uncertain'`; unlike Limrun (`provider-limrun/src/runtime.ts:632-635` keeps the owner for a retried delete), the entry is dropped (`:361-363`), so nothing ever retries. A 404 `invalid session id` (already gone) is also reported as a failed delete.
- Fix: mark the session DELETE idempotent in the client and read `invalid session id` as confirmed. Touches `webdriver-client.ts`, `runtime-session.ts`, tests.
- Effort: M
- Model: opus
- Verify: `runtime-session.test.ts`: first DELETE resets, second succeeds → `cleanup: 'confirmed'`; DELETE answering 404 `invalid session id` → `confirmed`.

### PROV-11: AT-SPI dump drops everything below depth 12 without reporting truncation
- Category: broken
- Severity: medium     Confidence: medium
- Evidence: `linux/atspi-dump.py:118-119` returns silently when `depth > max_depth`; `:271-275` sets `truncated` only from `len(nodes) >= max_nodes` (which is also a false positive for a tree of exactly `max_nodes`). `packages/platform-linux/src/atspi-bridge.ts:28` fixes `MAX_DEPTH = 12`, shallow for Electron and nested GTK trees, so deep controls vanish from snapshots while `truncated` stays false.
- Fix: track a `ctx["truncated"]` flag set on both the depth and node cut-offs and return it. Touches `linux/atspi-dump.py`, `__tests__/atspi-bridge.test.ts`.
- Effort: S
- Model: sonnet
- Verify: run the script against a fake tree deeper than `--max-depth` and assert `truncated: true`.

### PROV-12: xdotool long-press and drag leave the mouse button held when a step fails
- Category: broken
- Severity: low     Confidence: high
- Evidence: `packages/platform-linux/src/input-actions.ts:161-164` and `:195-199` run `mousedown`, then `sleep` / `mousemove --sync`, then `mouseup` with no `try/finally`. The file documents that `mousemove --sync` can hang until the 10 s action timeout (`:33-40`); when it does, `mouseup` never runs and the host pointer stays pressed for every later action.
- Fix: put the release in `finally` for both tools. Touches `input-actions.ts`, its test.
- Effort: S
- Model: sonnet
- Verify: unit test: `mousemove` rejects → `mouseup 1` is still issued.

### PROV-13: AWS readiness loop discards a session that became RUNNING on the last poll
- Category: broken
- Severity: low     Confidence: high
- Evidence: `packages/provider-webdriver/src/aws-device-farm.ts:291-305`. The status is checked at the top of the loop only; after the final `getRemoteAccessSession` (`:298`) the `while (Date.now() < deadline)` exits and throws the timeout without looking at `last`, and the caller then stops the session (`:226`).
- Fix: check `last.status === 'RUNNING'` once more after the loop. Touches `aws-device-farm.ts`, `aws-device-farm.test.ts`.
- Effort: S
- Model: sonnet
- Verify: test with a fake clock where the poll that crosses the deadline returns RUNNING → resolves.

### PROV-14: AWS WebDriver endpoint selection guesses from unrelated fields and downgrades to `http://`
- Category: inconsistent
- Severity: low     Confidence: medium
- Evidence: `packages/provider-webdriver/src/aws-device-farm.ts:253-273` takes the first non-`ws` value from `remoteDriverEndpoint`, `endpoint`, every value of `endpoints` in object order, `remoteDebugUrl`, `remoteRecordAppUrl`. Only the first is a WebDriver endpoint; the rest are fallbacks nobody requested (AGENTS.md: no fallback paths without request), and a scheme-less value gets `http://` prepended.
- Fix: accept only `remoteDriverEndpoint` (top-level or under `endpoints`) and fail with the existing "did not expose a WebDriver endpoint" error otherwise. Touches `aws-device-farm.ts`, test.
- Effort: S
- Model: opus
- Verify: unit test: a session with only `remoteDebugUrl` fails typed; confirm against a real `get-remote-access-session` payload.

### PROV-15: Every web command resolves the managed-backend status three times with synchronous file I/O
- Category: inefficient
- Severity: low     Confidence: high
- Evidence: `packages/platform-web/src/agent-browser-provider.ts:512`, `:681` (inside `cleanupProviderStartupOrphans`, called at `:518`) and `agent-browser-tool.ts:63` each call `getManagedAgentBrowserStatus`, which reads and parses the backend `package.json` and stats the entry and manifest (`agent-browser-tool.ts:135-163,230-252`). `managedAgentBrowserEnv` (`:183-197`) then does three sync `mkdir` calls plus `lstat`/`readlink` before every spawn.
- Fix: resolve the status once in `runAgentBrowserCommand` and pass it down (an internal `runManagedAgentBrowserWithStatus`); ensure the directories once per status. Touches `agent-browser-provider.ts`, `agent-browser-tool.ts`.
- Effort: S
- Model: sonnet
- Verify: test counting `readHostTextFileSync` calls for one provider command (expect 1).

### PROV-16: `binaryPath` in the managed web status points at the shim the code forbids running
- Category: unneeded
- Severity: low     Confidence: high
- Evidence: `packages/platform-web/src/agent-browser-tool.ts:146,266-269` computes the `node_modules/.bin` shim path and returns it as `status.binaryPath`, while `:54-58,166-167` state the shim must never be executed. No production code reads the field; the only readers are the contract type (`packages/contracts/src/managed-web-backend.ts:7`) and the test fixture `packages/test-kit/src/web-managed-agent-browser.ts:23-25,67`, which writes a fake shim nothing runs.
- Fix: remove `binaryPath` from `ManagedWebBackendStatus`, `resolveManagedBinaryPath`, and the fixture's shim. Check that no documented `web doctor` JSON output promises the field first.
- Effort: S
- Model: sonnet
- Verify: `pnpm typecheck` and the platform-web tests.

### PROV-17: Linux screenshot tools run with no timeout and ignore the declared screenshot options
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence: `packages/platform-linux/src/tool-provider.ts:327-335` builds `grim`/`scrot`/`import`/`gnome-screenshot` commands with no `options`, while the clipboard commands in the same table set `timeoutMs: 5000` (`:288-325`); `runCmd` has no default timeout. `LinuxScreenshotOptions` (`:46-50`: `fullscreen`, `stabilize`, `surface`) is passed through `interactor.ts:71` → `screenshot.ts:7`, but `capture(outPath)` at `:232` does not take the parameter.
- Fix: add a timeout to the screenshot commands, and either implement the options or remove them from the local provider type.
- Effort: S
- Model: sonnet
- Verify: `__tests__/tool-provider.test.ts` asserts the screenshot argv carries a `timeoutMs`.

### PROV-18: HarmonyOS long-press accepts a duration and ignores it
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence: `packages/platform-harmonyos/src/input-actions.ts:22-32` takes `_durationMs = 800` and always sends `uitest uiInput longClick x y`; `interactor.ts:37` forwards the caller's duration. The runtime advertises `longPress` with no duration caveat (`runtime.ts:238`).
- Fix: refuse a non-default duration with `UNSUPPORTED_OPERATION`, or state it in the long-press fact and help. Touches `input-actions.ts`, `runtime.ts`, owning help text.
- Effort: S
- Model: sonnet
- Verify: `__tests__/input-actions.test.ts` case for a custom duration.

### PROV-19: HarmonyOS `keyboard dismiss` sends Back without knowing a keyboard is up
- Category: broken
- Severity: low     Confidence: medium
- Evidence: `packages/platform-harmonyos/src/interactor.ts:61-64` implements `keyboardDismiss` as `pressHarmonyKeyboardKey(device, 'Back')` and returns `acknowledged`; keyboard status is declared unavailable (`runtime.ts:171-173`). With no keyboard showing, the command navigates the app back and still reports success.
- Fix: document the behaviour in the owning help, or gate on a snapshot-derived keyboard check. Needs a product decision.
- Effort: M
- Model: opus
- Verify: device run on a HarmonyOS target: `keyboard dismiss` with no keyboard showing.

### PROV-20: v1 plugin compatibility path is scheduled for removal at 0.22 and still spans four files
- Category: unneeded
- Severity: low     Confidence: high
- Evidence: `packages/plugins/src/legacy.ts:17-21` ("until 0.22 removes v1"; also `docs/adr/0034-provider-plugin-registry.md:27`); repo version is `0.21.37-dev`. The path includes `legacy.ts`, `legacyStoreManifests` and its callers (`store-legacy.ts:54-73`, `connection.ts:73-83`, `credential-fingerprint.ts:43-44`, `store.ts:237-241,265-281`), the v1 manifest reader in `manifest.ts`, and TestMu's v1 entry (`provider-testmu/src/plugin.ts`, the `agentDevicePlugin` block in `provider-testmu/package.json`). `store-legacy.ts` also holds the non-legacy store primitives (`readPluginConfig`, `validatePluginSelection`, `storeHome`, `installationDirectory`, `isVersionSelector`), so it cannot simply be deleted. The v1 adapter re-runs the whole plugin factory, including runtime construction, for every `resolve`/`verify` (`legacy.ts:38-63`).
- Fix: at 0.22, delete the v1 path and move the store primitives out of `store-legacy.ts` into `store.ts`. Moving the primitives can be done now.
- Effort: M
- Model: sonnet
- Verify: `pnpm check:affected --run`; `packages/plugins/src/load.test.ts` with the v1 cases removed.

### PROV-21: BrowserStack and TestMu boilerplate has drifted
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence: (a) session id is path-encoded for TestMu (`provider-testmu/src/testmu.ts:231`) but not for BrowserStack (`provider-webdriver/src/browserstack.ts:226`). (b) `browserstack.ts:214-218` defines a local `asRecord` where TestMu uses `asOptionalRecord` from `@agent-device/kernel/record`. (c) The hosted-WebDriver connection capability object exists three times: `provider-webdriver/src/providers.ts:29-37`, `provider-testmu/src/index.ts:45-53`, `provider-testmu/package.json`. (d) `testmu.ts:92-101` stats the file and throws its own error before `appFileUploadForm`, which stats again (`webdriver-utils.ts:77-88`), so the shared refusal is unreachable for TestMu and the two providers word the same mistake differently. (e) `testmu-webdriver.ts:44-54` takes an `env` parameter that shadows the identical outer `env`.
- Fix: encode the BrowserStack id, use `asOptionalRecord`, export the capability constant from `@agent-device/provider-webdriver/plugin` for TestMu, drop the duplicate stat (pass the hint into `appFileUploadForm`), drop the shadowing parameter.
- Effort: S
- Model: sonnet
- Verify: `pnpm check:affected --run`.

### PROV-22: tv-cdp polls the inspector once a second per attached TV and adds unabortable sleeps to every tap
- Category: inefficient
- Severity: low     Confidence: high
- Evidence: `packages/tv-cdp/src/page-interactor.ts:101-115` re-arms an HTTP GET of `/json` every 1000 ms for as long as a page is attached. `hover` (`:153-163`) sleeps 4×60 ms and `press` adds `holdMs`, none tied to the request `signal`. `session.logs` (`runtime.ts:203`, `page-interactor.ts:117-123`) keeps up to 5000×4000 chars per app id for the lease lifetime and is not cleared on `close(app)`.
- Fix: lengthen the watch interval (the tunnel's `onClose` and request timeouts already cover most exits), pass `signal` to the sleeps, drop an app's log on `close`.
- Effort: S
- Model: sonnet
- Verify: `packages/tv-cdp/src/runtime.test.ts`.

### PROV-23: WebDriver session manager bookkeeping grows for the daemon's lifetime
- Category: inefficient
- Severity: low     Confidence: high
- Evidence: `packages/provider-webdriver/src/runtime-session.ts:117,389` adds to `releasedProviderSessionIdsByLeaseId` on every disposal and never deletes; `ownedDeviceIds` (`:116,270`) is added per session and cleared only in `shutdown()` (`:242`), so `ownsDevice` stays true for released devices and both collections grow by one entry per lease.
- Fix: bound the released-session map (LRU or TTL). If stale-owner retention of device ids is intended, state the bound.
- Effort: S
- Model: sonnet
- Verify: unit test allocating and releasing N leases and asserting the map size is capped.

### PROV-24: `wl-copy` is run with piped stdio and a 5 s timeout
- Category: broken
- Severity: low     Confidence: low
- Evidence: `packages/platform-linux/src/tool-provider.ts:310-314` runs `wl-copy -- <text>` through `runCmd`, which settles on `close` (`host-kit/src/internal/exec.ts:336-339`). `wl-copy` forks a background process to serve the selection; if it keeps the inherited pipes open, `close` never fires and the write reports a 5 s timeout although the copy worked. Depends on the installed wl-clipboard version; `__tests__/clipboard.test.ts` mocks the command. Not reproduced.
- Fix: run it with `captureOutput: false` and ignored stdio, or `wl-copy --foreground` under a detached runner.
- Effort: S
- Model: opus
- Verify: on a Wayland host, time `agent-device clipboard write`.

### PROV-25: A Linux tap costs three process spawns
- Category: inefficient
- Severity: low     Confidence: high
- Evidence: `packages/platform-linux/src/input-actions.ts:41-48,98-105`: `xdotool getmouselocation`, `xdotool mousemove --sync`, `xdotool click`, each a separate `runCmd`. xdotool chains commands in one invocation.
- Fix: issue `mousemove --sync X Y click N` as one command when the pointer is not already there. Keep the no-op guard.
- Effort: S
- Model: sonnet
- Verify: `__tests__/input-actions.test.ts` argv expectations.

### PROV-26: webOS device listing throws a raw `SyntaxError`
- Category: broken
- Severity: low     Confidence: high
- Evidence: `packages/provider-webos/src/ares.ts:119` does `JSON.parse(await ares('ares-setup-device', ['--listfull']))` with no guard. Any banner or warning line makes `connectTv` fail with an untyped `SyntaxError`, where every other ares failure goes through `aresError` (`:131-143`).
- Fix: catch and rethrow `COMMAND_FAILED` with the output and the existing hint. Touches `ares.ts`, `ares.test.ts`.
- Effort: S
- Model: sonnet
- Verify: `ares.test.ts`: non-JSON stdout → `AppError` `COMMAND_FAILED`.

### PROV-27: AT-SPI bridge classifies failures by matching stderr text and shows the helper's JSON error raw
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence: `packages/platform-linux/src/atspi-bridge.ts:131` picks `TOOL_MISSING` from `stderr.includes('No module named') || stderr.includes('gi.require_version')` (AGENTS.md: typed reasons, no text matching). The helper reports its own errors as `{"error": …}` on stdout with exit 1 (`linux/atspi-dump.py:283-285,312-316,322-324`), but the bridge reads `parsed.error` only on exit 0 (`:154-156`), so those surface as `AT-SPI2 snapshot failed (exit 1): {"error": "..."}`.
- Fix: have the script exit with distinct codes for missing bindings versus runtime errors and always parse stdout JSON for `error`. Touches `atspi-dump.py`, `atspi-bridge.ts`, test.
- Effort: S
- Model: sonnet
- Verify: `__tests__/atspi-bridge.test.ts` cases for exit 1 with a JSON error and for the missing-bindings code.
