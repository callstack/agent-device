import AppKit
import QuartzCore

/// A drawn pointer that shows where a background action lands while the user keeps the real
/// one. The helper exits after each command, so the last point is persisted and the next
/// action glides from it; a stale point restarts from the user's own cursor.
final class GhostCursor {
  private static let size = CGSize(width: 64, height: 64)
  /// Where the arrow's tip sits inside the panel, from its top-left corner; it leaves room for
  /// the pulse ring's full radius.
  private static let tipOffset = CGPoint(x: 22, y: 22)
  private static let staleAfter: TimeInterval = 30
  private static let positionURL = URL(fileURLWithPath: NSTemporaryDirectory())
    .appendingPathComponent("agent-device-ghost-cursor.json")

  private let panel: NSPanel
  private let view: GhostCursorView
  private let primaryScreenHeight: CGFloat
  private var position: CGPoint

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
    position =
      Self.restoredPosition(primaryScreenHeight: primaryScreenHeight)
      ?? Self.userCursorPosition(primaryScreenHeight: primaryScreenHeight)
    place(at: position)
    panel.orderFrontRegardless()
    flush(for: 0.016)
  }

  /// Glides to a point in global top-left coordinates, the space AX and CGEvent share.
  func move(to target: CGPoint, duration: TimeInterval = 0.22) {
    let start = position
    let steps = max(1, Int(duration / 0.016))
    for step in 1...steps {
      let t = Double(step) / Double(steps)
      let eased = t < 0.5 ? 2 * t * t : 1 - pow(-2 * t + 2, 2) / 2
      place(
        at: CGPoint(
          x: start.x + (target.x - start.x) * eased,
          y: start.y + (target.y - start.y) * eased
        )
      )
      flush(for: 0.016)
    }
    position = target
  }

  /// A ring at the tip, marking the moment the action was delivered.
  func pulse(duration: TimeInterval = 0.18) {
    let steps = max(1, Int(duration / 0.016))
    for step in 1...steps {
      view.ringProgress = CGFloat(step) / CGFloat(steps)
      view.display()
      flush(for: 0.016)
    }
    view.ringProgress = nil
    view.display()
  }

  /// Hides the cursor; only a delivered action's point becomes the next action's start.
  func finish(delivered: Bool, linger: TimeInterval = 0.25) {
    flush(for: linger)
    panel.orderOut(nil)
    if delivered { persist(position) }
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

  private static func userCursorPosition(primaryScreenHeight: CGFloat) -> CGPoint {
    let location = NSEvent.mouseLocation
    return CGPoint(x: location.x, y: primaryScreenHeight - location.y)
  }

  /// The last delivered point, unless it is stale or no display shows it any more.
  private static func restoredPosition(primaryScreenHeight: CGFloat) -> CGPoint? {
    guard let attributes = try? FileManager.default.attributesOfItem(atPath: positionURL.path),
      let modified = attributes[.modificationDate] as? Date,
      Date().timeIntervalSince(modified) < staleAfter,
      let data = try? Data(contentsOf: positionURL),
      let stored = try? JSONDecoder().decode([Double].self, from: data),
      stored.count == 2
    else {
      return nil
    }
    let point = CGPoint(x: stored[0], y: stored[1])
    let appKitPoint = CGPoint(x: point.x, y: primaryScreenHeight - point.y)
    return NSScreen.screens.contains { $0.frame.contains(appKitPoint) } ? point : nil
  }

  private func persist(_ point: CGPoint) {
    guard let data = try? JSONEncoder().encode([Double(point.x), Double(point.y)]) else { return }
    try? data.write(to: Self.positionURL, options: .atomic)
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
