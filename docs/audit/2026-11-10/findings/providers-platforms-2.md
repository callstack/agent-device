# PROV2 slice audit: provider-limrun, provider-revyl, provider-webdriver, platform-web, platform-harmonyos (second pass)

## Coverage

This pass covers what the first report (`providers-platforms.md`) listed as not reached. Nothing was executed. Production source in the five packages is about 17k lines; with the first pass, about 85% of it has now been read line by line. Tests were spot-checked only (about 5% of 30k test lines).

Read fully in this pass:
- `provider-webdriver/src`: `webdriver-interactor.ts`, `platform-runtime.ts`, `webdriver-source.ts`, `capabilities.ts`, `lifecycle.ts`, `runtime.ts`, `webdriver-scroll-frame.ts`
- `provider-revyl/src`: `interactor.ts`, `interaction-operations.ts`, `snapshot.ts`, `platform-runtime.ts`, `lifecycle.ts`, `runtime.ts`, `facts-runtime.ts`
- `provider-limrun/src`: `lease-release.ts`, `ios.ts`, `network-har.ts`, `capture-lifecycle.ts`, `app-log-runtime.ts`, `app-log-reconnect.ts`, `facts-runtime.ts`, `interaction-operations.ts`, `runtime-dependencies.ts`, `connection-verification.ts`, `session-allocation.ts`, `recording-runtime.ts`, `app-catalog.ts`, `sync-cache.ts`, `client-options.ts`, `lifecycle-budget.ts`, `request-cancellation.ts`, `lifecycle.ts`, `deployment-runtime.ts`, `app-state-read.ts`, `android-text-entry.ts`, `android-perf-runtime.ts`, `android.ts` (240-362)
- `platform-web/src`: `agent-browser-snapshot.ts`, `agent-browser-process-record.ts`, `agent-browser-audio-probe.ts`, `runtime.ts`, `recording/runtime.ts`, `interactor.ts`, `provider.ts`
- `platform-harmonyos/src`: `recording/runtime.ts`, `recording/recovery.ts`, `logs/runtime.ts`, `logs/descriptor.ts`, `deployment/runtime.ts`, `inventory.ts`, `perf.ts`, `perf/runtime.ts`, `app-state.ts`, `doctor.ts`, `runtime.ts`

Read partially: `webdriver-orientation.ts` (head), `agent-browser-select-content.ts` (head), `agent-browser-fleet.ts` (head), `agent-browser-provider.ts` (555-600).

Still not reached:
- Limrun: `lease-ownership.ts`, `android.ts` (1-60), `device.ts`, `app-log-descriptor.ts`, `runtime.ts` (1-160, 720-976)
- Revyl: `connection.ts`, `device.ts`, `session-allocation.ts`, `session-identity.ts`, `credentials.ts`, plugin files
- WebDriver: both `*-connection-verification.ts`, `browserstack-device-features.ts`, `aws-device-farm-connection.ts`, `provider-plugin.ts`
- platform-web: `agent-browser-provider.ts` (1-440, 730-893), `doctor.ts`, `resolve-provider.ts`
- HarmonyOS: `app-lifecycle.ts` and `snapshot.ts` bodies
- Almost all test files. Only these were opened: `provider-limrun/src/device.test.ts`, `provider-webdriver/src/runtime.test.ts`, three `*-profile-fields.test.ts`, parts of `webdriver-interactor.test.ts`, `webdriver-interactor-mutation-resend.test.ts`, `platform-harmonyos/src/recording/runtime.test.ts`, `__tests__/doctor.test.ts`.

Checked and dropped (not findings):
- Limrun repeat allocation overwriting a working capture: `runtime.ts:390` guards on `phase !== 'capturing'`.
- Limrun default HAR selectors covering only six TLDs: documented in `website/docs/docs/limrun.md:193`.
- Revyl interactor `type` / `setOrientation` / `setSetting` throwing stubs: the `Interactor` contract requires those members, and `admittedOperations` drops them from the binding.
- HarmonyOS deployment calling bare `hdc`: `ensureHarmonyToolchainPathConfigured` amends `PATH` first.
- HarmonyOS recording leaving staged files after a failed finish: the live handle's `forceCleanup` removes them (covered by `runtime.test.ts:158,209`).

