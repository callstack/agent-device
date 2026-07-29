package com.callstack.agentdevice.snapshothelper;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

public final class BoundedUiAutomationConnectionTest {
  private BoundedUiAutomationConnectionTest() {}

  static void run() throws Exception {
    returnsAReadyConnection();
    retriesWhileTheConnectionIsUnavailable();
    boundsABlockingPlatformCall();
    propagatesConnectionFailures();
    propagatesInterruption();
  }

  private static void returnsAReadyConnection() throws Exception {
    Object expected = new Object();
    Object actual = BoundedUiAutomationConnection.await(() -> expected, 1_000);
    if (actual != expected) {
      throw new AssertionError("Expected the ready connection");
    }
  }

  private static void retriesWhileTheConnectionIsUnavailable() throws Exception {
    int[] attempts = {0};
    Object connection =
        BoundedUiAutomationConnection.await(
            () -> {
              attempts[0] += 1;
              return attempts[0] == 1 ? null : "connected";
            },
            1_000);

    if (!"connected".equals(connection)) {
      throw new AssertionError("Expected the connection returned by the retry");
    }
    if (attempts[0] != 2) {
      throw new AssertionError("Expected 2 connection attempts, got " + attempts[0]);
    }
  }

  private static void boundsABlockingPlatformCall() throws Exception {
    CountDownLatch release = new CountDownLatch(1);
    Thread eventualRelease =
        new Thread(
            () -> {
              try {
                Thread.sleep(2_000);
              } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
              }
              release.countDown();
            },
            "bounded-ui-automation-test-release");
    eventualRelease.setDaemon(true);
    eventualRelease.start();

    long startedAtNanos = System.nanoTime();
    try {
      BoundedUiAutomationConnection.await(
          () -> {
            boolean interrupted = false;
            while (true) {
              try {
                release.await();
                if (interrupted) {
                  Thread.currentThread().interrupt();
                }
                return "connected";
              } catch (InterruptedException error) {
                // Model the framework connection call, which may outlive cancellation.
                interrupted = true;
              }
            }
          },
          25);
      throw new AssertionError("Expected a blocking connection attempt to time out");
    } catch (TimeoutException expected) {
      long elapsedMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startedAtNanos);
      if (elapsedMs > 1_000) {
        throw new AssertionError("Expected the outer timeout to bound the platform call");
      }
    } finally {
      release.countDown();
    }
  }

  private static void propagatesConnectionFailures() throws Exception {
    IllegalStateException expected = new IllegalStateException("connection rejected");
    try {
      BoundedUiAutomationConnection.await(
          () -> {
            throw expected;
          },
          1_000);
      throw new AssertionError("Expected the connection failure");
    } catch (IllegalStateException actual) {
      if (actual != expected) {
        throw new AssertionError("Expected the original connection failure", actual);
      }
    }
  }

  private static void propagatesInterruption() throws TimeoutException {
    Thread.currentThread().interrupt();
    try {
      BoundedUiAutomationConnection.await(() -> null, 1_000);
      throw new AssertionError("Expected connection interruption to propagate");
    } catch (InterruptedException expected) {
      if (!Thread.currentThread().isInterrupted()) {
        throw new AssertionError("Expected interruption to restore the thread flag");
      }
    } finally {
      Thread.interrupted();
    }
  }
}
