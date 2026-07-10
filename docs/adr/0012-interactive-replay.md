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
`src/cli/parser/cli-flags.ts:1041-1047`). It only fires after a step has already returned a hard
failure (`session-replay-runtime.ts:118-149`: `if (!shouldUpdate) return failure; ...
healReplayAction(...)`), and it only retries the SAME recorded selector material —
`collectReplaySelectorCandidates` (`session-replay-heal.ts:39-81`) gathers the step's originally
recorded `selectorChain`/positionals, then `resolveSelectorChain` re-resolves those exact candidate
strings against a freshly captured snapshot (`session-replay-heal.ts:122-135`). If the identifying term
itself changed — an id or label rename — the same string will not match the new tree either, so heal
cannot rescue renames; it can only recover drift the ORIGINAL selector still matches (a moved or
re-rendered node with the same id). PR #297 (closing #279) already trimmed heal once, removing
`refLabel`-synthesis and numeric `get text` drift healing to keep it "centered on recorded selectors and
explicit selector expressions" — heal has a maintained history of narrowing, not growing.

**Benchmark evidence** (2026-07-09/10, `~/.agent-device-bench/rnnav-matrix.py`, external harness): the
`--settle` quiet-window loop is now at its 1-snapshot floor, so wall time for a QA flow is dominated by
model turn latency, not device I/O. A happy-path agent-driven QA flow costs O(steps) model turns
end-to-end; a deterministic replay of the same flow costs O(divergences). The entire economic case for
replay is collapsing the per-step model-turn cost toward zero on the happy path and paying only where
reality diverged from the recording.

**Audit evidence** (2026-07-10) on where that divergence cost actually goes:

- **(a) Heal is narrow and mostly unable to act.** Per the mechanism above, heal only recovers
  same-selector drift. Most real replay failures are renames or removals heal's candidate-recycling
  cannot reach.
- **(b) The real mis-binding surface is not heal — it is silent disambiguation in ORDINARY resolution**,
  live and replay alike. `resolveSelectorInteractionTarget` calls `resolveSelectorChain(..., {
  disambiguateAmbiguous: true })` on every press/click/fill (`resolution.ts:170-183`); when a selector
  matches N>1 nodes, `accumulateDisambiguationCandidate`/`compareDisambiguationCandidates`
  (`src/daemon/selectors-resolve.ts:153-204`) silently pick a winner — visible candidates over
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
  (`selectorFailureHint`, `src/daemon/selectors-resolve.ts:84-97`, thrown at `resolution.ts:199-203`);
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
re-resolution it drives — are repurposed to populate a ranked list of selector suggestions inside the
divergence report (decision 4), not to act unattended. With an agent in the loop, adjudicating a heal
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

The accepted direct-iOS selector fast path has no daemon tree and the XCTest response cannot truthfully
provide a match count, candidate refs, or a runtime tiebreak. It remains enabled for ordinary simple
`press`/`fill`, but its canonical response instead carries
`resolution: { source: "direct-ios", kind: "not-observed" }`. It must never fabricate a unique-match or
identity claim. `--verify` and `--settle` continue to disable this fast path and therefore produce a
runtime resolution. Recording likewise disables it for any action for which target-binding evidence is
required by decision 3.

ADR 0011's matrix must add a `resolutionDisclosure` guarantee with all six honest cells: `runtime-selector`
enforces the complete pre-action diagnostic shape; `runtime-ref` and `native-ref` enforce
`{ source: "ref", phase: "pre-action", kind: "exact" }`; `direct-ios-selector` enforces only the explicit
`{ source: "direct-ios", kind: "not-observed" }` shape; `coordinate` is inapplicable because no element
was resolved; and `maestro-non-hittable-fallback` is inapplicable because Maestro owns matching and the
fallback is coordinate execution. The four enforced cells use the shared response builder. Its existing
direct-path `disambiguation` and `responseIdentity` waivers remain, and the exact waived-cell test must
continue to list them. Layer-3 coverage must claim every enforced/delegated cell: runtime
ambiguity/tiebreak/cap plus non-actionable diagnostics after mutation, exact-ref provenance for runtime
and native refs, and a direct-iOS no-snapshot `not-observed` case. No selection-parity table is claimed or
added for the direct path: such a table would falsely imply XCTest selection has runtime parity. A future
runner-side diagnostic design must replace the two waivers, add a Swift/TypeScript parity fixture, and add
the corresponding provider contract cases in the same change.

### 3. Versioned `.ad` target-binding evidence

Recording writes evidence for every action that resolves an element target. The plain-text format is a
versioned comment immediately before the action it annotates:

```text
# agent-device:target-v1 {"id":"save","role":"button","label":"Save","rect":{"x":12,"y":48,"width":80,"height":44},"ancestry":[{"role":"window"},{"role":"toolbar","id":"editor"}],"sibling":0,"verification":"verified"}
click @e12 "Save"
```

The prefix is ASCII and the payload is one JSON object encoded on one line. JSON supplies all quoting and
escaping; writers must use canonical `JSON.stringify` field order `id`, `role`, `label`, `rect`,
`ancestry`, `sibling`, `verification`, `matchCount` and rect order `x`, `y`, `width`, `height`. `id`,
`role`, and `label` are optional non-empty strings; `rect` is an optional object of four finite numbers.
`verification` is `"verified"` or `"unverifiable"`; `matchCount` is required only for the latter. `role` is
`normalizeType(node.type ?? "")`, exactly the normalized type used by `buildSelectorChainForNode`; it is
never the raw optional `node.role`. `ancestry` is up to eight root-to-parent entries of the same normalized
`role` plus optional id/label, derived through `parentIndex`; `sibling` is the zero-based ordinal among
siblings with the same local identity. The writer normalizes strings to Unicode NFC and omits missing or
empty fields. A v1 payload is at most **4 KiB** UTF-8; each string field is at most **256 bytes** after
normalization; `ancestry` has at most eight entries; and `matchCount`, when present, is a positive safe
integer. The parser rejects a v1 annotation exceeding these bounds with `INVALID_ARGS`.

