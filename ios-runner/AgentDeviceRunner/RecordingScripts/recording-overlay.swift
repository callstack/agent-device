import AppKit
import AVFoundation
import Foundation
import QuartzCore

let touchDotColor = NSColor(calibratedRed: 0.20, green: 0.63, blue: 0.98, alpha: 0.48).cgColor
let touchDotBorderColor = NSColor(calibratedRed: 0.94, green: 0.98, blue: 1.0, alpha: 0.68).cgColor
let minimumTapVisibility: CFTimeInterval = 0.45
let minimumSwipeVisibility: CFTimeInterval = 0.5
let minimumPinchVisibility: CFTimeInterval = 0.5
let swipeVisibilityTail: CFTimeInterval = 0.16
let trailOpacityKeyTimes: [NSNumber] = [0.0, 0.08, 0.62, 1.0]

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
  let contentDirection: String?
  let edge: String?
}

enum OverlayError: Error, CustomStringConvertible {
  case invalidArgs(String)
  case missingVideoTrack
  case exportFailed(String)

  var description: String {
    switch self {
    case .invalidArgs(let message):
      return message
    case .missingVideoTrack:
      return "Input video does not contain a video track."
    case .exportFailed(let message):
      return message
    }
  }
}

do {
  try run()
} catch {
  fputs("recording-overlay: \(error)\n", stderr)
  exit(1)
}

func run() throws {
  let arguments = Array(CommandLine.arguments.dropFirst())
  let parsedArgs = try parseArguments(arguments)
  let inputURL = URL(fileURLWithPath: parsedArgs.inputPath)
  let outputURL = URL(fileURLWithPath: parsedArgs.outputPath)
  let eventsURL = URL(fileURLWithPath: parsedArgs.eventsPath)

  if FileManager.default.fileExists(atPath: outputURL.path) {
    try FileManager.default.removeItem(at: outputURL)
  }

  let payload = try Data(contentsOf: eventsURL)
  let envelope = try JSONDecoder().decode(GestureEnvelope.self, from: payload)

  if envelope.events.isEmpty {
    try FileManager.default.copyItem(at: inputURL, to: outputURL)
    return
  }

  let asset = AVURLAsset(url: inputURL)
  guard let sourceVideoTrack = asset.tracks(withMediaType: .video).first else {
    throw OverlayError.missingVideoTrack
  }

  let composition = AVMutableComposition()
  guard let compositionVideoTrack = composition.addMutableTrack(
    withMediaType: .video,
    preferredTrackID: kCMPersistentTrackID_Invalid
  ) else {
    throw OverlayError.exportFailed("Failed to create composition video track.")
  }

  let fullRange = CMTimeRange(start: .zero, duration: asset.duration)
  try compositionVideoTrack.insertTimeRange(fullRange, of: sourceVideoTrack, at: .zero)

  if let sourceAudioTrack = asset.tracks(withMediaType: .audio).first,
     let compositionAudioTrack = composition.addMutableTrack(
       withMediaType: .audio,
       preferredTrackID: kCMPersistentTrackID_Invalid
     ) {
    try? compositionAudioTrack.insertTimeRange(fullRange, of: sourceAudioTrack, at: .zero)
  }

  let renderSize = resolvedRenderSize(for: sourceVideoTrack)
  let videoComposition = AVMutableVideoComposition()
  videoComposition.renderSize = renderSize
  videoComposition.frameDuration = resolvedFrameDuration(for: sourceVideoTrack)

  let instruction = AVMutableVideoCompositionInstruction()
  instruction.timeRange = fullRange
  let layerInstruction = AVMutableVideoCompositionLayerInstruction(assetTrack: compositionVideoTrack)
  layerInstruction.setTransform(sourceVideoTrack.preferredTransform, at: .zero)
  instruction.layerInstructions = [layerInstruction]
  videoComposition.instructions = [instruction]

  let parentLayer = CALayer()
  parentLayer.frame = CGRect(origin: .zero, size: renderSize)
  parentLayer.masksToBounds = true

  let videoLayer = CALayer()
  videoLayer.frame = parentLayer.frame
  parentLayer.addSublayer(videoLayer)

  let overlayLayer = CALayer()
  overlayLayer.frame = parentLayer.frame
  parentLayer.addSublayer(overlayLayer)

  for event in envelope.events {
    switch event.kind {
    case "tap":
      addTapLayer(event: event, renderSize: renderSize, to: overlayLayer)
    case "longpress":
      addLongPressLayer(event: event, renderSize: renderSize, to: overlayLayer)
    case "swipe":
      addSwipeLayers(event: event, renderSize: renderSize, to: overlayLayer)
    case "scroll":
      addScrollLayers(event: event, renderSize: renderSize, to: overlayLayer)
    case "back-swipe":
      addBackSwipeLayers(event: event, renderSize: renderSize, to: overlayLayer)
    case "pinch":
      addPinchLayers(event: event, renderSize: renderSize, to: overlayLayer)
    default:
      continue
    }
  }

  videoComposition.animationTool = AVVideoCompositionCoreAnimationTool(
    postProcessingAsVideoLayer: videoLayer,
    in: parentLayer
  )

  // Overlay burn-in forces a full re-encode; medium quality keeps simulator videos readable
  // while avoiding very slow highest-quality exports. Pass --quality high to opt into
  // the slower highest-quality export.
  let presetName = exportPresetName(for: parsedArgs.exportQuality, compatibleWith: composition)
  guard let exporter = AVAssetExportSession(asset: composition, presetName: presetName) else {
    throw OverlayError.exportFailed("Failed to create export session.")
  }

  exporter.outputURL = outputURL
  exporter.outputFileType = .mp4
  exporter.videoComposition = videoComposition
  exporter.shouldOptimizeForNetworkUse = true

  let semaphore = DispatchSemaphore(value: 0)
  exporter.exportAsynchronously {
    semaphore.signal()
  }
  if semaphore.wait(timeout: .now() + 120) == .timedOut {
    exporter.cancelExport()
    throw OverlayError.exportFailed("Touch overlay export timed out.")
  }

  if exporter.status != .completed {
    throw OverlayError.exportFailed(exporter.error?.localizedDescription ?? "Touch overlay export failed.")
  }
}

