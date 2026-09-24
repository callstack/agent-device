import XCTest
import AgentDeviceSnapshotPresentation

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
// MARK: - In-bundle unit tests

extension RunnerTests {
  func testPrivateAXAttemptDepthsAppliesRememberedDepth() {
    XCTAssertEqual(
      Self.privateAXAttemptDepths(requestedDepth: 64, rememberedDepth: nil),
      [64, 56, 40, 24, 12]
    )
    XCTAssertEqual(
      Self.privateAXAttemptDepths(requestedDepth: 64, rememberedDepth: 56),
      [56, 40, 24, 12]
    )
    XCTAssertEqual(Self.privateAXAttemptDepths(requestedDepth: 64, rememberedDepth: 12), [12])
    // Remembered at/above the requested depth changes nothing.
    XCTAssertEqual(
      Self.privateAXAttemptDepths(requestedDepth: 64, rememberedDepth: 64),
      [64, 56, 40, 24, 12]
    )
    // A shallower explicit request keeps its own rungs; deeper stale memory is ignored.
    XCTAssertEqual(Self.privateAXAttemptDepths(requestedDepth: 24, rememberedDepth: 56), [24, 12])
  }

  /// Executed producer contract for the #1627 review blocker: a frontier whose
  /// live element vanished, and one whose re-rooted request fails, must BOTH
  /// count as missed — an all-miss extension reporting itself drained would
  /// present a capped capture as complete. Goes red if either miss-path
  /// increment in extendSnapshotFrontiers is removed.
  func testDeepExtensionCountsMissedFrontiers() {
    // Element vanished (list churn between serialization and extension): the
    // fabricated snapshot answers nil for accessibilityElement — missed, and
    // no request call is consumed. (An explicit nil property: bare NSObject
    // resolves the key through a UIKit category and would take the call path.)
    let orphan = RunnerAXSnapshotFrontier()
    orphan.snapshot = FrontierSnapshotWithoutElementForTesting()
    orphan.node = NSMutableDictionary()
    // Re-rooted request fails: the element resolves but the client cannot
    // serve requestSnapshotForElement — one consumed call AND a miss.
    let unreachable = RunnerAXSnapshotFrontier()
    unreachable.snapshot = FrontierSnapshotWithElementForTesting()
    unreachable.node = NSMutableDictionary()

    var nodeCount = 0
    var truncated = ObjCBool(false)
    let outcome = RunnerAXSnapshotBridge.extend(
      NSMutableArray(array: [orphan, unreachable]),
      axClient: NSObject(),
      attributes: [],
      maxDepth: 56,
      maxNodes: 5_000,
      nodeCount: &nodeCount,
      truncated: &truncated,
      callsAllowed: 8,
      mergedLeaves: nil,
      deadline: nil
    )

    XCTAssertEqual(outcome?[RunnerAXSnapshotDeepExtensionMissedKey] as? Int, 2)
    XCTAssertEqual(outcome?[RunnerAXSnapshotDeepExtensionCallsKey] as? Int, 1)
    XCTAssertEqual(outcome?[RunnerAXSnapshotDeepExtensionPendingKey] as? Int, 0)
    XCTAssertEqual(outcome?[RunnerAXSnapshotDeepExtensionNodesAddedKey] as? Int, 0)
    XCTAssertFalse(truncated.boolValue)
    // And the consumer verdict over exactly this outcome: still depth-limited.
    XCTAssertTrue(
      Self.privateAXDepthLimited(
        effectiveDepth: 56, requestedDepth: 64, pendingFrontiers: 0, missedFrontiers: 2))
  }

