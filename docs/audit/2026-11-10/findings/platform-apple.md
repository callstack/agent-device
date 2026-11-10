# SLICE APPLE — `packages/platform-apple/`

## Coverage

Slice: 346 tracked files, ~29k non-test lines + ~36k test/fixture lines.

- Read in full (comments stripped, all code lines): `core/{simctl,devicectl,simulator,tool-provider,app-launch,local-simulator-apps,local-simulator-files,launch-diagnostics,ios-simulator-accessibility,app-device-io,app-resolution,simctl-settings,app-settings,install-artifact,bundle-info,plist,config,physical-device-coredevice,physical-device-control,physical-device-screenshot,physical-device-files,screenshot,screenshot-status-bar,tool-diagnostics,simctl-execution}.ts`, `simulator-boot.ts`, `simulator-state.ts`, `alert.ts`, `detached-attempt.ts`, `runner-runtime.ts`, `open-policy.ts`, `readiness/runtime.ts`, `shutdown/runtime.ts`, `deployment/runtime.ts`, `inventory.ts`, `simulator-inventory.ts`, `physical-inventory.ts`, `inventory-classification.ts`, `os/macos/{apps,host-provider}.ts`, `native-build/{cache,toolchain-identity}.ts`, `foldable/{fold-helper,fold-helper-cache}.ts`, `snapshot-source/cache.ts`, `audio/runtime.ts`.
- Read partially: `lifecycle.ts` (first 500 of 652 lines), `core/display-inventory.ts` (~70%), `os/macos/helper.ts` (~60%, build/exec path fully), `logs/start.ts` (~65%), `interactor.ts` and `core/perf.ts`/`perf-target.ts` (targeted regions only).
- Mechanical scans over the whole slice: every `runXcrun`/`runCmd`/`simctl.run` call site checked for a `timeoutMs`; all 646 exported symbols cross-referenced against the repo (no export is fully unreferenced — fallow is clean here; ~80 are referenced only by their own file plus tests, not reported); error-text matching grep; legacy/compat/TODO grep; timeout-constant inventory; tests without assertions (none: the two hits assert through `assertProducedRunnerRequests`).
- Not reached: `snapshot-source/{lifecycle,tree,protocol,bridge-source,adapter,transport}.ts`, `interactions.ts`, `runtime.ts`, `recording/*`, `core/perf*.ts` bodies, `core/debug-symbols/*`, `navigation/`, `network/`, `system/`, `launch-confirmation.ts`, `snapshot-presentation.ts`, `os/macos/launch-services-registration.ts`, and the test bodies (150 test files) beyond the mechanical scans.
- Rough depth: ~35% of production lines read line by line, ~100% covered by the mechanical scans, tests ~0% read.

Android was only grepped to confirm duplication (`platform-android/src/deployment/runtime.ts`).

## Findings

### APPLE-1: macOS helper recomputes its source fingerprint (17 file reads + a `swift --version` spawn) on every helper call, with no single-flight on the build
- Category: inefficient
- Severity: high     Confidence: high
- Evidence:
  - `packages/platform-apple/src/os/macos/helper.ts:340-346` — `runMacOsHelper` calls `resolveMacOsHelperCommandPath(env)` for every action (press, snapshot, read, alert, quit, permission).
  - `helper.ts:283-296` → `ensureMacOsHelperBinary` (`:243-281`) → `computeMacOsHelperFingerprint` (`:211-230`), which walks `apple/macos-helper`, reads and hashes every `.swift` file (17 files, 140 KB today) and spawns `swift --version` (`:220-224`, 10 s timeout). Nothing is memoized; `resolveMacOsHelperPackageRootFrom` (`:164-180`) additionally does a sync `existsSync` walk up the tree each time.
  - `os/macos/apps.ts:132-135` — `closeMacOsApp` polls with up to 19 further `quitMacOsApp` helper calls at a nominal 100 ms interval; each one repeats the fingerprint work, so the poll interval is dominated by `swift --version`.
  - No lock or in-flight promise around `swift build` + `copy` to the fixed `${installedPath}.tmp` (`:267-275`): two concurrent first calls (two sessions, or snapshot + alert) build twice and race on the same temp file. The sibling native helpers use `ensureNativeBuildCacheEntry` (`native-build/cache.ts:20-78`), which has a process lock, a pid-scoped temp path and an atomic rename.
