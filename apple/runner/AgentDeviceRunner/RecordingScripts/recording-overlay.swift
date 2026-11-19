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

// A compositor that cannot render frames still completes with an empty track, so a whole frame at
// or below this mean luma counts as black.
let compositedBlackFrameLuma: Double = 1.0
// Above this mean luma the raw capture is taken to hold visible content worth preserving. Below it
// the recording itself is dark, so a dark composite is the content and not a compositor failure.
let sourceVisibleFrameLuma: Double = 2.0

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

/// A positive, finite reference pair: the canvas size an event's coordinates were measured in.
struct ReferenceSize {
  let width: Double
  let height: Double

  init?(width: Double?, height: Double?) {
    guard let width, let height, width.isFinite, height.isFinite, width > 0, height > 0
    else { return nil }
    self.width = width
    self.height = height
  }
}

/// A gesture event admitted for drawing. Admission proves its reference pair once, so drawing and
/// projection take the pair as given. Raw telemetry stays in `GestureEvent`.
struct RenderableGestureEvent {
  let event: GestureEvent
  let reference: ReferenceSize

  /// Returns nil when the reference pair is missing or not finite and positive. Such an event has
  /// no proven transform into the captured canvas, so its marker is omitted (#4448).
  init?(admitting event: GestureEvent) {
    guard let reference = ReferenceSize(width: event.referenceWidth, height: event.referenceHeight)
    else { return nil }
    self.event = event
    self.reference = reference
  }
}

enum ExportQuality: String {
  case medium
  case high
}

/// Entry point: `@main` because multi-file swiftc compilation reserves top-level statements for
/// `main.swift`, which cannot be shared per-script.
@main
enum RecordingOverlay {
  static func main() {
    do {
      try run()
    } catch {
      fputs("recording-overlay: \(error)\n", stderr)
      exit(1)
    }
  }
}

