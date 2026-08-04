import CoreGraphics

// #1598: iOS has no app-agnostic API to resign the keyboard's first responder.
// When the keyboard itself exposes no dismiss/hide key (the common case on
// iPhone — only iPad's floating/split keyboard reliably has one) and no
// synthesized gesture resigns it either (interactive keyboard dismissal is an
// opt-in UIScrollView behavior, not a system-wide guarantee — verified live:
// neither a swipe-down starting on the keyboard nor a tap on blank content
// dismissed Settings/Safari/Contacts' keyboards on a stock iOS 26 simulator),
// the last resort is a tap on a point that is provably outside the keyboard
// and outside every currently-hittable element. Whether or not the target
// app happens to resign on that tap (many RN screens do via a background
// `Pressable`/`TouchableWithoutFeedback`; stock system screens tested here
// did not), the tap itself cannot corrupt app state because it deliberately
// avoids every interactive control the snapshot knows about — so it is safe
// to attempt even when the caller cannot know in advance whether it will
// work. The caller must disclose that this fallback was used (ADR: keyboard
// dismiss mechanism field) precisely because "safe" is not "guaranteed".
//
// Pure geometry on purpose (no XCUIElement) so the point selection is
// provable independent of a simulator — mirrors RunnerTapPointPolicy.
enum RunnerKeyboardDismissSafeArea {
  // Horizontal candidates, tried in order, as a fraction of window width.
  // Center first (least likely to be near edge-anchored chrome like a back
  // button or a floating action button), then a spread of alternates.
  static let candidateXFractions: [Double] = [0.5, 0.25, 0.75, 0.1, 0.9]

  // Clears the status bar / notch on every current device class without
  // needing safe-area-inset data the runner does not have cheap access to.
  // A tap here can still trigger "scroll to top" on a scroll view under it;
  // that is a disclosed, accepted side effect of this fallback, not a bug.
  static let topMargin: Double = 50

  // Padding added around every obstacle frame before containment is tested,
  // so a tap just outside a control's reported frame still counts as risky
  // (hit-testing slop, rounded corners, shadows extending the visual bounds).
  static let obstacleMargin: Double = 6

  // A frame covering (almost) the whole window is a structural container —
  // Application/Window roots, full-screen scrims, or an RN background
  // `Pressable` — not a discrete control the safe-area tap can route around:
  // every candidate lies inside it by construction. Exempting them from the
  // obstacle set is what keeps the any-element rule (#1606 review P1)
  // satisfiable at all; the trade-off (a genuinely tappable full-screen
  // backdrop is NOT treated as an obstacle) is exactly the disclosed,
  // accepted behavior of this fallback — on many RN screens that backdrop
  // tap IS what resigns the keyboard.
  static let structuralRootCoverage: Double = 0.95

  static func isStructuralRootFrame(_ frame: CGRect, windowFrame: CGRect) -> Bool {
    guard !windowFrame.isEmpty else { return false }
    return frame.width >= windowFrame.width * structuralRootCoverage
      && frame.height >= windowFrame.height * structuralRootCoverage
  }

  /// Returns a point inside `windowFrame`, above `keyboardFrame`, and outside
  /// every frame in `obstacles` (each expanded by `obstacleMargin`) — or nil
  /// if no candidate clears all of them, in which case the caller must not
  /// tap (there is no rect left the runner can vouch for as ax-empty).
  static func safePoint(
    windowFrame: CGRect,
    keyboardFrame: CGRect,
    obstacles: [CGRect]
  ) -> CGPoint? {
    guard !windowFrame.isEmpty, !windowFrame.isInfinite, !windowFrame.isNull else {
      return nil
    }
    let keyboardTop = keyboardFrame.isEmpty || keyboardFrame.isNull || keyboardFrame.isInfinite
      ? windowFrame.maxY
      : min(keyboardFrame.minY, windowFrame.maxY)
    let availableHeight = keyboardTop - windowFrame.minY
    guard availableHeight >= topMargin * 2 else {
      return nil
    }
    let y = windowFrame.minY + topMargin
    let expandedObstacles = obstacles.map { $0.insetBy(dx: -obstacleMargin, dy: -obstacleMargin) }
    for fraction in candidateXFractions {
      let x = windowFrame.minX + windowFrame.width * fraction
      let point = CGPoint(x: x, y: y)
      guard point.y < keyboardTop else { continue }
      if !expandedObstacles.contains(where: { $0.contains(point) }) {
        return point
      }
    }
    return nil
  }
}

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
extension RunnerTests {
  func testKeyboardDismissSafeAreaPrefersScreenCenterWhenClear() {
    let point = RunnerKeyboardDismissSafeArea.safePoint(
      windowFrame: CGRect(x: 0, y: 0, width: 400, height: 800),
      keyboardFrame: CGRect(x: 0, y: 550, width: 400, height: 250),
      obstacles: []
    )
    XCTAssertEqual(point, CGPoint(x: 200, y: 50))
  }

