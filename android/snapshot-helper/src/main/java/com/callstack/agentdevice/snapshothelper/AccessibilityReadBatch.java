package com.callstack.agentdevice.snapshothelper;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.FutureTask;

/**
 * Reads a bounded group of children concurrently and retains their traversal order.
 *
 * <p>Accessibility cache misses are served on the app's UI thread. Queuing siblings together lets
 * the app serve multiple reads between animation frames. Workers are reused because Android keeps
 * an AccessibilityInteractionClient for each calling thread for the lifetime of the process.
 * Closing waits for every read before releasing nodes, including unread results after truncation
 * or failure, so no worker outlives the parent node it is reading.
 */
final class AccessibilityReadBatch<T> implements AutoCloseable {
  interface Reader<T> {
    T read(int index);
  }

  interface Releaser<T> {
    void release(T value);
  }

  static final int MAX_READS = 8;
  private static final ExecutorService READERS =
      Executors.newFixedThreadPool(
          MAX_READS,
          task -> {
            Thread thread = new Thread(task, "agent-device-accessibility-read");
            thread.setDaemon(true);
            return thread;
          });

  private final List<FutureTask<T>> reads = new ArrayList<>();
  private final Releaser<T> release;

  AccessibilityReadBatch(int start, int count, Reader<T> read, Releaser<T> release) {
    if (count < 1 || count > MAX_READS) {
      throw new IllegalArgumentException("Accessibility read batch must contain 1 to 8 reads");
    }
    this.release = release;
    for (int offset = 0; offset < count; offset += 1) {
      int index = start + offset;
      FutureTask<T> task = new FutureTask<>(() -> read.read(index));
      reads.add(task);
      READERS.execute(task);
    }
  }

  T get(int offset) {
    return await(reads.get(offset));
  }

  @Override
  public void close() {
    for (FutureTask<T> read : reads) {
      T node;
      try {
        node = await(read);
      } catch (RuntimeException | Error ignored) {
        // get() propagates read failures. Other reads must finish before the parent is released.
        continue;
      }
      if (node != null) {
        release.release(node);
      }
    }
  }

  private static <T> T await(FutureTask<T> read) {
    boolean interrupted = false;
    try {
      while (true) {
        try {
          return read.get();
        } catch (InterruptedException error) {
          interrupted = true;
        } catch (ExecutionException error) {
          Throwable cause = error.getCause();
          if (cause instanceof RuntimeException) {
            throw (RuntimeException) cause;
          }
          if (cause instanceof Error) {
            throw (Error) cause;
          }
          throw new IllegalStateException("Android accessibility child read failed", cause);
        }
      }
    } finally {
      if (interrupted) {
        Thread.currentThread().interrupt();
      }
    }
  }
}
