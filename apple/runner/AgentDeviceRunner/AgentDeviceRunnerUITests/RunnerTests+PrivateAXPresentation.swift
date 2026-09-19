import XCTest
import AgentDeviceSnapshotPresentation

/// Reported facts for one private-AX element, read once so every consumer describes a node the
/// same way.
struct PrivateAXFields {
  let rect: CGRect
  let label: String
  let identifier: String
  let value: String
  let rawType: Int
  let elementType: XCUIElement.ElementType?
  let enabled: Bool
  let focused: Bool?
  let selected: Bool?
  let actions: [String]?
  let children: [[String: Any]]
}

extension RunnerTests {
  /// Private-AX acquisition: ONE serializer for both projections. Reported facts at traversal
  /// depth -- membership, the clip fold, scroll hints, and collapsed depth are
  /// `SnapshotPresentation`'s alone (#1797). The traversal-depth cut is the backend's one
  /// narrowing, complete for raw (raw depth *is* traversal depth) and a declared residue for
  /// regular; the frame carried here is the one the platform reported, and
  /// `SnapshotGeometrySpace.normalized` turns it once, after this walk, before presentation (#2661).
  func privateAXAcquisition(
    rawRoot: [String: Any],
    hint: CaptureHint
  ) -> [RawAXNode] {
    var nodes: [RawAXNode] = []
    appendPrivateAXNode(rawRoot, to: &nodes, hint: hint, depth: 0, parentIndex: nil)
    return nodes
  }

  private func appendPrivateAXNode(_ raw: [String: Any], to nodes: inout [RawAXNode],
    hint: CaptureHint, depth: Int, parentIndex: Int?)
  {
    if let limit = hint.rawTraversalDepth, depth > limit { return }
    let fields = privateAXFields(raw)
    let index = nodes.count
    nodes.append(privateAXNode(fields, index: index, depth: depth, parentIndex: parentIndex))
    for child in fields.children {
      appendPrivateAXNode(child, to: &nodes, hint: hint, depth: depth + 1, parentIndex: index)
    }
  }

  private func privateAXFields(_ raw: [String: Any]) -> PrivateAXFields {
    let rawType = privateAXPresentationInt(raw["type"]) ?? 0
    return PrivateAXFields(
      rect: privateAXRect(raw["frame"]),
      label: privateAXPresentationString(raw["label"]),
      identifier: privateAXPresentationString(raw["identifier"]),
      value: privateAXPresentationString(raw["value"]),
      rawType: rawType,
      elementType: privateAXElementType(rawElementType: rawType),
      enabled: privateAXPresentationBool(raw["enabled"]) ?? true,
      focused: privateAXPresentationBool(raw["focused"]) == true ? true : nil,
      selected: privateAXPresentationBool(raw["selected"]) == true ? true : nil,
      actions: raw["actions"] as? [String],
      children: raw["children"] as? [[String: Any]] ?? []
    )
  }

  private func privateAXNode(_ fields: PrivateAXFields, index: Int, depth: Int,
    parentIndex: Int?) -> RawAXNode
  {
    return RawAXNode(index: index,
      type: fields.elementType.map(elementTypeName) ?? "Element(\(fields.rawType))",
      label: fields.label.isEmpty ? nil : fields.label,
      identifier: fields.identifier.isEmpty ? nil : fields.identifier,
      value: fields.value.isEmpty ? nil : fields.value,
      rect: SnapshotRect(fields.rect), enabled: fields.enabled,
      focused: fields.focused, selected: fields.selected,
      hittable: false,
      depth: depth, parentIndex: parentIndex, hiddenContentAbove: nil, hiddenContentBelow: nil,
      actions: fields.actions)
  }

