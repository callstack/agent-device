#if AGENT_DEVICE_RUNNER_UNIT_TESTS
import XCTest

extension RunnerTests {
  private struct FixedSeedGenerator {
    private var state: UInt64

    init(seed: UInt64) {
      state = seed
    }

    mutating func nextInt(_ upperBound: Int) -> Int {
      precondition(upperBound > 0)
      state = state &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
      return Int(state % UInt64(upperBound))
    }
  }

  private static func invariantNode(
    _ index: Int,
    type: String,
    label: String? = nil,
    rect: SnapshotRect,
    parentIndex: Int?,
    hittable: Bool = false
  ) -> RawAXNode {
    RawAXNode(
      index: index,
      type: type,
      label: label,
      identifier: nil,
      value: nil,
      rect: rect,
      enabled: true,
      focused: nil,
      selected: nil,
      hittable: hittable,
      depth: parentIndex == nil ? 0 : 1,
      parentIndex: parentIndex,
      hiddenContentAbove: nil,
      hiddenContentBelow: nil
    )
  }

  private static func fixedSeedAcquisition(seed: UInt64) -> SnapshotAcquisition {
    var generator = FixedSeedGenerator(seed: seed)
    let viewport = CGRect(x: 0, y: 0, width: 320, height: 240)
    var nodes = [
      invariantNode(
        0,
        type: "Application",
        label: "App",
        rect: SnapshotRect(x: 0, y: 0, width: 320, height: 240),
        parentIndex: nil
      ),
      invariantNode(
        1,
        type: "ScrollView",
        label: "Outer scroll",
        rect: SnapshotRect(x: 16, y: 20, width: 220, height: 180),
        parentIndex: 0
      ),
      invariantNode(
        2,
        type: "ScrollView",
        label: "Inner scroll",
        rect: SnapshotRect(x: 120, y: 40, width: 180, height: 160),
        parentIndex: 1
      ),
    ]

    for index in 3...18 {
      let parentIndex = generator.nextInt(index)
      let type = generator.nextInt(4) == 0 ? "StaticText" : "Button"
      let width = generator.nextInt(120) + 1
      let height = generator.nextInt(48) + 1
      let x = generator.nextInt(360) - 20
      let y = generator.nextInt(280) - 20
      nodes.append(
        invariantNode(
          index,
          type: type,
          label: "seed-\(seed)-\(index)",
          rect: SnapshotRect(
            x: Double(x), y: Double(y), width: Double(width), height: Double(height)),
          parentIndex: parentIndex,
          hittable: true
        )
      )
    }

    return SnapshotAcquisition(
      hint: CaptureHint(
        projection: .regular, depth: nil, interactiveOnly: false, customActions: false),
      nodes: nodes,
      truncated: false,
      effectiveDepth: nil,
      viewport: viewport
    )
  }

  private static func assertFramedNodesStayInsideTheirCumulativeClip(
    _ nodes: [SnapshotPresentation.PresentedNode],
    viewport: CGRect,
    file: StaticString = #filePath,
    line: UInt = #line
  ) {
    let nodesByIndex = Dictionary(uniqueKeysWithValues: nodes.map { ($0.index, $0) })
    for node in nodes {
      let frame = CGRect(
        x: node.rect.x, y: node.rect.y, width: node.rect.width, height: node.rect.height)
      guard !frame.isNull, !frame.isEmpty else {
        XCTAssertFalse(node.hittable, "degenerate regular node is actionable", file: file, line: line)
        continue
      }

      var cumulativeClip = viewport
      var parentIndex = node.parentIndex
      var visited = Set<Int>()
      while let currentIndex = parentIndex, visited.insert(currentIndex).inserted,
        let parent = nodesByIndex[currentIndex]
      {
        if SnapshotVisibilityFold.scrollContainerTypeNames.contains(parent.type) {
          let parentFrame = CGRect(
            x: parent.rect.x,
            y: parent.rect.y,
            width: parent.rect.width,
            height: parent.rect.height
          )
          if !parentFrame.isNull, !parentFrame.isEmpty {
            cumulativeClip = cumulativeClip.intersection(parentFrame)
          }
        }
        parentIndex = parent.parentIndex
      }

      XCTAssertGreaterThanOrEqual(frame.minX, cumulativeClip.minX, file: file, line: line)
      XCTAssertGreaterThanOrEqual(frame.minY, cumulativeClip.minY, file: file, line: line)
      XCTAssertLessThanOrEqual(frame.maxX, cumulativeClip.maxX, file: file, line: line)
      XCTAssertLessThanOrEqual(frame.maxY, cumulativeClip.maxY, file: file, line: line)
    }
  }

