package com.callstack.agentdevice.snapshothelper;

import android.app.UiAutomation;
import android.graphics.Rect;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;
import java.util.List;
import java.util.concurrent.TimeoutException;

/** Resolves the active application window bounds used to validate planned gestures. */
final class GestureViewportReader {
  private GestureViewportReader() {}

  @SuppressWarnings("deprecation")
  static Rect read(UiAutomation automation) {
    try {
      automation.waitForIdle(100, 2_000);
    } catch (TimeoutException ignored) {
      // Window/root state can still be usable when the app is animating continuously.
    }
    // UiAutomation.getWindows() transfers recyclable AccessibilityWindowInfo instances, and this
    // read runs repeatedly inside the persistent helper session: copy the bounds the precedence
    // below needs, then recycle every window before resolving.
    Rect activeBounds = null;
    Rect fallbackBounds = null;
    List<AccessibilityWindowInfo> windows = automation.getWindows();
    try {
      for (AccessibilityWindowInfo window : windows) {
        if (window.getType() != AccessibilityWindowInfo.TYPE_APPLICATION) continue;
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