- Fix: memoize the resolved helper path per process (key: `env[MACOS_HELPER_ENV_PATH]` + package root), holding the in-flight promise so concurrent callers share one build; move the build onto `ensureNativeBuildCacheEntry` (or at least a lock + pid-scoped temp). Files: `os/macos/helper.ts`.
- Effort: M
- Model: opus (concurrency, device-facing macOS path)
- Verify: unit test that N `runMacOsHelper` calls with a mocked `runAppleToolCommand` spawn `swift --version` once; `pnpm check:affected --run`; manual macOS `snapshot`/`press` latency before/after.

### APPLE-2: Listing macOS apps spawns one `plutil` per `.app`, all at once, plus three unbounded `find` runs
- Category: inefficient
- Severity: high     Confidence: high
- Evidence:
  - `packages/platform-apple/src/os/macos/host-provider.ts:106-121` — three `find <root> -maxdepth 4 -type d -name '*.app'` spawns, no `timeoutMs`.
  - `host-provider.ts:123-139` — `Promise.all` over every app path calling `readMacOsBundleInfo` → `readPlistJson` → `plutil -convert json` (`core/tool-provider.ts:206-225`). No concurrency bound: a Mac with 200 apps forks 200 `plutil` processes simultaneously, and up to 2 per app when `Contents/Info.plist` yields nothing (`host-provider.ts:153-167`).
  - Reached from `resolveMacOsApp` on every name-cache miss (`os/macos/apps.ts:49`) and from `apps` on macOS (`core/app-resolution.ts:284`).
  - The package already parses plists in-process: `parseApplePlist` in `core/plist.ts:67-74` (the `plist` module), used by `core/ios-simulator-accessibility.ts:70`.
- Fix: read `Info.plist` with `readHostBinaryFile` + `parseApplePlist` for the local provider (no spawn), bound the concurrency, and give `find` a timeout (or replace it with `readHostDirectory` recursion to depth 4). Files: `os/macos/host-provider.ts`, `core/tool-provider.ts`.
- Effort: M
- Model: sonnet
- Verify: `packages/platform-apple/src/os/macos/__tests__` host-provider tests asserting zero `plutil` spawns; `pnpm check:affected --run`.

### APPLE-3: The "recently observed Booted" memo is re-armed by its own cache hits, so it never expires under steady use
- Category: broken
- Severity: medium     Confidence: high
- Evidence:
  - `packages/platform-apple/src/core/simulator.ts:67-73` — `state = wasSimulatorRecentlyObservedBooted(device) ? 'Booted' : await getSimulatorState(...)`, then `if (state === 'Booted') { markSimulatorBooted(device); return; }`. A memo hit therefore calls `set` again.
  - `packages/kernel/src/ttl-memo.ts` `set` recomputes `expiresAt` from now, so the 5 s TTL (`SIMULATOR_BOOTED_MEMO_TTL_MS`, `simulator.ts:27`) slides.
  - `packages/platform-apple/src/readiness/runtime.ts:46-56` does the same: `recentlyObservedBooted ? 'Booted' : …` followed by an unconditional `markBooted(device)` (bound to the same memo in `src/platform-runtime-apple-automation-keep-hot.ts:11-17`).
  - Contradicts the contract written at `simulator.ts:38-42`: "Callers must only pass FRESH observations — seeding from a cached … listing would poison the memo." Any command stream with gaps under 5 s never runs `simctl list` again, so a simulator shut down externally is never auto-booted; the caller gets the raw simctl error indefinitely instead of "inside the window".
- Fix: mark only after a real observation (`getSimulatorState` returned `Booted`, or boot succeeded); return early on a memo hit without `set`. Files: `core/simulator.ts`, `readiness/runtime.ts`.
- Effort: S
- Model: sonnet
- Verify: extend `core/__tests__/simulator*.test.ts` with a fake clock: call `ensureBootedSimulator` every 3 s for 12 s and assert a second `simctl list devices -j` spawn after 5 s.

