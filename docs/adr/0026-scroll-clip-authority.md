# ADR 0026: Scroll Clip Authority — Inference May Reshape, Never Eject

## Status

Proposed (2026-09-22). Refines ADR 0004's acquisition/presentation boundary for scroll geometry; it
does not supersede it. Implementation contract: #2754.

An interactive iOS snapshot dropped every list row after a row holding selectable text. A `UITextView`
is a UIScrollView and XCTest publishes its scroll indicator inside the text, so the indicator was
attributed to the surrounding list and the list's visible band became one 22 px line; everything below
it was clipped out of `snapshot -i`. The root cause is not the wrong type: it is that a **tree-walking
guess about which scroll view an indicator describes was given the power to decide which nodes exist
in the output.** This ADR separates those two powers.

## Rules at a glance

| Situation | Behavior |
| --- | --- |
| Which scroll view an indicator reports on | A **reported** fact from the producer: the owner element, named capture-locally |
| Producer cannot report ownership (private-AX, tree backends) | An **inferred** attribution, explicitly typed as inferred |
| An inferred attribution | May add directional hints (`hiddenContentAbove` / `hiddenContentBelow`). May not rewrite a container's rect or remove a node |
| A reported attribution | May additionally establish that container's visible band |
| Indicator inside a `TextView`, `WebView`, or other host that scrolls but publishes as a non-scroll type | Ownership terminates at that host. The enclosing list keeps its own band and loses no rows |
| Visible clip for an acquired input | The clip fold's viewport-intersected container frame, unchanged |
| Visible clip for a runner-presented input | The same fold rule, refined only by reported ownership |
| Any rule that removes a node from output | Must go through the eject surface with a typed reason |
| "Is this a scroll container?" | A capability matrix (`mayOwnIndicator`, `mayEstablishViewportClip`, `terminatesAncestorOwnership`), never one boolean |
| Interactive output shrinks | Every removed source has a recorded disposition, and a gate says so |
| Producer proposes a visible band | Refused. The band is interpretation, not evidence |

## Contracts

**1. Ownership is a fact; the band is interpretation.** ADR 0004 kept interpretation on the host so no
backend carried its own copy of it. Indicator→owner attribution is a fact about what the producer
traversed — XCTest knows which UIScrollView it took the indicator from — so the runner publishes it and
the host still decides the clip. The producer reports **no** band: a producer-computed band moves the
interpretation back across the process boundary it was removed from.

The fact belongs with the payload, not with the validation claims: `IosRunnerPresentation`, beside
`payload` (`packages/contracts/src/ios-snapshot.ts:165-189`), not `IosSnapshotValidationFacts`, whose
members are viewport, hittability, lineage, and residue.

**2. The owner reference is capture-local.** Swift reindexes presented nodes after eligibility, scope,
and depth (`apple/snapshot-presentation/Sources/AgentDeviceSnapshotPresentation/SnapshotPresentationProjection.swift:59-87`).
An owner index must therefore be consumed or remapped before host compaction, never carried across a
reindex. A producer-side ancestor walk that merely relocates today's heuristic is not a reported fact
and does not earn band authority.

**3. Reshape and eject are different authorities.** The presentation rule seam
(`packages/capture-kit/src/ios-snapshot-engine/semantic-index.ts:9-18`) currently hands all five passes
one context whose `suppressNode` is unrestricted
(`packages/capture-kit/src/ios-snapshot-engine/tree.ts:5-13`). Split it:

```ts
type ReshapeApi = {
  current(index: number): RawSnapshotNode;
  replaceFacts(index: number, patch: Partial<RawSnapshotNode>): void;
  addScrollHint(index: number, hint: { above?: true; below?: true }): void;
};

type MembershipApi = ReshapeApi & {
  eject(index: number, reason: EjectionReason): void;
};

type EjectionReason =
  | { kind: 'semantic-representative'; representativeIndexes: readonly number[] }
  | { kind: 'noise' }
  | { kind: 'viewport-clip'; authority: 'fold' | 'reported-ownership' };
```

