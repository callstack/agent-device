package com.callstack.agentdevice.snapshothelper;

import android.app.UiAutomation;
import android.os.SystemClock;
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

  /** Builds the first event of a tap or key press for a down time. */
  interface StartEvent {
    InputEvent obtain(long downTime);
  }

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
   * Synchronously injects the first event of a tap or key press and returns its down time, or -1
   * when the framework refused it. A refused start reached no window: a transition can leave nothing
   * able to receive it. The start is then injected once more after the framework's animation sync,
   * with a fresh down time so the receiver does not measure the wait as a held press.
   */
  static long injectStart(UiAutomation automation, StartEvent start) {
    long downTime = SystemClock.uptimeMillis();
    if (injectStartRecycled(automation, start.obtain(downTime))) return downTime;
    if (!awaitAnimations(automation)) return -1;
    downTime = SystemClock.uptimeMillis();
    return injectStartRecycled(automation, start.obtain(downTime)) ? downTime : -1;
  }

  private static boolean injectStartRecycled(UiAutomation automation, InputEvent event) {
    try {
      if (inject(automation, event, true)) return true;
      // The dispatcher's input verifier records a dropped DOWN as a pointer that is still down.
      // Cancelling it keeps the next DOWN consistent; no window holds the touch to receive it.
      if (event instanceof MotionEvent) cancel(automation, (MotionEvent) event);
      return false;
    } finally {
      if (event instanceof MotionEvent) ((MotionEvent) event).recycle();
    }
  }

  private static void cancel(UiAutomation automation, MotionEvent refused) {
    MotionEvent.PointerProperties[] properties = {new MotionEvent.PointerProperties()};
    MotionEvent.PointerCoords[] coords = {new MotionEvent.PointerCoords()};
    refused.getPointerProperties(0, properties[0]);
    refused.getPointerCoords(0, coords[0]);
    MotionEvent cancel = MotionEvent.obtain(refused.getDownTime(), refused.getEventTime(),
        MotionEvent.ACTION_CANCEL, 1, properties, coords, 0, 0, 1f, 1f, 0, 0,
        refused.getSource(), MotionEvent.FLAG_CANCELED);
    try {
      inject(automation, cancel, false);
    } finally {
      cancel.recycle();
    }
  }

  /** Returns false when injection already waited for animations through the public overload. */
  private static boolean awaitAnimations(UiAutomation automation) {
    Method method = syncInputTransactions;
    if (injectWithoutAnimationWait == null || method == null) return false;
    try {
      method.invoke(automation);
      return true;
    } catch (IllegalAccessException | IllegalArgumentException error) {
      syncInputTransactions = null;
      return false;
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
