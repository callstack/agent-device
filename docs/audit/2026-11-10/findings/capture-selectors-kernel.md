# Audit: SLICE CAP — capture-kit, selectors, xml, kernel

## Coverage

Read-only audit. No gates, tests, or builds were run. All paths are relative to `/home/user/agent-device`.

| Package | Prod lines | Read fully | Skimmed | Not reached |
| --- | --- | --- | --- | --- |
| `packages/xml` | ~375 | 100% | - | - |
| `packages/kernel` | ~4.9k | ~65%: `snapshot.ts`, `rect.ts`, `rect-center.ts`, `screenshot-geometry.ts`, `bounds.ts`, `numeric.ts`, `collections.ts`, `validation.ts`, `scroll-indicator.ts`, `redaction.ts`, `success-text.ts`, `source-value.ts`, `device-identity.ts`, `device-isolation.ts`, `scoped-provider.ts`, `location-coordinates.ts`, `ttl-memo.ts`, `keyed-lock.ts`, `await-with-signal.ts`, `record.ts`, `device-shell.ts`, `errors.ts` | export surface of `device.ts`, `contracts.ts` | bodies of `device.ts` (1000 lines), `contracts.ts` |
| `packages/selectors` | ~5.3k | ~55%: all of `internal/*` (parse, match, node, resolve, resolve-with-policy, resolution-policy, build, find, replay, predicates, arguments, facade-engine), `index.ts`, `ast.ts`, `engine.ts`, `selector-pipeline.ts`, `interaction-targeting.ts`, `touch-semantics.ts` | `node-touch-point.ts`, `interaction-error.ts` | `parameterized-recorded-fill.ts`, `target-evidence.ts`, `absence-observation*.ts`, `keyboard-occlusion.ts`, `interaction-touch-point.ts`, `press-retarget.ts`, `selector-pipeline-policy.ts`, `interaction-positionals.ts` |
| `packages/capture-kit` | ~27k prod (53k with tests) | ~20%: snapshot core — `snapshot-occlusion.ts`, `snapshot-state.ts`, `snapshot-tree-ingestion.ts`, `snapshot-node-lookup.ts`, `snapshot-baseline.ts`, `snapshot-chrome.ts`, `mobile-snapshot-semantics.ts`, `snapshot/snapshot-diff.ts`, `snapshot/snapshot-lines.ts`, `snapshot/snapshot-label-dedup.ts`, `snapshot/snapshot-visibility.ts`, `snapshot/rect-coverage.ts`, `snapshot/snapshot-presentation/android/{helper,structural-noise,tree}.ts`, `snapshot-router/router.ts`, `observe-until.ts`, `post-gesture-stability.ts`, `png-worker-client.ts`, `internal-entry.ts` | role/type lists in `screenshot-overlay.ts`, `snapshot-desktop-projection.ts`, `ios-snapshot-engine/{projection,geometry-policy,scroll}.ts`, `quality-warnings.ts` | `ios-snapshot-engine/*` internals, `snapshot/scroll-edge-state*`, `snapshot-freshness/*`, `durable-capture/*`, `capture-admission/*`, `recording/*`, `network-traffic*`, `app-log*`, `audio-probe*`, `screenshot-diff*`, `screenshot-overlay*`, PNG codecs, almost all test files |

Repo-wide checks done:
- Grep for selector parsing or matching outside `@agent-device/selectors` (one hit, CAP-10).
- Package subpath export usage for all four packages (CAP-17).
- Skipped/todo tests and assert-less tests in the slice: none found.
- TODO/FIXME/HACK markers in slice prod code: none found.

`docs/agents/selector-capture.md`: the invariants I could check inside this slice hold. `is` goes through `evaluateIsPredicate`, selector keys live only in `packages/selectors/src/internal/parse.ts`, and the direct iOS fast path uses `readSimpleSelectorTarget` (one term, `id|label|text|value`). The contradictions I found are CAP-10 (a hand-rolled matcher) and CAP-12 (hint text against match semantics). Most of that document's rules (snapshot cache, polling artifacts, mutation boundary, Maestro) are enforced in `daemon`/`command-runtime`, outside this slice.