Findings 1, 2 and 3 rest on Appium driver and HarmonyOS recorder behaviour that I could not run; each says what the in-repo evidence is.

## Findings

### PROV2-1: WebDriver `home` and `appSwitcher` send `mobile: pressButton` to Android, which UiAutomator2 does not have
- Category: broken
- Severity: medium     Confidence: high (Android `home`), medium (`appSwitch` name on iOS)
- Evidence: `packages/provider-webdriver/src/webdriver-interactor.ts:376-379,386-389` send `mobile: pressButton {name:'home'}` / `{name:'appSwitch'}` with no backend split. The same file states at `:392-396` that "UiAutomator2 registers no pressButton at all", which is why volume and power go through `pressAndroidHardwareKey` (`:427-433`). `capabilities.ts:109-120` marks `home` and `appSwitcher` `partial` for both platforms, so `platform-runtime.ts:628-629` admits them on Android. The only test (`webdriver-interactor-mutation-resend.test.ts:152-156`) checks the resend policy, not the backend route. XCUITest's documented `pressButton` names are `home`, `volumeup`, `volumedown`; `appSwitch` is not one of them, so the iOS leg is doubtful too.
- Fix: on Android press `KEYCODE_HOME` and `KEYCODE_APP_SWITCH` through `pressAndroidHardwareKey` (the `HardwareButton` → keyevent table already exists); for iOS `appSwitcher`, either verify the button name on a real session or declare it `unsupported` in the iOS map. Touches `webdriver-interactor.ts`, `capabilities.ts`, `webdriver-interactor-hardware-button.test.ts`.
- Effort: S
- Model: opus
- Verify: unit test pinning `mobile: pressKey [{"keycode":3}]` for Android `home`; then `agent-device home` and `app-switcher` against a BrowserStack Android and iOS session per `docs/agents/device-verification.md`.

### PROV2-2: HarmonyOS recorder stop is the same toggle as start, and cleanup sends it without knowing the recorder is running
- Category: broken
- Severity: medium     Confidence: medium
- Evidence: the host's `stop` is the same `aa start -b com.huawei.hmos.screenrecorder -a …ServiceExtAbility` command as `start` minus the file name (`src/platform-runtime-screen-recording-harmony-host.ts:7-34`), and `packages/platform-harmonyos/src/recording/runtime.ts:182` calls it "One `aa start` toggle". In `startHarmonyRecording`, when `harmony.start` rejects after the signal aborted (`runtime.ts:92-96`), `cleanupLiveHarmonyDescriptor` runs its default `stopRecorder` (`:262-265`) and sends the toggle although the start may never have reached the device, which would start a recording nobody owns. `runtime.test.ts:256-272` covers this path and asserts only the rejection reason. The same applies to a `stop` that timed out after landing: `recorderStopped` stays false (`:108-113`), so `forceCleanup` toggles again. `recovery.ts:66-71` already refuses to stop after a daemon restart for this reason. Not reproduced on a device.
- Fix: send the stop toggle only when a start result was observed as successful; when the start outcome is unknown, return `cleanup-pending` and remove only the staging file and media item. Record an attempted-but-unconfirmed stop so a second cleanup does not toggle again. Touches `recording/runtime.ts`, `recording/runtime.test.ts`.
- Effort: M
- Model: opus
- Verify: extend `runtime.test.ts:256`: a rejected start after abort must not call `stop`; then a device run that cancels `record start` mid-flight and checks no recording is left running.

