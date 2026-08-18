package com.callstack.agentdevice.snapshothelper;

import android.graphics.Rect;
import android.os.Build;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityNodeInfo.AccessibilityAction;
import android.view.accessibility.AccessibilityWindowInfo;
import java.util.List;
import java.util.Locale;

/** Serializes accessibility nodes using the helper's host-consumed XML contract. */
final class AccessibilityTreeXml {
  private AccessibilityTreeXml() {}

  @SuppressWarnings("deprecation")
  static void appendNode(
      StringBuilder xml,
      AccessibilityNodeInfo node,
      int nodeIndex,
      int depth,
      int maxDepth,
      int maxNodes,
      Stats stats,
      WindowMetadata windowMetadata) {
    if (stats.nodeCount >= maxNodes) {
      stats.truncated = true;
      return;
    }
    stats.nodeCount += 1;
    Rect bounds = new Rect();
    node.getBoundsInScreen(bounds);
    xml.append("<node");
    appendAttribute(xml, "index", Integer.toString(nodeIndex));
    if (windowMetadata != null) {
      appendWindowMetadata(xml, windowMetadata);
    }
    appendNonEmptyAttribute(xml, "text", node.getText());
    appendNonEmptyAttribute(xml, "resource-id", node.getViewIdResourceName());
    appendAttribute(xml, "class", node.getClassName());
    appendNonEmptyAttribute(xml, "package", node.getPackageName());
    appendNonEmptyAttribute(xml, "content-desc", node.getContentDescription());
    appendAttribute(xml, "visible-to-user", Boolean.toString(node.isVisibleToUser()));
    appendDrawingOrderAttribute(xml, node);
    appendTrueAttribute(xml, "clickable", node.isClickable());
    appendAttribute(xml, "enabled", Boolean.toString(node.isEnabled()));
    appendTrueAttribute(xml, "focusable", node.isFocusable());
    appendTrueAttribute(xml, "focused", node.isFocused());
    boolean scrollable = node.isScrollable();
    if (scrollable) {
      appendAttribute(xml, "scrollable", "true");
      appendAttribute(
          xml,
          "can-scroll-forward",
          Boolean.toString(
              hasAccessibilityAction(node, AccessibilityAction.ACTION_SCROLL_FORWARD)));
      appendAttribute(
          xml,
          "can-scroll-backward",
          Boolean.toString(
              hasAccessibilityAction(node, AccessibilityAction.ACTION_SCROLL_BACKWARD)));
    }
    appendTrueAttribute(xml, "password", node.isPassword());
    appendAttribute(
        xml,
        "bounds",
        String.format(
            Locale.ROOT,
            "[%d,%d][%d,%d]",
            bounds.left,
            bounds.top,
            bounds.right,
            bounds.bottom));

    int childCount = depth >= maxDepth ? 0 : node.getChildCount();
    if (depth >= maxDepth && node.getChildCount() > 0) {
      stats.truncated = true;
    }
    if (childCount <= 0) {
      xml.append(" />");
      return;
    }

    xml.append(">");
    for (int index = 0; index < childCount; index += 1) {
      if (stats.nodeCount >= maxNodes) {
        stats.truncated = true;
        break;
      }
      AccessibilityNodeInfo child = node.getChild(index);
      if (child == null) {
        continue;
      }
      try {
        appendNode(xml, child, index, depth + 1, maxDepth, maxNodes, stats, null);
      } finally {
        child.recycle();
      }
    }
    xml.append("</node>");
  }

  @SuppressWarnings("deprecation")
  static WindowMetadata readWindowMetadata(AccessibilityWindowInfo window, int index) {
    Rect bounds = new Rect();
    window.getBoundsInScreen(bounds);
    return new WindowMetadata(
        index, window.getType(), window.getLayer(), window.isActive(), window.isFocused(), bounds);
  }

  private static void appendNonEmptyAttribute(
      StringBuilder xml, String name, CharSequence value) {
    if (value == null || value.length() == 0) {
      return;
    }
    appendAttribute(xml, name, value);
  }

