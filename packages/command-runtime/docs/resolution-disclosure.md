# Resolution disclosure

These contracts supplement [ADR 0012](../../../docs/adr/0012-interactive-replay.md) decision 2.
`@agent-device/command-runtime` builds the `resolution` response field.
ADR 0011's `resolutionDisclosure` row in the interaction guarantee matrix enforces it.

## Runtime selector

The daemon-tree selector path (`runtime-selector`) adds a `resolution` response field.
A unique resolution is `{ source: "runtime", phase: "pre-action", kind: "unique" }`.
Multiple matches succeed only if they form one ancestor–descendant wrapper chain for the same actionable node.
That structural collapse returns `{ source: "runtime", phase: "pre-action", kind: "disambiguated", matchCount, winnerDiagnostic, tiebreak: "structural-equivalence", alternatives }`.
Distinct subtrees fail before mutation with `AMBIGUOUS_MATCH` and at most five snapshot candidate lines.
Geometry never selects among distinct mutating targets.

Successful structural-collapse diagnostics remain **pre-action diagnostics**.
They issue no refs.
After mutation, neither `winnerDiagnostic` nor `alternatives` may serve as an `@ref` target.
An ambiguity rejection performs no mutation.
Its bounded candidate lines issue a partial ref frame and `refsGeneration`.
CLI prints pinned candidates. MCP remembers their generation for immediate retry.
A post-action `--settle` diff remains a separate actionable issuer.
A target-binding divergence also sends no action.
It issues its fresh report snapshot under the [divergence contract](../../ad-replay/docs/divergence-and-resume.md).

## Ref paths

Ref paths disclose ref provenance.
A successful lookup of the `@ref` itself returns `{ source: "ref", phase: "pre-action", kind: "exact" }`.
The runtime-ref path can recover a stale or unusable `@ref` through its recorded trailing label.
`tryResolveRefNode` uses `fallbackLabel` for this first-match label lookup.
This recovery returns `{ source: "ref", phase: "pre-action", kind: "label-fallback" }`.
Label recovery must never claim exact ref provenance.

The native-ref fast path always discloses `exact`.
It dispatches the ref handle and forwards the recorded `fallbackLabel` to the backend.
The daemon cannot observe any backend label recovery.
Thus, `exact` describes only daemon resolution.
This path cannot make a more specific claim.

## Direct-iOS selector

The accepted direct-iOS selector fast path has no daemon tree.
The XCTest response cannot establish a match count, candidate refs, or a runtime tiebreak.
This path remains enabled for an ordinary simple `press`.
Its canonical unique-match response contains `resolution: { source: "direct-ios", kind: "not-observed" }`.
It must never invent a unique-match or identity claim.
XCTest counts raw exact matches before it applies hittability.
Multiple matches return `AMBIGUOUS_MATCH`.
For non-Maestro dispatches, they delegate to the runtime structural rule.
`--verify`, `--settle`, fill, and recording paths continue to use runtime resolution directly.

## Matrix cells

ADR 0011's matrix has a `resolutionDisclosure` guarantee for every interaction path, with five enforced and three inapplicable cells:

- `runtime-selector` enforces the complete pre-action diagnostic shape.
- `runtime-ref` enforces `exact` or `label-fallback` for trailing-label recovery.
- `target-drag` enforces a disclosure for each endpoint: the source and the destination each carry their own `resolution`.
- `native-ref` enforces `exact`.
- `maestro-direct-selector` enforces only `{ source: "direct-ios", kind: "not-observed" }`.
- `coordinate` is inapplicable because no element resolves.
- `find-focus-dispatch` is inapplicable because it issues no identity (ADR 0014).
- `maestro-non-hittable-fallback` is inapplicable because Maestro owns matching and the fallback executes coordinates.

The **executed dispatch** determines maestro-cell membership.
Permission to use a fallback does not determine membership.
A press that was allowed to fall back but hit its element normally is the direct-iOS path, and it discloses `not-observed`.
Only an executed coordinate fallback belongs to the inapplicable maestro cell.
The enforced cells use the shared response builder.
The existing direct path delegates `disambiguation` to `runtime-selector` after its raw-match count.
Its `responseIdentity` limitation remains explicit.

This contract claims no cross-language selection-parity table.
XCTest detects only raw ambiguity.
The daemon tree owns structural equivalence and candidate publication.

## Required coverage

Layer-3 coverage must claim every enforced/delegated cell:

- Unique runtime resolution
- Structural wrapper collapse
- Distinct-subtree rejection with candidates
- Exact-ref provenance for runtime and native refs
- Runtime-ref `label-fallback` recovery
- Direct-iOS `not-observed` without a snapshot

Matrix and provider contracts cover every `resolutionDisclosure` cell:

- Runtime ambiguity/tiebreak and the five-alternative limit
- Runtime/native exact-ref provenance
- Runtime-ref `label-fallback` disclosure
- Target-drag disclosure for the source and destination endpoints
- Direct-iOS `not-observed`
- Coordinate inapplicability
- Find-focus dispatch inapplicability
- Maestro inapplicability on both sides of the permission: fallback taken, and allowed-but-not-taken that discloses `not-observed`
- The retained direct-path waiver list

Interaction mutation contracts prove that pre-action resolution diagnostics neither issue refs nor receive MCP pins.
Use of an alternative requires a fresh snapshot.
A no-action target-binding divergence can issue and pin its fresh report refs.
