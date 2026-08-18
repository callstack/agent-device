//
//  RunnerTests.swift
//  AgentDeviceRunnerUITests
//
//  Created by Michał Pierzchała on 30/01/2026.
//

import XCTest
import Network
#if canImport(UIKit)
import UIKit
typealias RunnerImage = UIImage
#elseif canImport(AppKit)
import AppKit
typealias RunnerImage = NSImage
#endif

final class RunnerTests: XCTestCase {
  enum RunnerErrorDomain {
    static let general = "AgentDeviceRunner"
    static let exception = "AgentDeviceRunner.NSException"
  }

  enum RunnerErrorCode {
    static let noResponseFromMainThread = 1
    static let commandReturnedNoResponse = 2
    static let mainThreadExecutionTimedOut = 3
    static let objcException = 1
  }

  static let springboardBundleId = "com.apple.springboard"
  // SpringBoard hosts blocking system modals on iOS/visionOS; tvOS (PineBoard/HeadBoard)
  // and macOS have no such host, so there is nothing to probe there.
  static let hasSpringBoardSystemModalHost: Bool = {
    #if os(tvOS) || os(macOS)
      return false
    #else
      return true
    #endif
  }()
  static let defaultRecordingFps: Int32 = 15
  var listener: NWListener?
  var doneExpectation: XCTestExpectation?
  let transportQueue = DispatchQueue(label: "agent-device.runner.transport")
  let commandExecutionQueue = DispatchQueue(label: "agent-device.runner.commands")
  let app = XCUIApplication()
  lazy var springboard = XCUIApplication(bundleIdentifier: Self.springboardBundleId)
  var currentApp: XCUIApplication?
  var currentBundleId: String?
  var currentAppProcessIdentifier: Int?
  // iOS does not reliably expose hasKeyboardFocus for a bare type request, especially when
  // hardware-keyboard input hides the software keyboard. A successful tap on a concrete text
  // input is a scoped witness for the immediately-following bare type; lifecycle and non-text
  // interactions clear it before it can become stale.
  var textEntryTapWitness: TextEntryTapWitness?
  let maxRequestBytes = 2 * 1024 * 1024
  let mainThreadExecutionTimeout: TimeInterval = 30
  let appExistenceTimeout: TimeInterval = 30
  let retryCooldown: TimeInterval = 0.2
  let postSnapshotInteractionDelay: TimeInterval = 0.2
  let firstInteractionAfterActivateDelay: TimeInterval = 0.25
  let scrollInteractionIdleTimeoutDefault: TimeInterval = 1.0
  let tvRemoteDoublePressDelayDefault: TimeInterval = 0.0
  // Keep a periodic XCTest liveness marker in runner.log without flooding long-lived sessions.
  let xctestIdleKeepaliveInterval: TimeInterval = 60.0
  let minRecordingFps = 1
  let maxRecordingFps = 120
  var needsPostSnapshotInteractionDelay = false
  var needsFirstInteractionDelay = false
  var runnerAccessibilityHealth: RunnerAccessibilityHealth = .unknown
  var activeRecording: ScreenRecorder?
  let commandJournal = RunnerCommandJournal()
  // Coalesces duplicate transport sends of the same commandId onto the single in-flight
  // execution instead of enqueueing them again behind it (#1105 capture pileup).
  let inFlightCommandLock = NSLock()
  var inFlightCommandIds: Set<String> = []
  var inFlightCommandWaiters: [String: [((data: Data, shouldFinish: Bool)) -> Void]] = [:]
  // Tracks main-queue work abandoned by the execution watchdog so new main-thread commands
  // fail fast as busy instead of queueing behind work that cannot be cancelled (#1105).
  let mainThreadWorkLock = NSLock()
  var abandonedMainThreadWorkCount = 0
  var abandonedMainThreadWorkSince: Date?
  // Past this age the runner stops claiming "busy, retry soon" and reports itself wedged so
  // the daemon recycles it — the only cure once the main thread is stuck for good.
  let mainThreadWedgeThreshold: TimeInterval = 120
  // Sticky per-bundle hint: after an XCTest-backed snapshot tier ground past its slice (or a
  // snapshot was abandoned by the watchdog), later capture plans avoid the XCTest accessibility
  // channel when an independent recovery backend exists, or use a bounded XCTest probe when it
  // does not, for the same screen class (#1105/#1156).
  let snapshotXCTestChannelPenaltyLock = NSLock()
  var snapshotXCTestChannelPenaltyBundleId: String?
  var snapshotXCTestChannelPenaltyUntil = Date.distantPast
  let snapshotXCTestChannelPenaltyDuration: TimeInterval = 120
  var snapshotXCTestPenaltyWarmupExemptionPending = false
  // Sticky per-bundle hint for the private AX depth ladder: deep RN screens reject the default
  // depth with kAXErrorIllegalArgument on EVERY capture, so once a shallower rung is accepted
  // later captures start there instead of re-paying the rejected deep request (~300ms per
  // capture on the Bluesky feed). Shares the penalty's lifetime model: same duration, cleared
  // on target process change, so screens that regain deep-capture ability are re-probed.
  let privateAXAcceptedDepthLock = NSLock()
  var privateAXAcceptedDepthBundleId: String?
  // PID-bound: a relaunch (external or A->B->A while inactive) changes the process, and the new
  // tree may accept the full depth again. Any invalidation path that drops the cached PID makes
  // the memory unmatchable, so every fresh activation re-probes the full requested depth.
  var privateAXAcceptedDepthProcessIdentifier: Int?
  var privateAXAcceptedDepth: Int?
  var privateAXAcceptedDepthUntil = Date.distantPast
  // Bluesky-class screens can grind ~4-8s before an XCTest-backed snapshot tier fails; anything
  // past this threshold marks the screen hostile so the next capture uses non-XCTest recovery.
  let snapshotXCTestSlowCaptureThreshold: TimeInterval = 3
  // The blocking XCTest tree snapshot XPC runs on the main thread with this slice so a
  // content-dependent grind (#1105: seconds to minutes on live Bluesky screens) cannot pin
  // the capture plan. On timeout the XPC keeps grinding on main; while any abandoned
  // tree capture is outstanding, plans skip XCTest-backed tiers (tree, query sweep) until the
  // abandoned work drains.
  let treeCaptureLock = NSLock()
  var abandonedTreeCaptureCount = 0
  let treeCaptureSliceBudget: TimeInterval = 8
  // Bounds the pre-plan SpringBoard system-modal probe, which can otherwise grind for tens of
  // seconds on remote-hosted consent dialogs and bypass the plan budget (#1244).
  let systemModalProbeBudget: TimeInterval = 4
  // In-bundle unit tests (every `func test…` except `testCommand` below) compile only under
  // `-D AGENT_DEVICE_RUNNER_UNIT_TESTS` and are classified by their `#if` guard (#1781 A7):
  //   - `#if AGENT_DEVICE_RUNNER_UNIT_TESTS` alone: a pure runner decision (rule table,
  //     geometry, parser, policy, journal, dispatch bookkeeping) that needs no launched app.
  //     Runs on the macOS host lane on every PR (ci.yml, no simulator) and on the iOS lanes.
  //   - `… && os(iOS)` (or a nested `#if os(iOS)`): runner/XCTest semantics — launches the
  //     host app, routes through SpringBoard, swizzles XCUIApplication, or asserts an
  //     iOS-only branch. Simulator lanes only (ios.yml PR list, xctest-nightly.yml).
  // `pnpm check:xctest-selection` derives each lane's reachable set from these guards and
  // fails when a declared test is reachable by no lane, so a test gated to a platform nothing
  // runs (the old tvOS-only pair) cannot go dark silently.
  #if AGENT_DEVICE_RUNNER_UNIT_TESTS
  // #1605 merge gate: deterministic live reproduction of the field ambiguity —
  // a tap whose coordinate activation LANDS while XCTest bookkeeping records a
  // failure. Armed by writing a decrementing count to the flag file below
  // (the daemon regenerates tampered xctestrun templates, so env plumbing
  // cannot reach a daemon-spawned runner); consumed one injection per tap.
  // The injection records a real XCTIssue AFTER the real gesture, so
  // `xctestRecordedFailureResponse` and target invalidation fire byte-for-byte
  // like a field failure. Production builds compile none of this.
  static let injectedTapFailureFlagPathForTesting =
    "/tmp/agent-device-inject-tap-recorded-failure-for-testing"

