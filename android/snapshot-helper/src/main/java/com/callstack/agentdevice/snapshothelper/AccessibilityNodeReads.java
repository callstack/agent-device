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

  static AccessibilityNodeInfo root(AccessibilityWindowInfo window) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      return window.getRoot(PREFETCH_STRATEGY);
    }
    return window.getRoot();
  }

  static AccessibilityNodeInfo child(AccessibilityNodeInfo node, int index) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      return node.getChild(index, PREFETCH_STRATEGY);
    }
    return node.getChild(index);
  }
}
