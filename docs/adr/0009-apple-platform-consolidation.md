# ADR 0009: Apple Platform Consolidation (AppleOS leaf axis)

## Status

Accepted

Completed process history is in git history.

> **Amended by [ADR 0019](0019-request-bound-platform-runtime.md).** The Apple family and explicit `AppleOS` leaf axis remain accepted.
> The lazy platform-module registry and private `@agent-device/platform-*` packages supersede the shallow `PlatformPlugin` shape and root `src/platforms/**` location.
> Each execution migration covers one complete command.
> Shared physical mechanics move only through ADR 0019's permitted injected transition or after their last legacy consumer.

## Rules at a glance

- Use one `apple` Platform with an `AppleOS` discriminant, not six Platform literals.
- Keep shared Apple mechanics in `packages/platform-apple/src/core/` and per-OS code in `packages/platform-apple/src/os/<os>/`.
- Express per-OS capability differences as data keyed by `AppleOS`.
- Preserve macOS's distinct AppKit leaf and tvOS's focus-only interaction contract.
- Keep watchOS as an unsupported sentinel. Discovery never produces it.
- Keep public `ios`/`macos` output separate from internal family ownership.
- Do not claim public-command coverage for visionOS or watchOS. visionOS spatial-input QA remains deferred.

## Context

Apple support uses an asymmetric model.
An `ios` directory contains much of the shared Apple engine.
`Platform` has separate `ios` and `macos` literals, but tvOS uses `platform: 'ios' + target: 'tv'`.
`resolveApplePlatformName` in `src/kernel/device.ts` reconstructs the OS name late and loses information.
Approximately 697 LOC of macOS code resides in `src/platforms/ios/`.
`src/platforms/macos/devices.ts` is a 19-line stub imported by iOS discovery, which reverses the intended dependency direction.
The Apple interactor in `src/core/interactors/apple.ts` also imports from `platforms/ios`.

A survey by four investigators found approximately 85% of `platforms/ios` already OS-neutral:

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
Consolidate the OS-neutral Apple engine under `packages/platform-apple/src/core/`.
Keep genuinely per-OS code in `packages/platform-apple/src/os/<os>/` leaves.
The Apple plugin is the first instance of the platform-plugin registry.
Per-OS capability differences become data keyed by `AppleOS`.

## Alternatives Considered

- **Give each Apple OS its own `Platform` literal.** Rejected.
  `DeviceTarget` (`mobile | tv | desktop`) already spans platforms.
  Android TV uses `target: 'tv'`, so a `tvos` literal would conflict with the form-factor axis.
  Approximately 15 `isApplePlatform` sites and 52 `macos` branches would need to enumerate six literals.
  This would also break the working single-bucket `apple` capability/selector model.
- **Keep the existing structure.** Rejected.
  It retains tvOS/macOS asymmetry, mislabeled macOS code, and lossy target→OS inference without a path to iPadOS/visionOS.
- **Exclude macOS from consolidation.** Rejected.
  macOS already builds through the same XCUITest project, and approximately 697 LOC resides in `platforms/ios`.
  Exclusion would retain the incorrect label.
  A distinct AppKit leaf normalizes ownership while preserving macOS-specific behavior.

## Consequences

A first-class Apple OS needs only a leaf module and runner-profile row for the shared structure.
iOS/iPadOS/tvOS/macOS mostly require moves and renames because the engine does not need the specific Apple OS.
visionOS requires scoped new work because XCUITest supports it:

- A profile row.
- A build case.
- `#if os(visionOS)`.
- A wider discovery filter.
- Real spatial-input QA.

watchOS is an explicit **unsupported sentinel** because XCUITest cannot operate its UI.
macOS remains a distinct AppKit leaf with its helper binary and menubar/desktop surface model.
The tvOS focus-only interaction contract, with no coordinate `tap`, must remain distinct across OSes.
Snapshot fidelity is uneven.
The deep-RN AX-server fallback is iOS-simulator-only.
Public leaf output remains a separate compatibility projection.

This design composes with ADR 0008's descriptor capability facet and ADR 0003.

The support boundary includes:

- Internal `Platform` ownership uses `apple`, with additive `appleOs`.
- The shared Apple engine resides under `packages/platform-apple/src/core`.
- macOS leaf files reside under `packages/platform-apple/src/os/macos`.
- A dedicated tvOS leaf resides under `packages/platform-apple/src/os/tvos`.
- Internal imports access Apple modules directly.
- Per-`AppleOS` runtime facts include `packages/platform-apple/src/gesture-facts.ts`.
  The former capability projection's predicates now belong to request-bound facts.
- `AppleOS` reserves watchOS, but the interactor rejects it.
  `isSupportedAppleDeploymentLeaf`, the Apple interactor, and gesture admission all reject watchOS.
  Discovery never produces it.
- visionOS has profile/build/discovery support and simulator-deployment evidence.

visionOS discovery and simulator deployment are supported and unit-tested in `packages/platform-apple/src/inventory-classification.ts` and `packages/platform-apple/src/deployment/runtime.test.ts`.
CoreDevice-backed physical devices also admit app deployment.
XCTest-backed physical deployment remains unsupported.
Push remains simulator-only.
No public-command coverage is claimed for visionOS or watchOS.
This ADR records that decision-only boundary without a command-coverage manifest for either leaf.

The public wire retains `ios`/`macos` leaves through `PUBLIC_PLATFORMS`.
Internal family ownership must not enter that projection.
New visionOS spatial-input QA remains deferred.

This ADR owns the Apple family/leaf decision.
ADR 0019 owns the staged package/runtime boundary.
New visionOS spatial-input QA remains a separate follow-up outside consolidation.
