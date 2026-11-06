# Simulator AX bridge

This directory contains the small private accessibility reader used by the
Apple platform acquisition facet. The framed server lives in
`SnapshotBridge.m`; request validation lives in `SnapshotBridgeRequest.m`;
private runtime binding lives in `SnapshotBridgeRuntime.m`. It is compiled for the iOS Simulator on first use
and is never downloaded, pre-signed, or built by npm installation. It serves
iPhone and iPad Simulators, which both run the iOS Simulator runtime (#3844).

The guest process uses the `XCTAccessibilityFramework` remote-access client
from the simulator runtime and the `userTestingSnapshotForElement:options:error:`
snapshot API. Requests and responses are length-prefixed JSON frames:

```text
uint32 big-endian byte length
UTF-8 JSON object
```

The host owns all target identity, bounds, deadlines, and lifecycle decisions.
A successful response carries only a bounded raw tree, the target pid,
truncation, and protocol/source versions. A refusal carries the target pid, a
typed error kind and code, and, for a running surface host, the
`surfaceHostExecutable` it found. It does not expose an HTTP route or a public
CLI surface.

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
not replace the native primary owner. An ownership refusal is evidence about
the screen, so the route sends only that capture to XCTest and keeps the app
generation on the bridge.

## System surface hosts

A registered system surface host, such as `SafariViewService` for a web sign-in
sheet, presents out of the app's process. While its sheet is up, the app stays
the primary owner, so the ownership check passes over the occluded app tree.
When a request names `surfaceHostExecutables` and `simulatorUdid`, the reader
reads the process table in place before acquisition, and again after an
acquisition that returned a tree. If a process of a named executable carries
this Simulator's `SIMULATOR_UDID` and its executable path ends with the named
executable, it returns the typed refusal
`system-surface-host-present` with `surfaceHostExecutable`, without the app
tree. If it cannot read the process table or place a matching process, it
returns `system-surface-host-unverified`. The host sends that capture to
XCTest and keeps the app generation on the bridge, because both refusals are
evidence about the screen. The host omits the check when a ready runner already
reported every host off screen.

## Window placement

The snapshot API reports the frames of an app that runs in an iPadOS window
(Windowed Apps or Stage Manager) relative to that window, not to the screen.
Before acquisition, the reader compares the AXRuntime frame of the primary app
with the frame of the system app. Both frames use the native space of the
screen, also in landscape. If they differ, the reader returns `app-window-not-full-screen` without
the app tree. Like an ownership refusal, this is evidence about the screen, so
the route sends only that capture to XCTest. If the runtime cannot report either
frame, the reader keeps the capture.

## Remote content

The reader snapshots one process. Two hosts put another process's UI into that
tree as an `AXRemoteElement` leaf: a WebKit page — Safari's or a `WKWebView`'s —
lives in a WebContent process under the web view, and a scene-hosted remote view
controller, such as a share extension presented over the app, lives in the
extension's process under a `_UISceneHostingView`. The guest returns the leaf as
delivered; the host refuses a tree in which such a leaf sits under either host
and reaches the viewport, or reports no frame (`remote-content-boundary`), and
routes that app generation to XCTest, which resolves remote elements (#2484). A
zero-area or off-screen leaf is published: it hosts nothing the capture can miss.

## Coordinate space

The bridge cannot name the app's interface orientation.
The AX attribute `XC_kAXXCAttributeApplicationOrientation` (id 1503) resolves but reads 0 through the guest's snapshot channel.
Through XCTest's own reader, the same attribute fails with `kAXErrorServerNotFound`.
The only cheap service read is device orientation, which differs from the app's orientation on a rotation-locked app (#2659).
Thus, the host decoder counts window roots that report the app's box turned through a quarter.
If it finds one, it refuses the capture (`window-coordinate-space-unresolved`, kind `unsupported`), and the route uses the runner, which reads the orientation.
This refusal is evidence about the screen, so it has capture scope.

## Tree changes between reads

The reader reads a node again when the first read withheld its children.
If the second read returns fewer children than the first read counted, the screen moved between the reads, as a scrolling list does when it recycles its cells.
The reader then refuses with `snapshot-tree-changed`.
This refusal has capture scope, so the next capture of the same app uses the bridge again.

## Trait typing

An iPadOS floating tab bar draws each item as a collection-view cell that holds an item view.
Neither node carries the button trait, but both carry the private tab-button trait (bit 28).
XCTest types such an element as `Button`, and the decoder does the same.
Otherwise, a `role=button` tab selector that matches the runner tree does not match the bridge tree.

A custom-drawn text input, such as a Compose Multiplatform text field, reports the automation type `Other` with the private text-entry trait (bit 18).
The decoder types such an element as `SecureTextField` with bit 24, else `SearchField` with bit 10, else `TextView` with bit 47, else `TextField`.
The decoder keeps a declared automation type.
Otherwise, the bridge tree reports the input as not editable, and a `fill` client refuses it.
Only the `TextView` case (bits 18, 33, and 47, from a Compose Multiplatform 1.12 `BasicTextField` on iOS 27) is captured live.
The other three cases and their order follow the trait names.

## Dimming views

Modal containment needs the `userInteractionEnabled` state of UIKit's dimming view.
The reader reads that attribute for dimming views only, with one follow-up read for each view.
A request for it on every node increases the capture time by about half on a large tree.
The presentation rule is in [`../snapshot-presentation/README.md`](../snapshot-presentation/README.md#modal-containment).

## Runner-served reader

A provider iOS Simulator, such as one on Limrun, cannot run the guest process.
There, the XCTest runner includes the reader sources of this directory and leaves out the socket server.
The `snapshotBridge` runner command reaches the reader through the runner's forwarded HTTP transport.
The runner answers that command on its own serial queue, off its journal and off the XCTest main thread.
The reader's accessibility calls run on a private serial queue.

The guest process ends itself when a read outlives its budget, because nothing can stop an accessibility call that never returns.
The runner must not end itself, because it also runs every XCTest command.
The runner abandons such a read (`bridge-read-abandoned`).
The runner admits one read at a time.
Until the admitted read returns, the runner refuses each new read (`bridge-read-in-flight`, capture scope).
After an abandoned read stays in flight for five seconds, the runner refuses with `bridge-reader-wedged`.
That refusal retires the bridge for the runner session, across app generations.
The route clears its circuit and cached targets when the runner session changes.
The runner does not replace the reader queue, because a second concurrent accessibility read is not proven safe.
The daemon gives the runner its read budget minus a transport margin, so the runner abandons a slow read before the daemon loses the reply.

The daemon cannot list the provider Simulator's processes, so the runner names the app generation.
The `target` verb returns the pid and the process start time of the app's foreground process.
The `describe` verb refuses another process of the same app with `target-process-changed`.
The daemon keeps the target until a read refuses it with `target-process-changed`.
On a `targetFreshness: 'cached'` channel, the route asks for a fresh target before it trusts an open circuit.
If that request fails, the channel keeps its cached target, and the capture names no generation.

For the system-surface proof, the runner reads the process table of the Simulator that it runs in.
A sandbox that refuses that table gives `system-surface-host-unverified`, and the capture uses XCTest.

## Bounded depth recovery

A healthy capture uses one native request. If native acquisition rejects it,
`SnapshotBridgeCapture.m` retries supported native failure codes at lower depths
and fetches withheld children from their accessibility elements. The completed
tree keeps the original depth and node limits; partial trees disclose
truncation. The traversal depth counts edges below the root; native requests
count the root as one level. One native request reads at most 65 levels; deeper
levels, up to the 128-level bound, arrive through continuations. On deep trees
the AX server rejects a request that would return more than about 62 levels, so
there the first request is rejected once and the lower-depth retry applies. Each
acquisition allows two lower-depth retries, and recovery allows at most 64
native requests within the existing capture deadline, checks foreground
ownership on every request, and returns a failure when it cannot complete a
continuation. Budget exhaustion and malformed continuations use non-launch
failure codes, so the route falls back without launch re-polling. At each native
fragment boundary, an absent or invalid child count means unknown completeness
and fails closed. Natural leaves above that boundary need no continuation
evidence. Unchanged native dictionaries and child arrays are reused.

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
