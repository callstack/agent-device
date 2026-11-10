# Target annotations

These contracts supplement [ADR 0012](../../../docs/adr/0012-interactive-replay.md) decision 3.
`@agent-device/ad-script` parses, serializes, and classifies `target-v1` and `targets-v1` annotations.
`@agent-device/selectors` builds record-time evidence and owns the writer-parser invariant.
`@agent-device/contracts` holds their shape.

## Format

Recording writes evidence for every action that resolves an element target.
The versioned comment immediately precedes its action:

```text
# agent-device:target-v1 {"id":"save","role":"button","label":"Save","ancestry":[{"role":"toolbar","label":"Editor"},{"role":"window"}],"sibling":0,"viewportOrder":0,"scrollRegion":{"role":"scrollview","id":"editor-scroll"},"verification":"verified"}
click @e12 "Save"
```

The prefix is ASCII.
The payload is one JSON object on one line.
JSON supplies all quotation and escape rules.
Writers must use canonical `JSON.stringify` field order: `id`, `role`, `label`, `ancestry`, `sibling`, `viewportOrder`, `scrollRegion`, `rect`, `verification`.
Rect field order is `x`, `y`, `width`, `height`.
`verification` is `"verified"` or `"unverifiable"`.

An action that resolves two elements records one `targets-v1` annotation instead of `target-v1` (#1567).
Its form is `# agent-device:targets-v1 {"source":{...},"destination":{...}}`.
Each nested value is a complete `TargetAnnotationV1`.
The same identity, normalization, field-size, and verification rules apply.
The wrapper limit is 8,320 bytes.
Before dispatch, replay verifies both selectors and carries two post-resolution guards.
If either endpoint has a selector miss, an identity mismatch, unverifiable evidence, or a dispatch-time guard mismatch, replay refuses the whole action before pointer-down.
Older readers treat unknown future `targets-vN` annotations as ordinary comments, as with single-target versions.

## Comparison tiers

- **Identity, compared exactly:** recorded `id`, otherwise `role` plus normalized `label`, together with the leaf-anchored `ancestry` prefix.
  `role` is `normalizeType(node.type ?? "")`, as `buildSelectorChainForNode` uses.
  It is never the raw optional `node.role`.
- **Disambiguation signals, consulted only when several current nodes share the identity:** `sibling`, then `viewportOrder` within the recorded `scrollRegion` partition.
  `sibling` is the actual same-parent child index.
  These relative signals use no absolute pixels.
  Document order resolves every ordering tie.
- **Diagnostics, never compared:** optional `rect` shows the recorded target's location in divergence reports.

No absolute-coordinate tolerance exists in v1.
If a future revision reintroduces an absolute tolerance, it must carry measured evidence.

## Normalization and bounds

All strings use Unicode NFC.
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

## Writer-parser invariant

The recorder must never emit a payload that its parser rejects.
If per-field truncation still leaves more than 4 KiB, the writer removes `ancestry` entries from the root side, one at a time.
This reduction is deterministic and uses the existing ancestry truncation direction.
If only `ancestry[0]` remains and the payload still exceeds the limit, the writer sets `verification: "unverifiable"`.
The limit measures serialized UTF-8 bytes, while field limits apply before JSON escaping.
Escape-heavy values can still exceed the limit after this downgrade.
The writer then drops `rect`, `scrollRegion`, the remaining `ancestry`, and `label`, in that order.
It measures the payload again after each drop and stops when the payload fits.
Replay refuses recorded `"unverifiable"` evidence before it reads these fields, so the drops do not weaken replay.
A capped field escapes to at most six times its limit, so `role` and `id` alone always fit and the writer never drops them.
If a field limit change breaks that bound, the writer throws instead of writing a payload that exceeds the limit.
When the reduced tuple fits, the record-time self-check uses that tuple.
A `verified` claim therefore applies to exactly the written evidence.

Action-mode evidence has another independent cause for the same `"unverifiable"` downgrade (#1398, ADR 0017).
It applies when a matched node's label echoes a literal already parameterized by the recording session.
The writer first replaces that literal with its placeholder in the label.
The literal therefore never enters the payload.
Landmark mode (`wait`) instead drops the annotation, as [Read-only steps](#read-only-steps) specifies.
ADR 0017's session-scoped echo protection amendment defines the full mechanism.

## Local identity

If both nodes carry `id`, equal normalized ids establish local identity.
If the recording carries no `id`, normalized roles and labels must match.
Absent labels on both sides are equal.
A label on only one side is a mismatch.
A recorded `id` never matches a node without that id.

An id may identify the target and lead its selector chain only if it is unique in the record-time tree (#1269).
The writer counts matches for the id independently of ancestry.
If multiple nodes carry that id, the writer demotes it to role+label, as for an unrecorded id.
The rule uses capture-time uniqueness, not an `android:id/*` namespace heuristic.

## Identity-empty pressed containers

A **click/press** can resolve an identity-empty container (#1280).
After the #1269 demotion, this means no surviving id, no label, and no value.
A demoted raw identifier counts as neither identity nor text.
Recording substitutes the container's first labeled descendant.
Its selector chain and `target-v1` tuple then carry selective role+label identity instead of a shared bare role.
"First labeled descendant" means the first node in document order within the whole subtree with a non-empty normalized label.
`fill` is excluded because its recorded `editable=true` constraints cannot match that descendant.
Otherwise, the script could not replay.

Two guards must permit the substitution:

1. The subtree contains **no competing interactive node**.
   No node is flagged `hittable`.
   No node has an independently tappable role under `isSemanticTouchTarget`, the policy for hittable-ancestor promotion.
   A row with a trailing `Switch` or `Checkbox` must not retarget.
   The descendant's center and the container's center could activate different controls.
2. The selected descendant's rect center lies **inside the container's rect**.
   The replay tap point must remain within the original activation region.
   Missing rects prevent substitution.

If either guard blocks substitution, recording keeps the container.
If no descendant has a label, recording also keeps the container.
This is a **recording-only side channel**.
The live response continues to describe the dispatched container: resolved node, selector chain, ref-label, tap point, resolution disclosure, and `targetHittable`/hint.
`resolveSelectorChain` and dispatch do not change.
Only the recorded action entry and its `target-v1` evidence use the descendant.
The rule applies to every platform.

## Read-only steps

Evidence extends to eligible read-only steps without changes to their execution semantics (#1349).
The `target-v1` tuple, bounds, writer, and parser do not change.
Each command declares when verification runs on the central `CommandDescriptor`:
`targetIdentityVerification: 'pre-dispatch' | 'post-resolution'`.
A completeness test enforces this declaration.
A new evidence-carrying command must select its phase explicitly.
It must not silently use generic pre-dispatch verification.

**`wait <selector>` uses `post-resolution` landmark existence semantics.**
Its landmark can be absent when the step starts.
Generic pre-action verification paths 2-6 must never run for it.
Only path 1, recorded-`unverifiable` without screen examination, refuses immediately.
The annotation instead enters the wait's polling loop through `internal.replayLandmarkGuard`.
This uses the same daemon-only channel as `replayTargetGuard`.
Success requires a selector match with recorded identity, not merely a selector match.
The comparison uses only local identity and the leaf-anchored ancestry prefix.
It excludes positional disambiguation signals.
A destination guard proves landmark existence on the ready screen, irrespective of list position.
Positional comparison could incorrectly reject a valid reordered screen.

Polling is fail-open in time and fail-closed at the deadline.
A same-selector impostor never aborts the wait.
Transient similar elements can appear during a transition.
At the deadline, matching polls without the recorded identity cause `identity-mismatch` before wait success.
`matchCount` comes from the last matching poll.
`mismatches` includes observed identity and the first ancestry mismatch.
If the selector never matches, the ordinary timeout remains `action-failure`.
This requires state repair, and its existing `repairHint` routing remains correct.
Polling also continues after an unreadable capture.
Android reports content verdicts through `isUnreadableCaptureContentError`.
iOS reports the same state as a sparse verdict without matches.
If the screen never becomes readable, the deadline rethrows the last capture verdict instead of a generic timeout.

Record-time **landmark mode** changes the record-time self-check from isolation to identity-set membership.
This matches replay verification.
If the #1269 demotion leaves neither id nor label, the writer records **no annotation**.
A role-only landmark identity distinguishes too little.
The unannotated wait retains selector-existence semantics instead of refusing unverifiable evidence.
ADR 0016 uses exactly this definition: a qualifying destination guard is a selector wait with a `verified` annotation.
The writer also omits evidence when identity echoes a literal already parameterized through `fill --record-as` (#1398, ADR 0017).
A recorded label placeholder cannot verify against the live literal during replay.
The writer drops the evidence instead of publishing it unverified.

**`get` remains unchanged.** Pre-dispatch verification and the post-resolution guard already cover it.

**`is`, except `exists` and `absent`, uses `pre-dispatch` verification and the complete `get` pattern.**
It resolves one unique node immediately, so pre-action verification applies.
The resolved node/tree supply record-time evidence.
Dispatch passes `replayTargetGuard` to `assertExpectedResolvedTarget`, as for `get`.
Recording and guarded replays disable direct-iOS `is`/`wait` fast paths, as the existing `get` recording gate does.

**The following coverage remains deferred.** Tests prove no annotation is recorded and no identity check runs:

- `is exists` has no unique winner.
  It has wait-like existence semantics without the guard-critical role.
- `is absent` observes absence in one capture without a resolved winner.
  It records an ordinary observation.
  Its `predicate_failed` is always `action-failure`, never identity mismatch.
- `wait absent` polls for zero candidates without a resolved winner.
  No-match success has no `target-v1` or landmark annotation.
  A `wait_target_present` deadline is ordinary `action-failure`.
  It is never identity mismatch or an ADR 0016 destination guard.
- Every read-only `find` variant lacks a selector-chain identity token for classification.
  Publication already refuses mutating `find` as non-verifiable.
- `wait text`, `wait stable`, duration waits, and `wait @ref` have no element target or use a session-local ref.
  ADR 0016 already refuses publication of that ref.
  `wait @ref` is rejected instead of converted to a portable selector.

## Ancestry

The chain contains the nearest **K = 8** ancestors in **leaf→root** order.
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

## Record-time write

Record and replay compute both positional signals over identical candidate domains.
They never use one domain at record time and another at replay.
**Document order** is the node's pre-order tree-traversal index.
It is the canonical total order for enumeration, ordering ties, and candidate lists throughout this contract.
Every comparison is therefore deterministic and total.

1. Resolve the action's winner and compute its identity tuple from the record-time tree.
2. Compute the record-time identity set.
   It contains all nodes with the winner's local identity and matching leaf-anchored ancestry prefix.
3. Compute `sibling` as the winner's zero-based index among its **parent's children**.
   It is independent of scroll regions.
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
   An `unverifiable` result from this self-check identifies a capture anomaly, such as missing parent linkage.
   It is a fail-closed safeguard, not an expected path.
   At replay, it causes `identity-unverifiable` before an action.

## Parsing and binding

A v1 parser accepts known fields in any JSON object order.
It ignores unknown fields and normalizes known strings to NFC.
Malformed annotations or invalid known field types cause `INVALID_ARGS`.
A v1 reader treats an unknown future `target-vN` comment as an ordinary comment.

The annotation binds only to the next physical action line.
A blank or intervening line leaves it unbound and causes `INVALID_ARGS`.
This prevents an edit from silently assigning evidence to a different target.

Old readers ignore the comment and execute the action unchanged.
New readers accept unannotated old scripts without target-binding checks for those actions.
A writer that reads and rewrites a script preserves v1 annotations in canonical form.
It must not silently discard them.

## Replay-time verification

Every annotated resolved target uses this exact classification before dispatch.
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
   This requires selector repair, distinct from identity mismatch.
3. `matchCount >= 1` and identity set I is empty: return **identity-mismatch**.
   I contains selector matches with the recorded local identity and matching ancestry prefix.
4. `|I| == 1` and resolution winner W is that member: **verified**.
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
     If the partition is empty, no identity-set candidate is in the recorded region.
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

A recorded field absent from the compared node is a mismatch.
`rect` is never compared.
Old unannotated actions remain executable without this check.
All three target-binding divergence classes precede device action.
`--verify` remains post-action change evidence under its separate contract.

## Required coverage

Parser/writer units cover these properties:

- V1 identity round trips, parse-write-parse semantic equality
- Old/new reader compatibility
- Embedded quotes, backslashes, Unicode, and other escape sequences
- Normalized-role source
- Leaf-anchored ancestry prefix comparison
- Root-side truncation
- Inserted-wrapper mismatch
- Duplicate/unverifiable record and replay evidence
- No rect comparison
- Unbound and malformed annotations
- Mismatch before action

Replay runtime tests cover all six verification paths: recorded-unverifiable, selector-miss (`matchCount == 0`), empty identity set, verified, unique-but-wrong rebind, and post-signal fall-through.
They also prove these positional properties:

- Same-parent `sibling` semantics, including repeated child indices under different parents
- Identical region-partitioned `viewportOrder` domains at record and replay
- Unavailable recorded scroll regions without cross-region comparison
- Out-of-range ordinals
- Document-order determinism for equal rect centers and rect-less members
