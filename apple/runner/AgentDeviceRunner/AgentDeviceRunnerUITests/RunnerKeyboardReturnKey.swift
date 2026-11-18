import Foundation

/// The known identifiers of system Return controls. The displayed label can be localized.
enum RunnerKeyboardReturnKey: String {
  case go
  case search
  case send
  case next
  case done
  case join
  case route
  case `continue`
  case enter
  case unknown

  /// Classify an observed accessibility identifier for status metadata.
  static func kind(forIdentifier identifier: String) -> RunnerKeyboardReturnKey {
    switch identifier.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
    case "go": return .go
    case "search": return .search
    case "send": return .send
    case "next": return .next
    case "done": return .done
    case "join": return .join
    case "route": return .route
    case "continue": return .continue
    case "return", "enter": return .enter
    default: return .unknown
    }
  }
}