  private static void appendTrueAttribute(StringBuilder xml, String name, boolean value) {
    if (value) {
      appendAttribute(xml, name, "true");
    }
  }

  // Declared residue (agent-device #1832): checked / checkable / selected / long-clickable are not
  // serialized, so toggle and selection state is invisible to agents. Adding them is a helper
  // protocol change (new attributes + host parser + fields on the wire node), tracked there.
  private static void appendDrawingOrderAttribute(StringBuilder xml, AccessibilityNodeInfo node) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
      appendAttribute(xml, "drawing-order", Integer.toString(node.getDrawingOrder()));
    }
  }

  private static void appendWindowMetadata(StringBuilder xml, WindowMetadata metadata) {
    appendAttribute(xml, "window-index", Integer.toString(metadata.index));
    appendAttribute(xml, "window-type", Integer.toString(metadata.type));
    appendAttribute(xml, "window-layer", Integer.toString(metadata.layer));
    appendAttribute(xml, "window-active", Boolean.toString(metadata.active));
    appendAttribute(xml, "window-focused", Boolean.toString(metadata.focused));
    appendAttribute(
        xml,
        "window-bounds",
        String.format(
            Locale.ROOT,
            "[%d,%d][%d,%d]",
            metadata.bounds.left,
            metadata.bounds.top,
            metadata.bounds.right,
            metadata.bounds.bottom));
  }

  private static void appendAttribute(StringBuilder xml, String name, CharSequence value) {
    String stringValue = value == null ? "" : value.toString();
    xml.append(' ');
    xml.append(name);
    xml.append("=\"");
    appendEscaped(xml, stringValue);
    xml.append('"');
  }

  private static boolean hasAccessibilityAction(
      AccessibilityNodeInfo node, AccessibilityAction action) {
    List<AccessibilityAction> actions = node.getActionList();
    return actions != null && actions.contains(action);
  }

  private static void appendEscaped(StringBuilder xml, String value) {
    for (int index = 0; index < value.length(); index += 1) {
      char character = value.charAt(index);
      switch (character) {
        case '&':
          xml.append("&amp;");
          break;
        case '<':
          xml.append("&lt;");
          break;
        case '>':
          xml.append("&gt;");
          break;
        case '"':
          xml.append("&quot;");
          break;
        case '\'':
          xml.append("&apos;");
          break;
        case '\n':
          xml.append("&#10;");
          break;
        case '\r':
          xml.append("&#13;");
          break;
        case '\t':
          xml.append("&#9;");
          break;
        default:
          xml.append(character);
          break;
      }
    }
  }

  static final class Stats {
    int nodeCount;
    boolean truncated;
    boolean activeWindowRootMissing;
    boolean focusedNonActiveWindowRootMissing;
    WindowMetadata activeWindowMetadata;

    Stats copy() {
      Stats next = new Stats();
      next.nodeCount = nodeCount;
      next.truncated = truncated;
      next.activeWindowRootMissing = activeWindowRootMissing;
      next.focusedNonActiveWindowRootMissing = focusedNonActiveWindowRootMissing;
      next.activeWindowMetadata = activeWindowMetadata;
      return next;
    }

    void copyFrom(Stats next) {
      nodeCount = next.nodeCount;
      truncated = next.truncated;
      activeWindowRootMissing = next.activeWindowRootMissing;
      focusedNonActiveWindowRootMissing = next.focusedNonActiveWindowRootMissing;
      activeWindowMetadata = next.activeWindowMetadata;
    }
  }

  static final class WindowMetadata {
    final int index;
    final int type;
    final int layer;
    final boolean active;
    final boolean focused;
    final Rect bounds;

    WindowMetadata(int index, int type, int layer, boolean active, boolean focused, Rect bounds) {
      this.index = index;
      this.type = type;
      this.layer = layer;
      this.active = active;
      this.focused = focused;
      this.bounds = bounds;
    }

    WindowMetadata withIndex(int nextIndex) {
      return new WindowMetadata(nextIndex, type, layer, active, focused, bounds);
    }
  }
}
