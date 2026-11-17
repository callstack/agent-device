package com.callstack.agentdevice.snapshothelper;

import android.app.UiAutomation;
import android.view.InputEvent;
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

  /** Whether injection skips the framework's animation wait on this runtime. */
  static boolean skipsAnimationWait() {
    return injectWithoutAnimationWait != null;
  }

  /**
   * Waits for the framework's animation sync. Returns false when the runtime does not expose or
   * permit the separate sync.
   */
  static boolean awaitAnimations(UiAutomation automation) {
    Method method = syncInputTransactions;
    if (method == null) return false;
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
