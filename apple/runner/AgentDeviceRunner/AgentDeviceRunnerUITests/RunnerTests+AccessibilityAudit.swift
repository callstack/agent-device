import XCTest

struct NativeAuditRect: Codable {
  let x: Double
  let y: Double
  let width: Double
  let height: Double
}

struct NativeAuditIssuePayload: Codable {
  let auditType: String
  let description: String
  let rect: NativeAuditRect?
}

#if os(iOS)
@available(iOS 17.0, *)
func nativeAuditTypeName(_ type: XCUIAccessibilityAuditType) -> String {
  switch type {
  case .contrast: return "contrast"
  case .dynamicType: return "dynamicType"
  case .elementDetection: return "elementDetection"
  case .hitRegion: return "hitRegion"
  case .sufficientElementDescription: return "sufficientElementDescription"
  case .textClipped: return "textClipped"
  case .trait: return "trait"
  default: return "unknown:\(type.rawValue)"
  }
}
#endif

#if os(iOS)
/// The audit must leave the app as it found it. Apple's Dynamic Type and clipped-text checks
/// resize the app's text while they run, so they are not requested.
@available(iOS 17.0, *)
let readOnlyAuditTypes: XCUIAccessibilityAuditType = [
  .contrast, .elementDetection, .hitRegion, .sufficientElementDescription, .trait,
]
#endif

extension RunnerTests {
  @MainActor
  func executeAccessibilityAudit(app: XCUIApplication) -> Response {
#if os(iOS)
    if #available(iOS 17.0, *) {
      var issues: [NativeAuditIssuePayload] = []
      do {
        try app.performAccessibilityAudit(for: readOnlyAuditTypes) { issue in
          let frame = issue.element?.frame
          issues.append(NativeAuditIssuePayload(
            auditType: nativeAuditTypeName(issue.auditType),
            description: issue.detailedDescription,
            rect: frame.map { NativeAuditRect(x: $0.origin.x, y: $0.origin.y, width: $0.width, height: $0.height) }
          ))
          return true
        }
        return Response(ok: true, data: DataPayload(auditIssues: issues))
      } catch {
        return Response(ok: false, error: ErrorPayload(
          code: "COMMAND_FAILED", message: "Native accessibility audit failed: \(error.localizedDescription)"
        ))
      }
    }
#endif
    return Response(ok: false, error: ErrorPayload(
      code: RunnerWireErrorCode.nativeAuditUnavailable, message: "Native accessibility audit requires iOS 17+ and the XCTest runner"
    ))
  }
}
