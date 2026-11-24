# ADR 0009: Apple platform consolidation

## Status

Accepted.
This record owns the Apple family and `AppleOS` leaf decision.
[ADR 0019](0019-request-bound-platform-runtime.md) replaces the original shallow `PlatformPlugin` shape and owns the package and request-bound runtime seam.
ADR 0019 owns the cutover and substrate transition rules. Completed migration history is in git history.

## Context

Apple support shared an engine while presenting asymmetric iOS, tvOS, and macOS models.
Inferring the OS from the target lost information, and the structure did not model iPadOS, visionOS, or watchOS.
Distinguishing or adding an Apple OS therefore cost more than its implementation required.
The XCTest runner builds iOS, macOS, tvOS, visionOS, and the watchOS simulator from one project.

## Decision

Model Apple OSes with an `AppleOS` discriminant (`ios | ipados | tvos | watchos | visionos | macos`) under one `apple` Platform.
Do not use six `Platform` literals.
Keep the OS-agnostic Apple engine in the Apple platform package's core and genuinely per-OS code in its OS leaves.
Express per-OS capability differences as data keyed by `AppleOS` in request-bound runtime facts.
The former capability projection is retired; its predicates moved into those facts.
This design composes with the daemon facet and descriptor `platformExecution` declaration in ADR 0008.

Keep macOS as a distinct AppKit leaf with its helper binary and menubar and desktop surface model.
Do not flatten the tvOS focus-only interaction contract, which has no coordinate `tap`, across OSes.
Support watchOS simulators through the shared XCUITest runner.
The runner's host app and UI-test targets build for the watchOS simulator SDK. A SwiftUI host replaces the UIKit host there.
The watchOS leaf (`packages/platform-apple/src/os/watchos/facts.ts`) admits only operations with a watch meaning and refuses every other operation.
The Digital Crown is `scroll` (rotation) and `home` (press). One-finger swipe and pan are admitted. Multi-touch is refused.
Physical watches are out of scope: a watch reaches the Mac only through its paired iPhone.

The public wire continues to emit `ios` and `macos` leaves through `PUBLIC_PLATFORMS`.
Internal family ownership must not leak into that compatibility projection.

## Rejected alternatives

- One `Platform` literal per Apple OS: `DeviceTarget` already spans platforms, and Android TV uses `target: 'tv'`, so a `tvos` literal would conflict with the form-factor axis.
  Every Apple branch site would need to enumerate six literals, and the single-bucket `apple` capability and selector model would break.
- Keep the existing structure: it retains asymmetric and mislabeled support and lossy OS inference without a path to iPadOS or visionOS.
- A separate watchOS runner project or a watchOS plugin: both would fork the runner sources and the Apple engine. The watch differences are a few `os(watchOS)` guards and one fact leaf.
- Exclude macOS: it shares the XCUITest project, and its code already lived in the shared Apple engine, so exclusion would keep the incorrect label.
  A distinct AppKit leaf normalizes macOS without making it the same as the other OSes.

## Consequences and open gaps

Adding a first-class Apple OS is cheap: it needs a leaf module and a runner-profile row.
Snapshot fidelity is uneven, and the deep-RN AX-server fallback serves iOS only: Simulators and physical devices, not tvOS, visionOS, watchOS, or macOS.

visionOS discovery and simulator deployment are supported.
App deployment is also admitted for CoreDevice-backed physical devices; XCTest-backed physical deployment is unsupported.
Push remains simulator-only.
As of 2026-08, no public-command coverage is claimed for visionOS.
This record states the boundary without a command-coverage manifest for that leaf.
The watchOS command boundary is the leaf's admission set; its evidence is in #4735 and #4738.

Decision history: until 2026-11 this record kept watchOS as an unsupported sentinel because "XCUITest cannot drive watchOS UI".
Spike #4735 showed that the watchOS simulator SDK ships XCUIAutomation and that the existing runner builds and runs there.
Net-new visionOS spatial-input QA remains deferred.