  func testKeyboardDismissSafeAreaSkipsObstructedCandidates() {
    // Center candidate (200, 50) sits inside a banner covering the middle of
    // the width; the next candidate (25% from the left) must be picked
    // instead, since it falls outside the banner even with margin applied.
    let point = RunnerKeyboardDismissSafeArea.safePoint(
      windowFrame: CGRect(x: 0, y: 0, width: 400, height: 800),
      keyboardFrame: CGRect(x: 0, y: 550, width: 400, height: 250),
      obstacles: [CGRect(x: 150, y: 0, width: 100, height: 100)]
    )
    XCTAssertEqual(point, CGPoint(x: 100, y: 50))
  }

  func testKeyboardDismissSafeAreaReturnsNilWhenEveryCandidateIsObstructed() {
    let point = RunnerKeyboardDismissSafeArea.safePoint(
      windowFrame: CGRect(x: 0, y: 0, width: 400, height: 800),
      keyboardFrame: CGRect(x: 0, y: 550, width: 400, height: 250),
      obstacles: [CGRect(x: 0, y: 0, width: 400, height: 120)]
    )
    XCTAssertNil(point)
  }

  func testKeyboardDismissSafeAreaReturnsNilWhenKeyboardCoversAlmostEverything() {
    // Only 40pt separates the top of the window from the keyboard — not
    // enough room for a safely-margined tap.
    let point = RunnerKeyboardDismissSafeArea.safePoint(
      windowFrame: CGRect(x: 0, y: 0, width: 400, height: 800),
      keyboardFrame: CGRect(x: 0, y: 40, width: 400, height: 760),
      obstacles: []
    )
    XCTAssertNil(point)
  }

  func testKeyboardDismissSafeAreaReturnsNilForEmptyWindow() {
    let point = RunnerKeyboardDismissSafeArea.safePoint(
      windowFrame: .zero,
      keyboardFrame: CGRect(x: 0, y: 40, width: 400, height: 760),
      obstacles: []
    )
    XCTAssertNil(point)
  }

  func testKeyboardDismissSafeAreaToleratesMissingKeyboardFrame() {
    // Callers that could not resolve a keyboard frame still get a safe point
    // near the top of the window rather than being refused outright.
    let point = RunnerKeyboardDismissSafeArea.safePoint(
      windowFrame: CGRect(x: 0, y: 0, width: 400, height: 800),
      keyboardFrame: .zero,
      obstacles: []
    )
    XCTAssertEqual(point, CGPoint(x: 200, y: 50))
  }

  func testKeyboardDismissStructuralRootFramesAreExemptButControlsAreNot() {
    let window = CGRect(x: 0, y: 0, width: 400, height: 800)
    // Application/Window roots and full-bleed backdrops are structural.
    XCTAssertTrue(RunnerKeyboardDismissSafeArea.isStructuralRootFrame(window, windowFrame: window))
    XCTAssertTrue(
      RunnerKeyboardDismissSafeArea.isStructuralRootFrame(
        CGRect(x: 5, y: 5, width: 390, height: 790),
        windowFrame: window
      )
    )
    // A wide banner, a half-screen sheet, and a small control are not.
    XCTAssertFalse(
      RunnerKeyboardDismissSafeArea.isStructuralRootFrame(
        CGRect(x: 0, y: 0, width: 400, height: 100),
        windowFrame: window
      )
    )
    XCTAssertFalse(
      RunnerKeyboardDismissSafeArea.isStructuralRootFrame(
        CGRect(x: 0, y: 400, width: 400, height: 400),
        windowFrame: window
      )
    )
    XCTAssertFalse(
      RunnerKeyboardDismissSafeArea.isStructuralRootFrame(
        CGRect(x: 20, y: 40, width: 60, height: 44),
        windowFrame: window
      )
    )
  }

  func testKeyboardDismissSafeAreaObstacleMarginCoversNearMisses() {
    // The 50%, 25%, and 75% candidates (x=200/100/300) sit inside a wide
    // banner. The 10% candidate (x=40) is NOT literally inside the next
    // obstacle (its raw bounds are x=44..90) but the 6pt margin grows that
    // obstacle to x=38..96, which does cover x=40 — so that candidate must
    // also be rejected, leaving the 90% candidate (x=360) as the pick.
    let point = RunnerKeyboardDismissSafeArea.safePoint(
      windowFrame: CGRect(x: 0, y: 0, width: 400, height: 800),
      keyboardFrame: CGRect(x: 0, y: 550, width: 400, height: 250),
      obstacles: [
        CGRect(x: 50, y: 0, width: 300, height: 100),
        CGRect(x: 44, y: 0, width: 46, height: 100),
      ]
    )
    XCTAssertEqual(point, CGPoint(x: 360, y: 50))
  }
}
#endif
