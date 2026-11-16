package com.callstack.agentdevice.snapshothelper;

import android.app.UiAutomation;
import android.os.SystemClock;
import android.view.InputDevice;
import android.view.InputEvent;
import android.view.MotionEvent;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;

/**
 * Dispatches input without the framework's global animation synchronization.
 *
 * <p>The public two-argument overload waits for global animations before a gesture's first event
 * and after its last one, up to five seconds each. Android's three-argument test API separates that
 * policy from synchronous input dispatch, but the SDK stub hides the method, so the helper resolves
 * it from the runtime framework.
 */
final class UiAutomationInputDispatcher {
  private static volatile Method injectWithoutAnimationWait = findInjectWithoutAnimationWait();
  private static volatile Method syncInputTransactions = findSyncInputTransactions();

  private UiAutomationInputDispatcher() {}

  static boolean inject(UiAutomation automation, InputEvent event, boolean waitForDispatch) {
    Method method = injectWithoutAnimationWait;
    if (method == null) return automation.injectInputEvent(event, waitForDispatch);
    try {
      return (Boolean) method.invoke(automation, event, waitForDispatch, false);
    } catch (IllegalAccessException | IllegalArgumentException error) {
      // Older or restricted runtimes retain the public, slower compatibility path.
      injectWithoutAnimationWait = null;
      return automation.injectInputEvent(event, waitForDispatch);
    } catch (InvocationTargetException error) {
      rethrowCause(error.getCause());
      throw new AssertionError("Unreachable");
    }
  }

  /**
   * Closes the verifier state of a refused touch DOWN with an ACTION_CANCEL. The verifier records a
   * dropped DOWN as a pointer that is still down; no window holds the touch to receive the cancel.
   */
  static void cancelRefusedDown(UiAutomation automation, long downTime, float x, float y) {
    MotionEvent.PointerProperties[] properties = {new MotionEvent.PointerProperties()};
    properties[0].id = 0;
    MotionEvent.PointerCoords[] coords = {new MotionEvent.PointerCoords()};
    coords[0].x = x;
    coords[0].y = y;
    MotionEvent cancel = MotionEvent.obtain(downTime, SystemClock.uptimeMillis(),
        MotionEvent.ACTION_CANCEL, 1, properties, coords, 0, 0, 1f, 1f, 0, 0,
        InputDevice.SOURCE_TOUCHSCREEN, MotionEvent.FLAG_CANCELED);
    try {
      inject(automation, cancel, false);
    } finally {
      cancel.recycle();
    }
  }

  /**
   * Waits for the framework's animation sync before a refused start is retried. The sync is
   * {@code ALREADY_WAITED} when injection runs through the public overload, and {@code UNAVAILABLE}
   * when injection skips the wait but the runtime does not expose or permit the separate sync.
   */
  static PressSequence.AnimationSync awaitAnimations(UiAutomation automation) {
    if (injectWithoutAnimationWait == null) return PressSequence.AnimationSync.ALREADY_WAITED;
    Method method = syncInputTransactions;
    if (method == null) return PressSequence.AnimationSync.UNAVAILABLE;
    try {
      method.invoke(automation);
      return PressSequence.AnimationSync.WAITED;
    } catch (IllegalAccessException | IllegalArgumentException error) {
      syncInputTransactions = null;
      return PressSequence.AnimationSync.UNAVAILABLE;
    } catch (InvocationTargetException error) {
      rethrowCause(error.getCause());
      throw new AssertionError("Unreachable");
    }
  }

  private static Method findInjectWithoutAnimationWait() {
    try {
      return UiAutomation.class.getMethod(
          "injectInputEvent", InputEvent.class, boolean.class, boolean.class);
    } catch (NoSuchMethodException | SecurityException error) {
      return null;
    }
  }

  private static Method findSyncInputTransactions() {
    try {
      return UiAutomation.class.getMethod("syncInputTransactions");
    } catch (NoSuchMethodException | SecurityException error) {
      return null;
    }
  }

  private static void rethrowCause(Throwable cause) {
    if (cause instanceof RuntimeException) throw (RuntimeException) cause;
    if (cause instanceof Error) throw (Error) cause;
    throw new IllegalStateException("UiAutomation input injection failed", cause);
  }
}
