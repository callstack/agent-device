import AVFoundation
import CoreVideo
import Foundation

let outputURL = URL(fileURLWithPath: CommandLine.arguments[1])
let transformName = CommandLine.arguments[2]
let width = 480
let height = 640
let writer = try AVAssetWriter(outputURL: outputURL, fileType: .mp4)
let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
  AVVideoCodecKey: AVVideoCodecType.h264,
  AVVideoWidthKey: width,
  AVVideoHeightKey: height,
])
switch transformName {
case "identity":
  input.transform = .identity
case "rot90-negative-origin":
  input.transform = CGAffineTransform(a: 0, b: 1, c: -1, d: 0, tx: 0, ty: 0)
case "rot90-translated":
  input.transform = CGAffineTransform(a: 0, b: 1, c: -1, d: 0, tx: CGFloat(height), ty: 0)
default:
  fatalError("Unknown fixture transform: \(transformName)")
}
let adaptor = AVAssetWriterInputPixelBufferAdaptor(
  assetWriterInput: input,
  sourcePixelBufferAttributes: [
    kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32ARGB,
    kCVPixelBufferWidthKey as String: width,
    kCVPixelBufferHeightKey as String: height,
  ]
)
writer.add(input)
guard writer.startWriting() else { fatalError("Writer failed: \(String(describing: writer.error))") }
writer.startSession(atSourceTime: .zero)
for frame in 0..<36 {
  while !input.isReadyForMoreMediaData { Thread.sleep(forTimeInterval: 0.002) }
  var buffer: CVPixelBuffer?
  guard CVPixelBufferPoolCreatePixelBuffer(nil, adaptor.pixelBufferPool!, &buffer) == kCVReturnSuccess,
    let buffer
  else { fatalError("Could not allocate fixture frame") }
  CVPixelBufferLockBaseAddress(buffer, [])
  let base = CVPixelBufferGetBaseAddress(buffer)!.assumingMemoryBound(to: UInt8.self)
  let stride = CVPixelBufferGetBytesPerRow(buffer)
  for y in 0..<height {
    for x in 0..<width {
      let offset = y * stride + x * 4
      let redMarker = x < 15 && y < 25
      base[offset] = 255
      base[offset + 1] = 245
      base[offset + 2] = redMarker ? 30 : 245
      base[offset + 3] = redMarker ? 30 : 245
    }
  }
  CVPixelBufferUnlockBaseAddress(buffer, [])
  guard adaptor.append(buffer, withPresentationTime: CMTime(value: Int64(frame), timescale: 30))
  else { fatalError("Append failed: \(String(describing: writer.error))") }
}
input.markAsFinished()
let finished = DispatchSemaphore(value: 0)
writer.finishWriting { finished.signal() }
guard finished.wait(timeout: .now() + 10) == .success, writer.status == .completed
else { fatalError("Finish failed: \(String(describing: writer.error))") }
