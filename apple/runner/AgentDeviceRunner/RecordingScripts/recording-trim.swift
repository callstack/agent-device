import AVFoundation
import Foundation

/// Entry point: `@main` because multi-file swiftc compilation reserves top-level statements for
/// `main.swift`, which cannot be shared per-script.
@main
enum RecordingTrim {
  static func main() {
    do {
      try run()
    } catch {
      fputs("recording-trim: \(error)\n", stderr)
      exit(1)
    }
  }
}

func run() throws {
  let arguments = Array(CommandLine.arguments.dropFirst())
  let parsedArgs = try parseArguments(arguments)
  let inputURL = URL(fileURLWithPath: parsedArgs.inputPath)
  let outputURL = URL(fileURLWithPath: parsedArgs.outputPath)

  try removeStaleOutput(outputURL)

  let asset = AVURLAsset(url: inputURL)
  let videoTrack = try sourceVideoTrack(of: asset)
  let trimStart = CMTime(seconds: parsedArgs.trimStartMs / 1000.0, preferredTimescale: 600)
  guard CMTimeCompare(trimStart, asset.duration) < 0 else {
    throw RecordingScriptError.invalidTrimRange
  }

  let trimmedDuration = CMTimeSubtract(asset.duration, trimStart)
  guard CMTimeCompare(trimmedDuration, .zero) > 0 else {
    throw RecordingScriptError.invalidTrimRange
  }

  let composition = try makeRecordingComposition(
    asset: asset,
    videoTrack: videoTrack,
    timeRange: CMTimeRange(start: trimStart, duration: trimmedDuration)
  )
  composition.tracks(withMediaType: .video).first?.preferredTransform = videoTrack.preferredTransform

  // Passthrough keeps the trim lossless when the composition supports it; otherwise re-encode at
  // highest quality.
  let presetName = AVAssetExportSession.exportPresets(compatibleWith: composition)
    .contains(AVAssetExportPresetPassthrough)
    ? AVAssetExportPresetPassthrough
    : AVAssetExportPresetHighestQuality
  let exporter = try makeRecordingExporter(composition, presetName: presetName, outputURL: outputURL)
  try runRecordingExport(
    exporter,
    timeoutMessage: "Trim export timed out.",
    failureMessage: "Trim export failed."
  )
}

func parseArguments(_ arguments: [String]) throws -> (inputPath: String, outputPath: String, trimStartMs: Double) {
  var inputPath: String?
  var outputPath: String?
  var trimStartMs: Double?
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
    case "--trim-start-ms":
      let rawValue = try recordingOptionValue(arguments, nextIndex, "--trim-start-ms")
      guard let parsed = Double(rawValue), parsed >= 0 else {
        throw RecordingScriptError.invalidArgs("--trim-start-ms must be a non-negative number")
      }
      trimStartMs = parsed
      index += 2
    default:
      throw RecordingScriptError.invalidArgs("Unknown argument: \(argument)")
    }
  }

  guard let inputPath, let outputPath, let trimStartMs else {
    throw RecordingScriptError.invalidArgs(
      "Usage: recording-trim.swift --input <video> --output <video> --trim-start-ms <ms>"
    )
  }
  return (inputPath, outputPath, trimStartMs)
}
