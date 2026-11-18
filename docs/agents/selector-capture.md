# Selector Capture Reliability

These requirements apply across routes.
ADRs 0002, 0004, 0005, 0011, 0014, and 0015 own their rationale and decisions.

- Direct iOS selectors are a fast path for simple one-term selectors, disabled while post-gesture stabilization is pending.
  A structured selector miss may return to snapshot resolution.
  Ambiguity and other runner failures stay failures.
- Regular selector reads, including `get`, `is`, `find`, and `wait`, capture through the backend.
  `@ref` resolves against its authorized ref frame.
  Polling, active freshness recovery, and stabilization bypass the snapshot cache.
  The cache serves a stored tree only while it is the newest observation.
  A side-effect seam or a native read, such as `wait text`'s owner text read, retires it.
- Sparse capture verdicts are observable failures that never replace the session snapshot.
  Only a user-facing snapshot may publish a fallback screenshot.
  Internal polling must not create one artifact per attempt.
- Apple accessibility failures do not prove an empty UI.
  Recovery plans may serve regular snapshots; raw and strict paths keep the failure.
  Fatal runner evidence invalidates the cached target.
- After a tap, a recorded XCTest failure is an ambiguous outcome.
  Only a usable same-presentation capture with a changed accessibility digest corroborates success.
  Missing, sparse, mismatched, or unchanged evidence stays a failure.
- Android helper reuse is not snapshot-result caching.
  Freshness is short-lived, action-triggered, and set only by route-safe complete observations.
- When required, Android freshness recovery runs after post-gesture stabilization.
  Gesture-like mutations mark stabilization.
- Write session snapshots through the shared snapshot mutation boundary.
  Sparse observations and empty ref-scoped projections never overwrite stored evidence.
- Maestro matching remains snapshot- and policy-owned.
  Coordinate dispatch uses fresh geometry.
  An exact same-generation iOS target may use atomic selector activation.
  A structured live miss returns to fresh Maestro resolution.
  Never add fuzzy matching, synthetic geometry, hierarchy heuristics, or error-message classification that changes authored selector meaning.

For changes to these rules, update the relevant ADR, guarantee-matrix cell, contract scenario, and TypeScript/Swift parity table.

Do not describe a new exception here instead.

## Replay and coordinates

Element interactions support selector and `@ref`.
After resolution, they record a selector chain.
Replay failures may re-resolve that chain only for a ranked divergence suggestion.
ADR 0012 retired silent script rewriting.

`@agent-device/selectors` owns selector keys.
The `is` predicates use `evaluateIsPredicate`.
On macOS, snapshot rectangles are absolute in window space, and point actions translate through the interaction root frame.
Prefer selector or ref tests to raw coordinates.
