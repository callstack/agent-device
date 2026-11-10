# Audit: SLICE CAP3 — capture-kit / selectors, third pass

## Coverage

Read-only audit at commit `093341a`. No gates, tests, or builds were run. One throwaway scan script listed assertion-less and duplicate-title tests and was deleted. All paths are relative to `/home/user/agent-device`. Findings CAP-1..23 and CAP2-1..18 are not repeated.

Read line by line in this pass (production source, about 6.9k lines):

- `packages/capture-kit/src/durable-capture/{recovery,recovery-authority}.ts`.
- `packages/capture-kit/src/capture-admission/*` (all 24 production files).
- `packages/capture-kit/src/recording/{contact-sheet,contact-sheet-frames,contact-sheet-plan,contact-sheet-render,contact-sheet-report,contact-sheet-selection,overlay,video-webm}.ts`.
- `packages/capture-kit/src/ios-snapshot-engine/`: `types, index, graph, replay, actions, geometry, geometry-policy, invariants, runner-presentation, rows, projection, scroll, semantic-index, noise, noise-helpers, noise-structural, noise-viewport, noise-search, noise-redundancy, noise-overlay, action-shelf, transitions, web, conformance-harness`. Only helper signatures were re-read in `tree.ts`.
- `packages/capture-kit/src/snapshot/snapshot-freshness/*`, `alert-tree-driver.ts`, `react-native-overlay.ts`.
- `packages/selectors/src/{absence-observation,absence-observation-errors,absence-observation-resolution,interaction-touch-point,press-retarget,selector-pipeline-policy,interaction-positionals}.ts`.

Skimmed: `ios-snapshot-engine/{conformance-generator,conformance-fixture}.ts` (test tooling), `durable-capture/store.ts` (`list` and `read` only).

Tests: a script scanned all 169 test files of the two packages for test blocks with no assertion and for duplicate titles across files (one hit, CAP3-17). Read in full: `rows.test.ts`, `tree.test.ts`, `perf-runtime-plan.test.ts`, `video-webm.test.ts`; test titles only for `react-native-overlay.test.ts`. No other test file was read in depth.

Not reached in capture-kit: `audio-probe-descriptor.ts`, `durable-resource-envelope.ts`, `durable-json.ts`, `durable-descriptor-codec.ts`, `screen-recording-{completion,live-handle,options,transport}.ts`, `screenshot-overlay-{draw,rects,android}.ts`, `ios-ax-tree.ts`, `ios-node-interpretation.ts`, `ios-snapshot-{acquisition,planning}.ts`, `snapshot-quality-*.ts`, `snapshot/ios-snapshot-runtime.ts`, `snapshot/snapshot-desktop-surface.ts`, `durable-capture/labels.ts`.

Estimated totals after three passes: capture-kit production about 85%, selectors production about 100%.

Checked and found clean (no finding):

- `video-webm.ts`: the EBML walk bounds every read by the probe buffer and handles unknown-size Segment and Cluster.
- `recovery-authority.ts`: a late acquisition after a deadline or cancel is disposed (handle, then control) on both paths.
- `rows.ts`, `action-shelf.ts`: descendant walks use the cached end-position table in `tree.ts`, so they are not quadratic.
- `snapshot-freshness/index.ts`: every export has a production consumer.
- `absence-observation-errors.ts`: no test names the builders, but `selector-is.test.ts`, `wait-absent.test.ts`, and `wait-polling.test.ts` in `command-runtime` assert their output.

## Findings

### CAP3-1: React Native overlay hint fires for any label that starts with "Error:" or "Warning:", on every platform
- Category: broken
- Severity: medium     Confidence: high for the logic; medium for how often real apps hit it
- Evidence:
  - `packages/capture-kit/src/react-native-overlay.ts:155-157` — `detected` is true when `collapsedNodes.length > 0`, with no other evidence required.
  - `react-native-overlay.ts:75-79,196-212` — a node is "collapsed" when it has a ref, a rect at most 180 px tall (or no rect), and a label, value, or identifier that passes `isReactNativeCollapsedWarningLabel`.
  - `packages/contracts/src/react-native-overlay.ts:8-12,43-50` — that test accepts `/^(warn|warning|error):\s+/` and `unhandled (promise )?rejection` anywhere in the text.
  - `packages/command-runtime/src/commands/capture/runtime/snapshot.ts:287` calls `formatReactNativeOverlayWarning` for every snapshot with no platform or React Native gate.
  - Net effect: a form that shows "Error: invalid email" gets "React Native warning/error overlay detected … Run: agent-device react-native dismiss-overlay" appended to each snapshot. `react-native-overlay.test.ts:89-101` tests only a `!, Open debugger…` label and a `Save` label.
