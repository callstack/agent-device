# iOS Simulator AX bridge spike

- Decision: **NO-GO**
- Status: **stopped**
- Revision: 590705e193fb65421b5faffa7573cc1108bbf972 (codex/2192-ios-ax-bridge-spike)
- Target: AgentDevice-2192-AX-20260901 (793B72F6-02C9-4BCD-BEC9-1B3EB42A7ED4, com.apple.CoreSimulator.SimRuntime.iOS-27-0)
- Generated: 2026-09-01T07:42:38.929Z
- Corpus: states=cold-cold, cold, warm, relaunch, screens=quiet, list, nested-scroll, alert, system-surface, xctest-stress, samples=20

## Environment and limits

- Node: v26.7.0
- pnpm: 11.19.0
- Xcode: Xcode 27.0; Build version 27A5252f
- simctl: @(#)PROGRAM:simctl  PROJECT:CoreSimulator-1171.6
- Swift: Apple Swift version 6.4 (swiftlang-6.4.0.33.1 clang-2100.3.33.1)
Target: arm64-apple-macosx27.0.0
- OS: darwin 27.0.0; arch=arm64
- Bounds: request=65536 B, response=4194304 B, nodes=1500, traversal=12, CPU=2000 ms, memory=268435456 B, duration=5000 ms

## Dependency and fixture provenance

- #2190 exact live prerequisite head: `bce60b56fb5c5c8d57247e0946fa1fd540e292a1` (`codex/refactor/ios-snapshot-contracts`, PR #2203).
- #2189 exact foundation used for this evidence: `e90b7763c8023857a054954ac200a95825ffae12`.
- Current integrated #2189 prerequisite head: `747a939adbdf15332463736241ab140180b41d9f` (`codex/2189-ios-snapshot-baselines`, PR #2204). This prerequisite-only update followed the evidence revision; the run produced no acquisition cells or latency claims.
- The fixture dependency install completed with `pnpm test-app:install`; that command installs the example app dependencies and does not produce an iOS `.app`.
- Direct fixture build command:
  `xcodebuild -workspace examples/test-app/ios/AgentDeviceTester.xcworkspace -scheme AgentDeviceTester -configuration Debug -sdk iphonesimulator -destination id=793B72F6-02C9-4BCD-BEC9-1B3EB42A7ED4 -derivedDataPath .tmp/ios-ax-app-derived CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO build`
- The build stopped at `expo-modules-jsi@56.0.10` `JavaScriptRuntime.swift:219:35` with `a C function pointer can only be formed from a reference to a 'func' or a literal closure`; retrying with `SWIFT_VERSION=5.9` produced the same compiler error. No installable `AgentDeviceTester.app` was produced.
- The fixture run therefore stopped before cell acquisition; no latency result is claimed for the four requested states or six requested screens.

## Candidate fidelity and limitation matrix

| Candidate | Mechanism | App surface | System surface | Lifecycle | Main limitation |
|---|---|---|---|---|---|
| public-macos-ax | public macOS ApplicationServices AX | protocol probe only | protocol probe only | framed protocol | host Accessibility permission and Xcode 27 DeviceHub surface |
| private-coresimulator-ax | external/private CoreSimulator AX tool | protocol probe only | protocol probe only | framed protocol contract only | private interface/tool compatibility |
| xctest-control | #2189 XCTest runner control | not observed (run stopped) | not observed (run stopped) | existing runner lifecycle | control, not a host-side AX bridge |

## Raw acquisition and prototype presentation results

| Candidate | State | Screen | N | Acquisition p50/p95 ms | First look p95 ms | Presentation p50/p95 ms | Nodes | Failures |
|---|---|---|---:|---:|---:|---:|---:|---:|

Acquisition samples retain the raw node payload, viewport evidence, target generation, truncation, residue, and resource metrics. Presentation samples measure only construction of the #2190 acquired carrier; they do not apply visibility, hittability, scope, depth, or semantic compaction.

## Direct protocol probes

- public-macos-ax/protocol-probe:public-macos-ax: ok=false, failure=unsupported-mechanism, code=host-accessibility-permission, nodes=0, duration=27.9 ms, CPU=2.9 ms, memory=9076736 B, response=332 B
- private-coresimulator-ax/protocol-probe:private-coresimulator-ax: ok=false, failure=unsupported-mechanism, code=private-tool-unavailable, nodes=0, duration=0.0 ms, CPU=– ms, memory=– B, response=0 B
- stderr public-macos-ax/protocol-probe:public-macos-ax: [ios-ax-spike] capture id=protocol-probe:public-macos-ax candidate=public-macos-ax screen=quiet
- stderr private-coresimulator-ax/protocol-probe:private-coresimulator-ax: empty

## Independent positive-control evidence

- Invalid shallow rule: exit=1; command=pnpm bench:ios-snapshot:deep-button -- --rule invalid-shallow; assertion=AssertionError: changed descendant was omitted by shallow observation; no-effect claim is invalid.
- Safe full rule: exit=0; command=pnpm bench:ios-snapshot:deep-button -- --rule safe-full; assertion=full observation changed and includes the changed descendant.

## Preference experiment

- Applied: **true**
- Restored: **true**
- Simulator state before experiment: Shutdown
- Private/preboot preference keys are experimental only; they were applied to this shutdown disposable Simulator and the original plist bytes were restored.
- /Users/michal/Library/Developer/CoreSimulator/Devices/793B72F6-02C9-4BCD-BEC9-1B3EB42A7ED4/data/Library/Preferences/com.apple.Accessibility.plist: existed=true, beforeSha256=fbc67ebbd3aa0079a4b4afff4181280731fbb8faaca2ffc623393a8d9c26a436, afterSha256=1b0bc929597307d4b0acd5b7ccf86d93dae01b36c3930ccc2ef69eba12b09610
  - Changes: AccessibilityEnabled: undefined -> true; ApplicationAccessibilityEnabled: undefined -> true; AutomationEnabled: undefined -> true; IgnoreAXServerEntitlements: undefined -> true
- /Users/michal/Library/Developer/CoreSimulator/Devices/793B72F6-02C9-4BCD-BEC9-1B3EB42A7ED4/data/Library/Preferences/com.apple.UIAutomation.plist: existed=true, beforeSha256=db8995177327a963486dd0607260f0fad74ad10d9dec6c2f5abdbaf0dbd00b2c, afterSha256=db8995177327a963486dd0607260f0fad74ad10d9dec6c2f5abdbaf0dbd00b2c
  - Changes: none

## Lifecycle, cancellation, and recovery

- Source: framed-protocol-fixture
- Process crash: process-crash; recovered=true
- Timeout: timeout; recovered=true
- Cancellation: cancelled; recovered=true
- Stale generation: stale-generation; recovered=true

## Decision rationale

- The live run stopped before the full corpus completed.
- public-macos-ax protocol probe returned unsupported-mechanism/host-accessibility-permission.
- private-coresimulator-ax protocol probe returned unsupported-mechanism/private-tool-unavailable.
- public-macos-ax produced no cells.
- private-coresimulator-ax produced no cells.

## Next interface boundary

- Keep any future bridge behind the #2190 acquisition adapter and preserve raw facts until a separate GO evidence run proves fidelity, lifecycle, and latency.

## Production boundary

- No production backend selection, fallback, runner-demand, open/relaunch, proxy, XCTest interaction, or public CLI changes were made.
- A production bridge should not start until this report has a GO result; this run is the #2192 boundary.

## Stop condition

- infrastructure: open quiet failed during fixture preparation (exit 1; code=COMMAND_FAILED; reason=none; diagnostic=Simulator device failed to open agent-device-test-app:///inert.)
- Command: /opt/homebrew/Cellar/node/26.7.0/bin/node bin/agent-device.mjs open com.callstack.agentdevicelab --launch-url agent-device-test-app:///inert --foreground --state-dir /var/folders/pn/0s6xww5x5tj2brz0nrvlx96w0000gn/T/agent-device-ios-ax-spike-YnARfy --session ax-spike-public-macos-ax-cold-cold-quiet --platform ios --udid 793B72F6-02C9-4BCD-BEC9-1B3EB42A7ED4 --ios-xctest-derived-data-path /var/folders/pn/0s6xww5x5tj2brz0nrvlx96w0000gn/T/agent-device-ios-ax-spike-YnARfy/derived-data/public-macos-ax/cold-cold/quiet --json