  func testRegularPresentationKeepsNestedClipGeometryCumulative() throws {
    let acquisition = SnapshotAcquisition(
      hint: CaptureHint(
        projection: .regular, depth: nil, interactiveOnly: false, customActions: false),
      nodes: [
        Self.invariantNode(
          0,
          type: "Application",
          label: "App",
          rect: SnapshotRect(x: 0, y: 0, width: 320, height: 240),
          parentIndex: nil
        ),
        Self.invariantNode(
          1,
          type: "ScrollView",
          label: "Outer",
          rect: SnapshotRect(x: 16, y: 20, width: 180, height: 180),
          parentIndex: 0
        ),
        Self.invariantNode(
          2,
          type: "ScrollView",
          label: "Inner",
          rect: SnapshotRect(x: 120, y: 40, width: 180, height: 160),
          parentIndex: 1
        ),
        Self.invariantNode(
          3,
          type: "Button",
          label: "Partially visible",
          rect: SnapshotRect(x: 150, y: 80, width: 100, height: 40),
          parentIndex: 2,
          hittable: true
        ),
        Self.invariantNode(
          4,
          type: "Button",
          label: "Escaped child",
          rect: SnapshotRect(x: 210, y: 80, width: 100, height: 40),
          parentIndex: 2,
          hittable: true
        ),
      ],
      truncated: false,
      effectiveDepth: nil,
      viewport: CGRect(x: 0, y: 0, width: 320, height: 240)
    )

    let options = PresentationOptions(
      interactiveOnly: false, depth: nil, scope: nil, raw: false)
    let capture = try SnapshotPresentation.presentRegular(acquisition, options: options)
    let nodes = try XCTUnwrap(capture.payload.nodes)

    XCTAssertEqual(nodes.compactMap(\.label), ["App", "Outer", "Inner", "Partially visible"])
    let clipped = try XCTUnwrap(nodes.first { $0.label == "Partially visible" })
    XCTAssertEqual(clipped.rect.x, 150)
    XCTAssertEqual(clipped.rect.width, 46)
    XCTAssertFalse(nodes.contains { $0.label == "Escaped child" })
    Self.assertFramedNodesStayInsideTheirCumulativeClip(
      nodes, viewport: acquisition.viewport)
  }

  func testRegularPresentationKeepsFramelessSemanticCarriersNonActionableAndNonClipping() throws {
    let acquisition = SnapshotAcquisition(
      hint: CaptureHint(
        projection: .regular, depth: nil, interactiveOnly: true, customActions: false),
      nodes: [
        Self.invariantNode(
          0,
          type: "Application",
          label: "App",
          rect: SnapshotRect(x: 0, y: 0, width: 320, height: 240),
          parentIndex: nil
        ),
        Self.invariantNode(
          1,
          type: "ScrollView",
          label: "Geometryless semantics",
          rect: SnapshotRect(x: 20, y: 20, width: 0, height: 0),
          parentIndex: 0,
          hittable: true
        ),
        Self.invariantNode(
          2,
          type: "Button",
          label: "Child is not clipped",
          rect: SnapshotRect(x: 40, y: 40, width: 80, height: 32),
          parentIndex: 1,
          hittable: true
        ),
        Self.invariantNode(
          3,
          type: "StaticText",
          label: "Zero-area semantics",
          rect: SnapshotRect(x: 40, y: 100, width: 0, height: 20),
          parentIndex: 0,
          hittable: true
        ),
      ],
      truncated: false,
      effectiveDepth: nil,
      viewport: CGRect(x: 0, y: 0, width: 320, height: 240)
    )

    let options = PresentationOptions(
      interactiveOnly: true, depth: nil, scope: nil, raw: false)
    let nodes = try XCTUnwrap(
      try SnapshotPresentation.presentRegular(acquisition, options: options).payload.nodes)

    XCTAssertEqual(nodes.compactMap(\.label), [
      "App", "Geometryless semantics", "Child is not clipped", "Zero-area semantics",
    ])
    XCTAssertEqual(nodes.filter { $0.index != 0 }.map(\.hittable), [false, true, false])
    Self.assertFramedNodesStayInsideTheirCumulativeClip(
      nodes, viewport: acquisition.viewport)
  }