Not verified, for the owner of the Apple runner slice: the TypeScript matcher is case-insensitive and collapses whitespace (`packages/selectors/src/internal/find.ts:161`). If the Swift direct-selector path counts "raw exact matches" case-sensitively, the fast path and snapshot resolution can disagree on ambiguity for the same selector.

## Findings

### CAP-1: Android helper presentation rescans the whole node array for every descendant
- Category: inefficient
- Severity: medium     Confidence: high
- Evidence:
  - `packages/capture-kit/src/snapshot/snapshot-presentation/android/tree.ts:18-30` — `collectDescendants` runs `for (const node of nodes)` once per popped node, so one call costs O(n x subtree size).
  - `tree.ts:32-46` — `markNodeAndDescendantsForRemoval` has the same shape.
  - `structural-noise.ts:18` and `structural-noise.ts:74` call `collectDescendants` for every hittable row; `structural-noise.ts:28,80,94,221` and `helper.ts:59,76` call the removal walk per node.
  - `structural-noise.ts:144-155` — `isPromotableRowContent` runs `descendants.some(...)` per descendant, which is O(subtree squared).
  - `helper.ts:89-97` — `inferRectlessNodeDirection` filters all nodes per rect-less node.
  - Net cost is O(n squared) or worse on each Android helper snapshot rendered as text. Nested hittable containers multiply it.
- Fix: build one `childrenByParent` map in `filterAndroidHelperTextOutputNodes` (`helper.ts:39`) and pass it to `collectDescendants`, `markNodeAndDescendantsForRemoval`, `isPromotableRowContent`, and `inferRectlessNodeDirection`. Files: `android/tree.ts`, `android/structural-noise.ts`, `android/helper.ts`.
- Effort: S
- Model: sonnet
- Verify: `pnpm vitest run packages/capture-kit/src/snapshot/snapshot-presentation/android/helper.test.ts`, with output unchanged on `settings-home.fixture.json`. Add a 3k-node synthetic tree timing assertion.

### CAP-2: Snapshot diff copies a Map per edit step, so cost is quadratic in the edit distance
- Category: inefficient
- Severity: medium     Confidence: high
- Evidence:
  - `packages/capture-kit/src/snapshot/snapshot-diff.ts:94-99` — `trace.push(new Map(v))` runs for every `d`. Total copied entries are about D squared over 2, where D is the edit distance.
  - Two unrelated screens of 1.5k lines each give D of about 3k, which is about 4.5M Map entries held until backtrack.
  - The comment at `snapshot-diff.ts:90` admits "very large trees may still be expensive". There is no common prefix/suffix trim and no size guard.
  - This runs on every `--settle` (`packages/command-runtime/src/commands/interaction/runtime/settle.ts:290`) and every `diff snapshot` (`packages/command-runtime/src/commands/capture/runtime/snapshot.ts:159`). Navigating to a new screen is the worst case and also the common case.
  - Related: `countSnapshotComparableLines` (`snapshot-diff.ts:61-66`) renders every display line and comparable key only to return `.length`.
- Fix: trim the common prefix and suffix before running Myers. Store `v` as an `Int32Array` of size `2*max+1` and keep per-`d` slices of length `2d+1` (or use the linear-space variant). Make `countSnapshotComparableLines` count without formatting. File: `snapshot/snapshot-diff.ts`.
- Effort: M
- Model: sonnet
- Verify: existing snapshot-diff tests under `packages/capture-kit/src/snapshot/__tests__/` stay green. Add a property test (same summary counts as the current implementation) and a 2x3000-line disjoint benchmark.

