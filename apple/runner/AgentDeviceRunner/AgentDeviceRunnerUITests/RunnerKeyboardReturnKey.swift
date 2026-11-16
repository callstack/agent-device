import Foundation

/// What the keyboard's return key offers, read from the key's own label or identifier.
///
/// The key is the app's declaration of what submitting the focused field does, and only the app
/// can answer that: `UITextInput.returnKeyType` reaches the keyboard as one of Apple's return-key
/// types, whose English wording is what XCTest exposes. This maps that wording to one stable kind.
///
/// Exact, case-insensitive matches only. An unlisted label stays `.unknown` rather than being
/// guessed: iOS localizes these keys unevenly, so a prefix or fuzzy rule would report a localized
/// "Done" as something else. Absence is not a kind either — only a control this module cannot read
/// is `.unknown`; a keyboard with no return control is reported by the caller that looked for one.
///
/// Three of Apple's return-key types are deliberately unmapped and answer `.unknown`: `Google` and
/// `Yahoo` are vendor-branded keys whose wording names a vendor rather than a submit action, and
/// `Emergency Call` places a call, which no caller of this should ever report as a submit. Every
/// other Apple type has a case above.
///
/// `probeLabels` is the order `findKeyboardReturnControl(app:)` presses in. It is the runner's own
/// vocabulary, so it is not derived from the cases: it carries the two spellings of the plain
/// return key, in the order that found a hittable control before this rule existed.
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

  /// The keyboard control labels `findKeyboardReturnControl(app:)` tries, in order.
  static let probeLabels = ["return", "Return", "Enter", "Go", "Search", "Next", "Done", "Send", "Join"]

  /// The kind an accessibility label or identifier names. Surrounding whitespace is trimmed
  /// because the accessibility tree carries it; nothing else is normalized.
  static func kind(of text: String) -> RunnerKeyboardReturnKey {
    switch text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
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
