import XCTest

extension RunnerTests {
  private static let privateAXSnapshotMaxNodes = 5_000
  /// Deep React Native trees make the AX server reject bulk snapshot requests outright with
  /// kAXErrorIllegalArgument once the requested depth crosses a tree-size-dependent limit
  /// (observed between depth 56 and 64 on the Bluesky Home feed; the limit moves with live
  /// content). Retrying the same request at a shallower depth succeeds, so on failure we walk
  /// this ladder instead of giving up. Capped at 4 attempts to bound worst-case latency on
  /// apps where the AX surface is genuinely unavailable.
  static let privateAXSnapshotDepthLadder = [56, 40, 24, 12]

  /// Ladder rungs for one capture. A remembered accepted depth (recorded when a prior capture's
  /// deep request was rejected) drops the rungs above it, so the known-rejected deep request is
  /// not re-paid on every capture of the same screen class.
  static func privateAXAttemptDepths(requestedDepth: Int, rememberedDepth: Int?) -> [Int] {
    var depths = [requestedDepth]
    depths.append(contentsOf: privateAXSnapshotDepthLadder.filter { $0 < requestedDepth })
    guard let remembered = rememberedDepth, remembered < requestedDepth else { return depths }
    return depths.filter { $0 <= remembered }
  }

  func rememberPrivateAXAcceptedDepth(bundleId: String?, processIdentifier: Int?, depth: Int) {
    // No PID means no way to notice a relaunch later; record nothing rather than risk serving
    // a stale shallow rung to a fresh process.
    guard let processIdentifier else { return }
    privateAXAcceptedDepthLock.lock()
    privateAXAcceptedDepthBundleId = bundleId
    privateAXAcceptedDepthProcessIdentifier = processIdentifier
    privateAXAcceptedDepth = depth
    privateAXAcceptedDepthUntil = Date().addingTimeInterval(snapshotXCTestChannelPenaltyDuration)
    privateAXAcceptedDepthLock.unlock()
    NSLog("AGENT_DEVICE_RUNNER_PRIVATE_AX_DEPTH_REMEMBERED depth=%ld bundle=%@", depth, bundleId ?? "")
  }

  func rememberedPrivateAXAcceptedDepth(bundleId: String?, processIdentifier: Int?) -> Int? {
    privateAXAcceptedDepthLock.lock()
    defer { privateAXAcceptedDepthLock.unlock() }
    guard Date() < privateAXAcceptedDepthUntil else { return nil }
    guard privateAXAcceptedDepthBundleId == bundleId else { return nil }
    guard let processIdentifier, privateAXAcceptedDepthProcessIdentifier == processIdentifier else {
      return nil
    }
    return privateAXAcceptedDepth
  }

  func clearPrivateAXAcceptedDepth(reason: String) {
    privateAXAcceptedDepthLock.lock()
    let hadMemory = privateAXAcceptedDepth != nil && Date() < privateAXAcceptedDepthUntil
    privateAXAcceptedDepthBundleId = nil
    privateAXAcceptedDepthProcessIdentifier = nil
    privateAXAcceptedDepth = nil
    privateAXAcceptedDepthUntil = .distantPast
    privateAXAcceptedDepthLock.unlock()
    if hadMemory {
      NSLog("AGENT_DEVICE_RUNNER_PRIVATE_AX_DEPTH_MEMORY_CLEARED reason=%@", reason)
    }
  }