### APPLE-4: `reinstall` uninstalls the installed app before the replacement artifact is validated
- Category: broken
- Severity: medium     Confidence: high
- Evidence: `packages/platform-apple/src/deployment/runtime.ts:108-123` — with `replaceExisting` the order is `resolveAppBundleId` → `uninstallAppleApp` → `prepareArtifact` → install. `prepareArtifact` is what rejects an invalid IPA (`core/install-artifact.ts:156-192`: missing `Payload`, zero or ambiguous `.app`), a failed archive extraction, or an aborted signal, so any of those leaves the device with the app (and its data) removed and nothing installed. The same branch also drops the injected installer's result (`:117` `if (install) await install(artifact, signal)`) and returns only `{ bundleId, launchTarget }`, so `appName` and an installer-reported bundle id are lost, unlike the non-replace path (`:160-179`).
  - Same ordering in `packages/platform-android/src/deployment/runtime.ts:104-125` (uninstall at the `uninstallAndroidPackage` line, then `prepareArtifact`), so this is a shared flaw.
- Fix: prepare the artifact first, then uninstall, then install; route the replace branch through `deployPreparedAppleApp` so the result shape matches. Files: `deployment/runtime.ts` (and mirror in the Android owner).
- Effort: S
- Model: opus (device-facing ordering, two platforms)
- Verify: unit test in `deployment/__tests__` with `prepareArtifact` rejecting — assert no `simctl uninstall` request was issued.

### APPLE-5: Two independent simulator-boot implementations with different budgets, retries and errors
- Category: inconsistent
- Severity: medium     Confidence: high
- Evidence:
  - `packages/platform-apple/src/core/simulator.ts:61-182` `ensureBootedSimulator`: `IOS_BOOT_TIMEOUT_MS = 180_000`, list timeout `IOS_SIMCTL_LIST_TIMEOUT_MS = 60_000` (`core/config.ts:1-3`), 3 attempts via `retryWithPolicy`, `classifyBootFailure` reasons, error "iOS simulator failed to boot", a post-`bootstatus` `simctl list` re-check (`:143`), private `getSimulatorState` (`:184-193`).
  - `packages/platform-apple/src/readiness/runtime.ts:32-183` `ensureAppleReady`: `BOOT_TIMEOUT_MS = 120_000`, `LIST_TIMEOUT_MS = 15_000` (`:15-16`), single attempt, error "Simulator did not finish booting within the startup budget" with `BOOT_TIMEOUT_REASON`, no re-check, shutdown-on-abort (`:82`), second `getSimulatorState` in `simulator-state.ts:6-30`.
  - Both duplicate the `'already booted' || 'current state: booted'` parse (`simulator.ts:120-121`, `readiness/runtime.ts:107-109`) and the `open -g -a Simulator` step (`simulator.ts:53-59`, `readiness/runtime.ts:178-183`).
  - Both are live: lifecycle/deployment use `ensureAppleReady`; `core/app-launch.ts:171,202,249,271`, `core/app-settings.ts:72,300`, `core/app-device-io.ts:14,40`, `core/screenshot.ts:115` and `src/platform-runtime-device-ready.ts:11-12` use `ensureBootedSimulator`. A cold simulator reached through `settings`/`clipboard`/`screenshot` gets a different timeout, retry policy and error reason than one reached through `open`.
- Fix: keep one boot owner (the `readiness/runtime.ts` shape, which is host-injected and cancel-aware) and have the `core/` callers go through it; delete the other with its constants. Files: `core/simulator.ts`, `readiness/runtime.ts`, `simulator-state.ts`, `core/config.ts`, callers.
- Effort: L
- Model: opus (cross-module, device behavior)
- Verify: `pnpm check:affected --run`; device run per `docs/agents/device-verification.md`: `screenshot` and `open` against a shut-down simulator report the same reason.

### APPLE-6: Many simctl and host spawns have no timeout; exec has no default
- Category: broken
- Severity: medium     Confidence: high
- Evidence: `packages/host-kit/src/internal/exec.ts:858-863` — `normalizeTimeoutMs(undefined)` is `undefined`, so a call without `timeoutMs` waits forever on a wedged CoreSimulator (the condition `core/config.ts:18-23` documents for `openurl`). Unbounded call sites:
  - `core/app-launch.ts:294` `simctl launch` (the retry `Deadline` at `:277` is only read between attempts; `IOS_APP_LAUNCH_TIMEOUT_MS` never reaches the exec).
  - `core/app-settings.ts:93` (`keychain reset`), `:382` and `:437` (biometric `spawn notifyutil`), `:183` (`runSimctl` for appearance/privacy/location → `core/simctl-settings.ts:30,46,56,67,71`).
  - `core/app-device-io.ts:16,42` (`pbpaste`/`pbcopy`), `core/settings-text-size.ts:21,34`.
  - `core/launch-diagnostics.ts:35,50,66` (`get_app_container`, `plutil`, `otool`) — runs on the error path after three failed launches.
  - `deployment/runtime.ts:253-261` (`simctl push`), `readiness/runtime.ts:186-192` (fire-and-forget `simctl shutdown`).
  - `os/macos/host-provider.ts:26,34,38,45,56,70,109` (`open`, `pbpaste`, `pbcopy`, `osascript` ×2, `find`) — `osascript … System Events` blocks on an unanswered Automation consent prompt.
  - `simulator-inventory.ts:80-87` (`simctl list -j` is bounded only when `request.booted === true`), `physical-inventory.ts:115-118` (`xctrace list devices`).
