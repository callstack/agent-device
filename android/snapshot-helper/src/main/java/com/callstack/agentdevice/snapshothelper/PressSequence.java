package com.callstack.agentdevice.snapshothelper;

/**
 * Sequences one tap or key press: a start event, then an end event with the same down time.
 *
 * <p>A refused start reached no window, as while a transition leaves nothing able to receive it.
 * The injection verifier still records it as landed, so the start is discarded before it is retried
 * once after the framework's animation sync, with a fresh down time so the receiver does not measure
 * the wait as a held press. A refused end is not cancelled: the verifier has recorded it too, so the
 * press is already closed there and a cancel would itself be inconsistent.
 */
final class PressSequence {
  /** Builds and injects the platform events of one press. */
  interface Injections {
    long now();

    /** Injects the start event, without the framework's animation wait when the runtime allows. */
    boolean start(long downTime);

    boolean end(long downTime);

    /** Closes the verifier state of a refused start that has this down time. */
    void discardRefusedStart(long downTime);

    AnimationSync awaitAnimations();
  }

  enum AnimationSync {
    WAITED,
    /** The runtime injects through the public overload, which waited for animations already. */
    ALREADY_WAITED,
    /** The runtime skips the animation wait on injection but cannot wait separately. */
    UNAVAILABLE,
  }

  enum Outcome {
    DISPATCHED,
    START_REFUSED,
    END_REFUSED,
    ANIMATION_SYNC_UNAVAILABLE,
  }

  private PressSequence() {}

  static Outcome run(Injections injections) {
    long downTime = injections.now();
    if (!injections.start(downTime)) {
      injections.discardRefusedStart(downTime);
      switch (injections.awaitAnimations()) {
        case ALREADY_WAITED:
          return Outcome.START_REFUSED;
        case UNAVAILABLE:
          return Outcome.ANIMATION_SYNC_UNAVAILABLE;
        case WAITED:
          downTime = injections.now();
          if (!injections.start(downTime)) {
            injections.discardRefusedStart(downTime);
            return Outcome.START_REFUSED;
          }
          break;
      }
    }
    return injections.end(downTime) ? Outcome.DISPATCHED : Outcome.END_REFUSED;
  }
}
