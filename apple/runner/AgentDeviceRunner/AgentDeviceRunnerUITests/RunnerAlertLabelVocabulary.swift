import Foundation

/// The device language's wording of the English alert labels `RunnerAlertButtonChoice` ranks.
///
/// Each translation resolves to the English labels it translates, so a localized prompt ranks
/// exactly like its English original. A translation that reads as an English label keeps its
/// English meaning, and one whose sources span both actions names no single role (#3627). Only a
/// source that is a whole button label counts, so a sentence that starts like one translates nothing.
struct RunnerAlertLabelVocabulary {
  static let english = RunnerAlertLabelVocabulary(translations: [])

  private let sources: [String: [String]]

  init(translations: [(english: String, localized: String)]) {
    var sources: [String: [String]] = [:]
    for translation in translations where RunnerAlertButtonChoice.action(of: translation.english, wholeLabel: true) != nil {
      sources[Self.normalized(translation.localized), default: []].append(translation.english)
    }
    self.sources = sources.filter { label, english in
      RunnerAlertButtonChoice.action(of: label) == nil
        && Set(english.compactMap { RunnerAlertButtonChoice.action(of: $0) }).count == 1
    }
  }

  func englishLabels(for label: String) -> [String] {
    sources[Self.normalized(label)] ?? []
  }

  private static func normalized(_ label: String) -> String {
    label.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  }
}

#if os(iOS) && targetEnvironment(simulator)
extension RunnerAlertLabelVocabulary {
  /// The device languages' vocabulary, read once from the OS strings. iOS words a prompt in the
  /// preferred language the app localizes into, so every preferred language takes part.
  static let system = fromSystemStrings(languages: Locale.preferredLanguages)

  /// Pairs each English prompt string with the same key's value in each of `languages`. Every
  /// permission table must read, or none counts: a missing table could hide the translation that
  /// makes a label in another table claim both actions. The launch confirmation's table only adds
  /// its own open and cancel labels, so without it the permission vocabulary stays whole.
  static func fromSystemStrings(languages: [String]) -> RunnerAlertLabelVocabulary {
    var tables: [RunnerSystemPromptStrings]
    switch RunnerSystemPromptStrings.read(RunnerSystemPromptStrings.promptTables, languages: languages) {
    case .failure(let failure):
      RunnerSystemPromptStrings.logUnavailable(failure, subsystem: "alert-vocabulary", languages: languages)
      return .english
    case .success(let read):
      tables = read
    }
    switch RunnerSystemPromptStrings.read([RunnerSystemPromptStrings.launchConfirmationTable], languages: languages) {
    case .failure(let failure):
      RunnerSystemPromptStrings.logUnavailable(failure, subsystem: "alert-vocabulary-launch-confirmation", languages: languages)
    case .success(let read):
      tables += read
    }
    var translations: [(english: String, localized: String)] = []
    for table in tables {
      for strings in table.localized.values {
        for (key, value) in table.english {
          if let translation = strings[key] { translations.append((english: value, localized: translation)) }
        }
      }
    }
    return RunnerAlertLabelVocabulary(translations: translations)
  }
}
#else
extension RunnerAlertLabelVocabulary {
  static let system = english
}
#endif
