# ADR 0012: Interactive Replay (agent-in-the-loop repair, resolution disclosure, retiring silent `--update` healing, and agent-supervised re-record repair)

## Status

Accepted (2026-07-10). Implemented on `main`, including the amendments folded into the decisions below:

- #1264
- #1269
- #1271 stage 2
- #1280
- #1349
- #1385
- the 2026-08-07 mutating-ambiguity amendment

Only the replay benchmark extension of decision 5 remains deferred.
The per-step implementation record (PRs #1193-#1349) and the pre-acceptance migration plan are in the git history of this file.

## Rules at a glance

This is a normative summary, with one entry for each decision.
The binding contracts, amendments, and edge cases are in [Decision](#decision).
The registries and tests named there are the living source of truth.

1. **`--update` never rewrites.**
   The candidate machinery of heal only ranks the bounded `suggestions` list inside a divergence report.
   The order is identity components, then the same `scrollRegion` for a verified `target-v1` annotation, then document order.
   The list is deduplicated by node.
   No unattended repair path exists.
2. **Every element resolution discloses how it resolved.**
   The additive `resolution` response field has one of these values:
   - `runtime`/`unique`;
   - `runtime`/`disambiguated` (`matchCount`, `tiebreak`, up to 5 alternatives);
   - `ref`/`exact` or `ref`/`label-fallback`;
   - `direct-ios`/`not-observed`.

   Coordinate dispatches and executed maestro-fallbacks carry no `resolution`.
   Successful structural-collapse alternatives are pre-action diagnostics.
   Distinct-subtree rejection candidates issue a partial ref frame for immediate retry.
   ADR 0011's `resolutionDisclosure` guarantee row enforces this rule (`packages/contracts/src/interaction-guarantees.ts`).

3. **Recording writes `target-v1` identity evidence; replay verifies it before it acts.**
   One versioned JSON comment for each element-targeting action carries these items:
   - identity: unique id, else role+label, plus a leaf-anchored ancestry prefix;
   - disambiguation signals: `sibling` and region-scoped `viewportOrder`;
   - never-compared diagnostics: `rect`.

   Replay classifies every annotated step through six exact verification paths.
   Anything that the evidence cannot isolate is an `identity-unverifiable` divergence, never a silent pick.
   Amendments:
   - Non-unique ids demote to role+label (#1269).
   - An identity-empty pressed container records its first labeled descendant, double-guarded fail-closed (#1280).
   - `wait` landmark identity and `is` coverage dispatch on the `targetIdentityVerification` descriptor trait (#1349).
   - The pre-dispatch verification capture bounds-retries a content-quality `capture-failed`/`sparse-snapshot` verdict on an app-launch race.
     This retry is opt-in for each call site (#1385).

4. **Divergence is a structured error, resumable by plan ordinal.**
   The response is `ok:false` with code `REPLAY_DIVERGENCE` and `details.divergence` v1.
   `details.divergence` has these fields:
   - `kind`: `action-failure` | `selector-miss` | `identity-mismatch` | `identity-unverifiable`;
   - a bounded `screen`: the same capture scope as plain `snapshot`, with ranked refs (#1264), that activates a partial ref frame under ADR 0014;
   - one `repairHint` enum;
   - `resume`: `from`, optional `alternateFrom`, `planDigest`, and `repairSessionHeld`.

   Serialized ceilings for each response level are 8/24/64 KiB.
   Resume is `replay --from N --plan-digest <sha>`.
   Resume is replay-only (`test` rejects `--from`).
   Resume has no state reconstruction: skipped `outputEnv` producers or control flow reject the resume.

5. **Validation is contractual.**
   The coverage inventory under decision 5 gates acceptance:
   guarantee-matrix cells, parser/writer round trips, all six verification paths, wire-projection parity, and `--update` no-write.
   Benchmark evidence alone is insufficient.
6. **Repair is agent-performed and transactional.**
   `replay --save-script` opens a persisted ARMED -> COMPLETE -> COMMITTED transaction.
   Rules R1-R7 govern the transaction:
   - recording is armed from step 1;
   - `--from` continuation only;
   - the daemon computes `repairHint` routing;
   - fail-loud on bare `@ref` export;
   - the `saveScriptBoundary` watermark bounds the healed slice;
   - the session is kept alive until commit or abort;
   - exclusive-`linkSync` publication refuses any pre-existing target.

   Provenance (`internal.replayPlanStep`) excludes out-of-band observations from the healed script.
   `--record` is the per-action opt-in (#1271 stage 2).

## Decision

### 1. Retire `--update` healing as an actor; repurpose its candidate machinery as ranked suggestions

`--update`/`-u` stops silently rewriting `.ad` files.
It already has two pieces of machinery:
`collectReplaySelectorCandidates` (recorded-chain/positional extraction) and the `resolveSelectorChain` re-resolution that it drives.
These are repurposed to populate the ranked `suggestions` list inside the divergence report (decision 4).
They do not act unattended.

**Ranking is a total order:**

1. Candidates that satisfy more identity components rank first.
   A recorded-id match precedes a role+label match. A role+label match precedes a label-only match.
2. For a verified `target-v1` annotation, equally strong candidates in the recorded `scrollRegion` rank before candidates in other regions.
3. Document order resolves the remaining ties.

Suggestions are deduplicated by node.
A node reached through several recorded selector terms appears once, with its strongest match basis.
Decision 4's suggestion cap bounds the list.
Response levels affect only report content, never file behavior.
At every level, `--update` performs no rewrite and returns the same bounded suggestions object.
`--level digest` omits entries and includes `suggestionCount`, as decision 4 specifies.

An agent can accept, reject, or edit a proposed repair in one inexpensive model turn.
This costs less than detection of a silent incorrect repair later.
Audit item (a) in Context also found that heal could rarely act.
A proposal that an agent can accept, reject, or edit is strictly more valuable than the same proposal applied blind.

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
A press that was allowed to fall back but hit its element normally is the direct-iOS path, and it discloses `not-observed`.
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
> If either endpoint has one of these failures, replay refuses the whole action before pointer-down:
>
> - selector miss;
> - identity mismatch;
> - unverifiable evidence;
> - dispatch-time guard mismatch.
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
- **Disambiguation signals, consulted only when several current nodes share the identity:** `sibling`, then `viewportOrder` within the recorded `scrollRegion` partition.
  `sibling` is the actual same-parent child index.
  These relative signals use no absolute pixels.
  Document order resolves every ordering tie.
- **Diagnostics, never compared:** optional `rect` shows the recorded target's location in divergence reports.

Absolute geometry is deliberately demoted out of identity.
An absolute rect is the least stable component of the identity of a target.
Scroll offset, device rotation, dynamic type, iPad/macOS window resizing, and ordinary RN layout shifts all move rects between healthy runs.
The audit's identical-rect "Prevent Remove" sibling pair proves that absolute geometry cannot even separate identical siblings in the worst case.
No absolute-coordinate tolerance exists in v1.
The earlier draft's ±8-unit rect comparison is removed, not tuned, because no measured drift distribution exists to justify any particular constant.
If a future revision reintroduces an absolute tolerance, it must carry measured evidence.

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
> "First labeled descendant" means the first node in document order within the whole subtree with a non-empty normalized label.
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
> Polling is fail-open in time and fail-closed at the deadline.
> A same-selector impostor never aborts the wait.
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
Recorded chain R matches observed chain O if and only if every index `i < |R|` satisfies these conditions:

- `O[i]` exists.
- The roles are equal.
- If `R[i]` has a label, the labels are equal.

An absent recorded label imposes no constraint.
`|O| < |R|` is a mismatch.
An inserted or removed wrapper ancestor deliberately changes identity.
Structure is part of identity.

**Record-time write.** Record and replay compute both positional signals over identical candidate domains.
They never use one domain at record time and another at replay.
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
   `viewportOrder` is the zero-based ordinal of the winner **within its own partition**, not within the whole identity set.
   Order rect centers top-to-bottom, then left-to-right.
   Resolve equal centers by document order.
   Put rect-less members last, in document order.
   The partition is the domain of the ordinal on both sides.
   Thus recorded and replayed `viewportOrder` always refer to the same candidate domain.
5. Run the replay verification algorithm against the record-time tree.
   If it isolates exactly the winner, write `verification: "verified"`.
   Otherwise, write `verification: "unverifiable"`.
   Both ordinals derive from the winner over deterministic total orders.
   Thus, the self-check succeeds by construction whenever the capture supplies the required structural data.
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
   - **sibling:** find the members of I whose zero-based index among their own parent's children equals the recorded `sibling`.
     If exactly one member qualifies, compare it with W under paths 4/5.
     If zero or several members qualify, the signal does not isolate a member.
     Then continue with the next signal over the same, unchanged set I.
     The same child index can recur under different parents.
   - **Region-scoped viewportOrder:** restrict I to the partition whose scroll-region key equals the recorded `scrollRegion`.
     If `scrollRegion` is omitted, use the *none* partition.
     If the partition is empty, the recorded scroll region no longer exists.
     Then `viewportOrder` is **unavailable**, and it is never compared across regions.
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
> While the app mounts, Android's snapshot helper returns "insufficient foreground app content", and the capture path throws.
> iOS's private-AX fallback can return sparse content under load.
> This capture retries with bounded backoff before it returns `identity-unverifiable`.
> The fixed delay list has 7 entries and a 12s **DELAY-ONLY** budget.
> This corresponds to `wait` landmark verification's existing continued polling (#1349).
>
> The retry is opt-in for each call site (`retryLaunchRace`).
> Other `captureDivergenceObservation` callers do not change.
> Only the pre-dispatch verification gate in `verifyReplayActionTarget` races a launch this way.
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

**Divergence is a structured error, not success data.** Both action failure and target-binding mismatch return `ok:false`, code `REPLAY_DIVERGENCE`, and `details.divergence`.
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
> Thus, a failed `snapshot --raw`/scoped/`-d` action must never narrow or reshape the diagnostic tree below what a plain `snapshot` shows.
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
> This is a hard invariant: **an agent must never see a healthier `screen` in a divergence report than a plain `snapshot` would show it.**
> A covering separate-window system overlay at the moment of capture must appear in `screen.refs` exactly as `snapshot` would present it.
> Its actionable/hittable/labeled nodes must survive the filters AND the cap.
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
Otherwise, a short ordinary value such as `2` or `on` would corrupt unrelated timestamps, paths, and typed error fields throughout the request log.
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
`N` is a 1-based index into the fully expanded executable plan.
`N` must be in range.
It is not a YAML line, fractional source-step number, or repeat iteration label.
Static includes, platform conditions, and fixed-count repeats expand before indexing.
Repeated source lines therefore have distinct plan indices.

Every divergence includes `resume: { allowed, from, reason?, planDigest, alternateFrom?, repairSessionHeld? }`.
`repairHint` determines `from` under decision 6, R2/R3:

- For `record-and-heal`, `from` is the index of the failed step **+ 1** (N + 1).
  The agent performs that step manually before it resumes.
  A resume AT that step would diverge again on the exact step that the agent just completed.
- For `state-repair`, `caution`, and `manual`, `from` remains **N**.

For single-path hints (`record-and-heal`, `state-repair`), `from` describes the complete continuation.
A JSON/MCP-first caller that blindly resumes at `resume.from` therefore reads the same command that the text guidance renders.
It never gets a stale `from` that loops the caller back onto the step that it just repaired.
For dual-path hints (`caution`, `manual`), `from` describes only app-state repair.
Their optional `alternateFrom` describes recorded correction.
Structured callers read both fields to obtain both text alternatives.

`alternateFrom` is an additive optional ordinal (#1262).
For `caution`/`manual`, there are two legitimate repairs, and the daemon cannot disambiguate them at divergence time:

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
The daemon stamps a per-session watermark (`expectedFrom`, the recorded action count at divergence time) in these cases:

- For `record-and-heal` with `allowed: true`, the reported `from` is already N + 1.
- For a preflight-safe `caution`/`manual` final-step alternate (#1262), the watermark uses `alternateFrom` N + 1.
  The primary `from` remains N.

Only a live session can receive this watermark.
Without one, an empty-tail `alternateFrom` is omitted.
Otherwise, the daemon would advertise a `--from N + 1` that it must then reject.
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
A `--save-script` replay opens the transaction.
Commit or abort ends the transaction (decision 6, R7).
The daemon sets `repairSessionHeld: true` until the transaction ends.
A `--from` continuation without `--save-script` still reports `repairSessionHeld: true`, because the persisted transaction state determines this field, not the flags of the current request.
Only this signal promises a live addressable daemon/session for repair.
R7's lifetime guarantee never uses `allowed`.
A non-armed replay can report `allowed: true` and then terminate its session normally.
Thus a consumer must not read `allowed: true` as "the session is still there."

Resume reconstructs no execution state.
For `N > 1`, preflight must reject with `INVALID_ARGS` under either condition:

- A skipped action can produce `outputEnv` values.
- The skipped range or resume target is inside runtime conditional, retry, or dynamic-repeat control flow.

After resume, only explicit script/header, CLI, and shell inputs supply variables.
If the planner cannot prove that scope, it rejects the request.
The daemon never infers app state.
Before resume, the caller must establish the required app state.
This conservative first-release scope defers deterministic state reconstruction until a separate specification and tests exist.

The loop is therefore:

1. Run the replay.
2. Read the divergence.
3. Repair the app state.
4. Replay with the reported plan digest and index.
   If you completed the failed action manually, use the next index:
   `from` for `record-and-heal`, or `alternateFrom` for `caution`/`manual`.
An edited script requires a fresh full replay and a new digest.
Help documents this protocol and resume rejections.
Successful text replay prints one line with replayed count and wall time.
`--json` remains structured.

### 5. Mandatory validation

Benchmark evidence alone does not establish acceptance.
Required automated coverage follows.

**Resolution disclosure:** matrix and provider contracts cover all six `resolutionDisclosure` cells:

- Runtime ambiguity/tiebreak and the five-alternative limit
- Runtime/native exact-ref provenance
- Runtime-ref `label-fallback` disclosure
- Direct-iOS `not-observed`
- Coordinate inapplicability
- Maestro inapplicability on both sides of the permission: fallback taken, and allowed-but-not-taken that discloses `not-observed`
- The retained direct-path waiver list

**Interaction mutation:** contracts prove that pre-action resolution diagnostics neither issue refs nor receive MCP pins.
Use of an alternative requires a fresh snapshot.
A no-action target-binding divergence can issue and pin its fresh report refs.

**Parser/writer units:** cases cover these properties:

- V1 identity round trips
- Old/new reader compatibility
- Escape sequences
- Normalized-role source
- Leaf-anchored ancestry prefix comparison
- Root-side truncation
- Inserted-wrapper mismatch
- Duplicate/unverifiable record and replay evidence
- No rect comparison
- Malformed annotations
- Mismatch before action

**Replay runtime:** tests cover all six decision 3 paths:

- Recorded-unverifiable
- Selector-miss (`matchCount == 0`)
- Empty identity set
- Verified
- Unique-but-wrong rebind
- Post-signal fall-through

They also prove these positional properties:

- Same-parent `sibling` semantics, including repeated child indices under different parents
- Identical region-partitioned `viewportOrder` domains at record and replay
- Unavailable recorded scroll regions without cross-region comparison
- Out-of-range ordinals
- Document-order determinism for equal rect centers and rect-less members

**Divergence reports:** tests cover compact/default/full field and byte ceilings.
Digest output includes `suggestionCount` without entries.
Coverage also includes redaction, overflow artifacts, artifact-write failure, available/sparse/capture-failed screens, and original-cause preservation.

**Resume:** tests cover digest emission and rejection after script/include/expansion changes.
They also cover `resume.allowed` reasons, `--from` indexing, variable-output rejection, control-flow rejection, and `test --from` rejection.

**Surface contracts:** daemon/client/CLI/MCP tests prove typed divergence survives failure.
JSON and MCP structured output retain it.
MCP pins only actionable error-path refs.
No text-only path discards the report.
`repairHint` is present and identical in text, JSON, client `AppError`, and MCP `structuredContent`, including compact `--level digest`.

**`--update` retirement:** tests prove no source-file rewrite.
Suggestions remain bounded, ranked, and deduplicated under decision 1's total order.

**Decision 6 acceptance:** tests prove these requirements:

- A healed sibling `.ad` replays completely in a **fresh session**.
  Every selector step has an annotation.
  There is no bare `@ref`.
- Daemon-side `repairHint` computation covers all four hints (`record-and-heal`, `state-repair`, `caution`, `manual`) and all four divergence kinds (`selector-miss`, `identity-mismatch`, `identity-unverifiable`, `action-failure`).
  The tests prove that the mapping is total.
  Missing `targetEvidence` defaults to `manual`, including PR #1223's unannotated `action-failure`.
  Sparse/unavailable capture also defaults to `manual`.
  The post-response-capture container test for `action-failure` is included.
- `--no-record` state-fix actions are excluded from the healed script.
  The corrective selector-drift action is included in the healed script.
- When recording is armed from step 1, prefix steps are re-annotated with fresh `target-v1` evidence (R1).
- `--from` continuation never duplicates the recorded prefix through another full replay on the same session (R2).
- The boundary watermark excludes the pre-invocation actions of a reused session from the healed script (R6).
- A bare `@ref` without a materializable selector causes a nonzero writer error instead of silent omission (R4).
- `resume.repairSessionHeld: true` keeps the repair session addressable for a later `--from`.
  A non-armed divergence with only `resume.allowed: true` does not keep the session live.
  Continuation uses persisted transaction state without another `--save-script`.
- A reaped incomplete transaction returns `REPAIR_SESSION_EXPIRED` through a session-key tombstone, never `SESSION_NOT_FOUND`.
  A fresh `replay --save-script` on that key clears the tombstone.
  An implementation that cannot preserve session lifetime fails before step 1 (R7).
- Every teardown (`close`, idle-reap, shutdown) commits atomically at `COMPLETE`.
  Before `COMPLETE`, it aborts without any publication, including a prefix.
  Idle-reap/shutdown at `COMPLETE` commits instead of creating a tombstone.
  After `COMMITTED`, teardown is idempotent and never republishes.
- An armed replay skips its terminal source `close` without session deletion (C4).
- The temp file uses the target directory.
  One exclusive `linkSync` publishes it with create-if-absent, first-writer-wins semantics.
- Publication refuses **every** existing target and preserves its bytes.
  This includes complete/partial files, the default healed sibling, and explicit `--save-script=<path>`.
  It also includes ordinary non-repair `open`/`close --save-script` recording.
  The shared writer entry point and publication primitive enforce uniform refusal, as "Scope" specifies.

Extend the settle benchmark with a replay arm only after these contracts pass.
Use the external `~/.agent-device-bench/rnnav-matrix.py` harness pattern.
Measure clean replay and one induced divergence repaired through the permitted `--from` loop.

### 6. Agent-supervised re-record repair ("heal-by-doing")

Decision 1 retires silent `--update` rewrites because selector agreement does not prove target identity.
This decision adds explicit agent-driven repair without restoring unattended selector application.
The agent performs the failed step with ordinary visible interactive commands.
The CLI records the successful execution.

For a selector-drift divergence (a recorded label/id renamed so that the selector no longer matches), decision 1's replacement repair surface is this: hand-edit the `.ad` selector text, then fresh-replay.
A 2026-07-12 measurement showed that this is a hostile repair surface for models.
A small-model (Haiku) repair run thrashed for 26 turns.
While it edited escaped-quote selector chains (`label="X" || label="X"`), it corrupted the `.ad` to `INVALID_ARGS`.
The divergence `suggestions` list was empty for the renamed label.
The divergence *report* is good (decision 4), but the repair *affordance* is broken.
Models should not edit `.ad` text.

For selector drift, the agent instead performs the failed step's **intent** through fresh actionable refs from divergence `screen` (decision 4).
The CLI produces a healed `.ad` from the session's actual successful execution path.
This requires neither text edits nor silent similarity-based repair.

**Core mechanism — the healed script IS `session.actions`.** No new splice engine is necessary.
`session.actions` accumulates executed actions throughout session lifetime.
`packages/daemon/src/core/session-action-recorder.ts:92` pushes them unconditionally.
The divergence refusal is pre-dispatch (decision 3), so a divergent step is never pushed.
Across a repair session, original steps that verified and dispatched enter `session.actions`.
The divergent step is absent, because it was refused pre-dispatch and never recorded.
The corrective interactive actions of the agent enter `session.actions`.
Corrective actions receive fresh `target-v1` evidence because recording is armed.
Armed recording also disables the direct-iOS fast path (PR #1196), which permits evidence computation.
`formatSessionScript` serializes actions from the repair boundary onward (R6).
That slice is the successful path, independent of earlier session history.
Only flag propagation and one writer entry point require new code.

**The two repair sub-flows (routed by the mechanical `repairHint`).**
A `selector-miss` with `matchCount: 0` can mean a renamed label or an entirely incorrect screen.
The daemon distinguishes the sub-flows with R3's `repairHint`.
Only the enum crosses the wire.
`record-and-heal` selects selector-drift repair; `state-repair` selects app-state repair.
The agent follows the hint.
Only if the case is ambiguous does it override routing after a fresh `screen.refs` read or one `snapshot -i`.
Each sub-flow has different recording rules:

1. **Selector drift:** the expected screen has a renamed or moved control.
   The agent presses the correct actionable `screen.refs` target without `--no-record`.
   This action and its fresh evidence replace the failed step in the healed script.
   `replay --from N+1 --plan-digest <original>` then continues after the manually performed step.
   A later divergence repeats the loop.
2. **App-state divergence:** the script is correct, but the app state is incorrect.
   The agent restores expected state with `--no-record` actions.
   These one-time setup actions must not enter the healed script.
   `replay --from N --plan-digest <original>` then repeats unchanged step N.

**Required protocol rules (normative).** These seven rules are the difference between "the mechanism works" and "healed scripts are always valid":

- **R1 — recording starts with the first replay.** `replay <file>.ad --save-script[=<out>]` sets `session.recordSession = true` before step 1.
  It must not wait for divergence.
  The repair replay re-executes prefix steps.
  Recording from the start supplies fresh `target-v1` evidence for those steps.
  Late activation creates a hybrid healed script: an annotated corrective step with a bare, unannotated prefix.
  That script diverges again on its own next replay.
  `packages/daemon/src/execution/interaction/internal/interaction-common.ts:64-65` attaches evidence only when `recordSession` was true at execution.
- **R2 — continuation uses `--from`.** After divergence at N and correction, the agent must use `replay --from k --plan-digest <original>`.
  It must never repeat full replay on that session.
  Full replay appends prefix `1..N-1` again because `session-action-recorder.ts:92` pushes unconditionally.
  Replay dispatch does not inject `noRecord`.
  App-state repair uses `k = N` to repeat the unchanged step.
  Selector-drift repair uses `k = N + 1` because the agent already performed N.
- **R3 — a mechanical `repairHint` on the divergence payload determines the sub-flow; no LLM-only routing.**
  The daemon computes `repairHint` at divergence time.
  The agent never computes it.
  It uses two inputs that the daemon already holds:
  - the recorded `targetEvidence`: the daemon owns the parsed `target-v1` `ancestry`/`scrollRegion` (decision 3), *when the diverged action carried an annotation*;
  - the screen capture of the divergence: the daemon owns the whole current tree, not the flat, 20-capped `screen.refs` on the wire.


  The daemon tests container presence where both inputs exist.
  Only the enum crosses the wire; omission of ancestry from the wire does not affect computation.

  Capture timing depends on divergence kind.
  Target-binding kinds use the pre-action verification tree.
  Ordinary `action-failure` uses the post-response capture from the dispatch-thrown path (PR #1223).
  That tree answers whether the recorded container currently exists.
  No separately stored pre-action tree is necessary.
  The mapping covers all four kinds:

  | Kind | Condition | Hint |
  | --- | --- | --- |
  | `selector-miss` (`matchCount: 0`) | Recorded container present | `record-and-heal` |
  | `selector-miss` | Container absent or screen differs | `state-repair` |
  | `identity-mismatch` (`matchCount >= 1`) | Selector matched incorrect identity | `caution` |
  | `identity-unverifiable` | Every case | `manual` |
  | `action-failure` | Recorded container present in post-response capture | `record-and-heal` |
  | `action-failure` | Otherwise | `manual` |

  `caution` applies to `identity-mismatch` because something matched the recorded selector, so a blind re-press may repeat the mistake.
  `manual` applies to unverifiable identity because future replays block this step pre-action, so heal-by-doing is a poor fit.
  The mapping is total over kind, evidence presence, and capture availability.
  Anything not proven safe defaults to `manual`.
  Two fail-safes override the container mapping:

  - No recorded `targetEvidence` means no container to test, so the hint is `manual`.
    PR #1223 also wraps unannotated actions.
    Thus this case is reachable for `action-failure`, and for any kind on a legacy/unannotated script.
  - Sparse or unavailable capture prevents the test, so the hint is `manual`.

- **R4 — corrective actions must materialize to selectors.** The writer must refuse persisted bare `@ref` exports with an explicit error.
  `press @e12` normally resolves a `selectorChain` in `packages/daemon/src/execution/interaction/internal/interaction-touch-targets.ts`.
  `buildOptimizedActions` converts it to a selector line (`packages/daemon/src/core/session-script-writer.ts:368-377`).
  Without a captured chain, the writer must refuse a bare `@ref` in persisted `.ad` output.
  A session-bound ref cannot resolve in a fresh run.
  Failure must reach the user with a nonzero exit.
  The writer must neither suppress the failure nor silently omit the line, despite existing session-write behavior.
- **R5 — repair must contain a recorded `open`.** The source script's first step must be `open --relaunch` or an explicit recorded `open`.
  This makes the healed `.ad` self-contained.
- **R6 — the healed script contains only the repair run.** `replay --save-script` records `session.actions.length` as its boundary watermark at invocation.
  Only actions at or after that watermark are serialized.
  Earlier unrelated actions from a reused session never enter the healed script.
  The repair session itself need not be fresh.
- **R7 — the transaction persists across the live session.** The session remains addressable until commit or abort.
  `--save-script` opens a multi-invocation repair transaction persisted on the session.
  Each request does not reconstruct it from flags.
  If an armed replay returns `resume.repairSessionHeld: true`, it **MUST NOT** terminate the owning daemon or session.
  Decision 4's `resume.allowed` only describes plan resumability.
  It is not the lifetime signal.
  `replay --from <n> --plan-digest <sha>` continues on the same armed session **without another `--save-script`**.
  The opener is the only place where that flag appears.
  The implementation MUST use persisted transaction state for continuation and keep-alive.
  It must not depend on current-request `--save-script`.
  The R6 watermark and action slice require this one surviving session.
  Same-session continuation is therefore a lifetime guarantee, beyond R2's preference.

  **Every teardown commits if and only if the state is `COMPLETE`.**
  Explicit `close`, idle-reap, and daemon shutdown otherwise abort without publication, including any prefix.
  Idle-reap/shutdown of an incomplete transaction also leaves the tombstone described below.
  Commands on its session key receive `REPAIR_SESSION_EXPIRED` with restart guidance instead of `SESSION_NOT_FOUND`.
  Explicit `close` of an incomplete transaction simply discards it.
  A persistent-daemon precondition is explicitly rejected.
  If the implementation cannot preserve lifetime, armed replay must fail before step 1 with actionable guidance.
  It must not proceed and later fail `--from` with `SESSION_NOT_FOUND`.

  **CLI one-shot teardown interaction (issue #1384).** A clean armed replay reaches `COMPLETE` and skips terminal source `close`.
  Its session therefore survives.
  Once client keep-alive uses `ReplayCommandResult.sessionActive` independently of repair state, it also preserves this daemon.
  Publication remains deferred until explicit `close`/`close --save-script` or ordinary idle-reap tears down the session.
  This preserves R7's post-repair inspection opportunity.
  It changes timing for scripted callers that previously saw the healed sibling immediately after one-shot client exit.

**Terminal lifecycle steps during a repair-armed `--from` resume.**
Decision 3 verifies only annotated resolved targets.
A source `close` or any step without `target-v1` `targetEvidence` is exempt from target-binding divergence.
A real dispatch failure can still produce `action-failure`.
Absent evidence alone never causes `selector-miss`, `identity-mismatch`, or `identity-unverifiable`.
This clarifies existing scope.

A **terminal source `close`** means the source plan's last action is `close`.
An armed replay or resume **skips it without dispatch**.
Dispatch would delete the session mid-transaction, and R7 keeps that session alive.
Thus the terminal source `close` must never run under an armed repair.
Reaching this step instead marks the transaction `COMPLETE`.
The next teardown, normally the agent's `close`/`close --save-script`, commits it.
Every teardown at `COMPLETE` commits.

**Acceptance test (mandatory).** A healed sibling `.ad` must replay completely in a **fresh session**.
Every selector step must have an annotation.
The script must contain no bare `@ref`.

**Digest and resume — unchanged, live-session loop.**
Decision 4 requires fresh full replay to validate an edited on-disk `.ad`.
This repair loop keeps the original file unchanged and operates in one live session.
Its original digest remains stable.
`--from k --plan-digest <original>` already permits manual correction followed by continuation.
Steps `1..k-1` never re-run, so decision 4's non-idempotency guarantee holds by construction.
The healed script is published only at repair completion and teardown.
It is a new script for future runs with the same non-idempotency risk as any hand-written `.ad`.

**Emitting the healed script — opt-in via `--save-script`.** Activation reuses existing flag vocabulary and close-time publication:

- Before step 1, `replay <file>.ad --save-script[=<out>]` sets `session.recordSession = true` and records the R6 boundary.
  This follows existing `saveScript` handling in `session-lifecycle/internal/session-close.ts`.
  Without the flag, replay retains existing behavior: no recording and no repair publication.
  Explicit activation preserves decision 1's prohibition on silent rewrites.
- A teardown at `COMPLETE` publishes the healed `.ad`.
  The usual trigger is `close`/`close --save-script <out>`, but every completed-transaction teardown commits.
  `SessionScriptWriter.write` (`packages/daemon/src/core/session-script-writer.ts:120-158`) serializes only the post-watermark slice.
  Without `<out>`, publication uses the **`<original-stem>.healed.ad` sibling** beside the original.
  For example, `flows/login.ad` becomes `flows/login.healed.ad`.
  The original is never overwritten in place without an explicit `<out>` path.
  A human reviews the diff and promotes the result.

**Commit state machine — `ARMED` → `COMPLETE` → `COMMITTED`.**
R6 defines the *slice*.
This machine defines *when the slice may be published*, as a machine-enforceable state, not a heuristic:

- **`ARMED`:** starts immediately when `replay --save-script` activates the transaction before step 1.
  The slice accumulates and MUST NOT be published.
- **`COMPLETE`:** all executable source steps have executed or been repaired, with no outstanding divergence.
  The terminal source `close` is excluded from executable steps.
  Reaching it changes `ARMED` to `COMPLETE`.
  Only `COMPLETE` permits publication.
- **`COMMITTED`:** atomic publication succeeded.
  This state is terminal.

**Teardown is the commit trigger, gated on `COMPLETE`.**
Explicit `close`/`close --save-script`, idle-reap, or shutdown commits if and only if the state is `COMPLETE`.
Before that state, teardown aborts, discards the slice, and publishes nothing, including a prefix.
Reaching `COMPLETE` alone writes no file.
It makes the next teardown commit instead of abort.
Publication therefore occurs once, after both completion and transaction end.
Any teardown can preserve the completed artifact without a specific finalization command, as #1235 implements.
After `COMMITTED`, teardown is idempotent and never republishes.
It cannot double-commit or trigger no-clobber refusal again.

**Atomic, race-safe publication.** Commit serializes the healed slice with a final `close` line for self-contained output.
It creates a temp file **in the final target's directory**.
An explicit target can be on another mount, and `linkSync` requires the same filesystem.
One exclusive `linkSync(temp, target)` then publishes with create-if-absent, first-writer-wins semantics.
Readers never see partial output.
Aborted repair leaves no partial file.

**Publication refuses every pre-existing target.** This applies to complete/partial files and default/explicit paths.
An earlier design distinguished a *complete, review-worthy* artifact (protected) from an incomplete or partial one (silently overwritable).
A publish lock enforced that distinction.
The distinction added a whole class of lock/lease/reclaim races for a degenerate case: a partial healed file that an aborted or reaped repair left behind.
The adopted design instead lets exclusive `linkSync` decide the winner.
`EEXIST` occurs if and only if a file already exists at the target, irrespective of its content.
The caller must remove it or select another `replay --save-script=<path>`.
The existing file is never silently replaced.
There is no lock, lease, ownership transfer, or overwrite.
`# agent-device:heal-complete` remains a trailing marker of a complete, reviewable artifact.
It does not affect publication permission.
Automatic versioned names, such as `.healed.2.ad`, remain out of scope as a separate naming change.

**Scope: the refusal applies to repair and ordinary recording.**
`publishHealedScriptAtomically` in `packages/daemon/src/core/session-script-writer.ts` is the one publication primitive used by `SessionScriptWriter.write` for every `--save-script` target.
It has no repair/ordinary branch.
Repair sets `saveScriptBoundary`; ordinary `open --save-script`/`close --save-script` recording does not.
Both use the same exclusive `linkSync`.
The former ordinary rename-replace path, `publishOverwriteAtomically`, is removed.
An ordinary recording with an existing target receives the same `AppError` for `EEXIST`.
The existing bytes remain unchanged.
The caller must remove the file or select another path.
Neither path has a `--force`/`--overwrite` override.
Issue #1258 tracks that future work outside this decision.

**Repair-session tombstone (R7 ownership).**
Idle-reap or shutdown before `COMPLETE` aborts without publication and must leave a tombstone.
Teardown at `COMPLETE` commits instead and needs no tombstone.
The tombstone uses the owner-scoped **session key** addressed by continuation.
It records owner and expiry and persists for a bounded period after reap.
During that period, every command on the key receives `REPAIR_SESSION_EXPIRED`, never `SESSION_NOT_FOUND`.
This includes resume, interactive correction, and `close`.
The error guides the caller to restart from the original script.
A new `replay --save-script` on the key clears the tombstone and starts a fresh `ARMED` transaction.
After bounded expiry, the tombstone disappears and the key is free.

> **Amendment (#1271 stage 2): repair-segment default exclusion of observation-only commands, and the `--record` opt-in.**
> #1271 reported a problem with read-only diagnostics that an agent runs mid-repair to LOCATE the repair target: `snapshot -i`, `get attrs`, `find`, `is`.
> These diagnostics were recorded into the healed script exactly like the corrective action itself.
> The wave-3 E3 experiment measured 0/4 trials that produced a clean healed script hands-off.
> One recorded `get attrs` caused a second, self-inflicted `identity-mismatch` divergence on fresh replay.
> Stage 1 (#1287) shipped interim guidance only: the divergence `repairHint` and `help workflow` told the agent to pass `--no-record` on those commands by hand.
> This amendment makes the safer behavior the default.
> It supersedes the "opt out by hand" guidance of stage 1 with "opt in by hand" for the one case that needs it.
>
> **1. Exclusion depends on provenance.** Both conditions must hold:
>
> - The command is observation-only: `snapshot`, `get`, `is`, or read-only `find` (`exists`, `wait`, `get_text`, `get_attrs`).
>   Mutating `find … click|fill|focus|type` remains a corrective action like `press`/`fill` and always records.
>   The top-level `wait` command is deliberately **not** in this set.
>   It is flow timing/synchronization, not observation, so it must keep recording unconditionally.
>   Silent removal of timing steps would change replay behavior.
> - The agent dispatches the observation **out of band** during repair.
>   It is not a step from the `.ad` plan under repair.
>
> Plan steps use the ordinary request path and enter `session.actions`.
> The healed script is `buildOptimizedActions` over `session.actions.slice(saveScriptBoundary)`.
> A command-only exclusion would execute an authored `is visible` and silently remove its assertion from the healed script.
> The repaired flow would then stop checking what the original checked.
> For a deterministic QA suite, that is the worst possible failure mode.
> **Authored prefix/suffix observations must survive automatically without `--record`.**
> Only provenance distinguishes authored observations from interactive diagnostics using the same command.
>
> `invokeResolvedReplayAction` stamps `internal.replayPlanStep` at the one dispatch point for every annotated or unannotated plan step.
> Its pointer is `packages/replay-port/src/daemon-port/session-replay-action-runtime.ts`.
> `internal` is daemon-only.
> `toDaemonRequest` in `packages/daemon/src/server/http/http-rpc-methods.ts` never copies it from the wire.
> A client therefore cannot forge authored provenance.
> `replayTargetGuard` and `findResolvedTarget` use the same channel.
> `isInteractiveObservation` in `packages/daemon/src/core/session-action-recorder.ts` defines the rule once for both recording call sites.
>
> **2. A corrective read requires explicit inclusion.**
> The failed step itself can be `get`, as wave-3 E3 measured.
> Its corrective `get` must enter the healed script.
> Blanket exclusion would silently remove the repaired step.
> This resembles the silent failures prevented by decision 3 and R4.
> A rejected alternative infers correction from position relative to eventual `--from`.
> The daemon records actions immediately and cannot know their future resume role.
> That alternative would retrospectively reinterpret intent.
> `--record` instead identifies the corrective read explicitly, irrespective of position.
>
> **3. Explicit recording remains possible.**
> `--record` forces an out-of-band observation into the healed script.
> Its purpose is an interactive corrective read.
> Outside repair, it has no effect because no default exclusion applies.
> Authored plan steps need no flag because provenance preserves them.
>
> `--record` is not a common flag.
> Universal `--no-record` covers every recordable command, including mutations, through `COMMON_COMMAND_SUPPORTED_FLAG_KEYS`.
> `--record` applies only where observation exclusion is possible.
> Each `snapshot`, `get`, and `is` schema lists it in `allowedFlags`.
> Acceptance on `press`/`fill`/`click` would be misleading.
> The grammar rejects every unsupported use before projection.
> `find` selects observation/mutation through a positional, so grammar permits the flag.
> `handleFindCommands` dynamically rejects it on mutating `find … click|fill|focus|type` with `INVALID_ARGS` before device work.
> Both routing and validation use shared `isReadOnlyFindAction` from `@agent-device/selectors`.
> Their classifications therefore cannot differ.
> `--record` and `--no-record` are mutually exclusive.
> Every surface rejects both together with `INVALID_ARGS` before execution.
> Neither silently overrides the other.
>
> **4. CLI/Node/MCP use the same rule.**
> `isExcludedRepairSegmentObservation` in `recordActionEntry` is the single daemon enforcement point (`packages/daemon/src/core/session-action-recorder.ts`).
> It requires `session.saveScriptBoundary !== undefined` and the entry's `interactiveObservation` marker.
> Only repair-armed `replay --save-script` sets that boundary.
> Ordinary non-repair authoring never sets it.
> Both recording call sites compute the marker with shared `isInteractiveObservation`:
>
> - `packages/daemon/src/core/selector-recording.ts` for `get`/`is`/read-only `find`
> - `packages/daemon/src/sessions/snapshot-runtime.ts` for `snapshot`
>
> Every surface reaches that same daemon function.
> The flags retain their different scopes:
>
> - Common `--no-record` belongs to `COMMON_COMMAND_SUPPORTED_FLAG_KEYS`.
>   Every recordable reader forwards it with `noRecordInputFromFlags` (`src/commands/cli-grammar/common.ts`, #1304).
> - Scoped `--record` is not common.
>   Only `snapshot`/`get`/`is` and dynamically validated `find` permit it.
>   Only their readers use `observationRecordInputFromFlags`.
>
> Two named helpers express the capability, not one helper with an `allowRecord` policy argument.
> The capability is then the NAME of the helper, so a mutating reader physically cannot forward `--record`.
> A policy argument would let a future mutating reader opt in through a changed literal, with no schema change.
> That fail-open is what the split prevents.
> Both flags then use the ordinary typed path:
>
> - Node forwards them through `buildRequestFlags`/`buildFlags` in `src/commands/command-flags.ts`.
>   Sources are `InternalRequestOptions`, `GetOptions`, `IsOptions`, `FindOptions`, and `CaptureSnapshotOptions`.
> - MCP exposes `record`/`noRecord` on `get`/`is`/`find`/`snapshot` tools.
>   `src/commands/interaction/metadata.ts` and `src/commands/capture/snapshot.ts` use `CommandMetadata.inputSchema` plus `readMetadataCommandFlags`, as for other typed fields.
>
> There is no separate per-surface recording contract.
>
> **5. The existing resume watermark detects missing corrections.**
> Exclusion occurs before `session.actions`, at the same point as `--no-record`.
> Excluded reads never increase `session.actions.length`.
> `describeUnperformedRecordAndHeal` already compares this count with `actionsCountAtDivergence`.
> Its pointer is `packages/ad-replay/src/internal/resume.ts`, using R2/#1262's `pendingRecordAndHeal` watermark.
> Count growth proves a corrective action before a `record-and-heal`-shaped resume.
> A segment with only excluded diagnostics fails the existing guard like an empty segment.
> No new state is necessary.
> The guard's message adds `--record` beside `--no-record` because correction can be a read:
> "no corrective action was recorded in this repair segment; press the correct control via a blessed `@ref` … — or, if your
> corrective action was a read, re-run it with `--record` … — before resuming."
>
> **Regression coverage** proves these cases:
>
> - Out-of-band diagnostic reads are omitted by default within an armed repair segment.
> - An authored `is visible` survives without `--record` through provenance.
>   A command-only exclusion fails this test.
> - Corrective press/fill actions remain included because they are not observation-only.
> - A corrective `get` with `--record` remains included.
> - The healed script replays cleanly in a fresh session.
> - Mutating `find … click --record` returns `INVALID_ARGS`.
> - The empty-segment guard refuses blind resume with actionable `--record` guidance.
> - Ordinary `open --save-script` authoring still records reads without a flag.
>   It never sets `session.saveScriptBoundary`.

## Consequences

- `--from` makes app state the caller's responsibility.
  Resume requires a matching digest and proof that variables and control flow do not depend on skipped execution.
  The daemon cannot know whether the app has step N's expected state.
  Context's live navigation-state example shows that the app determines the relaunch destination.
- **`--from` must never repeat steps `1..N-1`.**
  Non-idempotent scripts are the reason.
  A script that creates a record, navigates, then asserts on it would create the record twice on any re-run of its early steps.
  This is a hard constraint on the semantics of the flag, not an implementation nicety.
- **Retirement of heal-as-actor removes CI self-repair for agentless callers.**
  `--update` returns bounded suggestions but never rewrites.
  A nightly run that formerly patched a selector now remains failed.
  This is accepted because the audit found limited utility and silent target-binding risk.
  Selector agreement does not prove target identity.
- **Successful structural-collapse disclosure adds bounded diagnostics.**
  Its alternatives describe pre-action wrappers and are not reusable targets.
  Distinct-subtree rejection performs no mutation.
  Its at-most-five candidates are immediately reusable through the issued partial frame.
  Direct-iOS unique responses add only `not-observed`.
- **Identity evidence is an additive `.ad` format change.**
  A reserved JSON comment precedes each supported recorded target action.
  Unannotated scripts remain valid.
  A duplicate that structural evidence cannot distinguish causes pre-action unverifiable divergence instead of a guess.
- **Structural equivalence replaces the original geometric mutation heuristic.**
  Element-14 demonstrated its documented incorrect-binding risk.
  Blanket rejection remains unsuitable because RN commonly exposes one label on a row/button/text wrapper chain.
  Structural equivalence preserves that case.
  Distinct subtrees reject instead of selection by visibility, depth, or area.
- **Decision 6 retains ordinary interactive risk.**
  An agent can press an incorrect visible ref.
  Live interactive commands currently have no target-binding verification; see Context (c).
  This existing risk is not a new failure class.
  The retired-heal failure mode ("selector agreement is not proof of the same target") is structurally impossible here.
  Nothing re-matches a stale selector, because evidence comes fresh from the node that the agent actually pressed.
- **Decision 4 bounds `screen.refs`.**
  Default/full output has at most 20 entries and can be filtered.
  If the required control is absent, one additional `snapshot -i` retrieves it.
  This cost is bounded and disclosed.

## Alternatives considered

- **New guarded-sequence batch engine: rejected.** Replay already sequences steps with progress and failure reports.
  The existing engine needs disclosure, verification, and resume.
  A second engine is unnecessary.
- **`--agent`/agent-mode replay flag: rejected.** The richer divergence report can be the default error shape.
  Deterministic CI can ignore additional error data.
  No separate semantics are necessary.
- **Retain `--update` auto-heal with target verification: rejected.** Decision 3 verifies resolved targets without retry-and-rewrite behavior.
  Reconsider only if agentless CI needs a separately specified and testable repair policy.
- **Auto-heal tiers (safe-tier heals applied automatically, risky-tier surfaced): deferred.** This alternative is not rejected outright.
  There is no current evidence base for which heals are "safe", so tiers now would be speculative.
  Reconsider if agentless CI demand for self-repair appears.
- **Hand-edit `.ad` text (status quo): rejected.** It is hostile to models.
  Measured 2026-07-12: a small-model (Haiku) repair run thrashed for 26 turns.
  While it edited escaped-quote selector chains, it corrupted the `.ad` to `INVALID_ARGS`.
- **Silent automatic rewrite: retired under decision 1.** The former `--update` risks incorrect binding.
  Selector agreement does not prove target identity.

## Context and evidence at acceptance (2026-07-10)

This section records the repository audit on 2026-07-10, before implementation of these decisions.
Its observations and code pointers are **historical evidence**.
The decisions above and their gates define current behavior.

At acceptance, replay was deterministic.
`.ad` scripts used plain text with one action per line, `#` comments, and a `context platform=... device=... theme=...` header (`src/replay/script.ts`).
Users recorded them through `open --save-script` or wrote them manually.
Recording used `packages/daemon/src/core/session-action-recorder.ts` and `packages/daemon/src/core/session-script-writer.ts`.
`runReplayScriptFile` executed each step under daemon `replay`/`test` commands.
The historical pointers are `src/daemon/handlers/session-replay-runtime.ts` and `src/daemon/handlers/session-replay.ts`.
Touch/fill/get targets used selector chains with `||` alternatives:
`buildSelectorChainForNode(...).join(' || ')` in `src/commands/interaction/runtime/resolution.ts:242`, mirrored in `src/daemon/handlers/session-replay-heal.ts:131-135`.
Maestro YAML imported through `--maestro` and `packages/maestro/src/internal/`.
Progress used `stepIndex`/`stepTotal` in `emitReplayTestActionProgress` (`session-replay-runtime.ts:243-260`).

Recovery required explicit `--update`/`-u` (`replayUpdate`, `src/commands/cli-grammar/flag-definitions-workflow.ts`).
It ran only after a hard step failure.
`session-replay-runtime.ts:118-149` used `if (!shouldUpdate) return failure; ... healReplayAction(...)`.
It retried only the same recorded selector material.
`collectReplaySelectorCandidates` (`session-replay-heal.ts:39-81`) collected original `selectorChain`/positionals.
`resolveSelectorChain` retried those strings against a fresh snapshot (`session-replay-heal.ts:122-135`).
If the identifying term itself changed (an id or label rename), the same string did not match the new tree either.
Thus heal could not rescue renames.
Heal could recover only drift that the ORIGINAL selector still matched: a moved or re-rendered node with the same id.
PR #297, which closed #279, had already removed `refLabel` synthesis and numeric `get text` drift healing.
Its stated scope was "centered on recorded selectors and explicit selector expressions".
Thus, maintenance had narrowed heal rather than expanded it.

**Benchmark evidence** comes from 2026-07-09/10 on an iOS simulator with the react-navigation/RN playground matrix.
The external harness follows `~/.agent-device-bench/rnnav-matrix.py`.
The table preserves key evidence independently of that directory:

| Measurement | Result |
| --- | --- |
| Snapshot captures per interaction, `--settle` off → on | 3.67 → 1.00 (the 1-snapshot floor) |
| Commands per task, settled arm vs unsettled arms | 14.3 vs 23.3 / 26.7 |
| react-navigation Maestro suite via deterministic replay | 38/38 flows green in 539 s, zero model turns |

At one snapshot per interaction, model-turn latency dominates agent-driven QA wall time over device I/O.
A normal successful agent-driven flow costs O(steps) model turns.
Deterministic replay costs O(divergences).
The 38/38 run demonstrates zero divergences and zero model turns.
The entire economic case for replay is to collapse the per-step model-turn cost toward zero on the happy path.
Replay pays only where reality diverged from the recording.

**Audit evidence** below is historical, dated 2026-07-10.
Element-14 later demonstrated the geometric incorrect-binding risk.
The 2026-08-07 structural-equivalence-or-reject amendment supersedes that policy.

- **(a) Heal had limited scope and rarely acted.** It recovered only same-selector drift.
  Most actual failures were renames or removals that recycled candidates could not resolve.
- **(b) The real mis-binding surface was not heal. It was silent disambiguation in ORDINARY resolution**, in live commands and replay alike.
  Every press/click/fill called `resolveSelectorChain(..., { disambiguateAmbiguous: true })` through `resolveSelectorInteractionTarget` (`resolution.ts:170-183`).
  For N>1 matches, `accumulateDisambiguationCandidate`/`compareDisambiguationCandidates` silently chose a winner (`packages/selectors/src/internal/resolve.ts:181-285`).
  Visible candidates preceded off-screen candidates, then deepest nodes, then smallest on-screen areas.
  Only exact ties failed.
  `describeResolvedInteractionNode` (`resolution.ts:227-249`), the entire identity payload of the response, returned these fields:
  `node`, `selectorChain`, `refLabel`, `targetHittable`, and `hint`.
  It disclosed neither match count nor tiebreak.
  A live audit reproduced this with two identical-rect "Prevent Remove" buttons in the RN playground.
  Scroll position alone selected the target.
  General help documented the policy in `agent-device help workflow` and `src/cli/parser/cli-help.ts:243,384`:
  "does not fail by default ... auto-resolves deepest node first ... then smallest on-screen area".
  Responses did not disclose each use.
  An agent without that help context could not know that a heuristic selected the target.
  A moved target between record and replay had the same disclosure gap.
- **(c) This path had no target-binding verification at acceptance.**
  `--verify` attached a pre/post-action node diff through `captureEvidenceBaseline` (`resolution.ts:45-58,104-134`).
  ADR 0011's `verifyEvidence` cell records that guarantee.
  The diff proved change, not activation of the intended node.
  An incorrect sibling "Prevent Remove" press produced a visible diff but remained incorrect.
- **(d) Heal disclosed only a count.** Successful `--update` returned `{ replayed, healed, ... }` (`session-replay-runtime.ts:186-195`).
  `healed` was only a number.
  `writeReplayScript` rewrote `.ad` in place without a response diff (`session-replay-runtime.ts:182-184`, `src/replay/script.ts:459-484`).
- **(e) Silent selection conflicted with other ambiguity policy.** Elsewhere, the repository refused ambiguous input and gave hints.
  `start`/`restart` were intentionally absent from alias suggestions.
  `src/cli/parser/command-suggestions.ts:16-17` explains that `start` is "genuinely ambiguous, so a hint beats silently guessing".
  Selector resolution used the opposite default.
  ADR 0011 classified runtime-selector `disambiguation` as `{ kind: 'runtime', via: '...selectors-resolve.ts#resolveSelectorChain' }` (`packages/contracts/src/interaction-guarantees.ts:176-179`).
  This proved consistent heuristic execution, not disclosure.
  The acceptance-time design did not reconsider that default; its hard-reject alternative explains why.
- **(f) Issue #1037 / PR #1040 provided partial precedent.** Apple Maps uniquely matched `text="Anthropic - Headquarters"` to a 30x30 pin instead of a recents row.
  `describeNonHittableTarget` exposed `targetHittable:false` and a hint (`resolution.ts:259-268`).
  It disclosed but did not prevent the incorrect tap.
  N>1 disambiguation had no equivalent disclosure at acceptance.
- **(g) Issues #279/#297 supported reduced heal scope.** They showed precedent for removal when a heuristic's benefits did not justify complexity.

**Live hands-on evidence** comes from manual replay on the RN playground, iOS simulator, on 2026-07-10.
It covers both `.ad` and Maestro:

- **Successful text replay was silent.** Exit was 0 without output.
  Only `--json` showed `replayed: 5`.
  The success payload `{ replayed, healed, session, artifactPaths }` had no `message` (`session-replay-runtime.ts:186-195`).
  The generic CLI path therefore printed nothing:
  `writeGenericCliOutput` → `readCommandMessage` → `writeCommandOutput`.
  Pointers are `src/cli/commands/generic.ts:68-71`, `packages/kernel/src/success-text.ts:12-14`, and `src/cli/commands/shared.ts:4-15`.
  An agent needed another verification turn to learn the result.
- **Failure output lacked screen evidence.** It contained step, action, selector, and a generic hint.
  The observed divergence was app-state restoration.
  The RN app persisted navigation and restored Article after relaunch+deeplink.
  A correct selector therefore missed.
  Heal could not repair correct selector text on an incorrect screen.
  A "current screen: Article" observation would have identified the repair immediately.
  Only full replay was available, without `--from`.
  Repeated prefixes made state-restoring apps nondeterministic across attempts.
- **Maestro step indices were untraceable to source.** A broken `tapOn: Push Input`, the 4th top-level YAML step, failed as "Replay failed at step 5 (`__maestroTapOn` ...)".
  `runFlow file: ../launch.yml` expanded into the linear plan and shifted later indices.
  Failure output included no file or line.
  `parseReplayInput` flattened `--maestro` input (`src/compat/replay-input.ts:47-68`).
  `convertRunFlow`/`readRunFlowActions` inserted included actions (`src/compat/maestro/flow-control.ts:40-41,123-124`).
  `parseRunFlowFile` supplied them through `src/compat/maestro/replay-flow.ts:267-280`.
  Platform/`true` `when` conditions evaluated during parsing (`flow-control.ts:47-48`).
  Fixed `repeat.times` expanded deterministically (`flow-control.ts:84-87`).
  Provenance disappeared in two places.
  `convertRootCommands` assigned the parent YAML line to every converted action (`replay-flow.ts:76-83`).
  `parseRunFlowFile` callers retained only `.actions` and discarded included paths and line tables.
  Even `.ad` line tracking did not reach callers.
  `actionLines` reached per-action ndjson through `appendReplayTraceEvent` (`src/daemon/handlers/session-replay-action-runtime.ts:47-56`).
  `withReplayFailureContext` exposed only `replayPath` and `step` (`session-replay-runtime.ts:349-369`).
- **Equivalent failures differed by format.** Native `.ad` selector misses returned `COMMAND_FAILED` with targeted selector guidance.
  `selectorFailureHint` supplied "Run snapshot -i ... or use find ..." (`packages/selectors/src/internal/resolve.ts:110-113`, thrown at `resolution.ts:213-217`).
  Maestro returned `ELEMENT_NOT_FOUND` without a hint (`src/compat/maestro/runtime-interactions.ts:644-652`).
  `defaultHintForCode` supplied "Retry with --debug and inspect diagnostics log for details." (`src/kernel/errors.ts:253-254`).
- **Recordings had no verification steps.** `buildOptimizedActions` removed recorded snapshots with `if (action.command === 'snapshot') continue;` (`packages/daemon/src/core/session-script-writer.ts:315`).
  It reinserted only synthetic ref-scoped snapshots for resolution, not observation.
  `RECORDED_FLAG_KEYS` came from flag declarations' `recorded` fields (`packages/daemon/src/core/session-action-recorder.ts:367-381`).
  That allowlist omitted `settle`, `settleQuietMs`, and `verify`.
  Replay therefore performed actions without outcome observation.
  Decision 3's record-time identity evidence addresses the identified gap.

Recorded `@ref` steps already carried an optional identity hint, although it was underused.
`appendRefLabel` wrote the node label as a trailing token (`packages/daemon/src/core/session-script-writer.ts:532-537`).
The parser restored `action.result.refLabel` (`src/replay/script.ts:269,295,315`).
At acceptance, `tryResolveRefNode` used it only as a fallback lookup key when the ref failed (`fallbackLabel`, `resolution.ts:393,413-430`).
`buildScopedSnapshotAction` also used it for pre-action capture scope (`session-script-writer.ts:136-155`).
It never verified the disambiguation winner.
This established per-step identity transport in `.ad`, which decision 3 extends to verification.