- Fix: give each a named bound from `core/config.ts` (or add a default bound in `runSimctlForDevice`/`runXcrun` that callers override). Files: the call sites above.
- Effort: M
- Model: sonnet
- Verify: a repo-guard style test over `packages/platform-apple/src` asserting every `runXcrun`/`runSimctlForDevice`/`runAppleToolCommand` call carries `timeoutMs`; `pnpm check:affected --run`.

### APPLE-7: Reading three keys from one `Info.plist` costs 3–6 `plutil` spawns, through a three-layer fallback chain
- Category: inefficient
- Severity: medium     Confidence: high
- Evidence:
  - `packages/platform-apple/src/core/bundle-info.ts:9-13` — `readIosBundleInfo` runs `readInfoPlistString` three times in parallel on the same file.
  - `core/plist.ts:9-53` — each call runs `plutil -convert json` (via `readApplePlistJson`), and when the key is absent or not a string (the normal case for `CFBundleDisplayName`) falls through to a second spawn, `plutil -extract <key> raw`, then to reading the file as XML. So one bundle costs 3 full conversions + 1–2 extracts.
  - `core/install-artifact.ts:74` calls it for every install; a multi-app IPA calls it once per bundle at `:206` and then again for the chosen bundle at `:74`.
  - The second and third layers are fallback paths ("for non-Darwin environments without plist tooling", `plist.ts:22,43`) that AGENTS.md permits only on explicit request; `parseApplePlist` (`plist.ts:67-74`) already parses both binary and XML plists in-process on any host.
- Fix: read the plist once (`parseApplePlist(readHostBinaryFile(path))` or one `readApplePlistJson`) and pick the three keys from the object; delete the `-extract` and XML layers. Files: `core/plist.ts`, `core/bundle-info.ts`, `core/perf-target.ts:58`.
- Effort: S
- Model: sonnet
- Verify: `core/__tests__` bundle-info/install-artifact tests asserting a single plist read per bundle.

### APPLE-8: Four implementations of "simulator app container → Info.plist", three of which bypass the `(null)` reader
- Category: inconsistent
- Severity: medium     Confidence: high
- Evidence:
  - `packages/platform-apple/src/core/simctl.ts:93-110` defines `readSimctlContainerPath` as "One reader for every caller that turns that stdout into a host path, so the sentinel cannot be mistaken for a directory at one site and handled at another".
  - Used by `core/local-simulator-files.ts:66,106` and `core/local-simulator-apps.ts:123` only.
  - Not used by `core/launch-diagnostics.ts:44` (`containerResult.stdout.trim()`), `core/perf-target.ts:138` (`result.stdout.trim()`), `logs/start.ts:190` (`container.stdout.trim()`); each then joins `Info.plist` onto the raw string, so a `(null)` answer becomes the path `(null)/Info.plist`.
  - The same three sites re-implement `get_app_container` + `plutil -extract CFBundleExecutable` (`launch-diagnostics.ts:35-55`, `logs/start.ts:181-201`, `perf-target.ts:118-147` + `:58`) instead of `simulatorApps.readInfoPlist` (`local-simulator-apps.ts:110-148`), which is mtime-memoized for 30 minutes and budget-aware.
- Fix: one `resolveSimulatorAppExecutable(device, bundleId, options)` built on `simulatorApps.readInfoPlist`; call it from all three. Files: `core/launch-diagnostics.ts`, `core/perf-target.ts`, `logs/start.ts`, `core/local-simulator-apps.ts`.
- Effort: M
- Model: sonnet
- Verify: unit tests feeding `(null)\n` stdout to each caller; `pnpm check:affected --run`.

