import XCTest

#if AGENT_DEVICE_RUNNER_UNIT_TESTS && os(iOS)
import ObjectiveC.runtime

private final class TapScreenFixture: NSObject {
  @objc let displayID: UInt = 1
}

private final class TapWindowFixture: NSObject {
  let prepare: () -> Void
  @objc let screen = TapScreenFixture()
  init(prepare: @escaping () -> Void) { self.prepare = prepare }
  @objc var frame: CGRect {
    prepare()
    return CGRect(x: 0, y: 0, width: 100, height: 100)
  }
}

private final class TapApplicationFixture: NSObject {
  @objc let processID: Int = 1
  @objc let interfaceOrientation: Int = 1
}

private final class TapRecordSpy: NSObject {
  static var syntheses = 0
  @objc(synthesizeWithError:)
  func synthesize(error: AutoreleasingUnsafeMutablePointer<NSError?>?) -> Bool {
    Self.syntheses += 1
    return true
  }
}

extension RunnerTests {
  func testTapDeadlineExpiringDuringEventPreparationDoesNotSynthesize() throws {
    let recordClass = try XCTUnwrap(NSClassFromString("XCSynthesizedEventRecord"))
    let selector = NSSelectorFromString("synthesizeWithError:")
    let method = try XCTUnwrap(class_getInstanceMethod(recordClass, selector))
    let spy = try XCTUnwrap(class_getInstanceMethod(TapRecordSpy.self, selector))
    let original = method_getImplementation(method)
    method_setImplementation(method, method_getImplementation(spy))
    defer { method_setImplementation(method, original) }
    TapRecordSpy.syntheses = 0

    let deadline = Date().addingTimeInterval(1)
    var prepared = false
    var preparationBeganBeforeDeadline = false
    let window = TapWindowFixture {
      preparationBeganBeforeDeadline = Date() < deadline
      while Date() < deadline { Thread.sleep(forTimeInterval: 0.001) }
      prepared = true
    }
    var message: NSString?
    let expired = RunnerSynthesizedGesture.synthesizeTap(
      withApplication: TapApplicationFixture(),
      resolvedWindow: window,
      x: 50,
      y: 50,
      deadline: deadline,
      errorMessage: &message
    )

    XCTAssertTrue(preparationBeganBeforeDeadline)
    XCTAssertTrue(prepared)
    XCTAssertEqual(expired, .deadlineExceeded)
    XCTAssertNil(message)
    XCTAssertEqual(TapRecordSpy.syntheses, 0)

    let control = RunnerSynthesizedGesture.synthesizeTap(
      withApplication: TapApplicationFixture(),
      resolvedWindow: TapWindowFixture {},
      x: 50,
      y: 50,
      deadline: .distantFuture,
      errorMessage: &message
    )
    XCTAssertEqual(control, .succeeded, message as String? ?? "")
    XCTAssertEqual(TapRecordSpy.syntheses, 1)
  }
}
#endif
