# Audit report: SLICE CONTR3 (third pass, `packages/contracts/src` production files only)

## Coverage

This pass read what CONTR and CONTR2 listed as "not reached". It repeats none of CONTR-1..19 or CONTR2-1..16.

- Read fully, line by line (about 8,400 lines): `platform-runtime-operations.ts`, `interaction-guarantees.ts`, `tap-keyboard-occlusion.ts`, `touch-runtime.ts`, `snapshot-diagnostics.ts`, `snapshot-producers.ts`, `snapshot-runtime.ts`, `snapshot-capture-annotations.ts`, `replay.ts`, `replay-backend.ts`, `replay-divergence.ts`, `client-replay.ts`, `replay-request-fields.ts`, `settings.ts`, `settings-catalog.ts`, `settings-runtime.ts`, `client-settings.ts`, `platform-runtime.ts`, `platform-runtime-unavailable.ts`, `runtime-operation-names.ts`, `interactor-operation-catalog.ts`, `interactor-types.ts`, `interaction.ts`, `click-button.ts`.
- Read code-only, comment blocks skipped (about 3,200 lines): `screenshot.ts`, `screenshot-runtime.ts`, `device-rotation.ts`, `android-input-ownership.ts`, `alert-contract.ts`, `application-lifecycle-interaction.ts`, `keyboard-runtime.ts`, `system-button-runtime.ts`, `tv-remote.ts`, `tv-remote-runtime.ts`, `wait.ts`, `telephony-input.ts`, `navigation.ts`, `input-validation.ts`, `interactor-operation-binding.ts`, `local-interactor-operation-set.ts`, `gesture-runtime.ts`, `scroll-runtime.ts`.
- Total for this pass: about 45% of the 25.9k production lines. With the two earlier passes, about 60% of the package is now read.
- Every field, export and vocabulary reported below was checked with a whole-repo `git grep` (TS, Swift, Kotlin, fixtures, `.fallowrc.json`, scripts, website docs).
- Not reached: `lease-scope.ts` (beyond CONTR's regions), `backend.ts` (beyond CONTR's regions), `gesture-input.ts` (below the top), `application-lifecycle-runtime.ts`, `daemon-command-surface.ts`, all `client-*.ts` except replay and settings, `ios-snapshot.ts`, `ios-system-surface.ts`, `perf*.ts`, `screen-recording*.ts`, `audio-*.ts`, `app-log-runtime.ts`, `network-runtime*.ts`, `clipboard-runtime.ts`, `alert-runtime.ts`, `scroll-command.ts`, `cli-flags.ts`, `remote-config-fields.ts`, `metro.ts`, `cloud-artifacts.ts`, `artifact-adapter.ts`, `durable-resource*.ts`, `device-inventory.ts`, `plugin-inventory.ts`, `platform-module.ts`, `platform-runtime-host.ts`, the `facades/`. No test file was read.
- Clean results: `RUNTIME_OPERATION_NAMES`, the unavailable-cell table, the producer registry and the hardware-button label tables are all pinned by `Record<>`/`satisfies` proofs or a test, and showed no drift. Every `SnapshotProducerFacts` field has a consumer. Every `ReplayDispatchOptions` key and `ReplayRefPublicationResult` reason has a producer. The git history is squashed to one commit, so no finding relies on dates.

## Findings

### CONTR3-1: `open --relaunch` is silently dropped by the shared direct lifecycle binding (Linux, web, HarmonyOS, Vega)
- Category: broken
- Severity: medium     Confidence: medium
- Evidence:
  - `packages/contracts/src/application-lifecycle-interaction.ts:311-346` (`openDirectApplication`) closes before opening only when `params.closeBeforeRelaunch` is set (`:317`). It calls `invokeApplicationOpen` at `:324-330` without `terminateRunningApp`, although that function accepts and forwards it (`:154`, `:228`, `:255`).
  - `bindLocalDirectApplicationLifecycle` (`:396-414`) never sets `closeBeforeRelaunch`. It is the lifecycle of `packages/platform-linux/src/runtime.ts:146`, `platform-web/src/runtime.ts:313`, `platform-harmonyos/src/runtime.ts:365` and `platform-vega/src/runtime.ts:67`.
  - The daemon passes `relaunch: shouldRelaunch` to the owner (`packages/daemon/src/sessions/session-lifecycle/internal/session-open-execution.ts:291`). The only pre-check, `validateOpenRelaunchTarget` (`src/platform-runtime-open-target.ts:90-110`), refuses URL targets, non-app surfaces and Android binaries, nothing per platform.
  - `git grep relaunch` in those four platform packages returns nothing. The request therefore returns success after a plain `open`, with the running app left as it was.
  - Not verified: whether any of the four `interactor.open` implementations restarts a running app on its own. If one does, that owner is unaffected.