### CAP-3: Redaction reports any repeated object reference as `[Circular]`
- Category: broken
- Severity: medium     Confidence: high
- Evidence: `packages/kernel/src/redaction.ts:34-35` — `seen.add(value)` is never undone after the subtree is processed. A non-cyclic value such as `{ a: shared, b: shared }` serializes `b` as `'[Circular]'`. `redactDiagnosticData` runs on every `AppError.details` in `normalizeError` (`packages/kernel/src/errors.ts:455`), so details that reuse one object (for example the same rect or node under two keys) lose data on the wire. `redaction.test.ts` has no shared-reference case.
- Fix: track the current ancestor path only. Delete the value from `seen` after processing its children (wrap in try/finally), or pass an ancestor stack. File: `packages/kernel/src/redaction.ts`.
- Effort: S
- Model: sonnet
- Verify: add a test to `packages/kernel/src/redaction.test.ts` where a shared non-cyclic object appears twice and both copies survive, and a true cycle still yields `[Circular]`.

### CAP-4: Keyboard frame guard claims to equal `isPositiveFiniteRect` but skips two of its three refusals
- Category: broken
- Severity: medium     Confidence: high that the rules diverge; medium that a runner emits such a frame
- Evidence:
  - `packages/kernel/src/record.ts:154-162` — the comment says "Same rule as `isPositiveFiniteRect` in kernel/rect, inlined". The inline check tests only finite components and positive extents.
  - `packages/kernel/src/rect.ts:34-41` — the real guard also refuses an overflowing `x + width` / `y + height` and the `CGRectInfinite` sentinel.
  - `CGRectInfinite` (`rect.ts:8-13`) has four finite components and positive extents, so a failed keyboard frame read passes `readKeyboardFrameFact` as `{ kind: 'visible', frame: <infinite> }`. That would put every tap target under the keyboard. The #2891 guard was written for exactly this input.
- Fix: complete the inline rule in `record.ts` (add the overflow check and an extents check of `>= Number.MAX_VALUE`). Add a parity test that feeds one rect table to both `readSnapshotKeyboardBandFact` and `isPositiveFiniteRect`. Files: `packages/kernel/src/record.ts`, `packages/kernel/src/record.test.ts`.
- Effort: S
- Model: sonnet
- Verify: new parity test. `readSnapshotKeyboardBandFact({ kind: 'visible', frame: CGRectInfinite })` returns `unmeasurable`.

### CAP-5: Occlusion scan repeats classification and ancestor walks for every target-overlay pair
- Category: inefficient
- Severity: medium     Confidence: medium (cost model from reading; not profiled)
- Evidence, all in `packages/capture-kit/src/snapshot-occlusion.ts`:
  - `:246-256` loops over all overlay positions for every candidate touch node.
  - `:306` re-runs `isOverlayLikeNode` per pair. The file's own note at `:223-226` says this check is provably redundant. It costs an ancestor walk with a new `Set` (`:502-522`), a sibling scan (`:384`), and `normalizeNodeKind` (`:589-591`, three `normalizeType` calls and a join) up to four times.
  - `:307` does two more ancestor walks with fresh `Set`s (`:593-615`).
  - `:295` — the cheap `containsPoint` test that rejects almost every pair runs last.
  - `buildSnapshotState` calls this on every non-raw capture, including each wait and settle poll (`packages/capture-kit/src/snapshot-state.ts:104`).
- Fix: precompute per overlay position `{ rect, kindString }` once when `overlayPositions` is built. In `canCoverPoint`, test `containsPoint(candidateRect, center)` and the rect-equality check first, then relatedness and toolbar reach. Remove the redundant `isOverlayLikeNode` call at `:306`. Cache `normalizeNodeKind` per node index. File: `snapshot-occlusion.ts`.
- Effort: M
- Model: opus (the ordering interacts with the reentrancy cache at `:233-239`)
- Verify: `pnpm vitest run packages/capture-kit/src/snapshot-occlusion.test.ts packages/capture-kit/src/snapshot-occlusion-sibling-sized-chrome.test.ts` plus the mutation lane for this file.

