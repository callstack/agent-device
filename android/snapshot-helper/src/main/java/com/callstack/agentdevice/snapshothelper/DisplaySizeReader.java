package com.callstack.agentdevice.snapshothelper;

/**
 * The screen the captured bounds were measured on, in physical pixels, in the current rotation.
 *
 * Node bounds reach the host through {@code AccessibilityNodeInfo.getBoundsInScreen()}, which is
 * absolute screen space, so this is the box those numbers are measured in (#3182). Two consequences
 * follow from reading the display instead of the tree: a capture of an empty screen still reports a
 * viewport, because the box is a property of the device and no node has to survive on screen for it to
 * be known; and the box does not shrink when the foreground app is letterboxed or a keyboard is up,
 * because a rect's coordinates answer to the screen rather than to the app's window.
 *
 * The caller hands in the extent of the same {@code DisplayMetrics} whose {@code density} this helper
 * publishes, so size and density cannot describe two different configurations — it is the one the
 * framework laid the captured nodes out with, a {@code wm size} or {@code wm density} override
 * included, and it rotates with the screen. {@code getRealSize} is deliberately not consulted: it is
 * deprecated and rotates inconsistently across the devices this helper runs on.
 *
 * A display that answers with nothing usable publishes no fact at all. Absence is the only way to say
 * "unknown", so the host never sees a zero.
 */
final class DisplaySizeReader {
  private DisplaySizeReader() {}

  /** The screen's pixel size in the current rotation. */
  static final class Size {
    final int width;
    final int height;

    Size(int width, int height) {
      this.width = width;
      this.height = height;
    }
  }

  /**
   * Rejects a display that answered with no usable extent. Plain parameters because a
   * {@code DisplayMetrics} is a device type this refusal has to be testable without, and a zero
   * reaching the host would claim a screen with no width — the failure this gate exists to prevent.
   */
  static Size resolve(int widthPixels, int heightPixels) {
    if (widthPixels <= 0 || heightPixels <= 0) return null;
    return new Size(widthPixels, heightPixels);
  }
}