- Fix: in `openDirectApplication`, either pass `terminateRunningApp: input.relaunch` to `invokeApplicationOpen`, or make `closeBeforeRelaunch` a required field of `DirectApplicationLifecycleParams` so each owner states its choice. An owner that cannot relaunch must refuse with a typed reason. Files: `application-lifecycle-interaction.ts`, the four `runtime.ts` callers.
- Effort: S-M
- Model: opus (device behavior on four owners)
- Verify: new case in `packages/contracts/src/application-lifecycle-interaction.test.ts` asserting a `relaunch: true` input either closes first or reaches `interactor.open` with `terminateRunningApp: true`; one device run of `open <app> --relaunch` on Linux or web.

### CONTR3-2: Serialized-summary readers accept values the types forbid, and `mergeSnapshotDiagnostics` allocates from an unvalidated `count`
- Category: broken (validator weaker than type)
- Severity: medium     Confidence: medium
- Evidence:
  - `packages/contracts/src/snapshot-diagnostics.ts:207-225` accepts any `typeof === 'number'` for `count`, `p50Ms`, `p95Ms`, `maxMs`, `slowThresholdMs`: NaN, negatives, fractions and Infinity pass. `:237-240` casts any string to `PublicPlatform`.
  - `samplesFromStats` (`:244-260`) then runs `Array.from({ length: stats.count - 3 }, ...)`. `count: Infinity` throws `RangeError: Invalid array length`; `count: 1e9` allocates a billion objects.
  - The reader's input is a daemon response: `packages/replay-port/src/daemon-port/session-test-outcome.ts:67` and `packages/client/src/index.ts:587`. The merge runs on it at `packages/replay-test/src/internal/session-test.ts:485`. With a remote daemon that response is another host's data.
  - Same class in `packages/contracts/src/snapshot-capture-annotations.ts:134-140`: `readTargetActivation` checks only `typeof reason === 'string'` and `typeof priorState === 'string'`, then casts the whole object to `IosTargetActivation`. Kernel declares closed vocabularies and calls `isIosTargetActivationReason` "the only gate consumers apply to the field" (`packages/kernel/src/snapshot.ts:581-589`). The same file validates the quality verdict against `DECLARED_STATES`/`DECLARED_BACKENDS` (`:16-26`, `:148-155`), so the two readers disagree on strictness. `readObject` (`:164-168`) also passes arrays as `AndroidSnapshotBackendMetadata` (`:94`, `:107`).
- Fix: require `Number.isSafeInteger(count) && count >= 0` and finite non-negative durations in `readRequiredSnapshotTimingStats`; check `platform` against the public platform list. Compute the merged stats without materializing `count` samples (weighted nearest-rank over at most three values per run). Add `DECLARED_*` tables for activation reason and prior state, as the file already does for quality.
- Effort: S
- Model: sonnet
- Verify: cases in `packages/contracts/src/snapshot-diagnostics.test.ts` (`count: Infinity`, `count: 2.5`, `platform: 'bogus'` are all rejected) and `snapshot-capture-annotations.test.ts` (`reason: 'bogus'` is dropped).

### CONTR3-3: One invariant violation ("fact admitted, interactor member missing") has three error shapes
- Category: inconsistent
- Severity: medium     Confidence: high
- Evidence:
  - `packages/contracts/src/interactor-operation-binding.ts:25-35` (`requireInteractorMethod`): `COMMAND_FAILED`, `reason: 'interactor-method-missing'`. Used by keyboard, system-button, settings read, tv-remote.
  - `packages/contracts/src/touch-runtime.ts:152-157` and `:219-224` (`missingAdvertisedOperation`): `UNSUPPORTED_OPERATION`, no `reason`. Used by hover, `tapRef`, `hoverRef`, `fillRef`, `tapElementSelector`.
  - `packages/contracts/src/gesture-runtime.ts:127-131`, `:149-153` and `packages/contracts/src/platform-runtime.ts:418-421`: `invalidRuntimeContract(...)`.
  - A caller cannot branch on one typed reason for an owner bug, and the touch variant reports an owner bug as an unsupported command with no reason. AGENTS.md requires typed reasons.