### CAP-6: One settle classifies keyboard and system chrome on the same nodes up to three times
- Category: inefficient
- Severity: medium     Confidence: high
- Evidence:
  - `packages/capture-kit/src/snapshot-chrome.ts:347-368` — `withoutSettleChrome` and `collectSettleChromeRefs` each call `collectSettleChrome` and keep half of the result.
  - `packages/command-runtime/src/commands/interaction/runtime/settle.ts:292`, `:345`, and `:395` call them on the same `settledNodes` and `appBundleId` within one settle.
  - Each call runs four full `nodes.filter(hasIosKeyboardRole...)` passes before its early return (`snapshot-chrome.ts:86-118`), up to three unmemoized `collectSubtreeIndexes` ancestor walks (`:229-240`), and the Android pass (`:281-316`).
- Fix: export one `collectSettleChrome(nodes, appBundleId)` that returns `{ strippedIndexes, refs }`. Compute it once in `buildSettleDiffAndTail` and pass it down. Fold the four role filters into one pass. Files: `packages/capture-kit/src/snapshot-chrome.ts`, `packages/command-runtime/src/commands/interaction/runtime/settle.ts` (other slice).
- Effort: S
- Model: sonnet
- Verify: `pnpm vitest run packages/capture-kit/src/snapshot-chrome.test.ts` and the settle tests in `packages/command-runtime`.

### CAP-7: The post-gesture surface cache never hits, so every poll's signature is computed twice
- Category: inefficient
- Severity: low     Confidence: high
- Evidence: `packages/capture-kit/src/post-gesture-stability.ts:196-202` keeps one slot. The verdict at `:209-213` calls `surfaceOf(latest)` and then `surfaceOf(previousValue)`. The second call always evicts the first, and on the next poll the slot holds the older value again. `hooks.readSurface`, a whole-tree signature, therefore runs twice per captured value.
- Fix: carry the previous `CapturedSurface` forward in a closure variable (previous = current at the end of the verdict) and delete the cache. File: `post-gesture-stability.ts`.
- Effort: S
- Model: sonnet
- Verify: in `packages/capture-kit/src/post-gesture-stability.test.ts`, count `readSurface` calls and assert one per capture.

### CAP-8: `isRequestCanceledError` falls back to matching the error message
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence: `packages/kernel/src/errors.ts:387-393` returns `error.message === REQUEST_CANCELED_MESSAGE` when `details.reason` is absent. AGENTS.md says to use typed reasons and not match error text. `createRequestCanceledError` (`errors.ts:364-371`) is the only producer of that message in TypeScript and always sets `reason: 'request_canceled'`. `throwDaemonError` keeps details across the wire. The fallback is therefore a superseded path.
- Fix: delete the message fallback at `errors.ts:393`. File: `packages/kernel/src/errors.ts` and its tests.
- Effort: S
- Model: sonnet
- Verify: `pnpm vitest run packages/kernel/src/errors*.test.ts`. Grep `'request canceled'` shows no other producer in the Swift and Kotlin helpers.

### CAP-9: `details.ref` is bare on some refusal reasons and `@`-prefixed on others
- Category: inconsistent
- Severity: medium     Confidence: high
- Evidence:
  - `packages/selectors/src/node-touch-point.ts:148` says "`details.ref` is the bare ref body on every reason".
  - `node-touch-point.ts:127` strips the `@` for `target_bounds_invalid`.
  - `node-touch-point.ts:137-138` spreads the raw details for `covered_by_interactive_descendants`. The caller at `packages/command-runtime/src/commands/interaction/runtime/ref-target-resolution.ts:131` passes `@e12`, so this reason publishes `@e12`.
  - `packages/selectors/src/interaction-error.ts:65` (`target_covered`) and `packages/selectors/src/keyboard-occlusion.ts:123` publish `@${ref}`. `interaction-error.ts:19-20` documents `ref_not_found` as bare.
  - `covered_by_interactive_descendants` is a string literal that is not in `INTERACTION_ERROR_REASONS` (`interaction-error.ts:15-44`).
