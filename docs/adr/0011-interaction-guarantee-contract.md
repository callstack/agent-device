# ADR 0011: Interaction Guarantee Contract (path × guarantee matrix)

## Status

Accepted (implemented through Layer 3, 2026-07-04: #1080, #1082–#1086, #1091, #1092)

## Context

Interaction commands (`press`/`click`/`fill`/`longpress`, and by extension the
read/wait surfaces built on the same resolution machinery) reach the device
through several dispatch paths, each of which chose its latency-vs-semantics
trade-offs independently:

| Path | What it is | Why it exists |
| --- | --- | --- |
| `runtime-selector` | daemon tree capture → `resolveSelectorChain` → guards → coordinate tap | full semantics |
| `runtime-ref` | session snapshot → ref lookup → guards → coordinate tap | full semantics |
| `direct-ios-selector` | selector sent to the XCTest runner, which queries and taps natively | saves a full snapshot round trip |
| `native-ref` | `backend.tapTarget`/`fillTarget` for `click @ref` / `fill @ref` | saves resolution round trips |
| `coordinate` | raw x/y tap | escape hatch; semantics intentionally minimal |
| replay/maestro variants | `allowNonHittableCoordinateFallback`, replay-heal | third-party compat |

Over one week of fixes, every interaction bug we shipped or caught was the same
shape — a guarantee enforced on one path and silently absent on a sibling:

- off-screen refusal existed for `@ref` targets but not selector targets, and
  not in the runner's native tap (Bluesky closed drawer: `Tapped (-161, 265)`
  reported as success; fixed in #1075);
- `--verify` evidence attached on `press @ref` but was dropped by
  `fill @ref`'s hand-built response branch (#1064 review);
- adb failure classification enriched thrown errors but not
  `allowFailure`-result errors, and wrapped `exec` but not semantic provider
  methods (#1067 review);
- the user's wait budget bounded prepare/replay/snapshot request envelopes but
  not `wait` itself, and `wait` sat on the daemon-reset timeout path while
  `snapshot` — same failure mode — preserved the daemon (#1075).

The guarantees themselves are small and well-implemented. What is missing is
any structure that *knows the full set of paths and the full set of
guarantees* and can therefore notice an unfilled cell. Reviews catch cells
only when a reviewer happens to hold both axes in their head; dogfooding
catches them one production incident at a time.

## Decision

Make the path × guarantee matrix a first-class, machine-checked artifact, with
three enforcement layers. Types enforce **completeness** of declarations,
shared implementations prevent **drift**, and generated test coverage enforces
**truth**.

### Layer 1 — Declare: the matrix as a typed registry with a gate

Layer 1 is an **honesty/completeness gate, not a truth gate**: it proves that
every path has declared a stance on every guarantee and that the referenced
implementations exist. It does not prove the declared behavior — behavioral
parity only starts once the fixture tables (Layer 2) and contract scenarios
(Layer 3) land. Landing Layer 1 alone still changes the failure mode: an
unwatched cell becomes impossible; an unproven cell is at least a visible,
owned claim.

`src/contracts/interaction-guarantees.ts` declares both axes and requires
every cell to be classified:

```ts
export const INTERACTION_GUARANTEES = [
  'disambiguation',        // visible > deepest > smallest; ties fail
  'occlusion',             // covered targets are refused
  'offscreen',             // tap point (rect center) must lie in the root viewport
  'nonHittable',           // promotion + targetHittable/hint annotation
  'responseConstruction',  // one shared response construction site (Layer 2)
  'responseIdentity',      // refLabel/selectorChain availability on this path
  'verifyEvidence',        // --verify baseline + post-action digest
  'errorTaxonomy',         // no-match/ambiguous/offscreen codes, messages, hints
] as const;
```

Cells may be **command-scoped** via `appliesTo` when a guarantee only exists
for a subset of the path's commands — e.g. `verifyEvidence` applies to
`press`/`click`/`fill` but not `longpress`, and claiming it path-wide would
overstate coverage. The gate rejects `appliesTo` entries naming commands the
path does not dispatch, and rejects redundant full-coverage lists.

`responseConstruction` and `responseIdentity` are deliberately separate: "use
one shared construction site" and "which identity fields this path can
provide" have different closure strategies (the former is a single Layer-2
refactor; the latter is per-path capability work). `errorTaxonomy` is expected
to split the same way later — stable codes/fallback classification vs rich
selector diagnostics and hints — because direct runner paths can close codes
long before full diagnostics.

```ts

export type GuaranteeEnforcement =
  | { kind: 'runtime'; via: string }                    // shared TS implementation (symbol name)
  | { kind: 'runner'; via: string; parityTable?: string } // Swift twin; parityTable optional until Layer 3, required once the cell claims parity
  | { kind: 'delegated'; to: InteractionPathId }        // path defers (e.g. direct → runtime on ELEMENT_OFFSCREEN)
  | { kind: 'waived'; reason: string; trackingIssue?: string }; // explicit, reviewed waiver; gap waivers must carry a tracking issue

export const INTERACTION_DISPATCH_PATHS: Record<
  InteractionPathId,
  {
    description: string;
    commands: readonly string[];
    guarantees: Record<InteractionGuarantee, GuaranteeEnforcement>;
  }
> = { /* every path, every cell */ };
```

Because `guarantees` is a `Record` over the guarantee union, **tsc fails** the
moment someone adds a guarantee without classifying it for every path, or adds
a path without classifying every guarantee. A unit gate
(`interaction-guarantees.test.ts`) additionally checks that:

- every `via` string resolves to a real exported symbol (declarations cannot
  rot into fiction);
- every `parityTable` names an existing fixture file;
- every `waived` reason is non-empty, and every `gap:` waiver carries a
  `trackingIssue` — waivers must be owned, not merely visible. One umbrella
  tracking issue with sub-issues split off as work is scheduled is
  sufficient; the gate enforces the link, not the granularity.

This is the same "make the gap declare itself" pattern already proven in this
repo by `scripts/integration-progress-model.ts` (which caught the unclassified
`--verify` flag on #1064) and the cross-command apple-leak guard from the
platform consolidation (ADR 0009).

### Layer 2 — Share: one implementation per rule, on both sides of the wire

Each guarantee has exactly one home that all TS paths import (most already
exist after #1075: `isNodeVisibleOnScreen`, `accumulateDisambiguationCandidate`,
`isSnapshotNodeInteractionBlocked`, `describeResolvedNode`,
`interactionResultExtra`, `reconcileNonHittableHintWithEvidence`). The
registry's `via` fields point at them; fallow's duplication gate keeps
re-implementations from creeping back.

Rules that must run **runner-side** (the direct iOS path cannot see the daemon
tree) get pure-function Swift twins operating on plain geometry — no
`XCUIElement` — e.g. `TapPointPolicy.isAllowed(elementFrame:windowFrame:)`.
Parity is enforced by **golden fixture tables**: JSON files under
`contracts/fixtures/` consumed by three test suites —

1. vitest asserts the TS rule over the table;
2. the runner's Swift unit tests (already compiled in CI by "Swift Runner Unit
   Compile") assert the Swift twin over the same table;
3. the provider harness's fake runner derives its behavior from the same
   table, so integration scenarios exercise the real contract rather than a
   hand-written approximation.

Drift between TS and Swift then turns CI red on whichever side changed,
without needing a simulator.

For `responseFields`, one `buildInteractionResponseData(...)` becomes the only
construction site for interaction response payloads (this deletes the class of
bug where `fill @ref` rebuilt its response by hand and dropped `evidence`). A
small guard test — repo-precedented — fails if an interaction handler contains
a hand-rolled `responseData = {` literal.

### Layer 3 — Prove: a contract suite generated from the registry

`test/integration/interaction-contract/` holds table-driven scenarios: fixture
tree × command × forced path. The fixture trees are the real shapes that found
this week's bugs, kept permanently:

- closed drawer (all candidates off-screen) → `offscreen_selector`/`offscreen_ref`;
- drawer item + visible twin (ambiguous on/off-screen) → visible candidate wins;
- edge-grazing container (0.07 px viewport overlap, center off-screen) → still refused;
- covered node → occlusion refusal;
- non-hittable target ± `--verify` → hint present / suppressed by evidence;
- stripped-root tree (no Application/Window) → safe-default visibility.

Path forcing is explicit (`AGENT_DEVICE_FORCE_INTERACTION_PATH=runtime|direct|native-ref`,
test-only) so cases stay stable when path-selection heuristics change.

The gate closes the loop: it walks the Layer-1 registry and fails when any
non-waived cell has no contract case tagged for it. Coverage of the matrix is
therefore by construction, not by reviewer memory.

### Closing the gaps: a hybrid strategy, not one answer

The acknowledged gaps close by different mechanisms depending on what the
guarantee needs:

- **Runner-side parity for cheap geometry-local rules** (offscreen /
  tappable-frame on the direct iOS path). These are pure frame math, provable
  with golden tables, and keep the fast path fast.
- **Delegation-on-error for semantic and rich-runtime cases**
  (`ELEMENT_OFFSCREEN`, `AMBIGUOUS_MATCH`, `ELEMENT_NOT_FOUND`, non-hittable
  refusal): the fast path fails cheaply, and the runtime path supplies
  disambiguation and full diagnostics only when needed. **Delegation-on-error
  is not success-path parity**: it cannot catch the case where XCTest finds
  one hittable candidate that runtime rules would refuse or rank differently.
  Those cells stay `gap:` waivers until parity tables or contract scenarios
  prove the success path too.
- **A shared runtime preflight for the native-ref path**: the ref came from a
  daemon snapshot, so the node is already in hand — check offscreen /
  occlusion / non-hittable against it *before* calling
  `tapTarget`/`fillTarget`. A backend fast path can silently "succeed", so
  delegation-on-error would never trigger there.

### Timeout policy joins the descriptor registry

The `wait` timeout bug existed because request-envelope budgets and
on-timeout daemon policy lived in two hand-maintained lists in the client
(`isExplicitTimeoutCommand`, `shouldResetDaemonAfterRequestTimeout`). Both are
replaced by declarations on the command descriptors (ADR 0008 registry):

```ts
timeoutPolicy: {
  budget: { source: 'flag' | 'positional-parser' | 'none'; parser?: string };
  onTimeout: 'preserve-daemon' | 'reset-daemon';
}
```

with a completeness gate over all public commands. Read-only polling commands
declare `preserve-daemon`; the client derives the envelope from the declared
budget source instead of special-casing command names. Since #1105 the
capture-resolving interaction commands (`click`, `fill`, `longpress`, `press`,
`type`, `get`, `is`) also declare `preserve-daemon`: their dominant timeout
mode is the same blocked accessibility capture as `snapshot`, and resetting
the daemon there destroyed every healthy app session the daemon owned.

## Consequences

- Adding a dispatch path or a guarantee becomes a *forced* whole-matrix
  decision: tsc will not compile an unclassified cell, and the gate will not
  pass an untested one. Silent erosion is structurally impossible; explicit
  waivers remain possible but visible and linkable to issues.
- Fast paths keep their latency wins. Their divergence is priced and
  documented instead of discovered on-device.
- The Swift/TS split stops being a parity blind spot: golden tables are the
  single source of truth for cross-language rules, and the fake runner stops
  being a second, drifting implementation.
- Initial cost is mostly classification honesty: the first registry will
  contain `waived('gap: ...')` cells (e.g. the maestro non-hittable fallback
  intentionally waives `offscreen`), which is the point — the debt becomes a
  diffable list instead of folklore.
- The registry doubles as documentation input for help/skill output ("what
  press guarantees"), which matters for small-model agents that only read the
  contract, never the code.

### Synthesized iOS gesture policy

Synthesized iOS gestures (`scroll`, synthesized coordinate `tap`, synthesized
`drag`, and synthesized `sequence` tap/drag steps) are intentionally not folded
into the element dispatch-path matrix above. They do not resolve selectors or
refs, so claiming the element-targeting guarantees would be misleading. Their
AX-health, keyboard-probe, frame-source, activation-preflight, and
XCTest-coordinate fallback rules stay runner-local in
`RunnerTests+SynthesizedGesturePolicy.swift`. That Swift policy is the source of
truth because the current table has only three behaviors:

- coordinate synthesized tap never probes keyboards and may use the coordinate
  fallback;
- default iOS scroll probes keyboards only after AX is known healthy and must
  not fall back to `XCUICoordinate`;
- explicit synthesized drag, including synthesized sequence tap/drag steps, may
  still use the coordinate fallback before AX health is known, but stops using
  it once a snapshot stamps AX unavailable.

The non-obvious parts are covered by gated XCTest policy tests instead of a
cross-language mirror. A future sibling registry should only be introduced once
gesture policy grows beyond this small runner-local table or needs host-side
tooling to consume it directly. Synthesized coordinate contexts use screenshot
dimensions as their only frame source; cheaper frame sources such as
`app.frame`, windows, accessibility frames, or native screen bounds are
intentionally excluded because they can diverge from full-screen screenshot
coordinates on affected simulators.

Two-contact pan/pinch/rotate/transform planning is now owned by the typed
gesture-plan contract in [ADR 0013](0013-unified-gesture-plans.md). It remains a
sibling of this element-targeting matrix: coordinate gestures do not acquire
selector/ref guarantees merely because their native executor uses XCTest.

## Migration plan

Each step lands green and independently useful:

1. **Registry + gate** with an honest initial classification (waivers linked
   to issues). No behavior change.
2. **Response builder consolidation** (`buildInteractionResponseData`) + the
   hand-rolled-literal guard test.
3. **Golden fixture tables** + `TapPointPolicy` Swift extraction + the three
   consumers (vitest, XCTest, fake runner).
4. **Contract scenario suite** + registry-driven coverage gate; port the
   Bluesky fixtures from #1075's tests into the permanent tables.
5. **Descriptor timeout policy**; delete the two client-side command lists.

## Alternatives considered

- **Delete the fast paths** (single resolution spine): unacceptable — the
  direct iOS path saves a full snapshot round trip per interaction and the
  ref fast path is the backbone of replay throughput. The problem is not that
  fast paths exist; it is that their trade-offs were implicit.
- **Typestate/branded types** ("cannot construct a response without proof the
  guards ran"): cannot reach across the wire into Swift, and the proof tokens
  go viral through every signature for marginal gain over the
  registry-plus-gate split. Types are used where they are strongest —
  completeness of the declaration — and tests where they are strongest —
  truth of the declaration.
- **More integration tests without the registry**: this is the status quo
  plus effort. Without the matrix as code, nothing forces a new path to
  acquire the existing suite, which is exactly how this week's bugs happened.
