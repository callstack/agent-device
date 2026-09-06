import XCTest

#if AGENT_DEVICE_RUNNER_UNIT_TESTS && os(iOS)
import ObjectiveC.runtime

private enum SynthesizedInputSpy {
  static var paths: [ObjectIdentifier: Int] = [:]
  static var submittedPathCounts: [Int] = []
  static var rejectNext = true
}

private final class SynthesizedInputTarget: NSObject {
  @objc var processID: Int { 42 }
  @objc var interfaceOrientation: Int { 1 }
}

private final class SynthesizedInputRecordSpy: NSObject {
  @objc(addPointerEventPath:)
  func addPointerEventPath(_ path: AnyObject) {
    SynthesizedInputSpy.paths[ObjectIdentifier(self), default: 0] += 1
  }

  @objc(synthesizeWithError:)
  func synthesizeWithError(_ error: UnsafeMutablePointer<NSError?>?) -> Bool {
    SynthesizedInputSpy.submittedPathCounts.append(
      SynthesizedInputSpy.paths.removeValue(forKey: ObjectIdentifier(self)) ?? 0
    )
    if SynthesizedInputSpy.rejectNext {
      SynthesizedInputSpy.rejectNext = false
      error?.pointee = NSError(domain: "WarmupTest", code: 1)
      return false
    }
    return true
  }
}
#endif

extension RunnerTests {
#if AGENT_DEVICE_RUNNER_UNIT_TESTS && os(iOS)
  func testSynthesizedInputPreparationDoesNotDeliverContactsAndOrdersMixedRoutes() throws {
    let recordClass = try XCTUnwrap(NSClassFromString("XCSynthesizedEventRecord"))
    var originals: [(Method, IMP)] = []
    for name in ["addPointerEventPath:", "synthesizeWithError:"] {
      let selector = NSSelectorFromString(name)
      let method = try XCTUnwrap(class_getInstanceMethod(recordClass, selector))
      let spy = try XCTUnwrap(class_getInstanceMethod(SynthesizedInputRecordSpy.self, selector))
      originals.append((method, method_getImplementation(method)))
      method_setImplementation(method, method_getImplementation(spy))
    }
    defer {
      for (method, implementation) in originals { method_setImplementation(method, implementation) }
      SynthesizedInputSpy.paths = [:]
      SynthesizedInputSpy.submittedPathCounts = []
      SynthesizedInputSpy.rejectNext = true
    }
    let target = SynthesizedInputTarget()
    // Exercise the actual bridge entry points used by gesture/sequence, scroll,
    // synthesized drag and coordinate tap. No real event reaches the simulator.
    let samples: [[[String: NSNumber]]] = [[
      ["x": 10, "y": 10, "offsetMs": 0],
      ["x": 20, "y": 20, "offsetMs": 100],
    ]]
    // A failed preparation must leave the real request available and permit the
    // next route to prepare again. Only a successful empty synthesis consumes it.
    XCTAssertNil(RunnerSynthesizedGesture.synthesizeGesture(withApplication: target, pointerSamples: samples))
    XCTAssertNil(RunnerSynthesizedGesture.synthesizeControlledScroll(withApplication: target, x: 10, y: 10, x2: 20, y2: 20, durationMs: 100))
    XCTAssertNil(RunnerSynthesizedGesture.synthesizeContinuousDrag(withApplication: target, x: 10, y: 10, x2: 20, y2: 20, durationMs: 100))
    XCTAssertNil(RunnerSynthesizedGesture.synthesizeTap(withApplication: target, x: 10, y: 10))
    XCTAssertNil(RunnerSynthesizedGesture.synthesizeSwipe(withApplication: target, x: 10, y: 10, x2: 20, y2: 20, durationMs: 100))
    XCTAssertNil(RunnerSynthesizedGesture.synthesizeGesture(withApplication: target, pointerSamples: samples))
    XCTAssertEqual(SynthesizedInputSpy.submittedPathCounts, [0, 1, 0, 1, 1, 1, 1, 1])
  }
#endif
}
