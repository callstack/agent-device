import Foundation

/// Which of an alert's buttons an `accept` or `dismiss` activates, decided on the button labels
/// alone, so the rule is checkable without a screen.
///
/// `dismiss` activates only a label `isDismissButton` recognizes. An unknown decline cannot be
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
  static func buttonIndex(for labels: [String], action: String, popupMarkerSurface: Bool = false) -> Int? {
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
    return popupMarkerSurface ? labels.indices.last : nil
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
