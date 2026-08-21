#if AGENT_DEVICE_RUNNER_UNIT_TESTS
import XCTest

extension RunnerTests {
  func testEffectiveGeometryIntersectsViewportAndAncestorClip() {
    let effective = SnapshotGeometry.effectiveFrame(
      reportedFrame: CGRect(x: 350, y: 80, width: 100, height: 100),
      viewport: CGRect(x: 0, y: 0, width: 402, height: 874),
      ancestorClip: CGRect(x: 300, y: 100, width: 80, height: 80)
    )

    XCTAssertEqual(effective, CGRect(x: 350, y: 100, width: 30, height: 80))
  }

  func testEffectiveGeometryKeepsReportedOriginWhenFullyClipped() {
    let reported = CGRect(x: 500, y: 120, width: 100, height: 44)
    let effective = SnapshotGeometry.effectiveFrame(
      reportedFrame: reported,
      viewport: CGRect(x: 0, y: 0, width: 402, height: 874),
      ancestorClip: nil
    )

    let rect = SnapshotGeometry.snapshotRect(from: effective, reportedFrame: reported)
    XCTAssertEqual(rect.x, 500)
    XCTAssertEqual(rect.y, 120)
    XCTAssertEqual(rect.width, 0)
    XCTAssertEqual(rect.height, 0)
  }
}
#endif
