package com.callstack.agentdevice.snapshothelper;

import java.util.concurrent.TimeoutException;

/**
 * Sequences one tap or key press: a start event, then an end event with the same down time.
 *
 * <p>Without the framework's animation wait, a start can be dropped because a transition leaves
 * nothing able to receive it. The injection verifier still records it as landed, so the start is
 * discarded before it is retried once after the framework's animation sync, with a fresh down time
 * so the receiver does not measure the wait as a held press. A runtime that injects through the
 * public overload already waited, so its dropped start fails at once, as it always did.
 */
final class PressSequence {
  /**
   * The framework's synchronous injection deadline, {@code InputManagerService.INJECTION_TIMEOUT_MILLIS}.
   * Injection reports a timeout and a drop alike as {@code false}. The dispatcher starts this deadline
   * when the call enters it, so only a refusal at least this long after the call can be a timeout.
   */
  static final long INJECTION_TIMEOUT_MS = 30_000;

  /** Builds and injects the platform events of one press. */
  interface Injections {
    long now();

    /** Whether {@link #start} skips the framework's animation wait on this runtime. */
    boolean skipsAnimationWait();

    boolean start(long downTime);

    boolean end(long downTime);

    /** Closes the verifier state of a dropped start that has this down time. */
    void discardDroppedStart(long downTime);

    /** Releases a start that has this down time and that the receiver may hold. */
    void cancelStart(long downTime);

    /** Waits for the framework's animation sync; false when the runtime cannot wait separately. */
    boolean awaitAnimations();
  }

  enum Outcome {
    DISPATCHED,
    START_REFUSED,
    START_TIMED_OUT,
    END_REFUSED,
    ANIMATION_SYNC_UNAVAILABLE,
  }

  private enum Start {
    ACCEPTED,
    DROPPED,
    TIMED_OUT,
  }

  private PressSequence() {}

  static Outcome run(Injections injections) {
    long downTime = injections.now();
    Start start = start(injections, downTime);
    if (start == Start.DROPPED) {
      if (!injections.skipsAnimationWait()) return Outcome.START_REFUSED;
      discardDroppedStart(injections, downTime);
      if (!injections.awaitAnimations()) return Outcome.ANIMATION_SYNC_UNAVAILABLE;
      downTime = injections.now();
      start = start(injections, downTime);
      if (start == Start.DROPPED) {
        discardDroppedStart(injections, downTime);
        return Outcome.START_REFUSED;
      }
    }
    if (start == Start.TIMED_OUT) return Outcome.START_TIMED_OUT;
    // A refused end gets no cancel. The verifier records an event before the dispatcher drops it,
    // so the press is closed there and a cancel would be inconsistent. The dispatcher drops an end
    // only when no pointer or focus is still down, after it cancelled the receiving window itself
    // ("touched window was removed", "focus left window"). A timed-out end was already enqueued,
    // so the live window still receives it.
    return injections.end(downTime) ? Outcome.DISPATCHED : Outcome.END_REFUSED;
  }

  /** Turns an outcome into the helper's response: a typed exception for each failed press. */
  static void requireDispatched(Outcome outcome, String kind) throws TimeoutException {
    switch (outcome) {
      case DISPATCHED:
        return;
      case ANIMATION_SYNC_UNAVAILABLE:
        throw new UnsupportedOperationException(
            kind + " injection was refused and this runtime cannot wait for animations to retry it");
      case START_TIMED_OUT:
        throw new TimeoutException(
            kind + " injection timed out before the app finished handling it; it was cancelled");
      case START_REFUSED:
      case END_REFUSED:
        throw new IllegalStateException(kind + " injection was refused");
    }
  }

  /**
   * A timed-out start was enqueued before the deadline passed, so the receiver gets it and must not
   * see a second start; it is released instead of retried.
   */
  private static Start start(Injections injections, long downTime) {
    if (injections.start(downTime)) return Start.ACCEPTED;
    if (injections.now() - downTime < INJECTION_TIMEOUT_MS) return Start.DROPPED;
    try {
      injections.cancelStart(downTime);
    } catch (RuntimeException ignored) {
      // The timed-out start stays the reported failure.
    }
    return Start.TIMED_OUT;
  }

  private static void discardDroppedStart(Injections injections, long downTime) {
    try {
      injections.discardDroppedStart(downTime);
    } catch (RuntimeException ignored) {
      // The verifier keeps the dropped start; the press continues with its own outcome.
    }
  }
}