  private func privateAXPresentationString(_ value: Any?) -> String {
    guard let value else { return "" }
    return (value as? String ?? String(describing: value))
      .trimmingCharacters(in: .whitespacesAndNewlines)
  }
  private func privateAXPresentationInt(_ value: Any?) -> Int? {
    (value as? Int) ?? (value as? NSNumber)?.intValue
  }
  private func privateAXPresentationBool(_ value: Any?) -> Bool? {
    (value as? Bool) ?? (value as? NSNumber)?.boolValue
  }
}

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
extension RunnerTests {
  fileprivate static func privateAXFrame(
    _ x: Double, _ y: Double, _ width: Double, _ height: Double
  ) -> [String: Any] {
    ["x": x, "y": y, "width": width, "height": height]
  }

  /// A scroll container whose second row is scrolled out of the viewport, plus an unlabeled
  /// decoration: the shapes the regular projection folds away and the raw projection must keep.
  fileprivate static var privateAXScrolledFixture: [String: Any] {
    let frame = privateAXFrame
    return ["type": Int(XCUIElement.ElementType.application.rawValue),
      "label": "Element", "frame": frame(0, 0, 402, 874), "children": [[
        "type": Int(XCUIElement.ElementType.scrollView.rawValue), "frame": frame(0, 96, 402, 700),
        "actions": ["Scroll down"],
        "children": [
          ["type": Int(XCUIElement.ElementType.button.rawValue), "label": "Profile picture",
            "frame": frame(16, 120, 44, 44),
            "children": [["type": Int(XCUIElement.ElementType.image.rawValue),
              "frame": frame(16, 120, 1, 1)]]],
          ["type": Int(XCUIElement.ElementType.button.rawValue), "label": "Theme",
            "frame": frame(16, 900, 360, 44)]]]]]
  }

  /// Acquire with the private-AX serializer, run the one normalization pass the production capture
  /// plan runs (`captureWithBackend`), then present through the shared regular fold -- the production
  /// route for this backend since the fold moved into presentation (#1797, #2661).
  fileprivate func privateAXRegularPresentation(
    rawRoot: [String: Any],
    viewport: CGRect,
    interactiveOnly: Bool = false
  ) throws -> [PresentedNode] {
    let hint = CaptureHint(
      projection: .regular, depth: nil, regularPresentedDepth: nil,
      interactiveOnly: interactiveOnly, customActions: false)
    let nodes = privateAXNormalizedAcquisition(
      rawRoot: rawRoot, hint: hint, viewport: viewport,
      interfaceOrientation: RunnerInterfaceOrientation.portrait)
    return try SnapshotPresentation.presentRegular(
      SnapshotAcquisition(
        hint: hint, nodes: nodes, truncated: false, effectiveDepth: nil, viewport: viewport,
        interfaceOrientation: RunnerInterfaceOrientation.portrait),
      options: PresentationOptions(
        interactiveOnly: interactiveOnly, depth: nil, scope: nil, raw: false),
      policy: .cursorProjected
    ).nodes
  }

  /// Acquire, then normalize once -- the exact pair `captureWithBackend` runs for this backend.
  fileprivate func privateAXNormalizedAcquisition(
    rawRoot: [String: Any],
    hint: CaptureHint,
    viewport: CGRect,
    interfaceOrientation: Int
  ) -> [RawAXNode] {
    SnapshotGeometrySpace.normalized(
      nodes: privateAXAcquisition(rawRoot: rawRoot, hint: hint),
      viewport: viewport,
      interfaceOrientation: interfaceOrientation
    )
  }