- Fix: require banner evidence for the collapsed branch (`isSafeCollapsedWarningCoordinateFallback` already has the strict `!, ` / "open debugger" test at `:188-194`), or require a second signal (stack frame, known overlay text) for the generic `error:`/`warning:` prefixes. File: `react-native-overlay.ts`.
- Effort: S
- Model: opus (changes when agents are told to dismiss an overlay; needs a device check on a real LogBox)
- Verify: add cases to `packages/capture-kit/src/react-native-overlay.test.ts`: a 44 px `StaticText` labelled `Error: invalid email` gives no warning; a real collapsed LogBox banner still does.

### CAP3-2: The per-record recovery deadline bounds only the acquisition; the cleanup that follows has no bound and daemon startup awaits it
- Category: broken
- Severity: medium     Confidence: medium (control flow verified; whether a platform `forceCleanup` can hang was not traced)
- Evidence:
  - `packages/capture-kit/src/durable-capture/recovery.ts:140-152` — `recoverBeforeDeadline` awaits `acquireDurableCaptureRecoveryAuthorityBeforeDeadline` and then calls `settleRecoveryAuthority`.
  - `packages/capture-kit/src/durable-capture/recovery-authority.ts:113-116` — the timer is cleared in the `finally` of the acquisition race, so nothing times `settleRecoveryAuthority`.
  - `recovery.ts:165-179,200-204,209` — the settle phase awaits `handle.forceCleanup()`, `control.cleanup(envelope)`, and `control[Symbol.asyncDispose]()`.
  - `packages/daemon/src/server/http/daemon-runtime.ts:582-587` awaits `recoverAppLogResourcesAfterDaemonLock` during startup. The parameter is named `perRecordDeadlineMs` (`recovery.ts:48`), which reads as a bound on the whole record.
  - Related: `recovery.ts:87-99` reports an aborted scope as `…_recovery_failed`, and the loop at `:59-61` then repeats that for every remaining record.
- Fix: run the settle phase under the same `Deadline` (pass the remaining time into `settleRecoveryAuthority` and race it), or rename the parameter to `acquisitionDeadlineMs` and document the unbounded phase. Stop the loop when `params.scope.signal.aborted`. Files: `recovery.ts`, `recovery-authority.ts`.
- Effort: M
- Model: opus (ADR 0024 recovery contract)
- Verify: add a case to `packages/capture-kit/src/durable-capture/recovery.test.ts` where `forceCleanup` never settles; the record must come back `retained` with a `timed_out` diagnostic inside the deadline.

### CAP3-3: `alert wait` times out with no typed reason, while every other alert refusal has one
- Category: inconsistent
- Severity: medium     Confidence: high
- Evidence:
  - `packages/capture-kit/src/alert-tree-driver.ts:147` — `throw new AppError('COMMAND_FAILED', 'alert wait timed out')` with no details.
  - The same file sets `ALERT_NOT_FOUND_REASON`, `ALERT_CAPTURE_UNDECIDED_REASON`, `ALERT_BUTTON_UNDECIDED_REASON`, and `ALERT_WINDOW_EXPIRED_REASON` on every other exit (`:251,:349,:368,:375,:391`).
  - `packages/platform-apple/src/alert.ts:124` throws the same message from a second wait loop, and `packages/platform-apple/src/__tests__/alert.test.ts:107,524` match on the message text. AGENTS.md says to use typed reasons and not match error text.
  - `alert-tree-driver.ts:21-24` calls itself "the one driver for every backend that reads alerts from a capture tree"; its only caller is `packages/platform-android/src/alert.ts`.
  - `packages/contracts/src/alert-contract.ts:31,56,187,195` — two reasons are kebab-case (`alert-not-found`) and two are snake_case (`alert_button_undecided`).
- Fix: throw with `reason: ALERT_WINDOW_EXPIRED_REASON` (or a new `alert-wait-timeout`) at `alert-tree-driver.ts:147` and `platform-apple/src/alert.ts:124`; change the two tests to assert the reason. Correct the header comment.
- Effort: S
- Model: sonnet
- Verify: `pnpm vitest run packages/platform-android/src/__tests__/alert*.test.ts packages/platform-apple/src/__tests__/alert.test.ts`.

