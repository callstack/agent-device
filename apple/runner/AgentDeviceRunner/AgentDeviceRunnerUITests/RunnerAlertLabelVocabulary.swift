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

  /// The string tables that word the system permission prompts: notifications, privacy access
  /// (including App Tracking Transparency), and location.
  private static let promptStringTables = [
    ("/System/Library/PrivateFrameworks/UserNotificationsServer.framework", "Localizable"),
    ("/System/Library/PrivateFrameworks/TCC.framework", "Localizable"),
    ("/System/Library/Frameworks/CoreLocation.framework", "locationd")
  ]

  /// Pairs each English prompt string with the same key's value in each of `languages`. Every
  /// table must read, or none counts: a missing table could hide the translation that makes a
  /// label in another table claim both actions.
  static func fromSystemStrings(languages: [String]) -> RunnerAlertLabelVocabulary {
    // The simulated OS, taken from where this process's Foundation loaded; the simulator process
    // would otherwise read the host's /System.
    let foundationPath = "/System/Library/Frameworks/Foundation.framework"
    guard let foundation = Bundle(identifier: "com.apple.Foundation")?.bundlePath, foundation.hasSuffix(foundationPath)
    else { return unavailable(source: foundationPath, languages: languages) }
    let root = String(foundation.dropLast(foundationPath.count))
    var translations: [(english: String, localized: String)] = []
    for (path, table) in promptStringTables {
      guard let bundle = Bundle(path: root + path),
        let english = strings(in: bundle, table: table, localization: "en")
      else { return unavailable(source: path, languages: languages) }
      let localizations = Set(languages.compactMap {
        Bundle.preferredLocalizations(from: bundle.localizations, forPreferences: [$0]).first
      }).subtracting(["en"])
      for localization in localizations {
        guard let localized = strings(in: bundle, table: table, localization: localization)
        else { return unavailable(source: "\(path) \(localization)", languages: languages) }
        for (key, value) in english {
          if let translation = localized[key] { translations.append((english: value, localized: translation)) }
        }
      }
    }
    return RunnerAlertLabelVocabulary(translations: translations)
  }

  private static func unavailable(source: String, languages: [String]) -> RunnerAlertLabelVocabulary {
    NSLog(
      "AGENT_DEVICE_RUNNER_ALERT_VOCABULARY_UNAVAILABLE source=%@ languages=%@",
      source, languages.joined(separator: ",")
    )
    return .english
  }

  private static func strings(in bundle: Bundle, table: String, localization: String) -> [String: String]? {
    guard let url = bundle.url(forResource: table, withExtension: "strings", subdirectory: nil, localization: localization)
    else { return nil }
    return NSDictionary(contentsOf: url) as? [String: String]
  }
}
#else
extension RunnerAlertLabelVocabulary {
  static let system = english
}
#endif
