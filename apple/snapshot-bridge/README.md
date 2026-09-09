# Simulator AX bridge

This directory contains the small private accessibility reader used by the
Apple platform acquisition facet. The framed server and request validation
live in `SnapshotBridge.m`; private runtime binding lives in
`SnapshotBridgeRuntime.m`. It is compiled for the iOS Simulator on first use
and is never downloaded, pre-signed, or built by npm installation.

The guest process uses the `XCTAccessibilityFramework` remote-access client
from the simulator runtime and the `userTestingSnapshotForElement:options:error:`
snapshot API. Requests and responses are length-prefixed JSON frames:

```text
uint32 big-endian byte length
UTF-8 JSON object
```

The host owns all target identity, bounds, deadlines, and lifecycle decisions.
The guest returns only a bounded raw tree, the target pid, truncation, and
protocol/source versions. It does not expose an HTTP route or a public CLI
surface.

The private API is intentionally pinned to the idb v1.5.2-compatible shape.
See `LICENSE.idb` for attribution.

## Why Objective-C

The selected #2192 mechanism was idb v1.5.2's Objective-C
`SimulatorFrameworkBridge`; the Python used during the spike was only a client
for exercising that guest reader. This bridge keeps the proven native boundary
and removes the Python/idb client dependency.

Objective-C is the narrowest implementation for this private runtime adapter:
it resolves unavailable classes and functions with `dlopen`, `dlsym`, and the
Objective-C runtime, invokes dynamically discovered selectors, and contains
`NSException` failures. A Swift implementation would still require an
Objective-C shim for those operations, adding another native boundary. Keeping
the guest in Objective-C also allows direct lazy compilation with `clang`
without an Xcode project or Swift module for private headers.

## Foreground ownership

The reader checks AXRuntime's primary foreground application before and after
acquisition. If the target is covered by system UI, ownership is unavailable,
or the owner changes during capture, it returns a typed failure without the
app tree. The existing route then uses XCTest, which owns system-modal
resolution. Secondary owners such as the return-to-app status-bar control do
not replace the native primary owner. The route's generation circuit remains
disabled after fallback until that app relaunches.

## Bounded depth recovery

A healthy capture uses one native request. If native acquisition rejects it,
`SnapshotBridgeCapture.m` retries supported native failure codes at lower depths
and fetches withheld children from their accessibility elements. The completed
tree keeps the original depth and node limits; partial trees disclose truncation.
The traversal depth counts edges below the root; native requests count the root
as one level. Each acquisition allows two lower-depth retries, and recovery
allows at most 32 native requests within the existing capture deadline,
checks foreground ownership on every request, and returns a failure when it
cannot complete a continuation. Budget exhaustion and malformed continuations
use non-launch failure codes, so the route falls back without launch re-polling.
At each native fragment boundary, an absent or invalid child count means unknown
completeness and fails closed. Natural leaves above that boundary need no
continuation evidence. Unchanged native dictionaries and child arrays are reused.

## Accepted-depth hints

The host source (`packages/platform-apple/src/snapshot-source/depth-hints.ts`)
remembers the native levels a finished recovery accepted, keyed by the resolved
target id, its app generation, and this producer. The next capture of that
generation sends `nativeLevelsHint`, so the guest's first request asks for the
accepted levels instead of re-paying the known rejection. A hint changes the
request strategy only: the delivered depth, node bounds, and completeness rules
are unchanged. Hints are learned only from a recovery that observed a rejection
and then finished (a tree bounded by the requested depth or node budget still
teaches), never cross apps, generations, or producers, and expire after eight
hinted captures so the next capture probes the full depth again; a capture that
merely succeeds at the hinted depth does not renew it. Explicit raw-depth
requests neither use nor teach hints. Every response carries `recovery`
(`requests`, `rejected`, `continuations`, `acceptedLevels`), which the host
emits as the `ios_snapshot_source_recovery` diagnostic.

## Recovery conformance

`contracts/fixtures/ios-ax-recovery-conformance.json` is the shared, executable
recovery contract for this bridge and the XCTest runner's private AX bridge.
`packages/platform-apple/src/snapshot-source/fixtures/recovery-conformance.m`
replays each case through `captureSnapshotTree`; the runner replays the same
cases through its own bridge in
`RunnerTests+AXRecoveryConformanceTests.swift`. Each expectation names the
outcome, the native request accounting, and the delivered tree as a canonical
preorder signature with its retained node count, so a producer that drops,
duplicates, reorders, or re-parents nodes cannot pass as complete. The fixture
records each producer's expectation and documents the intentional differences
(depth vocabulary, ladders, completeness evidence, budgets, hint lifetime).