  func testRawPresentationKeepsReportedOffscreenAndFramelessFacts() throws {
    let nodes = [
      Self.invariantNode(
        0,
        type: "Application",
        label: "App",
        rect: SnapshotRect(x: 0, y: 0, width: 100, height: 100),
        parentIndex: nil
      ),
      Self.invariantNode(
        1,
        type: "Button",
        label: "Offscreen",
        rect: SnapshotRect(x: 200, y: 200, width: 40, height: 40),
        parentIndex: 0,
        hittable: true
      ),
      Self.invariantNode(
        2,
        type: "StaticText",
        label: "Frameless",
        rect: SnapshotRect(x: 12, y: 20, width: 0, height: 20),
        parentIndex: 0,
        hittable: true
      ),
    ]
    let options = PresentationOptions(
      interactiveOnly: true, depth: nil, scope: nil, raw: true)
    let raw = try XCTUnwrap(
      SnapshotPresentation.presentRaw(
        SnapshotAcquisition(
          hint: SnapshotPresentation.captureHint(for: options),
          nodes: nodes,
          truncated: false,
          effectiveDepth: nil,
          viewport: .infinite
        ),
        options: options
      ).payload.nodes)

    XCTAssertEqual(raw.map(\.label), ["App", "Offscreen", "Frameless"])
    XCTAssertEqual(raw[1].rect.x, 200)
    XCTAssertEqual(raw[1].rect.width, 40)
    XCTAssertEqual(raw[2].rect.width, 0)
    XCTAssertEqual(raw[2].rect.height, 20)
    XCTAssertEqual(raw[1].hittable, true)
    XCTAssertEqual(raw[2].hittable, true)
  }

  func testFixedSeedRegularPresentationMaintainsCumulativeClipInvariant() throws {
    // Non-vacuity: replacing the regular fold with reported geometry makes the presentation
    // choke point throw `presentation-failed`; removing that check makes this fixed-seed property
    // fail on the first nested-clip case that emits an out-of-clip node.
    for seed in 1...64 {
      let acquisition = Self.fixedSeedAcquisition(seed: UInt64(seed))
      let options = PresentationOptions(
        interactiveOnly: false, depth: nil, scope: nil, raw: false)
      let capture = try SnapshotPresentation.presentRegular(acquisition, options: options)
      let nodes = try XCTUnwrap(capture.payload.nodes)
      Self.assertFramedNodesStayInsideTheirCumulativeClip(
        nodes, viewport: acquisition.viewport)
    }
  }

  func testPresentationFailureKeepsItsNamedSnapshotQualityReason() {
    // Non-vacuity: dropping the typed reason preference in the plan mapper changes the assertion
    // below to `capture-failed`, losing the distinction this contract is meant to preserve.
    let presentationFailure = SnapshotPresentationFailure.regularNodeOutsideCumulativeClip(
      index: 7,
      frame: SnapshotRect(x: 150, y: 40, width: 80, height: 20),
      clip: SnapshotRect(x: 0, y: 0, width: 100, height: 100)
    )
    let captureFailure = Self.snapshotCaptureFailure(for: presentationFailure)

    XCTAssertEqual(captureFailure.code, "IOS_SNAPSHOT_PRESENTATION_FAILED")
    XCTAssertEqual(captureFailure.qualityReasonCode, "presentation-failed")
    XCTAssertEqual(Self.snapshotQualityReasonCode(for: captureFailure), "presentation-failed")
    XCTAssertNotEqual(Self.snapshotQualityReasonCode(for: captureFailure), "capture-failed")
    XCTAssertTrue(captureFailure.message.contains("cumulative clip"))

    let warning = Self.legacyQualityMessage(
      SnapshotQuality(
        state: "recovered",
        backend: "queries",
        reason: captureFailure.message,
        reasonCode: captureFailure.qualityReasonCode,
        effectiveDepth: nil,
        collapsedLeafIndexes: nil,
        customActions: nil
      )
    )
    XCTAssertTrue(warning?.contains("runner bug") == true)
    XCTAssertFalse(warning?.contains("fixing the app's accessibility") == true)
  }
}
#endif
