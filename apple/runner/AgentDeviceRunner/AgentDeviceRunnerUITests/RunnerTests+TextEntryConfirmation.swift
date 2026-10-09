import XCTest

// Target-bound observations and the replacement read-back policy.
// The wire shape mirrors the cross-platform `FillUnconfirmedVerification` in
// packages/contracts/src/fill-evidence.ts.
extension RunnerTests {
  /// The element a replacement typed into, named the way the shared fill evidence names a target.
  struct TextEntryElementIdentity: Equatable {
    let identifier: String?
    let elementType: String
    let frame: CGRect

    /// Same element across the entry: a stable accessibility identifier when either side has one,
    /// otherwise the same element type at the same frame.
    func isSameElement(as other: TextEntryElementIdentity) -> Bool {
      if identifier != nil || other.identifier != nil {
        return identifier == other.identifier
      }
      return elementType == other.elementType && frame == other.frame
    }
  }

  /// A field's readable value and identity, sampled once.
  struct TextEntryObservation: Equatable {
    let value: String
    let identity: TextEntryElementIdentity

    /// Same value on the same element; a frame change alone on an identified field is not a change.
    func isSettled(with other: TextEntryObservation) -> Bool {
      value == other.value && identity.isSameElement(as: other.identity)
    }
  }

  /// Target-bound evidence that the entry changed the field while its value cannot confirm the text.
  struct TextEntryUnconfirmedEvidence: Equatable {
    let requested: String
    let before: String
    let after: String
    let target: TextEntryElementIdentity
  }

  struct ReplacementTextEntryConfirmation {
    private let requested: String
    private let baseline: TextEntryObservation?
    private var deadline: Date
    private var latest: TextEntryObservation?
    private var stableSince: Date

    init(requested: String, baseline: TextEntryObservation?, startedAt: Date) {
      self.requested = requested
      self.baseline = baseline
      deadline = startedAt.addingTimeInterval(TextEntryTiming.replacementSettleCeiling)
      stableSince = startedAt
    }

    mutating func observe(_ observed: TextEntryObservation, at sampledAt: Date) -> TextEntryResult? {
      // A late first read still needs one stability window.
      if latest == nil {
        deadline = max(deadline, sampledAt.addingTimeInterval(TextEntryTiming.verificationStabilityWindow))
      }
      if latest.map({ observed.isSettled(with: $0) }) != true { stableSince = sampledAt }
      latest = observed
      let result = RunnerTests.replacementTextEntryResult(requested: requested, baseline: baseline, observed: observed)
      let settled = sampledAt.timeIntervalSince(stableSince) >= TextEntryTiming.verificationStabilityWindow
      let moved = baseline.map { !observed.isSettled(with: $0) } ?? true
      if settled && (moved || result.verified != false || sampledAt >= deadline) {
        return result
      }
      if sampledAt >= deadline {
        return TextEntryResult(
          verified: nil, repaired: false, expectedText: requested, observedText: observed.value,
          failure: .commitNotObserved
        )
      }
      return nil
    }
  }

  /// Literal read-back policy; a mismatch does not establish why the app changed the text.
  static func replacementTextEntryResult(
    requested: String,
    baseline: TextEntryObservation?,
    observed: TextEntryObservation?
  ) -> TextEntryResult {
    func result(_ verified: Bool?) -> TextEntryResult {
      TextEntryResult(verified: verified, repaired: false, expectedText: requested, observedText: observed?.value)
    }
    guard let observed else { return result(nil) }
    if let baseline, !baseline.identity.isSameElement(as: observed.identity) {
      return result(false)
    }
    let request = observed.identity.elementType == elementTypeNamesByRawValue[XCUIElement.ElementType.textView.rawValue]
      ? requested : textEntryRequestWithoutSubmitKeys(requested)
    if observed.value == requested || observed.value == request { return result(true) }
    // Any non-matching single-line submit result remains unverified, even a partial value.
    if request != requested { return result(nil) }
    guard !request.isEmpty, let baseline else { return result(false) }
    if isOrderedSubsequence(observed.value, of: baseline.value + request) { return result(false) }
    return TextEntryResult(
      verified: nil,
      repaired: false,
      expectedText: requested,
      observedText: observed.value,
      unconfirmed: TextEntryUnconfirmedEvidence(
        requested: requested,
        before: baseline.value,
        after: observed.value,
        target: observed.identity
      )
    )
  }

  /// Samples the element's readable value with its identity in one accessibility query; nil when
  /// the element is gone or its value is unreadable (secure fields).
  func textEntryObservation(for element: XCUIElement?) -> TextEntryObservation? {
    guard let element,
          let snapshot = try? element.snapshot(),
          let value = editableTextValue(for: snapshot, treatingPlaceholderAsEmpty: true)
    else {
      return nil
    }
    return TextEntryObservation(
      value: value,
      identity: TextEntryElementIdentity(
        identifier: snapshot.identifier.isEmpty ? nil : snapshot.identifier,
        elementType: elementTypeName(snapshot.elementType),
        frame: snapshot.frame
      )
    )
  }

  /// The text a request leaves in the field once trailing submit keys are pressed rather than typed.
  static func textEntryRequestWithoutSubmitKeys(_ text: String) -> String {
    var request = text
    while request.hasSuffix("\n") || request.hasSuffix("\r") {
      request.removeLast()
    }
    return request
  }

  /// Whether every character of `candidate` appears in `text` in the same order.
  static func isOrderedSubsequence(_ candidate: String, of text: String) -> Bool {
    var remaining = text[...]
    for character in candidate {
      guard let match = remaining.firstIndex(of: character) else {
        return false
      }
      remaining = remaining[remaining.index(after: match)...]
    }
    return true
  }
}
