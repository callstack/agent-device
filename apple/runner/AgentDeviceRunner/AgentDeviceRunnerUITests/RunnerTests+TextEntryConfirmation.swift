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
    // A submit may consume or clear a single-line input; repeating it can send the action twice.
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