  func testPrivateAXDepthLimitedRequiresEveryFrontierResolved() {
    // Un-capped capture is never depth-limited, extension or not.
    XCTAssertFalse(
      Self.privateAXDepthLimited(
        effectiveDepth: 64, requestedDepth: 64, pendingFrontiers: nil, missedFrontiers: nil))
    // Capped with no extension outcome (never ran) stays depth-limited.
    XCTAssertTrue(
      Self.privateAXDepthLimited(
        effectiveDepth: 56, requestedDepth: 64, pendingFrontiers: nil, missedFrontiers: nil))
    // Fully drained extension clears the verdict.
    XCTAssertFalse(
      Self.privateAXDepthLimited(
        effectiveDepth: 56, requestedDepth: 64, pendingFrontiers: 0, missedFrontiers: 0))
    // Budget exhaustion (pending frontiers) keeps it.
    XCTAssertTrue(
      Self.privateAXDepthLimited(
        effectiveDepth: 56, requestedDepth: 64, pendingFrontiers: 2, missedFrontiers: 0))
    // The #1627 review blocker: an all-miss extension (elements vanished or
    // re-rooted requests failed) resolved nothing — it must NOT present the
    // capture as complete just because the queue emptied.
    XCTAssertTrue(
      Self.privateAXDepthLimited(
        effectiveDepth: 56, requestedDepth: 64, pendingFrontiers: 0, missedFrontiers: 8))
  }

  func testPrivateAXAcceptedDepthMemoryMatchesBundleProcessAndExpires() {
    defer { clearPrivateAXAcceptedDepth(reason: "test-cleanup") }

    rememberPrivateAXAcceptedDepth(bundleId: "xyz.blueskyweb.app", processIdentifier: 111, depth: 56)
    XCTAssertEqual(
      rememberedPrivateAXAcceptedDepth(bundleId: "xyz.blueskyweb.app", processIdentifier: 111),
      56
    )
    XCTAssertNil(rememberedPrivateAXAcceptedDepth(bundleId: "com.other.app", processIdentifier: 111))
    // A relaunch changes the PID; the new process must re-probe the full depth even inside the
    // TTL, and an unknown current PID (post-invalidation) must never match.
    XCTAssertNil(rememberedPrivateAXAcceptedDepth(bundleId: "xyz.blueskyweb.app", processIdentifier: 222))
    XCTAssertNil(rememberedPrivateAXAcceptedDepth(bundleId: "xyz.blueskyweb.app", processIdentifier: nil))

    // Expired memory stops applying (the expiry re-probes the full requested depth).
    privateAXAcceptedDepthUntil = Date(timeIntervalSinceNow: -1)
    XCTAssertNil(rememberedPrivateAXAcceptedDepth(bundleId: "xyz.blueskyweb.app", processIdentifier: 111))
  }

  func testPrivateAXAcceptedDepthMemoryRequiresProcessIdentifierToRecord() {
    defer { clearPrivateAXAcceptedDepth(reason: "test-cleanup") }

    rememberPrivateAXAcceptedDepth(bundleId: "xyz.blueskyweb.app", processIdentifier: nil, depth: 56)
    XCTAssertNil(
      rememberedPrivateAXAcceptedDepth(bundleId: "xyz.blueskyweb.app", processIdentifier: nil)
    )
  }

  func testViewportReadSkippedWhileXCTestChannelPenalized() {
    // Pins the viewport fast path (#1587 review): every penalized private AX capture used to burn
    // the full 1s main-thread timeout on a doomed viewport read before falling back.
    let bundleId = "xyz.blueskyweb.app"
    defer {
      clearSnapshotXCTestChannelPenalty(reason: "test-cleanup")
      abandonedMainThreadWorkCount = 0
    }

    XCTAssertTrue(shouldReadPrivateAXViewportViaXCTest(bundleId: bundleId))

    penalizeSnapshotXCTestChannel(bundleId: bundleId, reason: "test")
    XCTAssertFalse(shouldReadPrivateAXViewportViaXCTest(bundleId: bundleId))

    clearSnapshotXCTestChannelPenalty(reason: "test")
    XCTAssertTrue(shouldReadPrivateAXViewportViaXCTest(bundleId: bundleId))

    abandonedMainThreadWorkCount = 1
    XCTAssertFalse(shouldReadPrivateAXViewportViaXCTest(bundleId: bundleId))
  }