### CAP3-4: Runner snapshot presentation validates the same node list twice for every non-interactive regular capture
- Category: inefficient
- Severity: medium     Confidence: high
- Evidence, all in `packages/capture-kit/src/ios-snapshot-engine/runner-presentation.ts`:
  - `:79-85` — `validateRunnerPayloads` runs `validateIosPayload` on `input.presentation.payload.nodes`.
  - `:106-118` — `compactRunnerPayload` returns `[...nodes]` unchanged unless the projection is `regular` and `interactiveOnly` is set.
  - `:120-130` — `validateRunnerOutput` runs `validateIosPayload` again on that copy whenever the projection is `regular`. The second pass can only repeat the first result.
  - Each pass is a graph check plus a per-node clip and actionability check (`invariants.ts:36-65`).
- Fix: skip the second validation when compaction is the identity (return `payloadValidation`). File: `runner-presentation.ts`.
- Effort: S
- Model: sonnet
- Verify: `pnpm vitest run packages/capture-kit/src/ios-snapshot-engine/runner-presentation.test.ts`.

### CAP3-5: Contact-sheet selection and rendering run synchronously on the daemon event loop
- Category: inefficient
- Severity: low     Confidence: medium (cost model from reading; not profiled)
- Evidence:
  - `packages/capture-kit/src/recording/contact-sheet.ts:96-103` — after the frames are decoded on the PNG worker, `selectContactSheetCells` and `renderContactSheet` run in-process.
  - `contact-sheet-selection.ts:49-57` — up to 48 full-frame pixel comparisons (`MAX_CONTACT_SHEET_SAMPLED_FRAMES`, `contact-sheet-plan.ts:7`).
  - `contact-sheet-render.ts:166-174,176-188` — `createCanvas` and `blit` call `setPngPixel` once per pixel, and `blit` allocates a four-element array per pixel.
  - `contact-sheet-render.ts:99` — every cell goes through `resizePngBox` (a four-deep loop, `png-resize.ts:42-79`) even when the cell width equals the decoded width (360 px is the first ladder step, `:23-30`). `resizePngBox` has no same-size return.
  - `contact-sheet-render.ts:77` — `encodePngPixels` is the synchronous encoder.
  - `contact-sheet.ts:134,159` — each frame file is opened twice (`readPngSize`, then `fs.readFileSync`), and all decoded frames stay in memory until selection ends.
- Fix: return the source when `resizePngBox` gets equal dimensions; fill and blit with `Buffer.fill`/`copy` per row; encode with `encodePngAsync`; read each frame file once and check the size from the buffer.
- Effort: S
- Model: sonnet
- Verify: `pnpm vitest run packages/capture-kit/src/recording/contact-sheet*.test.ts` with byte-identical output.

### CAP3-6: `scroll-edge-state/selection.ts` contains raw NUL bytes, so grep-based tools treat it as binary
- Category: broken
- Severity: low     Confidence: high
- Evidence: `packages/capture-kit/src/snapshot/scroll-edge-state/selection.ts:311` — the template literal `` `${identifier}<NUL>${label}<NUL>${value}` `` holds two literal 0x00 bytes. `file` reports the source as `data`, and GNU grep prints "binary file matches" instead of lines (seen during this audit). ripgrep stops at the first NUL, so the Grep tool misses everything after line 311. A scan of `packages/*/src`, `src`, and `scripts` found no other `.ts` file like this. `alert-tree-driver.ts:401` writes the same separator as `'\u0000'`.
- Fix: replace the two bytes with `\u0000` escapes.
- Effort: S
- Model: sonnet
- Verify: `file packages/capture-kit/src/snapshot/scroll-edge-state/selection.ts` reports text; `pnpm vitest run packages/capture-kit/src/snapshot/__tests__/scroll-edge-state-*.test.ts`.

### CAP3-7: A replayed `record stop` checks that the main output file exists, but not the chunk files it also serves
- Category: broken
- Severity: low     Confidence: medium (reader verified; whether a chunk can be removed while `outPath` survives was not traced)
- Evidence: `packages/capture-kit/src/capture-admission/screen-recording-stop-recovery.ts:133-147` — `readReplayableStoredCompletion` returns the stored completion when `fs.existsSync(completion.outPath)`. `isChunks` (`:206-217`) validates only the shape of each `chunk.path`. The doc at `:128-131` says "A caller never receives a path it cannot download". `telemetryPath` is also served unchecked.
- Fix: require `completion.chunks?.every((chunk) => fs.existsSync(chunk.path))`, and drop or check `telemetryPath`.
- Effort: S
- Model: sonnet
- Verify: add a case to `packages/capture-kit/src/capture-admission/__tests__/screen-recording-stop-recovery.test.ts` with a missing chunk file; the reader must return `undefined`.

