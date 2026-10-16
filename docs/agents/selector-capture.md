# Selector Capture Reliability

Before changes to selector capture, polling, snapshot caching, or interaction fast paths, read this.
These requirements apply across routes.
ADRs 0002, 0004, 0005, 0011, 0014, and 0015 own their rationale and decisions.

- Direct iOS selectors are a narrow fast path for simple one-term selectors.
  While post-gesture stabilization is pending, they are disabled.
  A structured selector miss may return to snapshot resolution.
  Ambiguity and other runner failures remain failures.
- Regular selector reads use capture.
  `@ref` resolves against its authorized ref frame.
  Selectors for `get`, `is`, `find`, and `wait` capture through the backend.
  Polling, active freshness recovery, and stabilization bypass the snapshot cache.
  The cache serves a stored tree only while it is the newest observation.
  A side-effect seam or a native read retires it.
  An example is `wait text`'s owner text read.
- Sparse capture verdicts are observable failures. They never replace the session snapshot.
  Only a user-facing snapshot may publish a fallback screenshot.
  Internal polling must not create one artifact per attempt.
- Apple accessibility failures do not prove an empty UI.
  Recovery plans may serve regular snapshots. Raw and strict paths preserve the failure.
  Fatal runner evidence invalidates the cached target.
- After a tap, a recorded XCTest failure is an ambiguous outcome.
  Only a usable same-presentation capture with a changed accessibility digest may corroborate success.
  Missing, sparse, mismatched, or unchanged evidence remains failure.
- Android helper reuse is not snapshot-result caching.
  Freshness is short-lived and action-triggered.
  Only route-safe complete observations establish freshness.
- Post-gesture stabilization runs first.
  When required, Android freshness recovery composes afterward.
  Gesture-like mutations mark stabilization.
  While stabilization is pending, these mutations disable direct iOS selector shortcuts.
- Write session snapshots through the shared snapshot mutation boundary.
  Sparse observations and empty ref-scoped projections do not overwrite stored evidence.
- Maestro matching remains snapshot- and policy-owned.
  Coordinate dispatch uses fresh geometry.
  An exact same-generation iOS target may use atomic selector activation.
  A structured live miss returns to fresh Maestro resolution.
  Never add fuzzy matching, synthetic geometry, hierarchy heuristics, or error-message classification that changes authored selector meaning.

For changes to these rules, update:

- The relevant ADR.
- The guarantee-matrix cell.
- The contract scenario.
- The TypeScript/Swift parity table.

Do not describe a new exception here instead.

## Replay and coordinates

Element interactions support selector and `@ref`.
After resolution, they record a selector chain.
Replay failures may re-resolve that chain only to produce a ranked divergence suggestion.
ADR 0012 retired silent script rewriting.

Keep selector keys centralized in `@agent-device/selectors`.
The `is` predicates use `evaluateIsPredicate`.
On macOS, snapshot rectangles are absolute in window space.
On macOS, point actions translate through the interaction root frame.
Prefer selector or ref tests over raw coordinates.
