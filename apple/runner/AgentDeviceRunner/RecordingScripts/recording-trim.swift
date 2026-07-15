import AVFoundation
import Foundation

enum TrimError: Error, CustomStringConvertible {
  case invalidArgs(String)
  case invalidTrimRange
  case missingVideoTrack
  case exportFailed(String)

  var description: String {
    switch self {
    case .invalidArgs(let message):
      return message
    case .invalidTrimRange:
      return "Trim start must be before the end of the recording."
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
  fputs("recording-trim: \(error)\n", stderr)
  exit(1)
}

func run() throws {
  let arguments = Array(CommandLine.arguments.dropFirst())
  let parsedArgs = try parseArguments(arguments)
  let inputURL = URL(fileURLWithPath: parsedArgs.inputPath)
  let outputURL = URL(fileURLWithPath: parsedArgs.outputPath)

  if FileManager.default.fileExists(atPath: outputURL.path) {
    try FileManager.default.removeItem(at: outputURL)
  }

  let asset = AVURLAsset(url: inputURL)
  guard let sourceVideoTrack = asset.tracks(withMediaType: .video).first else {
    throw TrimError.missingVideoTrack
  }

  let trimStart = CMTime(seconds: parsedArgs.trimStartMs / 1000.0, preferredTimescale: 600)
  guard CMTimeCompare(trimStart, asset.duration) < 0 else {
    throw TrimError.invalidTrimRange
  }

  let trimmedDuration = CMTimeSubtract(asset.duration, trimStart)
  guard CMTimeCompare(trimmedDuration, .zero) > 0 else {
    throw TrimError.invalidTrimRange
  }

  let composition = AVMutableComposition()
  let trimmedRange = CMTimeRange(start: trimStart, duration: trimmedDuration)

  guard let compositionVideoTrack = composition.addMutableTrack(
    withMediaType: .video,
    preferredTrackID: kCMPersistentTrackID_Invalid
  ) else {
    throw TrimError.exportFailed("Failed to create composition video track.")
  }
  try compositionVideoTrack.insertTimeRange(trimmedRange, of: sourceVideoTrack, at: .zero)
  compositionVideoTrack.preferredTransform = sourceVideoTrack.preferredTransform

  if let sourceAudioTrack = asset.tracks(withMediaType: .audio).first,
     let compositionAudioTrack = composition.addMutableTrack(
       withMediaType: .audio,
       preferredTrackID: kCMPersistentTrackID_Invalid
     ) {
    try? compositionAudioTrack.insertTimeRange(trimmedRange, of: sourceAudioTrack, at: .zero)
  }

  let presetName = AVAssetExportSession.exportPresets(compatibleWith: composition)
    .contains(AVAssetExportPresetPassthrough)
    ? AVAssetExportPresetPassthrough
    : AVAssetExportPresetHighestQuality
  guard let exporter = AVAssetExportSession(asset: composition, presetName: presetName) else {
    throw TrimError.exportFailed("Failed to create export session.")
  }

  exporter.outputURL = outputURL
  exporter.outputFileType = .mp4
  exporter.shouldOptimizeForNetworkUse = true

  let semaphore = DispatchSemaphore(value: 0)
  exporter.exportAsynchronously {
    semaphore.signal()
  }
  if semaphore.wait(timeout: .now() + 120) == .timedOut {
    exporter.cancelExport()
    throw TrimError.exportFailed("Trim export timed out.")
  }

  if exporter.status != .completed {
    throw TrimError.exportFailed(exporter.error?.localizedDescription ?? "Trim export failed.")
  }
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
      guard nextIndex < arguments.count else { throw TrimError.invalidArgs("--input requires a value") }
      inputPath = arguments[nextIndex]
      index += 2
    case "--output":
      guard nextIndex < arguments.count else { throw TrimError.invalidArgs("--output requires a value") }
      outputPath = arguments[nextIndex]
      index += 2
    case "--trim-start-ms":
      guard nextIndex < arguments.count else {
        throw TrimError.invalidArgs("--trim-start-ms requires a value")
      }
      guard let parsed = Double(arguments[nextIndex]), parsed >= 0 else {
        throw TrimError.invalidArgs("--trim-start-ms must be a non-negative number")
      }
      trimStartMs = parsed
      index += 2
    default:
      throw TrimError.invalidArgs("Unknown argument: \(argument)")
    }
  }

  guard let inputPath, let outputPath, let trimStartMs else {
    throw TrimError.invalidArgs(
      "Usage: recording-trim.swift --input <video> --output <video> --trim-start-ms <ms>"
    )
  }
  return (inputPath, outputPath, trimStartMs)
}
