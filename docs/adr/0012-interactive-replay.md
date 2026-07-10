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
- **(c) No outcome verification exists anywhere in this path.** `--verify`
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

### 2. Disclose disambiguation in every interaction response, live and replay

When a selector's resolution matched N>1 candidates and a heuristic (not a unique match) chose the
winner, the response — press/click/fill/longpress, live or replayed — carries the match count, the
chosen node's ref, the tiebreak reason (visible / deepest / smallest-area), and a capped list of the
other candidates' refs. This follows the #1040 precedent exactly (disclose, don't change resolution) and
slots into the single existing response-construction site (`buildInteractionResponseData`, ADR 0011
Layer 2, `src/daemon/handlers/interaction-touch-response.ts`) so it cannot be dropped by a hand-rolled
branch the way `evidence` once was (#1064). It is **not** a behavior change to
`resolveSelectorChain`/`accumulateDisambiguationCandidate` — same heuristic, same winner, same policy
already documented in `help workflow`. Only the caller's visibility into the decision changes.

### 3. Record-time identity verification for replay

`open --save-script` recording captures the winning node's identity evidence (id/role/label/rect) for
each step, not just the label hint `refLabel` already carries. At replay time, when disambiguation
(decision 2) selects a node, its identity is compared against the recorded evidence for that step. A
mismatch is a **divergence** — reported exactly like a hard failure (decision 4) — not a silent success,
even though the command itself "succeeded" (tapped something, got a result back). This is outcome
verification via recorded ground truth, and it is what actually catches the "Prevent Remove" class of
bug: the command doesn't error, so nothing else would flag it.

### 4. Interactive replay loop

**(a)** One new flag, `replay --from <step>` — a range selector on an existing script, not a new
mode or command. `--from` starts execution at step N and never re-runs steps `1..N-1`.

**(b)** On step failure — a hard failure OR a decision-3 identity divergence — the response, for ALL
callers (no agent-only mode), becomes a structured divergence report:

- **step provenance: step index AND the source file + line of the failing step.** For `.ad` this is
  mostly plumbing: `actionLines` is already tracked per step (`runReplayScriptFile`,
  `session-replay-runtime.ts:98-131`) and already reaches the ndjson trace, but
  `withReplayFailureContext` (`session-replay-runtime.ts:349-369`) currently renders only
  `replayPath` + `step` — the line must be added to the report. For Maestro this is a requirement on
  the parse: as the live evidence shows, includes and conditionals flatten into the linear `actions[]`
  at parse time, so a failing step's index is meaningless against the YAML the caller is editing.
  The Maestro parse must carry per-step source positions (file + line) through `runFlow` inlining —
  today `convertRootCommands` (`replay-flow.ts:76-83`) assigns the parent entry's line to every
  expanded action and `parseRunFlowFile`'s callers (`flow-control.ts:41,124`) discard the included
  file's path and line table. Without this, `--from` is unusable on Maestro flows. Index determinism
  makes this sufficient: platform/`true` `when` blocks and includes flatten at parse time
  (`flow-control.ts:47-48`), `repeat.times` expands deterministically (`flow-control.ts:84-87`), and
  visible/notVisible `when` becomes a single runtime control step (`wrapRunFlowCondition`,
  `flow-control.ts:411-430`), so step indices are stable per platform and `--from N` re-targets the
  same step the report named. Optionally, a `replay --list-steps` dry-run prints the flattened plan
  with per-step provenance so a caller can map indices to source before running anything;
- the failing command and its error;
- current screen evidence with actionable refs. Minted refs must be blessed into the session the same
  way settle refs are: `replay`/`test` are today in neither `REF_ISSUING_TOOLS` nor
  `SETTLE_REF_ISSUING_TOOLS` (`src/mcp/command-tools.ts:114,125-129`), so any ref a failure response
  handed back today would pass through unpinned at the MCP layer and fall to the coarse
  `STALE_SNAPSHOT_REFS_WARNING` floor at best (`src/daemon/session-snapshot.ts:11-12,104-116`). The
  divergence report must instead be an issuing response — carrying a `refsGeneration` the way
  `settle.refsGeneration` does (`interaction-touch-response.ts:64-73,131-140`) and consumed by the same
  merge-only pin bookkeeping settle uses (`mergeIssuedRefPins`/`mergeSettleIssuedRefPins`,
  `src/mcp/command-tools.ts:167-217`) — so the agent's very next command can use a ref this report just
  handed it at full precision, not the coarse warning floor;
- ranked selector suggestions from decision 1's retired heal machinery;
- when decision 3 applies, the recorded-vs-observed identity mismatch.

**(c)** The loop protocol — run, read the report, then either fix reality and `--from N`, or perform the
step manually and `--from N+1`, or edit the plain-text `.ad` file and `--from N` — is documented as a
help topic (`agent-device help ...`, alongside the existing disambiguation-policy paragraph in
`src/cli/parser/cli-help.ts`). Loop until exit 0. There is no agent-mode flag: deterministic/CI callers
get the same richer failure output as an interactive agent — they simply don't act on the suggestions,
the same way they already ignore `hint` strings today.

**(d)** The success path stops being silent for text callers: a successful replay prints a one-line
summary (replayed N, wall time). Today text mode emits nothing on success (see the live evidence in
Context — the success payload has no `message`, so the generic renderer prints zero bytes), which
costs an agent a verification turn just to confirm the run happened. One line closes that for free;
`--json` output is unchanged.

### 5. Validation

Extend the settle benchmark (`~/.agent-device-bench/rnnav-matrix.py` pattern, external harness) with a
replay arm: author a script from one session, then measure (i) clean-replay cost — should be 0 model
turns, matching the O(divergences) claim — and (ii) induced-divergence repair cost — break one selector
deliberately, measure agent turns to green through the `--from` loop.

## Consequences

- `--from` resumability makes app-state **preconditions the caller's responsibility**. The daemon has
  no way to know the app is actually in the state step N expects; the divergence report hands over
  current screen evidence specifically so the caller can check that before resuming, but nothing
  enforces it. The live nav-state-persistence divergence in Context is the canonical case: the app,
  not the script, decides what screen a relaunch lands on.
- **Non-idempotent scripts are exactly why `--from` must never re-run steps `1..N-1`**: a script that
  creates a record, navigates, then asserts on it would double-create on any re-run of its early steps.
  This is a hard constraint on the flag's semantics, not an implementation nicety.
- **Retiring heal-as-actor removes CI self-repair for agentless callers.** A nightly `test --update` run
  that used to silently patch a renamed selector and go green now stays red with a suggestion in the
  divergence report nobody reads. This is a real regression for that use case, accepted because the
  audit found heal rarely able to act anyway (rename is exactly the case it cannot rescue), and a
  silently patched selector was already a correctness risk of the kind decision 3 closes — "recorded and
  current selector agree" is not the same claim as "they agree on the right element."
- **Disclosure adds bytes to every response where resolution was ambiguous.** A capped candidate list
  keeps this bounded, but it is a token-cost increase on exactly the interactions that were already
  hardest to get right, not a free win.
- **Recorded identity evidence adds bytes to every `.ad` file**, proportional to steps that target
  selectors (ref-only steps already carry `refLabel` at similar cost today). `.ad` stays plain text;
  this is per-line growth, not a format change.
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
- **Keep `--update` auto-heal, add outcome verification to it**: rejected for now — decision 3's
  recorded-identity check subsumes what a verified auto-heal would buy (a heal that knows it healed
  correctly) more simply, without heal's own retry-and-rewrite complexity. Revisit if the agentless-CI
  regression noted in Consequences proves costlier than expected.
- **Auto-heal tiers** (safe-tier heals applied automatically, risky-tier surfaced): deferred, not
  rejected outright — there is no current evidence base for which heals are "safe," and tiering now
  would be speculative. Revisit if agentless CI demand for some self-repair materializes.

## Migration plan

Each step lands independently useful, in order:

1. **Resolution disclosure** (decision 2) — additive fields on the existing single response-construction
   site, no flag, no format change, immediately useful for live commands.
2. **`.ad` recorded identity evidence** (decision 3, recording side only) — the format change and the
   replay-side comparison land separately so each is independently reviewable; recorded evidence stays
   inert (captured but unchecked) until step 3.
3. **`replay --from` + the structured divergence report** (decision 4) — the report is what `--from`
   resumes from, so they land together; wires in decision 3's comparison and decision 1's
   retired-heal suggestions at the same time. Step provenance (the `.ad` line in the report and
   Maestro per-step source positions) is part of this step, not an optional follow-up — without it
   `--from` is unusable on Maestro flows. The one-line success summary (decision 4d) can land any
   time, independently.
4. **`--update` retirement** (decision 1, the removal of its rewrite path) — lands once step 3's
   suggestions are a proven substitute, not before, so there is no gap where healing regresses with
   nothing in its place.
5. **Benchmark extension** (decision 5) validates 1–4 against the O(divergences) claim before this
   ADR's economics are treated as proven rather than designed-for.
