import AppKit
import AVFoundation
import Foundation

struct GestureEnvelope: Decodable {
  let events: [GestureEvent]
}

struct GestureEvent: Decodable {
  let kind: String
  let tMs: Double
  let x: Double
  let y: Double
  let x2: Double?
  let y2: Double?
  let referenceWidth: Double?
  let referenceHeight: Double?
  let durationMs: Double?
  let scale: Double?
}

struct InspectionManifest: Encodable {
  struct Item: Encodable {
    let index: Int
    let kind: String
    let sourceTimeMs: Double
    let sampleTimeMs: Double
    let expectedX: Double
    let expectedY: Double
    let fullFramePath: String
    let cropPath: String
  }

  let generatedAt: String
  let inputPath: String
  let renderWidth: Int
  let renderHeight: Int
  let items: [Item]
}

enum InspectError: Error, CustomStringConvertible {
  case invalidArgs(String)
  case missingVideoTrack
  case frameExtractionFailed(String)

  var description: String {
    switch self {
    case .invalidArgs(let message):
      return message
    case .missingVideoTrack:
      return "Input video does not contain a video track."
    case .frameExtractionFailed(let message):
      return message
    }
  }
}

do {
  try run()
} catch {
  fputs("recording-inspect: \(error)\n", stderr)
  exit(1)
}

func run() throws {
  let arguments = Array(CommandLine.arguments.dropFirst())
  let parsed = try parseArguments(arguments)
  let inputURL = URL(fileURLWithPath: parsed.inputPath)
  let eventsURL = URL(fileURLWithPath: parsed.eventsPath)
  let outputDirURL = URL(fileURLWithPath: parsed.outputDir, isDirectory: true)

  try FileManager.default.createDirectory(at: outputDirURL, withIntermediateDirectories: true)

  let envelope = try JSONDecoder().decode(GestureEnvelope.self, from: Data(contentsOf: eventsURL))
  let asset = AVURLAsset(url: inputURL)
  guard let sourceVideoTrack = asset.tracks(withMediaType: .video).first else {
    throw InspectError.missingVideoTrack
  }

  let renderSize = resolvedRenderSize(for: sourceVideoTrack)
  let durationMs = max(0, asset.duration.seconds * 1000.0)
  let generator = AVAssetImageGenerator(asset: asset)
  generator.appliesPreferredTrackTransform = true
  generator.requestedTimeToleranceBefore = .zero
  generator.requestedTimeToleranceAfter = .zero

  var manifestItems: [InspectionManifest.Item] = []
  for (index, event) in envelope.events.enumerated() {
    let sampleTimeMs = clampedSampleTimeMs(
      recommendedSampleTimeMs(for: event),
      durationMs: durationMs
    )
    let sampleTime = CMTime(seconds: sampleTimeMs / 1000.0, preferredTimescale: 600)
    let cgImage: CGImage
    do {
      cgImage = try generator.copyCGImage(at: sampleTime, actualTime: nil)
    } catch {
      throw InspectError.frameExtractionFailed(
        "Failed to extract frame for event \(index + 1) at \(sampleTimeMs)ms: \(error)"
      )
    }

    let expectedPoint = overlayPoint(
      event: event,
      renderSize: renderSize,
      sampleTimeMs: sampleTimeMs
    )
    let fullFrameURL = outputDirURL.appendingPathComponent(
      fileName(prefix: index + 1, kind: event.kind, suffix: "frame")
    )
    let cropURL = outputDirURL.appendingPathComponent(
      fileName(prefix: index + 1, kind: event.kind, suffix: "crop")
    )

    try writePNG(cgImage: cgImage, to: fullFrameURL)
    let cropped = cropImage(cgImage, centeredAt: expectedPoint, size: CGSize(width: 280, height: 280))
    try writePNG(cgImage: cropped, to: cropURL)

    manifestItems.append(
      .init(
        index: index + 1,
        kind: event.kind,
        sourceTimeMs: event.tMs,
        sampleTimeMs: sampleTimeMs,
        expectedX: expectedPoint.x,
        expectedY: expectedPoint.y,
        fullFramePath: fullFrameURL.path,
        cropPath: cropURL.path
      )
    )
  }

  let manifest = InspectionManifest(
    generatedAt: ISO8601DateFormatter().string(from: Date()),
    inputPath: inputURL.path,
    renderWidth: Int(renderSize.width.rounded()),
    renderHeight: Int(renderSize.height.rounded()),
    items: manifestItems
  )
  let manifestURL = outputDirURL.appendingPathComponent("manifest.json")
  let encoder = JSONEncoder()
  encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
  try encoder.encode(manifest).write(to: manifestURL)
  print(manifestURL.path)
}