- Fix: choose one wire shape (bare, as the registry documents) and apply `bareTargetDetails` on all four producers. Register `coveredByInteractiveDescendants` in `INTERACTION_ERROR_REASONS`. Check client readers such as `readElementMatchCandidateRefs`. Files: `selectors/src/{node-touch-point,interaction-error,keyboard-occlusion}.ts` and consumers in `command-output`.
- Effort: M
- Model: opus (wire contract change with client-visible details)
- Verify: add a contract test that asserts `details.ref` matches `/^e\d+$/` for every reason, then the affected suites.

### CAP-10: A daemon test fake re-implements selector parsing and matching
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence: `packages/daemon/src/__tests__/support/touch-command-surface-fake.ts:470-484` splits on `' || '`, applies its own `key=value` regex, compares with `===`, and derives `role` by stripping `XCUIElementType`. Production matching is case-insensitive, collapses whitespace, decodes escapes, and uses `roleSpellingsOfNode`. AGENTS.md says to use `@agent-device/selectors` to parse and match selectors. Tests built on this fake can pass on selectors that production resolves differently.
- Fix: replace `nodeMatchesSelector` with `listSelectorChainMatches` from `@agent-device/selectors/ast`, or route the fake through the selector pipeline. File: `touch-command-surface-fake.ts` (other slice).
- Effort: S
- Model: sonnet
- Verify: the daemon test suites that import this fake.

### CAP-11: `ROLE_HINT_WORDS` cites a moved table and has drifted from it
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence:
  - `packages/selectors/src/internal/parse.ts:57-62` says the set is a superset of `ROLE_LABELS` in `packages/capture-kit/src/snapshot/snapshot-lines.ts` and is kept local "to avoid a selectors -> snapshot layering dependency".
  - `ROLE_LABELS` now lives in `packages/kernel/src/snapshot.ts:495-538`. `selectors` already depends on kernel and on capture-kit (`packages/selectors/package.json` dependencies).
  - The set is not a superset: `heading`, `activityindicator`, and `progressindicator` (`snapshot.ts:524-526`) are absent from `parse.ts:63-108`. So `heading="Title"` gets no role hint.
- Fix: export the key list of `ROLE_LABELS` from `@agent-device/kernel/snapshot` and derive `ROLE_HINT_WORDS` from it plus the extra words. Delete the stale comment. Files: `kernel/src/snapshot.ts`, `selectors/src/internal/parse.ts`.
- Effort: S
- Model: sonnet
- Verify: `pnpm vitest run packages/selectors/src/internal/parse-unknown-key.test.ts`, with an added case for `heading=`.

### CAP-12: The no-match hint says values "match exactly"; matching ignores case and collapses whitespace
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence: the hint is at `packages/selectors/src/internal/resolve.ts:186`. `textEquals` (`packages/selectors/src/internal/match.ts:55-57`) compares `normalizeText` of both sides, and `normalizeText` (`packages/selectors/src/internal/find.ts:161-163`) trims, lowercases, and collapses whitespace runs.
- Fix: reword the hint to "match the whole value (case-insensitive)", or make matching exact if that is the intended contract. If the semantics change, update the versioned CLI help. File: `selectors/src/internal/resolve.ts`.
- Effort: S
- Model: sonnet
- Verify: the snapshot test of the hint text. `pnpm vitest run packages/selectors`.