### CAP3-8: The interactive presentation rules rebuild the same indexes and walk ancestors for every `Other` node
- Category: inefficient
- Severity: low     Confidence: high for the repeated work; medium for its share of capture time
- Evidence, all under `packages/capture-kit/src/ios-snapshot-engine/`:
  - `collectChildrenByParent(nodes)` is built three times for one presentation: `web.ts:24`, `transitions.ts:13`, `noise-structural.ts:13`.
  - `findLargestViewportRect` runs twice: `actions.ts:15` and `noise-viewport.ts:13`.
  - `web.ts:59-60` — every labelled `Other` node calls `findNearestAncestor(isWebView)`, which allocates an ancestor array and a `Set` (`tree.ts:111-125`), even when the tree has no web view.
  - `actions.ts:35` does the same walk for a scroll ancestor.
  - `geometry-policy.ts:102-125,242` — `traversalDecision` normalizes the same rect up to five times and the same type twice per node.
  - `semantic-index.ts:53-55` runs these rules on every interactive iOS capture, including each wait and settle poll.
- Fix: put `childrenByParent` and the viewport rect on `SnapshotTreeRuleContext` (built once in `buildIosInteractiveSnapshotPresentation`); skip the web rule when no node is a web view; compute `normalizeRect` and `normalizeType` once in `traversalDecision`.
- Effort: S
- Model: sonnet
- Verify: `pnpm vitest run packages/capture-kit/src/ios-snapshot-engine`; `scripts/ios-snapshot-differential.test.ts` must still agree with Swift.

### CAP3-9: `parentClipLookups` and its callback plumbing have no reader
- Category: unneeded
- Severity: low     Confidence: high
- Evidence: the counter is produced at `packages/capture-kit/src/ios-snapshot-engine/geometry.ts:36,41-43,90,104-112`, `invariants.ts:44-49,64,67-74`, `runner-presentation.ts:45,78,126-127`, and `engine.ts:128,183`. A repo grep (TypeScript, Swift, scripts, tests) finds no reader. The other three fields of `IosSnapshotPresentationStats` (`types.ts:19-25`) are read only by `engine.test.ts:379` and `geometry-policy.test.ts:134-135`; no production code reads `presentation.stats`.
- Fix: remove `parentClipLookups`, the `onLookup`/`onParentLookup` closures, and the `{ parentClipLookups }` return type of `validateIosPayload`. Keep or drop the remaining stats as test-only data.
- Effort: S
- Model: sonnet
- Verify: `pnpm typecheck`; `pnpm vitest run packages/capture-kit/src/ios-snapshot-engine`.

### CAP3-10: Engine constants and helpers that must agree are written twice, with dead branches
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence, all under `packages/capture-kit/src/ios-snapshot-engine/`:
  - `SCROLL_CONTAINER_TYPES` — `geometry-policy.ts:7` and `invariants.ts:12`. The fold sets a clip with one and the validator checks that clip with the other, so a one-sided edit makes the engine reject its own output.
  - `normalizeRect` — `geometry-policy.ts:255-260` and `invariants.ts:170-176`. Both return `undefined` for a negative size and then apply `Math.max(0, …)`, which cannot change anything.
  - `hasSemanticContent` — `geometry-policy.ts:249-253` and `projection.ts:196-200`.
  - `verticallyOverlaps` — `action-shelf.ts:246-248` and `transitions.ts:116-118`.
  - Rect equality — `geometry.ts:221-228` (`sameRect`) and `scroll.ts:220-228` (`rectsEqual`).
  - `noise-overlay.ts:105-111` — `collectDescendantNodes` rebuilds what `collectDescendants` in `tree.ts:49-57` returns, and `:97-100` calls it twice for one node.
  - `invariants.ts:159-167` — the `catch` tests `error.code === 'IOS_SNAPSHOT_ENGINE_FAILED'` (always true for that class) and ends in two identical `throw error` statements.
- Fix: export one `SCROLL_CONTAINER_TYPES`, `normalizeRect`, and `hasSemanticContent` from `geometry-policy.ts` (or `tree.ts`) and import them; delete the dead `Math.max` and the redundant `catch` branch; use `collectDescendants` in `noise-overlay.ts`. Check Swift parity before removing the `Math.max` lines.
- Effort: S
- Model: sonnet
- Verify: `pnpm vitest run packages/capture-kit/src/ios-snapshot-engine`.

