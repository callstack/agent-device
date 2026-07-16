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
    List<AccessibilityWindowInfo> windows = automation.getWindows();
    AccessibilityWindowInfo fallback = null;
    for (AccessibilityWindowInfo window : windows) {
      if (window.getType() != AccessibilityWindowInfo.TYPE_APPLICATION) continue;
      if (window.isActive() || window.isFocused()) {
        Rect bounds = new Rect();
        window.getBoundsInScreen(bounds);
        if (!bounds.isEmpty()) return bounds;
      }
      if (fallback == null) fallback = window;
    }
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
    if (fallback != null) {
      Rect bounds = new Rect();
      fallback.getBoundsInScreen(bounds);
      if (!bounds.isEmpty()) return bounds;
    }
    throw new IllegalStateException("Active application interaction viewport is unavailable");
  }
}