### CAP-13: Two "semantic touch target" role lists disagree
- Category: inconsistent
- Severity: low     Confidence: medium
- Evidence:
  - `packages/selectors/src/touch-semantics.ts:4-16` has `securetextfield` (redundant, since `textfield` already matches it as a substring), an exact `tab`, and no `edittext`.
  - `packages/capture-kit/src/snapshot-occlusion.ts:39-51` has `edittext` and no `tab`.
  - An Android `EditText` is a touch candidate for the occlusion scan but not a semantic target for `isSemanticTouchTarget`, which drives promotion and wrapper collapse in `interaction-targeting.ts:124,196,301`.
  - A third variant is at `packages/capture-kit/src/mobile-snapshot-semantics.ts:319-336`, and a fourth at `packages/capture-kit/src/screenshot-overlay.ts:29-41`.
- Fix: move one `isSemanticTouchKind(node)` into capture-kit (selectors already imports `@agent-device/capture-kit/snapshot-occlusion`) and consume it from `touch-semantics.ts` and `snapshot-occlusion.ts`. Decide `edittext` and `tab` explicitly.
- Effort: M
- Model: opus (changes promotion on Android fields; needs a device check)
- Verify: `pnpm vitest run packages/selectors/src/interaction-targeting.test.ts packages/capture-kit/src/snapshot-occlusion.test.ts`, then manual Android fill and press on an `EditText`.

### CAP-14: `find` argument parsing silently drops an invalid wait timeout and trailing tokens
- Category: broken
- Severity: low     Confidence: medium (parser verified; the typed CLI reader in `command-surface` may catch some cases first)
- Evidence, all in `packages/selectors/src/internal/find.ts`:
  - `:286-290` — `parseTimeout('abc')` returns `null`, so `find X wait abc` runs with the default timeout and no error. Negative values are accepted.
  - `:249` — bare actions return without checking the remaining tokens, so `find X click extra junk` and `find X exists 5000` succeed and ignore the rest.
  - `:239-243` — a first argument equal to a locator word is always taken as the locator, so `find label` fails with "find requires a value" instead of searching for the text "label".
- Fix: return `INVALID_ARGS` from `checkFindArgs` for a non-numeric or negative timeout and for extra tokens after a bare action. File: `find.ts` plus `find-args.test.ts`.
- Effort: S
- Model: sonnet
- Verify: `pnpm vitest run packages/selectors/src/internal/find-args.test.ts`.

### CAP-15: Enum-set flags accept a different boolean vocabulary than boolean flags
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence: `packages/kernel/src/source-value.ts:128-132` accepts only `''`, `true`, `1`, `false`, `0`, and is case-sensitive. `parseBooleanLiteral` at `:109-114` accepts `1|true|yes|on` and `0|false|no|off`, case-insensitively. An env var set to `yes` or `TRUE` works for a boolean flag and throws for an enum-set flag. An empty string is true for an enum-set flag and an error for a boolean flag.
- Fix: route `parseEnumSetValue` through `parseBooleanLiteral`. Keep `''` meaning set only if it is documented. File: `source-value.ts`.
- Effort: S
- Model: sonnet
- Verify: `pnpm vitest run packages/kernel/src/source-value.test.ts`.

### CAP-16: `formatSnapshotLine`'s `hiddenGroup` parameter is never true in production
- Category: unneeded
- Severity: low     Confidence: high
- Evidence: the parameter and its branch are at `packages/capture-kit/src/snapshot/snapshot-lines.ts:58,74-76`. Every production call passes `false`: `snapshot-lines.ts:49,101`, `snapshot-diff.ts:74`, `packages/command-output/src/output/snapshot.ts:389`. The only `true` is in `snapshot/__tests__/snapshot-lines-custom-actions.test.ts:74`.
- Fix: remove the parameter and branch, and update callers and that test.
- Effort: S
- Model: sonnet
- Verify: `pnpm typecheck`, then `pnpm vitest run packages/capture-kit/src/snapshot/__tests__ packages/command-output/src/output/snapshot.test.ts`.

