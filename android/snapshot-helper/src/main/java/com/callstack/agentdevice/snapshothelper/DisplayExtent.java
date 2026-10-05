package com.callstack.agentdevice.snapshothelper;

import android.content.Context;
import android.graphics.Rect;
import android.os.Build;
import android.util.DisplayMetrics;
import android.view.Display;
import android.view.WindowManager;

/**
 * The physical display the captured bounds were measured on, in physical pixels, in the current
 * rotation (#3182).
 *
 * Node bounds reach the host through {@code AccessibilityNodeInfo.getBoundsInScreen()}, which is
 * absolute screen space across every interactive window, SystemUI's navigation bar included. The
 * extent therefore has to be the real display extent rather than {@code Resources.getSystem()}'s
 * app display size: the latter excludes a persistent navigation bar, so a nav-bar node's rect would
 * land outside the published box. On API 30+ that extent is
 * {@code WindowManager.getMaximumWindowMetrics().getBounds()}; below it, {@code
 * Display.getRealMetrics}, which likewise carries the full panel and not the app-usable inset.
 *
 * The caller reads this twice around the tree dump and publishes only what {@link #whenBothAgree}
 * returns. A rotation landing inside the dump changes the extent between the reads, and the capture
 * then says nothing about its box rather than pairing one rotation's bounds with the other's
 * dimensions. A display this process cannot address answers with null. Either way the host publishes
 * the absence it reads as unknown, and the host's own guard is what refuses a zero extent.
 */
final class DisplayExtent {
  private DisplayExtent() {}

  /** The extent one read of the display answered with, in the current rotation. */
  static final class Extent {
    final int width;
    final int height;

    Extent(int width, int height) {
      this.width = width;
      this.height = height;
    }
  }

  /**
   * The extent of the display {@code context} is attached to, or null when this process could not
   * address it. A zero extent is passed through as read: refusing an unusable box is the host's job,
   * and {@code snapshotViewportSizeFrom} already refuses one, so a second refusal here would only
   * be a second place that decides what a usable display is.
   */
  static Extent read(Context context) {
    try {
      WindowManager windowManager =
          (WindowManager) context.getSystemService(Context.WINDOW_SERVICE);
      if (windowManager == null) {
        return null;
      }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        Rect bounds = windowManager.getMaximumWindowMetrics().getBounds();
        return new Extent(bounds.width(), bounds.height());
      }
      return legacyExtent(windowManager);
    } catch (Throwable error) {
      return null;
    }
  }

  @SuppressWarnings("deprecation")
  private static Extent legacyExtent(WindowManager windowManager) {
    Display display = windowManager.getDefaultDisplay();
    DisplayMetrics metrics = new DisplayMetrics();
    display.getRealMetrics(metrics);
    return new Extent(metrics.widthPixels, metrics.heightPixels);
  }

  /**
   * The extent both reads of one capture agreed on, or null when either read failed or the display
   * changed underneath the tree dump. Omitting the viewport on disagreement is what keeps the
   * published box a fact about the capture rather than about two different rotations.
   */
  static Extent whenBothAgree(Extent before, Extent after) {
    if (before == null || after == null) {
      return null;
    }
    if (before.width != after.width || before.height != after.height) {
      return null;
    }
    return before;
  }
}
