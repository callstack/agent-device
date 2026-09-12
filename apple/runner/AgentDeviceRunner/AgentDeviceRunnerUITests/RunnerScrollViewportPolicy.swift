import XCTest

// The scroll viewport rule the runner shares with the TS runtime (#2500).
//
// RULE: a directional scroll centres its swipe, so a focused field puts the swipe's lower endpoint
// under the keyboard — the gesture lands on keys, the surface never moves, and the edge loop reads a
// stuck container (#2499) rather than a refusal. Clipping the viewport to the band above the
// keyboard BEFORE the gesture planner runs keeps the swipe in what is visible, and when that band is
// too thin to hold one the rule REFUSES instead of handing back the full frame: a keyboard-struck
// swipe and a tiny clipped swipe both read as "stuck", so failing open is what hides the failure.
//
// The pure rule below is geometry on purpose — no XCUIApplication — so its exact decision is proven
// against the golden table shared with its TS twin, `clipScrollViewportAboveKeyboard` in
// packages/contracts/src/scroll-gesture.ts, asserted in that file's test beside this one. The table
// carries only frames representable in both languages: `CGRect` standardizes a negative extent into a
// positive height at a moved origin, so a negative `height` is tested on the TS side alone.
//
// The `extension RunnerTests` below is the one impure caller: it reads the runner's own live keyboard
// frame, because a frame threaded from the daemon would predate the keyboard.

/** What an on-screen keyboard leaves of a scroll viewport. */
enum RunnerScrollKeyboardClip: Equatable {
  /** No keyboard, or one that does not own this surface: swipe the whole viewport. */
  case unobstructed
  /** The viewport trimmed above the keyboard. Report the reduced reference height honestly. */
  case avoided(frame: CGRect, keyboardMinY: Double)
  /** Too little surface left to swipe. The caller refuses; it never swipes under the keys. */
  case occluded(keyboardMinY: Double, visibleHeight: Double)
}

/** Where one directional scroll may place its swipe, once the keyboard has taken its share. */
enum RunnerScrollViewport {
  /**
   * The band to plan the swipe inside, the frame to rotate its coordinates against, and the keyboard
   * top when the band was clipped for one. The two frames are separate on purpose: a clip shortens
   * only the band, while `nativeSynthesizedPoint` derives a `landscapeRight` native x from the
   * frame's HEIGHT, so rotating inside the band moves the dispatched path sideways off the planned
   * one.
   */
  case swipe(planFrame: CGRect, coordinateFrame: CGRect, keyboardMinY: Double?)
  /** Nothing to swipe. The caller answers `occlusionRunnerCode` and performs no gesture. */
  case occluded(keyboardMinY: Double, visibleHeight: Double)
}

/// The gesture one directional scroll dispatches, built from a resolved viewport in one place so the
/// band the plan was made inside and the frame its coordinates rotate against cannot be swapped.
struct ScrollGestureDispatch {
  let plan: RunnerScrollGesturePlan
  let planFrame: CGRect
  let coordinateFrame: CGRect
  let keyboardMinY: Double?
}

/** What a resolved viewport turns into for the command: a gesture, or the reason there is none. */
enum ScrollGestureOutcome {
  case gesture(ScrollGestureDispatch)
  case unusableFrame
  case unusablePlan
  case occluded(keyboardMinY: Double, visibleHeight: Double)
}

extension RunnerScrollViewport {
  /// Plans the swipe inside the band the keyboard left and keeps the viewport as the coordinate basis,
  /// so a clip shortens the travel without moving the gesture's lane.
  func gestureDispatch(
    direction: RunnerScrollDirection,
    amount: Double?,
    pixels: Double?
  ) -> ScrollGestureOutcome {
    switch self {
    case .occluded(let keyboardMinY, let visibleHeight):
      return .occluded(keyboardMinY: keyboardMinY, visibleHeight: visibleHeight)
    case .swipe(let planFrame, let coordinateFrame, let keyboardMinY):
      guard planFrame.width > 0, planFrame.height > 0 else {
        return .unusableFrame
      }
      guard let plan = runnerScrollGesturePlan(
        direction: direction,
        amount: amount,
        pixels: pixels,
        referenceWidth: planFrame.width,
        referenceHeight: planFrame.height
      ) else {
        return .unusablePlan
      }
      return .gesture(
        ScrollGestureDispatch(
          plan: plan,
          planFrame: planFrame,
          coordinateFrame: coordinateFrame,
          keyboardMinY: keyboardMinY
        )
      )
    }
  }
}

