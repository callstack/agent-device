# iOS simulator boot and native build overlap

## Change

The iOS smoke lane starts its selected simulator before the generic native build.
The build runs while CoreSimulator completes boot.
A required boot-status barrier runs before the XCTest platform checks and public CLI preflight.
The barrier keeps the existing 300-second wait limit and propagates native failures.
Other users of the boot action still wait before the action returns.
No test selection or runtime policy changes.

## Hosted baseline

[Apple run 39287002947](https://github.com/callstack/agent-device/actions/runs/39287002947/job/118176526594), source `14f32fb218ac9e5608012bf6a5805652dc61f7fc`, passed in 23m49s.
The native runner preparation took 74.238s.
The subsequent simulator preparation took 109.032s.
These phases ran serially.
Their times show an overlap opportunity, not a promised hosted saving.

## Local comparison

The native sources are from base `f8eddcbda35b4b1ee4e28de963925c77d77eab56`.
Only workflow ordering and the shared wait script differ.
The host uses Xcode 26.2 and iOS 26.2 on arm64.
Each sample creates a fresh iPhone 17 Pro simulator and a separate DerivedData directory.
The build uses `scripts/build-xcuitest-apple.sh`, unit-test inclusion, arm64, and `generic/platform=iOS Simulator`.
The serial sample builds before it starts boot.
The overlap sample starts boot before it builds.
Both samples then require `scripts/wait-for-ios-simulator.sh <udid> 300` to succeed.
Creation, shutdown and deletion are outside the measured preparation interval.
All four native builds and boot barriers pass.

| Order | Native build | Preparation wall time |
| --- | ---: | ---: |
| 0-serial | 12.834s | 41.556s |
| 1-overlap | 17.644s | 29.006s |
| 2-overlap | 17.687s | 30.299s |
| 3-serial | 15.872s | 39.922s |

The two-sample means are 40.739s serial and 29.653s overlapping.
The observed saving is 11.086s (27.2%) for preparation on this host.
Overlap makes each build slower, but reduces the combined preparation time in both comparisons.
These are local samples with evolving system caches, not controlled hosted speed evidence.
The hosted lane uses a different Xcode and simulator image.
Hosted Apple CI must confirm correctness and total job cost.

## Failure controls and cleanup

The focused workflow suite passes 40 tests.
It executes the boot action with fake platform tools.
It verifies deferred boot, default blocking behavior, invalid-policy rejection, native failure propagation, and the mandatory readiness barrier before XCTest.
An injected alarm exit verifies the timeout branch without sleeping through a timeout in unit tests.
The real native comparisons above use the actual bounded wait.

All four owned simulators were shut down and deleted.
Other devices were not changed.
Commands, native build logs, boot logs and results remain under `/private/tmp/pr-apple-boot-benchmark`.
