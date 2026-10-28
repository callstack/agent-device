package com.callstack.agentdevice.snapshothelper;

import android.os.Build;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;

/**
 * Reads window roots and children from the app with uninterruptible descendant prefetch.
 *
 * <p>Every read that misses the connection cache is a round trip served on the app's main thread
 * after the frame it is drawing, so on an app that never stops animating each miss costs about a
 * frame. Of the prefetch strategies, uninterruptible depth-first traversed such an app fastest.
 */
final class AccessibilityNodeReads {
  private static final int PREFETCH_STRATEGY =
      AccessibilityNodeInfo.FLAG_PREFETCH_DESCENDANTS_DEPTH_FIRST
          | AccessibilityNodeInfo.FLAG_PREFETCH_UNINTERRUPTIBLE;

  private AccessibilityNodeReads() {}

  static AccessibilityNodeInfo rootWithoutPrefetch(AccessibilityWindowInfo window) {
    return Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
        ? window.getRoot(0) : window.getRoot();
  }

  static AccessibilityNodeInfo root(AccessibilityWindowInfo window) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      return window.getRoot(PREFETCH_STRATEGY);
    }
    return window.getRoot();
  }

  interface Read<T> {
    T read();
  }

  /**
   * The child, or null when it is gone. When the child's window closes during the read, the
   * framework can throw a NullPointerException from its result integrity check instead of answering
   * null (seen on API 35 while an alert dialog closed), so that throw means the same as null.
   *
   * <p>A null {@code node} is a programmer error, but the same catch hides its NullPointerException
   * as a gone child.
   */
  static AccessibilityNodeInfo child(AccessibilityNodeInfo node, int index) {
    return nullIfGone(
        () ->
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                ? node.getChild(index, PREFETCH_STRATEGY)
                : node.getChild(index));
  }

  /** Runs a framework read that answers null for a vanished node and can throw instead. */
  static <T> T nullIfGone(Read<T> read) {
    try {
      return read.read();
    } catch (NullPointerException vanished) {
      return null;
    }
  }
}
