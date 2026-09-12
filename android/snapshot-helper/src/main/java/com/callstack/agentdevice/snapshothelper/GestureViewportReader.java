package com.callstack.agentdevice.snapshothelper;

import android.app.UiAutomation;
import android.graphics.Rect;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;
import java.util.List;
import java.util.concurrent.TimeoutException;

/**
 * Resolves the active application window bounds used to validate planned gestures, plus the input
 * method window's bounds when one is on screen. The keyboard half is what lets a scroll keep its
 * swipe above the keys instead of flinging into them (#2500): the same {@code getWindows()} pass
 * already lists {@code TYPE_INPUT_METHOD}, so reading it costs no extra automation round trip, and
 * it is the live window list rather than a cached frame.
 */
final class GestureViewportReader {
  private GestureViewportReader() {}

  /** The application viewport a gesture may target, and the IME's share of the screen, if any. */
  static final class Reading {
    final Rect application;
    /** Null when no input method window is on screen; an unmeasurable keyboard is not occlusion. */
    final Rect inputMethod;

    Reading(Rect application, Rect inputMethod) {
      this.application = application;
      this.inputMethod = inputMethod;
    }
  }

  @SuppressWarnings("deprecation")
  static Reading readReading(UiAutomation automation) {
    try {
      automation.waitForIdle(100, 2_000);
    } catch (TimeoutException ignored) {
      // Window/root state can still be usable when the app is animating continuously.
    }
    // UiAutomation.getWindows() transfers recyclable AccessibilityWindowInfo instances, and this
    // read runs repeatedly inside the persistent helper session: copy the bounds the precedence
    // below needs, then recycle every window before resolving.
    // UiAutomation.getWindows() answers with an empty list until interactive retrieval is on, which
    // is the same seam the tree capture already uses. Without it this read sees no windows at all and
    // the keyboard below is invisible to it.
    AccessibilityTreeCapture.enableInteractiveWindowRetrieval(automation);
    Rect activeBounds = null;
    Rect fallbackBounds = null;
    Rect inputMethodBounds = null;
    List<AccessibilityWindowInfo> windows = automation.getWindows();
    try {
      for (AccessibilityWindowInfo window : windows) {
        int type = window.getType();
        if (type == AccessibilityWindowInfo.TYPE_INPUT_METHOD) {
          // Keep the largest IME window: a composer bar and its key plane can be reported as
          // separate windows, and the scroll only needs how far down the free surface reaches.
          Rect bounds = new Rect();
          window.getBoundsInScreen(bounds);
          if (!bounds.isEmpty() && (inputMethodBounds == null || bounds.height() * bounds.width()
              > inputMethodBounds.height() * inputMethodBounds.width())) {
            inputMethodBounds = bounds;
          }
          continue;
        }
        if (type != AccessibilityWindowInfo.TYPE_APPLICATION) continue;
        Rect bounds = new Rect();
        window.getBoundsInScreen(bounds);
        if (activeBounds == null
            && (window.isActive() || window.isFocused())
            && !bounds.isEmpty()) {
          activeBounds = bounds;
        }
        if (fallbackBounds == null) fallbackBounds = bounds;
      }
    } finally {
      for (AccessibilityWindowInfo window : windows) {
        window.recycle();
      }
    }
    return new Reading(resolveApplication(automation, activeBounds, fallbackBounds), inputMethodBounds);
  }

  static Rect read(UiAutomation automation) {
    return readReading(automation).application;
  }

  private static Rect resolveApplication(
      UiAutomation automation, Rect activeBounds, Rect fallbackBounds) {
    if (activeBounds != null) return activeBounds;
    AccessibilityNodeInfo activeRoot = automation.getRootInActiveWindow();
    if (activeRoot != null) {
      try {
        Rect bounds = new Rect();
        activeRoot.getBoundsInScreen(bounds);
        if (!bounds.isEmpty()) return bounds;
      } finally {
        activeRoot.recycle();
      }
    }
    if (fallbackBounds != null && !fallbackBounds.isEmpty()) return fallbackBounds;
    throw new IllegalStateException("Active application interaction viewport is unavailable");
  }
}
