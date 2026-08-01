package com.callstack.agentdevice.snapshothelper;

import android.accessibilityservice.AccessibilityServiceInfo;
import android.app.UiAutomation;
import android.os.Build;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;
import java.util.List;

/** Captures and serializes the Android accessibility window tree. */
final class AccessibilityTreeCapture {
  private AccessibilityTreeCapture() {}

  static Result capture(
      UiAutomation automation, int maxDepth, int maxNodes, long stabilizationTimeoutMs)
      throws InterruptedException, AccessibilityCaptureStabilizer.IncompleteCaptureException {
    clearAccessibilityCache(automation);
    return AccessibilityCaptureStabilizer.capture(
        () -> captureOnce(automation, maxDepth, maxNodes), stabilizationTimeoutMs);
  }

  @SuppressWarnings("deprecation")
  private static Result captureOnce(UiAutomation automation, int maxDepth, int maxNodes) {
    AccessibilityTreeXml.Stats stats = new AccessibilityTreeXml.Stats();
    StringBuilder xml = new StringBuilder();
    xml.append("<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>");
    xml.append("<hierarchy rotation=\"0\">");
    int windowCount = appendInteractiveWindowRoots(xml, automation, maxDepth, maxNodes, stats);
    String captureMode = "interactive-windows";
    if (AccessibilityCaptureStabilizer.requiresActiveWindowFallback(
        windowCount, stats.activeWindowRootMissing)) {
      boolean hasInteractiveWindowRoot = windowCount > 0;
      AccessibilityNodeInfo root = automation.getRootInActiveWindow();
      try {
        AccessibilityTreeXml.WindowMetadata fallbackMetadata =
            stats.activeWindowMetadata == null
                ? null
                : stats.activeWindowMetadata.withIndex(windowCount);
        if (root != null
            && AccessibilityCaptureStabilizer.canAppendActiveWindowFallback(
                windowCount, fallbackMetadata != null)) {
          AccessibilityTreeXml.appendNode(
              xml, root, windowCount, 0, maxDepth, maxNodes, stats, fallbackMetadata);
          windowCount += 1;
          stats.activeWindowRootMissing = false;
        }
        if (!hasInteractiveWindowRoot) {
          captureMode = "active-window";
        }
      } finally {
        if (root != null) {
          root.recycle();
        }
      }
    }
    xml.append("</hierarchy>");
    return new Result(
        xml.toString(),
        windowCount > 0,
        !stats.activeWindowRootMissing && !stats.focusedNonActiveWindowRootMissing,
        captureMode,
        windowCount,
        stats.nodeCount,
        stats.truncated);
  }

  private static void clearAccessibilityCache(UiAutomation automation) {
    // Navigation 3 and any in-place content swap that keeps the same window/Activity render every
    // destination inside one AndroidComposeView. A persistent helper session reuses a single
    // UiAutomation connection across captures, and its per-connection accessibility node cache is
    // not always invalidated by such a swap. Drop the cache before each traversal.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      try {
        automation.clearCache();
        return;
      } catch (RuntimeException ignored) {
        // Fall back to the setServiceInfo() flush below if the platform rejects the public API.
      }
    }
    clearAccessibilityCacheViaServiceInfo(automation);
  }

  private static void clearAccessibilityCacheViaServiceInfo(UiAutomation automation) {
    // Before API 34, re-applying service info is the supported public-API cache reset.
    try {
      automation.setServiceInfo(automation.getServiceInfo());
    } catch (RuntimeException ignored) {
      // Best-effort: proceed when this platform cannot reset the cache.
    }
  }

  static void enableInteractiveWindowRetrieval(UiAutomation automation) {
    AccessibilityServiceInfo serviceInfo;
    try {
      serviceInfo = automation.getServiceInfo();
    } catch (RuntimeException error) {
      return;
    }
    if (serviceInfo == null
        || (serviceInfo.flags & AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS) != 0) {
      return;
    }
    serviceInfo.flags |= AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS;
    try {
      automation.setServiceInfo(serviceInfo);
    } catch (RuntimeException ignored) {
      // Fall back to active-window capture if the platform rejects dynamic service flags.
    }
  }

  @SuppressWarnings("deprecation")
  private static int appendInteractiveWindowRoots(
      StringBuilder xml,
      UiAutomation automation,
      int maxDepth,
      int maxNodes,
      AccessibilityTreeXml.Stats stats) {
    List<AccessibilityWindowInfo> windows;
    try {
      windows = automation.getWindows();
    } catch (RuntimeException error) {
      return 0;
    }
    int windowCount = 0;
    for (int index = 0; index < windows.size(); index += 1) {
      if (stats.nodeCount >= maxNodes) {
        stats.truncated = true;
        break;
      }
      AccessibilityWindowInfo window = windows.get(index);
      AccessibilityNodeInfo root = null;
      boolean activeWindow = isActiveWindow(window);
      boolean focusedNonActiveWindow = !activeWindow && isFocusedWindow(window);
      AccessibilityTreeXml.WindowMetadata windowMetadata = null;
      try {
        windowMetadata = AccessibilityTreeXml.readWindowMetadata(window, windowCount);
        root = window.getRoot();
        if (root == null) {
          stats.activeWindowRootMissing |= activeWindow;
          stats.focusedNonActiveWindowRootMissing |= focusedNonActiveWindow;
          if (activeWindow) {
            stats.activeWindowMetadata = windowMetadata;
          }
          continue;
        }
        StringBuilder windowXml = new StringBuilder();
        AccessibilityTreeXml.Stats windowStats = stats.copy();
        AccessibilityTreeXml.appendNode(
            windowXml,
            root,
            windowCount,
            0,
            maxDepth,
            maxNodes,
            windowStats,
            windowMetadata);
        xml.append(windowXml);
        stats.copyFrom(windowStats);
        windowCount += 1;
      } catch (RuntimeException ignored) {
        // Accessibility windows can disappear while traversing; keep the rest of the snapshot.
        stats.activeWindowRootMissing |= activeWindow;
        stats.focusedNonActiveWindowRootMissing |= focusedNonActiveWindow;
        if (activeWindow && windowMetadata != null) {
          stats.activeWindowMetadata = windowMetadata;
        }
      } finally {
        if (root != null) {
          root.recycle();
        }
        window.recycle();
      }
    }
    return windowCount;
  }

  private static boolean isActiveWindow(AccessibilityWindowInfo window) {
    try {
      return window.isActive();
    } catch (RuntimeException ignored) {
      return false;
    }
  }

  private static boolean isFocusedWindow(AccessibilityWindowInfo window) {
    try {
      return window.isFocused();
    } catch (RuntimeException ignored) {
      return false;
    }
  }

  static final class Result implements AccessibilityCaptureStabilizer.Capture {
    final String xml;
    final boolean rootPresent;
    final boolean foregroundWindowRootsPresent;
    final String captureMode;
    final int windowCount;
    final int nodeCount;
    final boolean truncated;

    Result(
        String xml,
        boolean rootPresent,
        boolean foregroundWindowRootsPresent,
        String captureMode,
        int windowCount,
        int nodeCount,
        boolean truncated) {
      this.xml = xml;
      this.rootPresent = rootPresent;
      this.foregroundWindowRootsPresent = foregroundWindowRootsPresent;
      this.captureMode = captureMode;
      this.windowCount = windowCount;
      this.nodeCount = nodeCount;
      this.truncated = truncated;
    }

    @Override
    public boolean isComplete() {
      return rootPresent && foregroundWindowRootsPresent;
    }
  }

}