  static func shouldInjectTapRecordedFailure(command: CommandType, remaining: Int) -> Bool {
    command == .tap && remaining > 0
  }

  func consumeInjectedTapRecordedFailureForTesting(command: CommandType) -> Bool {
    guard
      let raw = try? String(
        contentsOfFile: Self.injectedTapFailureFlagPathForTesting,
        encoding: .utf8
      ),
      let remaining = Int(raw.trimmingCharacters(in: .whitespacesAndNewlines))
    else {
      return false
    }
    guard Self.shouldInjectTapRecordedFailure(command: command, remaining: remaining) else {
      return false
    }
    try? String(remaining - 1).write(
      toFile: Self.injectedTapFailureFlagPathForTesting,
      atomically: true,
      encoding: .utf8
    )
    return true
  }

  // Unit-test-only injectable override for the system-modal probe (see
  // `boundedBlockingSystemAlertSnapshot` in RunnerTests+Snapshot.swift): when set, a test's probe
  // body runs in place of `blockingSystemAlertSnapshot` so it can force a real timeout without a
  // live SpringBoard alert. Production never compiles this property. Stored here (rather than in
  // the extension that reads it) because Swift extensions cannot hold stored properties.
  var systemModalProbeOverrideForTesting: ((Date) -> DataPayload?)?
  var blockingSystemModalPresenceOverrideForTesting: Bool?
  var alertResolutionOverrideForTesting: ((Date) -> RunnerAlert?)?
  #endif
  // Observability for the record(_:) suppression below: how many AX-broken-screen snapshot
  // issues this session muted, so wedge investigations see the volume without grepping logs.
  let suppressedIssueLock = NSLock()
  var suppressedAxSnapshotIssueCount = 0
  let interactiveTypes: Set<XCUIElement.ElementType> = [
    .button,
    .cell,
    .checkBox,
    .collectionView,
    .link,
    .menuItem,
    .picker,
    .searchField,
    .segmentedControl,
    .slider,
    .stepper,
    .switch,
    .tabBar,
    .textField,
    .secureTextField,
    .textView,
    .webView
  ]
  // Keep blocker actions narrow to avoid false positives from generic hittable containers.
  let actionableTypes: Set<XCUIElement.ElementType> = [
    .button,
    .cell,
    .link,
    .menuItem,
    .checkBox,
    .switch
  ]

