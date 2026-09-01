import Foundation

struct SpikeRequest: Decodable {
  let version: Int
  let id: String
  let candidate: String
  let simulatorUdid: String
  let state: String
  let screen: String
  let appBundleId: String
  let targetProcessId: Int32?
  let expectedTargetGeneration: String?
  let limits: SpikeLimits
}

struct SpikeLimits: Decodable {
  let maxRequestBytes: Int
  let maxResponseBytes: Int
  let maxNodes: Int
  let maxTraversalDepth: Int
  let maxCpuMs: Int
  let maxMemoryBytes: Int
  let maxDurationMs: Int
}

struct SpikeRect: Encodable {
  let x: Double
  let y: Double
  let width: Double
  let height: Double
}

struct SpikeNode: Encodable {
  let id: String
  let parentId: String?
  let role: String?
  let subrole: String?
  let label: String?
  let value: String?
  let identifier: String?
  let frame: SpikeRect?
  let enabled: Bool?
  let selected: Bool?
  let focused: Bool?
}

struct SpikeViewport: Encodable {
  let kind: String
  let rect: SpikeRect?
  let reason: String?
  let coordinateSpace: String?
  let source: String?
}

struct SpikeResidue: Encodable {
  let kind: String
  let fields: [String]?
  let dimension: String?
  let limit: Int?
  let fact: String?
  let expected: String?
  let observed: String?
}

struct SpikeAcquisition: Encodable {
  let targetId: String
  let targetGeneration: String?
  let nodes: [SpikeNode]
  let viewport: SpikeViewport
  let truncated: Bool
  let residue: [SpikeResidue]
}

struct SpikeFailure: Encodable {
  let kind: String
  let code: String?
  let expectedTargetGeneration: String?
  let observedTargetGeneration: String?
}

struct SpikeMetrics: Encodable {
  let requestBytes: Int
  let responseBytes: Int
  let nodeCount: Int
  let maxTraversalDepth: Int
  let cpuMs: Double?
  let memoryBytes: Int64?
  let durationMs: Double
}

struct SpikeResponse: Encodable {
  let version: Int
  let id: String
  let candidate: String
  let ok: Bool
  let acquisition: SpikeAcquisition?
  let failure: SpikeFailure?
  let metrics: SpikeMetrics
}

struct SpikeCapture {
  let acquisition: SpikeAcquisition?
  let failure: SpikeFailure?
  let maxTraversalDepth: Int
}

func unsupportedCapture(
  code: String,
  observedTargetGeneration: String? = nil
) -> SpikeCapture {
  SpikeCapture(
    acquisition: nil,
    failure: SpikeFailure(
      kind: "unsupported-mechanism",
      code: code,
      expectedTargetGeneration: nil,
      observedTargetGeneration: observedTargetGeneration
    ),
    maxTraversalDepth: 0
  )
}

func failureResponse(
  request: SpikeRequest,
  failure: SpikeFailure,
  metrics: SpikeMetrics
) -> SpikeResponse {
  SpikeResponse(
    version: 1,
    id: request.id,
    candidate: request.candidate,
    ok: false,
    acquisition: nil,
    failure: failure,
    metrics: metrics
  )
}
