# Audit report: command packages, second pass (SLICE CMD2)

Slice: the parts of `packages/command-runtime/`, `packages/command-surface/`, `packages/command-output/`, `packages/provision-kit/`, `packages/host-kit/` that the first pass (`command-packages.md`) listed as unread. Findings CMD-1 to CMD-21 are not repeated.

## Coverage

Roughly 45% of what the first pass left unread was read line by line; with the first pass that puts the five packages at about 65-70% of production source.

- **Read fully (this pass):**
  - `provision-kit`: `provider-lease-table.ts`, `boot-diagnostics.ts`, `install-source-archive.ts`, `app-resolution-cache.ts`, `toolchain-probe.ts`, `install-artifact-archive-context.ts`.
  - `command-output`: `output/snapshot.ts`, `output/diff.ts`, `output/error.ts`.
  - `command-runtime` interaction runtime: `settle.ts`, `stable-capture.ts`, `moving-target-gate.ts`, `selector-read.ts`, `selector-read-shared.ts`, `selector-read-utils.ts`, `ref-target-resolution.ts`, `interactions.ts`, `resolution.ts`, `native-ref-interaction.ts`, `post-action-observation.ts`, `index.ts`, rest of `wait-polling.ts`; `gestures.ts` (focus / longpress / hover / drag); `capture/runtime/snapshot.ts`.
  - `command-surface`: `system/index.ts`, `interaction/index.ts`, `command-input.ts`, `post-action-observation-grammar.ts`, `capture/diff.ts`.
  - `host-kit`: `archive-safety.ts`, `archive-extraction.ts`, `archive-extraction-zip.ts`, `archive-extraction-tar.ts`, `exec-trace.ts`, `version.ts`.
- **Skimmed (outline or grep):** `selector-is.ts`, `selector-wait.ts`, `gesture-command.ts`, `command-surface/metro/index.ts`, `command-output/capture/output.ts`, `cli-output.ts`.
- **Tests:** all 161 test files in the five packages were scanned mechanically (assertion-free files, skips, duplicate titles, real sleeps, unused helper exports); about 6 were read. No semantic audit of the large suites (`settle.test.ts`, `snapshot.test.ts`, `process-lock.test.ts`).
- **Not reached:** `command-surface/replay/index.ts`, `schema/cli-config.ts`, `option-schema.ts`, `management/*`, `observability/index.ts`, `perf/index.ts`; `command-output/perf/output.ts`; `command-runtime` `target-visibility-stages.ts`, `selector-target-resolution.ts`, `replay-target-guard.ts`, `resolution-disclosure.ts`, `stable-capture-signal.ts`, `post-action-surface.ts`, `wait-*.ts` leaves, `diff-screenshot.ts`, `snapshot-unchanged.ts`; `host-kit` `code-signature*.ts`, `diagnostics.ts`, `verified-file.ts`, `owned-process-record.ts`, `local-artifact-adapter.ts`, `runtime-transport-hints.ts`.

Checks that came back clean (not findings):
- **Lease table.** `provider-lease-table.ts` was traced through allocate / join / teardown / follow-up orderings. No defect verified; one low-confidence edge is CMD2-13. The only driver (`provider-revyl/src/runtime.ts:246`) uses an arrow `handleKey`, so the unbound pass at `provider-lease-table.ts:398` is harmless.
- **Runtime session writes.** `captureSelectorSnapshot` and `storeSettledSnapshot` write `{...session, snapshot}` from a pre-capture read, but the daemon store (`daemon/src/core/runtime-session.ts:89-101`) re-reads the current session on `set`, so there is no lost update.
- **Test hygiene.** No test file without assertions, no `.only` / `.skip` / `.todo`; platform gates only (`runIf(win32)`). No unused export in `__tests__/test-utils/index.ts` or the `*.fixtures.ts` files.
- **Post-action flags.** `--verify` / `--settle` fields and CLI flags for click / press / fill / longpress / hover / scroll / back are derived from the registry in one place.

Probes were run with `node --experimental-strip-types` against the source readers (no build, no test run).

## Findings

