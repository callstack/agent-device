package com.callstack.agentdevice.snapshothelper;

import android.accessibilityservice.AccessibilityServiceInfo;
import android.app.UiAutomation;
import android.os.Build;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeoutException;

/** Captures and serializes the Android accessibility window tree. */
final class AccessibilityTreeCapture {
  static final long DEFAULT_WAIT_FOR_IDLE_TIMEOUT_MS = 500;
  static final long DEFAULT_WAIT_FOR_IDLE_QUIET_MS = 100;
  private static final long WINDOW_LIST_SETTLE_TIMEOUT_MS = 1_000;

  private AccessibilityTreeCapture() {}

  static void prepare(UiAutomation automation) throws InterruptedException {
    prepare(automation, DEFAULT_WAIT_FOR_IDLE_QUIET_MS, DEFAULT_WAIT_FOR_IDLE_TIMEOUT_MS);
  }

  static void prepare(UiAutomation automation, long quietMs, long timeoutMs)
      throws InterruptedException {
    enableInteractiveWindowRetrieval(automation);
    if (timeoutMs > 0) {
      try {
        automation.waitForIdle(Math.min(quietMs, timeoutMs), timeoutMs);
      } catch (TimeoutException ignored) {
        // A busy accessibility stream can still expose usable windows and nodes.
      }
    }
  }

  static Result capture(
      UiAutomation automation, int maxDepth, int maxNodes, long stabilizationTimeoutMs)
      throws InterruptedException, AccessibilityCaptureStabilizer.IncompleteCaptureException {
    return AccessibilityCaptureStabilizer.capture(
        () -> captureOnce(automation, maxDepth, maxNodes), stabilizationTimeoutMs);
  }

  @SuppressWarnings("deprecation")
  private static Result captureOnce(UiAutomation automation, int maxDepth, int maxNodes) {
    boolean cacheInvalidated = clearAccessibilityCache(automation);
    AccessibilityTreeXml.Stats stats = new AccessibilityTreeXml.Stats();
    StringBuilder xml = new StringBuilder();
    xml.append("<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>");
    xml.append("<hierarchy rotation=\"0\">");
    List<Integer> missingRootWindowTypes = new ArrayList<>();
    int windowCount =
        appendInteractiveWindowRoots(
            xml, automation, maxDepth, maxNodes, stats, missingRootWindowTypes);
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
        stats.truncated,
        missingRootWindowTypes,
        cacheInvalidated);
  }

  static boolean clearAccessibilityCache(UiAutomation automation) {
    // Navigation 3 and any in-place content swap that keeps the same window/Activity render every
    // destination inside one AndroidComposeView. A persistent helper session reuses a single
    // UiAutomation connection across captures, and its per-connection accessibility node cache is
    // not always invalidated by such a swap. Drop the cache before each traversal.
    //
    // Declared residue (agent-device #1832): the reset mechanism differs by API level — the public
    // clearCache() on 34+, a setServiceInfo() re-apply below — and the two are not known to be
    // equivalent. Only the public cache reset establishes cacheInvalidated evidence.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      try {
        return automation.clearCache();
      } catch (RuntimeException ignored) {
        // Fall back to the setServiceInfo() flush below if the platform rejects the public API.
      }
    }
    clearAccessibilityCacheViaServiceInfo(automation);
    return false;
  }

  private static void clearAccessibilityCacheViaServiceInfo(UiAutomation automation) {
    // Before API 34, re-applying service info is the supported public-API cache reset.
    try {
      automation.setServiceInfo(automation.getServiceInfo());
    } catch (RuntimeException ignored) {
      // Best-effort: proceed when this platform cannot reset the cache.
    }
  }

  /**
   * Turns on interactive-window retrieval and, when this call turned it on, waits a bounded time for
   * the window list to name an active window. The platform fills the list after the flag is set, so
   * a read straight after it can list only the status bar and none of the app's windows.
   */
  private static void enableInteractiveWindowRetrieval(UiAutomation automation)
      throws InterruptedException {
    if (!turnOnInteractiveWindowRetrieval(automation)) {
      return;
    }
    try {
      AccessibilityCaptureStabilizer.capture(
          () -> () -> listsActiveWindow(automation), WINDOW_LIST_SETTLE_TIMEOUT_MS);
    } catch (AccessibilityCaptureStabilizer.IncompleteCaptureException ignored) {
      // Capture what the platform lists; the host judges whether it holds the app.
    }
  }

  private static boolean turnOnInteractiveWindowRetrieval(UiAutomation automation) {
    AccessibilityServiceInfo serviceInfo;
    try {
      serviceInfo = automation.getServiceInfo();
    } catch (RuntimeException error) {
      return false;
    }
    if (serviceInfo == null
        || (serviceInfo.flags & AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS) != 0) {
      return false;
    }
    serviceInfo.flags |= AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS;
    try {
      automation.setServiceInfo(serviceInfo);
      return true;
    } catch (RuntimeException ignored) {
      // Fall back to active-window capture if the platform rejects dynamic service flags.
      return false;
    }
  }

  @SuppressWarnings("deprecation")
  private static boolean listsActiveWindow(UiAutomation automation) {
    List<AccessibilityWindowInfo> windows;
    try {
      windows = automation.getWindows();
    } catch (RuntimeException error) {
      return false;
    }
    boolean active = false;
    for (AccessibilityWindowInfo window : windows) {
      active |= isActiveWindow(window);
      window.recycle();
    }
    return active;
  }

  @SuppressWarnings("deprecation")
  private static int appendInteractiveWindowRoots(
      StringBuilder xml,
      UiAutomation automation,
      int maxDepth,
      int maxNodes,
      AccessibilityTreeXml.Stats stats,
      List<Integer> missingRootWindowTypes) {
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
        root = AccessibilityNodeReads.root(window);
        if (root == null) {
          missingRootWindowTypes.add(windowMetadata.type);
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
        if (windowMetadata != null) {
          missingRootWindowTypes.add(windowMetadata.type);
        }
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
    final boolean cacheInvalidated;
    // AccessibilityWindowInfo types of listed windows whose root read null or threw, so the host
    // can tell a window it could not read (an input method, say) from one that was not on screen.
    final List<Integer> missingRootWindowTypes;

    Result(
        String xml,
        boolean rootPresent,
        boolean foregroundWindowRootsPresent,
        String captureMode,
        int windowCount,
        int nodeCount,
        boolean truncated,
        List<Integer> missingRootWindowTypes,
        boolean cacheInvalidated) {
      this.xml = xml;
      this.rootPresent = rootPresent;
      this.foregroundWindowRootsPresent = foregroundWindowRootsPresent;
      this.captureMode = captureMode;
      this.windowCount = windowCount;
      this.nodeCount = nodeCount;
      this.truncated = truncated;
      this.cacheInvalidated = cacheInvalidated;
      this.missingRootWindowTypes = missingRootWindowTypes;
    }

    @Override
    public boolean isComplete() {
      return rootPresent && foregroundWindowRootsPresent;
    }
  }

}
