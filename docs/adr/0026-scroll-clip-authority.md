# ADR 0026: Scroll Clip Authority — Ownership Is the Parent Edge

## Status

Proposed (2026-09-22), revised after review. Refines ADR 0004's fact/interpretation boundary for scroll
geometry; does not supersede it. Implementation contract: #2754.

An interactive iOS snapshot of a list dropped every row after a row holding selectable text. A
`UITextView` is a UIScrollView and XCTest publishes its scroll indicator inside the text, so the
indicator was attributed to the surrounding list, the list's visible band became one 22 px line, and
everything below it was clipped out of `snapshot -i` (#2214 in 0.21.0, patched for that one type by
#2740). The root cause is not the unrecognised type — it is that presentation **inferred** an owner by
walking up past the indicator's parent, and that guess decided which nodes existed in the output.

## Rules at a glance

| Situation | Behavior |
| --- | --- |
| Which scroll view an indicator reports on | Its **parent**, when that parent is a scroll type. UIKit publishes an indicator inside its own scroll view, and the producer's tree already says so |
| An indicator whose parent is not a scroll type — `TextView`, `WebView`, a cell | Owns nothing. No band, no clip, and the host's own scrollability stays with that host |
| The visible band | Derived by presentation from the owner's frame and the indicator's track. Never reported by a producer |
| Removing a node from output | Requires evidence: a clip fold result, or a parent-edge owner. A guess about ownership may not do it |
| Weaker evidence than a parent edge | Directional hints (`hiddenContentAbove` / `hiddenContentBelow`) and nothing that changes membership |
| Every removed source | Ends with a typed disposition. Internal evidence, never wire vocabulary |

## Contracts

**Ownership is read, not inferred.** A scroll view's indicators arrive as its children, so the parent
edge is the producer's own claim and no new contract field, cross-language ownership table, or
capture-local index remapping is needed. That edge survives to presentation on both input stages
because every scroll host iOS can emit is regular-eligible, so projection re-parents an indicator only to
that host: `REGULAR_ELIGIBLE_TYPES` in `ios-snapshot-engine/projection.ts` and `eligibleInteractiveTypes`
in `SnapshotPresentationProjection.swift` both carry `Cell`, `CollectionView`, `ScrollView`, `Table`,
`TextView`, and `WebView`. Those two lists are one fact in two languages and must stay in step.

`scrollarea` is the named exception, scoped to iOS. `isScrollableSnapshotType` accepts it, neither
eligible set contains it, and the iOS runner never emits it — it originates in the macOS helper's
`AXScrollArea` mapping. That helper's trees do reach these rules, through `snapshot-desktop-surface.ts`
→ `ios-snapshot-runtime.ts` → `publishIosSnapshot`, so on that surface a `ScrollArea` host can be dropped
by eligibility while its children re-parent past it, which leaves a parent-edge lookup with no owner.
Reusing this rule for macOS therefore needs a `ScrollArea` eligibility decision made there, not carried
over from the iOS claim above.

**Why the band exists at all.** XCTest reports a scroll view's frame spanning the bars and the safe
area, not the visible track. In the pinned Settings tree the `CollectionView` frame is the whole screen,
0–874, while its indicator track is 116–812 (`runner-presentation.test.ts`). The frame alone therefore
cannot express visibility, and deleting indicator clipping would return content that is scrolled under
the chrome. The band is necessary; only *who owns it* was ever in question.

**Ejection needs evidence, and is recorded.** Removing a node from the regular output is the one
decision a weak signal must not make. Directional hints are the safe outlet for anything short of a
parent-edge owner. Every source index ends either presented, with its representatives, or removed with a
typed reason — which makes the ledger complete by construction rather than gated. The existing
`presentedIndexesBySourceIndex` in `ios-snapshot-engine/semantic-index.ts` is the shape to extend; a
second parallel ledger would be a second source of truth.

## Refuted alternatives

- **A producer-reported ownership field.** The first draft of this ADR required one on
  `IosRunnerPresentation`, plus capture-local indexing and remapping. The parent edge already carries the
  fact, so the field, its validation, and its hazards are all unnecessary.
- **Producer-computed visible bands.** Moves interpretation back across the process boundary ADR 0004
  removed it from. The band stays host-side.
- **An owner found by walking ancestors.** That walk is the incident. Skipping only the types known to
  scroll — #2740's fix — leaves the next scroll-shaped host (`WebView`, a map view, a paged cell) to
  reopen it.
- **One universal "is a scroll container" set, or a capability matrix of ownership/clip/termination
  booleans.** Five sites answer variants of this question today (`ios-snapshot-engine/tree.ts`,
  `geometry-policy.ts`, `invariants.ts`, `SnapshotVisibilityFold.swift`, `RunnerTests+Snapshot.swift`)
  and their contents already differ: only `tree.ts` accepts `scrollarea`, the type the macOS helper emits
  and the iOS runner never does. Characterise each site before reshaping any of them; with parent-edge
  ownership the shape this rule needs is the existing `isScrollableSnapshotType`.
- **A rule-graph or effect system, and a two-API reshape/eject split.** Rejected on the shape of the
  code: `suppressNode` already has ~23 call sites across ten rules, most legitimately ejecting, so
  handing `MembershipApi` to "one clip rule" restores the convention it claims to enforce. A reshape
  surface that still accepts `rect` would permit the exact rewrite that caused this incident. Inventory
  the ejection sites in #2754 first; redesign only what the inventory justifies.
- **A runtime guard substituting for the differential.** The subset property exists
  (`assertProjectionSubsets`, `ios-snapshot-engine/properties.test.ts`) but builds acquired inputs only,
  and the Swift differential drops interactive cases. Extending it to `stage: 'presented'` is what makes
  any future shrinkage visible.

## Consequences and open evidence

- **Under-clipping is the new risk.** Dropping the walk means a tree that places an indicator under a
  labelled wrapper rather than directly under its scroll view gets no band, so content scrolled under
  the chrome can survive in the output — the leak class #1784/#1797 removed. Measured so far: the full
  unit suite passes with parent-edge ownership, and a synthetic `WebView` row keeps rows that `main`
  drops. Real captured trees must be surveyed for that wrapper shape before landing.
- **The `WebView` instance is synthetic.** The mechanism is confirmed in a hand-built tree; that XCTest
  publishes a `WKWebView`'s indicator the same way is unverified.
- **macOS is already a second consumer of these rules.** Desktop capture runs the engine through
  `snapshot-desktop-surface.ts` → `ios-snapshot-runtime.ts` → `publishIosSnapshot`, and its trees carry
  `ScrollArea`, which neither eligible set admits. The parent-edge rule needs its own decision there
  before it is reused, not a carry-over from the iOS claim.
- **Ejection inventory precedes any API change.** 23 suppression sites across ten rules, and two of them
  (`scroll`, `noise-overlay`) already rewrite rects on other nodes while ejecting — the combination the
  proposed API split claimed to make impossible.
- **The 74 → 67 node delta on the reporting screen is unexplained.** No captured artifact exists, so
  neither number is an acceptance baseline.