enum ScrollViewportPolicy {
  /** Below this fraction of the viewport, the clipped band cannot hold a reliable swipe. */
  static let minVisibleFraction: Double = 0.15
  /**
   * A fixed allowance kept above the keyboard's top edge, in points. `keyboard.frame` reports the
   * key plane, not the input accessory or composer bar riding above it, so a swipe ending exactly
   * at the reported edge can still land on a bar.
   */
  static let accessoryAllowance: Double = 12

  /// The runner's own wire vocabulary, not a shared policy constant: the host keeps it
  /// `COMMAND_FAILED` and reads it back from `details.runnerErrorCode`.
  static let occlusionRunnerCode = "SCROLL_KEYBOARD_OCCLUDES_SURFACE"

  /// Clips a scroll viewport to the band above an occluding keyboard, failing open on a frame the
  /// runner cannot measure: a missing keyboard query is not evidence that the surface is blocked.
  static func clip(viewport: CGRect, keyboard: CGRect) -> RunnerScrollKeyboardClip {
    guard isUsable(viewport), isUsable(keyboard) else {
      return .unobstructed
    }
    // A vertical swipe runs along the viewport's centre line, which is the only part of the width
    // the keyboard has to reach to be struck: a 320pt keyboard centred in an 834pt viewport is 38%
    // of the width and sits exactly in the path.
    let swipeCenterX = viewport.minX + viewport.width / 2
    if swipeCenterX < keyboard.minX || swipeCenterX >= keyboard.maxX {
      return .unobstructed
    }
    let keyboardMinY = keyboard.minY
    if keyboardMinY >= viewport.maxY || keyboard.maxY <= viewport.minY {
      return .unobstructed
    }
    let visibleHeight = max(0, keyboardMinY - accessoryAllowance - viewport.minY)
    if visibleHeight < minVisibleFraction * viewport.height {
      return .occluded(keyboardMinY: keyboardMinY, visibleHeight: visibleHeight)
    }
    return .avoided(
      frame: CGRect(
        x: viewport.minX,
        y: viewport.minY,
        width: viewport.width,
        height: visibleHeight
      ),
      keyboardMinY: keyboardMinY
    )
  }

  /// Splits a clip verdict into the two frames a dispatch needs. The gesture planner runs inside the
  /// clipped band; the coordinate rotation keeps the frame the viewport was resolved against, because
  /// the rotation basis is a property of the screen, not of what the keyboard left free.
  static func frames(referenceFrame: CGRect, clip: RunnerScrollKeyboardClip) -> RunnerScrollViewport {
    switch clip {
    case .unobstructed:
      return .swipe(planFrame: referenceFrame, coordinateFrame: referenceFrame, keyboardMinY: nil)
    case .avoided(let frame, let keyboardMinY):
      return .swipe(planFrame: frame, coordinateFrame: referenceFrame, keyboardMinY: keyboardMinY)
    case .occluded(let keyboardMinY, let visibleHeight):
      return .occluded(keyboardMinY: keyboardMinY, visibleHeight: visibleHeight)
    }
  }

  private static func isUsable(_ rect: CGRect) -> Bool {
    return [rect.minX, rect.minY, rect.width, rect.height].allSatisfy(\.isFinite)
      && rect.width > 0 && rect.height > 0
  }
}

