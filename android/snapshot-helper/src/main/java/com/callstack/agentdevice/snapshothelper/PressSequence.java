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

  /** The framework's cap on one animation sync, {@code WindowManagerService.ANIMATION_COMPLETED_TIMEOUT_MS}. */
  static final long ANIMATION_SYNC_TIMEOUT_MS = 5_000;

  /**
   * The longest one press may take, so the helper answers before the host's input timeout. A
   * synchronous injection can block until {@link #INJECTION_TIMEOUT_MS}, so each one after the first
   * starts only when that deadline still fits: the retry of a dropped start is skipped, and an end
   * that does not fit is injected without waiting for dispatch.
   */
  static final long PRESS_BUDGET_MS = 40_000;

  /** Builds and injects the platform events of one press. */
  interface Injections {
    long now();

    /** Whether {@link #start} skips the framework's animation wait on this runtime. */
    boolean skipsAnimationWait();

    boolean start(long downTime);

    /** Injects the end event; without {@code waitForDispatch} it cannot report a refusal. */
    boolean end(long downTime, boolean waitForDispatch);

    /** Closes the verifier state of a dropped start that has this down time. */
    void discardDroppedStart(long downTime);

    /** Releases a start that has this down time and that the receiver may hold; false if refused. */
    boolean cancelStart(long downTime);

    /** Waits for the framework's animation sync; false when the runtime cannot wait separately. */
    boolean awaitAnimations();
  }

  enum Outcome {
    DISPATCHED,
    START_REFUSED,
    START_TIMED_OUT,
    START_TIMED_OUT_CANCEL_REFUSED,
    END_REFUSED,
    ANIMATION_SYNC_UNAVAILABLE,
  }

  private enum Start {
    ACCEPTED,
    DROPPED,
    TIMED_OUT,
    TIMED_OUT_CANCEL_REFUSED,
  }

  private PressSequence() {}

  static Outcome run(Injections injections) {
    long pressStart = injections.now();
    long downTime = pressStart;
    Start start = start(injections, downTime);
    if (start == Start.DROPPED) {
      if (!injections.skipsAnimationWait()) return Outcome.START_REFUSED;
      discardDroppedStart(injections, downTime);
      if (!fits(injections, pressStart, ANIMATION_SYNC_TIMEOUT_MS + INJECTION_TIMEOUT_MS)) {
        return Outcome.START_REFUSED;
      }
      if (!injections.awaitAnimations()) return Outcome.ANIMATION_SYNC_UNAVAILABLE;
      if (!fits(injections, pressStart, INJECTION_TIMEOUT_MS)) return Outcome.START_REFUSED;
      downTime = injections.now();
      start = start(injections, downTime);
      if (start == Start.DROPPED) {
        discardDroppedStart(injections, downTime);
        return Outcome.START_REFUSED;
      }
    }
    if (start == Start.TIMED_OUT) return Outcome.START_TIMED_OUT;
    if (start == Start.TIMED_OUT_CANCEL_REFUSED) return Outcome.START_TIMED_OUT_CANCEL_REFUSED;
    // A refused end gets no cancel. The verifier records an event before the dispatcher drops it,
    // so the press is closed there and a cancel would be inconsistent. The dispatcher drops an end
    // only when no pointer or focus is still down, after it cancelled the receiving window itself
    // ("touched window was removed", "focus left window"). A timed-out end was already enqueued,
    // so the live window still receives it.
    boolean waitForDispatch = fits(injections, pressStart, INJECTION_TIMEOUT_MS);
    return injections.end(downTime, waitForDispatch) ? Outcome.DISPATCHED : Outcome.END_REFUSED;
  }

  private static boolean fits(Injections injections, long pressStart, long waitMs) {
    return injections.now() - pressStart + waitMs <= PRESS_BUDGET_MS;
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
      case START_TIMED_OUT_CANCEL_REFUSED:
        throw new TimeoutException(kind + " injection timed out before the app finished handling"
            + " it, and its cancel was refused, so the app may still hold it");
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
    boolean cancelled;
    try {
      cancelled = injections.cancelStart(downTime);
    } catch (RuntimeException error) {
      cancelled = false;
    }
    return cancelled ? Start.TIMED_OUT : Start.TIMED_OUT_CANCEL_REFUSED;
  }

  private static void discardDroppedStart(Injections injections, long downTime) {
    try {
      injections.discardDroppedStart(downTime);
    } catch (RuntimeException ignored) {
      // The verifier keeps the dropped start; the press continues with its own outcome.
    }
  }
}
