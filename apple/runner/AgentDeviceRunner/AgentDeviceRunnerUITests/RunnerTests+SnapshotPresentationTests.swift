#if AGENT_DEVICE_RUNNER_UNIT_TESTS
import XCTest

extension RunnerTests {
  func testSnapshotPresentationPreservesCurrentWireShape() throws {
    // Non-vacuity: setting PresentedNode.label to nil made this test execute once and fail on the
    // missing `"label":"Continue"` field before the production mapping was restored.
    let raw = RawAXNode(
      index: 3,
      type: "Button",
      label: "Continue",
      identifier: "continue-button",
      value: "Ready",
      rect: SnapshotRect(x: 10, y: 20, width: 100, height: 44),
      enabled: true,
      focused: true,
      selected: true,
      hittable: true,
      depth: 2,
      parentIndex: 1,
      hiddenContentAbove: true,
      hiddenContentBelow: true,
      actions: ["Open menu"]
    )
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]

    let capture = SnapshotPresentation.present(
      SnapshotAcquisition(
        nodes: [raw],
        truncated: true,
        effectiveDepth: 4,
        customActions: SnapshotCustomActionCoverage(
          read: 1,
          candidates: 2,
          truncated: 0,
          blocked: false
        )
      ),
      options: PresentationOptions(
        interactiveOnly: true,
        depth: nil,
        scope: nil,
        raw: true
      )
    )
    let nodes = try XCTUnwrap(capture.payload.nodes)
    let encoded = try encoder.encode(nodes)

    XCTAssertEqual(
      String(decoding: encoded, as: UTF8.self),
      #"[{"actions":["Open menu"],"depth":2,"enabled":true,"focused":true,"hiddenContentAbove":true,"hiddenContentBelow":true,"hittable":true,"identifier":"continue-button","index":3,"label":"Continue","parentIndex":1,"rect":{"height":44,"width":100,"x":10,"y":20},"selected":true,"type":"Button","value":"Ready"}]"#
    )
    XCTAssertEqual(capture.payload.truncated, true)
    XCTAssertEqual(capture.effectiveDepth, 4)
    XCTAssertEqual(capture.customActions?.read, 1)
    XCTAssertEqual(capture.customActions?.candidates, 2)
  }

  func testSnapshotPresentationOwnsBackendNeutralEligibility() throws {
    // Non-vacuity: forcing `isEligibleForRegularPresentation` to return true made this test execute
    // once and fail exactly four membership/index/depth/parent assertions before restoration.
    func node(
      _ index: Int,
      type: String,
      label: String? = nil,
      identifier: String? = nil,
      value: String? = nil,
      hittable: Bool = false,
      depth: Int? = nil,
      parentIndex: Int? = 0
    ) -> RawAXNode {
      RawAXNode(
        index: index,
        type: type,
        label: label,
        identifier: identifier,
        value: value,
        rect: SnapshotRect(x: Double(index * 10), y: 0, width: 8, height: 8),
        enabled: true,
        focused: nil,
        selected: nil,
        hittable: hittable,
        depth: depth ?? (parentIndex == nil ? 0 : 1),
        parentIndex: parentIndex,
        hiddenContentAbove: nil,
        hiddenContentBelow: nil
      )
    }

    let acquired = [
      node(0, type: "Application", parentIndex: nil),
      node(1, type: "Button"),
      node(2, type: "Image", label: "Product photo"),
      node(3, type: "Other", identifier: "promo-banner"),
      node(4, type: "Other", value: "3 items"),
      node(5, type: "Image"),
      node(6, type: "Image", hittable: true),
      node(7, type: "ScrollView"),
      node(8, type: "Table"),
      node(9, type: "Other"),
      node(10, type: "StaticText", label: "Reparented content", depth: 2, parentIndex: 9),
    ]
    let regular = try XCTUnwrap(
      SnapshotPresentation.present(
        SnapshotAcquisition(nodes: acquired, truncated: false, effectiveDepth: nil),
        options: PresentationOptions(interactiveOnly: false, depth: nil, scope: nil, raw: false)
      ).payload.nodes
    )
    let interactive = try XCTUnwrap(
      SnapshotPresentation.present(
        SnapshotAcquisition(nodes: acquired, truncated: false, effectiveDepth: nil),
        options: PresentationOptions(interactiveOnly: true, depth: nil, scope: nil, raw: false)
      ).payload.nodes
    )

    XCTAssertEqual(
      regular.map(\.type),
      ["Application", "Button", "Image", "Other", "Other", "ScrollView", "Table", "StaticText"]
    )
    XCTAssertEqual(interactive.map(\.type), regular.map(\.type))
    XCTAssertEqual(regular.map(\.index), [0, 1, 2, 3, 4, 5, 6, 7])
    XCTAssertEqual(regular.map(\.depth), [0, 1, 1, 1, 1, 1, 1, 1])
    XCTAssertEqual(regular.map(\.parentIndex), [nil, 0, 0, 0, 0, 0, 0, 0])
    XCTAssertEqual(regular.compactMap(\.label), ["Product photo", "Reparented content"])
    XCTAssertEqual(regular.compactMap(\.identifier), ["promo-banner"])
    XCTAssertEqual(regular.compactMap(\.value), ["3 items"])

    let raw = try XCTUnwrap(
      SnapshotPresentation.present(
        SnapshotAcquisition(nodes: acquired, truncated: false, effectiveDepth: nil),
        options: PresentationOptions(interactiveOnly: true, depth: nil, scope: nil, raw: true)
      ).payload.nodes
    )
    XCTAssertEqual(raw.map(\.index), Array(0...10))
    XCTAssertEqual(raw.last?.depth, 2)
    XCTAssertEqual(raw.last?.parentIndex, 9)
  }
}
#endif