extension RunnerTests {
  /// Resolves the frame one directional scroll places its swipe in, and what the keyboard leaves of
  /// it. Never dismisses: a dismiss drops focus, breaks a `type`/`scroll`/`type` loop, and mutates
  /// state session-action provenance does not record, so `keyboard dismiss` stays an explicit
  /// command and this path only ever reduces the space it swipes in.
  func resolvedScrollViewport(
    app: XCUIApplication,
    context: SynthesizedCoordinateContext
  ) -> RunnerScrollViewport {
#if os(iOS)
    // Every scroll reports its decision, including the two ways it avoids reading the keyboard at
    // all: a policy that forbids the probe, and a probe that finds no keyboard.
    guard context.allowsKeyboardProbe else {
      logScrollViewport(decision: "probeSkipped", keyboardMinY: nil, swipeHeight: context.referenceFrame.height, context: context)
      return ScrollViewportPolicy.frames(referenceFrame: context.referenceFrame, clip: .unobstructed)
    }
    guard let keyboardFrame = visibleKeyboardFrame(app: app) else {
      logScrollViewport(decision: "noKeyboard", keyboardMinY: nil, swipeHeight: context.referenceFrame.height, context: context)
      return ScrollViewportPolicy.frames(referenceFrame: context.referenceFrame, clip: .unobstructed)
    }
    let clip = ScrollViewportPolicy.clip(viewport: context.referenceFrame, keyboard: keyboardFrame)
    switch clip {
    case .unobstructed:
      logScrollViewport(decision: "unobstructed", keyboardMinY: nil, swipeHeight: context.referenceFrame.height, context: context)
    case .avoided(let frame, let keyboardMinY):
      logScrollViewport(
        decision: "avoided",
        keyboardMinY: keyboardMinY,
        swipeHeight: frame.height,
        context: context
      )
    case .occluded(let keyboardMinY, let visibleHeight):
      logScrollViewport(
        decision: "occluded",
        keyboardMinY: keyboardMinY,
        swipeHeight: visibleHeight,
        context: context
      )
    }
    return ScrollViewportPolicy.frames(referenceFrame: context.referenceFrame, clip: clip)
#else
    let fallbackFrame = resolvedTouchReferenceFrame(app: app, appFrame: app.frame)
    return ScrollViewportPolicy.frames(referenceFrame: fallbackFrame, clip: .unobstructed)
#endif
  }

#if os(iOS)
  /// The #2500 diagnostic for a scroll that reports no travel: whether the swipe was clipped, and
  /// whether the keyboard probe was even permitted. `axHealth` is the first thing to read, because a
  /// policy that skipped the probe looks exactly like a keyboard that was never found.
  private func logScrollViewport(
    decision: String,
    keyboardMinY: Double?,
    swipeHeight: Double,
    context: SynthesizedCoordinateContext
  ) {
    NSLog(
      "AGENT_DEVICE_RUNNER_SCROLL_VIEWPORT kind=scroll axHealth=%@ keyboardPolicy=%@ decision=%@ keyboardMinY=%@ swipeHeight=%.1f",
      context.accessibilityHealth.rawValue,
      context.keyboardPolicy.rawValue,
      decision,
      keyboardMinY.map { String(format: "%.1f", $0) } ?? "none",
      swipeHeight
    )
  }
#endif
}

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
private struct ScrollViewportPolicyFixture: Decodable {
  struct Frame: Decodable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double

    var cgRect: CGRect {
      CGRect(x: x, y: y, width: width, height: height)
    }
  }

  struct Constants: Decodable {
    let minVisibleFraction: Double
    let accessoryAllowance: Double
  }

  struct Expected: Decodable {
    let kind: String
    let viewport: Frame?
    let keyboardMinY: Double?
    let visibleHeight: Double?
  }

  struct TestCase: Decodable {
    let name: String
    let viewport: Frame
    let keyboard: Frame
    let expected: Expected
  }

  let constants: Constants
  let cases: [TestCase]
}

extension RunnerTests {
  /// Golden parity table (#2500): every case in contracts/fixtures/scroll-keyboard-policy.json must
  /// agree with the vitest twin. Add cases there, never fork the rule.
  func testScrollViewportKeyboardClipMatchesGoldenParityTable() throws {
    let fixture = try loadScrollViewportPolicyFixture()
    XCTAssertFalse(fixture.cases.isEmpty, "parity table must not be empty")
    for testCase in fixture.cases {
      let clip = ScrollViewportPolicy.clip(
        viewport: testCase.viewport.cgRect,
        keyboard: testCase.keyboard.cgRect
      )
      switch testCase.expected.kind {
      case "unobstructed":
        XCTAssertEqual(clip, .unobstructed, testCase.name)
      case "avoided":
        let expectedFrame = try XCTUnwrap(testCase.expected.viewport, testCase.name).cgRect
        let expectedMinY = try XCTUnwrap(testCase.expected.keyboardMinY, testCase.name)
        XCTAssertEqual(
          clip,
          .avoided(frame: expectedFrame, keyboardMinY: expectedMinY),
          testCase.name
        )
      case "occluded":
        let expectedMinY = try XCTUnwrap(testCase.expected.keyboardMinY, testCase.name)
        let expectedVisibleHeight = try XCTUnwrap(testCase.expected.visibleHeight, testCase.name)
        XCTAssertEqual(
          clip,
          .occluded(keyboardMinY: expectedMinY, visibleHeight: expectedVisibleHeight),
          testCase.name
        )
      default:
        XCTFail("unknown expected kind `\(testCase.expected.kind)` in \(testCase.name)")
      }
    }
  }