- Fix: route the touch and gesture sites through `requireInteractorMethod` (or all three through `invalidRuntimeContract`); delete `missingAdvertisedOperation`.
- Effort: S
- Model: sonnet
- Verify: `git grep -n "advertised .* without an interactor" packages/contracts/src` is empty; `pnpm vitest run packages/contracts/src/touch-runtime.test.ts packages/contracts/src/gesture-runtime.test.ts`.

### CONTR3-4: `MAESTRO_NON_HITTABLE_FALLBACK_MESSAGE` has no consumer and is kept alive by a fallow allowlist entry
- Category: unneeded
- Severity: low     Confidence: high
- Evidence: `packages/contracts/src/interactor-types.ts:112-117` ("Legacy success text retained for compatibility"). The only other reference in the repo is the ignore entry `.fallowrc.json:206-210`, whose comment says it "has no in-repo production consumer". The Swift runner hardcodes its own literal (`apple/runner/.../RunnerTests+CommandExecution.swift:117,151`), and the structured signal is `maestroNonHittableCoordinateFallbackUsed`. No test reads the constant.
- Fix: delete the constant and the `.fallowrc.json` entry.
- Effort: S
- Model: sonnet
- Verify: `git grep -n MAESTRO_NON_HITTABLE_FALLBACK_MESSAGE` is empty; `pnpm exec fallow` reports no new finding.

### CONTR3-5: The retired `--update` replay flag is still typed, parsed and sent on the wire, and nothing reads it
- Category: unneeded (superseded compat path)
- Severity: low     Confidence: medium
- Evidence: `packages/contracts/src/replay-request-fields.ts:13` (`replayUpdate`), `packages/contracts/src/client-replay.ts:13-18` (`ReplayRunOptions.update`, `@deprecated ... Accepted for backward compatibility`) and `:56` (`ReplayTestOptions.update`, same field with no deprecation mark). Whole-repo grep for `replayUpdate`: the flag definition, `command-surface/src/replay/index.ts:212,230,252,280` (copy in, copy out), and one reader, `src/cli/commands/replay.ts:87`, which only rejects it on `replay export`. No daemon, replay-port or ad-replay code reads it. `scripts/integration-progress-model.ts:189` calls it "retired --update no-op".
- Fix: remove `update`/`replayUpdate` from both option types, `ReplayRequestFields`, the flag definition and the projections, unless the maintainers want the no-op kept. AGENTS.md allows compat paths only on explicit request. If kept, mark `ReplayTestOptions.update` deprecated like its sibling and stop sending it to the daemon.
- Effort: S
- Model: sonnet
- Verify: `git grep -n replayUpdate` is empty; `pnpm tsc -b`; `pnpm vitest run packages/command-surface packages/command-registry`.

### CONTR3-6: The `.ad` screenshot flag codec lives in contracts and is split with ad-script
- Category: inconsistent (owner logic in contracts)
- Severity: low     Confidence: high
- Evidence: `packages/contracts/src/screenshot.ts:223-253` and `:376-489` hold the script writer (`appendScreenshotScriptFlags`) and reader (`readScreenshotScriptFlag`), whose only callers are `packages/ad-script/src/internal/script-utils.ts:366` and `script.ts:465`. The two halves do not match: the reader parses `--crop-on` (`:247-253`, `:475-489`), the writer does not emit it (`:376-393`), and ad-script writes it itself (`script-utils.ts:364`). The same file declares the flag set five times: `SCREENSHOT_COMMAND_FLAG_KEYS` (`:96`), `SCREENSHOT_ACTION_FLAG_KEYS` (`:109`), `SCREENSHOT_SPECIFIC_FLAG_DEFINITIONS` (`:135`, CLI usage text consumed only by `command-registry/src/flag-definitions-workflow.ts:361`), the four `SCREENSHOT_SCRIPT_*_FLAGS` tables (`:223-253`) and `ScreenshotRequestFlags` (`:255`). The scale and pixel-density bounds are stated in the definitions and again in the script readers (`:449`, `:465`).
- Fix: move the two script functions and the `SCRIPT_*` tables to `@agent-device/ad-script`, with `--crop-on` handled on both sides in one place. Derive `SCREENSHOT_ACTION_FLAG_KEYS` and the script tables from `SCREENSHOT_SPECIFIC_FLAG_DEFINITIONS`.
- Effort: M
- Model: sonnet
- Verify: `pnpm vitest run packages/ad-script`; a round-trip test for `screenshot --crop-on 'id=x' --scale 0.5`.

