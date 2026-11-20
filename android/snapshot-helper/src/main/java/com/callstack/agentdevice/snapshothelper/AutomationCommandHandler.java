package com.callstack.agentdevice.snapshothelper;

import android.app.UiAutomation;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Rect;
import android.hardware.display.DisplayManager;
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
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

/** Executes session input and image capture inside the instrumentation's automation context. */
final class AutomationCommandHandler {
  private AutomationCommandHandler() {}

  static void writeSessionResponse(
      SessionResponseWriter.FrameSink sink,
      String requestId,
      String action,
      String payload,
      UiAutomation automation,
      Context context)
      throws IOException {
    InputDispatch dispatch = new InputDispatch();
    SessionResponseWriter.respondOnce(
        sink,
        () -> {
          Bundle result = SessionResponseWriter.sessionResponseBundle(requestId);
          if ("app".equals(action)) {
            ApplicationCommandHandler.execute(automation, new JSONObject(new String(Base64.decode(payload, Base64.DEFAULT), StandardCharsets.UTF_8)), result);
          } else if ("screenshot".equals(action)) {
            screenshot(result, automation, context);
          } else if ("focus".equals(action)) {
            focus(result, automation);
          } else {
            input(automation, new JSONObject(new String(Base64.decode(payload, Base64.DEFAULT), StandardCharsets.UTF_8)), dispatch);
          }
          result.putString("ok", "true");
          return SessionResponseWriter.encodeSessionResponse(result, new byte[0]);
        },
        error -> errorFrame(requestId, action, dispatch.attempted, error));
  }

  /**
   * The error frame for a failed automation command. It is built from fresh headers, so a failure
   * while encoding a screenshot never encodes the screenshot again. An input that never reached
   * the injector says so, so the host knows nothing was dispatched.
   */
  static SessionResponseWriter.Frame errorFrame(
      String requestId, String action, boolean inputAttempted, Throwable error) {
    return "input".equals(action) && !inputAttempted
        ? SessionResponseWriter.errorFrame(requestId, error, "injected", "false")
        : SessionResponseWriter.errorFrame(requestId, error);
  }

  private static final class InputDispatch {
    boolean attempted;
  }

  /**
   * The budget of a host that sends none: a provider-supplied helper can be newer than its host, and
   * an older host waits 30 s for input, less the 5 s answer margin. It never affords a retry.
   */
  private static final long OLDER_HOST_BUDGET_MS = 25_000;

  /** The framework's accessibility interaction timeout, AccessibilityInteractionClient. */
  private static final long TEXT_ENTRY_RESERVE_MS = 5_000;

  /** The command deadline left too little time for the next step, so it was not started. */
  static final class InputBudgetExhausted extends IllegalStateException {
    InputBudgetExhausted(String message) {
      super(message);
    }
  }

  /** Refuses text entry the deadline cannot fit, after a focus tap that may have used the budget. */
  static void requireTextEntryTime(long deadline, long now) {
    if (deadline - now < TEXT_ENTRY_RESERVE_MS) {
      throw new InputBudgetExhausted("Fill text was not entered: too little time left after focus");
    }
  }

  private static void input(UiAutomation automation, JSONObject input, InputDispatch dispatch) throws Exception {
    // The host's remaining time for this command bounds every retry decision.
    long deadline =
        SystemClock.uptimeMillis() + input.optLong("budgetMs", OLDER_HOST_BUDGET_MS);
    switch (input.getString("kind")) {
      case "tap":
        tap(automation, input.getDouble("x"), input.getDouble("y"), dispatch, deadline);
        return;
      case "key":
        key(automation, input.getInt("keyCode"), dispatch, deadline);
        return;
      case "fill":
        fill(automation, input.getInt("x"), input.getInt("y"), input.getString("text"), dispatch,
            deadline);
        return;
      default:
        throw new IllegalArgumentException("Unknown input kind");
    }
  }

  private static void tap(
      UiAutomation automation, double x, double y, InputDispatch dispatch, long deadline) {
    if (Double.isNaN(x) || Double.isInfinite(x) || Double.isNaN(y) || Double.isInfinite(y)
        || x < 0 || y < 0) {
      throw new IllegalArgumentException("Invalid tap coordinates");
    }
    dispatch.attempted = true;
    PressSequence.requireDispatched(PressSequence.run(new TouchPress(automation, (float) x, (float) y), deadline), "Touch");
  }

