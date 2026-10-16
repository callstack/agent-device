# ADR 0012: Interactive Replay (agent-in-the-loop repair, resolution disclosure, retiring silent `--update` healing, and agent-supervised re-record repair)

## Status

Accepted (2026-07-10). The decisions are implemented on `main`, including the amendments below:

- #1264
- #1269
- #1271 stage 2
- #1280
- #1349
- #1385
- The 2026-08-07 mutating-ambiguity amendment

Only the replay benchmark extension in decision 5 remains deferred.
The completed migration plan and implementation history (PRs #1193-#1349) are in git history.

## Rules at a glance

This normative summary has one entry for each decision.
[Decision](#decision) contains the full contracts, amendments, and exceptions.
The named registries and tests are the living source of truth.

1. **`--update` never rewrites.** The candidate machinery only ranks bounded divergence `suggestions`.
   It orders identity components, then the same `scrollRegion`, then document order.
   It deduplicates suggestions by node. There is no unattended repair path.
2. **Every element resolution discloses its method.** The additive `resolution` field identifies runtime resolution, ref provenance, or direct-iOS non-observation.
   Runtime disambiguation includes `matchCount`, `tiebreak`, and at most 5 alternatives.
   Coordinate dispatches and executed maestro-fallbacks have no disclosure.
   Successful structural-collapse alternatives are pre-action diagnostics.
   Distinct-subtree rejection candidates issue a partial ref frame for immediate retry.
   ADR 0011's `resolutionDisclosure` row enforces this contract (`packages/contracts/src/interaction-guarantees.ts`).
3. **Recording writes `target-v1` identity evidence. Replay verifies it before an action.**
   Each element-targeting action has one versioned JSON comment.
   Identity uses a unique id, otherwise role+label, and a leaf-anchored ancestry prefix.
   Disambiguation uses `sibling` and region-scoped `viewportOrder`. Diagnostic `rect` values are never compared.
   Six verification paths classify each annotated step.
   Evidence that cannot isolate a target causes `identity-unverifiable`, never a silent selection.
   Amendments cover non-unique ids (#1269), identity-empty pressed containers (#1280), and read-only identity verification (#1349).
   The #1385 amendment adds bounded retries for launch-race content verdicts, with explicit activation at each call site.
4. **Divergence is a structured error with resume by plan ordinal.**
   `ok:false`, `REPLAY_DIVERGENCE`, and `details.divergence` v1 identify four divergence kinds.
   The bounded `screen` uses plain `snapshot` capture scope and ranked refs (#1264).
   It activates a partial ref frame under ADR 0014.
   Each report includes one `repairHint` enum and `resume` data.
   Serialized ceilings are 8/24/64 KiB for compact/default/full responses.
   Resume uses `replay --from N --plan-digest <sha>` without state reconstruction.
   `test` rejects `--from`. Skipped `outputEnv` producers or runtime control flow prevent resume.
5. **Validation is contractual.** Decision 5 defines required coverage for acceptance.
   Benchmark evidence alone is insufficient.
6. **The agent performs repair within a transaction.** `replay --save-script` persists an ARMED -> COMPLETE -> COMMITTED transaction.
   Rules R1-R7 require recording from step 1 and continuation with `--from`.
   The daemon computes `repairHint`. The writer refuses bare `@ref` exports with an explicit error.
   `saveScriptBoundary` bounds the healed slice. The session remains active until commit or abort.
   Exclusive `linkSync` publication refuses every pre-existing target.
   Provenance (`internal.replayPlanStep`) excludes out-of-band observations by default.
   `--record` explicitly includes one corrective observation (#1271 stage 2).

## Decision

### 1. Retire `--update` healing as an actor; repurpose its candidate machinery as ranked suggestions

`--update`/`-u` no longer silently rewrites `.ad` files.
Its existing machinery populates ranked `suggestions` in the divergence report (decision 4).
`collectReplaySelectorCandidates` extracts recorded chains and positionals.
Its `resolveSelectorChain` calls resolve those candidates again.
Neither mechanism acts without agent supervision.

**Ranking is a total order:**

1. Candidates that satisfy more identity components rank first.
   A recorded-id match precedes a role+label match. A role+label match precedes a label-only match.
2. Among equal candidates, the recorded `scrollRegion` precedes other regions.
3. Document order resolves the remaining ties.

Suggestions are deduplicated by node.
A node reached through several recorded selector terms appears once, with its strongest match basis.
Decision 4 bounds the list.
Response levels change report content only.
At every level, `--update` performs no rewrite and returns the same bounded suggestions object.
`--level digest` omits entries and includes `suggestionCount`, as decision 4 specifies.

An agent can accept, reject, or edit a proposed repair in one inexpensive model turn.
This costs less than detection of a silent incorrect repair later.
Audit item (a) in Context also found that heal could rarely act.
An agent-reviewed proposal is therefore more useful than the same proposal applied without review.

### 2. Disclose daemon-tree disambiguation and identify fast-path responses

The daemon-tree selector path (`runtime-selector`) adds a `resolution` response field.
A unique resolution is `{ source: "runtime", phase: "pre-action", kind: "unique" }`.
Multiple matches succeed only if they form one ancestor–descendant wrapper chain for the same actionable node.
That structural collapse returns `{ source: "runtime", phase: "pre-action", kind: "disambiguated", matchCount, winnerDiagnostic, tiebreak: "structural-equivalence", alternatives }`.
Distinct subtrees fail before mutation with `AMBIGUOUS_MATCH` and at most five snapshot candidate lines.
Geometry never selects among distinct mutating targets.

Successful structural-collapse diagnostics remain **pre-action diagnostics**.
They issue no refs.
After mutation, neither `winnerDiagnostic` nor `alternatives` may serve as an `@ref` target.
An ambiguity rejection performs no mutation.
Its bounded candidate lines issue a partial ref frame and `refsGeneration`.
CLI prints pinned candidates. MCP remembers their generation for immediate retry.
A post-action `--settle` diff remains a separate actionable issuer.
A target-binding divergence also sends no action.
It issues its fresh report snapshot under decision 4.

Ref paths disclose ref provenance.
A successful lookup of the `@ref` itself returns `{ source: "ref", phase: "pre-action", kind: "exact" }`.
The runtime-ref path can recover a stale or unusable `@ref` through its recorded trailing label.
`tryResolveRefNode` uses `fallbackLabel` for this first-match label lookup, as Context describes.
This recovery returns `{ source: "ref", phase: "pre-action", kind: "label-fallback" }`.
Label recovery must never claim exact ref provenance.

The native-ref fast path always discloses `exact`.
It dispatches the ref handle and forwards the recorded `fallbackLabel` to the backend.
The daemon cannot observe any backend label recovery.
Thus, `exact` describes only daemon resolution.
This path cannot make a more specific claim.

The accepted direct-iOS selector fast path has no daemon tree.
The XCTest response cannot establish a match count, candidate refs, or a runtime tiebreak.
This path remains enabled for an ordinary simple `press`.
Its canonical unique-match response contains `resolution: { source: "direct-ios", kind: "not-observed" }`.
It must never invent a unique-match or identity claim.
XCTest counts raw exact matches before it applies hittability.
Multiple matches return `AMBIGUOUS_MATCH`.
For non-Maestro dispatches, they delegate to the runtime structural rule.
`--verify`, `--settle`, fill, and recording paths continue to use runtime resolution directly.

ADR 0011's matrix must add a `resolutionDisclosure` guarantee with six accurate cells:

- `runtime-selector` enforces the complete pre-action diagnostic shape.
- `runtime-ref` enforces `exact` or `label-fallback` for trailing-label recovery.
- `native-ref` enforces `exact`.
- `direct-ios-selector` enforces only `{ source: "direct-ios", kind: "not-observed" }`.
- `coordinate` is inapplicable because no element resolves.
- `maestro-non-hittable-fallback` is inapplicable because Maestro owns matching and the fallback executes coordinates.

The **executed dispatch** determines maestro-cell membership.
Permission to use a fallback does not determine membership.
If a permitted fallback is unnecessary, the normal direct-iOS press discloses `not-observed`.
Only an executed coordinate fallback belongs to the inapplicable maestro cell.
The four enforced cells use the shared response builder.
The existing direct path delegates `disambiguation` to `runtime-selector` after its raw-match count.
Its `responseIdentity` limitation remains explicit.

Layer-3 coverage must claim every enforced/delegated cell:

- Unique runtime resolution
- Structural wrapper collapse
- Distinct-subtree rejection with candidates
- Exact-ref provenance for runtime and native refs
- Runtime-ref `label-fallback` recovery
- Direct-iOS `not-observed` without a snapshot

This decision claims no cross-language selection-parity table.
XCTest detects only raw ambiguity.
The daemon tree owns structural equivalence and candidate publication.

### 3. Versioned `.ad` target-binding evidence

> **Amendment (#1567): dual-endpoint target evidence.** An action that resolves two elements records one `targets-v1` annotation instead of `target-v1`.
> Its form is `# agent-device:targets-v1 {"source":{...},"destination":{...}}`.
> Each nested value is a complete `TargetAnnotationV1`.
> The same identity, normalization, field-size, and verification rules apply.
> The wrapper limit is 8,320 bytes.
> Before dispatch, replay verifies both selectors and carries two post-resolution guards.
> Either endpoint can refuse the whole action before pointer-down for these reasons:
>
> - Selector miss
> - Identity mismatch
> - Unverifiable evidence
> - Dispatch-time guard mismatch
>
> Older readers treat unknown future `targets-vN` annotations as ordinary comments, as with single-target versions.

Recording writes evidence for every action that resolves an element target.
The versioned comment immediately precedes its action:

```text
# agent-device:target-v1 {"id":"save","role":"button","label":"Save","ancestry":[{"role":"toolbar","label":"Editor"},{"role":"window"}],"sibling":0,"viewportOrder":0,"scrollRegion":{"role":"scrollview","id":"editor-scroll"},"verification":"verified"}
click @e12 "Save"
```

The prefix is ASCII.
The payload is one JSON object on one line.
JSON supplies all quotation and escape rules.
Writers must use canonical `JSON.stringify` field order:

- `id`
- `role`
- `label`
- `ancestry`
- `sibling`
- `viewportOrder`
- `scrollRegion`
- `rect`
- `verification`

Rect field order is `x`, `y`, `width`, `height`.
`verification` is `"verified"` or `"unverifiable"`.
The payload has three comparison tiers:

- **Identity, compared exactly:** recorded `id`, otherwise `role` plus normalized `label`, together with the leaf-anchored `ancestry` prefix.
  `role` is `normalizeType(node.type ?? "")`, as `buildSelectorChainForNode` uses.
  It is never the raw optional `node.role`.
- **Disambiguation signals, used only for shared identity:** `sibling`, then `viewportOrder` within the recorded `scrollRegion` partition.
  `sibling` is the actual same-parent child index.
  These relative signals use no absolute pixels.
  Document order resolves every ordering tie.
- **Diagnostics, never compared:** optional `rect` shows the recorded target's location in divergence reports.

Absolute geometry is excluded from identity because healthy runs change rects.
Causes include scroll offset, rotation, dynamic type, iPad/macOS window size changes, and ordinary RN layout changes.
The audited “Prevent Remove” siblings also had identical rects.
Thus, absolute geometry cannot always distinguish siblings.
V1 has no absolute-coordinate tolerance.
The earlier ±8-unit comparison has no measured drift distribution to justify its constant.
Any future absolute tolerance must include measured evidence.

**Normalization.** All strings use Unicode NFC.
`label` also removes leading/trailing whitespace and replaces each internal whitespace sequence with one space.
Comparisons are case-sensitive after normalization.
A label case change is a UI change.
The writer omits strings that normalize to empty.
The comparator treats them as absent.
Each normalized string field has a **256 UTF-8 byte** limit.
The whole payload has a **4 KiB** limit.
`ancestry` has at most **eight** entries.
`sibling` and `viewportOrder` are non-negative safe integers.
The parser rejects annotations outside these bounds with `INVALID_ARGS`.

**Writer-parser invariant.** The recorder must never emit a payload that its parser rejects.
If per-field truncation still leaves more than 4 KiB, the writer removes `ancestry` entries from the root side, one at a time.
This reduction is deterministic and uses the existing ancestry truncation direction.
If only `ancestry[0]` remains and the payload still exceeds the limit, the writer sets `verification: "unverifiable"`.
It must not write an invalid or silently lossy script.
With the 256-byte field limits, a parent-only payload fits arithmetically.
Thus, this downgrade is a terminal guarantee, not an expected path.
Step 5's record-time self-check uses the reduced tuple.
A `verified` claim therefore applies to exactly the written evidence.

> **Amendment (#1398, ADR 0017):** action-mode evidence has another independent cause for the same `"unverifiable"` downgrade.
> It applies when a matched node's label echoes a literal already parameterized by the recording session.
> The writer first replaces that literal with its placeholder in the label.
> The literal therefore never enters the payload.
> Landmark mode (`wait`) instead drops the annotation, as the #1349 amendment specifies.
> ADR 0017's session-scoped echo protection amendment defines the full mechanism.

**Local identity.** If both nodes carry `id`, equal normalized ids establish local identity.
If the recording carries no `id`, normalized roles and labels must match.
Absent labels on both sides are equal.
A label on only one side is a mismatch.
A recorded `id` never matches a node without that id.

> **Amendment (#1269).** An id may identify the target and lead its selector chain only if it is unique in the record-time tree.
> The writer counts matches for the id independently of ancestry.
> If multiple nodes carry that id, the writer demotes it to role+label, as for an unrecorded id.
> The measured case is `android:id/title` on every titled list row.
> The rule uses capture-time uniqueness, not an `android:id/*` namespace heuristic.
> A reused RN `FlatList` `testID` causes the same demotion on iOS.

> **Amendment (#1280).** A **click/press** can resolve an identity-empty container.
> After #1269 demotion, this means no surviving id, no label, and no value.
> A demoted raw identifier counts as neither identity nor text.
> Recording substitutes the container's first labeled descendant.
> Its selector chain and `target-v1` tuple then carry selective role+label identity instead of a shared bare role.
> The measured Android case is a clickable `role="linearlayout"` row with its title on a child `TextView`.
> “First labeled descendant” means the first node in document order within the whole subtree with a non-empty normalized label.
> `fill` is excluded because its recorded `editable=true` constraints cannot match that descendant.
> Otherwise, the script could not replay.
>
> Two guards must permit the substitution:
>
> 1. The subtree contains **no competing interactive node**.
>    No node is flagged `hittable`.
>    No node has an independently tappable role under `isSemanticTouchTarget`, the policy for hittable-ancestor promotion.
>    A row with a trailing `Switch` or `Checkbox` must not retarget.
>    The descendant's center and the container's center could activate different controls.
> 2. The selected descendant's rect center lies **inside the container's rect**.
>    The replay tap point must remain within the original activation region.
>    Missing rects prevent substitution.
>
> If either guard blocks substitution, recording keeps the container.
> If no descendant has a label, recording also keeps the container.
> This is a **recording-only side channel**.
> The live response continues to describe the dispatched container throughout:
>
> - Resolved node
> - Selector chain
> - Ref-label
> - Tap point
> - Resolution disclosure
> - `targetHittable`/hint
>
> `resolveSelectorChain` and dispatch do not change.
> Only the recorded action entry and its `target-v1` evidence use the descendant.
> The rule applies to every platform.
> An iOS RN `FlatList` row (`Cell`) without a label and with a labeled `Text` child uses the same substitution.

> **Amendment (#1349): read-only step identity — `wait` landmark verification, `is` coverage, and the per-command verification-phase trait.**
> Decision 3's evidence extends to eligible read-only steps without changes to their execution semantics.
> The `target-v1` tuple, bounds, writer, and parser do not change.
> Each command declares when verification runs on the central `CommandDescriptor`:
> `targetIdentityVerification: 'pre-dispatch' | 'post-resolution'`.
> A completeness test enforces this declaration.
> A new evidence-carrying command must select its phase explicitly.
> It must not silently use generic pre-dispatch verification.
>
> **`wait <selector>` uses `post-resolution` landmark existence semantics.**
> Its landmark can be absent when the step starts.
> Generic pre-action verification paths 2-6 must never run for it.
> Only path 1, recorded-`unverifiable` without screen examination, refuses immediately.
> The annotation instead enters the wait's polling loop through `internal.replayLandmarkGuard`.
> This uses the same daemon-only channel as `replayTargetGuard`.
> Success requires a selector match with recorded identity, not merely a selector match.
> The comparison uses only local identity and the leaf-anchored ancestry prefix.
> It excludes positional disambiguation signals.
> A destination guard proves landmark existence on the ready screen, irrespective of list position.
> Positional comparison could incorrectly reject a valid reordered screen.
>
> A same-selector impostor does not abort polling.
> Transient similar elements can appear during a transition.
> At the deadline, matching polls without the recorded identity cause `identity-mismatch` before wait success.
> `matchCount` comes from the last matching poll.
> `mismatches` includes observed identity and the first ancestry mismatch.
> If the selector never matches, the ordinary timeout remains `action-failure`.
> This requires state repair, and its existing `repairHint` routing remains correct.
>
> Polling also continues after an unreadable capture.
> Android reports content verdicts through `isUnreadableCaptureContentError`.
> iOS reports the same state as a sparse verdict without matches.
> Live Android validation showed deterministic failure on the first transition capture after a navigation press without this rule.
> If the screen never becomes readable, the deadline rethrows the last capture verdict instead of a generic timeout.
>
> Record-time **landmark mode** changes step 5's self-check from isolation to identity-set membership.
> This matches replay verification.
> If #1269 demotion leaves neither id nor label, the writer records **no annotation**.
> A role-only landmark identity distinguishes too little.
> The unannotated wait retains selector-existence semantics instead of refusing unverifiable evidence.
> ADR 0016 uses exactly this definition: a qualifying destination guard is a selector wait with a `verified` annotation.
> **Amendment (#1398, ADR 0017):** the writer also omits evidence when identity echoes a literal already parameterized through `fill --record-as`.
> A recorded label placeholder cannot verify against the live literal during replay.
> The writer drops the evidence instead of publishing it unverified.
> ADR 0017's session-scoped echo protection amendment defines the mechanism.
>
> **`get` remains unchanged.** Pre-dispatch verification and the post-resolution guard already cover it.
>
> **`is`, except `exists` and `absent`, uses `pre-dispatch` verification and the complete `get` pattern.**
> It resolves one unique node immediately, so pre-action verification applies.
> The resolved node/tree supply record-time evidence.
> Dispatch passes `replayTargetGuard` to `assertExpectedResolvedTarget`, as for `get`.
> Recording and guarded replays disable direct-iOS `is`/`wait` fast paths, as the existing `get` recording gate does.
>
> **The following coverage remains deferred.** Tests prove no annotation is recorded and no identity check runs:
>
> - `is exists` has no unique winner.
>   It has wait-like existence semantics without the guard-critical role.
> - `is absent` observes absence in one capture without a resolved winner.
>   It records an ordinary observation.
>   Its `predicate_failed` is always `action-failure`, never identity mismatch.
> - `wait absent` polls for zero candidates without a resolved winner.
>   No-match success has no `target-v1` or landmark annotation.
>   A `wait_target_present` deadline is ordinary `action-failure`.
>   It is never identity mismatch or an ADR 0016 destination guard.
> - Every read-only `find` variant lacks a selector-chain identity token for classification.
>   Publication already refuses mutating `find` as non-verifiable.
> - `wait text`, `wait stable`, duration waits, and `wait @ref` have no element target or use a session-local ref.
>   ADR 0016 already refuses publication of that ref.
>   `wait @ref` is rejected instead of converted to a portable selector.

**Ancestry.** The chain contains the nearest **K = 8** ancestors in **leaf→root** order.
Each entry is `{ role, label? }` with the same normalization.
If the node has no type, `role` may be empty.
Empty `label` is omitted.
Truncation removes entries from the **root side only**.
The nearest ancestors always remain.

Comparison uses a **leaf-anchored prefix match**.
Recorded chain R matches observed chain O if every index `i < |R|` satisfies these conditions:

- `O[i]` exists.
- The roles are equal.
- If `R[i]` has a label, the labels are equal.

An absent recorded label imposes no constraint.
`|O| < |R|` is a mismatch.
An inserted or removed wrapper ancestor deliberately changes identity.
Structure is part of identity.

**Record-time write.** Record and replay compute both positional signals over identical candidate domains.
**Document order** is the node's pre-order tree-traversal index.
It is the canonical total order for enumeration, ordering ties, and candidate lists throughout this contract.
Every comparison is therefore deterministic and total.

1. Resolve the action's winner and compute its identity tuple from the record-time tree.
2. Compute the record-time identity set.
   It contains all nodes with the winner's local identity and matching leaf-anchored ancestry prefix.
3. Compute `sibling` as the winner's zero-based index among its **parent's children**.
   It is independent of scroll regions and inexpensive to read from the accessibility tree.
   `ancestry[0]` already records the parent.
   No additional field is necessary.
   Record and replay compute this ordinal identically.
4. Partition the identity set by **scroll region**.
   The key is the nearest scrollable ancestor's local identity (`role` + `id`/`label`), or *none* without that ancestor.
   `scrollRegion` is the winner's key and is omitted for *none*.
   `viewportOrder` is its zero-based ordinal **within its own partition**.
   Order rect centers top-to-bottom, then left-to-right.
   Resolve equal centers by document order.
   Put rect-less members last, in document order.
   Record and replay use this partition as the ordinal's domain.
5. Run the replay verification algorithm against the record-time tree.
   If it isolates exactly the winner, write `verification: "verified"`.
   Otherwise, write `verification: "unverifiable"`.
   Both ordinals derive from the winner over deterministic total orders.
   Thus, the self-check succeeds when capture supplies the required structural data.
   Record-time `unverifiable` identifies a capture anomaly, such as missing parent linkage.
   It is a fail-closed safeguard, not an expected path.
   At replay, it causes `identity-unverifiable` before an action.
   Evidence declares its limits instead of permitting a silent guess.

A v1 parser accepts known fields in any JSON object order.
It ignores unknown fields and normalizes known strings to NFC.
Malformed annotations or invalid known field types cause `INVALID_ARGS`.
A v1 reader treats an unknown future `target-vN` comment as an ordinary comment.

The annotation binds only to the next physical action line.
A blank or intervening line leaves it unbound and causes `INVALID_ARGS`.
This prevents an edit from silently assigning evidence to a different target.
Parser/writer tests must prove these cases:

- Parse-write-parse semantic equality
- Embedded quotes
- Backslashes
- Unicode
- Unbound annotations
- Malformed annotations

Old readers ignore the comment and execute the action unchanged.
New readers accept unannotated old scripts without target-binding checks for those actions.
A writer that reads and rewrites a script preserves v1 annotations in canonical form.
It must not silently discard them.
This is an additive `.ad` format change, beyond per-line size growth.

**Replay-time verification.** Every annotated resolved target uses this exact classification before dispatch.
`matchCount` counts current nodes matching the **recorded selector**.
It uses the resolution match set and has range **0..N**.
Paths 2-6 require it.
Path 1 omits the key, never sets it to `null`, under the drop-empty-keys convention.
Path 1 precedes resolution.
It computes no diagnostic count because the recorded identity is untrustworthy.
A count could mislead and would add capture cost without verification.
Identity verification applies only when `matchCount >= 1`.

1. Recorded `verification` is `"unverifiable"`: return **identity-unverifiable** before resolution.
2. `matchCount == 0`: return **selector-miss**.
   The selector matches nothing.
   This requires selector repair, distinct from identity mismatch.
3. `matchCount >= 1` and identity set I is empty: return **identity-mismatch**.
   I contains selector matches with the recorded local identity and matching ancestry prefix.
   Nothing matched that identity.
4. `|I| == 1` and resolution winner W is that member: **verified**.
   The action proceeds.
   Only this verified result sends the action.
5. `|I| == 1` and W differs: return **identity-mismatch**.
   This detects a unique-but-wrong rebind or a changed ambiguity winner, even after unique resolution.
6. `|I| > 1`: apply these signals in order over their record-time candidate domains:
   - **sibling:** retain members of I whose index among their own parent's children equals recorded `sibling`.
     If exactly one remains, compare it with W under paths 4/5.
     If zero or multiple remain, continue.
     The same child index can recur under different parents.
   - **Region-scoped viewportOrder:** restrict I to the recorded `scrollRegion` partition, including *none* when omitted.
     If empty, the recorded region no longer exists.
     The signal is unavailable and must never compare across regions.
     Otherwise, order centers top-to-bottom, then left-to-right.
     Resolve equal centers by document order.
     Put rect-less members last in document order.
     If the recorded ordinal is in range, compare that member with W under paths 4/5.
     If out of range, continue.
   If neither signal isolates a member, return **identity-unverifiable**.
   List at most **5** candidates in document order.
   Never silently select a candidate.
   Pre-order indexing prevents two nodes from occupying the same document-order position in one tree.
   Even a residual tie causes identity-unverifiable.
   This refusal is the purpose of the ADR.

A recorded field absent from the compared node is a mismatch.
`rect` is never compared.
Old unannotated actions remain executable without this check.
All three target-binding divergence classes precede device action.
This is distinct from general outcome verification.
`--verify` remains post-action change evidence under its separate contract.

> **Amendment (#1385).** `captureDivergenceObservation` supplies the pre-dispatch verification tree.
> Immediately after `open --relaunch`, the app can still be in launch or mount operations.
> A transient `capture-failed` or `sparse-snapshot` verdict can therefore occur without real divergence.
> Android's helper can throw for insufficient foreground app content during mount.
> iOS's private-AX fallback can return sparse content under load.
> This capture retries with bounded backoff before it returns `identity-unverifiable`.
> The fixed delay list has 7 entries and a 12s **DELAY-ONLY** budget.
> This corresponds to `wait` landmark verification's existing continued polling (#1349).
>
> Each call site explicitly selects `retryLaunchRace`.
> Only `verifyReplayActionTarget`'s pre-dispatch gate uses it.
> `buildReplayFailureDivergence` and the post-resolution guard-mismatch capture follow established failures.
> They do not retry because retries would only delay the decided divergence.
>
> The retry classification matches #1381's content-quality/mechanism distinction in `isUnreadableCaptureContentError`.
> The non-throwing `sparse-snapshot` verdict always retries because it already identifies content quality.
> A thrown `capture-failed` retries only for these `androidSnapshotHelperFailureReason` codes:
>
> - `empty-helper-output`
> - `system-window-only`
> - `content-poor-app-window`
>
> `rejectAndroidHelperContentUnavailable` in `packages/platform-android/src/snapshot.ts` attaches those codes to content-poor/system-window-only rejections.
> They correspond to `AndroidHelperContentRecoveryDecision['reason']` in `packages/platform-android/src/snapshot-content-recovery.ts`.
> The generic `retriable` flag is insufficient.
> Android's adb layer also marks mechanism failures retriable:
>
> - `connection_dropped`
> - `device_offline`
> - `server_version_mismatch`
>
> The same unchanged adb command can succeed after those failures.
> A permanently missing helper artifact (`androidSnapshotHelperUnavailableError`) carries neither signal.
> Mechanism failures fail on the first attempt, irrespective of their `retriable` flag.
>
> The 12s **DELAY-ONLY** budget starts at the first capture attempt.
> It bounds inter-attempt sleep, not the duration of individual captures.
> Capture retains its own platform timeouts.
> This loop neither shortens nor duplicates them.
> The fixed-length array independently bounds the attempt count.
> An instant mocked `sleep` therefore cannot cause a real-time busy loop.

### 4. Divergence wire contract and replay-only resume

**Divergence is a structured error.** Both action failure and target-binding mismatch return `ok:false`, code `REPLAY_DIVERGENCE`, and `details.divergence`.
The version `1` object contains these fields:

- `kind`
- `step` (`index`, `source.path`, `source.line`)
- `action`
- `cause`
- `screen`
- `suggestions`
- `resume`
- `repairHint`
- For binding failures, `targetBinding` (`classification`, `matchCount`, `recorded`, `observed`, `mismatches`, `candidates`)

`kind` is `action-failure`, `selector-miss`, `identity-mismatch`, or `identity-unverifiable`.
The last three are decision 3's target-binding classes.
`targetBinding.classification` always equals top-level `kind`.
Decision 3 determines `targetBinding.matchCount` presence:

- Present, with range 0..N, for `selector-miss` and `identity-mismatch`
- Present for resolution-derived `identity-unverifiable` (path 6)
- Omitted, never `null`, for recorded-unverifiable evidence before resolution (path 1)

`step.index` is the 1-based executable-plan ordinal.
The source location is diagnostic only.
A Maestro parser must preserve original files and lines through includes so the caller can use the location.

`repairHint` is one bounded enum value from a fixed closed set:

- `record-and-heal`
- `state-repair`
- `caution`
- `manual`

It is never a list.
The daemon computes it under decision 6, R3.
Every divergence includes it, with `manual` when no safer route is proven.
It is never absent or null.
Its small fixed size permits inclusion at every response level, including `--level digest`.
It must survive these four projections unchanged:

- Daemon text summary
- JSON
- Node client `AppError`
- MCP `structuredContent`

Decision 6 defines its meaning and computation.
This section defines transport.

`screen` has two discriminated forms.
`{ state: "available", refsGeneration, refs, truncated }` is a fresh healthy snapshot digest.
Only this form issues actionable refs.
`{ state: "unavailable", reason, hint }` indicates failed or sparse capture.
It has no refs or generation and must not reuse the old session tree.
Capture failure never replaces or conceals the original replay cause.

> **Amendment (#1264): `screen`'s capture scope and ref selection.**
> `refs` is a filtered, ranked digest of the tree that plain `snapshot` would return at that moment.
> Two guarantees establish this invariant.
>
> **1. Capture scope.** The capture uses the same `captureSnapshot` wrapper as the plain command's backend.
> It does not use a parallel single-shot dispatch.
> It inherits full-window scope:
>
> - Android uses the snapshot-helper route.
>   The existing graceful app-scoped fallback applies only when the helper is unavailable.
> - iOS uses the bounded system-modal probe path.
> - macOS/Linux use their surface-scoped branches.
>
> It also inherits Android freshness and post-action retries.
> Divergence must not use a first stale or app-scoped dump when plain `snapshot` retries for fresh full-window content.
> Diagnostic flags use a fixed full-window, non-raw, default-depth policy.
> They do not inherit the failed action's `snapshotRaw`, `snapshotScope`, or `snapshotDepth`.
> Thus, failed raw, scoped, or `-d` snapshots cannot reduce diagnostic scope.
> Only interactive-only policy is carried:
> non-rect `get`/`is`/`wait` reads use full content; other actions use interactive content.
> Chrome filtering (#1233/#1256, `collectSettleChromeRefs`) and meaningful-target filtering apply after full capture.
> Meaningful targets have label/id or `hittable`.
> These filters can remove captured nodes.
> The capture itself must never omit content that plain `snapshot` would show.
>
> **2. Ref selection within the cap.** `screen.refs` has a byte bound, not a first-N document-order policy.
> Separate-window overlays enumerate after app-window nodes.
> A document-order slice could therefore omit the overlay's dismiss target and falsely imply healthy app state.
> Before the cap applies, ranking promotes foreign-window hittable nodes ahead of app content.
> A foreign window has a non-app `bundleId`.
> These nodes include controls that dismiss the covering window.
> Each tier otherwise preserves document order.
> If a system overlay marks every app node `covered`, the report shows those covered nodes instead of empty `refs`.
> Meaningful captured nodes must not produce an empty ref report.
>
> An agent must never see a healthier divergence `screen` than plain `snapshot` would show.
> A covering separate-window system overlay must survive both filters and the cap through its actionable/hittable/labeled nodes.
> Examples include a held volume dialog, persistent quick-settings shade, or permission dialog.
> `repairHint` and `suggestions` use the **full captured node list**, never the capped `refs` slice.
> Their routing must not treat an app beneath an overlay as healthy.

Response limits apply to the entire serialized UTF-8 `details.divergence` object:

| Response level | Byte ceiling | Screen refs | Suggestions |
| --- | --- | --- | --- |
| Compact (`--level digest`) | 8 KiB | At most 8 | No entries; `suggestionCount` |
| Default | 24 KiB | At most 20 | At most 5 |
| Full | 64 KiB | At most 20 | At most 5 |

`suggestionCount` counts entries available at default/full level.
It tells callers whether a higher-level fetch has more material.
Default/full suggestions follow decision 1's total order.
Counts are absolute, including error payloads.
The following individual values are UTF-8 truncated to **256 bytes**:

- Labels
- Ids
- Selectors
- Source paths
- Mismatch values
- Cause messages
- Hints

An action summary has no positional array.
Arbitrary nested cause details are never serialized.
Maestro failure provenance uses resolved diagnostic identifiers, including targets and `runFlow` paths.
It names the attempted runtime operation instead of unresolved `${VAR}` or synthetic `<var:VAR>` tokens.

Text-entry payloads remain semantic secrets.
`inputText` progress, failure messages, suggestions, and overflow artifacts never serialize entered text.
Injected replay values are not global sensitive literals.
Otherwise, ordinary short values such as `2` or `on` could corrupt timestamps, paths, and typed log fields.
The actual text-entry dispatch boundary registers values before platform work, independently of the failure projection.
Users must not put secrets in selectors, links, filenames, or other diagnostic identifiers expected in failure output.

Native `.ad` replay retains categorical `<var:NAME>` replacement in human-readable divergence messages, hints, and bounded diagnostic fields.
This existing fail-closed policy remains separate from Maestro compatibility output.
Semantically masked positionals and daemon-owned machine-readable fields and paths never receive substring replacements.
The report marks every truncation, redaction, and omission.

If bounded output omits material, the daemon writes the same redacted, per-field-bounded detail to a session-scoped divergence artifact.
It returns the path and `overflow: { omittedBytes, artifactPath }`.
If the write fails, it returns `artifactUnavailable: true` and preserves the original error.
The artifact contains no raw snapshot tree or unredacted input.

All surfaces preserve the daemon error.
The Node client rejects with `AppError` and retains `details.divergence`.
CLI exits nonzero.
Text shows a compact report; JSON includes the complete structured error.
MCP returns `isError: true`, the object in `structuredContent`, and the same compact text summary.
MCP treats divergence as a ref-issuing result, including on the error path.
Before return, it merges and pins every `screen` ref with `refsGeneration`.
CLI and direct clients receive the daemon error's unpinned refs and generation.
No surface may reduce divergence to text and discard repair data.

> **ADR 0014 amendment (accepted, implemented):** divergence `screen.refs` issues a bounded partial ref frame.
> `markSessionPartialRefsIssued` authorizes exactly those refs.
> MCP pins them automatically.
> CLI text renders `@eN~s<refsGeneration>`.
> JSON and Node.js callers pair each plain ref with the response-level generation before mutation.
> A mutation through this partial frame requires a pinned ref.
> A plain ref returns `plain_ref_requires_complete_frame`.

`--from N` belongs only to `replay`.
`test` must reject it with `INVALID_ARGS` because a suite run must remain full and deterministic.
`N` is an in-range 1-based index into the fully expanded executable plan.
It is not a YAML line, fractional source-step number, or repeat iteration label.
Static includes, platform conditions, and fixed-count repeats expand before indexing.
Repeated source lines therefore have distinct plan indices.

Every divergence includes `resume: { allowed, from, reason?, planDigest, alternateFrom?, repairSessionHeld? }`.
`repairHint` determines `from` under decision 6, R2/R3:

- For `record-and-heal`, `from` is the failed index **N + 1**.
  The agent performs step N manually before resume.
- For `state-repair`, `caution`, and `manual`, `from` remains **N**.

For single-path hints (`record-and-heal`, `state-repair`), `from` describes the complete continuation.
JSON/MCP callers therefore receive the same next command as text callers.
For dual-path hints (`caution`, `manual`), `from` describes only app-state repair.
Their optional `alternateFrom` describes recorded correction.
Structured callers read both fields to obtain both text alternatives.

`alternateFrom` is an additive optional ordinal (#1262).
For `caution`/`manual`, the daemon cannot yet distinguish these repairs:

- App-state fix: use `--no-record`, then repeat unchanged step N at `from`.
- Recorded correction: perform step N's intent as a recorded action, then continue at N + 1.

`alternateFrom` carries N + 1 only if that request passes `evaluateReplayResumePreflight({ from: N + 1, actions }).allowed`.
Step N must itself be safe to skip.
A `runScript` `outputEnv` producer or runtime control flow therefore prevents this alternate.
The alternate preflight examines a strict superset of the primary range.
Thus, `alternateFrom` implies `allowed: true`.
`record-and-heal` omits it because `from` already carries N + 1.
`state-repair` omits it because it has no recorded-action alternate.
Text renders the N + 1 command **if and only if `alternateFrom` exists**.
Clients never recompute resumability.
Text and structured output therefore advertise identical commands.

`actions.length + 1` is a legal **empty-tail resume** for a repaired final step.
It executes zero device actions and follows normal end-of-plan completion.
An armed transaction becomes `COMPLETE`, which permits its later `close` commit.
Otherwise, `close` would abort the incomplete transaction and discard the correction.

This ordinal requires authorization from the exact session and target that produced it.
The daemon stamps a per-session watermark with `expectedFrom` and the recorded action count at divergence:

- For `record-and-heal` with `allowed: true`, the reported `from` is already N + 1.
- For a preflight-safe `caution`/`manual` final-step alternate (#1262), the watermark uses `alternateFrom` N + 1.
  The primary `from` remains N.

Only a live session can receive this watermark.
Without one, an empty-tail `alternateFrom` is omitted.
Examples include a one-step `open` failure or a session closed during replay.
A later empty-tail resume must match the watermark and show growth in the session's action count.
That growth proves a corrective action was recorded.
It prevents unrelated or blind resumes from skipping the unresolved last step and committing an incomplete repair.
Every other `record-and-heal` continuation uses the same watermark and count-growth guard, including ordinals inside the plan.
If the count is unchanged, resume refuses to skip the unrepaired step.

`planDigest` is SHA-256 over the canonical fully expanded plan.
It includes command, normalized inputs, control shape, platform-conditioned expansion, and source provenance.
Normalized inputs include positionals/flags, execution-affecting `runtime` hints, and `target-v1` identity evidence.
Identity evidence affects pre-action execution and must therefore affect the digest.
Platform-conditioned expansion uses the **effective resolved `platform`/`target`**.
CLI flags override script metadata.
A digest for one target is not reusable for another.
Native `.ad` `${VAR}` **values are excluded** because substitution follows planning.
Changes only to late-bound values retain the digest.
Maestro substitutes environment values during compatibility parsing.
Those values can change action inputs, includes, or control expansion and therefore the digest.

Resume requires both `--from N` and `--plan-digest <planDigest>` from the report.
The daemon rebuilds the current plan.
If the digest differs, it returns `INVALID_ARGS` before any action.
Edits or parse-time expansion cannot silently change ordinal N's target.
`allowed: false` explains why resume is unsafe.
Its digest remains diagnostic and cannot bypass preflight.

`allowed` describes **plan resumability only**.
Every divergence emits it.
It says nothing about session lifetime.
The separate `repairSessionHeld: true` signal identifies an active repair transaction persisted on the session.
A `--save-script` replay opens it; commit or abort ends it (decision 6, R7).
A continuation without `--save-script` still reports it because persisted state determines this field.
Only this signal promises a live addressable daemon/session for repair.
R7's lifetime guarantee never uses `allowed`.
A non-armed replay can report `allowed: true` and then terminate its session normally.

Resume reconstructs no execution state.
For `N > 1`, preflight must reject with `INVALID_ARGS` under either condition:

- A skipped action can produce `outputEnv` values.
- The skipped range or resume target is inside runtime conditional, retry, or dynamic-repeat control flow.

After resume, only explicit script/header, CLI, and shell inputs supply variables.
If the planner cannot prove that scope, it rejects the request.
The daemon never infers app state.
Before resume, the caller must establish the required app state.
This conservative first-release scope defers deterministic state reconstruction until a separate specification and tests exist.

The caller runs replay, reads divergence, repairs state or performs the failed action, and resumes with the reported digest and ordinal.
An edited script requires a fresh full replay and a new digest.
Help documents this protocol and resume rejections.
Successful text replay prints one line with replayed count and wall time.
`--json` remains structured.

### 5. Mandatory validation

Implementation is not accepted on benchmark evidence alone. Required automated coverage is:

- matrix and provider contracts for all six `resolutionDisclosure` cells: runtime ambiguity/tiebreak and
  the five-alternative limit, runtime/native exact-ref provenance plus the runtime-ref `label-fallback`
  recovery disclosure, direct-iOS `not-observed`, coordinate inapplicability, Maestro inapplicability on
  both sides of the permission (fallback taken, and allowed-but-not-taken disclosing `not-observed`), and
  the retained direct-path waiver list;
- an interaction mutation contract proving pre-action resolution diagnostics are not ref-issued or
  MCP-pinned, a fresh snapshot is required before using an alternative, and a no-action target-binding
  divergence can issue and pin its fresh report refs;
- parser/writer unit cases for v1 identity round trips, old/new reader compatibility, escaping,
  normalized-role source, leaf-anchored ancestry prefix matching (including root-side truncation and
  inserted-wrapper mismatch), duplicate/unverifiable record and replay evidence, rect-never-compared,
  malformed annotations, and mismatch-before-action behavior;
- replay runtime tests covering all six verification paths of decision 3 — recorded-unverifiable,
  selector-miss (`matchCount == 0`), empty identity set, verified, unique-but-wrong rebind, and
  post-signal fall-through — including same-parent `sibling` semantics with the same child index
  recurring under different parents, region-partitioned `viewportOrder` domains proven identical at
  record and replay, a recorded scroll region that no longer exists (unavailable, never compared
  cross-region), out-of-range ordinals, and document-order determinism for equal rect centers and
  rect-less members — plus divergence-report tests for
  compact/default/full field and byte ceilings (including digest-level `suggestionCount` with entries
  omitted), redaction, overflow artifacts and artifact-write failure,
  available versus sparse/capture-failed screen forms, and preservation of the original cause;
- replay resume tests for plan-digest emission and mismatch rejection after script/include/expansion
  changes, `resume.allowed` reasons, `--from` indexing, variable-output and control-flow rejection, and
  `test --from` rejection;
- daemon/client/CLI/MCP contracts proving the typed divergence survives failure, JSON and MCP structured
  output retain it, MCP pins only actionable error-path refs, no text-only path drops the report, and the
  `repairHint` enum is present and identical across all four projections (text, JSON, client `AppError`,
  MCP `structuredContent`), including at compact `--level digest`;
- `--update` retirement tests proving it never rewrites the source file and only returns bounded
  suggestions ranked and deduplicated per decision 1's total order; and
- decision 6 acceptance tests: a healed sibling `.ad` replays end-to-end in a **fresh session** with
  every selector step annotated and no bare `@ref`; daemon-side `repairHint` computation for all four
  values (`record-and-heal`, `state-repair`, `caution`, `manual`) against the four divergence kinds
  (`selector-miss`, `identity-mismatch`, `identity-unverifiable`, `action-failure`), proving the mapping
  is total — including the no-`targetEvidence` fail-safe to `manual` (an unannotated `action-failure` per
  PR #1223) and the sparse/unavailable-capture fail-safe to `manual`, and the post-response-capture
  container test for `action-failure`; `--no-record` state-fix actions excluded from the healed script
  while the corrective selector-drift action is included; prefix steps re-annotated with fresh
  `target-v1` evidence when recording is armed from step 1 (R1); a `--from`-continuation test proving the
  already-recorded prefix is never duplicated by a second full replay on the same session (R2); a
  boundary-watermark test proving a reused session's pre-invocation actions are excluded from the healed
  script (R6); a writer fail-loud test proving a bare `@ref` that cannot materialize to a selector
  errors with a non-zero exit rather than being silently dropped (R4); a repair-transaction lifetime test
  proving a divergence with `resume.repairSessionHeld: true` keeps the session live and addressable for a
  following `--from` while a non-armed divergence with only `resume.allowed: true` does not, that
  continuation resumes off the session's **persisted** transaction with a `--from` that carries no
  `--save-script`, that a reaped INCOMPLETE transaction surfaces `REPAIR_SESSION_EXPIRED` from a tombstone
  keyed by session key (not `SESSION_NOT_FOUND`) and that a fresh `replay --save-script` on that key clears
  it, and that a keep-alive-incapable implementation fails fast before step 1 (R7); a commit-state-machine
  test proving **any teardown** (explicit `close`, idle-reap, and shutdown) commits atomically at
  `COMPLETE`, aborts and publishes nothing (no prefix) before `COMPLETE` — with an idle-reap/shutdown of a
  `COMPLETE` transaction committing (not tombstoning) — and is idempotent with no re-publish once
  `COMMITTED`; a terminal-close test proving an armed replay reaching the terminal source `close`
  **skips** it without deleting the session (C4); an atomic-publication test proving the temp file is
  created in the target's own directory and published via a single exclusive `linkSync`
  (create-if-absent, first writer wins); and a no-clobber test proving publication refuses ANY
  pre-existing target — complete or partial alike, byte-for-byte unchanged — for both the default healed
  sibling and an explicit `--save-script=<path>`, **and for an ordinary (non-repair) `open`/`close
  --save-script` recording whose target already exists** — the writer entry point and publish primitive
  are shared, so the refusal is uniform, not repair-only (see "Scope" below).

Extend the settle benchmark (`~/.agent-device-bench/rnnav-matrix.py` pattern, external harness) with a
replay arm only after these contracts pass: measure clean replay and one induced divergence repaired
through the allowed `--from` loop.

### 6. Agent-supervised re-record repair ("heal-by-doing")

Decision 1 retired `--update`'s SILENT auto-rewrite because selector agreement is not proof of the same
target. This decision is not a reversal of that: it adds an EXPLICIT, agent-driven repair path — the
agent performs the failed step with ordinary interactive commands an operator can see, and the CLI
records what actually worked. Nothing here re-applies a candidate selector unattended; retiring silent
auto-rewrite and adding explicit agent-driven re-record are consistent, not contradictory.

Decision 1's replacement repair surface for a selector-drift divergence (a recorded label/id renamed so
the selector no longer matches) is: hand-edit the `.ad` selector text, then fresh-replay. Measured
2026-07-12: this is a hostile repair surface for models — a small-model (Haiku) repair run thrashed 26
turns and corrupted the `.ad` to `INVALID_ARGS`, editing escaped-quote selector chains
(`label="X" || label="X"`), and the divergence `suggestions` list was empty for the renamed label. The
divergence *report* is good (decision 4); the repair *affordance* is broken. Models should not edit `.ad`
text.

When a replay diverges on selector drift, the agent instead performs the failed step's **intent** with
ordinary interactive commands against the fresh blessed `@refs` the divergence's `screen` already hands
it (decision 4), and the CLI emits a healed `.ad` equal to the session's actual successful execution
path — no text editing, no silent similarity-heal.

**Core mechanism — the healed script IS `session.actions`.** No new splice engine. `session.actions`
already accumulates every executed action for the session's lifetime
(`packages/daemon/src/core/session-action-recorder.ts:92`, unconditional push), and the divergence refusal is
pre-dispatch (target verification refuses before the device action, decision 3), so a divergent step is
never pushed. Across a repair session: original steps that verified and dispatched land in
`session.actions`; the divergent step is absent (refused pre-dispatch, never recorded); the agent's
corrective interactive action(s) land in `session.actions` with fresh `target-v1` evidence, because
recording is armed and armed recording also disables the direct-iOS fast path (PR #1196) so evidence is
computable. `formatSessionScript` over `session.actions` from the repair-run boundary (R6 — the slice
recorded during this repair, not the whole session history) is therefore the healed script: the path that
actually worked. The only net-new code is flag-threading plus one writer entry point.

**The two repair sub-flows (routed by the mechanical `repairHint`).** A `selector-miss` with
`matchCount: 0` (decision 3) is the same wire surface for "label renamed" and "app is on the wrong screen
entirely", so the sub-flow is not left to the agent to guess. The daemon computes a `repairHint` enum at
divergence time (R3 below) and sends only that value on the wire: `record-and-heal` selects the
selector-drift sub-flow, `state-repair` selects the app-state sub-flow. The agent follows the hint —
overriding with a fresh `screen.refs` read (or one `snapshot -i`) only when it is genuinely ambiguous —
rather than routing blind. The two sub-flows use different recording discipline:

1. **Selector drift** (expected screen, one control renamed or moved): the agent presses the correct
   control via a blessed `@ref` from `screen.refs` — recorded (no `--no-record`). This corrective
   action, with fresh evidence, becomes the healed step. Then `replay --from N+1 --plan-digest
   <original>` continues past the step the agent just performed. If a later step also diverges, the loop
   repeats.
2. **App-state divergence** (the script is correct; the app is simply in the wrong state): the agent
   drives the app to the expected state with `--no-record` actions — one-time state setup, not script
   steps, and must not pollute the healed script — then `replay --from N --plan-digest <original>`
   re-runs the *unchanged* step N, which now matches.

**Required protocol rules (normative).** These seven rules are the difference between "the mechanism
works" and "healed scripts are always valid":

- **R1 — recording is armed from the first replay, not on divergence.** `replay <file>.ad
  --save-script[=<out>]` sets `session.recordSession = true` before step 1, not on divergence. Prefix
  steps are re-executed during the repair replay; only if recording is armed from the start do they land
  in `session.actions` with fresh `target-v1` evidence. Arming late yields a hybrid healed script (an
  annotated corrective step glued to a bare, unannotated prefix) that re-diverges on its own next replay
  (`packages/daemon/src/execution/interaction/internal/interaction-common.ts:64-65` attaches evidence only when `recordSession` was
  true when the step ran).
- **R2 — `--from` continuation only; never re-run the full replay on the same session.** After a
  divergence at step N and the corrective action, the agent must continue with `replay --from k
  --plan-digest <original>`, not a fresh full `replay`. A full re-replay on the same session re-appends
  the already-recorded prefix `1..N-1` to `session.actions` — duplication, because
  `session-action-recorder.ts:92` pushes unconditionally and replay dispatch does not inject `noRecord`.
  The two sub-flows differ in `k`: app-state uses `k = N` (re-run the unchanged step after fixing state);
  selector-drift uses `k = N + 1` (the agent already performed step N manually; do not re-run it).
- **R3 — a mechanical `repairHint` on the divergence payload gates the sub-flow; no LLM-only routing.**
  The `repairHint` enum is computed **daemon-side at divergence time, never by the agent**, from two
  inputs the daemon already holds: (i) the recorded `targetEvidence` — the daemon owns the parsed
  `target-v1` `ancestry`/`scrollRegion` (decision 3), *when the diverged action carried an annotation* —
  and (ii) the divergence's own screen capture — the daemon owns the whole current tree, not the flat,
  20-capped `screen.refs` shipped on the wire. Only the resulting enum value crosses the wire, so "the
  wire omits `ancestry`" is moot: the container-presence test runs where both inputs exist.
  **Capture timing differs by kind, and the test uses whichever capture the kind already provides:** a
  target-binding kind (`selector-miss`/`identity-mismatch`/`identity-unverifiable`) verifies before
  dispatch, so its capture is the PRE-action tree; an ordinary `action-failure` (the dispatch-thrown
  path, per PR #1223) captures its screen AFTER the failed response, so its capture is the POST-response
  tree. The post-response tree is adequate for the only question the test asks — "does the recorded
  container currently exist?" — so `action-failure` does not need a separately stored pre-action tree.
  The mapping covers all four divergence `kind`s:
  - **selector-miss** (`matchCount: 0`): recorded container still present in the current capture →
    `record-and-heal` (selector drift); container absent or the screen differs → `state-repair`
    (app-state).
  - **identity-mismatch** (`matchCount >= 1`, wrong identity) → `caution`: something matched the recorded
    selector, so a blind re-press may repeat the mistake.
  - **identity-unverifiable** → `manual`: future replays block this step pre-action, so heal-by-doing is
    a poor fit.
  - **action-failure** → the same container-presence test over its post-response capture: container
    present → `record-and-heal`, else `manual`.

  The mapping is **total**: every (`kind` × evidence-presence × capture-availability) triple resolves to a
  defined enum, and any case that cannot be proven safe defaults to `manual`. Two fail-safes make it so.
  First, when the diverged action carried **no recorded `targetEvidence`** — PR #1223 wraps unannotated
  actions too, so this is reachable for `action-failure` and for any kind on a legacy/unannotated script —
  there is no recorded container to test → `manual`. Second, when the divergence capture is sparse or
  unavailable so the container-presence test cannot run → `manual`. This resolves the routing mechanically
  instead of leaving it to agent judgment.
- **R4 — corrective actions must materialize to selector form; the writer fails loudly on a bare `@ref`
  cross-session export.** A `press @e12` normally resolves a `selectorChain` at runtime
  (`packages/daemon/src/execution/interaction/internal/interaction-touch-targets.ts`), which `buildOptimizedActions`
  (`packages/daemon/src/core/session-script-writer.ts:368-377`) rewrites to a selector line. If no `selectorChain` was
  captured, the writer must refuse to emit a bare `@ref` line into a persisted `.ad` — a session-bound
  ref will not resolve in a fresh run. It **fails loudly**: an error surfaced to the user with a non-zero
  exit, never a swallowed or silently-dropped line (existing session-write paths swallow such failures;
  this one must not), so the repair never ships a non-replayable script.
- **R5 — the repair session must contain a recorded `open`.** The repair must start with a `replay` of a
  script whose step 1 is `open --relaunch` (or an explicit recorded `open`), so the healed `.ad` is
  self-contained.
- **R6 — the healed script is bounded to the repair run, not the whole session.** `replay --save-script`
  records a **boundary watermark** = `session.actions.length` at the replay invocation (see "Emitting the
  healed script" below). The healed `.ad` serializes only actions from that watermark onward — the repair
  replay's own execution path — so a reused session's earlier, unrelated actions never leak into the
  healed script. This makes the healed output independent of prior session history without requiring a
  fresh session for the repair itself.
- **R7 — the repair transaction spans the whole live session; the session stays addressable until the
  transaction ends (commit or abort).** `--save-script` opens a multi-invocation repair **transaction**
  whose state **persists on the session** — it is not re-derived from each request's flags. A repair-armed
  replay that returns `REPLAY_DIVERGENCE` with **`resume.repairSessionHeld: true`** (decision 4 — the
  distinct session-lifetime signal, NOT `resume.allowed`, which conveys plan-resumability only and is
  emitted for every divergence) **MUST NOT** tear down the owning daemon or session. **Continuation is by
  persisted transaction state, not the per-request flag:** `replay --from <n> --plan-digest <sha>` resumes
  the repair on that same armed session **without repeating `--save-script`** — the opener is the only
  place that flag appears — and the implementation MUST key keep-alive and continuation off the session's
  persisted transaction, never off whether the current request carried `--save-script`. The boundary
  watermark (R6) and the accumulating `session.actions` slice only mean anything if that one session
  survives across invocations. This strengthens R2: same-session continuation is not merely preferred, it
  is a lifetime guarantee.

  **Commit is at teardown, gated on `COMPLETE`.** Any teardown of the session — an explicit `close`, an
  idle-reap, or a daemon shutdown — **commits** the healed `.ad` atomically **iff** the transaction is
  `COMPLETE`, and otherwise **aborts** with no publish (never a prefix), per the commit state machine
  below. An idle-reap or shutdown of an INCOMPLETE transaction additionally leaves a **tombstone** (R7's
  ownership guarantee, under "Repair-session tombstone" below), so a later command on that session key
  surfaces a specific `REPAIR_SESSION_EXPIRED` recovery error with re-run guidance, never a bare
  `SESSION_NOT_FOUND`; an explicit `close` of an incomplete transaction simply discards. A
  **persistent-daemon precondition is explicitly rejected**: if some implementation constraint would
  prevent keep-alive, the armed replay must **fail-fast before step 1** with actionable guidance, never
  proceed and then fail a later `--from` with `SESSION_NOT_FOUND`.

  **Interaction with the CLI client's one-shot teardown (issue #1384).** A repair-armed replay that
  completes cleanly (no divergence, transaction reaches `COMPLETE`) skips its terminal source `close` by
  design (above), so the session always survives the run. Once the client keeps a one-shot `replay`'s
  owning daemon alive whenever the session survives (`ReplayCommandResult.sessionActive`, independent of
  repair state), that keep-alive now applies here too: the healed `.ad` commit — gated on teardown, not on
  the replay response — is deferred past the request that completed it, landing only when the agent issues
  an explicit `close`/`close --save-script` or ordinary idle-reap tears the session down. This is the
  correct shape of "commit at teardown" (the session stays addressable for inspection immediately after a
  completed repair, per R7), but it changes observable timing for a scripted caller that previously saw
  the healed sibling appear the instant the one-shot client process exited.

**Terminal lifecycle steps during a repair-armed `--from` resume.** Verification is scoped, per decision
3, to *annotated resolved targets* — so a non-target step (a source `close`, or any step carrying no
`target-v1` `targetEvidence`) is already exempt from target-binding divergence: it may still surface an
`action-failure` if its dispatch genuinely fails, but never a `selector-miss`/`identity-mismatch`/
`identity-unverifiable` merely for lacking evidence. This is a clarification of decision 3's existing
scope, not a change to it. The **terminal source `close`** is defined precisely as *the last action of
the source plan being a `close`*. During a repair-armed replay or resume that terminal source `close` is
**SKIPPED — not dispatched**: dispatching it deletes the session mid-transaction (the very session R7
keeps alive), so it must never run under an armed repair. Reaching it instead marks the transaction
`COMPLETE` (see commit state machine); the next teardown of the session — normally the agent's own
`close`/`close --save-script` — then commits (a teardown at `COMPLETE` always commits; R7).

**Acceptance test (mandatory).** A healed sibling `.ad` produced by the repair loop must replay
end-to-end in a **fresh session** with every selector step annotated and no bare `@ref`.

**Digest and resume — unchanged, live-session loop.** Per decision 4, "editing a script requires a fresh
full replay" governs validating a persisted, on-disk *edited* `.ad`. It does not block the live loop
here: the repair happens in one live session against the unedited original file, so its plan digest is
stable — `--from k --plan-digest <original>` is exactly decision 4's already-designed "perform step
manually, then resume" loop. Steps `1..k-1` never re-run, so decision 4's non-idempotency guarantee holds
by construction. The healed `.ad` is written only when the repair ends (below) and is a fresh script for
*future* runs, carrying the same pre-existing non-idempotency caveat as any hand-written `.ad`.

**Emitting the healed script — opt-in via `--save-script`.** Arming and emission reuse the existing
`--save-script` vocabulary and the precedented close-time write:

- `replay <file>.ad --save-script[=<out>]` arms the repair loop at invocation, before step 1: it sets
  `session.recordSession = true` (mirroring the existing `saveScript` handling in `session-lifecycle/internal/session-close.ts`)
  **and** records the repair-run boundary watermark `session.actions.length` (R6). Absent this flag,
  replay behaves exactly as today: no recording, no heal. The heal is opt-in, preserving decision 1's "no
  silent rewrite."
- The healed `.ad` is published when a teardown commits the transaction at state `COMPLETE` — normally the
  agent's own `close`/`close --save-script <out>`, but any teardown of a completed transaction commits
  (see the commit state machine below) — reusing the existing `session.actions` serializer
  (`SessionScriptWriter.write`, `packages/daemon/src/core/session-script-writer.ts:120-158`) over the post-watermark slice
  only (R6). When no
  `<out>` path is given, the default is the **`<original-stem>.healed.ad` sibling**: the original script's
  path with its `.ad` extension replaced by `.healed.ad` (e.g. `flows/login.ad` → `flows/login.healed.ad`),
  written beside the original. The original is never overwritten in place without an explicit `<out>`
  path, so a human reviews the diff and promotes it.

**Commit state machine — `ARMED` → `COMPLETE` → `COMMITTED`.** R6 defines the *slice*; this defines *when
the slice may be published*, as a machine-enforceable state, not a heuristic:

- **`ARMED`** — set the instant `replay --save-script` arms the transaction (before step 1). The healed
  slice is accumulating but MUST NOT be published.
- **`COMPLETE`** — reached when the source plan has executed/healed through its **last executable step**
  with **no outstanding divergence** (the terminal source `close` is excluded from "executable" here —
  see the terminal-close contract above; reaching it is what flips `ARMED` → `COMPLETE`). Only in this
  state is a publish permitted.
- **`COMMITTED`** — the healed `.ad` has been atomically published (below). Terminal.

**Teardown is the commit trigger, gated on `COMPLETE`.** Any teardown of the repair-armed session — an
explicit `close`/`close --save-script`, an idle-reap, or a daemon shutdown — commits the healed `.ad`
**iff** the state is `COMPLETE`. A teardown while **not** `COMPLETE` is an **ABORT**: discard the slice,
publish **nothing** — never a prefix. Reaching `COMPLETE` does not itself write a file; it only makes the
*next* teardown a commit rather than an abort, so the artifact is published exactly once — when the
transaction has both completed and ended. Commit is thus gated on `COMPLETE` but happens at *any* teardown
(safer for the artifact than requiring one specific finalize command, and the model #1235 implements).
Teardown after `COMMITTED` is **teardown-only, idempotent — no re-publish** (so it can neither
double-commit nor trip the no-clobber guard).

**Atomic, race-safe publication.** The commit serializes the healed slice (ending with a serialized
`close` line so the artifact is self-contained) to a temp file created **in the same directory as the
final target** — an explicit `--save-script=<path>` target may live on a different mount than any
process-wide temp dir, and `linkSync` requires the same filesystem — then publishes with a single
exclusive `linkSync(temp, target)`: create-if-absent, first writer wins. A reader therefore never
observes a half-written healed script, and an aborted repair leaves no partial behind.

**Publication refuses ANY pre-existing target — complete or partial, default or explicit path alike.**
An earlier design distinguished a *complete, review-worthy* artifact (protected) from an incomplete or
partial one (silently overwritable), enforced through a publish lock. That distinction added a whole
class of lock/lease/reclaim races for a case that is, in practice, a degenerate state: a partial healed
file left behind by an aborted or reaped repair. The simpler, adopted design collapses this: the atomic
`linkSync` itself decides the winner (`EEXIST` iff a file already sits at the target, regardless of its
contents), and the caller must explicitly clear the way — remove the existing file, or pass a different
`replay --save-script=<path>` — rather than have it silently replaced. No lock, no lease, no steal, no
overwrite. The `# agent-device:heal-complete` trailing sentinel remains — it still marks a healed `.ad` as
a complete, review-worthy repair artifact for any other reader — but it no longer participates in the
publish decision. Auto-versioned output names (e.g. `.healed.2.ad`) are explicitly **out of scope** here —
a separate naming change, not part of this decision.

**Scope: this refusal is uniform across repair AND ordinary recording, not repair-only.** Everything
above is written in the context of decision 6's repair-armed heal, but `publishHealedScriptAtomically`
(`packages/daemon/src/core/session-script-writer.ts`) is the single publish primitive `SessionScriptWriter.write` calls
for every `--save-script` target, with no repair-armed-vs-ordinary branch — a repair-armed heal
(`saveScriptBoundary` set) and an ordinary, non-repair `open --save-script`/`close --save-script`
recording (`saveScriptBoundary` absent) publish through the exact same exclusive `linkSync`. Before this
decision, ordinary recording published via a separate atomic rename-replace path
(`publishOverwriteAtomically`, since removed), silently overwriting an existing target; that overwrite
path is gone. An ordinary recording whose target already exists is now refused exactly like a healed
repair publish would be: `EEXIST` surfaces as the same `AppError`, the existing file is left
byte-for-byte unchanged, and the caller must remove it or choose a different `--save-script=<path>`.
There is no `--force`/`--overwrite` escape hatch for either path today; that is tracked as a future
follow-up (#1258), not part of this decision.

**Repair-session tombstone (R7 ownership).** When a bounded-expiry escape hatch idle-reaps (or a daemon
shutdown tears down) a repair-armed transaction that has **not** reached `COMPLETE`, the teardown aborts
(no publish, per the state machine) and must leave a **tombstone** rather than deleting the session record
outright. (A teardown of a `COMPLETE` transaction instead *commits* and needs no tombstone — the
transaction ended successfully.) The tombstone is keyed by the **session key** (the same
owner-scoped session identifier a `--from` continuation addresses), records the **owner** and an
**expiry**, and lives for a bounded window after reap. While it exists, any command targeting that key —
a `--from` resume, an interactive heal step, or a `close` — resolves to `REPAIR_SESSION_EXPIRED` (with
re-run guidance to restart the repair from the original script), never a bare `SESSION_NOT_FOUND`. A new
`replay --save-script` on the same key **clears the tombstone and starts a fresh transaction** (`ARMED`).
The tombstone itself expires after its bounded window, after which the key is fully free.

> **Amendment (#1271 stage 2): repair-segment default exclusion of observation-only commands, and the
> `--record` opt-in.** #1271 reported that read-only diagnostics an agent runs mid-repair to LOCATE the
> repair target — `snapshot -i`, `get attrs`, `find`, `is` — recorded into the healed script exactly like
> the corrective action itself. The wave-3 E3 experiment measured 0/4 trials producing a clean healed
> script hands-off; one recorded `get attrs` caused a second, self-inflicted `identity-mismatch` divergence
> on fresh replay. This amendment excludes these observations by default. An agent can explicitly record
> a corrective observation with `--record`.
>
> **1. Which observations are excluded — a PROVENANCE rule, not a command-class rule.** The exclusion
> applies to an observation that is BOTH:
>
> - **observation-only by command**: `snapshot`, `get`, `is`, or a **read-only** `find` sub-action
>   (`exists`, `wait`, `get_text`, `get_attrs`). A **mutating** `find … click|fill|focus|type` is not in
>   this set — it is a corrective action like `press`/`fill` and always records. The top-level `wait`
>   command is deliberately **not** in this set either: it is flow timing/synchronisation (pacing the
>   script), not observation, so it must keep recording unconditionally — a healed script that silently
>   dropped its own timing steps would replay differently from what actually happened; **AND**
> - **dispatched OUT OF BAND**: typed by the agent mid-repair, NOT replayed from the `.ad` plan under
>   repair.
>
> The second clause is load-bearing and is the rule's real discriminator. Replayed plan steps dispatch
> through the ordinary request path and land in `session.actions` like any other action, and the healed
> script IS that slice (`buildOptimizedActions` over `session.actions.slice(saveScriptBoundary)`). So a
> command-class-only exclusion would replay an authored `is visible` assertion and then **silently drop it
> from its own healed script** — the repaired flow would quietly stop checking what the original checked,
> which for a deterministic QA suite is the worst possible failure mode. **Planned prefix/suffix
> observations must survive automatically; a user must never have to annotate authored `.ad` steps with
> `--record` to keep them.** An authored observation and an interactive diagnostic read are the same
> command, so only provenance separates them.
>
> Provenance travels as `internal.replayPlanStep`, stamped by `invokeResolvedReplayAction`
> (`src/daemon/handlers/session-replay-action-runtime.ts`) — the single point every plan step is
> dispatched, so the marker covers annotated and unannotated steps alike. `internal` is a daemon-only
> channel (`toDaemonRequest`, `packages/daemon/src/server/http/http-rpc-methods.ts`, never copies it off the wire), so
> authored provenance cannot be spoofed by a client; this is the same channel `replayTargetGuard` and
> `findResolvedTarget` already use. The rule is written once, in `isInteractiveObservation`
> (`packages/daemon/src/core/session-action-recorder.ts`), and both recording call sites consume it.
>
> **2. The corrective-read trap: why even out-of-band reads need an opt-in.** Excluding every out-of-band
> read is still not safe on its own: a divergence's **correction** can itself be a read. In the wave-3 E3 drift, the diverged step **was** a `get`, so its corrective replacement is a
> recorded `get` that **must** land in the heal — a blanket read-exclusion would silently drop the very
> step being repaired, producing an incomplete heal with no signal anything was missing (the same class of
> silent-failure mode decision 3 exists to close for target-binding, and decision 6 R4 exists to close for
> bare `@ref` exports). Distinguishing "the read that replaces the diverged step" from "reads used to locate
> the target" by POSITION (e.g., relative to the eventual `--from` resume) was considered and rejected: the
> daemon records each action as it happens and has no reliable way to know, at record time, which one the
> agent will later treat as the resume boundary — and a position-based rule would silently reinterpret
> intent after the fact rather than let the agent state it. The adopted rule instead makes this an **explicit
> opt-in per action**: `--record` (below) marks the ONE read that must count, independent of its position in
> the repair segment.
>
> **3. Explicit recording remains possible.** `--record` forces an out-of-band observation into the heal
> even though its command is observation-only. It exists for exactly one job: an interactive corrective
> read the agent is deliberately inserting into the healed script. It is a no-op outside a repair-armed
> session (there is no default exclusion to override), and it is **not** needed for authored plan steps —
> those survive on provenance alone (rule 1).
>
> `--record` is **not a common flag**, unlike `--no-record`. `--no-record` applies to every recordable
> command, mutations included, so it stays universal
> (`COMMON_COMMAND_SUPPORTED_FLAG_KEYS`). `--record` only means something for a command the exclusion can
> drop, so it is scoped **statically** to `snapshot`, `get`, and `is` through each command schema's
> `allowedFlags` — accepting it on `press`/`fill`/`click` would be misleading, and the grammar rejects
> unsupported uses before projection. `find` is the one command whose observe-vs-mutate split is a
> POSITIONAL rather than the command name, so it cannot be settled statically: it allows `--record`
> in the grammar and validates **dynamically** in the daemon (`handleFindCommands`), rejecting
> `--record` on a mutating `find … click|fill|focus|type` with `INVALID_ARGS` before any device work. Both
> halves read one shared predicate (`isReadOnlyFindAction`, `@agent-device/selectors`), so the routing and
> the validation can never disagree about which sub-actions observe.
>
> `--record` and `--no-record` express opposite intents for the same action and are **mutually exclusive**:
> passing both is rejected as `INVALID_ARGS` before the command runs, uniformly for every surface, rather
> than letting one silently win.
>
> **4. How the rule projects across CLI/Node/MCP surfaces.** The exclusion is enforced at a single
> daemon-side choke point — `isExcludedRepairSegmentObservation` in `recordActionEntry`
> (`packages/daemon/src/core/session-action-recorder.ts`), gated on `session.saveScriptBoundary !== undefined` (set ONLY
> by a repair-armed `replay --save-script`; an ordinary, non-repair `open --save-script`/`close --save-script`
> authoring recording never sets it — see decision 6's "Scope" note above) and on the entry's
> `interactiveObservation` marker, which both recording call sites
> (`packages/daemon/src/core/selector-recording.ts` for `get`/`is`/read-only `find`, `packages/daemon/src/sessions/snapshot-runtime.ts` for
> `snapshot`) compute from the shared `isInteractiveObservation` predicate rather than each re-deriving it.
> Every surface reaches this same function because every surface's request reaches the same daemon.
>
> The flags project asymmetrically, matching their different scopes:
>
> - `--no-record` stays a common flag: its key is in `COMMON_COMMAND_SUPPORTED_FLAG_KEYS`, and every
>   recordable reader forwards it through the shared `noRecordInputFromFlags` helper
>   (`src/commands/cli-grammar/common.ts`, per #1304).
> - `--record` is scoped: its key is NOT common, it appears in `allowedFlags` only for `snapshot`/`get`/`is`
>   (plus `find`, which validates dynamically per rule 3), and only those readers spread
>   `observationRecordInputFromFlags`. Two named helpers rather than one helper with an `allowRecord`
>   policy argument: the capability is then the helper's NAME, so a mutating reader physically cannot
>   forward `--record`, whereas a policy argument would let a future mutating reader opt in by flipping a
>   literal with no schema change — the fail-open the split exists to prevent.
>
> From there both flags ride the ordinary typed path: the Node client threads them through
> `buildRequestFlags`/`buildFlags` (`src/commands/command-flags.ts`) from `InternalRequestOptions` and each
> typed per-command Options type (`GetOptions`/`IsOptions`/`FindOptions`/`CaptureSnapshotOptions`), and the
> MCP tool schema exposes `record`/`noRecord` on the `get`/`is`/`find`/`snapshot` tools
> (`src/commands/interaction/metadata.ts`, `src/commands/capture/snapshot.ts`) through the same
> `CommandMetadata.inputSchema` + `readMetadataCommandFlags` path every other typed field already uses. No
> surface has a separate recording contract; all of them hit the identical daemon-side default.
>
> **5. The fail-loud guard is the EXISTING resume watermark, not new state.** Because the exclusion happens
> at the same point `--no-record` is enforced — before an action ever reaches `session.actions` — an excluded
> diagnostic read never grows `session.actions.length`. That counter is exactly what
> `describeUnperformedRecordAndHeal` (`src/daemon/handlers/session-replay-runtime-plan.ts`, R2/#1262's
> `pendingRecordAndHeal` watermark) already compares against `actionsCountAtDivergence` to prove a corrective
> action happened before authorizing a `record-and-heal`-shaped `--from` resume. No additional bookkeeping is
> needed: a repair segment containing only excluded diagnostic reads is indistinguishable, at that check,
> from a repair segment containing no activity at all, so the existing guard already refuses it. This
> amendment only updates the guard's message to name `--record` alongside the existing `--no-record`
> mention, since the missing corrective action may have been a read rather than a press: "no corrective
> action was recorded in this repair segment; press the correct control via a blessed `@ref` … — or, if your
> corrective action was a read, re-run it with `--record` … — before resuming."
>
> **Regression coverage** proves: an out-of-band diagnostic read inside an armed repair segment is omitted
> from the healed script by default; an **authored** `is visible` plan step in the same repair, carrying no
> `--record`, **survives** into the heal (the provenance rule — this fails if the exclusion is
> command-class-only); a corrective action remains for both a mutating press/fill (unaffected — never
> observation-only) and a `--record`ed read (the diverged-step-was-a-`get` case); the resulting healed
> script replays cleanly in a fresh session; `--record` on a mutating `find … click` is refused with
> `INVALID_ARGS`; the empty-segment guard refuses a blind resume with the actionable `--record` hint; and
> ordinary, non-repair `open --save-script` authoring recording is completely unchanged — a read in a fresh
> authoring session still records with no flag needed, because `session.saveScriptBoundary` is never set
> there.

## Consequences

- `--from` makes app state the caller's responsibility, and only accepts a resume when the planner can
  prove its variable and control-flow state is independent of skipped execution **and** its plan digest
  matches the reported plan. The daemon has no way to know that the app is actually in the state step N
  expects. The live nav-state-persistence divergence in Context is the canonical case: the app, not the
  script, decides what screen a relaunch lands on.
- **Non-idempotent scripts are exactly why `--from` must never re-run steps `1..N-1`**: a script that
  creates a record, navigates, then asserts on it would double-create on any re-run of its early steps.
  This is a hard constraint on the flag's semantics, not an implementation nicety.
- **Retiring heal-as-actor removes CI self-repair for agentless callers.** `--update` may return bounded
  suggestions but never rewrites the script. A nightly run that once patched a selector now stays red.
  This is accepted because the audit found the mechanism rarely useful and a silent patch is a
  target-binding risk: selector agreement is not proof of the same target.
- **Successful structural-collapse disclosure adds bounded diagnostic bytes, not reusable targets.** Its
  pre-action alternatives describe wrappers consumed by the mutation. A distinct-subtree rejection is
  different: no mutation occurred, so its at-most-five candidate refs are immediately reusable through
  the issued partial frame. Direct iOS unique responses pay only the explicit `not-observed` marker.
- **Recorded identity evidence is an additive `.ad` format change.** It adds one reserved JSON comment
  before each supported recorded target action; scripts without the comment remain valid. A duplicate that
  survives structural evidence is intentionally a pre-action unverifiable divergence, not a best guess.
- **The original geometric mutation heuristic was superseded after element-14 realized its documented
  mis-binding risk.** Blanket hard-reject remains inappropriate because React Native commonly exposes
  a row/button/text wrapper chain under one label. Structural equivalence preserves that benign case,
  while distinct subtrees reject instead of letting visibility, depth, or area choose a semantic target.
- **Decision 6's residual risk is old risk, not new.** The agent can press the wrong visible ref — live
  interactive commands have no target-binding verification anywhere in this codebase today (see (c) in
  Context) — but that is ordinary agent-driven-interaction risk, not a new class this decision
  introduces. The retired-heal failure mode ("selector agreement is not proof of the same target") is
  structurally impossible here: nothing re-matches a stale selector, because evidence is derived fresh
  from the node the agent actually pressed.
- **`screen.refs` is bounded, per decision 4.** The divergence report's `screen.refs` is capped at 20
  entries at default/full level and may be filtered; if the control the agent needs is not among them,
  one extra `snapshot -i` recovers it — a bounded, disclosed cost, not a silent gap.

## Alternatives considered

- **Guarded sequences as a new batch engine**: rejected — replay already is a step-sequenced engine
  with progress and failure reporting; the gap is disclosure/verification/resumability on the existing
  engine, not a second one.
- **An `--agent`/agent-mode flag on `replay`**: rejected — no semantic fork is needed once the
  divergence report is simply the richer default failure shape. A deterministic CI caller does not need
  protection from a richer error payload it can ignore.
- **Keep `--update` auto-heal, add target-binding verification to it**: rejected — decision 3 verifies
  the resolved target without retry-and-rewrite behavior. Revisit only if agentless CI needs a separately
  specified and testable repair policy.
- **Auto-heal tiers** (safe-tier heals applied automatically, risky-tier surfaced): deferred, not
  rejected outright — there is no current evidence base for which heals are "safe," and tiering now
  would be speculative. Revisit if agentless CI demand for some self-repair materializes.
- **Hand-edit `.ad` text (status quo)**: rejected — hostile to models. Measured 2026-07-12: a small
  model (Haiku) repair run thrashed 26 turns and corrupted the `.ad` to `INVALID_ARGS` editing
  escaped-quote selector chains.
- **Silent auto-rewrite (the old `--update`)**: already retired (decision 1) — mis-binding risk;
  selector agreement is not proof of the same target.

## Context and evidence at acceptance (2026-07-10)

This section records the repository state audited on 2026-07-10, before the decisions above
shipped. Its present-tense observations and code pointers are historical evidence; the decisions
above and the gates they name are the authoritative record of current behavior.

At acceptance, replay was deterministic. `.ad` scripts were plain text — one action per line, `#`
comments, and a `context platform=... device=... theme=...` header (`src/replay/script.ts`) — recorded
via `open --save-script` (`packages/daemon/src/core/session-action-recorder.ts`,
`packages/daemon/src/core/session-script-writer.ts`) or hand-written, and executed step-by-step by
`runReplayScriptFile`
(`src/daemon/handlers/session-replay-runtime.ts`) under the daemon's `replay`/`test` commands
(`src/daemon/handlers/session-replay.ts`). Recorded touch/fill/get targets are selector chains with
`||` alternates (`buildSelectorChainForNode(...).join(' || ')`,
`src/commands/interaction/runtime/resolution.ts:242`, mirrored in
`src/daemon/handlers/session-replay-heal.ts:131-135`); Maestro YAML flows import through `--maestro`
(`packages/maestro/src/internal/`); progress is step-indexed (`stepIndex`/`stepTotal` in
`emitReplayTestActionProgress`, `session-replay-runtime.ts:243-260`).

Recovery was opt-in `--update`/`-u` healing (`replayUpdate` flag,
`src/commands/cli-grammar/flag-definitions-workflow.ts`). It only fires after a step has already
returned a hard failure (`session-replay-runtime.ts:118-149`: `if (!shouldUpdate) return failure; ...
healReplayAction(...)`), and it only retries the SAME recorded selector material —
`collectReplaySelectorCandidates` (`session-replay-heal.ts:39-81`) gathers the step's originally
recorded `selectorChain`/positionals, then `resolveSelectorChain` re-resolves those exact candidate
strings against a freshly captured snapshot (`session-replay-heal.ts:122-135`). If the identifying term
itself changed — an id or label rename — the same string will not match the new tree either, so heal
cannot rescue renames; it can only recover drift the ORIGINAL selector still matches (a moved or
re-rendered node with the same id). PR #297 (closing #279) already trimmed heal once, removing
`refLabel`-synthesis and numeric `get text` drift healing to keep it "centered on recorded selectors and
explicit selector expressions" — heal has a maintained history of narrowing, not growing.

**Benchmark evidence** (2026-07-09/10, iOS simulator, react-navigation/RN playground matrix; harness
follows the `~/.agent-device-bench/rnnav-matrix.py` pattern, external — the key numbers are recorded
here so the evidence stays durable without the harness directory):

| Measurement | Result |
| --- | --- |
| Snapshot captures per interaction, `--settle` off → on | 3.67 → 1.00 (the 1-snapshot floor) |
| Commands per task, settled arm vs unsettled arms | 14.3 vs 23.3 / 26.7 |
| react-navigation Maestro suite via deterministic replay | 38/38 flows green in 539 s, zero model turns |

With the settle loop at its snapshot floor, wall time for an agent-driven QA flow is dominated by model
turn latency, not device I/O. A happy-path agent-driven QA flow costs O(steps) model turns end-to-end; a
deterministic replay of the same flow costs O(divergences) — the 38/38 sweep is that limit realized at
zero divergences. The entire economic case for replay is collapsing the per-step model-turn cost toward
zero on the happy path and paying only where reality diverged from the recording.

**Audit evidence** (2026-07-10) on where that divergence cost actually goes follows as historical
evidence. Its identified geometric-mis-binding risk was realized by element-14 and superseded by the
2026-08-07 structural-equivalence-or-reject amendment above:

- **(a) Heal is narrow and mostly unable to act.** Per the mechanism above, heal only recovers
  same-selector drift. Most real replay failures are renames or removals heal's candidate-recycling
  cannot reach.
- **(b) The real mis-binding surface is not heal — it is silent disambiguation in ORDINARY resolution**,
  live and replay alike. `resolveSelectorInteractionTarget` calls `resolveSelectorChain(..., {
  disambiguateAmbiguous: true })` on every press/click/fill (`resolution.ts:170-183`); when a selector
  matches N>1 nodes, `accumulateDisambiguationCandidate`/`compareDisambiguationCandidates`
  (`packages/selectors/src/internal/resolve.ts:181-285`) silently pick a winner — visible candidates over
  off-screen ones, then deepest node, then smallest on-screen area, only an exact tie failing.
  `describeResolvedInteractionNode` (`resolution.ts:227-249`), the response's entire identity payload,
  carries `node`/`selectorChain`/`refLabel`/`targetHittable`/`hint` — no match count, no signal a
  tiebreak happened at all. This was live-reproduced during the audit on an RN playground screen with
  two identical-rect "Prevent Remove" buttons, where scroll position alone decided which one a selector
  hit. The general policy is documented (`agent-device help workflow`,
  `src/cli/parser/cli-help.ts:243,384`: "does not fail by default ... auto-resolves deepest node first
  ... then smallest on-screen area") but never disclosed per response — an agent that hasn't read the
  help topic, or whose target moved between recording and replay, gets no signal a heuristic rather than
  an exact match chose its target.
- **(c) No target-binding verification existed in this path at acceptance.** `--verify`
  (`captureEvidenceBaseline`, `resolution.ts:45-58,104-134`; the `verifyEvidence` guarantee cell in ADR
  0011's registry) attaches a pre/post-action node diff so the caller can see SOMETHING changed — it
  says nothing about whether the CORRECT node was the one tapped. A wrong-but-plausible pick (the
  sibling "Prevent Remove" button) produces a real, visible diff and is still the wrong action.
- **(d) Heal auditability was a bare count.** A successful `--update` run returned
  `{ replayed, healed, ... }` (`session-replay-runtime.ts:186-195`) — `healed` is a number, nothing
  else — and rewrote the `.ad` file in place via `writeReplayScript`
  (`session-replay-runtime.ts:182-184`, `src/replay/script.ts:459-484`) with no diff shown anywhere in
  the response.
- **(e) This silent-pick default is in real tension with this repo's general posture toward ambiguity.**
  Elsewhere, ambiguous input is refused and hinted about rather than silently guessed — `start`/`restart`
  are deliberately left out of the CLI alias-suggestion table because `start` is "genuinely ambiguous, so
  a hint beats silently guessing" (`src/cli/parser/command-suggestions.ts:16-17`). Selector resolution
  took the opposite default, and ADR 0011's own registry records that choice precisely: the
  `disambiguation` cell for `runtime-selector` is classified `{ kind: 'runtime', via:
  '...selectors-resolve.ts#resolveSelectorChain' }` (`packages/contracts/src/interaction-guarantees.ts:176-179`)
  — proving the heuristic runs consistently across paths, not that the caller is told it ran. That
  default is not being revisited here; see the rejected hard-reject alternative below for why.
- **(f) Issue #1037 / PR #1040 is the direct, partial precedent.** A UNIQUE-but-wrong match (Apple
  Maps' `text="Anthropic - Headquarters"` exact-matching a 30x30 map-pin annotation instead of the
  recents row) now surfaces as `targetHittable:false` plus a hint
  (`describeNonHittableTarget`, `resolution.ts:259-268`) — disclosed, but not prevented; the tap still
  lands on the wrong element, just no longer silently. Disambiguation (N>1 matches, as opposed to one
  unique-but-non-hittable match) has no equivalent disclosure today.
- **(g) Issues #279/#297 are precedent for trimming heal rather than growing it** when the evidence
  says a heuristic isn't earning its complexity — see above.

**Live hands-on evidence** (2026-07-10, driving replay by hand on the RN playground, iOS simulator,
both `.ad` and Maestro paths) grounds the same conclusions from the caller's seat:

- **Successful replay is silent in text mode.** Exit 0, zero output; `replayed: 5` appears only under
  `--json`. Structurally: replay's success payload (`{ replayed, healed, session, artifactPaths }`,
  `session-replay-runtime.ts:186-195`) has no `message` field, so the generic CLI success path prints
  nothing (`writeGenericCliOutput` → `readCommandMessage` → `writeCommandOutput`,
  `src/cli/commands/generic.ts:68-71`, `packages/kernel/src/success-text.ts:12-14`,
  `src/cli/commands/shared.ts:4-15`). An agent pays a verification turn just to learn what happened.
- **Failure output today is step + action + selector + a generic hint — no screen evidence.** The live
  divergence hit was pure app state: the RN example app persists navigation state, so relaunch+deeplink
  restored the Article screen and a perfectly correct selector legitimately missed. Heal can never fix
  that class (the selector isn't wrong; reality is), while one line of screen evidence ("current
  screen: Article") would have made the repair instant. The only recovery available was a full re-run —
  no `--from` — and re-running earlier steps is precisely what makes state-restoring apps
  nondeterministic across attempts.
- **Maestro step indices are untraceable to source today.** Breaking `tapOn: Push Input` — the 4th
  top-level YAML step — failed as "Replay failed at step 5 (`__maestroTapOn` ...)": the flow's
  `runFlow file: ../launch.yml` include had expanded into the linear plan and shifted every subsequent
  index, and no file or line appears anywhere in the failure. Code-verified: `--maestro` input flattens
  at parse time (`parseReplayInput`, `src/compat/replay-input.ts:47-68`) — `runFlow file:` inlines the
  included file's actions (`convertRunFlow`/`readRunFlowActions`,
  `src/compat/maestro/flow-control.ts:40-41,123-124`, via `parseRunFlowFile`,
  `src/compat/maestro/replay-flow.ts:267-280`), platform/`true` `when` conditions are evaluated at
  parse time (`flow-control.ts:47-48`), and `repeat.times` expands deterministically
  (`flow-control.ts:84-87`). Provenance is lost in two stages: every action converted from one root
  command inherits that PARENT command's YAML line (`convertRootCommands`, `replay-flow.ts:76-83`),
  and `parseRunFlowFile`'s callers keep only `.actions`, discarding the included file's own line table
  and path entirely. Even for `.ad`, the tracked line never reaches the caller: `actionLines` flows
  into the per-action ndjson trace (`appendReplayTraceEvent`,
  `src/daemon/handlers/session-replay-action-runtime.ts:47-56`) but `withReplayFailureContext`
  (`session-replay-runtime.ts:349-369`) puts only `replayPath` + `step` in the error details.
- **The same failure class reports differently per format.** An `.ad` selector miss is
  `COMMAND_FAILED` with the targeted hint "Run snapshot -i ... or use find ..."
  (`selectorFailureHint`, `packages/selectors/src/internal/resolve.ts:110-113`, thrown at `resolution.ts:213-217`);
  the equivalent Maestro miss is `ELEMENT_NOT_FOUND` constructed with no hint
  (`src/compat/maestro/runtime-interactions.ts:644-652`), falling through to the generic default
  "Retry with --debug and inspect diagnostics log for details." (`defaultHintForCode`,
  `src/kernel/errors.ts:253-254`).
- **Recordings contain zero verification steps.** The script writer strips every recorded `snapshot`
  action (`buildOptimizedActions`, `packages/daemon/src/core/session-script-writer.ts:315`: `if (action.command ===
  'snapshot') continue;` — only synthetic ref-scoped snapshots are re-inserted, as resolution aids, not
  observations), and the record-time flag allowlist (`RECORDED_FLAG_KEYS` from the flag
  declarations' `recorded` field, `packages/daemon/src/core/session-action-recorder.ts:367-381`) carries neither `settle`/`settleQuietMs` nor `verify`,
  so `--settle`/`--verify` are dropped from recorded steps. A recording therefore replays actions with
  no outcome observation at all — exactly the gap decision 3's record-time identity evidence fills.

A related, currently under-used precedent: recorded `@ref` steps already carry an optional identity
hint in the `.ad` file. `appendRefLabel` (`packages/daemon/src/core/session-script-writer.ts:532-537`) writes the
node's label as a trailing token, parsed back into `action.result.refLabel`
(`src/replay/script.ts:269,295,315`). Today that label is used only as a fallback LOOKUP key
(`tryResolveRefNode`'s `fallbackLabel`, `resolution.ts:393,413-430`) when the ref itself fails to
resolve, and to scope the pre-action snapshot capture (`buildScopedSnapshotAction`,
`session-script-writer.ts:136-155`) — never as a check against what disambiguation actually picked. It
establishes the pattern this ADR's decision 3 extends into a verification role: per-step identity
already travels in the `.ad` file.