### CAP-17: Package subpath exports with no consumer outside their own package
- Category: unneeded
- Severity: low     Confidence: high
- Evidence: a repo-wide grep for each specifier finds only `scripts/layering/package-boundaries.test.ts`, which pins the export list at `:474-540` and `:781-793`.
  - `@agent-device/capture-kit/durable-json` — the file is used only by the relative import in `durable-resource-envelope.ts`.
  - `@agent-device/capture-kit/screenshot-diff-pixels` — used only by `png-worker*.ts`, relatively.
  - `@agent-device/capture-kit/durable-capture-runtime-recovery` — used only by `capture-admission/*-resource-recovery.ts`, relatively.
  - `@agent-device/selectors/interaction-touch-point` — used only by `node-touch-point.ts`, relatively.
  - `@agent-device/capture-kit/android-replacement-surface-occlusion` and `@agent-device/selectors/touch-semantics` have no production importer outside the package. One root test (`src/__tests__/android-snapshot-occlusion-context.test.ts`) and one e2e file use them.
- Fix: drop the four unused entries from the two `package.json` files and from the pinned lists in `scripts/layering/package-boundaries.test.ts`. Fallow treats subpath exports as entry points, so removal also exposes any now-dead inner exports.
- Effort: S
- Model: sonnet
- Verify: `pnpm typecheck`, then `pnpm vitest run scripts/layering/package-boundaries.test.ts`.

### CAP-18: Nine "Mutation-lane note" comment blocks keep guards the notes call provably redundant
- Category: unneeded
- Severity: low     Confidence: high
- Evidence: `packages/capture-kit/src/snapshot-occlusion.ts:102-106, 119-123, 214-226, 315-317, 325-329, 370-374, 533-538, 555-559, 583-588`. Each note explains that the code below it cannot change behavior. AGENTS.md allows comments only for public APIs, tool directives, or constraints code cannot show, and the notes describe dead guards rather than constraints. One of those guards is the hot-path cost in CAP-5 (`:306`).
- Fix: delete the redundant guards (the `nodes.length < 2` return, the re-check at `:306`, the `!candidate` checks, the `typeof parentIndex` ternaries) together with their notes. Keep only the reentrancy note at `:235-238`.
- Effort: S
- Model: sonnet
- Verify: the occlusion test files plus the mutation gate for `snapshot-occlusion.ts` (survivor count should drop).

### CAP-19: `markNodeAndAncestorsVisible` walks to the root for every visible node
- Category: inefficient
- Severity: low     Confidence: high
- Evidence: `packages/capture-kit/src/mobile-snapshot-semantics.ts:352-365` allocates a `visited` Set per node and does not stop at an ancestor that is already in `visibleNodeIndexes`. The cost is O(n x depth) for every mobile presentation, and `buildSnapshotVisibility` (`snapshot/snapshot-visibility.ts:23`) and `deriveMobileSnapshotHiddenContentHints` call it too.
- Fix: break when `visibleNodeIndexes.has(current.index)` (the ancestors are already marked) and drop the per-call Set.
- Effort: S
- Model: sonnet
- Verify: `pnpm vitest run packages/capture-kit/src/mobile-snapshot-semantics.test.ts`.

### CAP-20: Selector matching re-normalizes the query and re-derives role spellings for every node
- Category: inefficient
- Severity: low     Confidence: medium
- Evidence:
  - `packages/selectors/src/internal/match.ts:55-57` — `normalizeText(query)` (trim, lowercase, regex replace) runs per node per term.
  - `match.ts:67-70` with `node.ts:42-46` — `roleSpellingsOfNode` runs `formatRole` (up to seven regex replaces, `packages/kernel/src/snapshot.ts:546-568`) and `normalizeType` per node, although `attachRefs` already published `kind`.
  - This runs over the whole tree on every wait poll and every chain alternative (`resolve.ts:146-151, 243-250`).
