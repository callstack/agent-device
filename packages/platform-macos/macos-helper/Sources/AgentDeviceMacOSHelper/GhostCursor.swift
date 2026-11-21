import AppKit
import QuartzCore

/// A drawn pointer that shows where a background action lands while the user keeps the real
/// one. It appears just above and left of the target, glides onto it, and pulses when the action
/// is delivered: about 0.3 s per action. It holds no state between helper processes.
final class GhostCursor {
  private static let size = CGSize(width: 64, height: 64)
  /// Where the arrow's tip sits inside the panel, from its top-left corner; it leaves room for
  /// the pulse ring's full radius.
  private static let tipOffset = CGPoint(x: 22, y: 22)
  /// Where the glide starts, relative to the target.
  private static let approach = CGVector(dx: -36, dy: -36)

  private let panel: NSPanel
  private let view: GhostCursorView
  private let primaryScreenHeight: CGFloat

  /// Nil when no display is attached; the action still runs, just unseen.
  static func show() -> GhostCursor? {
    _ = NSApplication.shared
    NSApp.setActivationPolicy(.accessory)
    guard let primary = NSScreen.screens.first else { return nil }
    return GhostCursor(primaryScreenHeight: primary.frame.height)
  }

  private init(primaryScreenHeight: CGFloat) {
    self.primaryScreenHeight = primaryScreenHeight
    view = GhostCursorView(frame: CGRect(origin: .zero, size: Self.size), tip: Self.tipOffset)
    panel = NSPanel(
      contentRect: CGRect(origin: .zero, size: Self.size),
      styleMask: [.borderless, .nonactivatingPanel],
      backing: .buffered,
      defer: false
    )
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = false
    panel.ignoresMouseEvents = true
    panel.level = .screenSaver
    panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenAuxiliary]
    panel.contentView = view
  }

  /// Glides onto a point in global top-left coordinates, the space AX and CGEvent share.
  func move(to target: CGPoint, duration: TimeInterval = 0.15) {
    let start = CGPoint(x: target.x + Self.approach.dx, y: target.y + Self.approach.dy)
    place(at: start)
    panel.orderFrontRegardless()
    let steps = max(1, Int(duration / 0.016))
    for step in 1...steps {
      let t = Double(step) / Double(steps)
      let eased = 1 - pow(1 - t, 3)
      place(at: CGPoint(x: start.x + (target.x - start.x) * eased, y: start.y + (target.y - start.y) * eased))
      flush(for: 0.016)
    }
  }

  /// A ring at the tip, marking the moment the action was delivered; nothing when the cursor never
  /// moved onto a target.
  func pulse(duration: TimeInterval = 0.12) {
    guard panel.isVisible else { return }
    let steps = max(1, Int(duration / 0.016))
    for step in 1...steps {
      view.ringProgress = CGFloat(step) / CGFloat(steps)
      view.display()
      flush(for: 0.016)
    }
  }

  func hide() {
    panel.orderOut(nil)
    CATransaction.flush()
  }

  private func place(at tip: CGPoint) {
    panel.setFrameOrigin(
      CGPoint(
        x: tip.x - Self.tipOffset.x,
        y: primaryScreenHeight - tip.y - Self.size.height + Self.tipOffset.y
      )
    )
  }

  private func flush(for interval: TimeInterval) {
    CATransaction.flush()
    RunLoop.current.run(until: Date(timeIntervalSinceNow: interval))
  }
}

private final class GhostCursorView: NSView {
  private let tip: CGPoint
  var ringProgress: CGFloat?

  init(frame: CGRect, tip: CGPoint) {
    self.tip = tip
    super.init(frame: frame)
  }

  required init?(coder: NSCoder) {
    nil
  }

  override var isFlipped: Bool { true }

  override func draw(_ dirtyRect: NSRect) {
    NSColor.clear.setFill()
    dirtyRect.fill()
    if let progress = ringProgress {
      let radius = 6 + 14 * progress
      let ring = NSBezierPath(
        ovalIn: CGRect(x: tip.x - radius, y: tip.y - radius, width: radius * 2, height: radius * 2)
      )
      ring.lineWidth = 3
      NSColor.systemPurple.withAlphaComponent(0.85 * (1 - progress)).setStroke()
      ring.stroke()
    }
    let arrow = NSBezierPath()
    arrow.move(to: tip)
    arrow.line(to: CGPoint(x: tip.x, y: tip.y + 22))
    arrow.line(to: CGPoint(x: tip.x + 6, y: tip.y + 17))
    arrow.line(to: CGPoint(x: tip.x + 10, y: tip.y + 26))
    arrow.line(to: CGPoint(x: tip.x + 14, y: tip.y + 24))
    arrow.line(to: CGPoint(x: tip.x + 10, y: tip.y + 15))
    arrow.line(to: CGPoint(x: tip.x + 17, y: tip.y + 15))
    arrow.close()
    arrow.lineJoinStyle = .round
    let shadow = NSShadow()
    shadow.shadowBlurRadius = 3
    shadow.shadowOffset = CGSize(width: 0, height: -1)
    shadow.shadowColor = NSColor.black.withAlphaComponent(0.35)
    NSGraphicsContext.saveGraphicsState()
    shadow.set()
    NSColor.systemPurple.setFill()
    arrow.fill()
    NSGraphicsContext.restoreGraphicsState()
    arrow.lineWidth = 1.5
    NSColor.white.setStroke()
    arrow.stroke()
  }
}