enum ExportQuality: String {
  case medium
  case high
}

func parseArguments(
  _ arguments: [String]
) throws -> (inputPath: String, outputPath: String, eventsPath: String, exportQuality: ExportQuality) {
  var inputPath: String?
  var outputPath: String?
  var eventsPath: String?
  // Export quality defaults to medium so existing callers keep the fast, simulator-friendly
  // export. Pass --quality high to opt into a slower highest-quality export.
  var exportQuality: ExportQuality = .medium
  var index = 0

  while index < arguments.count {
    let argument = arguments[index]
    let nextIndex = index + 1
    switch argument {
    case "--input":
      guard nextIndex < arguments.count else { throw OverlayError.invalidArgs("--input requires a value") }
      inputPath = arguments[nextIndex]
      index += 2
    case "--output":
      guard nextIndex < arguments.count else { throw OverlayError.invalidArgs("--output requires a value") }
      outputPath = arguments[nextIndex]
      index += 2
    case "--events":
      guard nextIndex < arguments.count else { throw OverlayError.invalidArgs("--events requires a value") }
      eventsPath = arguments[nextIndex]
      index += 2
    case "--quality":
      guard nextIndex < arguments.count else {
        throw OverlayError.invalidArgs("--quality requires a value")
      }
      guard let parsed = ExportQuality(rawValue: arguments[nextIndex]) else {
        throw OverlayError.invalidArgs("--quality must be one of: medium, high")
      }
      exportQuality = parsed
      index += 2
    default:
      throw OverlayError.invalidArgs("Unknown argument: \(argument)")
    }
  }

  guard let inputPath, let outputPath, let eventsPath else {
    throw OverlayError.invalidArgs(
      "Usage: recording-overlay.swift --input <video> --output <video> --events <json> [--quality <medium|high>]"
    )
  }
  return (inputPath, outputPath, eventsPath, exportQuality)
}

func exportPresetName(
  for exportQuality: ExportQuality,
  compatibleWith asset: AVAsset
) -> String {
  switch exportQuality {
  case .high:
    return AVAssetExportPresetHighestQuality
  case .medium:
    // Prefer the faster medium preset, falling back to highest quality only when medium is
    // not available for this composition.
    let compatible = AVAssetExportSession.exportPresets(compatibleWith: asset)
    return compatible.contains(AVAssetExportPresetMediumQuality)
      ? AVAssetExportPresetMediumQuality
      : AVAssetExportPresetHighestQuality
  }
}

func resolvedRenderSize(for track: AVAssetTrack) -> CGSize {
  let transformed = track.naturalSize.applying(track.preferredTransform)
  return CGSize(width: abs(transformed.width), height: abs(transformed.height))
}

