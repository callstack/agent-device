#if AGENT_DEVICE_RUNNER_UNIT_TESTS
import XCTest
import AgentDeviceSnapshotPresentation

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
      placeholder: "Type here",
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

    let capture = try XCTUnwrap(try SnapshotPresentation.present(
      SnapshotAcquisition(
        hint: CaptureHint(
          projection: .raw, depth: nil, regularPresentedDepth: nil,
          interactiveOnly: false, customActions: false),
        nodes: [raw],
        truncated: true,
        effectiveDepth: 4,
        customActions: SnapshotCustomActionCoverage(
          read: 1,
          candidates: 2,
          truncated: 0,
          blocked: false
        ),
        viewport: .reported(box: CGRect(x: 0, y: 0, width: 100, height: 100))
      ),
      options: PresentationOptions(
        interactiveOnly: true,
        depth: nil,
        scope: nil,
        raw: true
      )
    ))
    let nodes = capture.nodes
    let encoded = try encoder.encode(nodes)

    XCTAssertEqual(
      String(decoding: encoded, as: UTF8.self),
      #"[{"actions":["Open menu"],"depth":2,"enabled":true,"focused":true,"hiddenContentAbove":true,"hiddenContentBelow":true,"hittable":true,"identifier":"continue-button","index":3,"label":"Continue","parentIndex":1,"placeholder":"Type here","rect":{"height":44,"width":100,"x":10,"y":20},"selected":true,"type":"Button","value":"Ready"}]"#
    )
    XCTAssertEqual(capture.truncated, true)
    XCTAssertEqual(capture.effectiveDepth, 4)
    XCTAssertEqual(capture.customActions?.read, 1)
    XCTAssertEqual(capture.customActions?.candidates, 2)
  }

  /// A node without a placeholder omits the key: the wire contract is "absent when empty", which
  /// the synthesized `encodeIfPresent` provides today and a hand-written encoder must keep.
  func testPresentedNodeOmitsAnAbsentPlaceholder() throws {
    let raw = RawAXNode(
      index: 0,
      type: "Button",
      label: "Save",
      identifier: nil,
      value: nil,
      rect: SnapshotRect(x: 0, y: 0, width: 100, height: 44),
      enabled: true,
      focused: nil,
      selected: nil,
      hittable: true,
      depth: 0,
      parentIndex: nil,
      hiddenContentAbove: nil,
      hiddenContentBelow: nil
    )
    let capture = try XCTUnwrap(try SnapshotPresentation.present(
      SnapshotAcquisition(
        hint: CaptureHint(
          projection: .raw, depth: nil, regularPresentedDepth: nil,
          interactiveOnly: false, customActions: false),
        nodes: [raw],
        truncated: false,
        effectiveDepth: nil,
        customActions: nil,
        viewport: .reported(box: CGRect(x: 0, y: 0, width: 100, height: 100))
      ),
      options: PresentationOptions(interactiveOnly: false, depth: nil, scope: nil, raw: true)
    ))
    let encoded = String(decoding: try JSONEncoder().encode(capture.nodes), as: UTF8.self)

    XCTAssertNil(capture.nodes.first?.placeholder)
    XCTAssertFalse(encoded.contains("placeholder"), encoded)
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
      try SnapshotPresentation.presentRegular(
        SnapshotAcquisition(
          hint: CaptureHint(
            projection: .regular, depth: nil, regularPresentedDepth: nil,
            interactiveOnly: false, customActions: false),
          nodes: acquired, truncated: false, effectiveDepth: nil,
          viewport: .reported(box: CGRect(x: 0, y: 0, width: 1_000, height: 1_000))),
        options: PresentationOptions(interactiveOnly: false, depth: nil, scope: nil, raw: false)
      ).nodes
    )
    let interactive = try XCTUnwrap(
      try SnapshotPresentation.presentRegular(
        SnapshotAcquisition(
          hint: CaptureHint(
            projection: .regular, depth: nil, regularPresentedDepth: nil,
            interactiveOnly: true, customActions: false),
          nodes: acquired, truncated: false, effectiveDepth: nil,
          viewport: .reported(box: CGRect(x: 0, y: 0, width: 1_000, height: 1_000))),
        options: PresentationOptions(interactiveOnly: true, depth: nil, scope: nil, raw: false)
      ).nodes
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
            projection: .raw, depth: nil, regularPresentedDepth: nil,
            interactiveOnly: false, customActions: false),
          nodes: acquired, truncated: false, effectiveDepth: nil,
          viewport: .reported(box: CGRect(x: 0, y: 0, width: 1_000, height: 1_000)) ),
        options: PresentationOptions(interactiveOnly: true, depth: nil, scope: nil, raw: true)
      ).nodes
    )
    XCTAssertEqual(raw.map(\.index), Array(0...10))
    XCTAssertEqual(raw.last?.depth, 2)
    XCTAssertEqual(raw.last?.parentIndex, 9)
  }

  func testRegularPresentationRoutesThroughVisibilityFold() throws {
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
        projection: .regular, depth: nil, regularPresentedDepth: nil,
        interactiveOnly: false, customActions: false),
      nodes: nodes,
      truncated: false,
      effectiveDepth: nil,
      viewport: .reported(box: CGRect(x: 0, y: 0, width: 100, height: 100))
    )

    let presented = try SnapshotPresentation.presentRegular(
      acquisition,
      options: PresentationOptions(
        interactiveOnly: false, depth: nil, scope: nil, raw: false)
    ).nodes

    XCTAssertEqual(presented.compactMap(\.label), ["App"])
  }

  func testRegularPresentationPublishesEffectiveRectWhileRawKeepsReportedFrame() throws {
    let acquired = [
      RawAXNode(
        index: 0, type: "Application", label: "App", identifier: nil, value: nil,
        rect: SnapshotRect(x: 0, y: 0, width: 402, height: 874), enabled: true,
        focused: nil, selected: nil, hittable: false, depth: 0, parentIndex: nil,
        hiddenContentAbove: nil, hiddenContentBelow: nil),
      RawAXNode(
        index: 1, type: "Button", label: "Partially clipped", identifier: nil, value: nil,
        rect: SnapshotRect(x: 350, y: 120, width: 100, height: 44), enabled: true,
        focused: nil, selected: nil, hittable: true, depth: 1, parentIndex: 0,
        hiddenContentAbove: nil, hiddenContentBelow: nil),
    ]
    let viewport = CGRect(x: 0, y: 0, width: 402, height: 874)
    let regularOptions = PresentationOptions(
      interactiveOnly: false, depth: nil, scope: nil, raw: false)
    let regular = try XCTUnwrap(
      try SnapshotPresentation.presentRegular(
        SnapshotAcquisition(
          hint: SnapshotPresentation.captureHint(for: regularOptions),
          nodes: acquired,
          truncated: false,
          effectiveDepth: nil,
          viewport: .reported(box: viewport)
        ),
        options: regularOptions
      ).nodes
    )
    let regularButton = try XCTUnwrap(regular.first { $0.label == "Partially clipped" })
    XCTAssertEqual(regularButton.rect.x, 350)
    XCTAssertEqual(regularButton.rect.y, 120)
    XCTAssertEqual(regularButton.rect.width, 52)
    XCTAssertEqual(regularButton.rect.height, 44)

    let rawOptions = PresentationOptions(
      interactiveOnly: false, depth: nil, scope: nil, raw: true)
    let raw = try XCTUnwrap(
      SnapshotPresentation.presentRaw(
        SnapshotAcquisition(
          hint: SnapshotPresentation.captureHint(for: rawOptions),
          nodes: acquired,
          truncated: false,
          effectiveDepth: nil,
          viewport: .reported(box: CGRect(x: 0, y: 0, width: 100, height: 100))
        ),
        options: rawOptions
      ).nodes
    )
    let rawButton = try XCTUnwrap(raw.first { $0.label == "Partially clipped" })
    XCTAssertEqual(rawButton.rect.x, 350)
    XCTAssertEqual(rawButton.rect.y, 120)
    XCTAssertEqual(rawButton.rect.width, 100)
    XCTAssertEqual(rawButton.rect.height, 44)
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
        projection: .regular, depth: nil, regularPresentedDepth: nil,
        interactiveOnly: true, customActions: false),
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
      viewport: .reported(box: CGRect(x: 0, y: 0, width: 1_000, height: 1_000))
    )
    let options = PresentationOptions(
      interactiveOnly: true,
      depth: 1,
      scope: " SCOPE-ROOT ",
      raw: false
    )
    let capture = try XCTUnwrap(try SnapshotPresentation.present(acquisition, options: options))
    let nodes = capture.nodes

    XCTAssertEqual(nodes.map(\.label), [nil, "Child"])
    XCTAssertEqual(nodes.map(\.identifier), ["scope-root", nil])
    XCTAssertEqual(nodes.map(\.index), [0, 1])
    XCTAssertEqual(nodes.map(\.depth), [0, 1])
    XCTAssertEqual(nodes.map(\.parentIndex), [nil, 0])
    XCTAssertEqual(capture.qualityNodes?.count, 6)

    let raw = try XCTUnwrap(
      SnapshotPresentation.presentRaw(
        SnapshotAcquisition(
          hint: CaptureHint(
            projection: .raw, depth: nil, regularPresentedDepth: nil,
            interactiveOnly: false, customActions: false),
          nodes: acquisition.nodes,
          truncated: false,
          effectiveDepth: nil,
          viewport: .reported(box: CGRect(x: 0, y: 0, width: 100, height: 100))
        ),
        options: PresentationOptions(
          interactiveOnly: true,
          depth: 1,
          scope: "scope-root",
          raw: true
        )
      ).nodes
    )
    XCTAssertEqual(raw.map(\.type), ["Other", "StaticText", "Image"])
    XCTAssertEqual(raw.map(\.depth), [0, 1, 1])

    let hint = SnapshotPresentation.captureHint(for: options)
    XCTAssertNil(hint.depth)
    XCTAssertTrue(hint.interactiveOnly)
    XCTAssertEqual(hint.projection, .regular)

    let missing = try XCTUnwrap(try SnapshotPresentation.present(
      acquisition,
      options: PresentationOptions(
        interactiveOnly: true,
        depth: 1,
        scope: "missing",
        raw: false
      )
    ))
    XCTAssertEqual(missing.nodes.count, 0)
    XCTAssertNil(
      RunnerTests.sparsePayloadReason(
        DataPayload(nodes: missing.qualityNodes, truncated: missing.truncated)
      )
    )
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
      viewport: .reported(box: CGRect(x: 0, y: 0, width: 100, height: 100)))
    let rawAcquisition = SnapshotAcquisition(
      hint: SnapshotPresentation.captureHint(for: rawRequest),
      nodes: nodes, truncated: false, effectiveDepth: nil,
      viewport: .reported(box: CGRect(x: 0, y: 0, width: 100, height: 100)))

    let regularCaptureForRawRequest = try SnapshotPresentation.present(
      regularAcquisition, options: rawRequest)
    let rawCaptureForRegularRequest = try SnapshotPresentation.present(
      rawAcquisition, options: regularRequest)
    let rawCapture = try SnapshotPresentation.present(rawAcquisition, options: rawRequest)
    let regularCapture = try SnapshotPresentation.present(
      regularAcquisition, options: regularRequest)
    XCTAssertNil(regularCaptureForRawRequest)
    XCTAssertNil(rawCaptureForRegularRequest)
    XCTAssertEqual(rawCapture?.nodes.count, 2)
    XCTAssertEqual(regularCapture?.nodes.count, 2)
  }

  /// The one derivation every backend reads. Non-vacuity: returning the request's own depth for a
  /// scoped capture, or keeping `interactiveOnly` on the raw projection, each fails one assertion.
  func testCaptureHintIsTheOnlyAcquisitionViewOfARequest() {
    let scoped = SnapshotPresentation.captureHint(
      for: PresentationOptions(
        interactiveOnly: true, depth: 2, scope: "Settings", raw: false))
    // Scope re-roots the tree and depth counts from that root: neither can narrow acquisition.
    XCTAssertNil(scoped.depth)
    XCTAssertNil(scoped.regularPresentedDepth)
    XCTAssertEqual(scoped.projection, .regular)

    let depthOnly = SnapshotPresentation.captureHint(
      for: PresentationOptions(interactiveOnly: true, depth: 2, scope: nil, raw: false))
    XCTAssertNil(depthOnly.depth)
    XCTAssertEqual(depthOnly.regularPresentedDepth, 2)

    // The raw projection is the acquired tree, so `--raw -i` never narrows acquisition either.
    let raw = SnapshotPresentation.captureHint(
      for: PresentationOptions(interactiveOnly: true, depth: 3, scope: nil, raw: true))
    XCTAssertEqual(raw.projection, .raw)
    XCTAssertFalse(raw.interactiveOnly)
    XCTAssertEqual(raw.rawTraversalDepth, 3)
    XCTAssertNil(raw.regularPresentedDepth)
    XCTAssertTrue(Self.canDescendAtRawDepth(0, hint: raw))
    XCTAssertTrue(Self.canDescendAtRawDepth(2, hint: raw))
    XCTAssertFalse(Self.canDescendAtRawDepth(3, hint: raw))
    XCTAssertTrue(raw.isRaw)

    let actions = SnapshotPresentation.captureHint(
      for: PresentationOptions(
        interactiveOnly: false, depth: nil, scope: nil, raw: false, customActions: true))
    XCTAssertTrue(actions.customActions)
  }

  /// #1797: a regular depth is measured after structural wrappers collapse, so it is a presentation
  /// cut and never a raw traversal cap. The root -> wrapper -> button fixture is the smallest tree
  /// where the two meanings diverge: acquisition descends freely, `present` stops at the cut.
  func testRegularDepthCutsPresentationNotAcquisition() throws {
    func node(
      _ index: Int,
      type: String,
      label: String?,
      depth: Int,
      parentIndex: Int?
    ) -> RawAXNode {
      RawAXNode(
        index: index,
        type: type,
        label: label,
        identifier: nil,
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

    let options = PresentationOptions(
      interactiveOnly: false, depth: 1, scope: nil, raw: false)
    let hint = SnapshotPresentation.captureHint(for: options)
    let capture = try XCTUnwrap(
      SnapshotPresentation.present(
        SnapshotAcquisition(
          hint: hint,
          nodes: [
            node(0, type: "Application", label: "App", depth: 0, parentIndex: nil),
            node(1, type: "Other", label: nil, depth: 1, parentIndex: 0),
            node(2, type: "Button", label: "Save", depth: 2, parentIndex: 1),
            node(3, type: "Button", label: "More", depth: 3, parentIndex: 2),
          ],
          truncated: false,
          effectiveDepth: nil,
          viewport: .reported(box: CGRect(x: 0, y: 0, width: 100, height: 100))
        ),
        options: options
      )
    )

    XCTAssertEqual(hint.regularPresentedDepth, 1)
    XCTAssertNil(hint.rawTraversalDepth)
    // A regular depth is a presentation cut, not an acquisition bound: the walk descends at every
    // raw depth. What limits the presented tree is the depth applied inside `present` above.
    XCTAssertTrue(Self.canDescendAtRawDepth(0, hint: hint))
    XCTAssertTrue(Self.canDescendAtRawDepth(1, hint: hint))
    XCTAssertTrue(Self.canDescendAtRawDepth(2, hint: hint))
    XCTAssertEqual(capture.nodes.map(\.label), ["App", "Save"])
    XCTAssertEqual(capture.nodes.map(\.depth), [0, 1])
  }

  /// #1797 P1: the shared visibility fold, running inside `present`, drops an eligible parent
  /// outside the viewport while an independently projected child stays visible and takes the
  /// requested depth. Acquisition does not consult that parent's geometry, so it never prunes here.
  func testVisibilityFoldKeepsIndependentChildPastClippedParent() throws {
    func node(
      _ index: Int,
      type: String,
      label: String?,
      rect: SnapshotRect,
      depth: Int,
      parentIndex: Int?
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
        hittable: type == "Button",
        depth: depth,
        parentIndex: parentIndex,
        hiddenContentAbove: nil,
        hiddenContentBelow: nil
      )
    }

    let viewport = CGRect(x: 0, y: 0, width: 100, height: 100)
    let options = PresentationOptions(
      interactiveOnly: false, depth: 1, scope: nil, raw: false)
    let hint = SnapshotPresentation.captureHint(for: options)
    let nodes = [
      node(
        0,
        type: "Application",
        label: "App",
        rect: SnapshotRect(x: 0, y: 0, width: 100, height: 100),
        depth: 0,
        parentIndex: nil
      ),
      node(
        1,
        type: "Other",
        label: "Clipped parent",
        rect: SnapshotRect(x: 200, y: 20, width: 40, height: 40),
        depth: 1,
        parentIndex: 0
      ),
      node(
        2,
        type: "Button",
        label: "Projected child",
        rect: SnapshotRect(x: 20, y: 20, width: 40, height: 40),
        depth: 2,
        parentIndex: 1
      ),
    ]
    let acquisition = SnapshotAcquisition(
      hint: hint,
      nodes: nodes,
      truncated: false,
      effectiveDepth: nil,
      viewport: .reported(box: viewport)
    )
    let presented = try XCTUnwrap(
      SnapshotPresentation.present(acquisition, options: options)?.nodes)

    XCTAssertEqual(presented.map(\.label), ["App", "Projected child"])
    XCTAssertEqual(presented.map(\.depth), [0, 1])
    XCTAssertEqual(presented.map(\.parentIndex), [nil, 0])

    // The removed parent is dropped by the fold inside `present`, not by acquisition: the walk's only
    // bound is the raw depth, which is nil for this regular capture, so a clipped parent never stops
    // its children from being acquired (#2612, #2661).
    XCTAssertTrue(Self.canDescendAtRawDepth(2, hint: hint))

    let rawHint = SnapshotPresentation.captureHint(
      for: PresentationOptions(interactiveOnly: false, depth: 1, scope: nil, raw: true))
    XCTAssertFalse(Self.canDescendAtRawDepth(1, hint: rawHint))
  }

  /// #2661: a turned keyboard subtree reported in the device's native space survives a regular
  /// `--depth N` capture. Acquisition never reads geometry, so it descends regardless of the reported
  /// rect; `normalized` returns the band to the viewport and presentation keeps it at app-space rects.
  func testRegularDepthKeepsTurnedKeyboardSubtreeAfterOneNormalizationPass() throws {
    let viewport = CGRect(x: 0, y: 0, width: 874, height: 402)
    func node(
      _ index: Int, _ type: String, _ label: String, _ rect: CGRect, _ parent: Int?, _ depth: Int
    ) -> RawAXNode {
      RawAXNode(
        index: index, type: type, label: label, identifier: nil, value: nil,
        rect: SnapshotRect(x: rect.minX, y: rect.minY, width: rect.width, height: rect.height),
        enabled: true, focused: nil, selected: nil, hittable: false,
        depth: depth, parentIndex: parent, hiddenContentAbove: nil, hiddenContentBelow: nil
      )
    }
    // Reported (native) geometry: a quarter-turned host box with the plane and `q` inside it.
    let acquired = [
      node(0, "Application", "App", CGRect(x: 0, y: 0, width: 874, height: 402), nil, 0),
      node(1, "Window", "Window", CGRect(x: 0, y: 0, width: 874, height: 402), 0, 1),
      node(2, "Other", "Keyboard", CGRect(x: 0, y: 0, width: 402, height: 874), 1, 2),
      node(3, "Key", "plane", CGRect(x: 2, y: 75, width: 202, height: 724), 2, 3),
      node(4, "Key", "q", CGRect(x: 154, y: 77, width: 45, height: 72), 2, 3),
    ]
    let normalized = SnapshotGeometrySpace.normalized(
      nodes: acquired,
      viewport: .reported(
        box: viewport,
        interfaceOrientation: RunnerInterfaceOrientation.landscapeRight
      )
    )
    let options = PresentationOptions(interactiveOnly: false, depth: 3, scope: nil, raw: false)
    let hint = SnapshotPresentation.captureHint(for: options)
    let presented = try XCTUnwrap(
      SnapshotPresentation.present(
        SnapshotAcquisition(
          hint: hint,
          nodes: normalized,
          truncated: false,
          effectiveDepth: nil,
          viewport: .reported(box: viewport)
        ),
        options: options
      )?.nodes
    )
    let band = presented.first { $0.rect == SnapshotRect(x: 75, y: 198, width: 724, height: 202) }
    let keyQ = presented.first { $0.rect == SnapshotRect(x: 77, y: 203, width: 72, height: 45) }
    XCTAssertNotNil(band, "keyboard plane must be presented under --depth \(options.depth ?? -1)")
    XCTAssertNotNil(keyQ, "`q` key must be presented under --depth \(options.depth ?? -1)")
  }

  /// #3899: an iPad window that does not fill the screen publishes screen space. The measured shape is
  /// iPad Pro 11-inch (M5, iOS 27.0) with Windowed Apps on and a Calendar window at (224,207,386x682):
  /// the app's own window arrives as a (0,0)-anchored copy of that box and its subtree with it, so the
  /// Add button reports (335,14,37,36) for a control drawn at (559,221). The one normalization pass
  /// reads the declaration and publishes the subtree at its place on the screen, which is what lets the
  /// fold keep every node instead of clipping each one to (w − x) × (h − y) and refusing the capture.
  func testAWindowedSubtreeIsPublishedInScreenSpaceAndKeepsEveryNode() throws {
    let windowOnScreen = CGRect(x: 224, y: 207, width: 386, height: 682)
    func node(
      _ index: Int, _ type: String, _ label: String, _ rect: CGRect, _ parent: Int?, _ depth: Int
    ) -> RawAXNode {
      RawAXNode(
        index: index, type: type, label: label, identifier: nil, value: nil,
        rect: SnapshotRect(x: rect.minX, y: rect.minY, width: rect.width, height: rect.height),
        enabled: true, focused: nil, selected: nil, hittable: false,
        depth: depth, parentIndex: parent, hiddenContentAbove: nil, hiddenContentBelow: nil
      )
    }
    let reportedRoot = CGRect(x: 0, y: 0, width: 386, height: 682)
    let acquired = [
      node(0, "Application", "Calendar", reportedRoot, nil, 0),
      node(1, "Window", "Window", reportedRoot, 0, 1),
      node(2, "Other", "Toolbar", reportedRoot, 1, 2),
      node(3, "Button", "Add", CGRect(x: 335, y: 14, width: 37, height: 36), 2, 3),
      node(4, "Button", "Today", CGRect(x: 8, y: 583, width: 90, height: 38), 2, 3),
      // A SpringBoard overlay under the app root reports the screen's own box: its subtree is already
      // in screen space and must not move.
      node(5, "Window", "Alert", CGRect(x: 0, y: 0, width: 834, height: 1210), 0, 1),
      node(6, "Button", "Discard Changes", CGRect(x: 300, y: 500, width: 240, height: 44), 5, 2),
    ]
    let normalized = SnapshotGeometrySpace.normalized(
      nodes: acquired,
      viewport: .reported(
        box: windowOnScreen,
        interfaceOrientation: RunnerInterfaceOrientation.portrait
      )
    )
    let options = PresentationOptions(interactiveOnly: false, depth: nil, scope: nil, raw: false)
    let capture = try XCTUnwrap(try SnapshotPresentation.present(
      SnapshotAcquisition(
        hint: SnapshotPresentation.captureHint(for: options),
        nodes: normalized,
        truncated: false,
        effectiveDepth: nil,
        viewport: .reported(box: windowOnScreen)
      ),
      options: options
    ))

    // One space: the root answers with the window's screen box, and the button with the position the
    // screenshot draws.
    XCTAssertEqual(capture.nodes.first?.rect, SnapshotRect(windowOnScreen))
    let add = try XCTUnwrap(capture.nodes.first { $0.label == "Add" })
    XCTAssertEqual(add.rect, SnapshotRect(x: 559, y: 221, width: 37, height: 36))
    XCTAssertEqual(add.hittable, true)
    // Nothing is dropped for being "outside the clip": the whole acquired tree is still there. The one
    // clipped node is the system overlay that really is larger than the app's window, which is the
    // fold's normal answer to oversized content — not the mixed-space clip that used to publish
    // (w − x) × (h − y) boxes and refuse this capture outright.
    XCTAssertEqual(Set(capture.nodes.map(\.label)), Set(acquired.map(\.label)))
    let clipNote = capture.qualityNotes.first { $0.code == .regularGeometryClipped }
    XCTAssertEqual(clipNote?.droppedNodeCount, 0, "no node is dropped for the window's origin")
    XCTAssertEqual(clipNote?.clippedNodeCount, 1, "only the overlay larger than the window is clipped")
    XCTAssertEqual(
      capture.nodes.first { $0.label == "Alert" }?.rect,
      SnapshotRect(x: 224, y: 207, width: 386, height: 682),
      "the overlay is clipped to the window's visible box, not to (w − x) × (h − y) of it"
    )
    // The system window and its button stay where the platform reported them.
    let discard = try XCTUnwrap(capture.nodes.first { $0.label == "Discard Changes" })
    XCTAssertEqual(discard.rect, SnapshotRect(x: 300, y: 500, width: 240, height: 44))
  }

  /// #3899 keeps a full-screen capture byte-identical: the same tree reported from the screen origin is
  /// published exactly as reported, with no translation read from its zero-origin viewport.
  func testAFullScreenCapturePublishesWhatThePlatformReported() throws {
    let screen = CGRect(x: 0, y: 0, width: 834, height: 1210)
    func node(
      _ index: Int, _ type: String, _ label: String, _ rect: CGRect, _ parent: Int?, _ depth: Int
    ) -> RawAXNode {
      RawAXNode(
        index: index, type: type, label: label, identifier: nil, value: nil,
        rect: SnapshotRect(x: rect.minX, y: rect.minY, width: rect.width, height: rect.height),
        enabled: true, focused: nil, selected: nil, hittable: false,
        depth: depth, parentIndex: parent, hiddenContentAbove: nil, hiddenContentBelow: nil
      )
    }
    let acquired = [
      node(0, "Application", "Calendar", screen, nil, 0),
      node(1, "Window", "Window", screen, 0, 1),
      node(2, "Button", "Add", CGRect(x: 335, y: 14, width: 37, height: 36), 1, 2),
    ]
    let normalized = SnapshotGeometrySpace.normalized(
      nodes: acquired,
      viewport: .reported(
        box: screen,
        interfaceOrientation: RunnerInterfaceOrientation.portrait
      )
    )
    XCTAssertEqual(normalized.map(\.rect), acquired.map(\.rect))
    XCTAssertEqual(
      SnapshotContentTranslation.offset(reportedBox: screen, viewportBox: screen),
      nil,
      "a viewport at the screen origin carries no translation"
    )
  }

  /// #3899 keeps ADR 0025 foldable panel taps: a panel reports its own box from its own display's
  /// origin, so no translation is read and the panel's geometry stays exactly as measured.
  func testAFoldablePanelReportsNoContentTranslation() {
    let panel = CGRect(x: 0, y: 0, width: 951, height: 669)
    XCTAssertNil(
      SnapshotContentTranslation.offset(reportedBox: panel, viewportBox: panel),
      "a panel box anchored at its display's origin names no translation"
    )
    // A digitizer point on the panel is passed through, so the fold's display selection stays the only
    // window-dependent choice the tap path makes.
    XCTAssertEqual(
      CoordinateSpaceRotation.native(
        point: CGPoint(x: 476, y: 226),
        in: panel,
        interfaceOrientation: RunnerInterfaceOrientation.portrait
      ),
      CGPoint(x: 476, y: 226)
    )
  }

  /// #2891: a capture whose viewport read failed publishes no `hittable` for a node whose answer is
  /// containment, while a root and a disabled node stay a declared `false`. Pinned on the
  /// encoded objects rather than on `capture.nodes`, because the promise is about the wire: a test
  /// over the Swift values would still pass if a custom encoder started writing `"hittable":null`
  /// for `nil`, which is a shape no host decoder is specified for. The #2638 wrapper verdict reads a
  /// declared `false` as evidence that the wrapper is inert.
  func testAMissingViewportOmitsTheHittableBitFromTheWire() throws {
    func node(
      _ index: Int, _ type: String, _ label: String,
      enabled: Bool, parent: Int?, depth: Int
    ) -> RawAXNode {
      RawAXNode(
        index: index, type: type, label: label, identifier: nil, value: nil,
        rect: SnapshotRect(x: 10, y: Double(20 + index * 60), width: 100, height: 44),
        enabled: enabled, focused: nil, selected: nil, hittable: false,
        depth: depth, parentIndex: parent, hiddenContentAbove: nil, hiddenContentBelow: nil
      )
    }
    let acquired = [
      node(0, "Application", "App", enabled: true, parent: nil, depth: 0),
      node(1, "Button", "Continue", enabled: true, parent: 0, depth: 1),
      node(2, "Button", "Sold out", enabled: false, parent: 0, depth: 1),
    ]
    let viewport = SnapshotViewport.missing(reason: .notProvided)
    let options = PresentationOptions(interactiveOnly: false, depth: nil, scope: nil, raw: false)
    let capture = try XCTUnwrap(try SnapshotPresentation.present(
      SnapshotAcquisition(
        hint: SnapshotPresentation.captureHint(for: options),
        nodes: SnapshotGeometrySpace.normalized(nodes: acquired, viewport: viewport),
        truncated: false,
        effectiveDepth: nil,
        viewport: viewport
      ),
      options: options
    ))
    let objects = try XCTUnwrap(
      JSONSerialization.jsonObject(with: JSONEncoder().encode(capture.nodes)) as? [[String: Any]]
    )

    // Containment is the one thing a capture with no box cannot decide, so the key is not there.
    let undecided = try XCTUnwrap(objects.first { $0["label"] as? String == "Continue" })
    XCTAssertFalse(
      undecided.keys.contains("hittable"),
      "an unknown viewport publishes no bit: \(undecided.keys.sorted())"
    )
    // Enablement and the root rule need no box, so those stay declared answers rather than gaps.
    let disabled = try XCTUnwrap(objects.first { $0["label"] as? String == "Sold out" })
    XCTAssertEqual(disabled["hittable"] as? Bool, false, "a disabled node is decided without a box")
    let root = try XCTUnwrap(objects.first { $0["label"] as? String == "App" })
    XCTAssertEqual(root["hittable"] as? Bool, false, "a root has nothing to hit through")
  }
}
#endif
