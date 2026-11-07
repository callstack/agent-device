# ADR 0009: Apple platform consolidation

## Status

Accepted. [ADR 0019](0019-request-bound-platform-runtime.md) supersedes the original platform-plugin shape and owns the package and request-bound runtime seam.
Each command cuts over to the new execution path in one atomic step.
Shared physical mechanics move only through ADR 0019's legal injected substrate transition or after their last legacy user.

## Context

Apple support shared an engine while presenting asymmetric iOS, tvOS, and macOS models.
Inferring the OS from the target lost information, and the structure did not model iPadOS, visionOS, or watchOS.
The XCTest runner builds iOS, macOS, and tvOS from one project.

## Decision

Model Apple OSes with an `AppleOS` discriminant (`ios | ipados | tvos | watchos | visionos | macos`) under one `apple` Platform.
Do not use six `Platform` literals.
Keep the OS-agnostic Apple engine in the Apple platform package's core and genuinely per-OS code in its OS leaves.
Express per-OS capability differences as data keyed by `AppleOS` in request-bound runtime facts.
This design composes with the daemon facet and descriptor `platformExecution` declaration in ADR 0008.

Keep macOS as a distinct AppKit leaf with its helper binary and menubar and desktop surface model.
Do not flatten the tvOS focus-only interaction contract, which has no coordinate `tap`, across OSes.
Keep watchOS as an unsupported sentinel: the Apple interactor, gesture admission, and supported-deployment check reject it, and discovery never produces it.
XCUITest cannot drive watchOS UI.

The public wire continues to emit `ios` and `macos` leaves through `PUBLIC_PLATFORMS`.
Internal family ownership must not leak into that compatibility projection.

## Rejected alternatives

- One `Platform` literal per Apple OS: `DeviceTarget` already spans platforms, and a tvOS literal conflicts with the form-factor axis and the single Apple capability and selector model.
- Keep the existing structure: it retains asymmetric and mislabeled support and lossy OS inference without a path to iPadOS or visionOS.
- Exclude macOS: it shares the XCUITest project and was already entangled with the Apple engine. A distinct AppKit leaf preserves its differences.

## Consequences and open gaps

Adding an Apple OS needs a leaf module and a runner-profile row.
Snapshot fidelity is uneven, and the deep-RN AX-server fallback is iOS-simulator-only.

visionOS discovery and simulator deployment are supported.
App deployment is also admitted for CoreDevice-backed physical devices; XCTest-backed physical deployment is unsupported.
Push remains simulator-only.
No public-command coverage is claimed for visionOS or watchOS, and this record does not claim a command-coverage manifest for either leaf.
Net-new visionOS spatial-input QA remains deferred.
