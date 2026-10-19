package com.callstack.agentdevice.snapshothelper;

import android.app.UiAutomation;
import android.graphics.Bitmap;
import android.graphics.Rect;
import android.os.Bundle;
import android.os.SystemClock;
import android.util.Base64;
import android.view.InputDevice;
import android.view.KeyCharacterMap;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

/** Executes session input and image capture inside the instrumentation's automation context. */
final class AutomationCommandHandler {
  private AutomationCommandHandler() {}

  static void writeSessionResponse(
      OutputStream output, String requestId, String action, String payload, UiAutomation automation)
      throws IOException {
    Bundle result = SessionResponseWriter.sessionResponseBundle(requestId);
    InputDispatch dispatch = new InputDispatch();
    try {
      if ("screenshot".equals(action)) {
        screenshot(result, automation);
      } else if ("focus".equals(action)) {
        focus(result, automation);
      } else {
        input(automation, new JSONObject(new String(Base64.decode(payload, Base64.DEFAULT), StandardCharsets.UTF_8)), dispatch);
      }
      result.putString("ok", "true");
      SessionResponseWriter.writeSessionResponse(output, result, "");
    } catch (Throwable error) {
      result.putString("ok", "false");
      result.putString("errorType", error.getClass().getName());
      result.putString("message", error.getMessage() == null ? error.getClass().getName() : error.getMessage());
      if ("input".equals(action) && !dispatch.attempted) result.putString("injected", "false");
      SessionResponseWriter.writeSessionResponse(output, result, "");
    }
  }

  private static final class InputDispatch {
    boolean attempted;
  }

  private static void input(UiAutomation automation, JSONObject input, InputDispatch dispatch) throws Exception {
    switch (input.getString("kind")) {
      case "tap":
        tap(automation, input.getDouble("x"), input.getDouble("y"), dispatch);
        return;
      case "key":
        key(automation, input.getInt("keyCode"), dispatch);
        return;
      case "fill":
        fill(automation, input.getInt("x"), input.getInt("y"), input.getString("text"), dispatch);
        return;
      default:
        throw new IllegalArgumentException("Unknown input kind");
    }
  }

  private static void tap(UiAutomation automation, double x, double y, InputDispatch dispatch) {
    if (Double.isNaN(x) || Double.isInfinite(x) || Double.isNaN(y) || Double.isInfinite(y)
        || x < 0 || y < 0) {
      throw new IllegalArgumentException("Invalid tap coordinates");
    }
    long down = SystemClock.uptimeMillis();
    touch(automation, down, MotionEvent.ACTION_DOWN, (float) x, (float) y, dispatch);
    touch(automation, down, MotionEvent.ACTION_UP, (float) x, (float) y, dispatch);
  }

  private static void touch(UiAutomation automation, long down, int action, float x, float y, InputDispatch dispatch) {
    MotionEvent event = MotionEvent.obtain(down, SystemClock.uptimeMillis(), action, x, y, 0);
    event.setSource(InputDevice.SOURCE_TOUCHSCREEN);
    try {
      dispatch.attempted = true;
      if (!automation.injectInputEvent(event, true)) {
        throw new IllegalStateException("Touch injection was refused");
      }
    } finally {
      event.recycle();
    }
  }

  private static void key(UiAutomation automation, int code, InputDispatch dispatch) {
    if (code < 0 || code > KeyEvent.getMaxKeyCode()) throw new IllegalArgumentException("Invalid key code");
    long down = SystemClock.uptimeMillis();
    for (int action : new int[] {KeyEvent.ACTION_DOWN, KeyEvent.ACTION_UP}) {
      KeyEvent event = new KeyEvent(down, SystemClock.uptimeMillis(), action, code, 0, 0,
          KeyCharacterMap.VIRTUAL_KEYBOARD, 0, 0, InputDevice.SOURCE_KEYBOARD);
      dispatch.attempted = true;
      if (!automation.injectInputEvent(event, true)) {
        throw new IllegalStateException("Key injection was refused");
      }
    }
  }