### PROV2-3: WebDriver `openDevice` sends `mobile: activateApp` with an empty argument object
- Category: broken
- Severity: medium     Confidence: medium
- Evidence: `packages/provider-webdriver/src/webdriver-interactor.ts:144-146` runs `executeScript('mobile: activateApp', [{}])`. Both Appium drivers require the app id for this extension (`bundleId` on XCUITest, `appId` on UiAutomator2); the client's own `activateApp` passes one (`webdriver-client.ts:114-115`). `openDevice` is what `open` with no app target calls (`packages/contracts/src/application-lifecycle-interaction.ts:192`). Revyl and Limrun iOS implement the same member as a no-op because a rented device has nothing to raise (`provider-revyl/src/interactor.ts:84`, `provider-limrun/src/ios.ts:247`). The only test is the resend-policy row at `webdriver-interactor-mutation-resend.test.ts:147`. Related: `open(app, {url})` at `:136` sends `{url, package: app}` on both backends, but XCUITest's deep-link extension reads `bundleId`, so the target app is dropped on iOS.
- Fix: make `openDevice` a no-op like the other provider-owned interactors, and send `bundleId` instead of `package` for the iOS deep link. Touches `webdriver-interactor.ts` and its tests.
- Effort: S
- Model: opus
- Verify: unit test that `openDevice()` sends no request and that an iOS deep link carries `bundleId`; then `agent-device open` with no app against a hosted session.