### CMD2-1: `clipboard write ""` is refused before it reaches the daemon, although docs and the daemon advertise it as "clear clipboard"
- Category: broken
- Severity: medium     Confidence: high
- Evidence:
  - `packages/command-surface/src/system/index.ts:388` declares `text: stringField()`. Without `allowEmpty`, `stringField` reads through `optionalString`, which rejects `''` (`command-input.ts`, `stringField`).
  - Probed: `readInputFromCli('clipboard', ['write', ''], {})` returns `{action:'write', text:''}`, then `runCommand` throws `INVALID_ARGS Expected text to be a non-empty string.` The generic CLI path is `src/commands/cli-runner.ts:36-42` (`readInputFromCli` then `runCommand`); there is no dedicated clipboard CLI command.
  - The structured path (`metadata.readInput({action:'write', text:''})`) throws the same error.
  - `website/docs/docs/commands.md:885` documents `agent-device clipboard write ""   # clear clipboard`. `packages/daemon/src/execution/handlers/session-clipboard.ts:84-91` implements it and says `use "" to clear clipboard`; the daemon test at `session-clipboard.test.ts:151` pins it. The daemon is never reached.
  - Related gap on the same field: `{action:'write'}` with no text passes `readInput`, and `clipboardDaemonWriter` emits positionals `["write", undefined]` (probed); `{action:'read', text:'x'}` is accepted silently, where the CLI reader rejects extra arguments (`system/index.ts:771-774`).
- Fix: `text: stringField(undefined, { allowEmpty: true })`, plus a `readInput` (same pattern as `telephonyFieldMetadata`, `system/index.ts:439-449`) that requires `text` for `write` and refuses it for `read`; add the matching `oneOf` to the input schema.
- Effort: S
- Model: sonnet
- Verify: new cases in `packages/command-surface/src/system/index.test.ts` running `readInputFromCli` + `runCommand` for `clipboard write ""`; `pnpm vitest run packages/command-surface/src/system`.

### CMD2-2: Boot-failure classification is substring matching on error text and stdout, and it decides whether the Android boot wait keeps polling
- Category: broken
- Severity: medium     Confidence: medium
- Evidence:
  - `packages/provision-kit/src/boot-diagnostics.ts:43-121` joins message, stdout and stderr into one lowercase `haystack` and classifies with `includes(...)`. AGENTS.md: "Use typed reasons and details for behavior. Do not match error text."
  - The result drives behaviour, not only a hint: `packages/platform-android/src/emulator-lifecycle.ts:71-79` returns `shouldRetry = reason !== 'ADB_TRANSPORT_UNAVAILABLE' && reason !== 'ANDROID_BOOT_TIMEOUT'`, with the last `getprop` stdout/stderr as input.
  - The android branch matches the bare word `offline` (`:113`, redundant with `device offline` at `:112`), `unauthorized`, `no devices`, and for phase `boot` any `timeout` / `timed out` (`:93-98`). An emulator that reports `device offline` on one poll while it is still starting is classified `ADB_TRANSPORT_UNAVAILABLE` and the boot wait stops retrying. I did not confirm on a device that `readAndroidBootProp` returns that stderr rather than throwing, hence medium.
  - The function is baselined debt: `fallow-baselines/health.json` lists `boot-diagnostics.ts:complexity`, and the source carries `// fallow-ignore-next-line complexity` (`:16`).
- Fix: have the producers stamp a typed reason (`details.reason` on the adb / simctl / runner errors, as `0xe8008012` already has a stable code) and make `classifyBootFailure` read that first; keep text matching only as the hint for unclassified errors and never as the `shouldRetry` input. Touches `boot-diagnostics.ts`, `platform-android/src/emulator-lifecycle.ts`, `apple-runner/src/runner-startup-transport.ts`.
- Effort: M
- Model: opus (device boot behaviour, cross-package)
- Verify: `pnpm vitest run packages/provision-kit/src/boot-diagnostics.test.ts packages/platform-android` plus a new case: a poll whose stderr is `adb: device offline` followed by `1` must complete the boot wait.