### APPLE-9: Closing an app on a physical device costs three sequential `devicectl` spawns and cannot be cancelled
- Category: inefficient
- Severity: medium     Confidence: high
- Evidence: `packages/platform-apple/src/core/devicectl.ts:115-142` `terminateIosDeviceApp` → `resolveIosDeviceAppProcesses` (`:144-171`) runs `devicectl device info apps --include-all-apps` (every installed app, to find one bundle URL), then `devicectl device info processes`, then `devicectl device process terminate`, each through its own temp JSON file and each with the 20 s `IOS_DEVICECTL_TIMEOUT_MS`. No `signal` is threaded: `physical-device-control.ts:82` drops `options.runnerOptions`, as do `launchCoreDeviceApp` (`core/physical-device-coredevice.ts:27-44`) and `captureCoreDeviceScreenshot` (`core/physical-device-screenshot.ts:32-38`). A name-based close adds a fourth listing through `resolveIosApp` (`core/app-resolution.ts:63-66`). `open --relaunch` on a device pays all of it before the launch.
- Fix: cache the bundle id → bundle URL map per device (invalidate with `invalidateIosAppResolutionCache`), or use `--filter` on the apps listing; pass `runnerOptions.signal` to the three devicectl paths. Files: `core/devicectl.ts`, `core/physical-device-control.ts`, `core/physical-device-coredevice.ts`, `core/physical-device-screenshot.ts`.
- Effort: M
- Model: opus (physical-device behavior)
- Verify: `core/__tests__/devicectl*.test.ts` spawn-count assertion; physical-device `open --relaunch` timing.

### APPLE-10: Screenshot retry and fallback decisions match error text, including host-kit's own timeout message
- Category: inconsistent
- Severity: medium     Confidence: high
- Evidence:
  - `packages/platform-apple/src/core/screenshot.ts:454-465` — `shouldRetryIosSimulatorScreenshot` tests `appleToolFailureText(error)`, which concatenates `error.message`, stdout, stderr and argv (`core/tool-diagnostics.ts:31-39`). The clause `combined.includes('timed out') && combined.includes('screenshot')` matches the repo's own `"xcrun timed out after Nms"` message (`packages/host-kit/src/internal/exec.ts:662`) plus the argv word `screenshot`; `isCommandTimeoutError` exists for exactly this (`exec.ts:674-681`, used correctly in `core/app-launch.ts:186`).
  - Because argv is in the haystack, an output path or bundle id containing "screenshot" satisfies the second half of each clause.
  - Same pattern: `core/perf.ts:642-650` (`args.includes(' ps ') && message.includes('no such file')`), `core/physical-device-screenshot.ts:124-132`, `screenshot.ts:467-479`.
  - AGENTS.md: "Use typed reasons and details for behavior. Do not match error text."
- Fix: use `isCommandTimeoutError(error)` for the timeout clause; restrict the remaining tool-output matches to `details.stderr` (not message + argv). Files: `core/screenshot.ts`, `core/perf.ts`, `core/physical-device-screenshot.ts`, `core/tool-diagnostics.ts`.
- Effort: S
- Model: sonnet
- Verify: existing `core/__tests__/screenshot*.test.ts` plus a case where only argv contains "screenshot" and stderr is unrelated → no retry.

### APPLE-11: Every non-simulator device discovery runs `xcrun xctrace list devices`, unbounded
- Category: inefficient
- Severity: medium     Confidence: medium
- Evidence: `packages/platform-apple/src/inventory.ts:49-52` runs simulator and physical discovery in parallel; `physical-inventory.ts:66-69` always runs both `devicectl list devices` (8 s bound, `:88`) and `xctrace list devices` (`:115-118`, no `timeoutMs`). `xctrace list devices` launches Instruments' device service and is the slowest of the three listings; the discovery cannot return before it does. Its only contribution is XCTest-backend devices that `devicectl` did not report (`mergeAppleDevices`, `:70`). Confidence is medium because I did not measure it here and did not trace whether the daemon caches discovery results above this layer.
- Fix: bound it (same 8 s), and skip it when the request names a udid that `devicectl` already returned. Files: `physical-inventory.ts`.
- Effort: S
- Model: sonnet
- Verify: `__tests__/physical-inventory*.test.ts` asserting the request carries `timeoutMs`; `agent-device devices --platform ios` wall time before/after on a Mac.

