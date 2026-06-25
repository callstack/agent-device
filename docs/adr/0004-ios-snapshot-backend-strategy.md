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
rich, but some real simulator app trees can make XCTest fail with `kAXErrorIllegalArgument` while
the same app remains visually usable and can be inspected by lower-level simulator accessibility
services. Bluesky is the current known example: Argent's `ax-service` can describe the screen, but
XCTest recursive snapshots and typed `XCUIElementQuery` enumeration can degrade to no useful child
nodes.

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
- **Private AX fallback strategy**: treat Bluesky-class failures as evidence that XCTest is not a
  complete semantic snapshot backend. The in-runner private AX request path may be attempted after
  XCTest returns sparse output when the runtime exposes it, including on physical iOS devices, but
  it is still a fallback: sparse private AX output must remain observable and must not be presented
  as proof that the UI is empty. When the user requested a shallow depth and iOS returns only
  wrappers/chrome instead of the expected content, the warning should recommend bounded retries
  from deepest to shallower, such as `snapshot -i -d 56`, then `-d 40`, then `-d 24`, before
  treating the screen as blocked. A more
  robust semantic fix should add a host-side simulator accessibility backend, similar in role to
  `idb` accessibility commands or Argent's `ax-service`, and normalize its output into the same
  `SnapshotNode` model.

The daemon should make degraded output observable. If an iOS interactive snapshot contains only the
application root or another sparse shape, surface a structured quality verdict and warning so
agents know the snapshot is degraded output rather than proof that the screen has no controls.
Do not expose a `healthy` verdict as a user-facing guarantee when no degraded condition was found:
absence of a warning is enough. `healthy` is an internal plan-acceptance state, not proof that the
app exposed every useful control.

## Regression Notes

PR #639 made XCTest AX serialization failures explicit instead of swallowing them as empty
snapshots. That was the correct diagnostic change, but it exposed apps whose accessibility trees
XCTest cannot serialize.

Later work moved recovery into the regular visible capture plan so healthy apps keep the fast
recursive tree path while degraded app classes can still return bounded, honest output when
fallback query or private AX tiers are the only available source of visible controls. Physical
device verification against X showed that root wrapper identifiers such as `TwitterAppRootView`
must not make an Application/Window-only tree look healthy.

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
