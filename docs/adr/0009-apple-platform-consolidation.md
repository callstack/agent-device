# ADR 0009: Apple Platform Consolidation (AppleOS leaf axis)

## Status

Accepted

> **Amended by [ADR 0019](0019-request-bound-platform-runtime.md).** The Apple family and explicit
> `AppleOS` leaf axis remain accepted. The shallow `PlatformPlugin` shape and root
> `src/platforms/**` location are superseded by the lazy platform-module registry and private
> `@agent-device/platform-*` packages. Execution cuts over command-atomically; shared physical
> mechanics move only through ADR 0019's legal injected transition or after their last legacy user.

## Context

Apple support is modeled asymmetrically and is physically smeared across an `ios` directory that is really
the shared Apple engine. `Platform` carries `ios` and `macos` as separate literals, but tvOS is not a
platform at all — it is `platform: 'ios' + target: 'tv'`, with the OS name reconstructed late and lossily by
`resolveApplePlatformName` (`src/kernel/device.ts`). Meanwhile ~697 LOC of macOS code lives inside
`src/platforms/ios/`, `src/platforms/macos/devices.ts` is a 19-line stub that the iOS discovery imports (the
dependency arrow points backwards), and the Apple interactor in `src/core/interactors/apple.ts` reaches into
`platforms/ios`. A four-investigator survey found that ~85% of `platforms/ios` (the runner stack,
tool-provider, discovery, snapshot, screenshot, perf, debug-symbols) is already OS-agnostic, and the XCTest
runner already builds `ios | macos | tvos` from one Xcode project. Distinguishing or adding an Apple OS today
is therefore costly out of proportion to the actual work, and iPadOS/visionOS/watchOS are unmodeled.

## Decision

Model Apple OSes with an **`AppleOS` discriminant** (`ios | ipados | tvos | watchos | visionos | macos`)
under a single `apple` Platform — **not** six `Platform` literals. The OS-agnostic Apple engine consolidates
under `src/platforms/apple/core/`, with genuinely per-OS code in `src/platforms/apple/os/<os>/` leaves;
the Apple plugin is the first instance of the platform-plugin registry (the platform axis of the
completed perfect-shape refactor; see [CONTEXT.md](../../CONTEXT.md) Architecture). Per-OS capability
differences become data keyed by `AppleOS`. The additive,
non-breaking `appleOs` discriminant — the groundwork for this — shipped in #896.

## Alternatives Considered

- Promote each Apple OS to its own `Platform` literal: rejected. `DeviceTarget` (`mobile | tv | desktop`) is
  already cross-platform (Android TV uses `target: 'tv'`), so a `tvos` literal collides with the form-factor
  axis; it would also force the ~15 `isApplePlatform` and ~52 `macos` branch sites to enumerate six literals
  and break the single-bucket `apple` capability/selector model that already works.
- Keep the status quo: rejected — the tvOS/macOS asymmetry, the mislabeled macOS code, and the lossy
  target→OS inference persist, with no path to iPadOS/visionOS.
- Exclude macOS from the consolidation: rejected. macOS is already entangled — it builds via the same XCUITest
  project and ~697 LOC of its code already lives inside `platforms/ios`. Excluding it would leave the
  mislabel in place; including it as a distinct AppKit leaf normalizes it without homogenizing it.

## Consequences

Adding a first-class Apple OS becomes cheap: a leaf module plus a runner-profile row. iOS/iPadOS/tvOS/macOS
are mostly relocate-and-rename (the engine never needed to know which Apple OS it drives); visionOS is scoped
net-new work (XCUITest supports it — a profile row, a build case, `#if os(visionOS)`, a widened discovery
filter, plus real spatial-input QA); watchOS is an explicit **unsupported sentinel** because XCUITest cannot
drive watchOS UI. macOS stays a distinct AppKit leaf (its helper binary and menubar/desktop surface model are
preserved). The tvOS focus-only interaction contract (no coordinate `tap`) must not be flattened across OSes,
and snapshot fidelity is uneven (the deep-RN AX-server fallback is iOS-simulator-only). The internal
`Platform` collapse of `ios`+`macos` into `apple` was the last, highest-diff step; public leaf output
remains a separate compatibility projection.

This composes with ADR 0008 (the descriptor's capability facet) and ADR 0003.

Implementation status as of 2026-08:

- Shipped: the internal `Platform` collapse to `apple`; additive `appleOs` groundwork; the shared
  Apple engine under `src/platforms/apple/core`; macOS leaf files under
  `src/platforms/apple/os/macos`; a dedicated tvOS leaf under `src/platforms/apple/os/tvos`;
  direct internal imports to the Apple modules; the per-`AppleOS` capability table
  (`APPLE_OS_CAPABILITIES`, `src/platforms/apple/capabilities.ts`, parity-pinned against the pre-table
  predicates); the watchOS **unsupported sentinel** (reserved in the `AppleOS` type and interactor-rejected —
  XCUITest cannot drive watchOS UI — never produced by discovery); and visionOS profile/build/discovery
  groundwork.
- Retained compatibility: the public wire still emits `ios`/`macos` leaves through
  `PUBLIC_PLATFORMS`; internal family ownership must not leak into that projection.
- Deferred: net-new visionOS spatial-input QA.

This ADR owns the Apple family/leaf decision. The Phase 3 platform-plugin umbrella (#972) is closed;
ADR 0019 now owns the staged package/runtime seam. Net-new visionOS spatial-input QA remains a
separate follow-up outside the consolidation.
