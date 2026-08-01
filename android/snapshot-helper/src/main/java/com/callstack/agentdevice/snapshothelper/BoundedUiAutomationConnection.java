package com.callstack.agentdevice.snapshothelper;

import java.util.concurrent.ExecutionException;
import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * Bounds Android's UiAutomation connection independently of the framework call.
 *
 * <p>For modern target SDKs, Instrumentation.getUiAutomation() can apply its own 60-second
 * connection timeout. Running the attempt on a daemon worker keeps the helper's shorter command
 * deadline authoritative even when the framework call does not respond to interruption.
 * Cancellation bounds the caller; it cannot stop a non-cooperative framework call. After a
 * timeout, the session owner must retire the instrumentation process before starting another
 * attempt. Both the persistent-session failure path and one-shot Instrumentation.finish() do so.
 */
final class BoundedUiAutomationConnection {
  private static final long RETRY_INTERVAL_MS = 50;

  interface Attempt<T> {
    T connect();
  }

  private BoundedUiAutomationConnection() {}

  static <T> T await(Attempt<T> attempt, long timeoutMs)
      throws InterruptedException, TimeoutException {
    FutureTask<T> task = new FutureTask<>(() -> connectWhenReady(attempt));
    Thread worker = new Thread(task, "agent-device-ui-automation-connect");
    worker.setDaemon(true);
    worker.start();

    try {
      return task.get(Math.max(1, timeoutMs), TimeUnit.MILLISECONDS);
    } catch (java.util.concurrent.TimeoutException error) {
      task.cancel(true);
      throw new TimeoutException("Timed out waiting for Android UiAutomation to connect");
    } catch (InterruptedException error) {
      task.cancel(true);
      Thread.currentThread().interrupt();
      throw error;
    } catch (ExecutionException error) {
      Throwable cause = error.getCause();
      if (cause instanceof RuntimeException) {
        throw (RuntimeException) cause;
      }
      if (cause instanceof Error) {
        throw (Error) cause;
      }
      throw new IllegalStateException("Android UiAutomation connection failed", cause);
    }
  }

  private static <T> T connectWhenReady(Attempt<T> attempt) throws InterruptedException {
    while (true) {
      T connection = attempt.connect();
      if (connection != null) {
        return connection;
      }
      Thread.sleep(RETRY_INTERVAL_MS);
    }
  }
}