func resolvedFrameDuration(for track: AVAssetTrack) -> CMTime {
  let minFrameDuration = track.minFrameDuration
  if minFrameDuration.isValid && !minFrameDuration.isIndefinite && minFrameDuration.seconds > 0 {
    return minFrameDuration
  }

  let nominalFrameRate = track.nominalFrameRate
  if nominalFrameRate > 0 {
    let timescale = Int32(max(1, round(nominalFrameRate)))
    return CMTime(value: 1, timescale: timescale)
  }

  return CMTime(value: 1, timescale: 60)
}

func overlayPoint(event: GestureEvent, x: Double, y: Double, renderSize: CGSize) -> CGPoint {
  let scaleX = scaledAxis(renderSize: renderSize.width, referenceSize: event.referenceWidth)
  let scaleY = scaledAxis(renderSize: renderSize.height, referenceSize: event.referenceHeight)
  let scaledX = x * scaleX
  let scaledY = y * scaleY
  let flippedY = max(0, Double(renderSize.height) - scaledY)
  return CGPoint(x: scaledX, y: flippedY)
}

func scaledAxis(renderSize: CGFloat, referenceSize: Double?) -> Double {
  guard let referenceSize, referenceSize > 0 else { return 1.0 }
  return Double(renderSize) / referenceSize
}

func addTapLayer(event: GestureEvent, renderSize: CGSize, to overlayLayer: CALayer) {
  let layer = makeTouchDotLayer(
    center: overlayPoint(event: event, x: event.x, y: event.y, renderSize: renderSize),
    renderSize: renderSize
  )
  overlayLayer.addSublayer(layer)

  let opacity = CAKeyframeAnimation(keyPath: "opacity")
  opacity.values = [0.0, 0.98, 0.98, 0.0]
  opacity.keyTimes = [0.0, 0.08, 0.8, 1.0]

  let scale = CAKeyframeAnimation(keyPath: "transform.scale")
  scale.values = [0.84, 1.0, 1.0]
  scale.keyTimes = [0.0, 0.22, 1.0]

  let group = makeAnimationGroup(
    animations: [opacity, scale],
    duration: minimumTapVisibility,
    beginTime: AVCoreAnimationBeginTimeAtZero + (event.tMs / 1000.0)
  )
  layer.add(group, forKey: "tap")
}

func addLongPressLayer(event: GestureEvent, renderSize: CGSize, to overlayLayer: CALayer) {
  let duration = max(0.75, (event.durationMs ?? 800) / 1000.0)
  let layer = makeTouchDotLayer(
    center: overlayPoint(event: event, x: event.x, y: event.y, renderSize: renderSize),
    renderSize: renderSize
  )
  overlayLayer.addSublayer(layer)

  let opacity = CAKeyframeAnimation(keyPath: "opacity")
  opacity.values = [0.0, 0.98, 0.98, 0.0]
  opacity.keyTimes = [0.0, 0.08, 0.92, 1.0]

  let scale = CAKeyframeAnimation(keyPath: "transform.scale")
  scale.values = [0.84, 1.0, 1.0]
  scale.keyTimes = [0.0, 0.15, 1.0]

  let group = makeAnimationGroup(
    animations: [opacity, scale],
    duration: duration,
    beginTime: AVCoreAnimationBeginTimeAtZero + (event.tMs / 1000.0)
  )
  layer.add(group, forKey: "longpress")
}

func addSwipeLayers(event: GestureEvent, renderSize: CGSize, to overlayLayer: CALayer) {
  addTrailLayers(event: event, renderSize: renderSize, to: overlayLayer, style: .swipe)
}

func addScrollLayers(event: GestureEvent, renderSize: CGSize, to overlayLayer: CALayer) {
  addTrailLayers(event: event, renderSize: renderSize, to: overlayLayer, style: .scroll)
}

func addBackSwipeLayers(event: GestureEvent, renderSize: CGSize, to overlayLayer: CALayer) {
  addTrailLayers(event: event, renderSize: renderSize, to: overlayLayer, style: .backSwipe)
}

enum TrailStyle: Equatable {
  case swipe
  case scroll
  case backSwipe
}

extension TrailStyle {
  var tail: CFTimeInterval {
    switch self {
    case .swipe:
      return swipeVisibilityTail
    case .scroll:
      return 0.08
    case .backSwipe:
      return 0.12
    }
  }

  var lineWidth: CGFloat {
    switch self {
    case .swipe:
      return 4
    case .scroll:
      return 5
    case .backSwipe:
      return 6
    }
  }

  var color: CGColor {
    switch self {
    case .swipe:
      return touchDotColor
    case .scroll:
      return NSColor(calibratedRed: 0.16, green: 0.74, blue: 0.88, alpha: 0.34).cgColor
    case .backSwipe:
      return NSColor(calibratedRed: 0.24, green: 0.69, blue: 1.0, alpha: 0.55).cgColor
    }
  }