func run() throws {
  let arguments = Array(CommandLine.arguments.dropFirst())
  let parsedArgs = try parseArguments(arguments)
  let inputURL = URL(fileURLWithPath: parsedArgs.inputPath)
  let outputURL = URL(fileURLWithPath: parsedArgs.outputPath)
  let eventsURL = URL(fileURLWithPath: parsedArgs.eventsPath)

  try removeStaleOutput(outputURL)

  let payload = try Data(contentsOf: eventsURL)
  let envelope = try JSONDecoder().decode(GestureEnvelope.self, from: payload)

  // The telemetry events and the video are preserved either way. With nothing left to render, the
  // raw capture is kept as-is.
  let renderableEvents = envelope.events.compactMap(RenderableGestureEvent.init(admitting:))
  if renderableEvents.isEmpty {
    try FileManager.default.copyItem(at: inputURL, to: outputURL)
    return
  }

  let asset = AVURLAsset(url: inputURL)
  let sourceVideoTrack = try sourceVideoTrack(of: asset)
  let fullRange = CMTimeRange(start: .zero, duration: asset.duration)
  let composition = try makeRecordingComposition(
    asset: asset,
    videoTrack: sourceVideoTrack,
    timeRange: fullRange
  )
  guard let compositionVideoTrack = composition.tracks(withMediaType: .video).first else {
    throw RecordingScriptError.exportFailed("Failed to create composition video track.")
  }

  let sourceBounds = resolvedRenderBounds(for: sourceVideoTrack)
  let renderSize = sourceBounds.size
  let videoComposition = AVMutableVideoComposition()
  videoComposition.renderSize = renderSize
  videoComposition.frameDuration = resolvedFrameDuration(
    for: sourceVideoTrack,
    maximumFrameRate: parsedArgs.maximumFrameRate
  )

  let instruction = AVMutableVideoCompositionInstruction()
  instruction.timeRange = fullRange
  let layerInstruction = AVMutableVideoCompositionLayerInstruction(assetTrack: compositionVideoTrack)
  let renderTransform = sourceVideoTrack.preferredTransform.concatenating(
    CGAffineTransform(translationX: -sourceBounds.minX, y: -sourceBounds.minY)
  )
  layerInstruction.setTransform(renderTransform, at: .zero)
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

  for event in renderableEvents {
    switch event.event.kind {
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

  // Overlay burn-in forces a full re-encode. The export has to keep the captured track's own
  // dimensions, so it uses the one preset that preserves arbitrary capture geometry; the hardware
  // encoder makes the full-resolution re-encode cheap (measured ~1-2s for a 90s 1206x2622 clip).
  let presetName = try exportPresetName(compatibleWith: composition)
  let exporter = try makeRecordingExporter(
    composition,
    presetName: presetName,
    outputURL: outputURL,
    videoComposition: videoComposition
  )
  try runRecordingExport(
    exporter,
    timeoutSeconds: parsedArgs.timeoutSeconds,
    timeoutMessage: "Touch overlay export timed out.",
    failureMessage: "Touch overlay export failed."
  )
  try verifyCompositedOverlay(
    input: inputURL,
    output: outputURL,
    expectedRenderSize: renderSize
  )
}

func parseArguments(
  _ arguments: [String]
) throws -> (
  inputPath: String, outputPath: String, eventsPath: String, timeoutSeconds: Double,
  maximumFrameRate: Int32
) {
  var inputPath: String?
  var outputPath: String?
  var eventsPath: String?
  var timeoutSeconds = defaultRecordingExportTimeoutSeconds
  var maximumFrameRate = maximumCompositedFrameRate
  var index = 0

  while index < arguments.count {
    let argument = arguments[index]
    let nextIndex = index + 1
    switch argument {
    case "--input":
      inputPath = try recordingOptionValue(arguments, nextIndex, "--input")
      index += 2
    case "--output":
      outputPath = try recordingOptionValue(arguments, nextIndex, "--output")
      index += 2
    case "--events":
      eventsPath = try recordingOptionValue(arguments, nextIndex, "--events")
      index += 2
    case "--quality":
      // Accepted for CLI parity with the other backends and still validated, but the composited
      // export always preserves the captured geometry (see `exportPresetName`), so the tier never
      // picks a resolution-capping preset and is not retained.
      let rawValue = try recordingOptionValue(arguments, nextIndex, "--quality")
      guard ExportQuality(rawValue: rawValue) != nil else {
        throw RecordingScriptError.invalidArgs("--quality must be one of: medium, high")
      }
      index += 2
    case "--timeout-ms":
      let rawValue = try recordingOptionValue(arguments, nextIndex, "--timeout-ms")
      guard let milliseconds = Double(rawValue), milliseconds > 0 else {
        throw RecordingScriptError.invalidArgs("--timeout-ms must be a positive number")
      }
      timeoutSeconds = milliseconds / 1000
      index += 2
    case "--max-fps":
      let rawValue = try recordingOptionValue(arguments, nextIndex, "--max-fps")
      guard let framesPerSecond = Int32(rawValue), framesPerSecond > 0 else {
        throw RecordingScriptError.invalidArgs("--max-fps must be a positive integer")
      }
      maximumFrameRate = min(framesPerSecond, maximumCompositedFrameRate)
      index += 2
    default:
      throw RecordingScriptError.invalidArgs("Unknown argument: \(argument)")
    }
  }

  guard let inputPath, let outputPath, let eventsPath else {
    throw RecordingScriptError.invalidArgs(
      "Usage: recording-overlay.swift --input <video> --output <video> --events <json> [--quality <medium|high>] [--timeout-ms <ms>] [--max-fps <n>]"
    )
  }
  return (inputPath, outputPath, eventsPath, timeoutSeconds, maximumFrameRate)
}

/// The composited overlay must keep the captured track's dimensions, so it can only use a preset
/// that preserves source geometry. The fixed-canvas presets rescale the long edge —
/// `AVAssetExportPresetMediumQuality` caps it at 480px, which is exactly what collapsed every
/// touch-bearing recording to ~220x480 (#2707). Only `HighestQuality` preserves the capture, and it
/// is the export for every quality tier, so `--quality` never trades capture resolution away. If a
/// composition offers no geometry-preserving preset the export refuses rather than rescaling.
func exportPresetName(compatibleWith asset: AVAsset) throws -> String {
  guard AVAssetExportSession.exportPresets(compatibleWith: asset).contains(AVAssetExportPresetHighestQuality) else {
    throw RecordingScriptError.exportFailed(
      "No geometry-preserving export preset is available; refusing to rescale the capture."
    )
  }
  return AVAssetExportPresetHighestQuality
}

func resolvedRenderSize(for track: AVAssetTrack) -> CGSize {
  resolvedRenderBounds(for: track).size
}

func resolvedRenderBounds(for track: AVAssetTrack) -> CGRect {
  CGRect(origin: .zero, size: track.naturalSize).applying(track.preferredTransform)
}

/// Guards the compositor's own contract before the caller adopts its output: the burn-in must keep
/// the captured track's dimensions, must produce frames, and must not silently become an all-black
/// track. Any failure throws, dropping the overlay and keeping the raw capture rather than
/// publishing a broken file with a success exit.
func verifyCompositedOverlay(input: URL, output: URL, expectedRenderSize: CGSize) throws {
  let composited = AVURLAsset(url: output)
  guard let track = composited.tracks(withMediaType: .video).first else {
    throw RecordingScriptError.exportFailed("Touch overlay export produced no video track.")
  }

  let producedSize = resolvedRenderSize(for: track)
  if !renderSizeMatches(producedSize, expectedRenderSize) {
    throw RecordingScriptError.exportFailed(
      "Touch overlay export changed the track geometry: \(Int(producedSize.width))x\(Int(producedSize.height)) instead of \(Int(expectedRenderSize.width))x\(Int(expectedRenderSize.height))."
    )
  }

  // A compositor that produced no decodable frames is a failure, not an absence of evidence.
  guard let compositedLuma = meanFrameLuma(of: composited) else {
    throw RecordingScriptError.exportFailed("Touch overlay export produced no decodable frames.")
  }

  let source = AVURLAsset(url: input)
  let sourceDuration = CMTimeGetSeconds(source.duration)
  let producedDuration = CMTimeGetSeconds(composited.duration)
  if sourceDuration.isFinite, sourceDuration > 1, producedDuration.isFinite,
    producedDuration < sourceDuration * 0.5
  {
    throw RecordingScriptError.exportFailed(
      "Touch overlay export truncated the track to \(Int(producedDuration))s of \(Int(sourceDuration))s."
    )
  }

  if compositedLuma <= compositedBlackFrameLuma,
    let sourceLuma = meanFrameLuma(of: source),
    sourceLuma > sourceVisibleFrameLuma
  {
    throw RecordingScriptError.exportFailed(
      "Touch overlay export produced an all-black track while the raw capture had visible content."
    )
  }
}

func renderSizeMatches(_ produced: CGSize, _ expected: CGSize) -> Bool {
  // The encoder rounds the stored frame to its coding-block grid, so an honest match tolerates a
  // few pixels regardless of size. A geometry collapse (the #2707 failure) misses by hundreds.
  let tolerance: CGFloat = 32
  return abs(produced.width - expected.width) <= tolerance
    && abs(produced.height - expected.height) <= tolerance
}

func meanFrameLuma(of asset: AVURLAsset, sampleCount: Int = 5) -> Double? {
  let duration = CMTimeGetSeconds(asset.duration)
  guard duration.isFinite, duration > 0 else { return nil }
  let generator = AVAssetImageGenerator(asset: asset)
  generator.appliesPreferredTrackTransform = true
  generator.requestedTimeToleranceBefore = .positiveInfinity
  generator.requestedTimeToleranceAfter = .positiveInfinity
  // Only the mean brightness is wanted, so decode a thumbnail rather than the full frame.
  generator.maximumSize = CGSize(width: 64, height: 64)

  var total = 0.0
  var sampled = 0
  for index in 0..<sampleCount {
    let fraction = (Double(index) + 0.5) / Double(sampleCount)
    let time = CMTime(seconds: fraction * duration, preferredTimescale: 600)
    guard let image = try? generator.copyCGImage(at: time, actualTime: nil),
      let luma = frameMeanLuma(image)
    else { continue }
    total += luma
    sampled += 1
  }
  guard sampled > 0 else { return nil }
  return total / Double(sampled)
}

func frameMeanLuma(_ image: CGImage) -> Double? {
  let width = image.width
  let height = image.height
  guard width > 0, height > 0 else { return nil }
  let bytesPerRow = width * 4
  var pixels = [UInt8](repeating: 0, count: bytesPerRow * height)
  let drawn = pixels.withUnsafeMutableBytes { raw -> Bool in
    guard
      let context = CGContext(
        data: raw.baseAddress,
        width: width,
        height: height,
        bitsPerComponent: 8,
        bytesPerRow: bytesPerRow,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
      )
    else { return false }
    context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    return true
  }
  guard drawn else { return nil }

  var total = 0.0
  var count = 0
  for offset in stride(from: 0, to: bytesPerRow * height, by: 4) {
    total += 0.299 * Double(pixels[offset])
      + 0.587 * Double(pixels[offset + 1])
      + 0.114 * Double(pixels[offset + 2])
    count += 1
  }
  guard count > 0 else { return nil }
  return total / Double(count)
}

/// The composited export renders at most this many frames a second, which is smooth for a touch
/// that stays visible for 0.45s. `--max-fps` lowers it, never raises it.
let maximumCompositedFrameRate: Int32 = 30

/// A variable-frame-rate capture (simctl recordVideo, adb screenrecord) reports one tick of its
/// timescale as `minFrameDuration` (1/600s from simctl). Rendering at that asked the compositor for
/// every frame the encoder could make, 75 a second from an iOS simulator and 60 from an Android
/// emulator, about three times the frames the capture holds; a 5-minute recording's export then
/// outlasted the `record stop` request. So the frame duration is the capture's, but never shorter
/// than one frame at `maximumFrameRate`. A capture that reports none renders at that
/// rate: its average (`nominalFrameRate`) can be a couple of frames a second over a still screen,
/// which would skip a touch.
func resolvedFrameDuration(for track: AVAssetTrack, maximumFrameRate: Int32) -> CMTime {
  let shortest = CMTime(value: 1, timescale: maximumFrameRate)
  let minFrameDuration = track.minFrameDuration
  if minFrameDuration.isValid && !minFrameDuration.isIndefinite && minFrameDuration.seconds > 0 {
    return CMTimeMaximum(minFrameDuration, shortest)
  }

  return shortest
}

func overlayPoint(reference: ReferenceSize, x: Double, y: Double, renderSize: CGSize) -> CGPoint {
  let scaledX = x * (Double(renderSize.width) / reference.width)
  let scaledY = y * (Double(renderSize.height) / reference.height)
  let flippedY = max(0, Double(renderSize.height) - scaledY)
  return CGPoint(x: scaledX, y: flippedY)
}

func addTapLayer(event: RenderableGestureEvent, renderSize: CGSize, to overlayLayer: CALayer) {
  addPressLayer(
    event: event,
    renderSize: renderSize,
    to: overlayLayer,
    duration: minimumTapVisibility,
    opacityKeyTimes: [0.0, 0.08, 0.8, 1.0],
    scaleKeyTimes: [0.0, 0.22, 1.0],
    animationKey: "tap"
  )
}

func addLongPressLayer(event: RenderableGestureEvent, renderSize: CGSize, to overlayLayer: CALayer) {
  addPressLayer(
    event: event,
    renderSize: renderSize,
    to: overlayLayer,
    duration: max(0.75, (event.event.durationMs ?? 800) / 1000.0),
    opacityKeyTimes: [0.0, 0.08, 0.92, 1.0],
    scaleKeyTimes: [0.0, 0.15, 1.0],
    animationKey: "longpress"
  )
}

func addPressLayer(
  event: RenderableGestureEvent,
  renderSize: CGSize,
  to overlayLayer: CALayer,
  duration: CFTimeInterval,
  opacityKeyTimes: [NSNumber],
  scaleKeyTimes: [NSNumber],
  animationKey: String
) {
  let center = overlayPoint(
    reference: event.reference,
    x: event.event.x,
    y: event.event.y,
    renderSize: renderSize
  )
  let layer = makeTouchDotLayer(center: center, renderSize: renderSize)
  overlayLayer.addSublayer(layer)

  let opacity = CAKeyframeAnimation(keyPath: "opacity")
  opacity.values = [0.0, 0.98, 0.98, 0.0]
  opacity.keyTimes = opacityKeyTimes

  let scale = CAKeyframeAnimation(keyPath: "transform.scale")
  scale.values = [0.84, 1.0, 1.0]
  scale.keyTimes = scaleKeyTimes

  let group = makeAnimationGroup(
    animations: [opacity, scale],
    duration: duration,
    beginTime: AVCoreAnimationBeginTimeAtZero + (event.event.tMs / 1000.0)
  )
  layer.add(group, forKey: animationKey)
}

func addSwipeLayers(event: RenderableGestureEvent, renderSize: CGSize, to overlayLayer: CALayer) {
  addTrailLayers(event: event, renderSize: renderSize, to: overlayLayer, style: .swipe)
}

func addScrollLayers(event: RenderableGestureEvent, renderSize: CGSize, to overlayLayer: CALayer) {
  addTrailLayers(event: event, renderSize: renderSize, to: overlayLayer, style: .scroll)
}

func addBackSwipeLayers(event: RenderableGestureEvent, renderSize: CGSize, to overlayLayer: CALayer) {
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
  event: RenderableGestureEvent,
  renderSize: CGSize,
  to overlayLayer: CALayer,
  style: TrailStyle
) {
  let raw = event.event
  guard let x2 = raw.x2, let y2 = raw.y2 else { return }
  let startPoint = overlayPoint(reference: event.reference, x: raw.x, y: raw.y, renderSize: renderSize)
  let endPoint = overlayPoint(reference: event.reference, x: x2, y: y2, renderSize: renderSize)
  let duration = max(0.1, (raw.durationMs ?? 250) / 1000.0)
  let visibleDuration = max(minimumSwipeVisibility, duration + style.tail)
  let beginTime = AVCoreAnimationBeginTimeAtZero + (raw.tMs / 1000.0)

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
      edge: raw.edge,
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

func addPinchLayers(event: RenderableGestureEvent, renderSize: CGSize, to overlayLayer: CALayer) {
  let raw = event.event
  let reference = event.reference
  let duration = max(minimumPinchVisibility, (raw.durationMs ?? 280) / 1000.0)
  let beginTime = AVCoreAnimationBeginTimeAtZero + (raw.tMs / 1000.0)
  let startOffset: CGFloat = 28
  let scale = max(0.2, min(raw.scale ?? 1.0, 3.0))
  let endOffset = scale >= 1.0 ? startOffset * CGFloat(min(scale, 2.0)) : startOffset * CGFloat(max(scale, 0.5))
  let startLeft = overlayPoint(reference: reference, x: raw.x - Double(startOffset), y: raw.y, renderSize: renderSize)
  let startRight = overlayPoint(reference: reference, x: raw.x + Double(startOffset), y: raw.y, renderSize: renderSize)
  let endLeft = overlayPoint(reference: reference, x: raw.x - Double(endOffset), y: raw.y, renderSize: renderSize)
  let endRight = overlayPoint(reference: reference, x: raw.x + Double(endOffset), y: raw.y, renderSize: renderSize)

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
  edge rawEdge: String?,
  renderSize: CGSize,
  beginTime: CFTimeInterval,
  visibleDuration: CFTimeInterval,
  to overlayLayer: CALayer
) {
  let edge = (rawEdge ?? "left").lowercased()
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