  /// The one normalization pass has to reach the node it publishes: this asserts the rotated rect of
  /// a key under a turned surface host, and an untouched sibling under the app's own window, so a
  /// pass that drops the space a subtree declared fails here.
  func testPrivateAXAcquisitionPublishesATurnedSurfaceHostInAppOrientationSpace() {
    let frame = Self.privateAXFrame
    let appWindow: [String: Any] = [
      "type": Int(XCUIElement.ElementType.window.rawValue),
      "frame": frame(0, 0, 874, 402),
      "children": [
        ["type": Int(XCUIElement.ElementType.button.rawValue), "label": "Home",
          "frame": frame(204, 323, 91, 55), "children": []]
      ]
    ]
    let keyboardWindow: [String: Any] = [
      "type": Int(XCUIElement.ElementType.window.rawValue),
      "frame": frame(0, 0, 874, 402),
      "children": [
        ["type": Int(XCUIElement.ElementType.other.rawValue),
          "frame": frame(0, 0, 402, 874),
          "children": [
            ["type": Int(XCUIElement.ElementType.key.rawValue), "label": "q",
              "frame": frame(154, 77, 45, 72), "children": []]
          ]]
      ]
    ]
    let hint = CaptureHint(
      projection: .raw, depth: nil, regularPresentedDepth: nil,
      interactiveOnly: false, customActions: false)
    let nodes = privateAXNormalizedAcquisition(
      rawRoot: [
        "type": Int(XCUIElement.ElementType.application.rawValue),
        "label": "Element", "frame": frame(0, 0, 874, 402),
        "children": [appWindow, keyboardWindow]
      ],
      hint: hint,
      viewport: CGRect(x: 0, y: 0, width: 874, height: 402),
      interfaceOrientation: RunnerInterfaceOrientation.landscapeRight
    )

    // Measured on iPhone 17 Pro (26.2): the key plane's left column arrives 154 pt along the device's
    // long axis and comes back 203 pt down the app's short one.
    XCTAssertEqual(
      nodes.first { $0.label == "q" }?.rect,
      SnapshotRect(x: 77, y: 203, width: 72, height: 45)
    )
    XCTAssertEqual(
      nodes.first { $0.label == "Home" }?.rect,
      SnapshotRect(x: 204, y: 323, width: 91, height: 55)
    )
  }

  func testPrivateAXRegularPresentationProjectsToViewportAndKeepsScrollHint() throws {
    let nodes = try privateAXRegularPresentation(
      rawRoot: Self.privateAXScrolledFixture,
      viewport: CGRect(x: 0, y: 0, width: 402, height: 874))
    XCTAssertEqual(nodes.compactMap(\.label), ["Element", "Profile picture"])
    let scrollView = nodes.first { $0.type == "ScrollView" }
    XCTAssertEqual(scrollView?.hiddenContentBelow, true)
    XCTAssertEqual(scrollView?.actions, ["Scroll down"])
  }

  /// #1797 D4: the raw projection is the acquired tree. The offscreen row and the sub-pixel
  /// decoration the regular projection folds away are both present, at traversal depth, and every
  /// regular node still appears -- `regular ⊆ raw` on the same capture.
  func testPrivateAXRawProjectionKeepsEveryAcquiredNode() throws {
    let viewport = CGRect(x: 0, y: 0, width: 402, height: 874)
    let root = Self.privateAXScrolledFixture
    let regular = try privateAXRegularPresentation(rawRoot: root, viewport: viewport,
      interactiveOnly: true)
    let raw = privateAXNormalizedAcquisition(rawRoot: root,
      hint: CaptureHint(
        projection: .raw, depth: nil, regularPresentedDepth: nil,
        interactiveOnly: false, customActions: false),
      viewport: viewport,
      interfaceOrientation: RunnerInterfaceOrientation.portrait)

    XCTAssertEqual(raw.map(\.type), ["Application", "ScrollView", "Button", "Image", "Button"])
    XCTAssertEqual(raw.map(\.depth), [0, 1, 2, 3, 2])
    XCTAssertEqual(raw.map(\.parentIndex), [nil, 0, 1, 2, 1])
    XCTAssertEqual(raw.compactMap(\.label), ["Element", "Profile picture", "Theme"])
    // The offscreen row is a reported fact in raw, and reported facts do not become hittable
    // just because the projection kept them.
    XCTAssertEqual(raw.last?.hittable, false)
    XCTAssertTrue(raw.allSatisfy { $0.hiddenContentAbove == nil && $0.hiddenContentBelow == nil })

    let rawKeys = Set(raw.map { "\($0.type)-\($0.label ?? "")-\($0.rect.y)" })
    for node in regular {
      XCTAssertTrue(
        rawKeys.contains("\(node.type)-\(node.label ?? "")-\(node.rect.y)"),
        "regular node \(node.type)/\(node.label ?? "") is missing from the raw projection"
      )
    }
    XCTAssertGreaterThan(raw.count, regular.count)
  }