  func privateAXSnapshotCapture(
    app: XCUIApplication,
    options: SnapshotOptions,
    deadline: Date = .distantFuture
  ) -> SnapshotBackendCapture? {
    #if os(iOS) && targetEnvironment(simulator)
      let requestedDepth = options.depth ?? 64
      // An explicit --depth request is honored as asked; only default-depth captures consult
      // (and feed) the accepted-depth memory.
      let rememberedDepth =
        options.depth == nil
        ? rememberedPrivateAXAcceptedDepth(
          bundleId: currentBundleId,
          processIdentifier: currentAppProcessIdentifier
        )
        : nil
      let attemptDepths = Self.privateAXAttemptDepths(
        requestedDepth: requestedDepth,
        rememberedDepth: rememberedDepth
      )
      var response: [String: Any] = [:]
      var effectiveDepth = requestedDepth
      var lastError = "unknown private AX snapshot failure"
      for depth in attemptDepths {
        // The first rung always runs (the plan gated entry on its own budget); later rungs
        // stop when the capture-plan deadline is spent so ladder retries can never stack
        // past the runner's main-thread watchdog (#1105).
        if depth != attemptDepths.first, Date() >= deadline {
          NSLog("AGENT_DEVICE_RUNNER_PRIVATE_AX_SNAPSHOT_BUDGET_EXHAUSTED depth=%ld", depth)
          break
        }
        response = RunnerAXSnapshotBridge.snapshotTree(
          for: app,
          maxDepth: depth,
          maxNodes: Self.privateAXSnapshotMaxNodes
        )
        if response["ok"] as? Bool == true {
          effectiveDepth = depth
          break
        }
        lastError = response["error"] as? String ?? lastError
        NSLog(
          "AGENT_DEVICE_RUNNER_PRIVATE_AX_SNAPSHOT_DEPTH_RETRY depth=%ld error=%@",
          depth,
          lastError
        )
      }
      guard response["ok"] as? Bool == true else {
        NSLog("AGENT_DEVICE_RUNNER_PRIVATE_AX_SNAPSHOT_FAILED=%@", lastError)
        return nil
      }
      // Only a capture that actually descended records memory: a first-rung success on a
      // remembered depth deliberately does NOT refresh the TTL, so expiry re-probes the full
      // requested depth once per window instead of capping this screen class forever.
      if options.depth == nil, effectiveDepth != attemptDepths.first {
        rememberPrivateAXAcceptedDepth(
          bundleId: currentBundleId,
          processIdentifier: currentAppProcessIdentifier,
          depth: effectiveDepth
        )
      }
      guard let root = response["root"] as? [String: Any] else {
        NSLog("AGENT_DEVICE_RUNNER_PRIVATE_AX_SNAPSHOT_FAILED=missing root")
        return nil
      }

      let rootFrame = privateAXRect(root["frame"])
      let viewport = privateAXSnapshotViewport(app: app, rootFrame: rootFrame)
      var nodes: [SnapshotNode] = []
      appendPrivateAXNode(
        root,
        to: &nodes,
        options: options,
        viewport: viewport,
        depth: 0,
        parentIndex: nil,
        insideMatchedScope: false
      )
      if nodes.count <= 1 {
        NSLog("AGENT_DEVICE_RUNNER_PRIVATE_AX_SNAPSHOT_SPARSE=%ld", nodes.count)
        return nil
      }

      let depthLimited = effectiveDepth < requestedDepth
      NSLog(
        "AGENT_DEVICE_RUNNER_PRIVATE_AX_SNAPSHOT_USED nodes=%ld depth=%ld",
        nodes.count,
        effectiveDepth
      )
      return SnapshotBackendCapture(
        payload: DataPayload(nodes: nodes, truncated: (response["truncated"] as? Bool) == true),
        effectiveDepth: depthLimited ? effectiveDepth : nil
      )
    #else
      return nil
    #endif
  }

  /// The viewport read is XCTest main-thread work — the exact channel the penalty marks as
  /// grinding on this screen class. Under penalty it reliably burns its full timeout and
  /// falls back anyway (~1s added to every private AX capture on the Bluesky bench feed),
  /// so honor the penalty here the same way capture plans do.
  func shouldReadPrivateAXViewportViaXCTest() -> Bool {
    !hasAbandonedTreeCapture() && !isSnapshotXCTestChannelPenalized(bundleId: currentBundleId)
  }

  private func privateAXSnapshotViewport(app: XCUIApplication, rootFrame: CGRect) -> CGRect {
    let fallback = rootFrame.isEmpty ? CGRect.infinite : rootFrame
    guard shouldReadPrivateAXViewportViaXCTest() else {
      return fallback
    }
    do {
      let viewport = try runMainThreadWork(
        command: nil,
        timeout: 1,
        timeoutError: snapshotMainThreadTimeoutError("reading private AX viewport")
      ) {
        self.safeSnapshotViewport(app: app)
      }
      if viewport.isInfinite || viewport.isNull || viewport.isEmpty {
        return fallback
      }
      return viewport
    } catch {
      NSLog("AGENT_DEVICE_RUNNER_PRIVATE_AX_VIEWPORT_FALLBACK=%@", String(describing: error))
      return fallback
    }
  }

  private func appendPrivateAXNode(
    _ rawNode: [String: Any],
    to nodes: inout [SnapshotNode],
    options: SnapshotOptions,
    viewport: CGRect,
    depth: Int,
    parentIndex: Int?,
    insideMatchedScope: Bool
  ) {
    if let limit = options.depth, depth > limit { return }

    let rect = privateAXRect(rawNode["frame"])
    let label = privateAXString(rawNode["label"])
    let identifier = privateAXString(rawNode["identifier"])
    let value = privateAXString(rawNode["value"])
    let rawType = privateAXInt(rawNode["type"]) ?? 0
    let typeName = elementTypeName(rawElementType: rawType)
    let enabled = privateAXBool(rawNode["enabled"]) ?? true
    let visible = isVisibleInViewport(rect, viewport)
    let interactiveCandidate = privateAXInteractiveCandidate(rawElementType: rawType)
    let filterDecision = flatSnapshotFilterDecision(
      FlatSnapshotFilterNode(
        isRoot: parentIndex == nil,
        label: label,
        identifier: identifier,
        valueText: value.isEmpty ? nil : value,
        visible: visible
      ),
      options: options,
      insideMatchedScope: insideMatchedScope
    )
    let include = filterDecision.include
    let nowInsideScope = filterDecision.insideMatchedScope

    let currentIndex: Int?
    if include {
      currentIndex = nodes.count
      nodes.append(
        SnapshotNode(
          index: nodes.count,
          type: typeName,
          label: label.isEmpty ? nil : label,
          identifier: identifier.isEmpty ? nil : identifier,
          value: value.isEmpty ? nil : value,
          rect: snapshotRect(from: rect),
          enabled: enabled,
          focused: privateAXBool(rawNode["focused"]) == true ? true : nil,
          selected: privateAXBool(rawNode["selected"]) == true ? true : nil,
          hittable: visible && enabled && interactiveCandidate,
          depth: depth,
          parentIndex: parentIndex,
          hiddenContentAbove: nil,
          hiddenContentBelow: nil
        )
      )
    } else {
      currentIndex = parentIndex
    }

    guard let children = rawNode["children"] as? [[String: Any]] else {
      return
    }
    for child in children {
      appendPrivateAXNode(
        child,
        to: &nodes,
        options: options,
        viewport: viewport,
        depth: depth + 1,
        parentIndex: currentIndex,
        insideMatchedScope: nowInsideScope
      )
    }
  }