  private static void fill(UiAutomation automation, int x, int y, String text, InputDispatch dispatch) {
    AccessibilityNodeInfo target = null;
    try {
      for (AccessibilityWindowInfo window : automation.getWindows()) {
        try {
          if (window.getType() == AccessibilityWindowInfo.TYPE_INPUT_METHOD) continue;
          AccessibilityNodeInfo root = AccessibilityNodeReads.root(window);
          if (root == null) continue;
          AccessibilityNodeInfo candidate;
          try {
            candidate = editableAtPoint(root, x, y, 0);
          } finally {
            root.recycle();
          }
          if (candidate == null) continue;
          if (target != null) {
            candidate.recycle();
            throw new IllegalStateException("Multiple editable fields at the fill point");
          }
          target = candidate;
        } finally {
          window.recycle();
        }
      }
      if (target == null) throw new IllegalStateException("No editable field at the fill point");
      tap(automation, x, y, dispatch);
      if (!target.refresh()) throw new IllegalStateException("Fill target disappeared after focus");
      if (!target.isFocused() && !target.performAction(AccessibilityNodeInfo.ACTION_FOCUS)) {
        throw new IllegalStateException("Field focus was refused");
      }
      Bundle arguments = new Bundle();
      arguments.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text);
      if (!target.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, arguments)) {
        throw new IllegalStateException("Field text replacement was refused");
      }
    } finally {
      if (target != null) target.recycle();
    }
  }

  private static AccessibilityNodeInfo editableAtPoint(AccessibilityNodeInfo node, int x, int y, int depth) {
    if (depth > 128) throw new IllegalStateException("Fill target traversal exceeded its depth limit");
    Rect bounds = new Rect();
    node.getBoundsInScreen(bounds);
    AccessibilityNodeInfo target = null;
    try {
      for (int i = 0; i < node.getChildCount(); i++) {
        AccessibilityNodeInfo child = AccessibilityNodeReads.child(node, i);
        if (child == null) continue;
        AccessibilityNodeInfo candidate;
        try {
          candidate = editableAtPoint(child, x, y, depth + 1);
        } finally {
          child.recycle();
        }
        if (candidate == null) continue;
        if (target != null) {
          candidate.recycle();
          throw new IllegalStateException("Multiple editable fields at the fill point");
        }
        target = candidate;
      }
      if (target != null) {
        AccessibilityNodeInfo found = target;
        target = null;
        return found;
      }
      return node.isEditable() && node.isEnabled() && node.isVisibleToUser() && bounds.contains(x, y)
          ? AccessibilityNodeInfo.obtain(node) : null;
    } finally {
      if (target != null) target.recycle();
    }
  }

  private static void screenshot(Bundle result, UiAutomation automation) {
    Bitmap image = automation.takeScreenshot();
    if (image == null) throw new IllegalStateException("Screen capture was unavailable");
    try {
      ByteArrayOutputStream bytes = new ByteArrayOutputStream();
      if (!image.compress(Bitmap.CompressFormat.PNG, 100, bytes)) {
        throw new IllegalStateException("PNG encoding failed");
      }
      result.putString("payloadBase64", Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP));
    } finally {
      image.recycle();
    }
  }

  private static void focus(Bundle result, UiAutomation automation) throws Exception {
    AccessibilityTreeCapture.prepare(automation, 0, 0);
    AccessibilityTreeCapture.clearAccessibilityCache(automation);
    for (AccessibilityWindowInfo window : automation.getWindows()) {
      try {
        if (!window.isFocused()) continue;
        result.putString("windowType", Integer.toString(window.getType()));
        AccessibilityNodeInfo root = AccessibilityNodeReads.rootWithoutPrefetch(window);
        if (root == null) continue;
        try {
          CharSequence packageName = root.getPackageName();
          if (packageName != null) result.putString("focusedPackage", packageName.toString());
        } finally {
          root.recycle();
        }
      } finally {
        window.recycle();
      }
    }
  }
}
