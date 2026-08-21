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

    let capture = try XCTUnwrap(SnapshotPresentation.present(
      SnapshotAcquisition(
        hint: CaptureHint(
          projection: .raw, depth: nil, interactiveOnly: false, customActions: false),
        nodes: [raw],
        truncated: true,
        effectiveDepth: 4,
        customActions: SnapshotCustomActionCoverage(
          read: 1,
          candidates: 2,
          truncated: 0,
          blocked: false
        ),
        viewport: .infinite
      ),
      options: PresentationOptions(
        interactiveOnly: true,
        depth: nil,
        scope: nil,
        raw: true
      )
    ))
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
      SnapshotPresentation.presentRegular(
        SnapshotAcquisition(
          hint: CaptureHint(
            projection: .regular, depth: nil, interactiveOnly: false, customActions: false),
          nodes: acquired, truncated: false, effectiveDepth: nil,
          viewport: CGRect(x: 0, y: 0, width: 1_000, height: 1_000)),
        options: PresentationOptions(interactiveOnly: false, depth: nil, scope: nil, raw: false)
      ).payload.nodes
    )
    let interactive = try XCTUnwrap(
      SnapshotPresentation.presentRegular(
        SnapshotAcquisition(
          hint: CaptureHint(
            projection: .regular, depth: nil, interactiveOnly: true, customActions: false),
          nodes: acquired, truncated: false, effectiveDepth: nil,
          viewport: CGRect(x: 0, y: 0, width: 1_000, height: 1_000)),
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
      SnapshotPresentation.presentRaw(
        SnapshotAcquisition(
          hint: CaptureHint(
            projection: .raw, depth: nil, interactiveOnly: false, customActions: false),
          nodes: acquired, truncated: false, effectiveDepth: nil, viewport: .infinite),
        options: PresentationOptions(interactiveOnly: true, depth: nil, scope: nil, raw: true)
      ).payload.nodes
    )
    XCTAssertEqual(raw.map(\.index), Array(0...10))
    XCTAssertEqual(raw.last?.depth, 2)
    XCTAssertEqual(raw.last?.parentIndex, 9)
  }

  func testRegularPresentationRoutesThroughVisibilityFold() {
    let nodes = [
      RawAXNode(
        index: 0, type: "Application", label: "App", identifier: nil, value: nil,
        rect: SnapshotRect(x: 0, y: 0, width: 100, height: 100), enabled: true,
        focused: nil, selected: nil, hittable: false, depth: 0, parentIndex: nil,
        hiddenContentAbove: nil, hiddenContentBelow: nil),
      RawAXNode(
        index: 1, type: "Button", label: "Outside viewport", identifier: nil, value: nil,
        rect: SnapshotRect(x: 200, y: 200, width: 40, height: 40), enabled: true,
        focused: nil, selected: nil, hittable: true, depth: 1, parentIndex: 0,
        hiddenContentAbove: nil, hiddenContentBelow: nil),
    ]
    let acquisition = SnapshotAcquisition(
      hint: CaptureHint(
        projection: .regular, depth: nil, interactiveOnly: false, customActions: false),
      nodes: nodes,
      truncated: false,
      effectiveDepth: nil,
      viewport: CGRect(x: 0, y: 0, width: 100, height: 100)
    )

    let presented = SnapshotPresentation.presentRegular(
      acquisition,
      options: PresentationOptions(
        interactiveOnly: false, depth: nil, scope: nil, raw: false)
    ).payload.nodes

    XCTAssertEqual(presented?.compactMap(\.label), ["App"])
  }

  func testSnapshotPresentationOwnsScopeAndRelativeDepth() throws {
    // Non-vacuity: disconnecting applyScope produces eight scope, depth, and raw-projection failures.
    func node(
      _ index: Int,
      type: String,
      label: String? = nil,
      identifier: String? = nil,
      depth: Int,
      parentIndex: Int?
    ) -> RawAXNode {
      RawAXNode(
        index: index,
        type: type,
        label: label,
        identifier: identifier,
        value: nil,
        rect: SnapshotRect(x: 0, y: Double(index * 20), width: 100, height: 20),
        enabled: true,
        focused: nil,
        selected: nil,
        hittable: type == "Button",
        depth: depth,
        parentIndex: parentIndex,
        hiddenContentAbove: nil,
        hiddenContentBelow: nil
      )
    }

    let acquisition = SnapshotAcquisition(
      hint: CaptureHint(
        projection: .regular, depth: nil, interactiveOnly: true, customActions: false),
      nodes: [
        node(0, type: "Application", label: "App", depth: 0, parentIndex: nil),
        node(1, type: "Button", label: "Earlier sibling", depth: 1, parentIndex: 0),
        node(2, type: "Other", identifier: "scope-root", depth: 1, parentIndex: 0),
        node(3, type: "StaticText", label: "Child", depth: 2, parentIndex: 2),
        node(4, type: "Image", depth: 2, parentIndex: 2),
        node(5, type: "Button", label: "Grandchild", depth: 3, parentIndex: 3),
        node(6, type: "Button", label: "Outside sibling", depth: 1, parentIndex: 0),
      ],
      truncated: false,
      effectiveDepth: nil,
      viewport: CGRect(x: 0, y: 0, width: 1_000, height: 1_000)
    )
    let options = PresentationOptions(
      interactiveOnly: true,
      depth: 1,
      scope: " SCOPE-ROOT ",
      raw: false
    )
    let capture = try XCTUnwrap(SnapshotPresentation.present(acquisition, options: options))
    let nodes = try XCTUnwrap(capture.payload.nodes)

    XCTAssertEqual(nodes.map(\.label), [nil, "Child"])
    XCTAssertEqual(nodes.map(\.identifier), ["scope-root", nil])
    XCTAssertEqual(nodes.map(\.index), [0, 1])
    XCTAssertEqual(nodes.map(\.depth), [0, 1])
    XCTAssertEqual(nodes.map(\.parentIndex), [nil, 0])
    XCTAssertEqual(capture.qualityPayload?.nodes?.count, 6)

    let raw = try XCTUnwrap(
      SnapshotPresentation.presentRaw(
        SnapshotAcquisition(
          hint: CaptureHint(
            projection: .raw, depth: nil, interactiveOnly: false, customActions: false),
          nodes: acquisition.nodes,
          truncated: false,
          effectiveDepth: nil,
          viewport: .infinite
        ),
        options: PresentationOptions(
          interactiveOnly: true,
          depth: 1,
          scope: "scope-root",
          raw: true
        )
      ).payload.nodes
    )
    XCTAssertEqual(raw.map(\.type), ["Other", "StaticText", "Image"])
    XCTAssertEqual(raw.map(\.depth), [0, 1, 1])

    let hint = SnapshotPresentation.captureHint(for: options)
    XCTAssertNil(hint.depth)
    XCTAssertTrue(hint.interactiveOnly)
    XCTAssertEqual(hint.projection, .regular)

    let missing = try XCTUnwrap(SnapshotPresentation.present(
      acquisition,
      options: PresentationOptions(
        interactiveOnly: true,
        depth: 1,
        scope: "missing",
        raw: false
      )
    ))
    XCTAssertEqual(missing.payload.nodes?.count, 0)
    XCTAssertNil(RunnerTests.sparsePayloadReason(try XCTUnwrap(missing.qualityPayload)))
  }

  /// #1797 D4: a backend that answers a `--raw` request with a regular capture (or the reverse)
  /// loses its tier instead of having its output relabeled. Non-vacuity: dropping the projection
  /// guard makes both `XCTAssertNil` assertions fail, and the raw projection then returns the
  /// regular capture's four nodes under the raw label.
  func testPresentationRefusesAnAcquisitionCapturedForTheOtherProjection() throws {
    func node(_ index: Int, type: String, label: String?, parentIndex: Int?) -> RawAXNode {
      RawAXNode(
        index: index, type: type, label: label, identifier: nil, value: nil,
        rect: SnapshotRect(x: 0, y: Double(index * 20), width: 100, height: 20),
        enabled: true, focused: nil, selected: nil, hittable: false,
        depth: parentIndex == nil ? 0 : 1, parentIndex: parentIndex,
        hiddenContentAbove: nil, hiddenContentBelow: nil
      )
    }
    let nodes = [
      node(0, type: "Application", label: "App", parentIndex: nil),
      node(1, type: "Button", label: "Continue", parentIndex: 0),
    ]
    let rawRequest = PresentationOptions(
      interactiveOnly: false, depth: nil, scope: nil, raw: true)
    let regularRequest = PresentationOptions(
      interactiveOnly: false, depth: nil, scope: nil, raw: false)

    let regularAcquisition = SnapshotAcquisition(
      hint: SnapshotPresentation.captureHint(for: regularRequest),
      nodes: nodes, truncated: false, effectiveDepth: nil,
      viewport: CGRect(x: 0, y: 0, width: 100, height: 100))
    let rawAcquisition = SnapshotAcquisition(
      hint: SnapshotPresentation.captureHint(for: rawRequest),
      nodes: nodes, truncated: false, effectiveDepth: nil, viewport: .infinite)

    XCTAssertNil(SnapshotPresentation.present(regularAcquisition, options: rawRequest))
    XCTAssertNil(SnapshotPresentation.present(rawAcquisition, options: regularRequest))
    XCTAssertEqual(
      SnapshotPresentation.present(rawAcquisition, options: rawRequest)?.payload.nodes?.count, 2)
    XCTAssertEqual(
      SnapshotPresentation.present(regularAcquisition, options: regularRequest)?
        .payload.nodes?.count, 2)
  }

  /// The one derivation every backend reads. Non-vacuity: returning the request's own depth for a
  /// scoped capture, or keeping `interactiveOnly` on the raw projection, each fails one assertion.
  func testCaptureHintIsTheOnlyAcquisitionViewOfARequest() {
    let scoped = SnapshotPresentation.captureHint(
      for: PresentationOptions(
        interactiveOnly: true, depth: 2, scope: "Settings", raw: false))
    // Scope re-roots the tree and depth counts from that root: neither can narrow acquisition.
    XCTAssertNil(scoped.depth)
    XCTAssertEqual(scoped.projection, .regular)

    let depthOnly = SnapshotPresentation.captureHint(
      for: PresentationOptions(interactiveOnly: true, depth: 2, scope: nil, raw: false))
    XCTAssertEqual(depthOnly.depth, 2)

    // The raw projection is the acquired tree, so `--raw -i` never narrows acquisition either.
    let raw = SnapshotPresentation.captureHint(
      for: PresentationOptions(interactiveOnly: true, depth: 3, scope: nil, raw: true))
    XCTAssertEqual(raw.projection, .raw)
    XCTAssertFalse(raw.interactiveOnly)
    XCTAssertEqual(raw.depth, 3)
    XCTAssertTrue(raw.isRaw)

    let actions = SnapshotPresentation.captureHint(
      for: PresentationOptions(
        interactiveOnly: false, depth: nil, scope: nil, raw: false, customActions: true))
    XCTAssertTrue(actions.customActions)
  }
}
#endif