  /// Raw depth is traversal depth, so a raw `--depth` request is the one narrowing this backend
  /// can prove complete.
  func testPrivateAXRawProjectionAppliesRequestedTraversalDepth() {
    let raw = privateAXNormalizedAcquisition(rawRoot: Self.privateAXScrolledFixture,
      hint: CaptureHint(
        projection: .raw, depth: 2, regularPresentedDepth: nil,
        interactiveOnly: false, customActions: false),
      viewport: CGRect(x: 0, y: 0, width: 402, height: 874),
      interfaceOrientation: RunnerInterfaceOrientation.portrait)
    XCTAssertEqual(raw.map(\.type), ["Application", "ScrollView", "Button", "Button"])
    XCTAssertEqual(raw.map(\.depth), [0, 1, 2, 2])
  }

  func testPrivateAXPresentationKeepsOffscreenSubtreeExcludedWhenChildFramesAreClamped() throws {
    let frame = Self.privateAXFrame
    let root: [String: Any] = ["type": Int(XCUIElement.ElementType.application.rawValue),
      "label": "Element", "frame": frame(0, 0, 402, 874), "children": [[
        "type": Int(XCUIElement.ElementType.table.rawValue), "frame": frame(0, 96, 402, 700),
        "children": [["type": Int(XCUIElement.ElementType.cell.rawValue),
          "label": "Theme", "frame": frame(0, 900, 402, 44), "children": [[
            "type": Int(XCUIElement.ElementType.staticText.rawValue),
            "label": "Theme", "frame": frame(16, 96, 120, 44)],
          ["type": Int(XCUIElement.ElementType.switch.rawValue),
            "label": "Theme", "frame": frame(340, 96, 46, 44)]]]]]]]

    let nodes = try privateAXRegularPresentation(
      rawRoot: root, viewport: CGRect(x: 0, y: 0, width: 402, height: 874))

    XCTAssertEqual(nodes.compactMap(\.label), ["Element"])
    XCTAssertEqual(nodes.first { $0.type == "Table" }?.hiddenContentBelow, true)
  }

  func testPrivateAXGeometrylessSemanticsAreNeverActionableOrScrollContexts() throws {
    let zero = ["x": 0, "y": 0, "width": 0, "height": 0]
    let root: [String: Any] = ["type": Int(XCUIElement.ElementType.application.rawValue),
      "label": "Element", "frame": ["x": 0, "y": 0, "width": 402, "height": 874],
      "children": [["type": Int(XCUIElement.ElementType.scrollView.rawValue),
        "label": "Settings semantics", "frame": zero, "children": [[
          "type": Int(XCUIElement.ElementType.button.rawValue), "label": "Theme", "frame": zero],
        ["type": Int(XCUIElement.ElementType.other.rawValue), "frame": zero]]]]]
    let nodes = try privateAXRegularPresentation(
      rawRoot: root, viewport: CGRect(x: 0, y: 0, width: 402, height: 874),
      interactiveOnly: true)
    XCTAssertEqual(nodes.compactMap(\.label), ["Element", "Settings semantics", "Theme"])
    XCTAssertEqual(nodes.filter { $0.index != 0 }.map(\.hittable), [false, false])
    XCTAssertFalse(nodes.contains { $0.type == "Other" })
    XCTAssertTrue(nodes.allSatisfy { $0.hiddenContentAbove == nil && $0.hiddenContentBelow == nil })
  }
}
#endif