### CMD2-3: Six bound interaction-runtime commands have no production caller
- Category: unneeded
- Severity: medium     Confidence: high
- Evidence:
  - `packages/command-runtime/src/commands/interaction/runtime/index.ts:163-191` binds `selectors.getText`, `getAttrs`, `isVisible`, `isHidden`, `waitForText` and `interactions.focus`.
  - `git grep` for those members outside `packages/command-runtime` finds no call. The daemon uses only `selectors.find|get|is|wait` (`daemon/src/execution/selector-runtime.ts:67,171,245`, `wait-runtime.ts:175`) and `interactions.click|press|fill|longPress|hover|gesture|settleObservation`.
  - `focus` is served by `packages/contracts/src/focus-runtime.ts:60` (`interactor.focus`), not by `focusCommand` (`gestures.ts:115-135`). The CLI grammar only accepts `focus <x> <y>` (`command-surface/src/interaction/index.ts:417-419`), so the selector/ref resolution in `focusCommand` is unreachable.
  - `waitForText` is also declared in the daemon port (`contracts/src/daemon-command-surface.ts:318-321`, "The five selector reads the daemon's selector and wait routes serve"), with no caller.
  - Implementations: `getTextCommand` / `getAttrsCommand` (`selector-read.ts:219-247`), `isVisibleCommand` / `isHiddenCommand` (`selector-is.ts:196-214`), `waitForTextCommand` (`selector-read.ts:120-123`, `selector-wait.ts:239`), `focusCommand`. They are exercised only by `selector-read.test.ts`, `selector-is.test.ts`, `selector-is-visibility.test.ts`, `gestures.test.ts`, `__tests__/selector-read-policy.test.ts`.
  - Fallow does not flag them because the bound objects reference them (same mechanism as CMD-1).
- Fix: delete the six commands, their option/result types, their bindings, and the `waitForText` member of `DaemonCommandSurfaceSelectors`; rewrite the affected tests against `get` / `is` / `wait`. Fold into the CMD-1 change if that is done.
- Effort: S-M
- Model: sonnet
- Verify: `pnpm check:affected --run`; `pnpm vitest run packages/command-runtime packages/daemon`.

### CMD2-4: The native-ref preflight judges `@ref` against the latest observation, not the authorized ref frame
- Category: inconsistent
- Severity: low     Confidence: medium
- Evidence:
  - `native-ref-interaction.ts:38-45` (`preflightNativeRefInteraction`) reads `session?.snapshot` and resolves the ref in it.
  - Every other ref path resolves against `session.refFrameSnapshot ?? session.snapshot` through `requireSnapshotSession` (`selector-read-shared.ts:51-63`), whose comment states the ADR 0014 rule: "a ref resolves against the AUTHORIZED frame tree, never the latest operational observation".
  - On the web provider (the only backend with `tapTarget` / `fillTarget` / `hoverTarget`, per `interactions.ts:225-231`), a `--settle` capture or a read-only `find` replaces `session.snapshot` without retiring the frame. The occlusion / off-screen guards and the returned `node`, `preAction`, `targetHittable` then describe whatever node carries that ref body in the newer tree, while the dispatch goes to the provider's own handle.
  - The same function reports `resolution: EXACT_REF_RESOLUTION` and the un-normalized `target.ref` (`:89-92`) even when the preflight resolved through the label fallback; the coordinate path reports `label-fallback` and `@${resolved.ref}` (`ref-target-resolution.ts:137,286`).
- Fix: resolve the preflight node through `requireSnapshotSession` (tolerating a missing session as today) and report the resolution kind the lookup returned.
- Effort: S
- Model: opus (ADR 0014 ref-frame semantics)
- Verify: new case in `interactions-ref-frame-evidence.test.ts`: frame tree and observation disagree on `@e2`; a web-style `tapTarget` backend must be preflighted against the frame node.

### CMD2-5: `diff snapshot` compares against whatever capture last wrote the session snapshot, with no presentation check
- Category: inconsistent
- Severity: low     Confidence: medium
- Evidence:
  - `capture/runtime/snapshot.ts:138-161` diffs `capture.session?.snapshot` against the new capture and never compares `presentationKey`.
  - The sibling features in the same module do: the unchanged acknowledgement requires equal keys (`snapshot-unchanged.ts:46`), and the stale-drop warning calls `hasSameSnapshotPresentation` (`snapshot.ts:413,422-430`).
  - `session.snapshot` is also written by captures with other presentations: a read-only `find` stores a capture scoped to the query (`selector-read.ts:336-338`, `updateSession: true`), and `--settle` stores an interactive-only capture (`settle.ts:497`). A full `diff snapshot` after either reports filtered-out nodes as additions.
  - Not reproduced end to end; traced by reading.