### CONTR3-7: Identical or re-spelled shapes inside contracts (not covered by CONTR-6 or CONTR-9)
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence:
  - `ScreenshotPublicOptions` and `ScreenshotRuntimeOptions` are the same nine fields (`packages/contracts/src/screenshot.ts:290-312`). Neither name is imported outside `facades/capture.ts:28,31`.
  - `screenshotFlagsFromOptions` and `screenshotFlagsFromPublicOptions` (`:331-364`) differ only in whether `scale` maps to `screenshotScale`.
  - `SnapshotCaptureFreshness` (`snapshot-capture-annotations.ts:33-38`) is restated inline at `snapshot-types.ts:41-46`, and its reason union a third time at `packages/capture-kit/src/snapshot/snapshot-freshness/types.ts:21`.
  - `SnapshotRuntimeHost.presentIosAcquisition` (`snapshot-runtime.ts:80-83`) restates `SnapshotRuntimePresenter` (`:86-89`).
  - `PressPointOptions.button` (`interactor-types.ts:102`) and `alternateClick`'s `'secondary' | 'middle'` (`:332`) re-spell `ClickButton` (`click-button.ts:3-4`); so do `command-registry/src/flag-definitions-action.ts:251`, `command-surface/src/interaction/index.ts:216` and `ad-script/src/internal/script-utils.ts:456`.
  - `isAndroidInputMethodOwned` (`android-input-ownership.ts:62-72`) and the exported `isAndroidInputMethodOwnedNode` (`:74-80`) are the same function with different parameter shapes.
  - Biometric states `['match','nonmatch','enroll','unenroll']` are written twice in the catalog (`settings-catalog.ts:142,146`) and re-parsed by hand in `platform-apple/src/core/app-settings.ts:339-362` and `platform-android/src/settings.ts:325-331`, while appearance, text size and permissions export a tuple plus a shared parser.
  - `isRuntimeOperationUnavailabilityReason` (`platform-runtime.ts:424-437`) re-spells the union at `:177-189`. A reason added to the type alone compiles, then every owner fact that uses it is rejected at bind time as "invalid fact".
- Fix: keep one declaration per shape and derive the rest (`type X = Y`, `Exclude<ClickButton,'primary'>`, a `BIOMETRIC_ACTIONS` tuple with `findVocabularyName`, a `Record<Reason, true>` table that both the type and the guard read).
- Effort: S-M
- Model: sonnet
- Verify: `pnpm tsc -b`; `git grep -n "'secondary' | 'middle'" packages` returns only the derived alias.

### CONTR3-8: Platform- and provider-specific mechanics inside the contracts package
- Category: inconsistent (owner boundary)
- Severity: low     Confidence: high (facts) / medium (whether the lead wants them moved)
- Evidence:
  - `packages/contracts/src/platform-runtime.ts:1,80-150`: `providerRuntimeInstance` runs `scryptSync` (16 MiB, tens of ms). Only `provider-limrun/src/runtime-instance.ts:19` and `provider-revyl/src/runtime-instance.ts:15` call it, yet every importer of the hub module `platform-runtime.ts` loads `node:crypto`.
  - `packages/contracts/src/settings.ts:77-101`: `SimctlSettingRequest` and its runner type have one consumer, `platform-apple/src/core/simctl-settings.ts`. The comment "whichever host runs that simctl" names a second user that does not exist.
  - `packages/contracts/src/system-button-runtime.ts:126-177`: Android TV and simulator-kind rules with user-facing hints (`androidHardwareButtonFacts`), shared by `platform-android` and `provider-limrun`.
  - `packages/contracts/src/application-lifecycle-interaction.ts:202` (`device.platform === 'linux'` refuses `--launch-args`), `:386` (`device.platform === 'web'` closes with an empty app), `:93-97` (error text names "Limrun"), `:179-183` (CLI positional arity for `open`).
  - `packages/contracts/src/snapshot-runtime.ts:155-166`: observe-only is admitted by `isHandheldAppleDevice` plus a hardcoded sentence instead of an owner fact.
  - `packages/contracts/src/click-button.ts:28-39`: macOS/Linux capability for `--button` is decided by a platform string compare, not by a runtime fact.