  // MARK: - XCTest Entry

  override func setUp() {
    continueAfterFailure = true
  }

  /// True for the one recorded-issue class the runner deliberately mutes: an AX-server error
  /// (`kAXError*`) inside a "Failed to get matching snapshot" fetch. The kAXError token
  /// intentionally covers kAXErrorIllegalArgument and its sibling AX server codes (e.g.
  /// kAXErrorCannotComplete): any AX-server rejection inside a matching-snapshot fetch is the
  /// same capture-plan noise the plan already classifies and recovers from. The timeout
  /// variant ("Failed to get matching snapshot: Timed out while evaluating UI query.") carries
  /// no kAXError token and MUST keep recording — it signals a genuinely hung query, exactly
  /// the pathology XCTEST_RECORDED_FAILURE must stay able to see.
  static func isSuppressedAxSnapshotIssueDescription(_ description: String) -> Bool {
    description.contains("Failed to get matching snapshot") && description.contains("kAXError")
  }

  /// On AX-broken screens (deep RN trees, #758/#1105) XCUIApplication queries record
  /// "Failed to get matching snapshot: ... kAXError..." issues; XCTest tears the whole test
  /// case down once a few accumulate, killing the long-lived runner right after the command
  /// completes and forcing a ~25s restart per capture. This override is deliberately
  /// suite-global (all commands, not just snapshot capture): tap-triggered element queries on
  /// the same screens record the same noise and would still tear the runner down, and command
  /// outcomes stay honest through their own error paths — only this issue side-channel is
  /// muted. Everything else still records (and still drives XCTEST_RECORDED_FAILURE).
  override func record(_ issue: XCTIssue) {
    let description = issue.compactDescription
    if Self.isSuppressedAxSnapshotIssueDescription(description) {
      suppressedIssueLock.lock()
      suppressedAxSnapshotIssueCount += 1
      let count = suppressedAxSnapshotIssueCount
      suppressedIssueLock.unlock()
      NSLog(
        "AGENT_DEVICE_RUNNER_AX_SNAPSHOT_ISSUE_SUPPRESSED count=%ld description=%@",
        count,
        description
      )
      return
    }
    super.record(issue)
  }

