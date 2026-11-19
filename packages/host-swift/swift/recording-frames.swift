import AVFoundation
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// Extracts the frames at the requested presentation times from a recording and writes each one as
/// a PNG, then prints a JSON manifest naming the time each returned image actually carries.
///
/// The caller owns the sampling grid: it passes an explicit, bounded list of times, so this script
/// never walks a whole clip. `--times` is the whole job description, which keeps the amount of
/// decoding, the bytes on disk, and the wall clock all bounded by the request rather than by the
/// recording's length.
///
/// Reported times are the generator's *actual* return times, not the ones that were asked for. A
/// decoder answers a request with the frame it holds at that moment; the manifest says which frame
/// that was, so nothing downstream can print a requested time as though it had been decoded.

struct FrameManifest: Encodable {
  struct Frame: Encodable {
    let index: Int
    let requestedTimeMs: Double
    let actualTimeMs: Double
    let width: Int
    let height: Int
    let path: String
  }

  struct Skipped: Encodable {
    let index: Int
    let requestedTimeMs: Double
    let reason: String
  }

  let inputPath: String
  let durationMs: Double
  let frames: [Frame]
  let skipped: [Skipped]
}

/// Entry point: `@main` because multi-file swiftc compilation reserves top-level statements for
/// `main.swift`, which cannot be shared per-script.
@main
enum RecordingFrames {
  static func main() {
    do {
      try run()
    } catch {
      fputs("recording-frames: \(error)\n", stderr)
      exit(1)
    }
  }
}

func run() throws {
  let arguments = Array(CommandLine.arguments.dropFirst())
  let inputURL = URL(fileURLWithPath: try requiredOption(arguments, "--input"))
  let outputDirectoryURL = URL(fileURLWithPath: try requiredOption(arguments, "--output-dir"), isDirectory: true)
  let requestedTimesMs = try parseTimes(try requiredOption(arguments, "--times"))
  let maxWidth = try parseMaxWidth(optionValue(arguments, "--max-width"))

  guard !requestedTimesMs.isEmpty else {
    throw RecordingScriptError.invalidArgs("--times must name at least one presentation time")
  }
  try FileManager.default.createDirectory(at: outputDirectoryURL, withIntermediateDirectories: true)

  let asset = AVURLAsset(url: inputURL)
  _ = try sourceVideoTrack(of: asset)
  let durationMs = max(0, asset.duration.seconds * 1000)

  let generator = AVAssetImageGenerator(asset: asset)
  generator.appliesPreferredTrackTransform = true
  generator.maximumSize = CGSize(width: maxWidth, height: maxWidth)
  generator.requestedTimeToleranceBefore = .zero
  generator.requestedTimeToleranceAfter = .zero

  var frames: [FrameManifest.Frame] = []
  var skipped: [FrameManifest.Skipped] = []

  for (index, requestedTimeMs) in requestedTimesMs.enumerated() {
    let requestedTime = CMTime(seconds: requestedTimeMs / 1000, preferredTimescale: 600)
    var actualTime = CMTime.invalid
    let cgImage: CGImage
    do {
      cgImage = try generator.copyCGImage(at: requestedTime, actualTime: &actualTime)
    } catch {
      skipped.append(
        FrameManifest.Skipped(
          index: index,
          requestedTimeMs: requestedTimeMs,
          reason: "\(error)"
        )
      )
      continue
    }

    // A frame the decoder cannot place on the timeline is not a frame at 0 ms. Writing it would
    // label a mid-clip moment as the opening one, so the sample goes unanswered instead and the
    // manifest says so.
    guard CMTIME_IS_VALID(actualTime), actualTime.timescale != 0 else {
      skipped.append(
        FrameManifest.Skipped(
          index: index,
          requestedTimeMs: requestedTimeMs,
          reason: "Decoder returned no presentation time for this frame"
        )
      )
      continue
    }

    let outputURL = outputDirectoryURL.appendingPathComponent(frameFileName(index: index))
    do {
      try writePNG(cgImage: cgImage, to: outputURL)
    } catch {
      // A frame the decoder produced but storage refused is a failed run, not a moment the
      // recording has nothing to show: reporting it as skipped would let a partial sheet claim
      // to cover the clip.
      try? FileManager.default.removeItem(at: outputURL)
      throw RecordingScriptError.frameWriteFailed(
        "Could not write frame \(index) at \(requestedTimeMs)ms to \(outputURL.path): \(error)"
      )
    }

    frames.append(
      FrameManifest.Frame(
        index: index,
        requestedTimeMs: requestedTimeMs,
        actualTimeMs: timeIntervalMs(actualTime),
        width: cgImage.width,
        height: cgImage.height,
        path: outputURL.path
      )
    )
  }

  let manifest = FrameManifest(
    inputPath: inputURL.path,
    durationMs: durationMs,
    frames: frames,
    skipped: skipped
  )
  let encoder = JSONEncoder()
  encoder.outputFormatting = [.sortedKeys]
  FileHandle.standardOutput.write(try encoder.encode(manifest))
}

func requiredOption(_ arguments: [String], _ flag: String) throws -> String {
  guard let index = arguments.firstIndex(of: flag) else {
    throw RecordingScriptError.invalidArgs("Missing \(flag)")
  }
  return try recordingOptionValue(arguments, index + 1, flag)
}

func optionValue(_ arguments: [String], _ flag: String) -> String? {
  guard let index = arguments.firstIndex(of: flag), index + 1 < arguments.count else {
    return nil
  }
  return arguments[index + 1]
}

func parseTimes(_ value: String) throws -> [Double] {
  let parts = value.split(separator: ",", omittingEmptySubsequences: true)
  guard !parts.isEmpty else {
    throw RecordingScriptError.invalidArgs("--times must be a comma-separated list of milliseconds")
  }
  return try parts.map { part in
    guard let parsed = Double(part), parsed.isFinite, parsed >= 0 else {
      throw RecordingScriptError.invalidArgs("Invalid sample time: \(part)")
    }
    return parsed
  }
}

func parseMaxWidth(_ value: String?) throws -> Int {
  guard let value else { return 360 }
  guard let parsed = Int(value), parsed > 0 else {
    throw RecordingScriptError.invalidArgs("Invalid --max-width: \(value)")
  }
  return parsed
}

func timeIntervalMs(_ time: CMTime) -> Double {
  guard CMTIME_IS_VALID(time), time.timescale != 0 else { return 0 }
  return CMTimeGetSeconds(time) * 1000
}

func frameFileName(index: Int) -> String {
  String(format: "frame-%04d.png", index)
}

func writePNG(cgImage: CGImage, to url: URL) throws {
  guard let destination = CGImageDestinationCreateWithURL(
    url as CFURL,
    UTType.png.identifier as CFString,
    1,
    nil
  ) else {
    throw RecordingScriptError.exportFailed("Failed to open PNG destination for \(url.lastPathComponent)")
  }
  CGImageDestinationAddImage(destination, cgImage, nil)
  guard CGImageDestinationFinalize(destination) else {
    throw RecordingScriptError.exportFailed("Failed to encode PNG for \(url.lastPathComponent)")
  }
}
