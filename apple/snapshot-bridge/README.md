# Simulator AX bridge

This directory contains the small private accessibility reader used by the
Apple platform acquisition facet. The framed server and request validation
live in `SnapshotBridge.m`; private runtime binding lives in
`SnapshotBridgeRuntime.m`. It is compiled for the iOS Simulator on first use
and is never downloaded, pre-signed, or built by npm installation.

The guest process uses the `XCTAccessibilityFramework` remote-access client
from the simulator runtime and the `userTestingSnapshotForElement:options:error:`
single-fetch API. Requests and responses are length-prefixed JSON frames:

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
