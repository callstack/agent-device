import Foundation
import CoreGraphics

/// One `keyboard status` answer: whether the software keyboard is on screen and, when it is, what
/// its return key offers.
///
/// `returnKey` is a `RunnerKeyboardReturnKey` raw value, or `nil` when the keyboard is hidden — a
/// hidden keyboard has no return key to report, which is a different fact from one this read cannot
/// name. `returnKeyLabel` is the wording the return key itself carries, with surrounding whitespace
/// trimmed, so a localized or an app's custom key stays readable even where the kind is `unknown`.
/// It is present only for a control this read identified as the return key: a keyboard whose return
/// key cannot be identified — a number or phone pad has none — answers `unknown` with no label, so a
/// caller is never told a key exists on a layout that has no key to press.
struct RunnerKeyboardStatus: Equatable {
  let visible: Bool
  let returnKey: String?
  let returnKeyLabel: String?
}

extension RunnerKeyboardStatus {
  /// One control the status read observed on the visible keyboard: the wording it carries in the
  /// accessibility tree, and the frame it occupies. `frame` is what locates the return key by slot —
  /// the space bar's immediate right neighbour, when that neighbour is also its row's last worded key.
  struct ObservedKeyboardKey {
    let text: String?
    let frame: CGRect
  }

  /// What identifies Apple's space bar in the accessibility tree: wording that is whitespace and
  /// nothing else. This read measured a single space on an English and a Polish iOS layout, so the
  /// anchor survives the localization the positional rule exists for. A pad's keys all carry digit or
  /// `Delete` wording, so a pad has no anchor, and therefore no candidate.
  private static func isSpaceBar(_ text: String?) -> Bool {
    guard let text, !text.isEmpty else { return false }
    return text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  /// Builds the answer from what the runner observed. The keyboard decides whether a return key is
  /// reported at all: a hidden one has none, which is a different fact from one this read cannot
  /// name. Only Android's `IME_ACTION_NONE` can establish that a field offers no action key, so
  /// `none` is never this runner's answer.
  ///
  /// The key's own wording decides the kind, through the one rule `keyboard enter` probes with
  /// (`RunnerKeyboardReturnKey.kind(of:)`), so the two commands can never disagree about the same
  /// key. The label itself is kept as the accessibility tree carries it apart from its surrounding
  /// whitespace, so a localized or an app's custom key stays readable even where the kind is
  /// `unknown`.
  static func observed(
    visible: Bool,
    returnControlText: String?
  ) -> RunnerKeyboardStatus {
    guard visible else {
      return RunnerKeyboardStatus(visible: false, returnKey: nil, returnKeyLabel: nil)
    }
    guard let returnControlText else {
      return RunnerKeyboardStatus(
        visible: true,
        returnKey: RunnerKeyboardReturnKey.unknown.rawValue,
        returnKeyLabel: nil
      )
    }
    let label = returnControlText.trimmingCharacters(in: .whitespacesAndNewlines)
    return RunnerKeyboardStatus(
      visible: true,
      returnKey: RunnerKeyboardReturnKey.kind(of: label).rawValue,
      returnKeyLabel: label.isEmpty ? nil : label
    )
  }

  /// Builds the answer from every control the read saw on the visible keyboard, so it does not need to
  /// read English to find the return key. A control whose wording `kind(of:)` names a kind for is the
  /// return key on any keyboard in any language, and its wording is the label. When none maps — a fully
  /// localized keyboard — the return key is the control in the slot Apple's keyboards give it: the
  /// keyboard's `returnKeySlot`, the space bar's immediate right neighbour where that neighbour is also
  /// its row's trailing worded control.
  ///
  /// The slot is anchored on the space bar rather than on the keyboard's bottom-right corner because
  /// the corner is not the return key on every layout: a number, decimal or phone pad has no space bar
  /// and puts Delete in that corner, so reporting the corner would tell a caller an OTP field has a
  /// return key. The trailing half of the test is what keeps the rule off iPadOS, whose bottom row puts
  /// a numbers key and then a hide-keyboard key right of the space bar while its return key ends the row
  /// above. Neither case reports a key.
  ///
  /// `returnKeyLabel` therefore comes only from a control this read identified as the return key. A
  /// visible keyboard with no identifiable return control answers `unknown` with no label, which is the
  /// honest reading of a pad that has no return key at all, and of a layout this rule does not know.
  static func observed(
    visible: Bool,
    keyboardKeys: [ObservedKeyboardKey]
  ) -> RunnerKeyboardStatus {
    guard visible else {
      return RunnerKeyboardStatus(visible: false, returnKey: nil, returnKeyLabel: nil)
    }
    return observed(visible: true, returnControlText: returnControl(in: keyboardKeys)?.text)
  }

  /// The one decision that a control is the visible keyboard's return key, by wording first and by
  /// slot otherwise (see `observed(visible:keyboardKeys:)`). `keyboard status` reports it and
  /// `keyboard dismiss` refuses to press it, so the two commands cannot disagree about which key is
  /// the return key.
  ///
  /// A control that sits wholly above the first row of character keys is an input accessory toolbar's
  /// button, such as its `Next` or `Done`, and is never the return key even when the keyboard
  /// exposes it beside the keys.
  static func returnControl(in keys: [ObservedKeyboardKey]) -> ObservedKeyboardKey? {
    let worded = keys.filter { key in
      !(key.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
    let firstKeyRowTop = worded
      .filter { $0.text?.trimmingCharacters(in: .whitespacesAndNewlines).count == 1 && !$0.frame.isEmpty }
      .map { $0.frame.minY }
      .min()
    let named = worded.first { key in
      RunnerKeyboardReturnKey.kind(of: key.text ?? "") != .unknown
        && (firstKeyRowTop.map { key.frame.isEmpty || key.frame.maxY > $0 } ?? true)
    }
    return named ?? returnKeySlot(in: keys)
  }

  /// True when `frame` is the frame of the return key among `keys`. A control with no usable frame
  /// cannot be told apart from another control, so it is never the return key here.
  static func isReturnControl(frame: CGRect, in keys: [ObservedKeyboardKey]) -> Bool {
    guard !frame.isEmpty, let returnControl = returnControl(in: keys), !returnControl.frame.isEmpty else {
      return false
    }
    let tolerance = returnKeySlotTolerance
    return abs(frame.minX - returnControl.frame.minX) <= tolerance
      && abs(frame.minY - returnControl.frame.minY) <= tolerance
      && abs(frame.maxX - returnControl.frame.maxX) <= tolerance
      && abs(frame.maxY - returnControl.frame.maxY) <= tolerance
  }

  /// The worded control in the return key's slot, or `nil` when the keyboard exposes no space bar to
  /// anchor the slot on, or when the space bar's right neighbour is not also its row's trailing worded
  /// control. One positional test, both halves, and no wording list: see `observed(visible:keyboardKeys:)`
  /// for why the anchor is the space bar, and why a neighbour that is not its row's trailing key cannot
  /// be the return key.
  private static func returnKeySlot(in keys: [ObservedKeyboardKey]) -> ObservedKeyboardKey? {
    // The space bar is the widest key on Apple's keyboards by several times any other, so taking the
    // widest whitespace-worded control cannot mistake a padding or divider element for it.
    guard let spaceBar = keys
      .filter({ isSpaceBar($0.text) && !$0.frame.isEmpty })
      .max(by: { $0.frame.width < $1.frame.width })
    else {
      return nil
    }
    let spaceEdge = spaceBar.frame.maxX
    let spaceMidY = spaceBar.frame.midY
    // Worded, measurable controls in the space bar's row, at or right of its right edge. The tolerance
    // absorbs the fractions of a point a layout may round away between keys that sit edge to edge. The
    // space bar is never among them: its wording is whitespace, which no return key's wording ever is.
    let rightOfSpaceBar = keys.filter { key in
      !key.frame.isEmpty
        && !(key.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        && key.frame.minY <= spaceMidY
        && key.frame.maxY >= spaceMidY
        && key.frame.minX >= spaceEdge - returnKeySlotTolerance
    }
    // Both halves of the one rule: the nearest such control, and the last of them, must be the same key.
    let ordered = rightOfSpaceBar.sorted { ($0.frame.minX, $0.frame.maxX) < ($1.frame.minX, $1.frame.maxX) }
    guard let first = ordered.first, let last = ordered.last, first.frame == last.frame else {
      return nil
    }
    return first
  }

  /// Keys sit edge to edge, so the slot's left edge is the space bar's right edge; this absorbs the
  /// fractions of a point a keyboard's layout may round away.
  private static let returnKeySlotTolerance: CGFloat = 2
}
