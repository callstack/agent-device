# iOS Simulator AX bridge spike

- Decision: **NO-GO**
- Status: **stopped**
- Revision: a1c250b5cf63ee387935b17d3f81edc9f69abb97 (codex/2192-ios-ax-bridge-spike)
- Target: AgentDevice-2192-AX-20260901 (793B72F6-02C9-4BCD-BEC9-1B3EB42A7ED4, com.apple.CoreSimulator.SimRuntime.iOS-27-0)
- Generated: 2026-09-01T07:40:59.071Z
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

- public-macos-ax/protocol-probe:public-macos-ax: ok=false, failure=unsupported-mechanism, code=host-accessibility-permission, nodes=0, duration=37.5 ms, CPU=3.0 ms, memory=9011200 B, response=331 B
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
- /Users/michal/Library/Developer/CoreSimulator/Devices/793B72F6-02C9-4BCD-BEC9-1B3EB42A7ED4/data/Library/Preferences/com.apple.Accessibility.plist: existed=true, beforeSha256=fbc67ebbd3aa0079a4b4afff4181280731fbb8faaca2ffc623393a8d9c26a436, afterSha256=725b6bb8efe60c8c6d5768aebcec0b9f6af5cee185f0430a7d1ab62953428147
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
- Command: /opt/homebrew/Cellar/node/26.7.0/bin/node bin/agent-device.mjs open com.callstack.agentdevicelab --launch-url agent-device-test-app:///inert --foreground --state-dir /var/folders/pn/0s6xww5x5tj2brz0nrvlx96w0000gn/T/agent-device-ios-ax-spike-n3rBW5 --session ax-spike-public-macos-ax-cold-cold-quiet --platform ios --udid 793B72F6-02C9-4BCD-BEC9-1B3EB42A7ED4 --ios-xctest-derived-data-path /var/folders/pn/0s6xww5x5tj2brz0nrvlx96w0000gn/T/agent-device-ios-ax-spike-n3rBW5/derived-data/public-macos-ax/cold-cold/quiet --json
