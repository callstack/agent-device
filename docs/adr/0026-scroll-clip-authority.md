# ADR 0026: Scroll clip authority

## Status

Accepted (2026-09-22). The ownership decision is shipped.
The runner-stage differential arm and the typed ejection disposition in #2754 remain open.
This record refines ADR 0004's fact and interpretation boundary for scroll geometry; it does not supersede ADR 0004.

## Context

A scroll indicator attributed to an enclosing list instead of its smaller text host clipped the list's lower rows (#2214).
Walking past the indicator's parent had inferred ownership across a frame change.
A scroll frame can extend under system chrome, so the frame alone cannot express the visible band.

## Decision

Read indicator ownership from structure, not inference.
The indicator's parent owns it when the parent is a scroll type.
Ownership also passes through ancestors with their own parent's exact frame, which are transparent wrappers around one region.
Traversal stops at the first frame change, regardless of label or type.
An indicator whose nearest scroll-typed ancestor is reached only across a frame change owns nothing and gets no band or clip.
The smaller host retains its scrollability.
A scroll-typed node with the indicator label describes itself and owns nothing.

Presentation derives the visible band from the owner's frame and indicator track; a producer never reports the band.
Removal because a scroll band hides a node requires the clip fold's result or a band owned by the indicator's parent.
Inferred ownership cannot authorize removal.
Evidence weaker than a parent edge emits only `hiddenContentAbove` or `hiddenContentBelow` directional hints and does not change membership.
Semantic delegation, such as a collapsed row, duplicate label, or wrapper content, is compaction outside this decision and retains its own authority.
The decision also covers the clip fold's inclusion decision and the three keyboard-band visibility sites.
A weak signal can reach only the scroll-band site.

Every source index must end presented with its representatives or removed with a typed disposition.
This is the open #2754 step 5 contract, not shipped code; it is internal evidence, never wire vocabulary.
The existing source-to-representatives ledger is the shape to extend, because a second ledger would be a second source of truth.

## Eligibility and platform scope

On iOS, every scroll host the producer can emit is regular-eligible, so projection re-parents indicators only to that host.
The TypeScript and Swift eligibility lists must remain synchronized for `Cell`, `CollectionView`, `ScrollView`, `Table`, `TextView`, and `WebView`.

The iOS runner does not emit `scrollarea`; the macOS helper maps `AXScrollArea` to it.
macOS trees also use these presentation rules.
`scrollarea` remains outside both eligible lists.
A content-bearing `ScrollArea` survives eligibility and owns its band.
A label-less `ScrollArea` disappears and leaves its indicator without an owner.
That case under-clips instead of incorrectly clipping the enclosing list.

## Rejected alternatives

- A producer ownership field: the parent edge already supplies the fact, and a field adds validation and index-remapping hazards.
- Producer-computed bands: this moves interpretation across the producer boundary established by ADR 0004.
- An ancestor walk across frame changes: it caused the original failure; excluding known types alone leaves other smaller hosts exposed to the same error.
- One universal scroll-container set or an ownership and clip matrix: the sites answer different questions, and only the host-side scroll type predicate accepts macOS `scrollarea`. Characterize each site before reshaping it.
- A rule graph, effect system, or two-API reshape/eject split: existing rules can change rectangles and eject in one pass, while a replacements-only presentation with a separate suppression pass is also valid. Inventory ejection sites in #2754 first; redesign only what that inventory justifies.
- A shrinkage guard instead of the differential: a threshold can reject legitimate compaction or permit a collapse. The differential asserts interactive ⊆ regular ⊆ raw, but lacks runner-stage coverage. Extending it to `stage: 'presented'` makes future shrinkage visible.

## Consequences and open evidence

Same-frame pass-through preserves a `WKWebView` band's ownership through same-frame wrappers while smaller hosts still own nothing.
A non-scroll wrapper with a different frame can still under-clip; no captured iOS tree had that shape in the #2754 survey.
The ejection inventory precedes API changes.
The reporting screen's 74 → 67 node change remains unexplained; no captured artifact exists, and neither number is an acceptance baseline.