### CAP3-11: The `perf` request parser reads `kind` from a positional for cpu and trace, names `--kind` in its error, and accepts trailing tokens
- Category: inconsistent
- Severity: low     Confidence: medium (parser verified; the CLI writer currently always fills the positional)
- Evidence, all in `packages/capture-kit/src/capture-admission/perf-runtime-plan.ts`:
  - `:142` — the memory branch reads `input.kind ?? values[2]`.
  - `:170-173,194-197` — the cpu and trace branches read only `values[3]` / `values[2]` and then throw "requires --kind …". A daemon request with `flags.kind` and no kind positional is refused with a message that tells the caller to pass what it passed.
  - `:174-183,198-205` — template, out path, and trace path are positional slots with `''` placeholders (`packages/command-surface/src/perf/index.ts:112-124`). Tokens past the last slot are ignored for cpu and trace, while frames and memory reject extras (`:105-114,136-141`).
  - `perf-runtime-plan.test.ts:29-41` is titled "maps every accepted request to its single runtime use" and covers 3 of the 6 plan kinds; no test covers a trace request or a cpu start/stop.
  - The file is a CLI grammar parser inside `capture-admission/`.
- Fix: read `input.kind ?? values[n]` in both branches, reject extra positionals, and add table tests for all six plan kinds. Optionally move the file beside the other runtime plans.
- Effort: S
- Model: sonnet
- Verify: `pnpm vitest run packages/capture-kit/src/capture-admission/perf-runtime-plan.test.ts` and the daemon perf suites.

### CAP3-12: A screen-recording start scans every session directory twice with sync I/O and reads its own record three times
- Category: inefficient
- Severity: low     Confidence: high
- Evidence:
  - `packages/daemon/src/sessions/handlers/record-runtime.ts:262` calls `settleStartConflicts`, then `:322` calls `createNextFence`.
  - `packages/capture-kit/src/capture-admission/durable-capture-resource.ts:123` and `durable-capture-start-preflight.ts:22,86` each run `listDurableCaptureStartConflicts`.
  - `durable-capture-start-preflight.ts:59-60` — that is one `readdirSync` plus an `lstat` per session directory (`durable-capture/store.ts:65-77`) and one open, read, and `JSON.parse` per record.
  - `durable-capture-start-preflight.ts:23` reads the start's own record again for the generation.
  - Smaller item in the same directory: `app-log-files.ts:17-19,37-39` — `existsSync` before a recursive `mkdirSync`, and a `void lstatAppLogFile(outPath)` whose result `rotateAppLogIfNeeded` fetches again on the next line.
- Fix: let `settleStartConflicts` return the post-settle conflict list and pass it to `createNextFence`; take the generation from the list entry at `resourcePath` when present.
- Effort: S
- Model: sonnet
- Verify: `pnpm vitest run packages/capture-kit/src/capture-admission/__tests__/durable-capture-start-preflight.test.ts packages/capture-kit/src/capture-admission/__tests__/durable-capture-resource.test.ts`.

### CAP3-13: Contact-sheet cells report a change ratio measured against a cell the sheet no longer shows
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence:
  - `packages/capture-kit/src/recording/contact-sheet-selection.ts:50-57` measures each kept cell against the previous kept cell. `:61,96-103` — `thinEvenly` then drops cells and keeps the old ratios.
  - `contact-sheet-report.ts:30-31` documents `changedPixelRatio` as "since the previously kept cell", and `contact-sheet.ts:115` publishes it per printed cell.
  - `contact-sheet.ts:134,159` — a frame that is not a valid PNG fails in `readPngSize` or `decodePngAsync` with no `reason`, although `contact-sheet-frames.ts:231-242` says no failure may leave the typed taxonomy.
  - `contact-sheet-render.ts:59` — the layout uses the first cell's aspect ratio for all cells; a frame with another shape (the case `contact-sheet-selection.ts:92` handles) is stretched.
  - `contact-sheet-frames.ts:265-282` — `compileDecoder` takes `signal` and does not pass it to the 120 s compile.
- Fix: recompute ratios after thinning (or document them as pre-thinning); wrap frame decode errors with `CONTACT_SHEET_EXTRACTION_REASON`; letterbox mismatched frames.
- Effort: S
- Model: sonnet
- Verify: `pnpm vitest run packages/capture-kit/src/recording/contact-sheet-selection.test.ts packages/capture-kit/src/recording/contact-sheet.test.ts`.