- Fix: when the stored snapshot's `presentationKey` differs from the new capture's, return `baselineInitialized: true` (or a warning line naming the mismatch) instead of a cross-presentation diff.
- Effort: S
- Model: sonnet
- Verify: new case in `packages/command-runtime/src/commands/capture/runtime/snapshot.test.ts`: scoped stored snapshot, then unscoped `diffSnapshot`.

### CMD2-6: `jsonSchemaField` advertises a schema and validates nothing, so six fields accept any value on the structured path
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence:
  - `command-surface/src/command-input.ts:349-351` — `jsonSchemaField` reads `record[key] as T`. Production does not validate tool input against `inputSchema` (the only JSON-schema validator is the test helper `src/mcp/__tests__/output-schema-validator.ts`); `readInput` is the validation.
  - Probed: `diff` metadata `readInput({kind:'screenshot'})` and `readInput({kind:42})` both succeed, although the field is `{type:'string', const:'snapshot'}` (`capture/diff.ts:69`) and the CLI reader refuses anything but `snapshot` (`:94-96`).
  - Same pattern: `metro.kind` typed as a string (`metro/index.ts:40`), `metro.bridgeScope` (`:51`), `saveScript` (`management/app.ts:68,100`, `replay/index.ts:74`), push payload (`management/push.ts:79`), install source (`management/install.ts:63`). `fold.keyframes` is safe because `parseFoldInput` validates it.
  - Also probed: `diff` accepts `depth: -3` (`capture/diff.ts:72` is `integerField()`), while the shared `selectorSnapshotFields` uses `{ min: 0 }` (`command-input.ts`).
- Fix: replace `jsonSchemaField` for scalar shapes with the validating builders (`enumField(['snapshot'])`, `stringField()`), and give the union shapes a `customField` reader; reuse `selectorSnapshotFields()` in `diff`.
- Effort: S
- Model: sonnet
- Verify: `pnpm vitest run packages/command-surface` with new refusal cases for `diff {kind:'screenshot'}` and `metro {kind: 1}`.

### CMD2-7: Tar archives are read and decompressed twice; zip archives are opened three times
- Category: inefficient
- Severity: low     Confidence: high
- Evidence:
  - `host-kit/src/internal/archive-extraction-tar.ts:32` — `inspectTar` streams and gunzips the whole archive, draining every entry (`:67-99`), only to build the manifest. `:35-64` then streams and gunzips it again to write. The archive cap is 2 GiB compressed (`artifact-limits.ts:1`).
  - The second pass already enforces every limit as it goes (`reservation.chargeBytes` / `commitEntry`, `archive-safety.ts:105-120`). The first pass is needed only by callers that pass `validateManifest`; the sole production caller is `daemon/src/server/artifact-archive.ts:19`. Install-source extraction (`provision-kit/src/install-source-archive.ts:117`) and IPA extraction pass none.
  - `archive-extraction-zip.ts:32-53` reads the central directory twice (`readZipEntries` for the manifest, again for the entry list) and opens the file a third time for the streams. The first pass also calls `budget.preflightArchive` twice per entry (`:33-44`), allocating a discarded `ArchiveReservation` each time.
  - `install-source-archive.ts:61-74` walks the extracted tree twice (installables, then archives).
- Fix: when no `validateManifest` is given, run tar extraction in one pass with a running budget charge (declared size from each header, checked before the entry is written); keep the two-pass form for `validateManifest`. For zip, reuse the first pass's entries. Collect installables and archives in one walk.
- Effort: M
- Model: opus (archive safety invariants, TOCTOU reasoning)
- Verify: `pnpm vitest run packages/host-kit/src/internal/archive-extraction.test.ts packages/host-kit/src/internal/archive-safety.test.ts packages/provision-kit`.

