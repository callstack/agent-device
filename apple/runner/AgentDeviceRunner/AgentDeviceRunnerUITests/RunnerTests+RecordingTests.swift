import CoreGraphics
import Foundation
import XCTest
#if canImport(AppKit)
import AppKit
#elseif canImport(UIKit)
import UIKit
#endif

private func makeRecordingTestImage() -> RunnerImage {
  let context = CGContext(
    data: nil,
    width: 2,
    height: 2,
    bitsPerComponent: 8,
    bytesPerRow: 0,
    space: CGColorSpaceCreateDeviceRGB(),
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
  )!
  context.setFillColor(CGColor(red: 0.2, green: 0.4, blue: 0.6, alpha: 1))
  context.fill(CGRect(x: 0, y: 0, width: 2, height: 2))
  let cgImage = context.makeImage()!
#if canImport(AppKit)
  return NSImage(cgImage: cgImage, size: NSSize(width: 2, height: 2))
#else
  return UIImage(cgImage: cgImage)
#endif
}

extension RunnerTests {
#if AGENT_DEVICE_RUNNER_UNIT_TESTS
  func testRecordStopIsIdempotentAfterNativeRecorderAlreadyStopped() throws {
    activeRecording = nil

    for commandId in ["record-stop-recovery-one", "record-stop-recovery-two"] {
      let json = #"{"command":"recordStop","commandId":"\#(commandId)"}"#
      let command = try JSONDecoder().decode(Command.self, from: Data(json.utf8))
      let response = try execute(command: command)

      XCTAssertTrue(response.ok)
      XCTAssertEqual(response.data?.message, "recording already stopped")
      XCTAssertNil(activeRecording)
    }
  }

  func testScreenRecorderClampsNonMonotonicFrameTimestamps() throws {
    let outputPath = URL(fileURLWithPath: NSTemporaryDirectory())
      .appendingPathComponent("agent-device-screen-recorder-\(UUID().uuidString).mp4")
      .path
    defer { try? FileManager.default.removeItem(atPath: outputPath) }

    let recorder = ScreenRecorder(outputPath: outputPath, fps: 30)
    let image = makeRecordingTestImage()
    try recorder.startForTesting(image: image)
    defer { try? recorder.stop() }

    XCTAssertEqual(
      recorder.appendForTesting(image: image, timestampValue: 100),
      100
    )
    // Non-vacuity: without the monotonicity guard, this append records 0 or fails instead of 101.
    XCTAssertEqual(
      recorder.appendForTesting(image: image, timestampValue: 0),
      101
    )
    XCTAssertNoThrow(try recorder.stop())
  }
#endif
}