  var borderColor: CGColor {
    switch self {
    case .swipe:
      return touchDotBorderColor
    case .scroll:
      return NSColor(calibratedRed: 0.92, green: 1.0, blue: 1.0, alpha: 0.48).cgColor
    case .backSwipe:
      return NSColor(calibratedRed: 0.94, green: 0.98, blue: 1.0, alpha: 0.8).cgColor
    }
  }

  var trailOpacityValues: [NSNumber] {
    switch self {
    case .swipe:
      return [0.0, 0.9, 0.35, 0.0]
    case .scroll:
      return [0.0, 0.5, 0.18, 0.0]
    case .backSwipe:
      return [0.0, 1.0, 0.45, 0.0]
    }
  }

  var dotOpacityValues: [NSNumber] {
    switch self {
    case .swipe:
      return [0.0, 1.0, 0.92, 0.0]
    case .scroll:
      return [0.0, 0.72, 0.4, 0.0]
    case .backSwipe:
      return [0.0, 1.0, 0.9, 0.0]
    }
  }
}

func makeAnimationGroup(
  animations: [CAAnimation],
  duration: CFTimeInterval,
  beginTime: CFTimeInterval
) -> CAAnimationGroup {
  let group = CAAnimationGroup()
  group.animations = animations
  group.duration = duration
  group.beginTime = beginTime
  group.fillMode = .both
  group.isRemovedOnCompletion = false
  return group
}

func addTrailLayers(
  event: GestureEvent,
  renderSize: CGSize,
  to overlayLayer: CALayer,
  style: TrailStyle
) {
  guard let x2 = event.x2, let y2 = event.y2 else { return }
  let startPoint = overlayPoint(event: event, x: event.x, y: event.y, renderSize: renderSize)
  let endPoint = overlayPoint(event: event, x: x2, y: y2, renderSize: renderSize)
  let duration = max(0.1, (event.durationMs ?? 250) / 1000.0)
  let visibleDuration = max(minimumSwipeVisibility, duration + style.tail)
  let beginTime = AVCoreAnimationBeginTimeAtZero + (event.tMs / 1000.0)

  let pathLayer = CAShapeLayer()
  pathLayer.frame = overlayLayer.bounds
  pathLayer.strokeEnd = 1.0
  pathLayer.path = {
    let path = CGMutablePath()
    path.move(to: startPoint)
    path.addLine(to: endPoint)
    return path
  }()
  pathLayer.strokeColor = style.color
  pathLayer.lineWidth = style.lineWidth
  pathLayer.lineCap = .round
  pathLayer.fillColor = nil
  pathLayer.opacity = 0
  overlayLayer.addSublayer(pathLayer)

  let stroke = CABasicAnimation(keyPath: "strokeEnd")
  stroke.fromValue = 0.0
  stroke.toValue = 1.0

  let strokeOpacity = CAKeyframeAnimation(keyPath: "opacity")
  strokeOpacity.values = style.trailOpacityValues
  strokeOpacity.keyTimes = trailOpacityKeyTimes

  let strokeGroup = makeAnimationGroup(
    animations: [stroke, strokeOpacity],
    duration: visibleDuration,
    beginTime: beginTime
  )
  strokeGroup.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
  pathLayer.add(strokeGroup, forKey: "stroke")

  let dotLayer = makeTouchDotLayer(center: startPoint, renderSize: renderSize)
  dotLayer.backgroundColor = style.color
  dotLayer.borderColor = style.borderColor
  dotLayer.position = endPoint
  overlayLayer.addSublayer(dotLayer)

  let position = CABasicAnimation(keyPath: "position")
  position.fromValue = NSValue(point: startPoint)
  position.toValue = NSValue(point: endPoint)
  position.duration = duration

  let opacity = CAKeyframeAnimation(keyPath: "opacity")
  opacity.values = style.dotOpacityValues
  opacity.keyTimes = trailOpacityKeyTimes

  let group = makeAnimationGroup(
    animations: [position, opacity],
    duration: visibleDuration,
    beginTime: beginTime
  )
  group.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
  dotLayer.add(group, forKey: "swipe-dot")

  if style == .backSwipe {
    addBackSwipeEdgeHint(
      event: event,
      renderSize: renderSize,
      beginTime: beginTime,
      visibleDuration: visibleDuration,
      to: overlayLayer
    )
  }
}

