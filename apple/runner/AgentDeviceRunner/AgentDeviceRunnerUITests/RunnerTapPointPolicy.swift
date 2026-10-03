import XCTest

// The tap-point rule the runner shares with the TS runtime (ADR 0011 Layer 2).
//
// RULE: the tap point is the element frame's CENTER; a tap is allowed iff that
// center lies inside the window frame, edges inclusive. An empty or invalid
// window frame fails open (allowed): resolving the best available frame is the
// impure caller's job (onScreenWindowFrame / app.frame), and the policy must
// not turn a missing frame into a refusal.
//
// This is pure geometry on purpose — no XCUIElement — so the exact decision
// can be proven against the golden fixture table shared with the TS twin:
//   table:   contracts/fixtures/tap-point-policy.json
//   TS twin: packages/contracts/src/snapshot-visibility.ts#isTapPointInsideViewport
//   TS test: packages/contracts/src/snapshot-tap-point-policy.test.ts
// Drift on either side turns CI red without needing a simulator.
enum TapPointPolicy {
  static func isAllowed(elementFrame: CGRect, windowFrame: CGRect) -> Bool {
    if windowFrame.isNull || windowFrame.isEmpty || windowFrame.isInfinite {
      return true
    }
    let centerX = elementFrame.midX
    let centerY = elementFrame.midY
    return centerX >= windowFrame.minX && centerX <= windowFrame.maxX
      && centerY >= windowFrame.minY && centerY <= windowFrame.maxY
  }
}
