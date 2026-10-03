# ADR 0026: Scroll Clip Authority — Ownership Is the Parent Edge

## Status

Accepted (2026-09-22). The ownership decision is shipped: #2758 reads an indicator's owner off the
parent edge, climbing only same-frame ancestors — the tolerance the #2754 step 3 survey justified on
real captures — and #2759 pairs the two eligibility lists and settles `ScrollArea` for macOS. Two
#2754 steps stay open work rather than part of this decision: the runner-stage differential arm, and
the typed ejection disposition the "every removed source" row below names. Refines ADR 0004's
fact/interpretation boundary for scroll geometry; does not supersede it.

An interactive iOS snapshot of a list dropped every row after a row holding selectable text. A
`UITextView` is a UIScrollView and XCTest publishes its scroll indicator inside the text, so the
indicator was attributed to the surrounding list, the list's visible band became one 22 px line, and
everything below it was clipped out of `snapshot -i` (#2214 in 0.21.0, patched for that one type by
#2740). The root cause is not the unrecognised type — it is that presentation **inferred** an owner by
walking up past the indicator's parent, and that guess decided which nodes existed in the output.

## Rules at a glance

| Situation | Behavior |
| --- | --- |
| Which scroll view an indicator reports on | Its **parent**, when that parent is a scroll type. UIKit publishes an indicator inside its own scroll view, and the producer's tree already says so. Ownership also passes **up through ancestors that share their own parent's exact frame** — the producer's transparent wrappers around one scroll region (Safari nests `Other` → `WebView` → `WebView` above a `WKWebView`'s `ScrollView`, all one frame). A node that is **itself** a scroll type and carries the label describes itself, not its parent, so it owns nothing (resolved: #2754 step 1 — banding its parent would clip a sibling list to the host's band, mirroring #2214 upward) |
| An indicator whose nearest scroll-typed ancestor is reached only across a frame change — a smaller `TextView`/`WebView`/cell host | Owns nothing. No band, no clip, and the host's own scrollability stays with that host. The frame change, not a label or type, is what ends the walk (resolved: #2754 step 3 on a real `WKWebView` capture) |
| The visible band | Derived by presentation from the owner's frame and the indicator's track. Never reported by a producer |
| Removing a node **because a scroll band hides it** | Requires evidence: the clip fold's result, or a band whose owner is the indicator's parent. A guess about ownership may not do it |
| Removing a node by semantic delegation — a collapsed row, a duplicate label, a wrapper's content | Out of scope here. That is compaction, and it keeps its own authority |
| Weaker evidence than a parent edge | Directional hints (`hiddenContentAbove` / `hiddenContentBelow`) and nothing that changes membership |
| Every removed source | Must end with a typed disposition — the open #2754 step 5 contract, not shipped code. Internal evidence, never wire vocabulary |

## Contracts

**Ownership is read, not inferred.** A scroll view's indicators arrive as its children, so the parent
edge is the producer's own claim and no new contract field, cross-language ownership table, or
capture-local index remapping is needed. That edge survives to presentation on both input stages
because every scroll host iOS can emit is regular-eligible, so projection re-parents an indicator only to
that host: `REGULAR_ELIGIBLE_TYPES` in `ios-snapshot-engine/projection.ts` and `eligibleInteractiveTypes`
in `SnapshotPresentationProjection.swift` both carry `Cell`, `CollectionView`, `ScrollView`, `Table`,
`TextView`, and `WebView`. Those two lists are one fact in two languages and must stay in step.

Passing ownership up through **same-frame** ancestors keeps ownership read rather than inferred: the
producer states two nodes are the same rectangle, which is a structural fact, not a label or type guess.
It is needed because a `WKWebView`'s page indicator is published under `WebView` wrappers that fill the
`ScrollView` exactly (#1784/#1797, and real captures in #2754 step 3); strict parent-edge ownership left
that scroller unbanded and returned content scrolled under the toolbar. The walk stops at the first frame
change, so a host that is smaller than its parent — a `WebView` row in a list — is a different scroll
region and still owns nothing, which is the #2214 bug the pass-through must not reintroduce.

That eligibility claim is scoped to iOS, and `scrollarea` is why. `isScrollableSnapshotType` accepts it,
neither eligible set contains it, and the iOS runner never emits it — it originates in the macOS helper's
`AXScrollArea` mapping. That helper's trees do reach these rules, through `snapshot-desktop-surface.ts`
→ `ios-snapshot-runtime.ts` → `publishIosSnapshot`, so on that surface a `ScrollArea` host can be dropped
by eligibility while its children re-parent past it, which leaves a parent-edge lookup with no owner.
Reusing this rule for macOS therefore needed a `ScrollArea` eligibility decision made there, not
carried over from the iOS claim above, and #2759 made it with cases rather than by admitting the
type for iOS's sake: `scrollarea` stays out of both eligible sets, a `ScrollArea` carrying content
survives eligibility on those trees and owns its band, and a label-less one is dropped, leaving its
indicator with no owner to band — which under-clips (safe) instead of mis-clipping the enclosing
list (`eligibility-parity.test.ts`).

**Why the band exists at all.** XCTest reports a scroll view's frame spanning the bars and the safe
area, not the visible track. In the pinned Settings tree the `CollectionView` frame is the whole screen,
0–874, while its indicator track is 116–812 (`runner-presentation.test.ts`). The frame alone therefore
cannot express visibility, and deleting indicator clipping would return content that is scrolled under
the chrome. The band is necessary; only *who owns it* was ever in question.

**Visibility ejection needs evidence, and every ejection must be recorded.** Most of the engine's 23
removal sites delegate semantics or drop decoration — a collapsed row, a duplicate label, a
wrapper's content, a system indicator — and this ADR does not touch their authority. It governs the
four visibility-driven sites among them, the scroll band's one and the keyboard band's three,
alongside the clip fold's own inclusion decision in `geometry-policy.ts`. Of those, the scroll band
is the one a weak signal can reach, and directional hints are its safe outlet when nothing is the
indicator's parent. Every source index must end either presented, with its representatives, or
removed with a typed reason, which makes the ledger complete by construction rather than gated;
#2754 step 5 still owes that reason, and `presentedIndexesBySourceIndex` in
`ios-snapshot-engine/semantic-index.ts` records representatives and no removal reason today. That
ledger is the shape to extend; a second parallel ledger would be a second source of truth.

## Refuted alternatives

- **A producer-reported ownership field on `IosRunnerPresentation`.** The parent edge already carries the
  fact, so a field would add validation, capture-local indexing, and remapping hazards of its own for
  nothing.
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
  code. Nineteen of the 23 `suppressNode` sites legitimately eject, so handing a membership API to "one
  clip rule" restores the convention it claims to enforce. Two functions already rewrite rects *and* eject
  in one pass — the scroll rule and the navigation-bar affordance rule in `transitions.ts` — while
  `noise-overlay` shows the split done properly: its presentation pass receives replacements only and a
  separate suppression pass receives the ejecting surface. And a reshape surface that still accepts `rect`
  would permit the exact rewrite that caused this incident. Inventory the sites in #2754 first; redesign
  only what the inventory justifies.
- **A runtime guard on shrinkage instead of the differential.** A threshold would either fire on ordinary
  compaction — the Settings tree legitimately drops rows under the chrome — or sit loose enough to wave
  through a 74 → 20 collapse. The differential already asserts interactive ⊆ regular ⊆ raw; what it lacks
  is coverage of the runner stage, since `assertProjectionSubsets`
  (`ios-snapshot-engine/properties.test.ts`) builds acquired inputs only and the Swift differential drops
  interactive cases. Extending it to `stage: 'presented'` is what makes any future shrinkage visible.

## Consequences and open evidence

- **Under-clipping was the open risk; same-frame pass-through resolves the real instance.** Strict
  parent-edge ownership left a `WKWebView` page scroller unbanded because the page indicator is published
  under `WebView` wrappers, leaking content under the toolbar (#1797, with #1784 adjacent). #2754 step 3
  surveyed real captures (Settings, Settings › Privacy & Security, a Safari `WKWebView` page — 25 indicators,
  18 under a non-scroll parent) and found exactly this shape on the web surface. Resolved by passing
  ownership through same-frame ancestors, which reproduces `main`'s clip on all three real captures while
  the smaller-host row cases (#2214) still own nothing. A genuinely frame-mismatched non-scroll wrapper
  would still under-clip, but no captured iOS tree has that shape.
- **The `WebView` shape is now confirmed on real data.** A Safari `snapshot -i --raw` capture shows the
  `WKWebView`'s indicator published under `Other` → `WebView` → `WebView` ancestors that fill the
  `ScrollView` exactly; the fixture in `runner-presentation.test.ts` reduces that live tree.
- **The self case is resolved: a scroll-typed indicator owns nothing.** #2754 step 1 deleted the
  self-ownership branch. Reading a scroll-typed node labelled as an indicator onto its own band is a
  no-op (the indicator and container are the same rect, which `deriveScrollableViewportRect` refuses),
  while reading it onto its parent clips a sibling list to that host — the #2214 failure mirrored
  upward. So `findScrollIndicatorContainer` returns null when the node is itself a scroll type;
  `runner-presentation.test.ts` pins a scroll host labelled as an indicator leaving its parent list's
  band intact.
- **macOS is already a second consumer of these rules, and #2759 settled its `ScrollArea`
  question.** Desktop capture runs the engine through `snapshot-desktop-surface.ts` →
  `ios-snapshot-runtime.ts` → `publishIosSnapshot`, and its trees carry `ScrollArea`, which neither
  eligible set admits: a content-bearing one survives eligibility and owns its band; a label-less
  one is dropped and leaves its indicator with no owner, under-clipping instead of mis-clipping the
  list. `eligibility-parity.test.ts` pins both outcomes and the TS/Swift eligibility pair.
- **Ejection inventory precedes any API change.** 23 suppression sites across ten rules, and two of them
  (`scroll`, `transitions`) already rewrite rects on other nodes in the same pass that ejects — the
  combination the proposed API split claimed to make impossible.
- **The 74 → 67 node delta on the reporting screen is unexplained.** No captured artifact exists, so
  neither number is an acceptance baseline.
