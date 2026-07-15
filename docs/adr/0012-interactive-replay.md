# ADR 0012: Interactive Replay (agent-in-the-loop repair, resolution disclosure, retiring silent `--update` healing, and agent-supervised re-record repair)

## Status

Accepted (2026-07-10); partially implemented (last updated 2026-07-13). See [Migration progress](#migration-progress) for the per-step landing record.

**Implemented and merged to `main`:**

- Decisions 1-5 and their migration steps 1-7 — resolution disclosure (#1193), structured divergence
  transport (#1197), `.ad` target annotations and target-binding verification (#1196, #1209), `replay
  --from`/`--plan-digest` resume and `--update` retirement (#1211), and the selector-miss →
  `REPLAY_DIVERGENCE` repair-loop fix (#1223).
- Decision 6, the base agent-supervised re-record repair — `replay --save-script` arming, the
  post-watermark healed slice, `repairHint`, and the writer's bare-`@ref` fail-loud guard (#1228).
- Decision 4 amendment, `screen`'s capture scope and ref selection — the divergence `screen` capture runs
  through the same `captureSnapshot` wrapper as plain `snapshot` (full-window scope + Android freshness /
  post-action retry parity) under a clean, fixed capture-flags policy (a failed raw/scoped/`-d` action can
  no longer narrow the diagnostic tree), with the chrome and meaningful-target filters layered on top as
  filters, not scopings; and `screen.refs` is ranked within the byte cap (foreign-window dismiss targets
  ahead of app content; mass-covered app nodes surfaced rather than emptied) instead of sliced in document
  order, so a captured overlay is never buried past the cap (#1264).
- Decision 3 amendment, id demotion under non-unique capture-time match — a recorded id no longer serves
  as identity, or leads the selector chain, unless it is unique in the record-time tree; a non-unique id
  (a shared Android framework resource id such as `android:id/title`, or a reused RN `FlatList` `testID`)
  falls back to role+label in both `computeTargetEvidence`'s `target-v1` tuple and
  `buildSelectorChainForNode`'s chain (#1269).

**Accepted but NOT yet implemented** (this amendment; tracked by #1235 — repair-transaction lifecycle):
the R7 repair-transaction keep-alive and its distinct `resume.repairSessionHeld` signal, the ARMED →
COMPLETE → COMMITTED commit state machine, terminal-source-`close` skipping, the `REPAIR_SESSION_EXPIRED`
tombstone, and race-safe atomic publication. Until #1235 lands, `--save-script` on a diverging replay
does not carry the lifetime, abort-on-incomplete, or atomic-commit guarantees R7 specifies.

## Context (historical baseline)

This section records the repository state audited on 2026-07-10, before the migration steps recorded
below shipped. Its present-tense observations are historical evidence;
[Migration progress](#migration-progress) is the authoritative record of current behavior.

At acceptance, replay was deterministic. `.ad` scripts were plain text — one action per line, `#`
comments, and a `context platform=... device=... theme=...` header (`src/replay/script.ts`) — recorded
via `open --save-script` (`src/daemon/session-action-recorder.ts`,
`src/daemon/session-script-writer.ts`) or hand-written, and executed step-by-step by
`runReplayScriptFile`
(`src/daemon/handlers/session-replay-runtime.ts`) under the daemon's `replay`/`test` commands
(`src/daemon/handlers/session-replay.ts`). Recorded touch/fill/get targets are selector chains with
`||` alternates (`buildSelectorChainForNode(...).join(' || ')`,
`src/commands/interaction/runtime/resolution.ts:242`, mirrored in
`src/daemon/handlers/session-replay-heal.ts:131-135`); Maestro YAML flows import through `--maestro`
(`src/compat/maestro/`); progress is step-indexed (`stepIndex`/`stepTotal` in
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

> **Amendment (#1269).** An id may serve as identity (and lead the selector chain) only when it uniquely
> denotes the target in the record-time tree: the writer computes the id's own capture-time match count
> (independent of ancestry) and, whenever more than one node in the record-time tree carries the recorded
> id, demotes it — falling back to role+label exactly as an unrecorded id already does. A shared
> Android framework resource id (`android:id/title`, present on every titled list row) is the measured
> case, but the rule is capture-time uniqueness, not an `android:id/*` namespace heuristic: a reused RN
> `FlatList` `testID` hits the same demotion on iOS.

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
`action`, `cause`, `screen`, `suggestions`, `resume`, `repairHint`, and, for binding failures,
`targetBinding` (`classification`, `matchCount`, `recorded`, `observed`, `mismatches`, `candidates`).
`kind` is one of
`action-failure`, `selector-miss`, `identity-mismatch`, or `identity-unverifiable` — the latter three are
decision 3's target-binding classes, and `targetBinding.classification` always equals the top-level
`kind`. `targetBinding.matchCount` follows decision 3's presence rule exactly: present (0..N) for
`selector-miss`, `identity-mismatch`, and an `identity-unverifiable` reached through resolution (path 6);
absent — key omitted, never `null` — when `identity-unverifiable` arose from a recorded-unverifiable
annotation (path 1), which fires before any resolution.
`step.index` is the 1-based executable-plan ordinal, not a source
line. Its source location is diagnostic only. A Maestro parser must preserve the original file and line
through includes so that source location is actionable.

`repairHint` is a **single bounded enum value** — exactly one of `record-and-heal`, `state-repair`,
`caution`, or `manual` (never a list; a fixed, closed set), present on every divergence. The daemon
computes it (decision 6, R3) and it is always defined for every divergence — defaulting to `manual` when
no safer routing can be proven — so a consuming caller never sees it absent or null. It is a small fixed
token that costs no meaningful bytes, so it is carried at every response level, including compact
(`--level digest`), and must survive all four projections intact — daemon text summary, JSON, Node
client `AppError`, and MCP `structuredContent`. Decision 6 defines its computation and meaning; this
contract only guarantees it is transported.

`screen` is discriminated. `{ state: "available", refsGeneration, refs, truncated }` is a fresh,
healthy snapshot digest and the only form that issues actionable refs. `{ state: "unavailable", reason,
hint }` is returned when capture fails or is sparse; it has no refs or generation and must not fall back to
the old session tree. Screen-capture failure never replaces or masks the original replay cause.

> **Amendment (#1264): `screen`'s capture scope and ref selection.** `refs` is a filtered, ranked digest
> of the exact same tree a plain `snapshot` would return at that moment. Two guarantees back the invariant:
>
> 1. **Capture scope.** The capture underneath `screen` runs through the **same `captureSnapshot` wrapper**
>    the plain `snapshot` command's backend calls — not a parallel single-shot dispatch — so it inherits
>    `snapshot`'s full-window scope (Android: the snapshot-helper route, with the existing graceful
>    app-scoped fallback only when the helper is unavailable; iOS: the bounded system-modal probe path;
>    macOS/Linux: their surface-scoped branches) AND its Android freshness / post-action retry policy. A
>    divergence must not consume a first stale or app-scoped dump while a plain `snapshot` retries to the
>    fresh full-window tree — that would make the divergence staler or narrower than `snapshot`, violating
>    the invariant. The divergence capture's flags are a **clean, fixed policy** (full-window, non-raw,
>    default depth), NOT the failed action's flags: a failed `snapshot --raw`/scoped/`-d` action must never
>    narrow or reshape the diagnostic tree below what a plain `snapshot` shows, so `snapshotRaw` /
>    `snapshotScope` / `snapshotDepth` are dropped; only the interactive-only policy (full for non-rect
>    `get`/`is`/`wait` reads, interactive otherwise) is carried. The chrome filter (#1233/#1256,
>    `collectSettleChromeRefs`) and the meaningful-target filter (label/id or `hittable`) are layered ON TOP
>    of that full capture as **filters**, not as a separate, narrower scoping — a filter may drop a node the
>    full capture contains, but the capture itself must never omit content `snapshot` would show.
> 2. **Ref selection within the cap.** The `screen.refs` cap is a **byte bound**, not a "first N in document
>    order" policy. A separate-window overlay enumerates AFTER the app window's nodes, so a document-order
>    slice truncates a fully-captured overlay away (its dismiss target sits past the cap) — reporting a
>    healthy-looking app even though the capture holds the covering window. So `refs` is RANKED before it is
>    capped: foreign-window (non-app-`bundleId`) hittable nodes — the dismiss targets for whatever covers
>    the app — are promoted ahead of app content, with document order otherwise preserved (stable within
>    each tier). And when a system overlay MASS-COVERS the app so every app node is annotated `covered`,
>    those covered nodes are surfaced rather than emitting an empty `refs`: a report whose capture holds
>    meaningful nodes but whose `refs` is empty is broken by construction.
>
> This is a hard invariant: **an agent must never see a healthier `screen` in a divergence report than a
> plain `snapshot` would show it.** Concretely, a separate-window system overlay covering the app at the
> moment of capture — a held volume dialog, a persistent quick-settings shade, a permission dialog — must
> appear in `screen.refs` (its actionable/hittable/labeled nodes surviving the filters AND the cap) exactly
> as `snapshot` would present it. `repairHint` (decision 6) and `suggestions` (decision 1) consume the FULL
> captured node list, not the capped `refs` slice, so hint routing is computed over the same full,
> correctly-scoped capture and is never routed as if the app underneath a covering overlay were healthy.

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

> **ADR 0014 amendment (accepted, implemented):** replay divergence `screen.refs` is now a partial ref
> publication — it activates a bounded partial ref frame authorizing exactly the divergence screen's refs
> (`markSessionPartialRefsIssued`). MCP auto-pins those refs; CLI text renders `@eN~s<refsGeneration>`;
> JSON and Node.js callers pair each plain ref with the response-level generation before mutation. Because
> the frame is partial, a mutation through a divergence ref requires the pinned form; a plain ref there
> reports `plain_ref_requires_complete_frame`.

`--from N` is a `replay`-only flag. `test` must reject it as `INVALID_ARGS`; test shares replay execution
but must remain a full, deterministic suite run. `N` is a 1-based index into the fully expanded
executable plan and must be in range. It is never a YAML line number, fractional source-step number, or a
repeat iteration label. Static includes, platform conditions, and fixed-count repeats expand before
indexing, so repeated source lines are distinguished by their plan index.

Every divergence includes `resume: { allowed, from, reason?, planDigest, alternateFrom?, repairSessionHeld? }`.
`from` is not merely the failed step's ordinal — it is the ordinal the caller should actually pass to
`--from`, computed from the same `repairHint` carried alongside it (decision 6, R2/R3): for `record-and-heal`,
`from` is the failed step's index **+ 1** (the agent performs that step manually before resuming, so
resuming AT it would re-diverge on the exact step just completed); for every other hint (`state-repair`,
`caution`, `manual`), `from` equals the failed step's index unchanged. For the SINGLE-path hints
(`record-and-heal`, `state-repair`) `from` is the whole continuation, and a JSON/MCP-first caller that
blindly resumes at `resume.from` reads the identical command the text guidance renders — never a stale `from`
that loops the caller back onto the step it just repaired. The DUAL-path hints (`caution`, `manual`) are the
exception: `from` (`N`) carries only their app-state-fix continuation, and a second ordinal — the optional
`alternateFrom` (`N + 1`, below) — carries the record-and-heal-shaped alternate, so the structured caller
reads BOTH fields to match the text guidance rather than `resume.from` alone.

`alternateFrom` is an **additive optional** ordinal (#1262) that makes the `caution`/`manual` dual-path
structured-caller-legible, not text-only. Those two hints have TWO legitimate repairs the daemon cannot
disambiguate at divergence time: an app-state fix (`--no-record`, then re-run the unchanged step at `from` =
`N`), and a record-and-heal-shaped correction (perform the diverged step's intent as a recorded action, then
resume PAST it at `N + 1`). `from` carries the first; `alternateFrom` carries the second (`N + 1`), present
**only when a `--from N + 1` request for this divergence would actually be accepted** — the daemon computes
it as `evaluateReplayResumePreflight({ from: N + 1, actions }).allowed`, which additionally requires the
diverged step `N` itself to be skip-safe (so it is absent when `N` is a `runScript` outputEnv producer or
sits inside runtime control flow, where `--from N + 1` would be refused). Because that preflight's checked
range is a strict superset of `from`'s, `alternateFrom` present implies `allowed: true` — it never
contradicts the primary. Absent for `record-and-heal` (its `from` already IS the `N + 1` continuation) and
`state-repair` (no recorded-action alternate). The `repairHint` text guidance renders the `N + 1` command
**iff `alternateFrom` is present**, never re-deriving resumability client-side, so the text surface and the
structured wire advertise the identical next command — closing both the text-vs-structured disagreement a
client-side re-derivation would reintroduce and the parity gap where a structured caller saw only `from`.

If the resume ordinal equals `actions.length + 1` (the diverged step was the plan's LAST step), that is a
legal EMPTY-TAIL resume, not an error: there is nothing left to replay, so the resumed run executes zero
device actions and falls straight through to the normal end-of-plan completion path, correctly flipping an
armed repair transaction COMPLETE (decision 6, R7's `close` commit gate). Rejecting this ordinal outright
would force the agent to `close` an INCOMPLETE transaction instead, which aborts and discards the corrective
action it just recorded. This one-past-the-end ordinal is authorized ONLY for the EXACT session and target
that produced it — the daemon stamps a per-session watermark (`expectedFrom`, the recorded action count at
divergence time) when a `record-and-heal` divergence reports `allowed: true` (its own `from` is already
`N + 1`), and — per #1262 — also for a `caution`/`manual` LAST-step divergence whose `alternateFrom` (`N + 1`)
is preflight-safe (their `from` stays `N`, so the watermark tracks the alternate's `N + 1` empty-tail
ordinal). Because the watermark can only be stamped on a live session, an empty-tail `alternateFrom` is
withheld entirely when no session exists (a one-step `open` failure, or a session closed mid-replay) —
otherwise the daemon would advertise a `--from N + 1` it must then reject. A later `--from` request is
accepted at `actions.length + 1` only when it matches that watermark AND the session's action count has
grown since (proof the corrective press was actually recorded) — never a blanket "one past the end is fine"
for any session or repair kind, which would let an unrelated or blind resume silently skip the plan's
unresolved final step and commit an incomplete repair. The same watermark match, independent of whether the
resume ordinal lands one past the end or still inside the plan, also gates every OTHER `record-and-heal`
continuation: resuming at the reported `from` with the action count unchanged is rejected as proof the
corrective press never happened, rather than silently resuming past the unrepaired step.
`planDigest` is SHA-256 over
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

`allowed` conveys **plan-resumability only** — whether ordinal `from` can be safely resumed against a
matching plan — and is emitted for EVERY divergence; it says nothing about whether a session is still
alive to resume against. Session lifetime is a **distinct** signal: `repairSessionHeld: true` is set on
any divergence whose session carries an **active repair transaction** — one opened by a `--save-script`
replay and **persisted on the session** until commit/abort (decision 6, R7). It therefore keys off the
persisted transaction state, not the current request's flags, so a `--from` continuation that does NOT
repeat `--save-script` still reports `repairSessionHeld: true`. Only that flag promises the diverging
daemon/session is being kept live and addressable for the in-flight repair. Decision 6's R7 keys its
lifetime guarantee off `repairSessionHeld`, never off `allowed` — a plain (non-armed) replay may report
`allowed: true` for plan-resumability yet tear its session down normally, so a consumer must not read
`allowed: true` as "the session is still there."

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
(`src/daemon/session-action-recorder.ts:37`, unconditional push), and the divergence refusal is
pre-dispatch (target verification refuses before the device action, decision 3), so a divergent step is
never pushed. Across a repair session: original steps that verified and dispatched land in
`session.actions`; the divergent step is absent (refused pre-dispatch, never recorded); the agent's
corrective interactive action(s) land in `session.actions` with fresh `target-v1` evidence, because
recording is armed and armed recording also disables the direct-iOS fast path (PR #1196) so evidence is
computable. `formatSessionScript` over `session.actions` from the repair-run boundary (R6 — the slice
recorded during this repair, not the whole session history) is therefore the healed script: the path that
actually worked. The only net-new code is flag-threading plus one writer entry point (see Migration
plan).

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
  (`src/daemon/handlers/interaction-common.ts:64-65` attaches evidence only when `recordSession` was
  true when the step ran).
- **R2 — `--from` continuation only; never re-run the full replay on the same session.** After a
  divergence at step N and the corrective action, the agent must continue with `replay --from k
  --plan-digest <original>`, not a fresh full `replay`. A full re-replay on the same session re-appends
  the already-recorded prefix `1..N-1` to `session.actions` — duplication, because
  `session-action-recorder.ts:37` pushes unconditionally and replay dispatch does not inject `noRecord`.
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
  (`src/daemon/handlers/interaction-touch-targets.ts`), which `buildOptimizedActions`
  (`src/daemon/session-script-writer.ts:69-83`) rewrites to a selector line. If no `selectorChain` was
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
  `session.recordSession = true` (mirroring `session-close.ts:122-124`'s existing `saveScript` handling)
  **and** records the repair-run boundary watermark `session.actions.length` (R6). Absent this flag,
  replay behaves exactly as today: no recording, no heal. The heal is opt-in, preserving decision 1's "no
  silent rewrite."
- The healed `.ad` is published when a teardown commits the transaction at state `COMPLETE` — normally the
  agent's own `close`/`close --save-script <out>`, but any teardown of a completed transaction commits
  (see the commit state machine below) — reusing the existing `session.actions` serializer
  (`SessionScriptWriter.write`, `src/daemon/session-script-writer.ts:30-52`) over the post-watermark slice
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
(`src/daemon/session-script-writer.ts`) is the single publish primitive `SessionScriptWriter.write` calls
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
8. **Agent-supervised re-record repair, base** (decision 6, R1-R6) — **MERGED (#1228)**; depends on 2
   and 5 (the repair loop is built entirely on the existing divergence report and `--from`/`--plan-digest`
   resume machinery) and on 3/4 (corrective actions record fresh `target-v1` evidence, so the healed
   script is self-consistent). Prerequisite: the selector-miss → `REPLAY_DIVERGENCE` defensive fix
   (PR #1223) — a thrown per-action selector-miss must route through the same divergence-wrapping path as
   a returned failure, or the repair loop never sees a divergence report to act on. Delivered: the
   daemon-side `repairHint` computation over all four `kind`s (R3), `--save-script` arming plus the
   repair-run boundary watermark on `replay` (R1/R6), the writer's post-watermark slice and bare-`@ref`
   fail-loud guard (R4/R6) — reusing `close --save-script`'s existing `session.actions` serializer.
9. **Repair-transaction lifecycle** (decision 6, R7 + commit state machine) — **NOT YET IMPLEMENTED,
   tracked by #1235**; depends on 8. Adds: the distinct `resume.repairSessionHeld` divergence signal and
   R7 keep-alive keyed off the session's **persisted** repair-transaction state (so `--from` continuations
   need no repeat of `--save-script`), with `fail-fast-before-step-1` when keep-alive is impossible; the
   `ARMED → COMPLETE → COMMITTED` commit state machine where **any teardown** (explicit `close`,
   idle-reap, or daemon shutdown) commits atomically when `COMPLETE`, aborts (no prefix) when not, and is
   idempotent once `COMMITTED`; terminal-source-`close` **skipping** during an armed replay/resume, with a
   regression proving the session is NOT deleted when the terminal `close` is reached; the
   `REPAIR_SESSION_EXPIRED` tombstone for an incomplete-transaction reap/shutdown (keyed by session key,
   owner + bounded expiry, cleared by a fresh `replay --save-script`); and race-safe atomic publication
   (temp file in the target's own directory, published via a single exclusive `linkSync` that refuses ANY
   pre-existing target — complete or partial, default or explicit path alike, and uniformly for an
   ordinary non-repair recording's target too, since the publish primitive is shared — never overwriting
   one; see "Scope" under Decision 6 above).

## Migration progress

Landing record for the plan above (main as of 2026-07-13). This section tracks progress only; it does
not restate or amend the decisions.

| Step | Decision | Status | Landed in |
| --- | --- | --- | --- |
| 1. Resolution disclosure | 2 | Shipped | #1193 |
| 2. Structured divergence transport | 4 (report) | Shipped | #1197 |
| 3. `.ad` target annotations, inert | 3 (parser/writer) | Shipped | #1196 |
| 4. Target-binding verification | 3 (enforcement) | Shipped | #1209 |
| 5. `replay --from` + `--plan-digest` resume | 4 (resume) | Shipped | #1211 |
| 6. `--update` retirement | 1 | Shipped | #1211 |
| 7. Benchmark extension | 5 | Deferred | — |
| 8. Agent-supervised re-record repair, base | 6 (R1-R6) | Shipped | #1228 |
| 9. Repair-transaction lifecycle | 6 (R7) | Not yet | #1235 |

Step 4 (#1209) added the `selector-miss`/`identity-mismatch`/`identity-unverifiable` divergence kinds
and a post-resolution target guard that cross-checks the dispatched winner against the verified member.
Issue #1221 ("Complete ADR 0012 replay target-binding verification") was closed as already implemented:
its verification scope is covered by step 4. Step 7 remains deferred. Step 8 implements the repair
design accepted in #1226 and shipped in #1228; step 9 (R7 + commit machine) remains unimplemented,
tracked by #1235.