- Fix: move `providerRuntimeInstance` to its own subpath module (or to a provider-shared package) so the hub stays crypto-free. Move the simctl request type to `platform-apple`. Express the Linux launch-args, web close, observe-only and click-button rules as owner facts or owner-side checks. `androidHardwareButtonFacts` can stay if the lead accepts contracts as the shared home for a two-owner rule.
- Effort: M
- Model: opus (cross-package boundaries, eager-closure budgets)
- Verify: `pnpm check:affected --run` (layering and eager-closure gates); `git grep -n "scryptSync" packages/contracts/src/platform-runtime.ts` is empty.

### CONTR3-9: Public client types for `settings` admit inputs the catalog always refuses
- Category: inconsistent (type wider than validator)
- Severity: low     Confidence: medium
- Evidence: `packages/contracts/src/client-settings.ts:71-77` types `location` + `state: 'set'` with `app?: string`. The catalog marks the coordinates form `device-level` on both families (`settings-catalog.ts:123`), so `settingsAppRefusal` (`packages/daemon/src/execution/handlers/snapshot-settings.ts:240-253`) always answers `setting_app_not_consumed`. The permission branch (`:78-91`) accepts `state: 'deny'` and `mode` with a macOS target, which `parsePermissionPositionals` rejects (`settings.ts:319-334`, macOS form is `grant|reset` with no modes). `DeviceLevelToggleOptions` (`:39-55`) documents its `app` as always refused.
- Fix: drop `app` from the `location set` branch and from `DeviceLevelToggleOptions`; split the permission branch into a mobile form and a macOS form derived from the two catalog forms.
- Effort: S
- Model: sonnet
- Verify: `@ts-expect-error` lines in `packages/contracts/src/client-settings.test.ts`; `pnpm tsc -b packages/contracts packages/client`.

### CONTR3-10: Stale, orphaned and history-narrating comments (sites not listed in CONTR-16 or CONTR2-16)
- Category: inconsistent (AGENTS.md comment rule)
- Severity: low     Confidence: high
- Evidence:
  - Dangling symbol: `interaction-guarantees.ts:206-208` cites `DIRECT_IOS_SINGLE_QUERY_READINESS`, which exists nowhere in the repo.
  - Wrong location: `replay-divergence.ts:138` and `:153-155` say `formatReplayDivergenceReport` and `buildRepairHintGuidance` are "below"; both live in `packages/ad-replay/src/replay-divergence.ts:215,332`. `interactor-types.ts:267-271` says `SnapshotProvenance` is in `@agent-device/kernel/snapshot`; it is declared in `snapshot-producers.ts:219`.
  - Orphaned JSDoc: `platform-runtime-operations.ts:365` (a gesture-plan sentence stacked on `isMultiTouchGesture`), `tap-keyboard-occlusion.ts:114-119` (attached to nothing), `interaction.ts:275-291` (the `SettleObservation` description sits on `SettleParams`; `SettleObservation` at `:309` has none).
  - History narration: `interaction-guarantees.ts:404-408` ("Verified 2026-07-04 while designing the #1088 retirement experiment, which this finding dissolved"), `interactor-operation-catalog.ts:46-51` ("It used to take three parallel declarations", "Wave 6"), `replay.ts:166-168` ("used to send only the path"), `interaction.ts:299-300` ("a daemon-side structural twin drifted").
  - File names that no longer match content: `device-rotation.ts:103-349` holds hardware buttons and fold poses; `android-input-ownership.ts:175-201` holds the iOS keyboard role tables; `input-validation.ts:48` holds `ANDROID_SHELL_TEXT_UNSUPPORTED_REASON`.