### CMD2-8: Snapshot text is always rendered, twice per line for `-i`, even when the caller prints JSON
- Category: inefficient
- Severity: low     Confidence: high
- Evidence:
  - `src/commands/cli-runner.ts:43-52` calls `formatCliOutput` for every command regardless of `--json`. `command-output/src/capture/output.ts:32-37` builds `text: formatSnapshotText(...)` eagerly beside `data` / `jsonData`.
  - `formatSnapshotText` (`output/snapshot.ts:30-75`) then runs the Android helper presentation, `buildMobileSnapshotPresentation`, `detectPossibleRepeatedNavSubtree` and the line builder over the whole tree, and the result is discarded in JSON mode.
  - In the flattened branch (`snapshot -i`, the common agent path) each line is formatted twice: `buildSnapshotDisplayLines` already computes `text` (`capture-kit/src/snapshot/snapshot-lines.ts:49`), and `buildFlattenedSnapshotDisplayLines` (`output/snapshot.ts:385-394`) throws it away and calls `formatSnapshotLine` again at depth 0.
  - `--raw` still builds the helper presentation (`:38`) that only the non-raw branches read.
  - Two default parameters are never used because the single caller always passes them: `buildSnapshotNotices(..., helperPresentation = {...})` (`:274`) and `readSnapshotVisibility(..., filteredCount = 0)` (`:206`).
- Fix: make `text` lazy in `CliOutput` (a thunk the dispatcher evaluates only for text output), or pass the output mode to the formatter; give `buildSnapshotDisplayLines` a `flatten` option so the flattened branch formats once; move the helper presentation behind the `raw` check; drop the dead defaults.
- Effort: S-M
- Model: sonnet
- Verify: `pnpm vitest run packages/command-output` (the existing `snapshot.test.ts` / `snapshot-android.test.ts` pin the text byte for byte).

### CMD2-9: Ref and find read failures disagree with the other read paths on message and typed reason
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence:
  - `selector-read.ts:157-161` — `getCommand` passes `invalidRefMessage: 'get text requires a ref like @e2'` for both properties, so `get attrs <bad ref>` reports a `get text` error.
  - `selector-read.ts:141-143` — a `find` that matches nothing throws `COMMAND_FAILED 'find did not match any element'` with no `details.reason`. The sibling reads go through `observationReadFailure` / `selectorNotFoundFailure` and carry `reason: selector_not_found` with a hint (`selector-read-shared.ts:162-182`). Callers that branch on the typed reason cannot see a find miss.
  - The same literal is duplicated in `daemon/src/execution/interaction/internal/find-match-resolution.ts:78`.
  - `sparseSelectorSnapshotError` (`selector-read-utils.ts:34-39`) puts the verdict's free `reason` string straight into `details.reason`, the field the interaction surface otherwise reserves for `INTERACTION_ERROR_REASONS`.
- Fix: build the find miss through `selectorNotFoundFailure` (one constructor shared with the daemon site); make the `get` ref message property-aware.
- Effort: S
- Model: sonnet
- Verify: `pnpm vitest run packages/command-runtime/src/commands/interaction/runtime/selector-read.test.ts packages/daemon/src/execution`.

### CMD2-10: Eleven `command-output-schemas-*.test.ts` files are the same two tests with one identifier changed
- Category: unneeded
- Severity: low     Confidence: high
- Evidence:
  - `packages/command-surface/src/command-output-schemas-{diff,interaction,management-device,management-doctor,management-prepare,management-push,management-viewport,recording,replay,wait}.test.ts` plus one more: 11 files, 486 lines.
  - `diff` of the `wait` and `recording` files shows only the imported map, its name, and the owner path differ. Ten files share the title `the projected family map declares exactly the commands its module owns`.
  - Each file re-imports `command-output-schemas.ts` and the owner-files table.