  private static void key(UiAutomation automation, int code, InputDispatch dispatch, long deadline) {
    if (code < 0 || code > KeyEvent.getMaxKeyCode()) throw new IllegalArgumentException("Invalid key code");
    dispatch.attempted = true;
    PressSequence.requireDispatched(PressSequence.run(new KeyPress(automation, code), deadline), "Key");
  }

  private abstract static class Press implements PressSequence.Injections {
    final UiAutomation automation;

    Press(UiAutomation automation) {
      this.automation = automation;
    }

    @Override
    public long now() {
      return SystemClock.uptimeMillis();
    }

    @Override
    public boolean skipsAnimationWait() {
      return UiAutomationInputDispatcher.skipsAnimationWait();
    }

    @Override
    public boolean awaitAnimations() {
      return UiAutomationInputDispatcher.awaitAnimations(automation);
    }
  }

  private static final class TouchPress extends Press {
    private final float x;
    private final float y;

    TouchPress(UiAutomation automation, float x, float y) {
      super(automation);
      this.x = x;
      this.y = y;
    }

    @Override
    public boolean start(long downTime) {
      return inject(MotionEvent.ACTION_DOWN, downTime, 0, true);
    }

    @Override
    public boolean end(long downTime) {
      return inject(MotionEvent.ACTION_UP, downTime, 0, true);
    }

    /** Not awaited: a window that received a timed-out DOWN may not finish handling the cancel. */
    @Override
    public void releaseRefusedStart(long downTime) {
      inject(MotionEvent.ACTION_CANCEL, downTime, MotionEvent.FLAG_CANCELED, false);
    }

    private boolean inject(int action, long downTime, int flags, boolean waitForDispatch) {
      MotionEvent event = TouchEvents.obtain(
          downTime, SystemClock.uptimeMillis(), action, new float[] {x}, new float[] {y}, flags);
      try {
        return UiAutomationInputDispatcher.inject(automation, event, waitForDispatch);
      } finally {
        event.recycle();
      }
    }
  }

  private static final class KeyPress extends Press {
    private final int code;

    KeyPress(UiAutomation automation, int code) {
      super(automation);
      this.code = code;
    }

    @Override
    public boolean start(long downTime) {
      return inject(KeyEvent.ACTION_DOWN, downTime, 0, true);
    }

    @Override
    public boolean end(long downTime) {
      return inject(KeyEvent.ACTION_UP, downTime, 0, true);
    }

    /**
     * Android releases an interrupted key with an ACTION_UP that carries FLAG_CANCELED; receivers
     * take no action on a canceled up. Not awaited, like the touch cancel.
     */
    @Override
    public void releaseRefusedStart(long downTime) {
      inject(KeyEvent.ACTION_UP, downTime, KeyEvent.FLAG_CANCELED, false);
    }

    private boolean inject(int action, long downTime, int flags, boolean waitForDispatch) {
      return UiAutomationInputDispatcher.inject(
          automation, event(action, downTime, flags), waitForDispatch);
    }

    private KeyEvent event(int action, long downTime, int flags) {
      return new KeyEvent(downTime, SystemClock.uptimeMillis(), action, code, 0, 0,
          KeyCharacterMap.VIRTUAL_KEYBOARD, 0, flags, InputDevice.SOURCE_KEYBOARD);
    }
  }

  private static void fill(
      UiAutomation automation, int x, int y, String text, InputDispatch dispatch, long deadline) {
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
      tap(automation, x, y, dispatch, deadline);
      requireTextEntryTime(deadline, SystemClock.uptimeMillis());
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

  /**
   * The display count lets the host keep its rule that a device with more than one display reports
   * no rotation. The rotation is published only when a read before and a read after the capture
   * agree, so a rotation landing mid-capture reports none.
   */
  private static void screenshot(Bundle result, UiAutomation automation, Context context) {
    DisplayManager displays = ScreenshotDisplay.displays(context);
    int rotationBefore = ScreenshotDisplay.rotation(displays);
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
    int count = ScreenshotDisplay.count(displays);
    if (count == ScreenshotDisplay.UNKNOWN) return;
    result.putString("displayCount", Integer.toString(count));
    int rotation =
        ScreenshotDisplay.whenBothAgree(rotationBefore, ScreenshotDisplay.rotation(displays));
    if (rotation != ScreenshotDisplay.UNKNOWN) {
      result.putString("displayRotation", Integer.toString(rotation));
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
