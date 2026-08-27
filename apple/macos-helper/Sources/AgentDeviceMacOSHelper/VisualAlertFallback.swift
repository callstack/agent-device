import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import ImageIO
import Vision

struct VisualAlertMatch {
  let buttonLabel: String
}

func dismissLocalNetworkPermissionAlertVisually(
  screenshotPath: String,
  app: NSRunningApplication
) throws -> VisualAlertMatch? {
  guard FileManager.default.fileExists(atPath: screenshotPath) else {
    return nil
  }
  let screenshotUrl = URL(fileURLWithPath: screenshotPath)
  guard let source = CGImageSourceCreateWithURL(screenshotUrl as CFURL, nil),
        let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
  else {
    return nil
  }

  let request = VNRecognizeTextRequest()
  request.recognitionLevel = .accurate
  request.recognitionLanguages = ["en-US"]
  request.usesLanguageCorrection = false
  do {
    try VNImageRequestHandler(cgImage: image).perform([request])
  } catch {
    throw HelperError.commandFailed(
      "alert screenshot recognition failed",
      details: ["error": error.localizedDescription]
    )
  }

  let recognized = (request.results ?? []).compactMap { observation -> (String, CGRect)? in
    guard let candidate = observation.topCandidates(1).first else {
      return nil
    }
    return (candidate.string, observation.boundingBox)
  }
  let recognizedText = recognized.map(\.0).joined(separator: " ")
  guard recognizedText.localizedCaseInsensitiveContains("local network"),
        let denial = recognized.first(where: { text, _ in
          normalizeVisualAlertText(text).contains("don't allow")
        }),
        let windowRect = bestMatchingWindowRect(
          app: app,
          screenshotWidth: image.width,
          screenshotHeight: image.height
        )
  else {
    return nil
  }

  let point = CGPoint(
    x: windowRect.x + Double(denial.1.midX) * windowRect.width,
    y: windowRect.y + (1 - Double(denial.1.midY)) * windowRect.height
  )
  guard let move = CGEvent(
    mouseEventSource: nil,
    mouseType: .mouseMoved,
    mouseCursorPosition: point,
    mouseButton: .left
  ),
    let down = CGEvent(
      mouseEventSource: nil,
      mouseType: .leftMouseDown,
      mouseCursorPosition: point,
      mouseButton: .left
    ),
    let up = CGEvent(
      mouseEventSource: nil,
      mouseType: .leftMouseUp,
      mouseCursorPosition: point,
      mouseButton: .left
    )
  else {
    throw HelperError.commandFailed(
      "alert action failed",
      details: ["reason": "event_creation_failed"]
    )
  }
  move.post(tap: .cghidEventTap)
  down.post(tap: .cghidEventTap)
  up.post(tap: .cghidEventTap)
  return VisualAlertMatch(buttonLabel: denial.0)
}

private func normalizeVisualAlertText(_ value: String) -> String {
  value
    .replacingOccurrences(of: "’", with: "'")
    .trimmingCharacters(in: .whitespacesAndNewlines)
    .lowercased()
}

private func bestMatchingWindowRect(
  app: NSRunningApplication,
  screenshotWidth: Int,
  screenshotHeight: Int
) -> RectResponse? {
  guard screenshotWidth > 0, screenshotHeight > 0 else {
    return nil
  }
  let screenshotAspectRatio = Double(screenshotWidth) / Double(screenshotHeight)
  return windows(of: AXUIElementCreateApplication(app.processIdentifier))
    .compactMap(rectAttribute)
    .filter { $0.width > 0 && $0.height > 0 }
    .min { left, right in
      abs(left.width / left.height - screenshotAspectRatio)
        < abs(right.width / right.height - screenshotAspectRatio)
    }
}
