package com.callstack.agentdevice.snapshothelper;

import android.content.Context;
import android.hardware.display.DisplayManager;
import android.view.Display;

/**
 * Display facts published beside a session screenshot. {@code UiAutomation.takeScreenshot()}
 * captures the default display in its current rotation, so that display's logical rotation pairs
 * with the image. A read that fails answers {@link #UNKNOWN}, and the response then omits the fact
 * instead of failing the capture.
 */
final class ScreenshotDisplay {
  static final int UNKNOWN = -1;

  private ScreenshotDisplay() {}

  static DisplayManager displays(Context context) {
    try {
      return (DisplayManager) context.getSystemService(Context.DISPLAY_SERVICE);
    } catch (Throwable error) {
      return null;
    }
  }

  /** The default display's {@code Surface.ROTATION_*} index. */
  static int rotation(DisplayManager displays) {
    try {
      Display display = displays.getDisplay(Display.DEFAULT_DISPLAY);
      return display == null ? UNKNOWN : display.getRotation();
    } catch (Throwable error) {
      return UNKNOWN;
    }
  }

  /** The number of logical displays this process can see. */
  static int count(DisplayManager displays) {
    try {
      return displays.getDisplays().length;
    } catch (Throwable error) {
      return UNKNOWN;
    }
  }

  /**
   * The rotation read before and after the capture agreed on, or {@link #UNKNOWN} when either read
   * failed or the display turned during the capture.
   */
  static int whenBothAgree(int before, int after) {
    return before >= 0 && before == after ? before : UNKNOWN;
  }
}
