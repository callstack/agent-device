import XCTest

private enum OrientationObservationTiming {
  static let pollInterval: TimeInterval = 0.05
  static let timeout: TimeInterval = 2
}

extension RunnerTests {
  func executeRotateCommand(_ command: Command) -> Response {
    guard let orientation = command.orientation?.trimmingCharacters(in: .whitespacesAndNewlines),
      !orientation.isEmpty
    else {
      return Response(ok: false, error: ErrorPayload(message: "rotate requires orientation"))
    }
    let supportedOrientations = [
      "portrait",
      "portrait-upside-down",
      "landscape-left",
      "landscape-right",
    ]
    guard supportedOrientations.contains(orientation) else {
      return Response(
        ok: false,
        error: ErrorPayload(message: "unsupported rotate orientation: \(orientation)")
      )
    }
    guard let observedOrientation = rotateDevice(to: orientation) else {
      return Response(
        ok: false,
        error: ErrorPayload(message: "unable to observe device orientation after rotate")
      )
    }
    guard observedOrientation == orientation else {
      return Response(
        ok: false,
        error: ErrorPayload(
          message: "device orientation is \(observedOrientation), expected \(orientation)"
        )
      )
    }
    return Response(
      ok: true,
      data: DataPayload(message: "rotate", orientation: observedOrientation)
    )
  }

  private func rotateDevice(to orientationName: String) -> String? {
#if os(macOS) || os(tvOS) || os(visionOS)
    return nil
#else
    switch orientationName {
    case "portrait":
      XCUIDevice.shared.orientation = .portrait
    case "portrait-upside-down":
      XCUIDevice.shared.orientation = .portraitUpsideDown
    case "landscape-left":
      XCUIDevice.shared.orientation = .landscapeLeft
    case "landscape-right":
      XCUIDevice.shared.orientation = .landscapeRight
    default:
      return nil
    }
    let deadline = Date().addingTimeInterval(OrientationObservationTiming.timeout)
    repeat {
      if observedDeviceOrientation() == orientationName {
        return orientationName
      }
      sleepFor(OrientationObservationTiming.pollInterval)
    } while Date() < deadline
    return observedDeviceOrientation()
#endif
  }

  private func observedDeviceOrientation() -> String? {
#if os(macOS) || os(tvOS) || os(visionOS)
    return nil
#else
    switch XCUIDevice.shared.orientation {
    case .portrait:
      return "portrait"
    case .portraitUpsideDown:
      return "portrait-upside-down"
    case .landscapeLeft:
      return "landscape-left"
    case .landscapeRight:
      return "landscape-right"
    default:
      return nil
    }
#endif
  }
}
