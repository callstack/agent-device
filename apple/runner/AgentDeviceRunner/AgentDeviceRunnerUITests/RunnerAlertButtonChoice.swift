import Foundation

/// Which of an alert's buttons an `accept` or `dismiss` activates, decided on the button labels
/// alone, so the rule is checkable without a screen.
///
/// Earlier label preferences win; equal-rank buttons refuse rather than use their order.
/// `dismiss` activates only a recognized decline label. An unknown decline cannot be
/// identified from labels or button position: iOS localizes prompts unevenly, so one prompt can
/// pair a localized decline with a still-English affirmative, and a positional guess would tap
/// that affirmative and record an authorization (#3627). An unrecognized decline is therefore
/// refused with `ALERT_BUTTON_NOT_FOUND` and no tap.
///
/// The one exception is a dismiss-popup surface itself: its native accessibility marker is the
/// app's own declaration that the surface closes the popover, so `popupMarkerSurface` lets
/// `dismiss` take the last actionable element of that window. A consent prompt can never carry
/// that marker.
enum RunnerAlertButtonChoice {
  private static let acceptPreferences = [
    "^allow while using (?:the )?app$", "^while using the app$", "^allow all$",
    "^always allow$", "^allow all the time$", "^allow notifications$", "^allow$",
    "^ok$", "^yes$", "^continue$", "^save$", "^confirm", "^turn on$",
    "^open settings$", "^done$", "^open$", "^allow once$", "^only this time$"
  ]
  private static let dismissPreferences = [
    "^cancel$", "^deny$", "^don.?t allow$", "^not now$", "^no$", "^dismiss$",
    "^close$", "^close app$", "^later$", "^skip$", "^ask app not to track$", "^keep browsing$"
  ]

  static func buttonIndex(for labels: [String], action: String, popupMarkerSurface: Bool = false) -> Int? {
    let preferences = action == "accept" ? acceptPreferences : dismissPreferences
    for pattern in preferences {
      let matchingIndices = labels.indices.filter { matches(labels[$0], pattern: pattern) }
      if matchingIndices.count > 1 { return nil }
      if let index = matchingIndices.first { return index }
    }
    return action != "accept" && popupMarkerSurface ? labels.indices.last : nil
  }

  private static func matches(_ label: String, pattern: String) -> Bool {
    label.trimmingCharacters(in: .whitespacesAndNewlines)
      .range(of: pattern, options: [.regularExpression, .caseInsensitive]) != nil
  }
}