### CAP3-14: Two `isDescendantOf` walks in selectors, both run once per snapshot node
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence:
  - `packages/selectors/src/interaction-touch-point.ts:90-105` exports `isDescendantOf`; `packages/selectors/src/press-retarget.ts:52-68` defines a private copy with the same body.
  - `interaction-touch-point.ts:73-79` and `press-retarget.ts:71-76` each call it for every node, with a new `Set` per call. `interaction-touch-point.ts:75,79` runs the walk before the cheap `isSemanticTouchTarget` filter.
  - `resolveInteractionTouchPoint` runs on every ref or selector press.
  - More copies: `packages/capture-kit/src/screenshot-overlay.ts:331` (CAP2-3), `screenshot-overlay-android.ts:121`, `packages/maestro/src/internal/snapshot-policy.ts:29`.
- Fix: import the exported `isDescendantOf` in `press-retarget.ts`; apply `isSemanticTouchTarget` first in `collectInteractiveDescendantRects`; or build one children map and walk down from the target.
- Effort: S
- Model: sonnet
- Verify: `pnpm vitest run packages/selectors/src/interaction-touch-point.test.ts src/core/press-retarget.test.ts`.

### CAP3-15: Point targets parse with `Number()`, so an empty string is coordinate 0 and extra tokens are ignored
- Category: broken
- Severity: low     Confidence: medium (parser verified; an earlier CLI layer may reject some forms)
- Evidence: `packages/selectors/src/interaction-positionals.ts:106-109` — `Number('')` and `Number(' ')` are 0, and `Number('0x10')` is 16, so `press "" 40` taps (0, 40). `readInteractionTargetFromPositionals` (`:55`) passes all positionals and `readPointTarget` reads only the first two, so `press 10 20 30` taps (10, 20) with no error. The selector branch at `:47-52` does reject trailing tokens.
- Fix: accept only `/^-?\d+(\.\d+)?$/` tokens and refuse a third positional for click, press, and longpress.
- Effort: S
- Model: sonnet
- Verify: `pnpm vitest run packages/selectors/src/interaction-positionals.test.ts` with cases for `['', '40']` and `['10', '20', '30']`.

### CAP3-16: Small drift in capture-admission and snapshot-freshness
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence:
  - Each durable kind has two display names with different casing: the store (`app-log-resource-store.ts:6` `App-log`, `audio-probe-resource-store.ts:6` `Audio probe`, `perf-capture-resource-store.ts:6` `Perf capture`, `screen-recording-resource-store.ts:7` `screen recording`) and the definition (`app-log-durable-resource.ts:49`, `audio-probe-session-resource.ts:24`, and so on). The store name starts error messages (`durable-capture/store.ts:51`), so screen-recording messages start in lower case and the others do not.
  - `app-log-durable-resource.ts:6-12` lists the `LogBackend` values by hand; `packages/contracts/src/logs.ts:9` declares the union with no shared tuple. A new backend type-checks and its stored completion is then refused at `:28`.
  - `snapshot/snapshot-freshness/types.ts:20-21` — the comment says the reason is "`null` when the capture looked trustworthy"; the type has no `null`.
  - `snapshot/snapshot-freshness/recovery.ts:57` — the retry sleep takes no signal, so a cancelled request waits out up to 600 ms per retry.
- Fix: keep one `displayName` per kind (pass the definition's name to the store); export a `LOG_BACKENDS` tuple from `contracts/logs` and derive the type; correct the comment.
- Effort: S
- Model: sonnet
- Verify: `pnpm typecheck`; `pnpm vitest run packages/capture-kit/src/capture-admission`.

### CAP3-17: One test in the two packages has no assertion
- Category: broken (weak test)
- Severity: low     Confidence: high
- Evidence: `packages/selectors/src/keyboard-occlusion.test.ts:122-124` — "a target with no measurable point cannot be refused" only calls `guard(...)`, a `void` helper (`:41-58`). It passes whenever the call does not throw and says nothing about the path taken. The scan of all 169 test files in `capture-kit/src` and `selectors/src` found no other assertion-less block and no test title duplicated across files.
- Fix: wrap the call in `expect(() => guard(...)).not.toThrow()`, and add the twin case with a real tap point that does throw, so the pair pins the `tapPoint: null` branch.
- Effort: S
- Model: sonnet
- Verify: `pnpm vitest run packages/selectors/src/keyboard-occlusion.test.ts`; mutate the null-point guard and confirm a failure.