func clampedSampleTimeMs(_ sampleTimeMs: Double, durationMs: Double) -> Double {
  guard durationMs > 0 else { return max(0, sampleTimeMs) }
  return min(max(0, sampleTimeMs), max(0, durationMs - 50))
}

func parseArguments(_ arguments: [String]) throws -> (inputPath: String, eventsPath: String, outputDir: String) {
  var inputPath: String?
  var eventsPath: String?
  var outputDir: String?
  var index = 0

  while index < arguments.count {
    let argument = arguments[index]
    let nextIndex = index + 1
    switch argument {
    case "--input":
      guard nextIndex < arguments.count else { throw InspectError.invalidArgs("--input requires a value") }
      inputPath = arguments[nextIndex]
      index += 2
    case "--events":
      guard nextIndex < arguments.count else { throw InspectError.invalidArgs("--events requires a value") }
      eventsPath = arguments[nextIndex]
      index += 2
    case "--output-dir":
      guard nextIndex < arguments.count else { throw InspectError.invalidArgs("--output-dir requires a value") }
      outputDir = arguments[nextIndex]
      index += 2
    default:
      throw InspectError.invalidArgs("Unknown argument: \(argument)")
    }
  }

  guard let inputPath, let eventsPath, let outputDir else {
    throw InspectError.invalidArgs(
      "Usage: recording-inspect.swift --input <video> --events <json> --output-dir <dir>"
    )
  }
  return (inputPath, eventsPath, outputDir)
}

func resolvedRenderSize(for track: AVAssetTrack) -> CGSize {
  let transformed = track.naturalSize.applying(track.preferredTransform)
  return CGSize(width: abs(transformed.width), height: abs(transformed.height))
}

func recommendedSampleTimeMs(for event: GestureEvent) -> Double {
  switch event.kind {
  case "tap":
    return event.tMs + 180
  case "longpress":
    let duration = max(event.durationMs ?? 800, 350)
    return event.tMs + min(duration * 0.35, 280)
  case "swipe", "scroll", "back-swipe", "pinch":
    let duration = max(event.durationMs ?? 250, 180)
    return event.tMs + min(max(duration * 0.5, 120), 320)
  default:
    return event.tMs + 180
  }
}

func overlayPoint(event: GestureEvent, renderSize: CGSize, sampleTimeMs: Double) -> CGPoint {
  let sampleX: Double
  let sampleY: Double
  if let x2 = event.x2, let y2 = event.y2, let durationMs = event.durationMs, durationMs > 0 {
    let elapsedMs = max(0, min(sampleTimeMs - event.tMs, durationMs))
    let progress = min(1.0, elapsedMs / durationMs)
    let easedProgress = progress * progress * (3 - 2 * progress)
    let inspectedProgress =
      event.kind == "back-swipe" ? min(easedProgress, 0.25) : easedProgress
    sampleX = event.x + (x2 - event.x) * inspectedProgress
    sampleY = event.y + (y2 - event.y) * inspectedProgress
  } else {
    sampleX = event.x
    sampleY = event.y
  }
  let scaleX = scaledAxis(renderSize: renderSize.width, referenceSize: event.referenceWidth)
  let scaleY = scaledAxis(renderSize: renderSize.height, referenceSize: event.referenceHeight)
  let scaledX = sampleX * scaleX
  let scaledY = sampleY * scaleY
  return CGPoint(x: scaledX, y: scaledY)
}

func scaledAxis(renderSize: CGFloat, referenceSize: Double?) -> Double {
  guard let referenceSize, referenceSize > 0 else { return 1.0 }
  return Double(renderSize) / referenceSize
}

func fileName(prefix: Int, kind: String, suffix: String) -> String {
  String(format: "%02d-%@-%@.png", prefix, sanitize(kind), suffix)
}

func sanitize(_ value: String) -> String {
  value.replacingOccurrences(of: "[^A-Za-z0-9_-]", with: "-", options: .regularExpression)
}

func writePNG(cgImage: CGImage, to url: URL) throws {
  let rep = NSBitmapImageRep(cgImage: cgImage)
  guard let data = rep.representation(using: .png, properties: [:]) else {
    throw InspectError.frameExtractionFailed("Failed to encode PNG for \(url.lastPathComponent)")
  }
  try data.write(to: url)
}

func cropImage(_ image: CGImage, centeredAt point: CGPoint, size: CGSize) -> CGImage {
  let width = CGFloat(image.width)
  let height = CGFloat(image.height)
  let cropWidth = min(size.width, width)
  let cropHeight = min(size.height, height)
  let originX = min(max(0, point.x - cropWidth / 2), max(0, width - cropWidth))
  let originY = min(max(0, point.y - cropHeight / 2), max(0, height - cropHeight))
  let rect = CGRect(x: originX, y: originY, width: cropWidth, height: cropHeight).integral
  return image.cropping(to: rect) ?? image
}
