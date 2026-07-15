import XCTest

extension RunnerTests {
  /// Runs `block` and returns its value. If it raises an Objective-C exception, logs the message
  /// under `AGENT_DEVICE_RUNNER_<tag>_IGNORED_EXCEPTION` and returns `fallback`.
  ///
  /// Consolidates the catch-log-and-default band-aid the runner uses around exception-prone
  /// XCUITest queries (flaky `allElementsBoundByIndex` snapshots, stale element reads), giving the
  /// "silently logged and continued" path one searchable format and one place to add per-tag
  /// exception telemetry later. `RunnerObjCExceptionCatcher.catchException` takes a non-escaping
  /// block, so `block` may capture `inout` state.
  func safely<T>(_ tag: String, _ fallback: T, _ block: () -> T) -> T {
    let (result, exceptionMessage) = catchingObjCException(fallback: fallback, block)
    if let exceptionMessage {
      NSLog("AGENT_DEVICE_RUNNER_%@_IGNORED_EXCEPTION=%@", tag, exceptionMessage)
      return fallback
    }
    return result
  }

  func catchingObjCException<T>(
    fallback: T,
    _ block: () -> T
  ) -> (result: T, exceptionMessage: String?) {
    var result = fallback
    let exceptionMessage = RunnerObjCExceptionCatcher.catchException({
      result = block()
    })
    return (result, exceptionMessage)
  }

  /// Optional-returning convenience: returns `nil` on exception (matching the common
  /// `var x: T?` + catch-and-return-nil shape).
  func safely<T>(_ tag: String, _ block: () -> T?) -> T? {
    safely(tag, nil, block)
  }
}
