import Foundation

/// Which of an alert's buttons an `accept` or `dismiss` activates, decided on the button labels
/// alone, so the rule is checkable without a screen.
///
/// `dismiss` activates only a button `isDismissButton` recognizes. Any label-based guess at an
/// unrecognized decline can only ever land on a button the accept rule does not recognize either
/// — iOS localizes the App Tracking Transparency prompt's "Allow", consent copy is open-ended,
/// and no list closes either set — and answering such a button while reporting `dismissed` is
/// exactly the failure #3627 reports. So an unrecognized decline is refused with
/// `ALERT_BUTTON_NOT_FOUND` and no tap rather than guessed at. Unknown wording stays reachable:
/// `alert get` shows the labels, and `snapshot` + `press @ref` names the button instead of
/// inferring it.
///
/// The one recognized decline outside the list is a dismiss-popup surface itself: its native
/// accessibility marker is the app's own declaration that the surface closes the popover, so
/// `popupMarkerSurface` lets `dismiss` take the last actionable element of that window, as
/// before the #3627 rule existed. A consent prompt can never carry that marker.
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
