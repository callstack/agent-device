import Foundation
import XCTest

final class PrintAlertSurfaceTests: XCTestCase {
  func testPrintModeDispatchAndCorpusOutput() throws {
    let package = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    let process = Process()
    process.executableURL = package.appendingPathComponent(".build/debug/snapshot-presentation-conformance")
    process.arguments = [
      "print-alert-surface",
      package.appendingPathComponent("Tests/AlertSurfaceCorpus/iphone-duo-folded-safari-open-this-page-in-app.json").path,
    ]
    let output = Pipe()
    process.standardOutput = output
    try process.run()
    let text = String(decoding: output.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
    process.waitUntilExit()
    XCTAssertEqual(process.terminationStatus, 0)
    XCTAssertTrue(text.hasPrefix("ModalSurface reads (the rule's answer, not ground truth): modal\n"))
    XCTAssertTrue(text.contains("[surface roots:"))
    XCTAssertTrue(text.contains("Application"))
  }
}
