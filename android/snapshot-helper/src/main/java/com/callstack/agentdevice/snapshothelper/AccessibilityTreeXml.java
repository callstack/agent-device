package com.callstack.agentdevice.snapshothelper;

import android.graphics.Rect;
import android.graphics.Region;
import android.os.Build;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityNodeInfo.AccessibilityAction;
import android.view.accessibility.AccessibilityWindowInfo;
import java.util.List;

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
    CharSequence text = node.getText();
    if (text != null) {
      appendAttribute(xml, "text", text);
    }
    // getText() returns the HINT for an empty field on modern Android, so `text` alone cannot
    // distinguish a cleared field from one whose value equals its hint; only this flag can
    // (#2063 empty-fill verification).
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      appendAttribute(xml, "hint-showing", Boolean.toString(node.isShowingHintText()));
      // The hint itself, whether or not the field is showing it: `text` holds the hint only while
      // the field is empty, so a filled field's placeholder is readable nowhere else.
      appendNonEmptyAttribute(xml, "hint", node.getHintText());
    }
    appendAttribute(xml, "editable", Boolean.toString(node.isEditable()));
    // Accessibility selection offsets, not a measurement of the value's length. Read-only
    // selectable text exposes a selection too, so they do not depend on `editable`; -1 = unavailable.
    appendNonNegativeAttribute(xml, "selection-start", node.getTextSelectionStart());
    appendNonNegativeAttribute(xml, "selection-end", node.getTextSelectionEnd());
    appendNonEmptyAttribute(xml, "resource-id", node.getViewIdResourceName());
    appendAttribute(xml, "class", node.getClassName());
    appendNonEmptyAttribute(xml, "package", node.getPackageName());
    appendNonEmptyAttribute(xml, "content-desc", node.getContentDescription());
    appendNonEmptyAttribute(xml, "role-description", roleDescription(node));
    appendTrueAttribute(xml, "heading", isHeading(node));
    appendAttribute(xml, "visible-to-user", Boolean.toString(node.isVisibleToUser()));
    appendDrawingOrderAttribute(xml, node);
    appendTrueAttribute(xml, "clickable", node.isClickable());
    appendAttribute(xml, "enabled", Boolean.toString(node.isEnabled()));
    appendTrueAttribute(xml, "focusable", node.isFocusable());
    appendTrueAttribute(xml, "focused", node.isFocused());
    // Both answers, unlike the omitted-false booleans above: `false` is an observation, while an
    // absent attribute means the helper could not answer. The host keeps that difference, so an
    // unselected control reports selected=false and a helper older than this attribute reports
    // nothing at all.
    appendAttribute(xml, "selected", Boolean.toString(node.isSelected()));
    // Present only on a checkable control, with both answers: an unchecked switch reports
    // checked=false, while a node that cannot be checked reports nothing, like a helper older than
    // this attribute.
    if (node.isCheckable()) {
      appendAttribute(xml, "checked", Boolean.toString(node.isChecked()));
    }
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
    appendAttribute(xml, "password", Boolean.toString(node.isPassword()));
    appendBoundsAttribute(xml, "bounds", bounds.left, bounds.top, bounds.right, bounds.bottom);

    int childCount = depth >= maxDepth ? 0 : node.getChildCount();
    if (depth >= maxDepth && node.getChildCount() > 0) {
      stats.truncated = true;
    }
    if (childCount <= 0) {
      xml.append(" />");
      return;
    }

    xml.append(">");
    int index = 0;
    while (index < childCount && stats.nodeCount < maxNodes) {
      int count = Math.min(
          AccessibilityReadBatch.MAX_READS, Math.min(childCount - index, maxNodes - stats.nodeCount));
      int offset = 0;
      try (AccessibilityReadBatch<AccessibilityNodeInfo> children =
          new AccessibilityReadBatch<>(
              index, count, childIndex -> AccessibilityNodeReads.child(node, childIndex),
              AccessibilityNodeInfo::recycle)) {
        for (; offset < count && stats.nodeCount < maxNodes; offset += 1) {
          AccessibilityNodeInfo child = children.get(offset);
          if (child != null) {
            appendNode(xml, child, index + offset, depth + 1, maxDepth, maxNodes, stats, null);
          }
        }
      }
      index += offset;
    }
    if (index < childCount) {
      stats.truncated = true;
    }
    xml.append("</node>");
  }

  @SuppressWarnings("deprecation")
  static WindowMetadata readWindowMetadata(AccessibilityWindowInfo window, int index) {
    Rect bounds = new Rect();
    window.getBoundsInScreen(bounds);
    int type = window.getType();
    return new WindowMetadata(
        index,
        type,
        window.getLayer(),
        window.isActive(),
        window.isFocused(),
        bounds,
        readInputMethodRegionRect(window, type));
  }

  // The window bounds are the box around the window's touchable region. A floating keyboard's region
  // is several rects (the panel and the gesture strip), so the box claims app content between them;
  // the host must not read such a box as the keyboard band. getRegionInScreen arrived in API 33, so
  // older releases, and a region that reads empty, report nothing and keep the bounds-only answer.
  private static Boolean readInputMethodRegionRect(AccessibilityWindowInfo window, int type) {
    if (type != AccessibilityWindowInfo.TYPE_INPUT_METHOD
        || Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
      return null;
    }
    Region region = new Region();
    window.getRegionInScreen(region);
    return region.isEmpty() ? null : region.isRect();
  }

  private static void appendNonEmptyAttribute(
      StringBuilder xml, String name, CharSequence value) {
    if (value == null || value.length() == 0) {
      return;
    }
    appendAttribute(xml, name, value);
  }

  private static void appendNonNegativeAttribute(StringBuilder xml, String name, int value) {
    if (value >= 0) {
      appendAttribute(xml, name, Integer.toString(value));
    }
  }

  private static void appendTrueAttribute(StringBuilder xml, String name, boolean value) {
    if (value) {
      appendAttribute(xml, name, "true");
    }
  }

  // The platform node has no role description getter: androidx writes the value an app set
  // (AccessibilityNodeInfoCompat.setRoleDescription) into the node extras under this key, and
  // TalkBack reads it from there.
  private static CharSequence roleDescription(AccessibilityNodeInfo node) {
    return node.getExtras().getCharSequence("AccessibilityNodeInfo.roleDescription");
  }

  // isHeading() arrived in API 28. Older releases keep the compat flag in an extras bit this
  // helper does not read, so a heading on API 23-27 reports nothing.
  private static boolean isHeading(AccessibilityNodeInfo node) {
    return Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && node.isHeading();
  }

  // Declared residue (agent-device #1832): long-clickable is not serialized. Adding it is a helper
  // protocol change (new attribute + host parser + field on the wire node).
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
    appendBoundsAttribute(
        xml, "window-bounds", metadata.bounds.left, metadata.bounds.top,
        metadata.bounds.right, metadata.bounds.bottom);
    if (metadata.regionRect != null) {
      appendAttribute(xml, "window-region-rect", Boolean.toString(metadata.regionRect));
    }
  }

  private static void appendAttribute(StringBuilder xml, String name, CharSequence value) {
    String stringValue = value == null ? "" : value.toString();
    xml.append(' ');
    xml.append(name);
    xml.append("=\"");
    appendEscaped(xml, stringValue);
    xml.append('"');
  }

  static void appendBoundsAttribute(
      StringBuilder xml, String name, int left, int top, int right, int bottom) {
    xml.append(' ').append(name).append("=\"[")
        .append(left).append(',').append(top).append("][")
        .append(right).append(',').append(bottom).append("]\"");
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
    // Null unless an input method window's touchable region was read (API 33+).
    final Boolean regionRect;

    WindowMetadata(
        int index,
        int type,
        int layer,
        boolean active,
        boolean focused,
        Rect bounds,
        Boolean regionRect) {
      this.index = index;
      this.type = type;
      this.layer = layer;
      this.active = active;
      this.focused = focused;
      this.bounds = bounds;
      this.regionRect = regionRect;
    }

    WindowMetadata withIndex(int nextIndex) {
      return new WindowMetadata(nextIndex, type, layer, active, focused, bounds, regionRect);
    }
  }
}
