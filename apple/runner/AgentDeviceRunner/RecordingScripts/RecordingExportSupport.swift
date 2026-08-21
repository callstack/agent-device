import AVFoundation
import Foundation

/// Shared mechanics for the recording post-processing scripts (overlay burn-in, start trim).
/// Each script keeps its own argument grammar and export-quality policy; this file owns the
/// error vocabulary, flag-value reading, composition assembly, and the bounded export wait.

enum RecordingScriptError: Error, CustomStringConvertible {
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

func recordingOptionValue(_ arguments: [String], _ nextIndex: Int, _ flag: String) throws -> String {
  guard nextIndex < arguments.count else {
    throw RecordingScriptError.invalidArgs("\(flag) requires a value")
  }
  return arguments[nextIndex]
}

func removeStaleOutput(_ outputURL: URL) throws {
  if FileManager.default.fileExists(atPath: outputURL.path) {
    try FileManager.default.removeItem(at: outputURL)
  }
}

func sourceVideoTrack(of asset: AVURLAsset) throws -> AVAssetTrack {
  guard let track = asset.tracks(withMediaType: .video).first else {
    throw RecordingScriptError.missingVideoTrack
  }
  return track
}

/// Copies `videoTrack` for `timeRange` into a fresh composition, carrying the optional audio track
/// along when present. The caller owns any `preferredTransform` policy: trim propagates the source
/// transform directly, while overlay re-applies it through a video-composition layer instruction
/// instead.
func makeRecordingComposition(
  asset: AVURLAsset,
  videoTrack: AVAssetTrack,
  timeRange: CMTimeRange
) throws -> AVMutableComposition {
  let composition = AVMutableComposition()
  guard let compositionVideoTrack = composition.addMutableTrack(
    withMediaType: .video,
    preferredTrackID: kCMPersistentTrackID_Invalid
  ) else {
    throw RecordingScriptError.exportFailed("Failed to create composition video track.")
  }
  try compositionVideoTrack.insertTimeRange(timeRange, of: videoTrack, at: .zero)

  if let sourceAudioTrack = asset.tracks(withMediaType: .audio).first,
     let compositionAudioTrack = composition.addMutableTrack(
       withMediaType: .audio,
       preferredTrackID: kCMPersistentTrackID_Invalid
     ) {
    try? compositionAudioTrack.insertTimeRange(timeRange, of: sourceAudioTrack, at: .zero)
  }
  return composition
}

func makeRecordingExporter(
  _ composition: AVAsset,
  presetName: String,
  outputURL: URL,
  videoComposition: AVMutableVideoComposition? = nil
) throws -> AVAssetExportSession {
  guard let exporter = AVAssetExportSession(asset: composition, presetName: presetName) else {
    throw RecordingScriptError.exportFailed("Failed to create export session.")
  }
  exporter.outputURL = outputURL
  exporter.outputFileType = .mp4
  exporter.videoComposition = videoComposition
  exporter.shouldOptimizeForNetworkUse = true
  return exporter
}

/// Bounded asynchronous export: signals completion through a semaphore and cancels after 120s so a
/// wedged encoder cannot hang the recording pipeline past the caller's own timeout budget.
func runRecordingExport(
  _ exporter: AVAssetExportSession,
  timeoutMessage: String,
  failureMessage: String
) throws {
  let semaphore = DispatchSemaphore(value: 0)
  exporter.exportAsynchronously {
    semaphore.signal()
  }
  if semaphore.wait(timeout: .now() + 120) == .timedOut {
    exporter.cancelExport()
    throw RecordingScriptError.exportFailed(timeoutMessage)
  }

  if exporter.status != .completed {
    throw RecordingScriptError.exportFailed(exporter.error?.localizedDescription ?? failureMessage)
  }
}
