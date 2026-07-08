# ADR 0004: iOS Snapshot Backend Strategy

## Status

Accepted. Amended after iOS snapshot capture was simplified to two public modes:
regular interactive snapshots and raw diagnostic snapshots.

The current implementation is owned by `RunnerTests+SnapshotCapturePlan.swift`. Capture plans
declare their XCTest backend chain, and structured snapshot quality verdicts make degraded or
recovered output observable end to end.

## Context

Agent Device exposes iOS UI state through snapshots produced by the long-lived XCTest runner. The
runner has two durable snapshot needs:

- agent-facing regular context, where the important contract is the effective user-visible UI,
  fixed controls such as tab bars, and scroll-hidden hints for content outside visible scroll
  containers;
- rich diagnostics and selector disambiguation, where a raw recursive XCTest snapshot is useful
  because it preserves hierarchy, static text, wrappers, scroll containers, and ancestry.

These needs should not share one capture strategy blindly. Recursive `XCUIElement.snapshot()` is
rich, but some real app trees can make XCTest fail with `kAXErrorIllegalArgument` or main-thread
timeouts while the same app remains visually usable. Bluesky is the current known example:
lower-level accessibility services can describe simulator screens even when XCTest recursive
snapshots and typed `XCUIElementQuery` enumeration degrade to no useful child nodes. Physical iOS
devices can show the same XCTest accessibility-channel timeout shape even when no lower-level
semantic backend is available.

This is different from presentation filtering. The daemon's snapshot presentation can hide noisy
or inaccessible nodes, but it cannot recover nodes that XCTest never returns. More filters,
Maestro-specific heuristics, or retries in the daemon would only make this failure slower and less
predictable.

## Decision

Keep XCTest as the default iOS automation runner and split iOS snapshot capture into explicit
strategies:

- **Regular visible strategy**: use recursive XCTest snapshots, emit the effective user-visible
  tree plus visible ancestors and scroll-hidden hints, and fall back through the capture plan when
  XCTest returns sparse output. A node inside a scroll container is user-visible only when it
  intersects both the app viewport and the nearest visible scroll container. Offscreen descendants
  should be visited to set `hiddenContentAbove` / `hiddenContentBelow`, not emitted as normal
  visible nodes. This strategy must not use an arbitrary node-count cutoff: fixed controls that are
  later in traversal order, such as bottom tab bars after long lists, are part of the visible UI
  contract.
- **Raw diagnostic strategy**: use recursive XCTest snapshots for raw snapshots, diagnostics, and
  cases that need hierarchy. Raw output is allowed to be noisy and large; if the transport cannot
  carry the response, fail explicitly instead of silently truncating the tree at a hard node count.
  If XCTest reports a real AX serialization failure, preserve that error instead of pretending the
  UI is empty.
- **Future AX-service strategy**: treat Bluesky-class failures as evidence that XCTest is
  not a complete semantic snapshot backend. A robust semantic fix should add a host-side simulator
  accessibility backend, similar in role to existing simulator accessibility inspection tools,
  and normalize its output into the same `SnapshotNode` model. That backend can be simulator-only;
  physical devices should use an equivalent non-XCTest semantic backend only if Apple exposes a
  supported channel.

The daemon should make degraded output observable. If an iOS interactive snapshot contains only the
application root or another sparse shape, surface a structured quality verdict and warning so
agents know the snapshot is degraded output rather than proof that the screen has no controls.

## Regression Notes

PR #639 made XCTest AX serialization failures explicit instead of swallowing them as empty
snapshots. That was the correct diagnostic change, but it exposed apps whose accessibility trees
XCTest cannot serialize.

Later work moved recovery into the regular visible capture plan so healthy apps keep the fast
recursive tree path while degraded app classes can still return bounded, honest output when
fallback tiers are the only available source of visible controls.

Issue #1105 showed a second failure shape on the same app class: instead of failing fast with
`kAXErrorIllegalArgument`, the recursive tree capture can grind for many seconds on
heavy/animating screens before failing, pushing the chained plan past the runner's main-thread
watchdog and burying the main queue under retries. The plan now carries its umbrella deadline
into the query-sweep and private-AX tiers (later ladder rungs stop when the budget is spent),
and a slow, timed-out, or watchdog-abandoned XCTest-backed capture penalizes the XCTest
accessibility channel for that bundle for a bounded window. Subsequent regular plans derive the
next step from backend traits (`effectiveSnapshotCapturePlan`): when a runnable non-XCTest backend
exists, they defer to that independent tier; when it does not, as on physical iOS devices today,
they run a short XCTest probe instead of the full tree slice so healthy screens can recover without
repeating the hostile-screen grind. The raw diagnostic plan is exempt — it keeps tree-first error
propagation.

## Consequences

Regular snapshots remain the right tool for agents and Maestro compatibility because they describe
what a user can currently perceive and interact with. Raw snapshots remain the right tool when
hierarchy matters. Both may still fail loudly on XCTest-broken trees; that failure is useful
because retrying the same recursive capture is unlikely to reveal a different tree.

A future AX-service backend is the correct place to regain Bluesky-class semantic coverage. It
should be added as a platform backend with its own lifecycle, protocol, normalization, timing
metrics, and fallback rules, not as another special case inside the XCTest runner.

When adding new iOS snapshot behavior, maintainers should first decide which strategy owns it. If a
change tries to make regular snapshots fast by dropping visible controls behind a node budget, or
tries to make raw snapshots safe by silently truncating, it is probably crossing strategy
boundaries.