  private func elementTypeName(rawElementType: Int) -> String {
    if let type = flatSnapshotElementType(rawElementType: rawElementType) {
      return elementTypeName(type)
    }
    return "Element(\(rawElementType))"
  }

  private func privateAXString(_ value: Any?) -> String {
    guard let value else { return "" }
    if let string = value as? String {
      return string.trimmingCharacters(in: .whitespacesAndNewlines)
    }
    return String(describing: value).trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private func privateAXInt(_ value: Any?) -> Int? {
    if let value = value as? Int { return value }
    if let value = value as? NSNumber { return value.intValue }
    return nil
  }

  private func privateAXBool(_ value: Any?) -> Bool? {
    if let value = value as? Bool { return value }
    if let value = value as? NSNumber { return value.boolValue }
    return nil
  }

  private func privateAXRect(_ value: Any?) -> CGRect {
    guard let frame = value as? [String: Any] else {
      return .zero
    }
    return CGRect(
      x: privateAXDouble(frame["x"]) ?? 0,
      y: privateAXDouble(frame["y"]) ?? 0,
      width: privateAXDouble(frame["width"]) ?? 0,
      height: privateAXDouble(frame["height"]) ?? 0
    )
  }

  private func privateAXDouble(_ value: Any?) -> Double? {
    if let value = value as? Double { return value }
    if let value = value as? NSNumber { return value.doubleValue }
    return nil
  }
}

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
    currentBundleId = "xyz.blueskyweb.app"
    defer {
      currentBundleId = nil
      clearSnapshotXCTestChannelPenalty(reason: "test-cleanup")
      abandonedTreeCaptureCount = 0
    }

    XCTAssertTrue(shouldReadPrivateAXViewportViaXCTest())

    penalizeSnapshotXCTestChannel(bundleId: "xyz.blueskyweb.app", reason: "test")
    XCTAssertFalse(shouldReadPrivateAXViewportViaXCTest())

    clearSnapshotXCTestChannelPenalty(reason: "test")
    XCTAssertTrue(shouldReadPrivateAXViewportViaXCTest())

    abandonedTreeCaptureCount = 1
    XCTAssertFalse(shouldReadPrivateAXViewportViaXCTest())
  }

  func testPrivateAXScopeSelectsSubtreeNotMatchingLabels() {
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
    var nodes: [SnapshotNode] = []
    appendPrivateAXNode(
      tree,
      to: &nodes,
      options: SnapshotOptions(interactiveOnly: false, depth: nil, scope: "homeScreen", raw: false),
      viewport: .infinite,
      depth: 0,
      parentIndex: nil,
      insideMatchedScope: false
    )

    let labels = nodes.compactMap { $0.label ?? $0.identifier }
    XCTAssertTrue(labels.contains("homeScreen"))
    // Descendants of the matched scope are included even when they do not contain the text.
    XCTAssertTrue(labels.contains("Post body without the scope text"))
    XCTAssertFalse(labels.contains("unrelated sibling"))
  }

  func testPrivateAXInteractiveFiltersLoginLikeHiddenDrawer() {
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
    var nodes: [SnapshotNode] = []
    appendPrivateAXNode(
      tree,
      to: &nodes,
      options: SnapshotOptions(interactiveOnly: true, depth: nil, scope: nil, raw: false),
      viewport: CGRect(x: 0, y: 0, width: 390, height: 844),
      depth: 0,
      parentIndex: nil,
      insideMatchedScope: false
    )

    let labels = nodes.compactMap { $0.label }
    XCTAssertEqual(
      labels,
      ["Blue Sky", "Callstack", "Welcome back", "Email", "Password", "Sign in", "Forgot password?"]
    )
    XCTAssertFalse(labels.contains("Admin settings"))
  }
}
#endif