  @MainActor
  func testCommand() throws {
    if RunnerEnv.isTruthy("AGENT_DEVICE_RUNNER_NOOP_STARTUP") {
      NSLog("AGENT_DEVICE_RUNNER_NOOP_STARTUP=1")
      return
    }

    doneExpectation = expectation(description: "agent-device command handled")
    NSLog("AGENT_DEVICE_RUNNER_HEADLESS_STARTUP=1")
    let desiredPort = RunnerEnv.resolvePort()
    NSLog("AGENT_DEVICE_RUNNER_DESIRED_PORT=%d", desiredPort)
    listener = try makeRunnerListener(desiredPort: desiredPort)
    listener?.stateUpdateHandler = { [weak self] state in
      switch state {
      case .ready:
        NSLog("AGENT_DEVICE_RUNNER_LISTENER_READY")
        if let listenerPort = self?.listener?.port {
          NSLog("AGENT_DEVICE_RUNNER_PORT=%d", listenerPort.rawValue)
        } else {
          NSLog("AGENT_DEVICE_RUNNER_PORT_NOT_SET")
        }
      case .failed(let error):
        NSLog("AGENT_DEVICE_RUNNER_LISTENER_FAILED=%@", String(describing: error))
        self?.doneExpectation?.fulfill()
      default:
        break
      }
    }
    listener?.newConnectionHandler = { [weak self] conn in
      guard let self else { return }
      conn.start(queue: self.transportQueue)
      self.handle(connection: conn)
    }
    listener?.start(queue: transportQueue)
    let idleKeepaliveTimer = DispatchSource.makeTimerSource(queue: transportQueue)
    idleKeepaliveTimer.schedule(
      deadline: .now() + xctestIdleKeepaliveInterval,
      repeating: xctestIdleKeepaliveInterval
    )
    idleKeepaliveTimer.setEventHandler {
      NSLog("AGENT_DEVICE_RUNNER_IDLE_KEEPALIVE")
    }
    idleKeepaliveTimer.resume()
    defer {
      idleKeepaliveTimer.cancel()
    }

    guard let expectation = doneExpectation else {
      XCTFail("runner expectation was not initialized")
      return
    }
    NSLog("AGENT_DEVICE_RUNNER_WAITING")
    let result = XCTWaiter.wait(for: [expectation], timeout: 24 * 60 * 60)
    NSLog("AGENT_DEVICE_RUNNER_WAIT_RESULT=%@", String(describing: result))
    if result != .completed {
      XCTFail("runner wait ended with \(result)")
    }
  }

  private func makeRunnerListener(desiredPort: UInt16) throws -> NWListener {
    if desiredPort > 0, let port = NWEndpoint.Port(rawValue: desiredPort) {
      #if os(macOS)
        let parameters = NWParameters.tcp
        parameters.allowLocalEndpointReuse = true
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: port)
        return try NWListener(using: parameters)
      #else
        return try NWListener(using: .tcp, on: port)
      #endif
    }
    return try NWListener(using: .tcp)
  }
}