### APPLE-12: Native-helper preparation is repeated per request: three toolchain spawns plus a binary SHA-256 before each scoped-simulator display read
- Category: inefficient
- Severity: medium     Confidence: medium
- Evidence:
  - `packages/platform-apple/src/foldable/fold-helper.ts:56-70` memoizes `ensureFoldHelperBinary` only inside one `createFoldHelper` instance; instances are per request (`foldable/orientation.ts:130`, `foldable/pose.ts:50`, `core/display-inventory.ts:167`).
  - `foldable/fold-helper-cache.ts:59-82` then, every time: reads and hashes `Fold.m`, runs `readHostToolchainIdentity` = `xcodebuild -version`, `sw_vers -productVersion`, `sw_vers -buildVersion` sequentially (`native-build/toolchain-identity.ts:38-40`), takes a file lock, and re-hashes the cached binary (`native-build/cache.ts:95-97`).
  - `core/screenshot.ts:178` calls `resolveCaptureTarget` on every simulator screenshot; for a device with a `simulatorSetPath` that is `readGuestPanelTable` (`core/display-inventory.ts:119-120,158-178`), so each screenshot on a scoped simulator pays the above before `simctl spawn`. The comment at `display-inventory.ts:162` assumes only "the first read on a host also builds the helper".
  - Also `fold-helper.ts:70`: `binary ??= ensureFoldHelperBinary({ signal })` caches a promise bound to the first caller's signal; a rejection stays cached for the helper's lifetime (bounded by the request today).
- Fix: process-level memo of the prepared binary keyed by source root (invalidate on failure), so toolchain identity is probed once per daemon lifetime. Files: `foldable/fold-helper-cache.ts`, `foldable/fold-helper.ts`.
- Effort: S
- Model: sonnet
- Verify: `foldable/__tests__/fold-helper-cache.test.ts` — two `createFoldHelper(...).readPanelPayload` calls spawn `xcodebuild -version` once.

### APPLE-13: URL-scheme owner lookup spawns `plutil` once per installed app, sequentially
- Category: inefficient
- Severity: low     Confidence: high
- Evidence: `packages/platform-apple/src/core/app-resolution.ts:216-221` loops over every app from `simctl listapps` (system apps included) and awaits `readInstalledAppUrlSchemes` → `readSimulatorAppInfoPlist` → `hostFileStat` + `plutil -convert json` (`core/local-simulator-apps.ts:126-139`) one at a time. A stock simulator lists roughly 60–80 apps, so a cold lookup is that many sequential spawns under the 10 s `URL_OWNER_LOOKUP_TIMEOUT_MS` (`launch-confirmation.ts:44`); `resolveIosSimulatorExpoDevClientScheme` (`app-resolution.ts:231-249`) triggers the loop from `open`. The 30-minute mtime memo (`local-simulator-apps.ts:105-108`) only helps later calls in the same daemon.
- Fix: parse in-process with `parseApplePlist` for the local provider (same change as APPLE-2/7), or read with bounded parallelism. Files: `core/local-simulator-apps.ts`, `core/app-resolution.ts`.
- Effort: S
- Model: sonnet
- Verify: `core/__tests__/app-resolution*.test.ts` spawn count for a 50-app listing.

### APPLE-14: Simulator launch retry declares 10 attempts but can never make more than 3
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence: `packages/platform-apple/src/core/app-launch.ts:306-315` — `maxAttempts: 10`, but `shouldRetry` returns false unless the error is the FBS error and `consecutiveFBSFailures < MAX_CONSECUTIVE_FBS_FAILURES` (3, `:273-274`). Only FBS errors are retried and the counter is never reset, so "consecutive" is "total" and attempts 4–10 are unreachable.
- Fix: set `maxAttempts: 3` and delete the counter. Files: `core/app-launch.ts`.
- Effort: S
- Model: sonnet
- Verify: existing `core/__tests__/app-launch*.test.ts`.

