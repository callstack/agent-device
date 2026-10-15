import Foundation

/// Which of an alert's buttons an `accept` or `dismiss` activates, decided on the button labels
/// alone, so the rule is checkable without a screen.
///
/// `dismiss` never answers a button `isAcceptButton` recognizes. iOS words the App Tracking
/// Transparency prompt's decline in every language differently, so no decline list carries it,
/// and a fallback to the last button answered "Allow" while reporting `dismissed` (#3627). With
/// no known decline label, the only candidate that could decline is a label the accept list does
/// not claim, so `dismiss` takes the last such button; when every button reads affirmative there
/// is no decline to name and the command fails without a tap.
enum RunnerAlertButtonChoice {
  static func buttonIndex(for labels: [String], action: String) -> Int? {
    if action == "accept" {
      if let accept = labels.firstIndex(where: { isAcceptButton($0) }) {
        return accept
      }
      // A lone button is the only way out of the prompt, so accept takes it unless it declines.
      return labels.count == 1 && !isDismissButton(labels[0]) ? 0 : nil
    }
    if let decline = labels.firstIndex(where: { isDismissButton($0) }) {
      return decline
    }
    return labels.lastIndex { !isAcceptButton($0) }
  }

  static func isAcceptButton(_ label: String) -> Bool {
    let normalized = normalize(label)
    return [
      "ok",
      "allow",
      "yes",
      "continue",
      "done",
      "open",
      "open settings"
    ].contains(normalized) || normalized.hasPrefix("confirm")
  }

  static func isDismissButton(_ label: String) -> Bool {
    [
      "cancel",
      "close",
      "dismiss",
      "don't allow",
      "don’t allow",
      "not now",
      "no",
      "keep browsing",
      "later",
      "ask app not to track"
    ].contains(normalize(label))
  }

  private static func normalize(_ label: String) -> String {
    label.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  }
}