- Fix: one table-driven test over `[familyMap, ownerPath, copiesAllowed]` rows; keep the few file-specific assertions (for example the interaction file's settle-graft checks) as extra cases.
- Effort: S
- Model: sonnet
- Verify: `pnpm vitest run packages/command-surface/src/command-output-schemas`.

### CMD2-11: Merged-leaf warning prints `@undefined` for a node that has no ref
- Category: broken
- Severity: low     Confidence: medium
- Evidence:
  - `capture/runtime/snapshot.ts:366` interpolates `@${node.ref}` without checking it.
  - Refs are optional on producers that mint their own: `selector-read.ts:319-327` documents that a web node "left unaddressed carries none", and `hasSnapshotRef` exists for that reason.
  - The warning runs whenever the capture has no quality verdict (`snapshot.ts:281-285`), which includes web captures. A ref-less, non-text leaf whose label has more than ten `, ` segments yields `@undefined [..] merges ~N labels ...`. Not reproduced with a real web capture.
- Fix: filter with `hasSnapshotRef` or omit the ref prefix when absent.
- Effort: S
- Model: sonnet
- Verify: new case in `packages/command-runtime/src/commands/capture/runtime/snapshot.test.ts` with a ref-less merged leaf.

### CMD2-12: The `snapshot` command hands the backend a different context than every other capture
- Category: inconsistent
- Severity: low     Confidence: medium
- Evidence:
  - `capture/runtime/snapshot.ts:182-190` builds the backend context by hand and adds `appId` and `appBundleId` from the session.
  - Selector, wait, settle and interaction captures use `toBackendContext` (`runtime-common.ts:4-14`), which carries neither (`selector-read-shared.ts:85`).
  - A backend that reads `context.appBundleId` therefore sees it for `snapshot` / `diff snapshot` and not for `get` / `is` / `wait` / `--settle`. I did not find which backends read it.
  - This is a third hand-built copy of the context beside the two listed in CMD-15.
- Fix: one context builder that takes the optional session record; use it in both paths.
- Effort: S
- Model: sonnet
- Verify: `pnpm vitest run packages/command-runtime`.

### CMD2-13: Lease table can leave a ready rental with no holder when its only waiter is refused at delivery
- Category: broken
- Severity: low     Confidence: low
- Evidence:
  - `provision-kit/src/provider-lease-table.ts:403` — `runStart` marks the entry `ready` when `stillWanted(entry)` is true (`now < waiter.deadline`, `:766-775`).
  - `:304-309` — `deliver` then refuses the same caller when `Date.now() >= deadline` (`budgetSpent`, `:761-763`). The two reads are separated by promise continuations, so the clock can cross the deadline between them.
  - In that case the caller gets `gaveUp`, the entry stays `ready` with a rented device, and nothing in the table tears it down (`abandonIfUnwanted` returns early once `answered`, `:535`). It ends only if the daemon later releases or recovers the lease.
  - Separate hazard in the same class: `endFailedStart` calls `driver.cleanupPending` unguarded (`:472`). If it throws after every caller has given up, `entry.start` rejects with no listener; the other driver factories are guarded (`:409-414`, `:492-500`).
  - Not reproduced; the window is about 1 ms.
- Fix: in `deliver`, when the refusal is `gaveUp` on a `ready` entry with no remaining in-budget waiter, start `teardown(entry)`; wrap the `cleanupPending` call like the other factories.
- Effort: S
- Model: opus (concurrency)
- Verify: new case in `provider-lease-table-interleaving.test.ts` with a fake clock that crosses the deadline between the start answer and delivery.

### CMD2-14: `installArtifactArchiveBudget()` is typed `object | undefined` and its only caller casts it
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence:
  - `provision-kit/src/install-artifact-archive-context.ts:11-13` returns `object | undefined` although the store holds an `ArchiveBudget` (`:4`).
  - `platform-apple/src/core/install-artifact.ts:145` does `installArtifactArchiveBudget() as ArchiveBudget`, which also erases the `undefined` case (outside a scope the cast yields `undefined` typed as a budget; `extractArchiveSafely` then silently starts a fresh budget, so a nested archive outside the scope is not charged to the outer one).
- Fix: return `ArchiveBudget | undefined` and remove the cast; decide explicitly what a missing scope means.
- Effort: S
- Model: sonnet
- Verify: `pnpm check:affected --run` (typecheck).

### CMD2-15: `isTrustedInstallSourceUrl` is a deprecated export with no product caller
- Category: unneeded
- Severity: low     Confidence: high
- Evidence:
  - `provision-kit/src/install-source.ts:171-199` — marked `@deprecated`: "agent-device does not gate install sources on this check". With its two private helpers it is about 30 lines.
  - Callers: only the public re-export `src/sdk/install-source.ts:3` and tests (`src/__tests__/install-source.test.ts:82-103`, `provision-kit/src/install-source-download.test.ts:267`). `website/docs/docs/build-an-integration.md:73` lists it as deprecated.
  - Removal changes the public SDK surface, so it needs a release decision rather than a silent delete.
- Fix: remove the function, its helpers, the SDK re-export, the doc line and the tests in the next breaking release; until then leave as is.
- Effort: S
- Model: sonnet
- Verify: `pnpm check:affected --run` plus the SDK export snapshot test.