- Fix: compile the `Selector` once per resolve into terms with pre-normalized values, and read `node.kind` first.
- Effort: S
- Model: sonnet
- Verify: `pnpm vitest run packages/selectors/src/internal/match.test.ts packages/selectors/src/internal/resolve*.test.ts`.

### CAP-21: capture-kit re-implements rect helpers that kernel already exports
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence:
  - `rectArea`: `packages/kernel/src/rect.ts:103`, `packages/capture-kit/src/screenshot-overlay-rects.ts:15`, and `packages/capture-kit/src/ios-snapshot-acquisition.ts:120` (this one returns 0 for invalid rects).
  - Intersection: `kernel/src/rect.ts:95` (`intersectRects`), `kernel/src/screenshot-geometry.ts:18` (`intersectArea`), `capture-kit/src/ios-snapshot-engine/geometry-policy.ts:270-284`, `capture-kit/src/ios-snapshot-engine/scroll.ts:211-218`, `capture-kit/src/snapshot-rect-projection.ts:69`. The empty-intersection result differs among them: `undefined`, a zero-size rect at `left`, or a clamped rect.
  - `clamp`: `screenshot-overlay-rects.ts:10`, `screenshot-diff-region-overlay.ts:66`, `react-native-overlay.ts:298`.
  - `geometry-policy.ts:279-280` — the ternaries `rightEdge > x ? x : left.x` are dead after the early return at `:275`.
- Fix: use `kernel/rect` for area and intersection where the semantics match. Name the remaining variants by their empty-case contract. Delete the dead ternaries (check Swift parity first, since `geometry-policy.ts` mirrors the runner).
- Effort: M
- Model: sonnet
- Verify: `pnpm vitest run packages/capture-kit/src/ios-snapshot-engine packages/capture-kit/src/screenshot-overlay*.test.ts`.

### CAP-22: The capture-kit package description does not describe the package
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence: `packages/capture-kit/package.json:6` says "process execution, diagnostics, archives, PNG tooling, and request-scoped plumbing". Process execution and diagnostics are in `@agent-device/host-kit` (`host-kit/command`, `host-kit/diagnostics`). The package has no archive code. Most of the package is snapshot presentation, occlusion, the iOS snapshot engine, and the snapshot router, and the description names none of them.
- Fix: rewrite the description to list what the package owns.
- Effort: S
- Model: sonnet
- Verify: review only.

### CAP-23: Small contract drift in `kernel/src/snapshot.ts`
- Category: inconsistent
- Severity: low     Confidence: high
- Evidence:
  - `packages/kernel/src/snapshot.ts:196-197` says "the same six keys"; `SNAPSHOT_COMMAND_OPTION_KEYS` at `:183-191` has seven.
  - `buildSnapshotPresentationKey` (`:776-787`) lists the presentation keys by hand, while `SNAPSHOT_PRESENTATION_OPTION_KEYS` (`:216-222`) is documented as "see buildSnapshotPresentationKey". Adding a key to the tuple does not change the key string.
  - Two unrelated exported types are both named `SnapshotVisibility`: `kernel/src/snapshot.ts:656` (a response summary) and `packages/contracts/src/snapshot-visibility.ts:26` (a visibility index). capture-kit imports both: `snapshot/snapshot-visibility.ts:2` and `mobile-snapshot-semantics.ts:7`.
  - `normalizeRef` (`:768`) accepts any token that starts with `e`, so `normalizeRef('email')` returns `'email'`.
- Fix: derive the key object in `buildSnapshotPresentationKey` from `SNAPSHOT_PRESENTATION_OPTION_KEYS`. Fix the comment. Rename the kernel type to `SnapshotVisibilitySummary`. Tighten `normalizeRef` to `/^e\d+$/` after checking backend-issued ref shapes.
- Effort: S (M for the rename)
- Model: sonnet
- Verify: `pnpm typecheck`, then `pnpm vitest run packages/kernel packages/capture-kit/src/snapshot-state*`.
