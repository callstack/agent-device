import Foundation

/// Which of an alert's buttons an `accept` or `dismiss` activates, decided on the button labels
/// alone, so the rule is checkable without a screen.
///
/// Earlier label preferences win; equal-rank buttons refuse rather than use their order.
/// `dismiss` activates only a recognized decline label. An unknown decline cannot be
/// identified from labels or button position: iOS localizes prompts unevenly, so one prompt can
/// pair a localized decline with a still-English affirmative, and a positional guess would tap
/// that affirmative and record an authorization (#3627). An unrecognized decline is therefore
/// refused with `ALERT_BUTTON_NOT_FOUND` and no tap. A `RunnerAlertLabelVocabulary` matches the
/// device language's wording of these labels through the English labels it translates.
///
/// The one exception is a dismiss-popup surface itself: its native accessibility marker is the
/// app's own declaration that the surface closes the popover, so `popupMarkerSurface` lets
/// `dismiss` take the last actionable element of that window. A consent prompt can never carry
/// that marker.
enum RunnerAlertButtonChoice {
  private static let acceptPreferences = compiled([
    "^allow while using (?:the )?app$", "^while using the app$", "^allow all$",
    "^always allow$", "^allow all the time$", "^allow notifications$", "^allow$",
    "^ok$", "^yes$", "^continue$", "^save$", "^confirm", "^turn on$",
    "^open settings$", "^done$", "^open$", "^allow once$", "^only this time$"
  ])
  private static let dismissPreferences = compiled([
    "^cancel$", "^deny$", "^don.?t allow$", "^not now$", "^no$", "^dismiss$",
    "^close$", "^close app$", "^later$", "^skip$", "^ask app not to track$", "^keep browsing$"
  ])

  static func buttonIndex(
    for labels: [String],
    action: String,
    popupMarkerSurface: Bool = false,
    vocabulary: RunnerAlertLabelVocabulary
  ) -> Int? {
    let preferences = action == "accept" ? acceptPreferences : dismissPreferences
    let candidates = labels.map { [$0] + vocabulary.englishLabels(for: $0) }
    for pattern in preferences {
      let matchingIndices = labels.indices.filter { candidates[$0].contains { matches($0, pattern: pattern) } }
      if matchingIndices.count > 1 { return nil }
      if let index = matchingIndices.first { return index }
    }
    return action != "accept" && popupMarkerSurface ? labels.indices.last : nil
  }

  /// The action an English label's preference entry names, accept first. `wholeLabel` requires
  /// the entry to cover the entire label, so the prefix-matched "Confirm…" family names only
  /// "Confirm" itself.
  static func action(of label: String, wholeLabel: Bool = false) -> String? {
    if acceptPreferences.contains(where: { matches(label, pattern: $0, wholeLabel: wholeLabel) }) { return "accept" }
    if dismissPreferences.contains(where: { matches(label, pattern: $0, wholeLabel: wholeLabel) }) { return "dismiss" }
    return nil
  }

  private static func compiled(_ patterns: [String]) -> [NSRegularExpression] {
    patterns.map { try! NSRegularExpression(pattern: $0, options: .caseInsensitive) }
  }

  private static func matches(_ label: String, pattern: NSRegularExpression, wholeLabel: Bool = false) -> Bool {
    let trimmed = label.trimmingCharacters(in: .whitespacesAndNewlines)
    let range = NSRange(trimmed.startIndex..., in: trimmed)
    guard let match = pattern.firstMatch(in: trimmed, range: range) else { return false }
    return !wholeLabel || match.range == range
  }
}
