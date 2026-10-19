# ADR 0009: Apple Platform Consolidation (AppleOS leaf axis)

## Status

Accepted

Completed process history is in git history.

> **Amended by [ADR 0019](0019-request-bound-platform-runtime.md).** The Apple family and explicit `AppleOS` leaf axis remain accepted.
> The lazy platform-module registry and private `@agent-device/platform-*` packages supersede the shallow `PlatformPlugin` shape and root `src/platforms/**` location.
> Each command cuts over to the new execution path in one atomic step.
> Shared physical mechanics move only through ADR 0019's legal injected substrate transition or after their last legacy user.

## Rules at a glance

- Use one `apple` Platform with an `AppleOS` discriminant, not six Platform literals.
- Keep the OS-agnostic Apple engine in `packages/platform-apple/src/core/` and genuinely per-OS code in `packages/platform-apple/src/os/<os>/` leaves.
- Express per-OS capability differences as data keyed by `AppleOS`.
- Keep macOS as a distinct AppKit leaf.
- Do not flatten the tvOS focus-only interaction contract across OSes.
- Keep watchOS as an unsupported sentinel. Discovery never produces it.
- Internal family ownership must not leak into the public `ios`/`macos` leaf projection.
- As of 2026-08, no public-command coverage is claimed for visionOS or watchOS. Net-new visionOS spatial-input QA is deferred.

## Context

Apple support uses an asymmetric model.
Physically, Apple support is spread across an `ios` directory, and that directory is actually the shared Apple engine.
`Platform` has separate `ios` and `macos` literals.
However, tvOS is not a platform: it is `platform: 'ios' + target: 'tv'`.
`resolveApplePlatformName` in `src/kernel/device.ts` reconstructs the OS name late and loses information.
Approximately 697 LOC of macOS code resides in `src/platforms/ios/`.
`src/platforms/macos/devices.ts` is a 19-line stub imported by iOS discovery, which reverses the intended dependency direction.
The Apple interactor in `src/core/interactors/apple.ts` also imports from `platforms/ios`.

A survey by four investigators found approximately 85% of `platforms/ios` already OS-agnostic:

- Runner stack.
- Tool-provider.
- Discovery.
- Snapshot.
- Screenshot.
- Perf.
- Debug-symbols.

The XCTest runner already builds `ios | macos | tvos` from one Xcode project.
Thus, distinguishing or adding an Apple OS costs more than its actual implementation requires.
iPadOS, visionOS, and watchOS have no model.

## Decision

Model Apple OSes with an **`AppleOS` discriminant** (`ios | ipados | tvos | watchos | visionos | macos`) under one `apple` Platform.
Do not use six `Platform` literals.
Consolidate the OS-agnostic Apple engine under `packages/platform-apple/src/core/`.
Keep genuinely per-OS code in `packages/platform-apple/src/os/<os>/` leaves.
The Apple plugin is the first instance of the platform-plugin registry.
The registry and enforcement paths named below are authoritative.
Per-OS capability differences become data keyed by `AppleOS`.

## Alternatives Considered

- **Give each Apple OS its own `Platform` literal.** Rejected.
  `DeviceTarget` (`mobile | tv | desktop`) already spans platforms.
  Android TV uses `target: 'tv'`, so a `tvos` literal would conflict with the form-factor axis.
  Approximately 15 `isApplePlatform` sites and approximately 52 `macos` branch sites would need to enumerate six literals.
  This would also break the working single-bucket `apple` capability/selector model.
- **Keep the existing structure.** Rejected.
  It retains tvOS/macOS asymmetry, mislabeled macOS code, and lossy target→OS inference without a path to iPadOS/visionOS.
- **Exclude macOS from consolidation.** Rejected.
  macOS is already entangled.
  It builds through the same XCUITest project, and approximately 697 LOC of its code resides in `platforms/ios`.
  Exclusion would retain the incorrect label.
  A distinct AppKit leaf normalizes macOS without making it the same as the other OSes.

## Consequences

Adding a first-class Apple OS becomes cheap: it needs a leaf module and a runner-profile row.
iOS/iPadOS/tvOS/macOS mostly require moves and renames because the engine never needed to know which Apple OS it drives.
visionOS is scoped net-new work.
XCUITest supports visionOS.
The work includes:

- A profile row.
- A build case.
- `#if os(visionOS)`.
- A wider discovery filter.
- Real spatial-input QA.

watchOS is an explicit **unsupported sentinel** because XCUITest cannot drive watchOS UI.
macOS remains a distinct AppKit leaf, and its helper binary and menubar/desktop surface model are preserved.
The tvOS focus-only interaction contract, with no coordinate `tap`, must not be flattened across OSes.
Snapshot fidelity is uneven.
The deep-RN AX-server fallback is iOS-simulator-only.
Public leaf output remains a separate compatibility projection.

This design composes with the daemon facet and the descriptor `platformExecution` declaration in ADR 0008.
Per-OS behavior is data in request-bound runtime facts.

Implementation status as of 2026-08:

- Shipped:
  - The internal `Platform` collapse to `apple`.
  - Additive `appleOs` groundwork.
  - The shared Apple engine under `packages/platform-apple/src/core`.
  - macOS leaf files under `packages/platform-apple/src/os/macos`.
  - A dedicated tvOS leaf under `packages/platform-apple/src/os/tvos`.
  - Direct internal imports to the Apple modules.
  - The per-`AppleOS` runtime facts, including `packages/platform-apple/src/gesture-facts.ts`.
    The former capability projection was retired after its predicates moved into request-bound facts.
  - The watchOS **unsupported sentinel**.
    The `AppleOS` type reserves watchOS, and the interactor rejects it.
    XCUITest cannot drive watchOS UI.
    `isSupportedAppleDeploymentLeaf`, the Apple interactor, and gesture admission reject it.
    Discovery never produces it.
  - visionOS profile/build/discovery, plus simulator-deployment evidence.
- Decision-only support boundary:
  - visionOS discovery and simulator deployment are supported and unit-tested in `packages/platform-apple/src/inventory-classification.test.ts` and `packages/platform-apple/src/deployment/runtime.test.ts`.
  - App deployment is also admitted for CoreDevice-backed physical devices.
  - XCTest-backed physical deployment is unsupported.
  - Push remains simulator-only.
  - No public-command coverage is claimed for visionOS or watchOS.
  - This ADR records this boundary without a command-coverage manifest for either leaf.
- Retained compatibility: the public wire still emits `ios`/`macos` leaves through `PUBLIC_PLATFORMS`.
  Internal family ownership must not leak into that projection.
- Deferred: net-new visionOS spatial-input QA.

This ADR owns the Apple family/leaf decision.
ADR 0019 now owns the staged package/runtime seam.
Net-new visionOS spatial-input QA remains a separate follow-up outside the consolidation.