func addPinchDot(
  overlayLayer: CALayer,
  start: CGPoint,
  end: CGPoint,
  renderSize: CGSize,
  beginTime: CFTimeInterval,
  duration: CFTimeInterval
) {
  let dotLayer = makeTouchDotLayer(center: start, renderSize: renderSize)
  overlayLayer.addSublayer(dotLayer)

  let position = CABasicAnimation(keyPath: "position")
  position.fromValue = NSValue(point: start)
  position.toValue = NSValue(point: end)
  position.duration = duration

  let opacity = CAKeyframeAnimation(keyPath: "opacity")
  opacity.values = [0.0, 1.0, 1.0, 0.0]
  opacity.keyTimes = [0.0, 0.1, 0.82, 1.0]

  let group = makeAnimationGroup(
    animations: [position, opacity],
    duration: duration,
    beginTime: beginTime
  )
  dotLayer.add(group, forKey: "pinch")
}

func addPinchLayers(event: GestureEvent, renderSize: CGSize, to overlayLayer: CALayer) {
  let duration = max(minimumPinchVisibility, (event.durationMs ?? 280) / 1000.0)
  let beginTime = AVCoreAnimationBeginTimeAtZero + (event.tMs / 1000.0)
  let startOffset: CGFloat = 28
  let scale = max(0.2, min(event.scale ?? 1.0, 3.0))
  let endOffset = scale >= 1.0 ? startOffset * CGFloat(min(scale, 2.0)) : startOffset * CGFloat(max(scale, 0.5))
  let startLeft = overlayPoint(event: event, x: event.x - Double(startOffset), y: event.y, renderSize: renderSize)
  let startRight = overlayPoint(event: event, x: event.x + Double(startOffset), y: event.y, renderSize: renderSize)
  let endLeft = overlayPoint(event: event, x: event.x - Double(endOffset), y: event.y, renderSize: renderSize)
  let endRight = overlayPoint(event: event, x: event.x + Double(endOffset), y: event.y, renderSize: renderSize)

  addPinchDot(
    overlayLayer: overlayLayer,
    start: startLeft,
    end: endLeft,
    renderSize: renderSize,
    beginTime: beginTime,
    duration: duration
  )
  addPinchDot(
    overlayLayer: overlayLayer,
    start: startRight,
    end: endRight,
    renderSize: renderSize,
    beginTime: beginTime,
    duration: duration
  )
}

func makeTouchDotLayer(center: CGPoint, renderSize: CGSize) -> CALayer {
  let dotRadius = resolvedTouchDotRadius(renderSize: renderSize)
  let layer = CALayer()
  layer.bounds = CGRect(x: 0, y: 0, width: dotRadius * 2, height: dotRadius * 2)
  layer.position = center
  layer.cornerRadius = dotRadius
  layer.backgroundColor = touchDotColor
  layer.borderWidth = 2
  layer.borderColor = touchDotBorderColor
  layer.shadowColor = NSColor(calibratedRed: 0.08, green: 0.20, blue: 0.36, alpha: 1.0).cgColor
  layer.shadowOpacity = 0.18
  layer.shadowRadius = 4
  layer.opacity = 0
  return layer
}

func resolvedTouchDotRadius(renderSize: CGSize) -> CGFloat {
  let minDimension = min(renderSize.width, renderSize.height)
  return max(18, min(40, minDimension * 0.035))
}

func addBackSwipeEdgeHint(
  event: GestureEvent,
  renderSize: CGSize,
  beginTime: CFTimeInterval,
  visibleDuration: CFTimeInterval,
  to overlayLayer: CALayer
) {
  let edge = (event.edge ?? "left").lowercased()
  let hintLayer = CALayer()
  let width: CGFloat = 10
  let height: CGFloat = min(renderSize.height * 0.3, 320)
  let y = (renderSize.height - height) / 2
  let x: CGFloat = edge == "right" ? renderSize.width - width : 0
  hintLayer.frame = CGRect(x: x, y: y, width: width, height: height)
  hintLayer.backgroundColor = NSColor(calibratedRed: 0.24, green: 0.69, blue: 1.0, alpha: 0.22).cgColor
  hintLayer.cornerRadius = width / 2
  hintLayer.opacity = 0
  overlayLayer.addSublayer(hintLayer)

  let opacity = CAKeyframeAnimation(keyPath: "opacity")
  opacity.values = [0.0, 0.9, 0.0]
  opacity.keyTimes = [0.0, 0.2, 1.0]

  let group = makeAnimationGroup(
    animations: [opacity],
    duration: visibleDuration,
    beginTime: beginTime
  )
  hintLayer.add(group, forKey: "back-swipe-edge")
}
