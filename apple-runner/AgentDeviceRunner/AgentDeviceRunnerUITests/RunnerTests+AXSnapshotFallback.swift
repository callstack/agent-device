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

  func privateAXSnapshotCapture(
    app: XCUIApplication,
    options: SnapshotOptions,
    deadline: Date = .distantFuture
  ) -> SnapshotBackendCapture? {
    #if os(iOS) && targetEnvironment(simulator)
      let requestedDepth = options.depth ?? 64
      var attemptDepths = [requestedDepth]
      attemptDepths.append(
        contentsOf: Self.privateAXSnapshotDepthLadder.filter { $0 < requestedDepth }
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
      guard let root = response["root"] as? [String: Any] else {
        NSLog("AGENT_DEVICE_RUNNER_PRIVATE_AX_SNAPSHOT_FAILED=missing root")
        return nil
      }

      // If the app frame is unavailable, the private root's own frame is the reliable screen
      // rect here. Avoid public window queries: stale transient windows can record XCTest
      // failures after the runner already returned a successful command response.
      var viewport = safeSnapshotViewport(app: app)
      let rootFrame = privateAXRect(root["frame"])
      if viewport.isInfinite || viewport.isNull || viewport.isEmpty, !rootFrame.isEmpty {
        viewport = rootFrame
      }
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
