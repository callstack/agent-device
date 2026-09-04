# iOS Simulator snapshot-source live evidence

- Issue: #2196
- Observed: 2026-09-04T09:03:35Z
- Revision: `6d39faaa6a36a010b346d36bd576194d936115ac`
- Target: verified booted `iPhone 17 Pro` Simulator, iOS 26.2
- UDID: `F7D6F9A4-4FCC-4DD7-AC0B-3280C9319CB9`
- App: `Agent Device Tester` (`com.callstack.agentdevicelab`), PID `60439`
- Workflow: `agent-device open` established the session; the private facet was then called directly with an injected host and raw projection. No production routing or proxy path was used.

## Result

| Measurement | Observed |
|---|---:|
| Acquisition latency | 2560 ms |
| Raw nodes | 77 |
| Truncated | false |
| Viewport | 402 x 874 |
| Producer | `simulator-ax-bridge` |
| Intent | `full` |
| Residue | `hittability` unavailable |

The returned lineage carried the supplied target id and opaque generation. The source returned raw nodes with the observed target PID and did not claim hittability or interaction-query facts.

## Build and cache

- Protocol version: `1`
- Source version: `agent-device-simulator-ax-v1.5.3`
- Source hash: `44e0c10dd5f0bf236c35293999e05d6bfaa740b492a98206da6dc1dec6f7d879`
- Cache key: `0c73362db09451e54089e40d42c8f263`
- The live acquisition used the prepared cache entry; deterministic tests cover cold publish, atomic concurrent publish, corrupt-entry rejection, source invalidation, and toolchain invalidation.

## Package size

- Measured npm artifact at the revision above: 482 files, 1,035,582-byte tarball, 3,512,119 unpacked and clean-installed bytes.
- The exact base/head delta is supplied by the GitHub Size workflow; its base-aware assertion does not require a bridge asset on a base commit that predates this facet.
- The `apple-snapshot-bridge` component contributes 29,684 unpacked bytes across five published source/license/readme files.

## Boundary

- The first live attempt intentionally exercised the original long temp-socket path and failed closed with the guest's typed `socket path is empty or too long` diagnostic. The path was shortened to a per-host-process, target-hashed `/tmp` namespace before the successful retry.
- Native sources compile with `clang -Werror -Wall -Wextra` for the iOS Simulator.
- This is evidence for the private acquisition facet only. It does not authorize production snapshot routing, fallback, XCTest interaction, physical-device support, or a public CLI surface.

## Review reconciliation

The implementation remains one reviewable facet with four ownership layers: native AX acquisition,
the framed wire contract, host-side build/cache, and helper lifecycle. The tests and gates stay beside
those layers, including a native-source wire parity fixture. The change is intentionally not split into
independently publishable commits because each layer is unusable without the adjacent protocol and
lifecycle contract.

| Retained growth | Scope kept in the facet |
|---|---|
| Native runtime | Private AX binding, strict tree materialization, watchdog, and bounded response framing |
| Host/cache | Toolchain-aware atomic build cache and clean-installed native source validation |
| Lifecycle/wire | Per-simulator generation routing, persistent helper reuse, typed failures, and reap recovery |
| Proof | Vitest coverage topology, native/TypeScript vocabulary parity, size base/head handling, and live evidence |

The smaller alternatives were rejected for concrete boundary reasons: a generic cancellation protocol
cannot interrupt the synchronous private AX call safely, so a per-request native watchdog plus exact
helper reap is the bounded failure path; exposing host/cache injection would make test seams part of
the public contract, so injection remains internal; and hashing the whole source directory would make
README, license, and other package-only files rebuild the binary, so the cache fingerprints only the
three native compile inputs.
