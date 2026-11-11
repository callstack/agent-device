import AgentDeviceSnapshotPresentation
import CoreGraphics
import XCTest

final class ConformanceTests: XCTestCase {
  func testStandaloneHarnessUsesPresenterForAClippedRegularNode() throws {
    let options = PresentationOptions(
      interactiveOnly: false,
      depth: nil,
      scope: nil,
      raw: false
    )
    let result = try SnapshotPresentation.presentRegular(
      SnapshotAcquisition(
        hint: SnapshotPresentation.captureHint(for: options),
        nodes: [
          RawAXNode(
            index: 0,
            type: "Application",
            label: "App",
            identifier: nil,
            value: nil,
            rect: SnapshotRect(x: 0, y: 0, width: 100, height: 100),
            enabled: true,
            focused: nil,
            selected: nil,
            hittable: false,
            depth: 0,
            parentIndex: nil,
            hiddenContentAbove: nil,
            hiddenContentBelow: nil
          ),
          RawAXNode(
            index: 1,
            type: "Button",
            label: "Continue",
            identifier: nil,
            value: nil,
            rect: SnapshotRect(x: 80, y: 10, width: 40, height: 20),
            enabled: true,
            focused: nil,
            selected: nil,
            hittable: true,
            depth: 1,
            parentIndex: 0,
            hiddenContentAbove: nil,
            hiddenContentBelow: nil,
            nativePressTarget: NativePressTarget(type: 9, identifier: nil, label: "Continue", value: nil,
              rect: SnapshotRect(x: 80, y: 10, width: 40, height: 20))
          ),
        ],
        truncated: false,
        effectiveDepth: nil,
        viewport: .reported(box: CGRect(x: 0, y: 0, width: 100, height: 100))
      ),
      options: options,
      policy: .cursorProjected
    )

    XCTAssertEqual(result.nodes.map(\.label), ["App", "Continue"])
    XCTAssertEqual(result.nodes[1].rect, SnapshotRect(x: 80, y: 10, width: 20, height: 20))
    XCTAssertEqual(result.nodes[1].nativePressTarget?.rect, SnapshotRect(x: 80, y: 10, width: 40, height: 20))
    XCTAssertEqual(result.nodes[1].nativePressTarget?.type, 9)
    XCTAssertEqual(result.qualityNotes.first?.code, .regularGeometryClipped)
    XCTAssertEqual(result.qualityNotes.first?.clippedNodeCount, 1)
    XCTAssertEqual(result.qualityNotes.first?.droppedNodeCount, 0)
  }
  func testInputValueViewSurvivesGeometryNormalizationAndCodable() throws {
    let rect = SnapshotRect(x: 10, y: 20, width: 100, height: 40)
    let target = NativePressTarget(type: 49, identifier: "input", label: nil, value: "Hint",
      valueSource: "accessibility", rect: rect)
    let node = RawAXNode(index: 0, type: "TextField", label: nil, identifier: "input", value: "Hint",
      rect: rect, enabled: true, focused: nil, selected: nil, hittable: true, depth: 0, parentIndex: nil,
      hiddenContentAbove: nil, hiddenContentBelow: nil, nativePressTarget: target)
    let normalized = SnapshotGeometrySpace.normalized(nodes: [node],
      viewport: .reported(box: CGRect(x: 0, y: 0, width: 390, height: 844)))
    XCTAssertEqual(normalized[0].nativePressTarget, target)
    XCTAssertEqual(try JSONDecoder().decode(NativePressTarget.self, from: JSONEncoder().encode(target)), target)
  }

  func testSecureValuesAreOmittedBeforeNativeBindingSerialization() throws {
    let raw = RawAXNode(index: 0, type: "SecureTextField", label: "Password", identifier: "password",
      value: "private-secret", rect: SnapshotRect(x: 0, y: 0, width: 100, height: 40),
      enabled: true, focused: nil, selected: nil, hittable: true, depth: 0, parentIndex: nil,
      hiddenContentAbove: nil, hiddenContentBelow: nil,
      nativePressTarget: NativePressTarget(type: 50, identifier: "password", label: "Password", value: "private-secret",
        rect: SnapshotRect(x: 0, y: 0, width: 100, height: 40)))
    XCTAssertNil(raw.nativePressTarget?.value)
    let encoded = try JSONEncoder().encode(raw.nativePressTarget)
    XCTAssertFalse(String(decoding: encoded, as: UTF8.self).contains("private-secret"))
  }

}
