import XCTest

// What a replacement's read-back can prove when the field's value does not echo the typed text.
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

  /// Whether `observed` can be a degraded copy of the residual `baseline` plus the request: it is in
  /// order inside baseline + request (dropped characters), or it contains the request in order and
  /// the baseline did not already (residual text), or it contains baseline + request in order. A
  /// value related to the entry in none of these ways, such as an OTP field announcing
  /// "6 of 6 digits", is the app's own representation, so retyping cannot make it match.
  static func textEntryValueEchoes(observed: String, expected: String, baseline: String) -> Bool {
    let request = textEntryRequestWithoutSubmitKeys(expected)
    let residualAndRequest = baseline + request
    return isOrderedSubsequence(observed, of: residualAndRequest)
      || (isOrderedSubsequence(request, of: observed) && !isOrderedSubsequence(request, of: baseline))
      || isOrderedSubsequence(residualAndRequest, of: observed)
  }

  /// Classifies a replacement whose read-back never matched. The entry is unconfirmed, not failed,
  /// only when the same element's value moved off its pre-entry baseline to one that does not echo
  /// the request; every other mismatch stays a failure.
  static func unconfirmedTextEntryEvidence(
    requested: String,
    baseline: TextEntryObservation?,
    observed: TextEntryObservation?
  ) -> TextEntryUnconfirmedEvidence? {
    guard !textEntryRequestWithoutSubmitKeys(requested).isEmpty,
          let baseline,
          let observed,
          baseline.identity.isSameElement(as: observed.identity),
          observed.value != baseline.value,
          !textEntryValueEchoes(observed: observed.value, expected: requested, baseline: baseline.value)
    else {
      return nil
    }
    return TextEntryUnconfirmedEvidence(
      requested: requested,
      before: baseline.value,
      after: observed.value,
      target: observed.identity
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
