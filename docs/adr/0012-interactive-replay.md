# ADR 0012: Interactive Replay (agent-in-the-loop repair, resolution disclosure, retiring `--update` healing)

## Status

Proposed (2026-07-10). Nothing in this ADR is implemented yet.

## Context

Replay today is deterministic. `.ad` scripts are plain text — one action per line, `#` comments, a
`context platform=... device=... theme=...` header (`src/replay/script.ts`) — recorded via
`open --save-script` (`src/daemon/session-action-recorder.ts`, `src/daemon/session-script-writer.ts`)
or hand-written, and executed step-by-step by `runReplayScriptFile`
(`src/daemon/handlers/session-replay-runtime.ts`) under the daemon's `replay`/`test` commands
(`src/daemon/handlers/session-replay.ts`). Recorded touch/fill/get targets are selector chains with
`||` alternates (`buildSelectorChainForNode(...).join(' || ')`,
`src/commands/interaction/runtime/resolution.ts:242`, mirrored in
`src/daemon/handlers/session-replay-heal.ts:131-135`); Maestro YAML flows import through `--maestro`
(`src/compat/maestro/`); progress is step-indexed (`stepIndex`/`stepTotal` in
`emitReplayTestActionProgress`, `session-replay-runtime.ts:243-260`).

Recovery is opt-in `--update`/`-u` healing (`replayUpdate` flag,
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

**Audit evidence** (2026-07-10) on where that divergence cost actually goes:

- **(a) Heal is narrow and mostly unable to act.** Per the mechanism above, heal only recovers
  same-selector drift. Most real replay failures are renames or removals heal's candidate-recycling
  cannot reach.
- **(b) The real mis-binding surface is not heal — it is silent disambiguation in ORDINARY resolution**,
  live and replay alike. `resolveSelectorInteractionTarget` calls `resolveSelectorChain(..., {
  disambiguateAmbiguous: true })` on every press/click/fill (`resolution.ts:170-183`); when a selector
  matches N>1 nodes, `accumulateDisambiguationCandidate`/`compareDisambiguationCandidates`
  (`src/selectors/resolve.ts:181-285`) silently pick a winner — visible candidates over
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
- **(c) No target-binding verification exists anywhere in this path.** `--verify`
  (`captureEvidenceBaseline`, `resolution.ts:45-58,104-134`; the `verifyEvidence` guarantee cell in ADR
  0011's registry) attaches a pre/post-action node diff so the caller can see SOMETHING changed — it
  says nothing about whether the CORRECT node was the one tapped. A wrong-but-plausible pick (the
  sibling "Prevent Remove" button) produces a real, visible diff and is still the wrong action.
- **(d) Heal auditability is a bare count.** A successful `--update` run returns
  `{ replayed, healed, ... }` (`session-replay-runtime.ts:186-195`) — `healed` is a number, nothing
  else — and rewrites the `.ad` file in place via `writeReplayScript`
  (`session-replay-runtime.ts:182-184`, `src/replay/script.ts:459-484`) with no diff shown anywhere in
  the response.
- **(e) This silent-pick default is in real tension with this repo's general posture toward ambiguity.**
  Elsewhere, ambiguous input is refused and hinted about rather than silently guessed — `start`/`restart`
  are deliberately left out of the CLI alias-suggestion table because `start` is "genuinely ambiguous, so
  a hint beats silently guessing" (`src/cli/parser/command-suggestions.ts:16-17`). Selector resolution
  took the opposite default, and ADR 0011's own registry records that choice precisely: the
  `disambiguation` cell for `runtime-selector` is classified `{ kind: 'runtime', via:
  '...selectors-resolve.ts#resolveSelectorChain' }` (`src/contracts/interaction-guarantees.ts:176-179`)
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
  `src/cli/commands/generic.ts:68-71`, `src/utils/success-text.ts:12-14`,
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
  (`selectorFailureHint`, `src/selectors/resolve.ts:110-113`, thrown at `resolution.ts:213-217`);
  the equivalent Maestro miss is `ELEMENT_NOT_FOUND` constructed with no hint
  (`src/compat/maestro/runtime-interactions.ts:644-652`), falling through to the generic default
  "Retry with --debug and inspect diagnostics log for details." (`defaultHintForCode`,
  `src/kernel/errors.ts:253-254`).
- **Recordings contain zero verification steps.** The script writer strips every recorded `snapshot`
  action (`buildOptimizedActions`, `src/daemon/session-script-writer.ts:69`: `if (action.command ===
  'snapshot') continue;` — only synthetic ref-scoped snapshots are re-inserted, as resolution aids, not
  observations), and the record-time flag allowlist (`SANITIZED_FLAG_KEYS`,
  `src/daemon/session-action-recorder.ts:46-77`) carries neither `settle`/`settleQuietMs` nor `verify`,
  so `--settle`/`--verify` are dropped from recorded steps. A recording therefore replays actions with
  no outcome observation at all — exactly the gap decision 3's record-time identity evidence fills.

A related, currently under-used precedent: recorded `@ref` steps already carry an optional identity
hint in the `.ad` file. `appendRefLabel` (`src/daemon/session-script-writer.ts:235-240`) writes the
node's label as a trailing token, parsed back into `action.result.refLabel`
(`src/replay/script.ts:269,295,315`). Today that label is used only as a fallback LOOKUP key
(`tryResolveRefNode`'s `fallbackLabel`, `resolution.ts:393,413-430`) when the ref itself fails to
resolve, and to scope the pre-action snapshot capture (`buildScopedSnapshotAction`,
`session-script-writer.ts:136-155`) — never as a check against what disambiguation actually picked. It
establishes the pattern this ADR's decision 3 extends into a verification role: per-step identity
already travels in the `.ad` file.

## Decision

### 1. Retire `--update` healing as an actor; repurpose its candidate machinery as ranked suggestions

`--update`/`-u` stops silently rewriting `.ad` files. The two pieces of machinery it already has —
`collectReplaySelectorCandidates` (recorded-chain/positional extraction) and the `resolveSelectorChain`
re-resolution it drives — are repurposed to populate the ranked `suggestions` list inside the
divergence report (decision 4), not to act unattended.

**Ranking is a total order**: (1) candidates satisfying more identity components rank first — a
recorded-id match outranks a role+label match, which outranks a label-only match; (2) among equals,
candidates in the same `scrollRegion` as recorded rank before candidates in other regions; (3) document
order is the final tie-break. Suggestions are deduplicated by node: a node reachable through several
recorded selector terms appears once, tagged with its strongest match basis. The list is bounded by
decision 4's suggestion cap. Response levels affect only report content, never file behavior: before
retirement lands (migration step 6), `--update` keeps its legacy rewrite semantics regardless of level;
after retirement, `--update` at any level performs no rewrite and returns the same bounded suggestions
object, with `--level digest` omitting suggestion entries but carrying `suggestionCount` per decision 4.

With an agent in the loop, adjudicating a heal
proposal costs one cheap model turn — cheaper than discovering a silent wrong repair later — and the
audit ((a) above) already found heal rarely able to act. A proposal an agent can accept, reject, or edit
is strictly more valuable than the same proposal applied blind.

### 2. Disclose daemon-tree disambiguation and identify fast-path responses

The daemon-tree selector path (`runtime-selector`) adds an additive `resolution` response field. A unique
tree resolution is `{ source: "runtime", phase: "pre-action", kind: "unique" }`; a heuristic resolution
is `{ source: "runtime", phase: "pre-action", kind: "disambiguated", matchCount, winnerDiagnostic,
tiebreak, alternatives }`. `tiebreak` is one of `visible`, `deepest`, or `smallest-area`; `alternatives`
contains at most **5** losing `diagnosticRef` entries. The selected diagnostic is not included in
`alternatives`. `winnerDiagnostic` and each alternative are `{ diagnosticRef, role?, label? }`, where
`diagnosticRef` is an opaque non-`@` diagnostic token; every optional string is capped at **256 UTF-8
bytes** with a truncation marker. This discloses the existing heuristic without changing
`resolveSelectorChain` or its winner.

These are **pre-action diagnostics**, not issued refs. The selector-resolution snapshot can be invalid
after a mutating press/fill, so neither `winnerDiagnostic` nor `alternatives` carries `refsGeneration`, is
MCP-pinned, or may be reused as an `@ref` target. A caller that wants to act on an alternative must take a
fresh `snapshot`/`find`. A post-action `--settle` diff remains a separate, actionable issuer and may carry
fresh pinned refs. In contrast, a target-binding divergence sends no action; its fresh report snapshot is
an actionable issuer as defined in decision 4.

The ref paths disclose ref provenance. A lookup that resolves the `@ref` itself is
`{ source: "ref", phase: "pre-action", kind: "exact" }`. When the runtime-ref path recovers a stale or
unusable `@ref` through its recorded trailing label (`tryResolveRefNode`'s `fallbackLabel` — a first-match
label lookup, the replay recovery documented in Context), the response instead carries
`{ source: "ref", phase: "pre-action", kind: "label-fallback" }`: label recovery is not exact ref
provenance and must never claim it. The native-ref fast path always discloses `exact` — the ref handle is
the dispatched target, and although the recorded `fallbackLabel` is forwarded to the backend, any
label-based recovery a backend might perform with it is not observable daemon-side, so `exact` describes
the daemon's own resolution and no more specific claim is possible on this path.

The accepted direct-iOS selector fast path has no daemon tree and the XCTest response cannot truthfully
provide a match count, candidate refs, or a runtime tiebreak. It remains enabled for ordinary simple
`press`/`fill`, but its canonical response instead carries
`resolution: { source: "direct-ios", kind: "not-observed" }`. It must never fabricate a unique-match or
identity claim. `--verify` and `--settle` continue to disable this fast path and therefore produce a
runtime resolution. Recording likewise disables it for any action for which target-binding evidence is
required by decision 3.

ADR 0011's matrix must add a `resolutionDisclosure` guarantee with all six honest cells: `runtime-selector`
enforces the complete pre-action diagnostic shape; `runtime-ref` enforces the ref-provenance shapes
(`exact`, or `label-fallback` for trailing-label recovery) and `native-ref` enforces `exact`;
`direct-ios-selector` enforces only the explicit
`{ source: "direct-ios", kind: "not-observed" }` shape; `coordinate` is inapplicable because no element
was resolved; and `maestro-non-hittable-fallback` is inapplicable because Maestro owns matching and the
fallback is coordinate execution. Membership in the maestro cell is decided by the EXECUTED dispatch, not
the permission flag: a press that was allowed to fall back but hit its element normally is the direct-iOS
path and discloses `not-observed`; only a response whose runner actually executed the coordinate fallback
is the inapplicable maestro cell. The four enforced cells use the shared response builder. Its existing
direct-path `disambiguation` and `responseIdentity` waivers remain, and the exact waived-cell test must
continue to list them. Layer-3 coverage must claim every enforced/delegated cell: runtime
ambiguity/tiebreak/cap plus non-actionable diagnostics after mutation, exact-ref provenance for runtime
and native refs, the runtime-ref `label-fallback` recovery case, and a direct-iOS no-snapshot
`not-observed` case. No selection-parity table is claimed or
added for the direct path: such a table would falsely imply XCTest selection has runtime parity. A future
runner-side diagnostic design must replace the two waivers, add a Swift/TypeScript parity fixture, and add
the corresponding provider contract cases in the same change.

### 3. Versioned `.ad` target-binding evidence

Recording writes evidence for every action that resolves an element target. The plain-text format is a
versioned comment immediately before the action it annotates:

```text
# agent-device:target-v1 {"id":"save","role":"button","label":"Save","ancestry":[{"role":"toolbar","label":"Editor"},{"role":"window"}],"sibling":0,"viewportOrder":0,"scrollRegion":{"role":"scrollview","id":"editor-scroll"},"verification":"verified"}
click @e12 "Save"
```

The prefix is ASCII and the payload is one JSON object encoded on one line. JSON supplies all quoting and
escaping; writers must use canonical `JSON.stringify` field order `id`, `role`, `label`, `ancestry`,
`sibling`, `viewportOrder`, `scrollRegion`, `rect`, `verification`, and rect order `x`, `y`, `width`,
`height`. `verification` is `"verified"` or `"unverifiable"`. The payload has **three tiers** with
different comparison roles:

- **Identity** (compared exactly): `id` when recorded, else `role` plus normalized `label`, plus the
  leaf-anchored `ancestry` prefix. `role` is `normalizeType(node.type ?? "")`, exactly the normalized
  type used by `buildSelectorChainForNode`; it is never the raw optional `node.role`.
- **Disambiguation signals** (consulted only when several current nodes share the identity): `sibling`
  (a genuine same-parent child index), then `viewportOrder` scoped to the recorded `scrollRegion`
  partition — normalized, relative signals, never absolute pixels, with document order as the final
  deterministic tie-break for every ordering.
- **Diagnostics** (never compared): optional `rect`, carried only so divergence reports can show where
  the recorded target was.

Absolute geometry is deliberately demoted out of identity: an absolute rect is the least stable component
of a target's identity — scroll offset, device rotation, dynamic type, iPad/macOS window resizing, and
ordinary RN layout shifts all move rects between healthy runs — and the audit's identical-rect
"Prevent Remove" sibling pair proves absolute geometry cannot even separate identical siblings in the
worst case. No absolute-coordinate tolerance exists in v1: the earlier draft's ±8-unit rect comparison is
removed rather than tuned, because no measured drift distribution exists to justify any particular
constant. If a future revision reintroduces an absolute tolerance, it must carry measured evidence.

**Normalization.** All strings are Unicode NFC. `label` additionally trims leading/trailing whitespace
and collapses internal whitespace runs to a single space. Comparison is case-sensitive after
normalization (a label case change is a real UI change). A string that is empty after normalization is
omitted by the writer and treated as absent by the comparator. Each string field is at most **256 UTF-8
bytes** after normalization; the whole payload is at most **4 KiB**; `ancestry` has at most **eight**
entries; `sibling` and `viewportOrder` are non-negative safe integers. The parser rejects a v1 annotation
exceeding these bounds with `INVALID_ARGS`.

**Writer-parser invariant.** The recorder must never emit a payload its own parser rejects. When a
payload would exceed the 4 KiB ceiling after per-field truncation, the writer reduces it
deterministically: drop `ancestry` entries one at a time from the **root side** — the same side ancestry
truncation already drops from — until the payload fits. If it still overflows with only `ancestry[0]`
(the parent) retained, the writer downgrades the annotation to `verification: "unverifiable"`
(fail-closed) rather than writing an invalid or silently-lossy script; with the per-field 256-byte caps
in force, a parent-only payload fits arithmetically, so the downgrade branch is a terminal guarantee,
not an expected path. The record-time self-check (step 5 below) runs against the reduced tuple, so a
`verified` claim is always honest for exactly what was written.

**Local identity.** Two nodes share local identity when both carry `id` and the normalized ids are equal;
or, when the recording carries no `id`, when their normalized roles are equal and their normalized labels
are equal (label absent on both sides counts as equal; label present on exactly one side is a mismatch).
A recorded `id` never matches a node without that id.

**Ancestry.** The chain is the nearest **K = 8** ancestors of the target, ordered **leaf→root** (nearest
ancestor first), each entry `{ role, label? }` under the same normalization (`role` may be the empty
string when the node has no type; `label` is omitted when empty). Truncation drops entries from the
**root side only** — the nearest ancestors are always kept. Comparison is a **leaf-anchored prefix
match**: recorded chain R matches observed chain O iff for every index `i < |R|`, `O[i]` exists, the
roles are equal, and — when `R[i]` carries a label — the labels are equal (a label absent in `R[i]` is
unconstrained). `|O| < |R|` is a mismatch. An inserted or removed wrapper ancestor therefore changes
identity by design: structure is part of identity.

**Record-time write.** Both positional signals are defined over candidate domains that record and
replay compute identically — never one domain at record time and another at replay. **Document order**
— a node's pre-order tree-traversal index — is the canonical total order of this contract: every
enumeration, ordering tie, and candidate listing below resolves by document order, so every comparison
is total and deterministic.

1. Resolve the action's winner and compute its identity tuple from the record-time tree.
2. Compute the record-time identity set: all nodes sharing the winner's local identity with a matching
   leaf-anchored ancestry prefix.
3. `sibling` is the winner's zero-based index among its **parent's children** in the tree — a genuine
   same-parent structural ordinal, independent of scroll regions and cheap to read off the
   accessibility tree. The parent is already captured as `ancestry[0]` in the leaf-anchored chain, so
   no additional field is recorded; record and replay compute this ordinal identically by definition.
4. Partition the identity set by **scroll region**: the partition key is the local identity (`role` +
   `id`/`label`) of a member's nearest scrollable ancestor, or *none* when it has no scrollable
   ancestor. `scrollRegion` is the winner's partition key (omitted when *none*). `viewportOrder` is the
   winner's zero-based ordinal **within its own partition** — not the whole identity set — ordered by
   rect center top-to-bottom then left-to-right, with equal centers resolved by document order and
   rect-less members last, in document order. The partition is the ordinal's domain on both sides, so
   recorded and replayed `viewportOrder` always refer to the same candidate domain.
5. Run the replay-time verification algorithm below against the record-time tree itself. If it isolates
   exactly the winner, write `verification: "verified"`; otherwise write `verification: "unverifiable"`.
   Because both ordinals are computed from the winner over deterministic total orders, this self-check
   succeeds by construction whenever the capture supplies the needed structural data; `unverifiable` at
   record time therefore marks a capture anomaly — a signal that could not be computed (e.g. missing
   parent linkage) — and the branch is kept as a fail-closed safety valve, not an expected path. An
   unverifiable annotation makes the step an `identity-unverifiable` divergence at replay, before
   acting — the evidence declares its own limits at record time instead of permitting a silent best
   guess later.

A v1 parser accepts known fields in any JSON object order, ignores unknown fields, normalizes known
strings to NFC, and rejects malformed annotations or invalid known field types with `INVALID_ARGS`. An
unknown future `target-vN` comment is an ordinary comment to a v1 reader.

The annotation binds only to the next physical action line. A blank line or any intervening line leaves
it unbound and is rejected as `INVALID_ARGS`; this prevents an edit from silently moving evidence to a
different target. Parser/writer tests must prove parse-write-parse semantic equality, embedded quotes,
backslashes, Unicode, and the unbound/malformed cases.

Old readers ignore the comment and execute the action unchanged. New readers accept old scripts with no
annotation and perform no target-binding check for those actions. A writer that reads then rewrites a
script preserves v1 annotations in canonical form; it must not silently discard them. This is an additive
`.ad` format change, not merely per-line growth.

**Replay-time verification.** Every annotated resolved target is checked before its action is sent, by
this exact classification. `matchCount` is the number of current nodes matching the **recorded selector**
at replay time — the same match set resolution itself used — with range **0..N**. It is **required on
every path that performs resolution (paths 2–6 below) and absent on path 1** — the key is omitted per
the drop-empty-keys convention, never `null` — because path 1 fires before any resolution. No
diagnostic-only count is computed there: a recorded-unverifiable annotation means there is no
trustworthy recorded identity to resolve against, so a count would invite misreading and add capture
cost on a path that by definition cannot verify. Identity verification applies only when
`matchCount >= 1`.

1. Recorded `verification` is `"unverifiable"` → **identity-unverifiable** divergence, before any
   resolution.
2. `matchCount == 0` → **selector-miss** divergence: the recorded selector no longer matches anything.
   This class is distinct from an identity mismatch — the repair is a selector repair.
3. `matchCount >= 1`; the identity set I (matched nodes sharing the recorded local identity with a
   matching ancestry prefix) is empty → **identity-mismatch** divergence: the selector still matches,
   but nothing carries the recorded identity.
4. `|I| == 1` and the resolution winner W is that member → **verified**; the action proceeds. This is
   the only path that sends the action.
5. `|I| == 1` and W is a different node → **identity-mismatch** divergence: a unique-but-wrong rebind or
   a changed ambiguity winner, caught even when resolution was unique.
6. `|I| > 1` → apply the disambiguation signals in order, each over the SAME candidate domain record
   time used: (i) **sibling** — the members of I whose zero-based index among their own parent's
   children equals the recorded `sibling`. Exactly one qualifying member: the evidence denotes it —
   compare with W as in paths 4/5. Zero or several qualifying members (the same child index can recur
   under different parents): the signal does not isolate; fall through. (ii) **region-scoped
   viewportOrder** — restrict I to the partition whose scroll-region key equals the recorded
   `scrollRegion` (the *none* partition when none was recorded). An empty partition means the recorded
   scroll region no longer exists: `viewportOrder` is **unavailable** and is never compared across
   regions; fall through. Otherwise order the partition by rect center top-to-bottom then
   left-to-right (equal centers by document order; rect-less members last, in document order); if the
   recorded `viewportOrder` ordinal is in range, the evidence denotes that member — compare with W as
   in paths 4/5; out of range falls through.
   If neither signal isolates a member, the step is an **identity-unverifiable** divergence with up to
   **5** candidates listed in document order — never a silent pick. Document order makes every ordering
   above total, so a residual tie would require two nodes at identical positions in an identical tree —
   impossible under pre-order indexing — and even that residual case is identity-unverifiable, not a
   pick. That refusal is the point of this ADR.

A field present in the recording but absent on the compared node is a mismatch; `rect` is never compared.
An old unannotated action remains executable without this check. All three divergence classes are
target-binding divergences reported before the device action. This is not general outcome verification:
`--verify` remains post-action change evidence with a different contract.

### 4. Divergence wire contract and replay-only resume

**Divergence is a structured error, not success data.** The daemon returns `ok:false` with code
`REPLAY_DIVERGENCE` and a `details.divergence` object for both an action failure and a target-binding
mismatch. The object has version `1` and contains `kind`, `step` (`index`, `source.path`, `source.line`),
`action`, `cause`, `screen`, `suggestions`, `resume`, and, for binding failures, `targetBinding`
(`classification`, `matchCount`, `recorded`, `observed`, `mismatches`, `candidates`). `kind` is one of
`action-failure`, `selector-miss`, `identity-mismatch`, or `identity-unverifiable` — the latter three are
decision 3's target-binding classes, and `targetBinding.classification` always equals the top-level
`kind`. `targetBinding.matchCount` follows decision 3's presence rule exactly: present (0..N) for
`selector-miss`, `identity-mismatch`, and an `identity-unverifiable` reached through resolution (path 6);
absent — key omitted, never `null` — when `identity-unverifiable` arose from a recorded-unverifiable
annotation (path 1), which fires before any resolution.
`step.index` is the 1-based executable-plan ordinal, not a source
line. Its source location is diagnostic only. A Maestro parser must preserve the original file and line
through includes so that source location is actionable.

`screen` is discriminated. `{ state: "available", refsGeneration, refs, truncated }` is a fresh,
healthy snapshot digest and the only form that issues actionable refs. `{ state: "unavailable", reason,
hint }` is returned when capture fails or is sparse; it has no refs or generation and must not fall back to
the old session tree. Screen-capture failure never replaces or masks the original replay cause.

Response levels bound the entire serialized UTF-8 `details.divergence` object, not merely its arrays:
compact (`--level digest`) is at most **8 KiB**, default at most **24 KiB**, and full at most **64 KiB**.
Compact carries at most **8** screen refs and no suggestion entries — it carries `suggestionCount` (the
number of suggestions available at default/full) so a caller knows whether a re-fetch at a higher level
has material; default and full carry at most **20** screen refs and **5** suggestions ranked per
decision 1's total order. These counts are absolute, including error payloads. Individual
labels, ids, selectors, source paths, mismatch values, cause messages, and hints are UTF-8 truncated to
**256 bytes**; an action summary has no positional array, and fill text, expanded variables, and arbitrary
nested cause details are never serialized. All rendered strings and any overflow artifact pass through the
central diagnostics redactor before truncation. The report sets truncation/redaction markers for every
omission.

When the bounded form would omit material, the daemon writes the same redacted, bounded-per-field detail
to a session-scoped divergence artifact and returns its path plus `overflow: { omittedBytes, artifactPath
}`. If that artifact cannot be written, it returns `artifactUnavailable: true` and preserves the original
error. No raw snapshot tree or unredacted input is written to the artifact.

The same daemon error is preserved end to end. The Node client rejects with `AppError` retaining
`details.divergence`. CLI exits nonzero; text renders a compact report and JSON includes the complete
structured error. The MCP tool returns `isError: true`, exposes the object as `structuredContent`, and
renders the same compact text summary. MCP treats this error as a ref-issuing result: it merges and pins
every `screen` ref with `refsGeneration` before returning it, including on the error path. CLI and direct
client callers receive the unpinned refs and generation already present in the daemon error. No caller
gets a text-only divergence that loses its repair data.

`--from N` is a `replay`-only flag. `test` must reject it as `INVALID_ARGS`; test shares replay execution
but must remain a full, deterministic suite run. `N` is a 1-based index into the fully expanded
executable plan and must be in range. It is never a YAML line number, fractional source-step number, or a
repeat iteration label. Static includes, platform conditions, and fixed-count repeats expand before
indexing, so repeated source lines are distinguished by their plan index.

Every divergence includes `resume: { allowed, from, reason?, planDigest }`. `planDigest` is SHA-256 over
the canonical fully expanded plan, including each action's command, normalized inputs, control shape,
platform-conditioned expansion, and source provenance. Concretely "normalized inputs" bind each action's
positionals/flags, its execution-affecting `runtime` hints, and its `target-v1` identity annotation
(decision 3 — verification consumes it pre-action, so a changed annotation is execution-affecting); and
"platform-conditioned expansion" binds the EFFECTIVE resolved `platform`/`target` the run invokes with (CLI
flag over script metadata), never the raw script metadata, so a digest computed for one target is not
reusable against another. Deliberately EXCLUDED are native `.ad` `${VAR}` VALUES: substitution happens
after planning, so changing only late-bound values keeps the same digest. Maestro environment substitution
instead happens during compatibility parsing and can change action inputs, includes, or control expansion,
so it can change the digest. A resume requires both `--from N` and
`--plan-digest <planDigest>` from the report. The daemon rebuilds the current plan and rejects
`INVALID_ARGS` before any action when its digest differs, so edits or parse-time expansion cannot silently
retarget ordinal N. `allowed: false` explains why no resume is safe; its digest
is still diagnostic, not an authorization to bypass preflight.

Resume does not reconstruct execution state. For `N > 1`, preflight must reject with `INVALID_ARGS` when
any skipped action can produce `outputEnv` values, or when the skipped range or resume target is inside
runtime control flow (conditional, retry, or dynamic repeat). The only variables available after a resume
are explicit script/header, CLI, and shell inputs; if the planner cannot prove that, it rejects rather
than invoking with an incomplete scope. The daemon also never infers app state: the caller must put the
app into the required state before resuming. This conservative rule is intentionally the first release
scope; deterministic state reconstruction is deferred until it can be specified and tested separately.

The loop is therefore: run, read the divergence, repair app state, then replay with the reported plan
digest and index (or the next index after completing the failed action manually). Editing a script requires
a fresh full replay that produces a new digest. Help documents that protocol and its resume rejections.
Successful text replay prints one line with replayed count and wall time; `--json` remains structured.

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
  output retain it, MCP pins only actionable error-path refs, and no text-only path drops the report; and
- `--update` retirement tests proving it never rewrites the source file and only returns bounded
  suggestions ranked and deduplicated per decision 1's total order.

Extend the settle benchmark (`~/.agent-device-bench/rnnav-matrix.py` pattern, external harness) with a
replay arm only after these contracts pass: measure clean replay and one induced divergence repaired
through the allowed `--from` loop.

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
- **Disclosure adds bounded diagnostic bytes, not reusable targets.** Runtime ambiguity responses carry at
  most five pre-action alternatives; direct iOS responses pay only the explicit `not-observed` provenance
  marker. A fresh capture is the cost of acting on a diagnostic alternative.
- **Recorded identity evidence is an additive `.ad` format change.** It adds one reserved JSON comment
  before each supported recorded target action; scripts without the comment remain valid. A duplicate that
  survives structural evidence is intentionally a pre-action unverifiable divergence, not a best guess.
- **The disambiguation heuristic itself (visible → deepest → smallest-area) is unchanged.** The
  rejected alternative was hard-reject: fail any non-unique match instead of picking one. That would
  break benign, common cases the heuristic exists for — react-navigation's Maestro suite alone has 185
  `tapOn`s on short/duplicated labels (`'Albums'` x9, `'Go back'` x16, per #1040) that resolve correctly
  only because deepest/smallest-area picks the leaf button over its ancestor row/tab. Disclosure was
  chosen over rejection because the cost is asymmetric: most ambiguous matches are benign
  (tab+header+row sharing a label) and disclosure is nearly free for those, while rejection would fail
  all of them to catch the rare "Prevent Remove"-style case decision 3 is built to catch structurally
  instead.

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

## Migration plan

Steps are ordered so every dependency lands before its consumer; each step is independently useful, and
each states its dependencies explicitly.

1. **Resolution disclosure** (decision 2) — no dependencies. Update all six matrix cells, the exact
   waiver list, and provider mutation contracts together. Additive to response data; does not claim
   direct-iOS selection parity or issue pre-action refs.
2. **Structured divergence transport** (decision 4, report only) — no dependencies. `REPLAY_DIVERGENCE`
   with `kind: "action-failure"` attaches to the EXISTING replay failure paths: step provenance (source
   path + line preserved through Maestro includes), bounded/redacted payloads, actionable-or-unavailable
   screen semantics, error-path MCP pinning, ranked suggestions (decision 1's candidate machinery,
   read-only), and the one-line text success summary. Immediately useful on its own — this closes the
   provenance/evidence gaps the live hands-on evidence documents — and introduces no verification
   semantics.
3. **`.ad` target annotations, inert** (decision 3, parser/writer only) — no dependencies. Bounded
   parser/writer round trips, the writer-parser invariant with root-side reduction, old/new reader
   compatibility, structural uniqueness, and duplicate detection. Recordings gain annotations; replay
   parses and preserves them but does not yet enforce.
4. **Target-binding verification** (decision 3, enforcement) — depends on 2 (reports through the
   divergence transport, adding the `selector-miss`/`identity-mismatch`/`identity-unverifiable` kinds)
   and on 3 (consumes the annotations).
5. **`replay --from` + `--plan-digest` resume** (decision 4, resume) — depends on 2 only (the report
   supplies `resume` and `planDigest`); may land before, with, or after 3/4. `test` does not expose
   `--from`.
6. **`--update` retirement** (decision 1) — depends on 2 (ranked suggestions must be available in the
   report before the write path is removed), with a no-write regression test.
7. **Benchmark extension** (decision 5) — follows the mandatory contracts; measures the economic claim
   (clean replay plus one induced divergence repaired through the allowed `--from` loop).
