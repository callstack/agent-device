import Foundation

let encoder = JSONEncoder()
encoder.outputFormatting = [.sortedKeys]
let decoder = JSONDecoder()
var inputBuffer = Data()

while true {
  let chunk = FileHandle.standardInput.readData(ofLength: 4 * 1024)
  if chunk.isEmpty { break }
  inputBuffer.append(chunk)
  while let newline = inputBuffer.firstIndex(of: 0x0A) {
    let line = inputBuffer.subdata(in: inputBuffer.startIndex..<newline)
    inputBuffer.removeSubrange(inputBuffer.startIndex...newline)
    handleRequest(line)
  }
  if inputBuffer.count > 64 * 1024 {
    writeLog("request frame exceeded 65536 bytes")
    inputBuffer.removeAll(keepingCapacity: true)
  }
}

if !inputBuffer.isEmpty { handleRequest(inputBuffer) }

func handleRequest(_ line: Data) {
  guard line.count <= 64 * 1024 else {
    writeLog("discarded oversized request frame")
    return
  }
  let start = currentResourceUsage()
  let started = DispatchTime.now().uptimeNanoseconds
  do {
    let request = try decoder.decode(SpikeRequest.self, from: line)
    writeLog("capture id=\(request.id) candidate=\(request.candidate) screen=\(request.screen)")
    let capture = capturePublicAccessibility(request: request)
    let elapsedMs = Double(DispatchTime.now().uptimeNanoseconds - started) / 1_000_000
    let processMetrics = spikeProcessMetrics(since: start)
    let baseMetrics = SpikeMetrics(
      requestBytes: line.count + 1,
      responseBytes: 0,
      nodeCount: capture.acquisition?.nodes.count ?? 0,
      maxTraversalDepth: capture.maxTraversalDepth,
      cpuMs: processMetrics.cpuMs,
      memoryBytes: processMetrics.memoryBytes,
      durationMs: elapsedMs
    )
    let response = capture.failure.map {
      failureResponse(request: request, failure: $0, metrics: baseMetrics)
    } ?? SpikeResponse(
      version: 1,
      id: request.id,
      candidate: request.candidate,
      ok: true,
      acquisition: capture.acquisition,
      failure: nil,
      metrics: baseMetrics
    )
    writeResponse(response)
  } catch {
    writeLog("malformed request frame")
  }
}

func writeResponse(_ response: SpikeResponse) {
  guard let data = try? encoder.encode(response) else { return }
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data([0x0A]))
}

func writeLog(_ message: String) {
  let data = Data("[ios-ax-spike] \(message)\n".utf8)
  FileHandle.standardError.write(data)
}