Scroll-indicator interpretation receives `ReshapeApi`. Only the single clip-application rule receives
`MembershipApi`. "Low-confidence geometry cannot change membership" is then a compile-time property of
which argument a rule is handed, not a convention inside the rule body.

**4. Scroll capability is a matrix.** `mayOwnIndicator`, `mayEstablishViewportClip`, and
`terminatesAncestorOwnership` are three different questions and today get one boolean answered five
different ways: `ios-snapshot-engine/tree.ts:171-179`, `geometry-policy.ts:6`, `invariants.ts:12`,
`SnapshotVisibilityFold.swift:18`, `RunnerTests+Snapshot.swift:128-132`. A text or web host answers
`mayOwnIndicator: true, terminatesAncestorOwnership: true, mayEstablishViewportClip: false`. Adding
`TextView`/`WebView` to a universal scroll-container set is refused for the same reason the fix in #2740
was insufficient: it would let those hosts establish clips as well.

**5. One clip resolver, evidence-gated.** The acquired path folds
(`ios-snapshot-engine/engine.ts:108-132`, anchor rule `geometry-policy.ts:179`); the runner path skips
the fold and clips to an indicator band instead (`runner-presentation.ts:104-115`). One resolver, with
the viewport-intersected container frame as the safe default and reported ownership as the only
refinement. The band remains necessary — XCTest reports a UIScrollView's frame as its content extent, so
the container's own frame cannot express visibility alone — but it may only be applied to a container
whose ownership is reported.

**6. Ancestors are read from one tree.** Indicator detection reads presented nodes while ownership walks
source nodes (`ios-snapshot-engine/scroll.ts:22` vs `:74`), so a rule that rewrites a type — `web.ts:26-29`
turns `element(58)` into `WebView` — is invisible to the ownership walk that runs after it. Predicates see
the effective view.

**7. Ejections are accounted for.** Every source index ends with a disposition: presented (with its
representatives) or ejected (with at least one reason). The ledger is internal evidence; reasons stay off
the public snapshot wire.

**8. Differential coverage covers both stages.** `assertProjectionSubsets`
(`ios-snapshot-engine/properties.test.ts:107-133`) builds acquired inputs only, and the Swift differential
drops interactive cases (`scripts/ios-snapshot-differential.test.ts:24`). The subset property must run
`stage: 'presented'` inputs too. Assert source-level membership plus dispositions — not literally
`interactive ⊆ full`, which is false because the full projection skips semantic compaction
(`engine.ts:121-126`).

## Refuted alternatives

- **Producer-computed visible band.** Reopens the per-backend interpretation ADR 0004 closed.
- **The indicator band as the single global clip authority.** Recreates this incident for every host
  whose indicator is not its own; deleting indicator clipping instead breaks the contract pinned by
  `runner-presentation.test.ts:17-34`.
- **A universal "is scroll container" set.** Five sites already diverge, and some divergence is real:
  `ScrollArea` comes from the macOS helper's `AXScrollArea` mapping
  (`apple/macos-helper/Sources/AgentDeviceMacOSHelper/SnapshotTraversal.swift:597`) and may reach shared
  rules deliberately. Unifying without characterizing each site is a behavior change in disguise.
- **A generic rule graph or effect system.** The two interfaces above are the enforcement; a framework
  would be a larger thing to get wrong.
- **Cross-language parity asserted early.** Indicator cases join the Swift golden fixture only when Swift
  implements the behavior.

## Evidence gaps kept open

- 0.20.8 produced 74 nodes on the reporting screen, this fix 67. No captured artifact explains the
  difference; neither number is an acceptance baseline until one exists.
- Whether `ScrollArea` reaches the iOS engine rules on purpose, and what each of the five scroll-type
  sites actually needs, must be characterized before any set is unified.
