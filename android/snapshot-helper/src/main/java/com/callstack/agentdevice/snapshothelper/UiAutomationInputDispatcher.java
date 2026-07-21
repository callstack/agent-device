package com.callstack.agentdevice.snapshothelper;

import android.app.UiAutomation;
import android.view.InputEvent;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;

/**
 * Dispatches planned input without the framework's global animation synchronization.
 *
 * <p>The public two-argument overload waits for global animations before every event. Android's
 * three-argument test API separates that policy from synchronous input dispatch, but the SDK stub
 * hides the method, so the helper resolves it from the runtime framework.
 */
final class UiAutomationInputDispatcher {
  private static volatile Method injectWithoutAnimationWait = findInjectWithoutAnimationWait();

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

  private static Method findInjectWithoutAnimationWait() {
    try {
      return UiAutomation.class.getMethod(
          "injectInputEvent", InputEvent.class, boolean.class, boolean.class);
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