  /// The thresholds are the table's, not this file's. The refusal reason and the runner code are
  /// each one side's own vocabulary: the reason is what the host publishes, the code is what this
  /// runner answers with, and neither is a shared clip constant.
  func testScrollViewportPolicyUsesParityTableConstants() throws {
    let constants = try loadScrollViewportPolicyFixture().constants
    XCTAssertEqual(constants.minVisibleFraction, ScrollViewportPolicy.minVisibleFraction)
    XCTAssertEqual(constants.accessoryAllowance, ScrollViewportPolicy.accessoryAllowance)
  }

  /// A clipped landscape band shortens the frame, and `nativeSynthesizedPoint` derives a
  /// `landscapeRight` native x from the frame's HEIGHT. Rotating inside the band therefore moves the
  /// dispatched path sideways by exactly what the keyboard took, off the lane the plan was built for,
  /// so the plan band and the coordinate basis stay separate values through dispatch (#2500).
  func testScrollViewportDispatchKeepsTheUnclippedFrameAsItsCoordinateRotationBasis() throws {
    let viewport = CGRect(x: 0, y: 0, width: 1210, height: 834)
    let keyboard = CGRect(x: 0, y: 588, width: 1210, height: 246)
    let clip = ScrollViewportPolicy.clip(viewport: viewport, keyboard: keyboard)
    guard case .avoided(let band, let keyboardMinY) = clip else {
      return XCTFail("expected a landscape keyboard to be avoided, got \(clip)")
    }
    XCTAssertEqual(band.height, 576)

    guard case .gesture(let gesture) = ScrollViewportPolicy.frames(
      referenceFrame: viewport,
      clip: clip
    ).gestureDispatch(direction: .up, amount: nil, pixels: nil) else {
      return XCTFail("expected a gesture inside the clipped band")
    }
    XCTAssertEqual(gesture.planFrame, band)
    XCTAssertEqual(gesture.keyboardMinY, keyboardMinY)
    XCTAssertEqual(gesture.coordinateFrame, viewport, "the rotation basis must survive the clip")
    XCTAssertLessThanOrEqual(
      max(gesture.plan.y1, gesture.plan.y2),
      keyboard.minY - ScrollViewportPolicy.accessoryAllowance,
      "a landscape swipe must stay clear of the keys"
    )

    let orientedStartY = gesture.planFrame.minY + gesture.plan.y1
    let dispatched = nativeSynthesizedPoint(
      orientedX: gesture.planFrame.minX + gesture.plan.x1,
      orientedY: orientedStartY,
      in: gesture.coordinateFrame,
      interfaceOrientation: RunnerInterfaceOrientation.landscapeRight
    )
    let clippedBasis = nativeSynthesizedPoint(
      orientedX: gesture.planFrame.minX + gesture.plan.x1,
      orientedY: orientedStartY,
      in: gesture.planFrame,
      interfaceOrientation: RunnerInterfaceOrientation.landscapeRight
    )
    XCTAssertEqual(
      dispatched.x - clippedBasis.x,
      viewport.height - band.height,
      accuracy: 0.001,
      "rotating inside the clipped band would shift native x by what the keyboard took"
    )
  }

  private func loadScrollViewportPolicyFixture() throws -> ScrollViewportPolicyFixture {
    let fixtureURL = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent() // AgentDeviceRunnerUITests
      .deletingLastPathComponent() // AgentDeviceRunner
      .deletingLastPathComponent() // runner
      .deletingLastPathComponent() // apple
      .deletingLastPathComponent() // repo root
      .appendingPathComponent("contracts")
      .appendingPathComponent("fixtures")
      .appendingPathComponent("scroll-keyboard-policy.json")
    return try JSONDecoder().decode(
      ScrollViewportPolicyFixture.self,
      from: Data(contentsOf: fixtureURL)
    )
  }
}
#endif