### APPLE-15: `ensureBootedSimulator` can run 2× past its deadline per attempt and re-lists after a successful `bootstatus`
- Category: broken
- Severity: low     Confidence: high
- Evidence: `packages/platform-apple/src/core/simulator.ts:111` computes `remainingMs` once and passes the same value as `timeoutMs` to both `simctl boot` (`:112-116`) and `simctl bootstatus -b` (`:131-138`), so one attempt may take `2 × remainingMs`. `:143` then spawns `simctl list devices -j` (documented at `:21` as ~0.7 s) although `bootstatus -b` exiting 0 already means booted; `readiness/runtime.ts:120-149` does not re-list.
- Fix: recompute the remaining budget before `bootstatus`; drop the re-list (or resolve with APPLE-5). Files: `core/simulator.ts`.
- Effort: S
- Model: sonnet
- Verify: `core/__tests__/simulator*.test.ts` with a fake deadline.

### APPLE-16: The xctrace device parser drops physical devices whose user-assigned name lacks "iPhone/iPad/Apple TV"
- Category: broken
- Severity: low     Confidence: medium
- Evidence: `packages/platform-apple/src/physical-inventory.ts:40-47` — `parseXctracePhysicalAppleDeviceLine` returns `undefined` when `resolveAppleTargetFromLabel(name)` is null; `inventory-classification.ts:64-68` only accepts names matching `iphone|ipad|ipod`, the vision pattern or a TV hint. `xctrace list devices` prints the user's device name, so a phone renamed "QA 12" is filtered out. The filter exists to drop the host Mac row. Affects only devices that `devicectl` does not report (the XCTest backend). Medium confidence: not reproduced on hardware.
- Fix: exclude the host row explicitly (it is the row whose id equals the host hardware UUID / is first under `== Devices ==`) and classify by the OS-version/identifier shape rather than by name. Files: `physical-inventory.ts`, `inventory-classification.ts`.
- Effort: M
- Model: opus (device identification)
- Verify: add a `QA 12 (16.7) (00008030-…)` line to the xctrace fixture test.

### APPLE-17: Per-simulator caches disagree on what identifies a simulator
- Category: inconsistent
- Severity: low     Confidence: medium
- Evidence: `packages/platform-apple/src/core/simctl.ts:8-23` states "Two devices name the same simulator only when both fields match" (udid + set path) and `core/local-simulator-files.ts:34-38` keys on `simulatorAddressFor`. Other caches key differently: `core/simulator.ts:30-32` uses the raw, untrimmed `device.simulatorSetPath`; `core/screenshot-status-bar.ts:209-211` uses `platform:kind:id`; `core/screenshot.ts:125-126,383,502` and `core/app-resolution.ts:23-25` use the udid alone. A copied simulator set reuses udids, so two sets can share status-bar override state, the runner-bundle cache and app-name resolutions. Medium confidence on real-world impact.
- Fix: one `simulatorCacheKey(device)` derived from `simulatorAddressFor`, used by all five. Files: those listed.
- Effort: S
- Model: sonnet
- Verify: unit test with two `DeviceInfo` sharing a udid and differing `simulatorSetPath`.

### APPLE-18: Small duplicated helpers and redundant calls
- Category: unneeded
- Severity: low     Confidence: high
- Evidence:
  - `mergeAppleDevices` defined twice with the same behavior: `inventory.ts:102-112` and `physical-inventory.ts:126-135`.
  - Deadline-to-timeout helper twice: `core/screenshot.ts:425-432` (`resolveDeadlineTimeoutMs`) and `core/physical-device-files.ts:53-60` (`resolveCopyTimeoutMs`), same error shape.
  - "runner returned no file path" check twice: `core/screenshot.ts:347-353` (via an unchecked `as string`) and `core/physical-device-screenshot.ts:100-107`.
  - `readiness/runtime.ts:50,54` calls `keepHot(device)` twice on the cold-boot path.
  - `deployment/runtime.ts:144` + `:212` (uninstall) and `:111` + `:118` (reinstall) call `ensureAppleReady` twice per operation; on a physical device each is an `ensureConnected` round trip.
  - `core/app-settings.ts:72` and `:300` both call `ensureBootedSimulator` for `clear-app-state`.
  - `core/physical-device-coredevice.ts:25` and `:333` define two 10 s constants for the same `devicectl device info details` read, and `readIosDeviceDetails` (`:170`) silently clamps a caller's readiness budget to the first.
- Fix: keep one of each; drop the inner readiness calls. Files as listed.
- Effort: S
- Model: sonnet
- Verify: `pnpm check:affected --run`.