  /// The wire field must reach both capture options AND the backend pin: custom
  /// actions are only readable through the private AX client, so a capture that
  /// asked for them but planned the XCTest tree backend would return a payload
  /// that structurally cannot carry them.
  func testCustomActionsRequestPinsPrivateAXBackend() throws {
    let asked = try JSONDecoder().decode(
      Command.self, from: Data(#"{"command":"snapshot","customActions":true}"#.utf8))
    let options = Self.presentationOptions(from: asked)
    XCTAssertTrue(options.customActions)
    XCTAssertEqual(options.preferredBackend, SnapshotBackendKind.privateAX.rawValue)
    XCTAssertTrue(
      Self.snapshotXCTestChannelTreatedAsPenalized(
        penalized: false, preferredBackend: options.preferredBackend))

    // An explicit pin is never overwritten by the implied one.
    let pinned = try JSONDecoder().decode(
      Command.self,
      from: Data(#"{"command":"snapshot","customActions":true,"preferredBackend":"tree"}"#.utf8))
    XCTAssertEqual(Self.presentationOptions(from: pinned).preferredBackend, "tree")

    // And the default capture neither asks nor pins.
    let bare = try JSONDecoder().decode(Command.self, from: Data(#"{"command":"snapshot"}"#.utf8))
    XCTAssertFalse(Self.presentationOptions(from: bare).customActions)
    XCTAssertNil(Self.presentationOptions(from: bare).preferredBackend)
  }

  /// A request-pinned backend degraded nothing, so its verdict must not claim
  /// slow accessibility work — that reason drives a user-facing warning.
  func testRequestPinnedBackendReportsItsOwnReason() {
    let requested = Self.xcTestChannelStateFirstFailure(
      .deferredToIndependentBackend, requestPinnedBackend: true)
    XCTAssertEqual(requested?.code, "requested-backend")
    XCTAssertFalse(requested?.reason.contains("slow accessibility work") ?? true)

    // The circuit breaker's own deferral keeps its established code and wording.
    let breaker = Self.xcTestChannelStateFirstFailure(.deferredToIndependentBackend)
    XCTAssertEqual(breaker?.code, "deferred")

    // The bounded probe and the healthy plan are untouched by the new flag.
    XCTAssertEqual(
      Self.xcTestChannelStateFirstFailure(.boundedXCTestProbe, requestPinnedBackend: true)?.code,
      "budget")
    XCTAssertNil(Self.xcTestChannelStateFirstFailure(.normal, requestPinnedBackend: true))
  }

  /// The disclosure only exists if the counts survive the bridge boundary, and
  /// "did not ask" must stay distinguishable from "read none".
  func testCustomActionCoverageParsesOnlyCompletePairs() {
    let complete: [String: Any] = [
      RunnerAXSnapshotCustomActionsReadKey: 12,
      RunnerAXSnapshotCustomActionsCandidatesKey: 19,
      RunnerAXSnapshotCustomActionsTruncatedKey: 2,
      RunnerAXSnapshotCustomActionsBlockedKey: true,
    ]
    let coverage = Self.privateAXCustomActionCoverage(complete)
    XCTAssertEqual(coverage?.read, 12)
    XCTAssertEqual(coverage?.candidates, 19)
    XCTAssertEqual(coverage?.truncated, 2)
    XCTAssertEqual(coverage?.blocked, true)

    // Absent key = the capture never asked; it must not read as (0, 0), which
    // would warn "0 of 0" on every default capture.
    XCTAssertNil(Self.privateAXCustomActionCoverage(nil))
    // The bridge in this target always writes all four keys, so a partial
    // dictionary is malformed and is dropped whole.
    for key in complete.keys {
      var partial = complete
      partial.removeValue(forKey: key)
      XCTAssertNil(Self.privateAXCustomActionCoverage(partial), "missing \(key)")
    }
  }

  /// The AX call cannot be cancelled once issued, so the read deadline frees
  /// only the caller — the call keeps running. Without containment, repeating
  /// `snapshot --actions` against a wedged element would stack orphaned reads,
  /// all sharing one XCAXClient. This pins the containment: one serial queue and
  /// a single-flight refusal that adds no work while a read is outstanding.
  func testHungCustomActionReadIsContainedAndRecovers() {
    let hung = HungAXClientForTesting()
    let element = NSObject()
    let dispatchesBefore = RunnerAXSnapshotBridge.customActionReadDispatchCount()
    let blockedBefore = RunnerAXSnapshotBridge.customActionReadBlockedCount()
    defer { hung.release() }

    // 1. First read wedges. The caller is freed by the deadline, but the call is
    //    still out there, so it stays counted in flight.
    var completed = ObjCBool(true)
    let firstStarted = Date()
    let first = RunnerAXSnapshotBridge.customActionNames(
      forElement: element, axClient: hung, completed: &completed)
    XCTAssertNil(first)
    XCTAssertFalse(completed.boolValue)
    XCTAssertGreaterThanOrEqual(-firstStarted.timeIntervalSinceNow, 0.9)
    XCTAssertEqual(RunnerAXSnapshotBridge.customActionReadsInFlight(), 1)
    XCTAssertEqual(
      RunnerAXSnapshotBridge.customActionReadDispatchCount(), dispatchesBefore + 1)

    // 2. Repeats do NOT accumulate: no new dispatch, still exactly one in
    //    flight, and every repeat is refused by single-flight admission.
    for _ in 0..<5 {
      XCTAssertNil(
        RunnerAXSnapshotBridge.customActionNames(
          forElement: element, axClient: hung, completed: &completed))
      XCTAssertFalse(completed.boolValue)
    }
    XCTAssertEqual(RunnerAXSnapshotBridge.customActionReadsInFlight(), 1)
    XCTAssertEqual(
      RunnerAXSnapshotBridge.customActionReadDispatchCount(), dispatchesBefore + 1)
    XCTAssertEqual(RunnerAXSnapshotBridge.customActionReadBlockedCount(), blockedBefore + 5)

    // 3. A capture in that state discloses the skip rather than presenting the
    //    unread elements as action-free — and spends no read budget doing it.
    let leaf = RunnerAXSnapshotFrontier()
    leaf.snapshot = FrontierSnapshotWithElementForTesting()
    leaf.node = NSMutableDictionary(dictionary: ["label": "feedItem", "children": []])
    let coverage = RunnerAXSnapshotBridge.annotateCustomActions(
      onMergedLeaves: [leaf], axClient: hung, limit: 12, rootFrame: .zero, deadline: nil)
    XCTAssertEqual(coverage[RunnerAXSnapshotCustomActionsBlockedKey] as? Bool, true)
    XCTAssertEqual(coverage[RunnerAXSnapshotCustomActionsReadKey] as? Int, 0)
    XCTAssertEqual(coverage[RunnerAXSnapshotCustomActionsCandidatesKey] as? Int, 1)
    XCTAssertEqual(
      RunnerAXSnapshotBridge.customActionReadDispatchCount(), dispatchesBefore + 1)
    XCTAssertEqual(
      Self.privateAXCustomActionCoverage(coverage),
      SnapshotCustomActionCoverage(read: 0, candidates: 1, truncated: 0, blocked: true))

    // 4. Recovery: once the wedged call returns, reads resume by themselves.
    hung.release()
    let recovered = expectation(description: "in-flight drains")
    DispatchQueue.global().async {
      while RunnerAXSnapshotBridge.customActionReadsInFlight() > 0 {
        usleep(20_000)
      }
      recovered.fulfill()
    }
    wait(for: [recovered], timeout: 5)

    completed = ObjCBool(false)
    XCTAssertNil(
      RunnerAXSnapshotBridge.customActionNames(
        forElement: element, axClient: hung, completed: &completed))
    // Completed (the fake answers nil actions), which is the point: the pass is
    // live again rather than latched off.
    XCTAssertTrue(completed.boolValue)
    XCTAssertEqual(
      RunnerAXSnapshotBridge.customActionReadDispatchCount(), dispatchesBefore + 2)
  }

  /// The element budget bounds how many elements we read; these caps bound what
  /// any ONE element can put in the response. Clipping must be reported, since
  /// a clipped list looks exactly like a complete one.
  func testActionNamesAreCappedPerElementAndReported() {
    var truncated = ObjCBool(true)

    // Under both caps: untouched, nothing to report.
    let small = ["Reply", "Repost"]
    XCTAssertEqual(
      RunnerAXSnapshotBridge.cappedActionNames(small, truncated: &truncated), small)
    XCTAssertFalse(truncated.boolValue)

    // More actions than the per-element cap: clipped to the first 8, reported.
    let many = (1...20).map { "Action \($0)" }
    let cappedMany = RunnerAXSnapshotBridge.cappedActionNames(many, truncated: &truncated)
    XCTAssertEqual(cappedMany.count, 8)
    XCTAssertEqual(cappedMany.first, "Action 1")
    XCTAssertTrue(truncated.boolValue)

    // A single very long name is shortened, reported, and stays one string.
    let long = String(repeating: "a", count: 500)
    let cappedLong = RunnerAXSnapshotBridge.cappedActionNames([long], truncated: &truncated)
    XCTAssertEqual(cappedLong.count, 1)
    XCTAssertTrue(truncated.boolValue)
    XCTAssertLessThan(cappedLong[0].count, long.count)
    XCTAssertTrue(cappedLong[0].hasSuffix("…"))

    // Empty input is not "truncated".
    XCTAssertEqual(RunnerAXSnapshotBridge.cappedActionNames([], truncated: &truncated), [])
    XCTAssertFalse(truncated.boolValue)
  }

  /// Action names annotated by the bridge must survive into the emitted node —
  /// the whole point of the capture is that the merged card names its hidden
  /// affordances.
  func testPrivateAXNodesCarryAnnotatedCustomActions() {
    let tree: [String: Any] = [
      "type": Int(XCUIElement.ElementType.application.rawValue),
      "label": "Blue Sky",
      "frame": ["x": 0, "y": 0, "width": 390, "height": 844],
      "children": [
        [
          "type": Int(XCUIElement.ElementType.link.rawValue),
          "label": "feedItem-by-whiskers.test",
          "frame": ["x": 0, "y": 100, "width": 390, "height": 200],
          "actions": ["Reply", "Repost", "Open post options menu"],
          "children": [],
        ],
        [
          "type": Int(XCUIElement.ElementType.button.rawValue),
          "label": "Compose",
          "frame": ["x": 300, "y": 700, "width": 60, "height": 60],
          "children": [],
        ],
      ],
    ]
    let nodes = privateAXAcquisition(
      rawRoot: tree,
      hint: CaptureHint(
        projection: .regular, depth: nil, regularPresentedDepth: nil,
        interactiveOnly: false, customActions: false)
    )

    let card = nodes.first { $0.label == "feedItem-by-whiskers.test" }
    XCTAssertEqual(card?.actions, ["Reply", "Repost", "Open post options menu"])
    // A node the bridge did not annotate stays absent, not empty.
    XCTAssertNil(nodes.first { $0.label == "Compose" }?.actions)
  }

  func testPrivateAXAcquisitionDoesNotInterpretScope() {
    let tree: [String: Any] = [
      "type": 1, "label": "App",
      "children": [
        [
          "type": 9, "identifier": "homeScreen",
          "children": [
            ["type": 48, "label": "Post body without the scope text", "children": []]
          ],
        ],
        ["type": 9, "label": "unrelated sibling", "children": []],
      ],
    ]
    // Scope never reaches acquisition: the hint derived for a scoped request carries no scope,
    // and the backend has no way to interpret one.
    let nodes = privateAXAcquisition(
      rawRoot: tree,
      hint: SnapshotPresentation.captureHint(
        for: PresentationOptions(
          interactiveOnly: false,
          depth: nil,
          scope: "homeScreen",
          raw: false
        )
      )
    )

    let labels = nodes.compactMap { $0.label ?? $0.identifier }
    XCTAssertTrue(labels.contains("homeScreen"))
    // Descendants of the matched scope are included even when they do not contain the text.
    XCTAssertTrue(labels.contains("Post body without the scope text"))
    XCTAssertTrue(labels.contains("unrelated sibling"))
  }

  func testPrivateAXInteractiveFiltersLoginLikeHiddenDrawer() throws {
    let tree: [String: Any] = [
      "type": Int(XCUIElement.ElementType.application.rawValue),
      "label": "Blue Sky",
      "frame": ["x": 0, "y": 0, "width": 390, "height": 844],
      "children": [
        [
          "type": Int(XCUIElement.ElementType.scrollView.rawValue),
          "frame": ["x": 0, "y": 0, "width": 390, "height": 844],
          "children": [
            [
              "type": Int(XCUIElement.ElementType.image.rawValue),
              "label": "Callstack",
              "frame": ["x": 145, "y": 104, "width": 100, "height": 100],
              "children": [],
            ],
            [
              "type": Int(XCUIElement.ElementType.staticText.rawValue),
              "label": "Welcome back",
              "frame": ["x": 32, "y": 260, "width": 326, "height": 32],
              "children": [],
            ],
            [
              "type": Int(XCUIElement.ElementType.textField.rawValue),
              "label": "Email",
              "identifier": "login.email",
              "frame": ["x": 32, "y": 348, "width": 326, "height": 48],
              "children": [],
            ],
            [
              "type": Int(XCUIElement.ElementType.secureTextField.rawValue),
              "label": "Password",
              "identifier": "login.password",
              "frame": ["x": 32, "y": 412, "width": 326, "height": 48],
              "children": [],
            ],
            [
              "type": Int(XCUIElement.ElementType.button.rawValue),
              "label": "Sign in",
              "identifier": "login.submit",
              "frame": ["x": 32, "y": 492, "width": 326, "height": 52],
              "children": [],
            ],
            [
              "type": Int(XCUIElement.ElementType.link.rawValue),
              "label": "Forgot password?",
              "frame": ["x": 128, "y": 568, "width": 134, "height": 32],
              "children": [],
            ],
            [
              "type": Int(XCUIElement.ElementType.button.rawValue),
              "label": "Admin settings",
              "frame": ["x": -260, "y": 184, "width": 220, "height": 44],
              "children": [],
            ],
            [
              "type": Int(XCUIElement.ElementType.other.rawValue),
              "frame": ["x": 16, "y": 184, "width": 220, "height": 44],
              "children": [],
            ],
          ],
        ]
      ],
    ]
    let viewport = CGRect(x: 0, y: 0, width: 390, height: 844)
    let hint = CaptureHint(
      projection: .regular, depth: nil, regularPresentedDepth: nil,
      interactiveOnly: true, customActions: false)
    let acquired = SnapshotGeometrySpace.normalized(
      nodes: privateAXAcquisition(rawRoot: tree, hint: hint),
      viewport: .reported(box: viewport, interfaceOrientation: RunnerInterfaceOrientation.portrait)
    )
    // Acquisition serializes the drawer too; the shared fold is what hides it (#1797).
    XCTAssertTrue(acquired.compactMap(\.label).contains("Admin settings"))

    let capture = try SnapshotPresentation.presentRegular(
      SnapshotAcquisition(
        hint: hint, nodes: acquired, truncated: false, effectiveDepth: nil, viewport: .reported(box: viewport)),
      options: PresentationOptions(interactiveOnly: true, depth: nil, scope: nil, raw: false),
      policy: .cursorProjected
    )
    let labels = capture.nodes.compactMap { $0.label }
    XCTAssertEqual(
      labels,
      ["Blue Sky", "Callstack", "Welcome back", "Email", "Password", "Sign in", "Forgot password?"]
    )
    XCTAssertFalse(labels.contains("Admin settings"))
  }
}

/// Stands in for an AX client whose `attributesForElement:` never returns —
/// the wedged-server case the containment exists for. `release()` lets the
/// hung call finish so recovery is observable.
private final class HungAXClientForTesting: NSObject {
  private let gate = DispatchSemaphore(value: 0)
  private let releasedOnce = NSLock()
  private var released = false

  @objc(attributesForElement:attributes:error:)
  func attributes(forElement element: Any, attributes: Any, error: NSErrorPointer) -> Any? {
    releasedOnce.lock()
    let alreadyReleased = released
    releasedOnce.unlock()
    // Once the wedge clears, the server answers normally again — that is what
    // makes the recovery leg a recovery rather than a second hang.
    if alreadyReleased {
      return nil
    }
    gate.wait()
    return nil
  }

  func release() {
    releasedOnce.lock()
    defer { releasedOnce.unlock() }
    guard !released else { return }
    released = true
    gate.signal()
  }
}

/// Minimal snapshot stand-in whose accessibilityElement resolves (so the
/// extension proceeds to the request) while the paired fake client cannot
/// serve it — the failed-re-root miss path.
private final class FrontierSnapshotWithElementForTesting: NSObject {
  @objc let accessibilityElement = NSObject()
}

/// The vanished-element case: KVC resolves the property and gets nil.
private final class FrontierSnapshotWithoutElementForTesting: NSObject {
  @objc let accessibilityElement: NSObject? = nil
}
#endif
