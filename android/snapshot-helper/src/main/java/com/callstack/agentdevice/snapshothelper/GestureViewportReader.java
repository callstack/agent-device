package com.callstack.agentdevice.snapshothelper;

import android.app.UiAutomation;
import android.graphics.Rect;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;
import java.util.ArrayList;
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

  /**
   * One reported window's edges in screen pixels. Plain fields because {@code Rect} is a device type
   * whose constructors throw off-device, and which of several input method windows a swipe strikes is
   * arithmetic that has to be testable without one.
   */
  static final class WindowEdges {
    final int left;
    final int top;
    final int right;
    final int bottom;

    WindowEdges(int left, int top, int right, int bottom) {
      this.left = left;
      this.top = top;
      this.right = right;
      this.bottom = bottom;
    }

    static WindowEdges of(Rect rect) {
      return new WindowEdges(rect.left, rect.top, rect.right, rect.bottom);
    }

    Rect toRect() {
      return new Rect(left, top, right, bottom);
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
    List<WindowEdges> inputMethodWindows = new ArrayList<>();
    List<AccessibilityWindowInfo> windows = automation.getWindows();
    try {
      for (AccessibilityWindowInfo window : windows) {
        int type = window.getType();
        if (type == AccessibilityWindowInfo.TYPE_INPUT_METHOD) {
          // Copy every input method window. Which of them a swipe has to clear depends on the
          // application window, which this loop has not finished reading, so they are collected here
          // and resolved once it has.
          Rect bounds = new Rect();
          window.getBoundsInScreen(bounds);
          if (!bounds.isEmpty()) inputMethodWindows.add(WindowEdges.of(bounds));
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
    Rect application = resolveApplication(automation, activeBounds, fallbackBounds);
    WindowEdges struck = struckInputMethod(
        inputMethodWindows, application == null ? null : WindowEdges.of(application));
    return new Reading(application, struck == null ? null : struck.toRect());
  }

  /**
   * The input method share a swipe has to stay above, or null when none of it is in the way.
   *
   * <p>A composer bar and its key plane can arrive as separate windows, and the larger rectangle is
   * usually the lower key plane: keeping only that leaves the swipe inside the composer reaching
   * further up the screen. So this unions the windows the swipe's centre line crosses — the same line
   * the shared clip rule tests — and ignores the ones beside it that the swipe cannot reach.
   */
  static WindowEdges struckInputMethod(List<WindowEdges> inputMethodWindows, WindowEdges application) {
    WindowEdges struck = null;
    for (WindowEdges bounds : inputMethodWindows) {
      if (application != null) {
        double swipeCenterX = application.left + (application.right - application.left) / 2.0;
        boolean strikesSwipePath = swipeCenterX >= bounds.left && swipeCenterX < bounds.right;
        boolean overlapsWindow = bounds.bottom > application.top && bounds.top < application.bottom;
        if (!strikesSwipePath || !overlapsWindow) continue;
      }
      if (struck == null) {
        struck = bounds;
        continue;
      }
      struck = new WindowEdges(
          Math.min(struck.left, bounds.left),
          Math.min(struck.top, bounds.top),
          Math.max(struck.right, bounds.right),
          Math.max(struck.bottom, bounds.bottom));
    }
    return struck;
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
