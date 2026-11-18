import XCTest
import AgentDeviceSnapshotPresentation

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
extension RunnerTests {
  func testKeyboardStatusUsesTheLocalizedAXLabelWithTheObservedReturnIdentifier() {
    let viewport = CGRect(x: 0, y: 0, width: 951, height: 669)
    let keyboard = CGRect(x: 75, y: 449, width: 801, height: 219)
    let keys: [RunnerKeyboardStatus.ObservedKeyboardKey] = [
      .init(label: "A", identifier: "", frame: CGRect(x: 125, y: 501, width: 76, height: 52), isKey: true),
      .init(label: "Dyktuj", identifier: "dictation", frame: CGRect(x: 690, y: 609, width: 73, height: 51), isKey: false),
      .init(label: "szukaj", identifier: "Search", frame: CGRect(x: 763, y: 609, width: 111, height: 51), isKey: false),
    ]
    XCTAssertEqual(
      RunnerKeyboardStatus.observed(keyboardFrame: keyboard, keys: keys, viewport: .reported(box: viewport)),
      RunnerKeyboardStatus(visible: true, returnKey: "search", returnKeyLabel: "szukaj")
    )
  }

  func testKeyboardStatusIgnoresOffscreenKeysBelowAnAccessory() {
    let viewport = CGRect(x: 0, y: 0, width: 820, height: 1180)
    let bar = CGRect(x: 0, y: 1136, width: 820, height: 44)
    let keys: [RunnerKeyboardStatus.ObservedKeyboardKey] = [
      .init(label: "Done", identifier: "Done", frame: CGRect(x: 730, y: 1140, width: 66, height: 36), isKey: false),
      .init(label: "A", identifier: "", frame: CGRect(x: 112, y: 1251, width: 65, height: 63), isKey: true),
      .init(label: "return", identifier: "Return", frame: CGRect(x: 691, y: 1251, width: 126, height: 63), isKey: false),
    ]
    XCTAssertEqual(
      RunnerKeyboardStatus.observed(keyboardFrame: bar, keys: keys, viewport: .reported(box: viewport)),
      .hidden
    )
    XCTAssertNil(RunnerKeyboardStatus.observed(keyboardFrame: .zero, keys: keys, viewport: .reported(box: viewport)))
  }

  func testKeyboardStatusUsesTheVisibleFrameWhenNoKeysAreExposed() {
    XCTAssertEqual(
      RunnerKeyboardStatus.observed(
        keyboardFrame: CGRect(x: 0, y: 561, width: 393, height: 233),
        keys: [],
        viewport: .reported(box: CGRect(x: 0, y: 0, width: 393, height: 852))
      ),
      RunnerKeyboardStatus(visible: true, returnKey: "unknown", returnKeyLabel: nil)
    )
  }

  func testKeyboardStatusDoesNotTreatAnAccessoryOrNumericKeyAsReturn() {
    let viewport = CGRect(x: 0, y: 0, width: 393, height: 852)
    let keyboard = CGRect(x: 0, y: 531, width: 393, height: 263)
    let keys: [RunnerKeyboardStatus.ObservedKeyboardKey] = [
      .init(label: "Done", identifier: "Done", frame: CGRect(x: 300, y: 533, width: 80, height: 25), isKey: false),
      .init(label: "1", identifier: "", frame: CGRect(x: 0, y: 561, width: 131, height: 56), isKey: true),
      .init(label: "Delete", identifier: "delete", frame: CGRect(x: 262, y: 730, width: 131, height: 54), isKey: true),
    ]
    XCTAssertEqual(
      RunnerKeyboardStatus.observed(keyboardFrame: keyboard, keys: keys, viewport: .reported(box: viewport)),
      RunnerKeyboardStatus(visible: true, returnKey: "unknown", returnKeyLabel: nil)
    )
  }
}
#endif