The writer must test the tuple against the record-time tree. It writes `verification: "verified"` only
when exactly one node matches id/role/label/rect/ancestry/sibling. If zero or multiple nodes match, it
writes `verification: "unverifiable"` and `matchCount`; replay reports an
`identity-unverifiable` target-binding divergence before acting. At replay, the observed tree must also
produce exactly one tuple match. This closes the duplicate-label/identical-rect case even if the stronger
structural context is itself duplicated: ambiguity is a visible divergence, never a silent binding.

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

At replay, every annotated resolved target is checked before its action is sent. A field present in the
recording but absent in the observed node is a mismatch. `id` and normalized `role` compare exactly after
NFC; `label` compares after NFC plus trim and internal whitespace collapse; rects match when every
coordinate and dimension differs by at most **8** recorded coordinate units; ancestry and sibling compare
exactly after their component normalization. Every recorded field must match. An old unannotated action
remains executable without this check. Any mismatch is a
**target-binding divergence**, reported before the device action, even when resolution was unique; this
catches a unique-but-wrong rebind as well as a changed ambiguity winner. This is not general outcome
verification: `--verify` remains post-action change evidence with a different contract.

### 4. Divergence wire contract and replay-only resume

**Divergence is a structured error, not success data.** The daemon returns `ok:false` with code
`REPLAY_DIVERGENCE` and a `details.divergence` object for both an action failure and a target-binding
mismatch. The object has version `1` and contains `kind`, `step` (`index`, `source.path`, `source.line`),
`action`, `cause`, `screen`, `suggestions`, `resume`, and, for binding failures, `targetBinding`
(`recorded`, `observed`, `mismatches`). `step.index` is the 1-based executable-plan ordinal, not a source
line. Its source location is diagnostic only. A Maestro parser must preserve the original file and line
through includes so that source location is actionable.

`screen` is discriminated. `{ state: "available", refsGeneration, refs, truncated }` is a fresh,
healthy snapshot digest and the only form that issues actionable refs. `{ state: "unavailable", reason,
hint }` is returned when capture fails or is sparse; it has no refs or generation and must not fall back to
the old session tree. Screen-capture failure never replaces or masks the original replay cause.

Response levels bound the entire serialized UTF-8 `details.divergence` object, not merely its arrays:
compact (`--level digest`) is at most **8 KiB**, default at most **24 KiB**, and full at most **64 KiB**.
Compact carries at most **8** screen refs and no suggestions; default and full carry at most **20** screen
refs and **5** ranked suggestions. These counts are absolute, including error payloads. Individual
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
platform-conditioned expansion, and source provenance. A resume requires both `--from N` and
`--plan-digest <planDigest>` from the report. The daemon rebuilds the current plan and rejects
`INVALID_ARGS` before any action when its digest differs, so edits, include changes, or environment-driven
expansion cannot silently retarget ordinal N. `allowed: false` explains why no resume is safe; its digest
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
  the five-alternative limit, runtime/native exact-ref provenance, direct-iOS `not-observed`, coordinate
  and Maestro inapplicability, and the retained direct-path waiver list;
- an interaction mutation contract proving pre-action resolution diagnostics are not ref-issued or
  MCP-pinned, a fresh snapshot is required before using an alternative, and a no-action target-binding
  divergence can issue and pin its fresh report refs;
- parser/writer unit cases for v1 identity round trips, old/new reader compatibility, escaping,
  normalized-role source, ancestry/sibling structural context, duplicate/unverifiable record and replay
  evidence, rect tolerance, malformed annotations, and mismatch-before-action behavior;
- replay runtime tests for every annotated target, unique-but-wrong and duplicate-evidence divergences,
  compact/default/full field and byte ceilings, redaction, overflow artifacts and artifact-write failure,
  available versus sparse/capture-failed screen forms, and preservation of the original cause;
- replay resume tests for plan-digest emission and mismatch rejection after script/include/expansion
  changes, `resume.allowed` reasons, `--from` indexing, variable-output and control-flow rejection, and
  `test --from` rejection;
- daemon/client/CLI/MCP contracts proving the typed divergence survives failure, JSON and MCP structured
  output retain it, MCP pins only actionable error-path refs, and no text-only path drops the report; and
- `--update` retirement tests proving it never rewrites the source file and only returns bounded
  suggestions.

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

Each step lands independently useful, in order:

1. **Resolution disclosure** (decision 2) — update all six matrix cells, the exact waiver list, and
   provider mutation contracts together. It is additive to response data and does not claim direct-iOS
   selection parity or issue pre-action refs.
2. **`.ad` target annotations** (decision 3) — land bounded parser/writer round trips, compatibility,
   structural uniqueness, and duplicate detection before recording. Recording and pre-action
   target-binding verification then land together.
3. **Structured divergence + `replay --from`** (decision 4) — land bounded/redacted error propagation,
   actionable-or-unavailable screen semantics, error-path MCP pinning, plan digest validation, and
   conservative resume preflight together. `test` does not expose `--from`.
4. **`--update` retirement** (decision 1) — remove its write path only after divergence suggestions are
   available, with a no-write regression test.
5. **Benchmark extension** (decision 5) follows the mandatory contracts and measures the economic claim.
