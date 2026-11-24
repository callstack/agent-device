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
  /// The rows as they were handed in, before the initializer's guards: what the table (or the OS
  /// read) actually claims, for tests that compare the vocabulary against its own sources.
  let rows: [(english: String, localized: String)]

  init(translations: [(english: String, localized: String)]) {
    self.rows = translations
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

extension RunnerAlertLabelVocabulary {
  /// The system prompts' buttons in the languages the built-in table covers, for the devices
  /// whose OS string files the runner process cannot read. A simulated OS reads its own strings
  /// instead, so this table is the only vocabulary a physical device has.
  static let device = RunnerAlertLabelVocabulary(translations: deviceTranslations)

  /// The built-in translations behind `device`. Each entry pairs the system prompt's English
  /// button label with one language's wording of it, so the localized label ranks exactly like
  /// the English original; the initializer's guards (#3627) drop an entry that would claim both
  /// actions. A row's wording needs device evidence, so the table grows only with a label a
  /// device really shows.
  static let deviceTranslations: [(english: String, localized: String)] = [
    // Notification and privacy prompts.
    ("Allow", "允许"),
    ("Don’t Allow", "不允许"),
    // App Tracking Transparency.
    ("Ask App Not to Track", "要求App不追踪"),
    // Location.
    ("Allow While Using App", "使用App时允许"),
    ("Allow Once", "允许一次"),
    // General-purpose prompt buttons.
    ("OK", "好"),
    ("Cancel", "取消"),
    // SpringBoard's launch confirmation.
    ("Open", "打开")
  ]
}

#if os(iOS) && targetEnvironment(simulator)
extension RunnerAlertLabelVocabulary {
  /// The device languages' vocabulary, read once from the OS strings. iOS words a prompt in the
  /// preferred language the app localizes into, so every preferred language takes part.
  static let system = fromSystemStrings(languages: Locale.preferredLanguages)

  /// Pairs each English prompt string with the same key's value in each of `languages`.
  static func fromSystemStrings(languages: [String]) -> RunnerAlertLabelVocabulary {
    composed(
      permission: RunnerSystemPromptStrings.read(RunnerSystemPromptStrings.promptTables, languages: languages),
      launchConfirmation: RunnerSystemPromptStrings.read([RunnerSystemPromptStrings.launchConfirmationTable], languages: languages),
      languages: languages
    )
  }

  /// Every permission table must read, or none of them counts: a missing table could hide the
  /// translation that makes a label in another table claim both actions. The launch confirmation's
  /// table is independent of them. Only its open and cancel labels are taken, so they stay when the
  /// permission read fails, and the permission vocabulary stays whole when that table is missing.
  static func composed(
    permission: Result<[RunnerSystemPromptStrings], RunnerSystemPromptStrings.UnavailableSource>,
    launchConfirmation: Result<[RunnerSystemPromptStrings], RunnerSystemPromptStrings.UnavailableSource>,
    languages: [String]
  ) -> RunnerAlertLabelVocabulary {
    var tables: [RunnerSystemPromptStrings] = []
    switch permission {
    case .failure(let failure):
      RunnerSystemPromptStrings.logUnavailable(failure, subsystem: "alert-vocabulary", languages: languages)
    case .success(let read):
      tables = read
    }
    switch launchConfirmation {
    case .failure(let failure):
      RunnerSystemPromptStrings.logUnavailable(failure, subsystem: "alert-vocabulary-launch-confirmation", languages: languages)
    case .success(let read):
      tables += read.map { $0.limited(to: RunnerSystemPromptStrings.launchConfirmationLabelKeys) }
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
  /// A device keeps its OS string files from the runner process, so its vocabulary is the
  /// built-in table.
  static let system = device
}
#endif
