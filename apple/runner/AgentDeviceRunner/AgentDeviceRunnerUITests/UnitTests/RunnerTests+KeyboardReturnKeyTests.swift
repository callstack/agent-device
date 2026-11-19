import XCTest
import AgentDeviceSnapshotPresentation

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
extension RunnerTests {
  func testKeyboardDismissRefusalNamesKeyboardEnterOnlyWhereReturnEndsTheEdit() {
    let search = keyboardDismissRefusal(returnKey: .search)
    XCTAssertEqual(search.code, RunnerWireErrorCode.keyboardDismissUnavailable)
    XCTAssertTrue(search.hint?.hasPrefix("To submit this search, run keyboard enter.") == true)
    XCTAssertTrue(keyboardDismissRefusal(returnKey: .send).hint?.contains("run it only to send") == true)
    for key: RunnerKeyboardReturnKey? in [nil, .unknown, .enter, .next] {
      XCTAssertFalse(keyboardDismissRefusal(returnKey: key).hint?.contains("keyboard enter") == true)
    }
  }

  func testKeyboardStatusRequiresMeasuredDisplayBounds() {
    let keyboard = CGRect(x: 0, y: 925, width: 834, height: 282)
    XCTAssertNil(RunnerKeyboardStatus.observed(
      keyboardFrame: keyboard, keys: [], nativeDisplaySize: nil,
      interfaceOrientation: RunnerInterfaceOrientation.portrait
    ))
    XCTAssertNil(RunnerKeyboardStatus.observed(
      keyboardFrame: keyboard, keys: [], nativeDisplaySize: CGSize(width: 834, height: 1210),
      interfaceOrientation: RunnerInterfaceOrientation.unknown
    ))
  }

  func testKeyboardStatusUsesTheLocalizedAXLabelWithTheObservedReturnIdentifier() {
    let display = CGSize(width: 669, height: 951)
    let keyboard = CGRect(x: 75, y: 449, width: 801, height: 219)
    let keys: [RunnerKeyboardStatus.ObservedKeyboardKey] = [
      .init(label: "A", identifier: "", frame: CGRect(x: 125, y: 501, width: 76, height: 52), isKey: true),
      .init(label: "Dyktuj", identifier: "dictation", frame: CGRect(x: 690, y: 609, width: 73, height: 51), isKey: false),
      .init(label: "szukaj", identifier: "Search", frame: CGRect(x: 763, y: 609, width: 111, height: 51), isKey: false),
    ]
    XCTAssertEqual(
      RunnerKeyboardStatus.observed(keyboardFrame: keyboard, keys: keys, nativeDisplaySize: display, interfaceOrientation: RunnerInterfaceOrientation.landscapeLeft),
      RunnerKeyboardStatus(visible: true, returnKey: "search", returnKeyLabel: "szukaj")
    )
  }

  func testKeyboardStatusOmitsReturnMetadataForALabelOnlySearchKey() {
    let keyboard = CGRect(x: 0, y: 449, width: 393, height: 219)
    let keys: [RunnerKeyboardStatus.ObservedKeyboardKey] = [
      .init(label: "A", identifier: "", frame: CGRect(x: 15, y: 501, width: 36, height: 52), isKey: true),
      .init(label: "Search", identifier: "", frame: CGRect(x: 282, y: 609, width: 110, height: 51), isKey: false),
    ]
    XCTAssertEqual(
      RunnerKeyboardStatus.observed(keyboardFrame: keyboard, keys: keys,
        nativeDisplaySize: CGSize(width: 393, height: 852),
        interfaceOrientation: RunnerInterfaceOrientation.portrait),
      RunnerKeyboardStatus(visible: true, returnKey: "unknown", returnKeyLabel: nil)
    )
  }

  func testKeyboardStatusIgnoresOffscreenKeysBelowAnAccessory() {
    let display = CGSize(width: 820, height: 1180)
    let bar = CGRect(x: 0, y: 1136, width: 820, height: 44)
    let keys: [RunnerKeyboardStatus.ObservedKeyboardKey] = [
      .init(label: "Done", identifier: "Done", frame: CGRect(x: 730, y: 1140, width: 66, height: 36), isKey: false),
      .init(label: "A", identifier: "", frame: CGRect(x: 112, y: 1251, width: 65, height: 63), isKey: true),
      .init(label: "return", identifier: "Return", frame: CGRect(x: 691, y: 1251, width: 126, height: 63), isKey: false),
    ]
    XCTAssertEqual(
      RunnerKeyboardStatus.observed(keyboardFrame: bar, keys: keys, nativeDisplaySize: display, interfaceOrientation: RunnerInterfaceOrientation.portrait),
      .hidden
    )
    XCTAssertNil(RunnerKeyboardStatus.observed(keyboardFrame: .zero, keys: keys, nativeDisplaySize: display, interfaceOrientation: RunnerInterfaceOrientation.portrait))
  }

  func testKeyboardStatusUsesTheVisibleFrameWhenNoKeysAreExposed() {
    XCTAssertEqual(
      RunnerKeyboardStatus.observed(
        keyboardFrame: CGRect(x: 0, y: 561, width: 393, height: 233),
        keys: [],
        nativeDisplaySize: CGSize(width: 393, height: 852),
        interfaceOrientation: RunnerInterfaceOrientation.portrait
      ),
      RunnerKeyboardStatus(visible: true, returnKey: "unknown", returnKeyLabel: nil)
    )
  }

  func testKeyboardStatusDoesNotTreatAnAccessoryOrNumericKeyAsReturn() {
    let display = CGSize(width: 393, height: 852)
    let keyboard = CGRect(x: 0, y: 531, width: 393, height: 263)
    let keys: [RunnerKeyboardStatus.ObservedKeyboardKey] = [
      .init(label: "Done", identifier: "Done", frame: CGRect(x: 300, y: 533, width: 80, height: 25), isKey: false),
      .init(label: "1", identifier: "", frame: CGRect(x: 0, y: 561, width: 131, height: 56), isKey: true),
      .init(label: "Delete", identifier: "delete", frame: CGRect(x: 262, y: 730, width: 131, height: 54), isKey: true),
    ]
    XCTAssertEqual(
      RunnerKeyboardStatus.observed(keyboardFrame: keyboard, keys: keys, nativeDisplaySize: display, interfaceOrientation: RunnerInterfaceOrientation.portrait),
      RunnerKeyboardStatus(visible: true, returnKey: "unknown", returnKeyLabel: nil)
    )
  }
}
#endif
