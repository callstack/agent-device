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

  private let wordings: [(title: NSRegularExpression, open: String, cancel: String)]

  init(wordings: [Wording]) {
    self.wordings = wordings.compactMap { wording in
      let pattern = NSRegularExpression.escapedPattern(for: wording.titleFormat)
        .replacingOccurrences(of: "%@", with: ".+")
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
      RunnerSystemPromptStrings.logUnavailable(failure, languages: languages)
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