### PROV2-4: Every WebDriver scroll reads and parses the whole page source first, with no timeout and no cancellation
- Category: inefficient
- Severity: medium     Confidence: high
- Evidence: `packages/provider-webdriver/src/webdriver-interactor.ts:232-239` runs `hideKeyboard()` and then `scrollGestureFrame()` before each swipe; `:673-684` calls `this.client.source()` with no signal and no bounded timeout, then parses the full XML into nodes (`webdriver-scroll-frame.ts:4-25`) only to pick the largest scroll view. The same file documents the source read as the one call that hangs on busy screens and queues every later command behind it (`:289-292`, `:743-751`, issue #2509), and gives snapshot's read a signal for that reason. `gestureViewport()` (`:264-266`) takes the same path. A `scroll` therefore costs three round trips plus a full tree walk, and a scroll on a never-idle screen waits the transport's default timeout before it falls back to `windowRect`.
- Fix: pass the command signal and a short probe timeout to the scroll-frame source read (as `readAndroidSnapshotViewport` does at `:332-344`), and fall back to `windowRect` on timeout; consider caching the frame per interactor until the next snapshot. Touches `webdriver-interactor.ts`, `webdriver-interactor.test.ts`.
- Effort: M
- Model: opus
- Verify: unit test where `source()` never resolves: `scroll` still issues its swipe from `windowRect` within the probe budget.

### PROV2-5: Recording the managed browser fleet runs two synchronous `ps` spawns per process
- Category: inefficient
- Severity: medium     Confidence: high
- Evidence: `packages/platform-web/src/agent-browser-process-record.ts:101-107` calls `readProcessStartTime(pid)` and `readProcessCommand(pid)` for every fleet process; both are `runCmdSync(ps -p <pid> -o <field>)` (`packages/host-kit/src/internal/host-process.ts:144-150,282-294`). A Chrome fleet is typically 10-20 processes, so one record refresh blocks the daemon event loop for 20-40 sequential process spawns. The function already holds each process's command from `listHostProcesses` (`:87`), and the batched async `readHostProcessIdentityObservationsAsync` is used 40 lines later in the same file (`:149`). It runs from `finalizeAgentBrowserProcessRecord` after web commands (`agent-browser-provider.ts:584-586`).
- Fix: read start times with one `readHostProcessIdentityObservationsAsync(pids)` call and reuse `processInfo.command`. Touches `agent-browser-process-record.ts`, `__tests__/agent-browser-process-record.test.ts`.
- Effort: S
- Model: sonnet
- Verify: test that a refresh over N processes performs one identity probe and no `runCmdSync` call.

### PROV2-6: HarmonyOS admits `perf frames` and `perf memory snapshot`, and both operations only ever answer "unavailable"
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence: `packages/platform-harmonyos/src/runtime.ts:286-292` sets `frames` and `memorySnapshot` to the available cell on emulators and devices. `perf/runtime.ts:22,35-55` implements `perfFrames` as a constant `{available: false, reason: 'Dropped-frame sampling is currently available only on Android… and connected iOS…'}` and `perfMemorySnapshot` as a constant unavailable artifact. The facts therefore advertise two capabilities the owner cannot serve; other owners refuse these at the fact (for example `provider-revyl/src/facts-runtime.ts:187-193`, `platform-web/src/runtime.ts:411-417`).
- Fix: mark `frames` and `memorySnapshot` unavailable in the facts with those reasons, and bind only `perfMemorySample`. Touches `runtime.ts`, `perf/runtime.ts`, `perf/runtime.test.ts`, `runtime.test.ts`. Check the owning perf help text.
- Effort: S
- Model: sonnet
- Verify: `runtime.test.ts` asserts `perfFrames.available === false` on a HarmonyOS device; `pnpm check:affected --run`.

### PROV2-7: Refusal messages borrowed from unrelated cells in four runtimes
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence: each of these gives the caller a reason for a different feature.
  - `provider-webdriver/src/platform-runtime.ts:531` `perf: audioProbeUnavailable` → `perf` is refused with "does not expose the audio probe" (`:280-283`).
  - `provider-limrun/src/facts-runtime.ts:180-186` → iOS `perf` cells use `elementTextUnavailable`, "Read element text from the captured snapshot." (`:41-44`).
  - `provider-limrun/src/facts-runtime.ts:162-165` → Android `findText`/`querySelector` use `customSnapshotUnavailable`, "Custom snapshot actions are available only for Limrun iOS simulator sessions."
  - `platform-web/src/runtime.ts:369-372` → `findText`/`querySelector` always use `openTargetKindUnavailable`, "open is supported only for web browser devices.", including on a browser device.
  - `platform-harmonyos/src/runtime.ts:218-221` → `findText`/`querySelector` always use `snapshotKindUnavailable`, "snapshot is supported only for HarmonyOS emulators and devices.", including on those devices.
- Fix: give each cell its own `unavailableFact` (Revyl's `perfUnavailable` and `elementTextUnavailable` at `facts-runtime.ts:104,70` are the model). Touches the four files above and their fact tests.
- Effort: S
- Model: sonnet
- Verify: fact tests asserting the hint text for `perfFrames` and `findText` per owner.

### PROV2-8: Web snapshot value parsing reads inside quoted names
- Category: broken
- Severity: low     Confidence: high
- Evidence: `packages/platform-web/src/agent-browser-snapshot.ts:542-559`. `extractTrailingAriaValue` applies `/\]\s*:\s*(.+)$/` to the raw line, so `link "[1]: Introduction" [ref=e3]` yields value `Introduction" [ref=e3]`; the `value=` / `value:` patterns likewise match inside a name such as `button "Set value=3"`. Ref extraction in the same file strips quoted text first for exactly this reason (`stripQuotedText`, `:501-509`), and `isLineMarkedDisabled` reads only the annotation. The wrong value then feeds `isTextAlreadyReported` (`:399`) and every text selector that reads `value`.
- Fix: run the value patterns against `stripQuotedText(line)` for position, or match the trailing value only after the `[ref=…]` annotation. Touches `agent-browser-snapshot.ts`, `__tests__/agent-browser-snapshot.test.ts`.
- Effort: S
- Model: sonnet
- Verify: new cases in `agent-browser-snapshot.test.ts` for the two lines above expecting `value` undefined.

### PROV2-9: Managed-fleet daemon matching claims any non-Chrome process whose command line mentions the install directory
- Category: broken
- Severity: low     Confidence: medium
- Evidence: `packages/platform-web/src/agent-browser-process-record.ts:254-264` returns `agent-browser-daemon` for every non-Chrome process whose command contains `<installDir>/`. `recordManagedAgentBrowserProcesses` then expands each match's process tree and writes all of it to the owned-process store (`:89-108`), which is what the reaper signals. A user's `tail`, `grep`, editor, or a `pnpm` run pointed at a file under the managed install matches. The Chrome branch requires a launch marker or browser-home path as a second condition (`:239-252`); the daemon branch has none.
- Fix: require the command's executable or script entry (first or second argv word) to resolve under the install root, not any substring. Touches `agent-browser-process-record.ts` and its test.
- Effort: S
- Model: opus
- Verify: test that `vim <installDir>/package.json` is not matched and the real backend entry is.

### PROV2-10: WebDriver iOS `keyboard enter` branch is unreachable while the capability note advertises it
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence: `packages/provider-webdriver/src/platform-runtime.ts:604-611` admits `enter` on Android only ("has not run against [XCUITest], so an iOS device refuses until it has"). The interactor still carries the iOS newline branch and its `visibility-echo` result (`webdriver-interactor.ts:517-524`), and `capabilities.ts:104-107` tells users that enter "types a newline into the focused iOS field". No test drives the iOS branch (`grep visibility-echo` finds no test in the package).
- Fix: remove the iOS branch and the clause in the capability note until the route is verified, or verify it on a device and admit it. Touches `webdriver-interactor.ts`, `capabilities.ts`.
- Effort: S
- Model: sonnet
- Verify: `pnpm check:affected --run`; `platform-runtime.test.ts` keyboard cases.

### PROV2-11: HarmonyOS deployment carries a second copy of the launch-target logic
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence: `packages/platform-harmonyos/src/deployment/runtime.ts:98-148` re-implements `bm dump -n` → `mainElementName` → `aa start -b -m -a` with its own `parseLaunchTarget` and its own `runHdc`/`runHdcShell` wrappers (`:150-178`). `app-lifecycle.ts:64-70,160,224` owns the same parse and launch through `runHarmonyShell`. The two copies already differ in how they run hdc (`host.commands.run` with bare `hdc` versus `runCmd` in `hdc.ts`) and in error wording.
- Fix: have the post-install relaunch call the lifecycle owner's open, and delete the copy. Touches `deployment/runtime.ts`, `app-lifecycle.ts`, `deployment/runtime.test.ts`.
- Effort: S
- Model: sonnet
- Verify: `deployment/runtime.test.ts`; a device `install --replace` run.

### PROV2-12: HarmonyOS recording finish copies the media at least twice and throws untyped errors
- Category: inefficient
- Severity: low     Confidence: high
- Evidence: `packages/platform-harmonyos/src/recording/runtime.ts:233-256`. Each attempt removes the staged file, runs `mediatool recv` for the whole recording, and stats it; success needs two consecutive equal sizes, so every recording is copied on-device at least twice and costs six `hdc` spawns plus a sleep, up to 40 attempts. Stability could be read from the source (stat or `mediatool query`) before one copy. Failures on this path are bare `Error`s with no code or reason (`:150,153,162,313`), against the typed-reason rule in `AGENTS.md`.
- Fix: poll the media item's size until stable, then stage once; raise `AppError('COMMAND_FAILED', …, { reason })`. Touches `recording/runtime.ts`, the host adapter, `runtime.test.ts`.
- Effort: M
- Model: opus
- Verify: `runtime.test.ts:158` adjusted to expect one `stageMedia` call on the happy path; a device recording run.

### PROV2-13: Dead parameters and fields
- Category: unneeded
- Severity: low     Confidence: high
- Evidence: a repo-wide grep finds no caller that passes these.
  - `provider-revyl/src/interaction-operations.ts:131,162-165,194`: the `liveSession?` parameter of `revylInteractionOperationFacts`, `revylNavigationOperationFacts`, `revylUnsupportedOperationFacts`. All callers pass nothing (`facts-runtime.ts:179-182`, `interaction-operations.ts:257`); the not-live path uses `revylUnavailableCells` instead. The whole `if (liveSession)` block at `:166-176` and every `liveSession ??` is dead.
  - `provider-limrun/src/interaction-operations.ts:177-181`: `limrunAndroidSettingsFacts(liveSessionUnavailable?)`, called with no argument (`facts-runtime.ts:175`).
  - `provider-limrun/src/ios.ts:43`: `LimrunIosRemoteInstallOptions.md5`, never read (the comment at `:147` explains the digest is deliberately not used).
  - `provider-webdriver/src/platform-runtime.ts:119`: `const inactiveSession = webDriverInactiveSession` alias used once.
- Fix: delete the parameters, the dead branches, the field and the alias.
- Effort: S
- Model: sonnet
- Verify: `pnpm typecheck` (or `pnpm check:affected --run`).

### PROV2-14: Limrun's platform runtime owner is still named and worded as an app-log owner
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence: `packages/provider-limrun/src/app-log-runtime.ts` binds every operation of the Limrun runtime (lifecycle, interaction, deployment, recording, perf; `:193-251`), yet the file, `bindLimrunAppLogs` (`:138`), `limrunAppLogFacts` (`facts-runtime.ts:131`) and `isSupportedLimrunAppLogDevice` keep the app-log name. The user-visible refusals follow: a bind for any command on an unsupported device answers "Limrun app logs require an iOS simulator or Android emulator device identity" (`:112-115`), and an owner mismatch says "Limrun app-log owner identity does not match" (`:109`). Revyl and WebDriver name the same module `platform-runtime.ts` and word the same refusals for the runtime (`provider-revyl/src/platform-runtime.ts:56-62`).
- Fix: rename to `platform-runtime.ts` / `bindLimrunRuntime` / `limrunFacts` / `isSupportedLimrunRuntimeDevice` (one already exists in `runtime-device.ts`) and reword the two messages. Move the Fallow baseline entry with the rename.
- Effort: S
- Model: sonnet
- Verify: `pnpm check:affected --run`.

### PROV2-15: Migration-history comments in the runtime fact tables
- Category: unneeded
- Severity: low     Confidence: high
- Evidence: 19 non-test comment lines in the slice describe retired code rather than a constraint, against the `AGENTS.md` comment rule. Examples: `provider-webdriver/src/platform-runtime.ts:616-620` ("R55 cell delta, deliberate: the retired `supportsHostOrSimulatorSurface` closure…") and `:657-661` ("R59 cell delta…"); `platform-web/src/runtime.ts:90-92,388-391,405-409` (retired `WEB_SUPPORTED_COMMANDS`, `WEB_INTERACTION_COMMANDS`, `WEB_QUERY_COMMANDS`); `platform-harmonyos/src/runtime.ts:143-145,170-171,227-228` ("the retired admission", "the retired leaf", "the legacy dispatch"). None of the named symbols exists in production code any more (grep finds them only in comments and tests).
- Fix: delete the history; keep the one-line statement of what the cell is where it adds something.
- Effort: S
- Model: sonnet
- Verify: `grep -rn "retired\|cell delta\|legacy dispatch"` over the five packages' non-test source returns nothing.

### PROV2-16: Tests that cannot fail for the reason they name
- Category: broken
- Severity: low     Confidence: high
- Evidence:
  - `provider-limrun/src/device.test.ts:4-8` is the only test file for `device.ts` (119 lines) and asserts that a pure function returns the same value twice.
  - `platform-harmonyos/src/recording/runtime.test.ts:16-33` ("runs whole-screen capture and finalizes…") asserts only that `finish()` does not reject; no host call is checked.
  - `platform-harmonyos/src/recording/runtime.test.ts:256-272` passes whether or not cleanup sends the stop toggle (see PROV2-2).
  - `provider-webdriver/src/webdriver-interactor.test.ts:195` and `webdriver-interactor-mutation-resend.test.ts:237,248,261` use `assert.rejects(…, () => true)`, which accepts any error, including a test-world bug.
- Fix: assert the argv or host calls and the error code or reason in each. Follow `docs/agents/test-authoring.md`.
- Effort: S
- Model: sonnet
- Verify: mutate the production line each test names and confirm the test fails.
