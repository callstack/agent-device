package com.callstack.agentdevice.snapshothelper;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

public final class AccessibilityReadBatchTest {
  private AccessibilityReadBatchTest() {}

  static void run() throws Exception {
    queuesConcurrentReadsAndPreservesOrder();
    releasesUnreadResultsAfterFailure();
    waitsForReadersBeforeReleasingTheParent();
    preservesInterruptionDuringCleanup();
  }

  private static void queuesConcurrentReadsAndPreservesOrder() throws Exception {
    CountDownLatch started = new CountDownLatch(AccessibilityReadBatch.MAX_READS);
    CountDownLatch release = new CountDownLatch(1);
    List<Integer> recycled = new ArrayList<>();
    try (AccessibilityReadBatch<Integer> batch =
        new AccessibilityReadBatch<>(
            10,
            AccessibilityReadBatch.MAX_READS,
            index -> {
              started.countDown();
              await(release);
              return index;
            },
            recycled::add)) {
      try {
        if (!started.await(1, TimeUnit.SECONDS)) {
          throw new AssertionError("Sibling reads must start before any read completes");
        }
      } finally {
        release.countDown();
      }
      for (int offset = 0; offset < AccessibilityReadBatch.MAX_READS; offset += 1) {
        if (batch.get(offset) != 10 + offset) {
          throw new AssertionError("Child indexes must retain traversal order");
        }
      }
    }
    if (!recycled.equals(Arrays.asList(10, 11, 12, 13, 14, 15, 16, 17))) {
      throw new AssertionError("Each child must be released once: " + recycled);
    }
  }

  private static void releasesUnreadResultsAfterFailure() {
    IllegalStateException failure = new IllegalStateException("window disappeared");
    List<Integer> recycled = new ArrayList<>();
    try (AccessibilityReadBatch<Integer> batch =
        new AccessibilityReadBatch<>(
            0, 4,
            index -> {
              if (index == 1) {
                throw failure;
              }
              return index == 2 ? null : index;
            },
            recycled::add)) {
      if (batch.get(0) != 0) {
        throw new AssertionError("Expected the first child");
      }
      try {
        batch.get(1);
        throw new AssertionError("Expected the original accessibility failure");
      } catch (IllegalStateException actual) {
        if (actual != failure) {
          throw new AssertionError("Read failures must not be wrapped", actual);
        }
      }
    }
    if (!recycled.equals(Arrays.asList(0, 3))) {
      throw new AssertionError("Unread children must be released after failure: " + recycled);
    }
  }

  private static void waitsForReadersBeforeReleasingTheParent() throws Exception {
    CountDownLatch started = new CountDownLatch(1);
    CountDownLatch release = new CountDownLatch(1);
    CountDownLatch closed = new CountDownLatch(1);
    List<Integer> recycled = new ArrayList<>();
    AccessibilityReadBatch<Integer> batch =
        new AccessibilityReadBatch<>(0, 1, index -> {
          started.countDown();
          await(release);
          return index;
        }, recycled::add);
    Thread closer = new Thread(() -> {
      batch.close();
      closed.countDown();
    });
    try {
      if (!started.await(1, TimeUnit.SECONDS)) {
        throw new AssertionError("Expected a running child read");
      }
      closer.start();
      long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(1);
      while (closer.getState() != Thread.State.WAITING
          && closed.getCount() != 0
          && System.nanoTime() < deadline) {
        Thread.yield();
      }
      if (closer.getState() != Thread.State.WAITING || closed.getCount() == 0) {
        throw new AssertionError("Cleanup must block on the pending child read before release");
      }
    } finally {
      release.countDown();
      closer.join(1_000);
    }
    if (closed.getCount() != 0 || !recycled.equals(Arrays.asList(0))) {
      throw new AssertionError("Cleanup must wait for and release the unread child");
    }
  }

  private static void preservesInterruptionDuringCleanup() {
    List<Integer> recycled = new ArrayList<>();
    Thread.currentThread().interrupt();
    try (AccessibilityReadBatch<Integer> batch =
        new AccessibilityReadBatch<>(0, 2, index -> index, recycled::add)) {
      if (batch.get(1) != 1) {
        throw new AssertionError("Expected the completed child");
      }
    } finally {
      if (!Thread.interrupted()) {
        throw new AssertionError("Cleanup must preserve the caller's interrupt status");
      }
    }
    if (!recycled.equals(Arrays.asList(0, 1))) {
      throw new AssertionError("Interruption must not leak child nodes");
    }
  }

  private static void await(CountDownLatch latch) {
    try {
      if (!latch.await(2, TimeUnit.SECONDS)) {
        throw new AssertionError("Timed out waiting for the test to release a reader");
      }
    } catch (InterruptedException error) {
      Thread.currentThread().interrupt();
      throw new AssertionError(error);
    }
  }
}
