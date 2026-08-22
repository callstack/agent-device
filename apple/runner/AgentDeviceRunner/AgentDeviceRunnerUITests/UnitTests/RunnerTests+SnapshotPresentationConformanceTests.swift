import XCTest

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
private struct SnapshotPresentationConformanceFixture: Decodable {
  struct Rect: Decodable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double

    var snapshotRect: SnapshotRect {
      SnapshotRect(x: x, y: y, width: width, height: height)
    }

    var cgRect: CGRect {
      CGRect(x: x, y: y, width: width, height: height)
    }
  }

  struct Node: Decodable {
    let index: Int
    let type: String
    let label: String
    let rect: Rect
    let depth: Int
    let parentIndex: Int?
    let hittable: Bool
  }

  struct ExpectedNode: Decodable {
    let label: String
    let rect: Rect
    let depth: Int
    let parentIndex: Int?
    let hittable: Bool
  }

  struct Case: Decodable {
    let name: String
    let projection: String
    let scope: String?
    let nodes: [Node]
    let expected: [ExpectedNode]
  }

  let version: Int
  let viewport: Rect
  let cases: [Case]
}

extension RunnerTests {
  func testSnapshotPresentationMatchesSharedRawToPresentedFixture() throws {
    let fixtureURL = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent() // UnitTests
      .deletingLastPathComponent() // AgentDeviceRunnerUITests
      .deletingLastPathComponent() // AgentDeviceRunner
      .deletingLastPathComponent() // runner
      .deletingLastPathComponent() // apple
      .deletingLastPathComponent() // repo root
      .appendingPathComponent("contracts")
      .appendingPathComponent("fixtures")
      .appendingPathComponent("snapshot-presentation-conformance.json")
    let fixture = try JSONDecoder().decode(
      SnapshotPresentationConformanceFixture.self,
      from: Data(contentsOf: fixtureURL)
    )
    XCTAssertEqual(fixture.version, 1)
    XCTAssertFalse(fixture.cases.isEmpty, "conformance fixture must not be empty")

    for testCase in fixture.cases {
      let acquisition = SnapshotAcquisition(
        hint: CaptureHint(
          projection: testCase.projection == "raw" ? .raw : .regular,
          depth: nil,
          regularPresentedDepth: nil,
          interactiveOnly: false,
          customActions: false
        ),
        nodes: testCase.nodes.map { node in
          RawAXNode(
            index: node.index,
            type: node.type,
            label: node.label,
            identifier: nil,
            value: nil,
            rect: node.rect.snapshotRect,
            enabled: true,
            focused: nil,
            selected: nil,
            hittable: node.hittable,
            depth: node.depth,
            parentIndex: node.parentIndex,
            hiddenContentAbove: nil,
            hiddenContentBelow: nil
          )
        },
        truncated: false,
        effectiveDepth: nil,
        viewport: fixture.viewport.cgRect
      )
      let options = PresentationOptions(
        interactiveOnly: false,
        depth: nil,
        scope: testCase.scope,
        raw: testCase.projection == "raw"
      )
      let presented: [PresentedNode]
      if testCase.projection == "raw" {
        presented = try XCTUnwrap(
          SnapshotPresentation.presentRaw(acquisition, options: options).payload.nodes,
          testCase.name
        )
      } else {
        presented = try XCTUnwrap(
          try SnapshotPresentation.presentRegular(
            acquisition,
            options: options,
            policy: .cursorProjected
          ).payload.nodes,
          testCase.name
        )
      }

      XCTAssertEqual(presented.count, testCase.expected.count, testCase.name)
      for (actual, expected) in zip(presented, testCase.expected) {
        XCTAssertEqual(actual.label, expected.label, testCase.name)
        XCTAssertEqual(actual.rect.x, expected.rect.x, testCase.name)
        XCTAssertEqual(actual.rect.y, expected.rect.y, testCase.name)
        XCTAssertEqual(actual.rect.width, expected.rect.width, testCase.name)
        XCTAssertEqual(actual.rect.height, expected.rect.height, testCase.name)
        XCTAssertEqual(actual.depth, expected.depth, testCase.name)
        XCTAssertEqual(actual.parentIndex, expected.parentIndex, testCase.name)
        XCTAssertEqual(actual.hittable, expected.hittable, testCase.name)
      }
    }
  }
}
#endif