- Fix: delete or correct each comment; move the three misplaced groups to `hardware-button.ts`/`fold-pose.ts`, `ios-keyboard-roles.ts`, and the Android text module (move Fallow baseline entries with the renames).
- Effort: S (comments) + S-M (file moves)
- Model: sonnet
- Verify: `pnpm format`; `pnpm tsc -b`; `git grep -n DIRECT_IOS_SINGLE_QUERY_READINESS` is empty.

### CONTR3-11: Nine contracts modules import their own package by name while the rest use relative paths
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence: `import type ... from '@agent-device/contracts/snapshot-model'` in `interactor-types.ts:31`, `replay-backend.ts:6`, `snapshot-diagnostics.ts:1`, `runtime-contract.ts:4`, `snapshot-types.ts:10`, `session-surface.ts:1`, `replay.ts:4`, `backend.ts:25`, `android-system-surface-disclosure.ts:1`. Every other intra-package import in `packages/contracts/src` is `./x.ts`. The self-reference resolves through `package.json` `exports`, so these nine files depend on the built or mapped package entry instead of the sibling file.
- Fix: replace with `./snapshot-model.ts`.
- Effort: S
- Model: sonnet
- Verify: `grep -rn "from '@agent-device/contracts" packages/contracts/src --include=*.ts | grep -v test` is empty; `pnpm tsc -b packages/contracts`.

### CONTR3-12: `SnapshotTimingStats.backends` is keyed by producer, not by backend
- Category: inconsistent (naming drift on a public response field)
- Severity: low     Confidence: high
- Evidence: `packages/contracts/src/snapshot-diagnostics.ts:29-33` documents `backends` as "Captures per producer ... keyed by producer id such as `simulator-ax-bridge`", and `backendCounts` (`:172-180`) keys by `sample.producer ?? sample.backend`. One map therefore mixes two vocabularies (`SnapshotProducer` and `SnapshotBackend`, `snapshot-producers.ts:15-41`); `macos-helper` and `linux-atspi` are members of both. The field type is `Record<string, number>`, so nothing ties it to either list.
- Fix: do not rename the wire key without a request. Type it as `Partial<Record<SnapshotProducer | SnapshotBackend, number>>` and state the mixed key rule once in the type, or add a `producers` map and keep `backends` strictly per channel.
- Effort: S
- Model: sonnet
- Verify: `pnpm tsc -b packages/contracts packages/replay-port packages/maestro`.

### CONTR3-13: Small logic leftovers in the files read
- Category: unneeded / inconsistent
- Severity: low     Confidence: high
- Evidence:
  - `platform-runtime-operations.ts:826-840`: `normalizeVocabularyName` already returns a member of `READABLE_SETTINGS`, then `:831` tests `READABLE_SETTINGS.includes(setting)` again; the false branch is unreachable.
  - `platform-runtime-operations.ts:387-399` and `:615-653`: two `switch` statements whose every case runs the same call (four and five identical arms).
  - `touch-runtime.ts:138-141`: `tapPoint` calls `signal.throwIfAborted()` and then `interactorFor`, which calls it again (`:135`).
  - `tap-keyboard-occlusion.ts:136-141`: `isKeyboardSubtreeHost(node)` re-tests `isKeyboardAnchorNode`, already covered by `isKeyboardSurfaceNode` in the same condition.
  - `platform-runtime.ts:438-443`: `unsupportedRuntimeOperation` writes `hint: undefined` into details, while `touch-runtime.ts:233-236` omits an absent hint for the same refusal shape.
  - `device-rotation.ts:190-195` and `tv-remote.ts:118-119` lowercase without trimming; every other vocabulary parser in the package trims (`settings.ts:374-376`, `telephony-input.ts:37`, `device-rotation.ts:56,253`).
  - `replay-port/src/daemon-port/session-replay-divergence-publication.ts:71` re-spells the `ReplayRefPublicationResult` reasons (`replay.ts:204-209`) plus one extra, instead of deriving from the contract type.
- Fix: remove the dead branch and duplicate calls; collapse the switches to one generic call with a cast at the single site; share one `normalizeName`; derive the replay-port union with `Extract`.
- Effort: S
- Model: sonnet
- Verify: `pnpm vitest run packages/contracts`; `pnpm tsc -b`.
