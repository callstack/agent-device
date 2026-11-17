package com.callstack.agentdevice.snapshothelper;

/**
 * Sequences one tap or key press: a start event, then an end event with the same down time.
 *
 * <p>Every refused start is released before anything else is decided: the verifier and the policy
 * record a start even when the dispatcher drops it, and a start refused by the injection timeout
 * was delivered. Without the framework's animation wait, a start is often refused only because a
 * transition leaves nothing able to receive it, so it is retried once after the animation sync,
 * with a fresh down time, when the host's deadline still has room for that retry.
 */
final class PressSequence {
  /**
   * The room a retry decision reserves: the framework's animation-sync cap
   * ({@code WindowManagerService.ANIMATION_COMPLETED_TIMEOUT_MS}) plus the retried start's injection
   * deadline ({@code InputManagerService.INJECTION_TIMEOUT_MILLIS}). The end is not reserved: it
   * blocks only while the app does not finish handling it, which a press without a retry meets the
   * same way, and a 60 s press request could never reserve a second 30 s deadline.
   */
  static final long RETRY_WORST_CASE_MS = 5_000 + 30_000;

  /** Builds and injects the platform events of one press. */
  interface Injections {
    long now();

    /** Whether {@link #start} skips the framework's animation wait on this runtime. */
    boolean skipsAnimationWait();

    boolean start(long downTime);

    boolean end(long downTime);

    /** Releases a refused start that has this down time; the receiver may hold it. */
    void releaseRefusedStart(long downTime);

    /** Waits for the framework's animation sync; false when the runtime cannot wait separately. */
    boolean awaitAnimations();
  }

  enum Outcome {
    DISPATCHED,
    START_REFUSED,
    END_REFUSED,
    ANIMATION_SYNC_UNAVAILABLE,
  }

  private PressSequence() {}

  /** Runs one press that must answer by {@code deadline}, on the {@link Injections#now} clock. */
  static Outcome run(Injections injections, long deadline) {
    long downTime = injections.now();
    if (!injections.start(downTime)) {
      release(injections, downTime);
      if (!injections.skipsAnimationWait()
          || deadline - injections.now() < RETRY_WORST_CASE_MS) {
        return Outcome.START_REFUSED;
      }
      if (!injections.awaitAnimations()) return Outcome.ANIMATION_SYNC_UNAVAILABLE;
      downTime = injections.now();
      if (!injections.start(downTime)) {
        release(injections, downTime);
        return Outcome.START_REFUSED;
      }
    }
    // A refused end gets no cancel. The verifier records an event before the dispatcher drops it,
    // so the press is closed there and a cancel would be inconsistent. The dispatcher drops an end
    // only when no pointer or focus is still down, after it cancelled the receiving window itself
    // ("touched window was removed", "focus left window"). A timed-out end was already enqueued,
    // so the live window still receives it.
    return injections.end(downTime) ? Outcome.DISPATCHED : Outcome.END_REFUSED;
  }

  /** Turns an outcome into the helper's response: a typed exception for each failed press. */
  static void requireDispatched(Outcome outcome, String kind) {
    switch (outcome) {
      case DISPATCHED:
        return;
      case ANIMATION_SYNC_UNAVAILABLE:
        throw new UnsupportedOperationException(
            kind + " injection was refused and this runtime cannot wait for animations to retry it");
      case START_REFUSED:
      case END_REFUSED:
        throw new IllegalStateException(kind + " injection was refused");
    }
  }

  private static void release(Injections injections, long downTime) {
    try {
      injections.releaseRefusedStart(downTime);
    } catch (RuntimeException ignored) {
      // The refused start stays the reported outcome.
    }
  }
}
