import Foundation

extension RunnerTests {
  /// Where a bridge request waits for its read. The queue is concurrent, so a request reaches the
  /// reader's admission at once: the reader runs one read at a time and refuses an overlapping one
  /// immediately, and a read's budget starts at its admission rather than after a hidden wait.
  static let snapshotBridgeQueue = DispatchQueue(
    label: "agent-device.runner.snapshot-bridge",
    attributes: .concurrent
  )

  /// The largest envelope the transport carries when a request names no smaller bound. It matches the
  /// guest bridge's frame bound, so a tree too large for one transport is too large for the other.
  static let snapshotBridgeMaximumResponseBytes = 16 * 1024 * 1024

  /// Serves one `snapshotBridge` command. The answer is always a bridge envelope, including the reader's
  /// own refusals; only a request the runner cannot read at all is a runner error.
  func executeSnapshotBridge(command: Command) -> Response {
    guard
      let payload = command.snapshotBridge,
      let bundleId = command.appBundleId?.trimmingCharacters(in: .whitespacesAndNewlines),
      !bundleId.isEmpty
    else {
      return Response(
        ok: false,
        error: ErrorPayload(
          code: "INVALID_ARGS",
          message: "snapshotBridge requires appBundleId and a snapshotBridge payload"
        )
      )
    }
    let envelope = RunnerSnapshotBridgeHandle(
      payload.verb,
      bundleId,
      Self.snapshotBridgeReaderRequest(payload)
    )
    let limit = payload.maxResponseBytes ?? Self.snapshotBridgeMaximumResponseBytes
    return Response(
      ok: true,
      data: DataPayload(snapshotBridgeEnvelope: Self.serializedSnapshotBridgeEnvelope(
        envelope,
        requestId: payload.requestId,
        maxBytes: limit
      ))
    )
  }

  /// The reader's request dictionary. The tree and automation flags are the guest bridge's fixed
  /// `describe` contract, so the host does not repeat them on the runner transport.
  static func snapshotBridgeReaderRequest(_ payload: SnapshotBridgeCommandPayload) -> [String: Any] {
    var request: [String: Any] = [
      "verb": "describe",
      "requestId": payload.requestId,
      "snapshotTree": true,
      "automationMode": true,
    ]
    request["generation"] = payload.generation
    request["expectedPid"] = payload.expectedPid
    request["expectedProcessStartTime"] = payload.expectedProcessStartTime
    request["maxDepth"] = payload.maxDepth
    request["maxNodes"] = payload.maxNodes
    request["maxDurationMs"] = payload.maxDurationMs
    request["maxResponseBytes"] = payload.maxResponseBytes
    request["nativeLevelsHint"] = payload.nativeLevelsHint
    if let executables = payload.surfaceHostExecutables {
      // The runner runs inside the Simulator it reads, so it names that Simulator itself.
      request["surfaceHostExecutables"] = executables
      request["simulatorUdid"] = ProcessInfo.processInfo.environment["SIMULATOR_UDID"] ?? ""
    }
    return request
  }

  /// The envelope as JSON, or the guest bridge's own refusal: `response-too-large` when it exceeds the
  /// request's bound, `response-not-json-safe` when it cannot be serialized. The refusal keeps the
  /// identity fields, so the host still reports which process the tree belonged to.
  static func serializedSnapshotBridgeEnvelope(
    _ envelope: [AnyHashable: Any],
    requestId: String,
    maxBytes: Int
  ) -> String {
    let data = JSONSerialization.isValidJSONObject(envelope)
      ? try? JSONSerialization.data(withJSONObject: envelope) : nil
    if let data, data.count <= maxBytes, let text = String(data: data, encoding: .utf8) {
      return text
    }
    var refusal: [String: Any] = data == nil
      ? [
        "requestId": requestId, "ok": false, "error_kind": "malformed_tree",
        "error_code": "response-not-json-safe", "error": "response was not JSON serializable",
      ]
      : [
        "requestId": requestId, "ok": false, "error_kind": "response_limit_exceeded",
        "error_code": "response-too-large",
        "error": "snapshot response exceeds the per-request response bound",
      ]
    for key in ["protocolVersion", "sourceVersion", "pid", "generation", "processStartTime"] {
      if let value = envelope[key] { refusal[key] = value }
    }
    let encoded = (try? JSONSerialization.data(withJSONObject: refusal)) ?? Data("{}".utf8)
    return String(data: encoded, encoding: .utf8) ?? "{}"
  }
}
