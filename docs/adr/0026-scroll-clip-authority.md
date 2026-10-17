# ADR 0026: Scroll Clip Authority — Ownership Is the Parent Edge

## Status

Accepted (2026-09-22). The ownership decision is shipped.
#2758 reads indicator ownership from the parent edge and traverses only same-frame ancestors.
The #2754 step 3 survey justified this tolerance with real captures.
#2759 pairs the eligibility lists and decides macOS `ScrollArea` behavior.
Two #2754 steps remain open, outside the shipped decision:

- The runner-stage differential arm.
- The typed ejection disposition in the "every removed source" rule below.

This ADR refines ADR 0004's fact/interpretation boundary for scroll geometry.
It does not supersede ADR 0004.

An interactive iOS list snapshot lost all rows after a row with selectable text.
A `UITextView` is a UIScrollView.
XCTest publishes its scroll indicator inside the text.
Presentation attributed that indicator to the surrounding list and reduced the visible list band to one 22 px line.
It clipped every lower row from `snapshot -i` (#2214 in 0.21.0).
#2740 patched this one type.
The cause was an **inferred** owner from traversal beyond the indicator's parent, not an unrecognized type.
That inference determined output membership.

## Rules at a glance

| Situation | Behavior |
| --- | --- |
| Indicator ownership | Its **parent** owns it when the parent is a scroll type. Ownership also passes through ancestors with their own parent's **exact frame**. These are transparent wrappers around one region. A scroll-typed node with the indicator label describes itself and owns nothing. |
| An indicator whose nearest scroll-typed ancestor is reached only across a frame change, for example a smaller `TextView`/`WebView`/cell host | The indicator owns nothing. It gets no band and no clip. The smaller `TextView`/`WebView`/cell host retains its scrollability. A frame change ends traversal, regardless of label or type. |
| Visible band | Presentation derives it from the owner's frame and indicator track. A producer never reports it. |
| Removal **because a scroll band hides a node** | Require the clip fold's result or a band owned by the indicator's parent. Inferred ownership cannot authorize removal. |
| Removal of a node by semantic delegation, for example a collapsed row, a duplicate label, or wrapper content | This is compaction, outside this ADR. It retains its own authority. |
| Evidence weaker than a parent edge | Emit only directional hints, `hiddenContentAbove` / `hiddenContentBelow`. Do not change membership. |
| Every removed source | Must have a typed disposition. This is the open #2754 step 5 contract, not shipped code. It is internal evidence, never wire vocabulary. |

## Contracts

**Read ownership from structure. Do not infer it.**
A scroll view's indicators are its children.
The parent edge is therefore the producer's ownership claim.
No new contract field, cross-language ownership table, or capture-local index remap is necessary.
The edge survives until presentation at both input stages because every iOS scroll host is regular-eligible.
Projection therefore re-parents indicators only to that host.
These two lists encode the same fact and must remain synchronized:

- `REGULAR_ELIGIBLE_TYPES` in `ios-snapshot-engine/projection.ts`.
- `eligibleInteractiveTypes` in `SnapshotPresentationProjection.swift`.

Both contain these types:

- `Cell`
- `CollectionView`
- `ScrollView`
- `Table`
- `TextView`
- `WebView`

**Same-frame traversal preserves structural ownership.**
The producer states that two nodes have the same rectangle.
This is a structural fact, not a label or type inference.
Same-frame traversal is necessary because a `WKWebView` page indicator is published under `WebView` wrappers that exactly fill its `ScrollView`.
#1784/#1797 and real #2754 step 3 captures establish this shape.
Strict parent-edge ownership left this region without a band and exposed content under the toolbar.
Traversal stops at the first frame change.
A smaller host, such as a `WebView` row inside a list, describes a different scroll region and still owns nothing.
Same-frame traversal must not restore #2214's failure.

**The eligibility claim applies only to iOS.**
`isScrollableSnapshotType` accepts `scrollarea`, but neither eligible set contains it.
The iOS runner never emits it.
It originates in the macOS helper's `AXScrollArea` mapping.
Those trees reach these rules through `snapshot-desktop-surface.ts` → `ios-snapshot-runtime.ts` → `publishIosSnapshot`.
On those trees, eligibility can remove a `ScrollArea` host while its children re-parent beyond it.
Then a parent-edge lookup finds no owner.
Reuse on macOS therefore required a separate eligibility decision.
#2759 established these cases without admitting the type for iOS:

- `scrollarea` remains outside both eligible sets.
- A content-bearing `ScrollArea` survives eligibility and owns its band.
- A label-less `ScrollArea` disappears and leaves its indicator without an owner.

The last case safely under-clips instead of incorrectly clipping the enclosing list.
`eligibility-parity.test.ts` proves these cases.

**Why the band is necessary.**
XCTest reports a scroll frame across bars and safe areas, beyond the visible track.
In the pinned Settings tree, `CollectionView` spans the complete screen, 0–874, but its indicator track spans 116–812.
`runner-presentation.test.ts` records this example.
The frame alone cannot express visibility.
Removal of indicator clipping would expose content under system chrome.
The band is necessary; its owner was the disputed fact.

**Visibility ejection requires evidence. Each ejection must be recorded.**
Most of the engine's 23 removal sites delegate semantics or remove decoration, for example:

- A collapsed row.
- A duplicate label.
- Wrapper content.
- A system indicator.

This ADR does not change their authority.
It governs four visibility-driven sites: one scroll-band site and three keyboard-band sites.
It also covers the clip fold's inclusion decision in `geometry-policy.ts`.
A weak signal can reach only the scroll-band site.
If nothing is the indicator's parent, directional hints are the safe outlet for that signal.

Each source index must end presented with its representatives or removed with a typed reason.
This rule makes the ledger complete by construction, without a gate.
#2754 step 5 still owes the removal reason.
Currently, `presentedIndexesBySourceIndex` in `ios-snapshot-engine/semantic-index.ts` records representatives without removal reasons.
That ledger is the shape to extend. A second parallel ledger would be a second source of truth.

## Refuted alternatives

- **A producer-reported ownership field on `IosRunnerPresentation`.**
  The parent edge already supplies the fact.
  A field would add validation, capture-local indexing, and remap hazards, and give no new information.
- **Producer-computed visible bands.**
  This moves interpretation back across the process boundary.
  ADR 0004 removed interpretation from the producer side of that boundary.
  Bands remain host-side.
- **An owner found by walking ancestors.**
  That walk caused the incident.
  Exclusion of only known scroll types, as in #2740, leaves the next scroll-shaped host, for example a `WebView`, a map view, or a paged cell, to reopen the incident.
- **One universal scroll-container set or a matrix of ownership/clip/termination booleans.**
  Five sites currently answer related questions:
  - `ios-snapshot-engine/tree.ts`
  - `geometry-policy.ts`
  - `invariants.ts`
  - `SnapshotVisibilityFold.swift`
  - `RunnerTests+Snapshot.swift`
  Their contents differ.
  Only `tree.ts` accepts macOS `scrollarea`, which the iOS runner never emits.
  Before you reshape any of these sites, characterize each site.
  Parent-edge ownership needs only the existing `isScrollableSnapshotType`.
- **A rule graph, effect system, or two-API reshape/eject split.**
  The existing code does not justify this structure.
  Nineteen of 23 `suppressNode` sites legitimately eject nodes.
  Membership access for "one clip rule" would restore the convention that the API claims to enforce.
  The scroll rule and navigation-bar affordance rule in `transitions.ts` already change rectangles and eject nodes in one pass.
  `noise-overlay` demonstrates a valid split: replacements-only presentation and a separate suppression pass with ejection authority.
  A reshape API that still accepts `rect` would permit the original faulty change.
  First inventory sites in #2754.
  Redesign only what that inventory justifies.
- **A shrinkage guard instead of the differential.**
  A threshold would either reject legitimate compaction or permit a 74 → 20 collapse.
  Settings legitimately removes rows under system chrome.
  The differential already asserts interactive ⊆ regular ⊆ raw.
  It lacks runner-stage coverage.
  `assertProjectionSubsets` in `ios-snapshot-engine/engine-properties.test.ts` constructs only acquired inputs.
  The Swift differential omits interactive cases.
  Extension to `stage: 'presented'` makes future shrinkage visible.

## Consequences and open evidence

- **Same-frame traversal resolves the observed under-clipping.**
  Strict parent-edge ownership left a `WKWebView` page without a band because `WebView` wrappers contained the indicator.
  It exposed content under the toolbar (#1797, with adjacent #1784).
  #2754 step 3 surveyed Settings, Settings › Privacy & Security, and a Safari `WKWebView` page.
  The captures contained 25 indicators, 18 under non-scroll parents.
  The survey found exactly this shape on the web surface.
  Same-frame traversal reproduces `main` clipping on all three captures.
  Smaller-host cases from #2214 still own nothing.
  A non-scroll wrapper with a different frame would still under-clip.
  No captured iOS tree has that shape.
- **Real data confirms the `WebView` shape.**
  A Safari `snapshot -i --raw` capture shows the `WKWebView` indicator under `Other` → `WebView` → `WebView`.
  These ancestors exactly fill the `ScrollView`.
  `runner-presentation.test.ts` reduces that live tree into a fixture.
- **A scroll-typed indicator owns nothing.**
  #2754 step 1 removed self-ownership.
  A self-band is ineffective because indicator and container share a rectangle, which `deriveScrollableViewportRect` refuses.
  A parent band would incorrectly clip a sibling list, reproducing #2214 in the opposite direction.
  Thus, `findScrollIndicatorContainer` returns null for an indicator node that is itself a scroll type.
  `runner-presentation.test.ts` pins that a scroll host labelled as an indicator leaves the parent list's band intact.
- **macOS already consumes these rules.**
  Desktop capture uses `snapshot-desktop-surface.ts` → `ios-snapshot-runtime.ts` → `publishIosSnapshot`.
  #2759 decided the `ScrollArea` cases described above.
  Content-bearing hosts survive and own their bands.
  Label-less hosts disappear and leave ownerless indicators, which under-clip rather than incorrectly clip the list.
  `eligibility-parity.test.ts` pins both outcomes and the TypeScript/Swift eligibility pair.
- **The ejection inventory precedes API changes.**
  There are 23 suppression sites across ten rules.
  Two, `scroll` and `transitions`, already change other nodes' rectangles and eject in the same pass.
  The proposed API split claimed to prohibit this existing combination.
- **The reporting screen's 74 → 67 node change remains unexplained.**
  No captured artifact exists.
  Neither number is an acceptance baseline.
