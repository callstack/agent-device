import AVFoundation
import CoreMedia
import XCTest

@testable import AgentDeviceMacOSHelper

/// AudioProbe must set AVAudioPCMBuffer.frameLength before the PCM copy.
final class AudioProbeTests: XCTestCase {
  func testAddSampleBufferRecordsANonSilentPeakFromRealPCM() throws {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent(
      "audio-probe-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }

    let outPath = dir.appendingPathComponent("probe.json").path
    let writer = AudioProbeStatusWriter(outPath: outPath, durationMs: 1_000, bucketMs: 100)
    writer.add(sampleBuffer: try makeFloatPCMSampleBuffer(frames: 512, amplitude: 0.5))
    try writer.finish(reason: "test")

    let response = try JSONDecoder().decode(
      AudioProbeResponse.self, from: Data(contentsOf: URL(fileURLWithPath: outPath)))
    XCTAssertTrue(response.heard, "a 0.5 amplitude buffer must clear the silence floor")
    XCTAssertFalse(response.peakDbfs.isEmpty)
    XCTAssertGreaterThan(response.peakDbfs.max() ?? -90, -90)
  }
}

private func makeFloatPCMSampleBuffer(frames: Int, amplitude: Float) throws -> CMSampleBuffer {
  var asbd = AudioStreamBasicDescription(
    mSampleRate: 48_000,
    mFormatID: kAudioFormatLinearPCM,
    mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked
      | kAudioFormatFlagIsNonInterleaved,
    mBytesPerPacket: UInt32(MemoryLayout<Float>.size),
    mFramesPerPacket: 1,
    mBytesPerFrame: UInt32(MemoryLayout<Float>.size),
    mChannelsPerFrame: 1,
    mBitsPerChannel: UInt32(MemoryLayout<Float>.size * 8),
    mReserved: 0
  )

  var formatDescription: CMAudioFormatDescription?
  let formatStatus = CMAudioFormatDescriptionCreate(
    allocator: kCFAllocatorDefault,
    asbd: &asbd,
    layoutSize: 0,
    layout: nil,
    magicCookieSize: 0,
    magicCookie: nil,
    extensions: nil,
    formatDescriptionOut: &formatDescription
  )
  guard formatStatus == noErr, let formatDescription else {
    throw NSError(
      domain: "AudioProbeTests", code: Int(formatStatus),
      userInfo: [NSLocalizedDescriptionKey: "CMAudioFormatDescriptionCreate failed"])
  }

  let byteCount = frames * MemoryLayout<Float>.size
  var blockBuffer: CMBlockBuffer?
  let blockStatus = CMBlockBufferCreateWithMemoryBlock(
    allocator: kCFAllocatorDefault,
    memoryBlock: nil,
    blockLength: byteCount,
    blockAllocator: nil,
    customBlockSource: nil,
    offsetToData: 0,
    dataLength: byteCount,
    flags: 0,
    blockBufferOut: &blockBuffer
  )
  guard blockStatus == noErr, let blockBuffer else {
    throw NSError(
      domain: "AudioProbeTests", code: Int(blockStatus),
      userInfo: [NSLocalizedDescriptionKey: "CMBlockBufferCreateWithMemoryBlock failed"])
  }
  let assureStatus = CMBlockBufferAssureBlockMemory(blockBuffer)
  guard assureStatus == noErr else {
    throw NSError(
      domain: "AudioProbeTests", code: Int(assureStatus),
      userInfo: [NSLocalizedDescriptionKey: "CMBlockBufferAssureBlockMemory failed"])
  }

  var lengthAtOffset = 0
  var totalLength = 0
  var dataPointer: UnsafeMutablePointer<Int8>?
  let pointerStatus = CMBlockBufferGetDataPointer(
    blockBuffer,
    atOffset: 0,
    lengthAtOffsetOut: &lengthAtOffset,
    totalLengthOut: &totalLength,
    dataPointerOut: &dataPointer
  )
  guard pointerStatus == noErr, let dataPointer else {
    throw NSError(
      domain: "AudioProbeTests", code: Int(pointerStatus),
      userInfo: [NSLocalizedDescriptionKey: "CMBlockBufferGetDataPointer failed"])
  }
  let floatPointer = UnsafeMutableRawPointer(dataPointer).bindMemory(to: Float.self, capacity: frames)
  for index in 0..<frames {
    floatPointer[index] = amplitude
  }

  var timing = CMSampleTimingInfo(
    duration: CMTime(value: 1, timescale: 48_000),
    presentationTimeStamp: .zero,
    decodeTimeStamp: .invalid
  )
  var sampleBuffer: CMSampleBuffer?
  let sampleStatus = CMSampleBufferCreateReady(
    allocator: kCFAllocatorDefault,
    dataBuffer: blockBuffer,
    formatDescription: formatDescription,
    sampleCount: frames,
    sampleTimingEntryCount: 1,
    sampleTimingArray: &timing,
    sampleSizeEntryCount: 0,
    sampleSizeArray: nil,
    sampleBufferOut: &sampleBuffer
  )
  guard sampleStatus == noErr, let sampleBuffer else {
    throw NSError(
      domain: "AudioProbeTests", code: Int(sampleStatus),
      userInfo: [NSLocalizedDescriptionKey: "CMSampleBufferCreateReady failed"])
  }
  return sampleBuffer
}
