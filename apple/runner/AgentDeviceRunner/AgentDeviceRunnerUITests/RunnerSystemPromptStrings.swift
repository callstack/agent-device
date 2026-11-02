import Foundation

#if os(iOS) && targetEnvironment(simulator)
/// One OS string table read in English and in each preferred language that is not English.
struct RunnerSystemPromptStrings {
  let english: [String: String]
  /// The table's strings by localization, English excluded.
  let localized: [String: [String: String]]

  /// The string tables that word the system permission prompts: notifications, privacy access
  /// (including App Tracking Transparency), and location.
  static let promptTables = [
    (path: "/System/Library/PrivateFrameworks/UserNotificationsServer.framework", table: "Localizable"),
    (path: "/System/Library/PrivateFrameworks/TCC.framework", table: "Localizable"),
    (path: "/System/Library/Frameworks/CoreLocation.framework", table: "locationd")
  ]

  /// SpringBoard's launch confirmation. It is read apart from `promptTables`, so a runtime without
  /// it keeps the permission prompts' vocabulary.
  /// The only keys of that table the alert vocabulary takes, so another key of an undocumented
  /// table cannot join the accept or dismiss labels.
  static let launchConfirmationLabelKeys: Set<String> = ["SCHEME_APPROVAL_OPEN_BUTTON", "SCHEME_APPROVAL_DO_NOT_OPEN_BUTTON"]

  static let launchConfirmationTable = (
    path: "/System/Library/Frameworks/CoreServices.framework",
    table: "SchemeApproval"
  )

  /// Reads `tables` from the simulated OS, or names the source that did not read. The simulated OS
  /// is taken from where this process's Foundation loaded; the simulator process would otherwise
  /// read the host's /System. A table reads in every preferred language or not at all, because a
  /// missing translation could hide the one that makes a label claim both actions.
  static func read(
    _ tables: [(path: String, table: String)],
    languages: [String]
  ) -> Result<[RunnerSystemPromptStrings], UnavailableSource> {
    let foundationPath = "/System/Library/Frameworks/Foundation.framework"
    guard let foundation = Bundle(identifier: "com.apple.Foundation")?.bundlePath, foundation.hasSuffix(foundationPath)
    else { return .failure(UnavailableSource(source: foundationPath)) }
    let root = String(foundation.dropLast(foundationPath.count))
    var read: [RunnerSystemPromptStrings] = []
    for (path, table) in tables {
      guard let bundle = Bundle(path: root + path), let english = strings(in: bundle, table: table, localization: "en")
      else { return .failure(UnavailableSource(source: path)) }
      let localizations = Set(languages.compactMap {
        Bundle.preferredLocalizations(from: bundle.localizations, forPreferences: [$0]).first
      }).subtracting(["en"])
      var localized: [String: [String: String]] = [:]
      for localization in localizations {
        guard let strings = strings(in: bundle, table: table, localization: localization)
        else { return .failure(UnavailableSource(source: "\(path) \(localization)")) }
        localized[localization] = strings
      }
      read.append(RunnerSystemPromptStrings(english: english, localized: localized))
    }
    return .success(read)
  }

  /// This table restricted to `keys`.
  func limited(to keys: Set<String>) -> RunnerSystemPromptStrings {
    RunnerSystemPromptStrings(
      english: english.filter { keys.contains($0.key) },
      localized: localized.mapValues { $0.filter { keys.contains($0.key) } }
    )
  }

  struct UnavailableSource: Error {
    let source: String
  }

  static func logUnavailable(_ failure: UnavailableSource, subsystem: String, languages: [String]) {
    NSLog(
      "AGENT_DEVICE_RUNNER_SYSTEM_PROMPT_STRINGS_UNAVAILABLE subsystem=%@ source=%@ languages=%@",
      subsystem, failure.source, languages.joined(separator: ",")
    )
  }

  private static func strings(in bundle: Bundle, table: String, localization: String) -> [String: String]? {
    guard let url = bundle.url(forResource: table, withExtension: "strings", subdirectory: nil, localization: localization)
    else { return nil }
    return NSDictionary(contentsOf: url) as? [String: String]
  }
}
#endif
