import Foundation

/// SpringBoard's `Open in “<App>”?` launch confirmation, recognized by the OS's own wording of its
/// title and its two buttons. A prompt counts only when both buttons are exactly the open and
/// cancel labels of one language, so an app alert that happens to start the same way is not it.
struct RunnerLaunchConfirmationPrompt {
  /// One language's wording, as SpringBoard's `SchemeApproval` strings give it.
  struct Wording {
    let titleFormat: String
    let open: String
    let cancel: String
  }

  static let unavailable = RunnerLaunchConfirmationPrompt(wordings: [])

  private static let appNamePlaceholder = try? NSRegularExpression(pattern: "%(?:\\d+\\$)?(?:\\[[^\\]]*\\])?@")

  private let wordings: [(title: NSRegularExpression, open: String, cancel: String)]

  /// A wording whose title format has no app-name placeholder is skipped, because its pattern would
  /// match a title with no app name. A placeholder is `%@`, a positional `%1$@`, or Apple's
  /// bracketed object format `%[tt]@`, as Finnish words it.
  init(wordings: [Wording]) {
    guard let placeholder = Self.appNamePlaceholder else {
      self.wordings = []
      return
    }
    self.wordings = wordings.compactMap { wording in
      let format = wording.titleFormat as NSString
      let slots = placeholder.matches(in: wording.titleFormat, range: NSRange(location: 0, length: format.length))
      guard !slots.isEmpty else { return nil }
      var pattern = ""
      var from = 0
      for slot in slots {
        pattern += NSRegularExpression.escapedPattern(for: format.substring(with: NSRange(location: from, length: slot.range.location - from)))
        pattern += ".+"
        from = slot.range.location + slot.range.length
      }
      pattern += NSRegularExpression.escapedPattern(for: format.substring(from: from))
      guard let title = try? NSRegularExpression(pattern: "^\(pattern)$") else { return nil }
      return (title, Self.normalized(wording.open), Self.normalized(wording.cancel))
    }
  }

  func recognizes(title: String, buttons: [String]) -> Bool {
    let title = title.trimmingCharacters(in: .whitespacesAndNewlines)
    let titleRange = NSRange(title.startIndex..., in: title)
    let labels = buttons.map(Self.normalized)
    guard labels.count == 2 else { return false }
    return wordings.contains { wording in
      wording.title.firstMatch(in: title, range: titleRange) != nil
        && Set(labels) == [wording.open, wording.cancel]
    }
  }

  private static func normalized(_ label: String) -> String {
    label.trimmingCharacters(in: .whitespacesAndNewlines)
  }
}

#if os(iOS) && targetEnvironment(simulator)
extension RunnerLaunchConfirmationPrompt {
  /// English and every preferred language, read once from the OS strings. Unreadable strings
  /// recognize nothing, so the prompt stays an unrecognized alert.
  static let system = fromSystemStrings(languages: Locale.preferredLanguages)

  static func fromSystemStrings(languages: [String]) -> RunnerLaunchConfirmationPrompt {
    switch RunnerSystemPromptStrings.read([RunnerSystemPromptStrings.launchConfirmationTable], languages: languages) {
    case .failure(let failure):
      RunnerSystemPromptStrings.logUnavailable(failure, subsystem: "launch-confirmation", languages: languages)
      return .unavailable
    case .success(let tables):
      guard let table = tables.first else { return .unavailable }
      let wordings = ([table.english] + table.localized.values).compactMap { strings -> Wording? in
        guard let title = strings["SCHEME_APPROVAL_PROMPT_TITLE_NO_SOURCE"],
          let open = strings["SCHEME_APPROVAL_OPEN_BUTTON"],
          let cancel = strings["SCHEME_APPROVAL_DO_NOT_OPEN_BUTTON"]
        else { return nil }
        return Wording(titleFormat: title, open: open, cancel: cancel)
      }
      return RunnerLaunchConfirmationPrompt(wordings: wordings)
    }
  }
}
#else
extension RunnerLaunchConfirmationPrompt {
  static let system = unavailable
}
#endif
