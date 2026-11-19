package com.callstack.agentdevice.snapshothelper;

import java.io.IOException;

/**
 * Writes one response frame under one monotonic deadline. Every send is nonblocking, and the writer
 * waits for room only as long as the deadline allows. A blocking socket write cannot do this: the
 * platform loops over short sends inside one write, and each send gets the full send timeout again.
 *
 * <p>The deadline is fixed when the frame write starts: the base allowance plus the frame size at
 * the floor rate. A large frame over a slow link can finish. A peer that stops reading is closed at
 * the deadline, whatever progress it made before.
 */
final class SessionFrameWriter implements SessionResponseWriter.FrameSink {
  /** A socket that sends without blocking and can wait for send room. */
  interface Channel {
    /** Sends up to length bytes without blocking. Answers 0 when there is no room. */
    int send(byte[] data, int offset, int length) throws IOException;

    /**
     * Waits until the absolute deadline for send room. The implementation re-checks the deadline
     * when the wait starts, so a pause cannot make it poll with a stale duration. A closed or
     * failed peer throws.
     */
    void awaitWritable(long deadlineAtMs) throws IOException;
  }

  private final Channel channel;
  private final SessionPeerPolicy.MonotonicClock clock;
  private final long baseTimeoutMs;
  private final int minBytesPerSecond;

  SessionFrameWriter(
      Channel channel,
      SessionPeerPolicy.MonotonicClock clock,
      long baseTimeoutMs,
      int minBytesPerSecond) {
    this.channel = channel;
    this.clock = clock;
    this.baseTimeoutMs = baseTimeoutMs;
    this.minBytesPerSecond = minBytesPerSecond;
  }

  @Override
  public void write(SessionResponseWriter.Frame frame) throws IOException {
    long frameBytes = (long) frame.head.length + frame.body.length;
    long deadlineAtMs = clock.nowMs() + baseTimeoutMs + frameBytes * 1000L / minBytesPerSecond;
    sendAll(frame.head, deadlineAtMs);
    sendAll(frame.body, deadlineAtMs);
  }

  private void sendAll(byte[] data, long deadlineAtMs) throws IOException {
    int offset = 0;
    while (offset < data.length) {
      // Each wait measures its own remaining time as it starts, so a pause before the wait cannot
      // make it poll with a duration measured before the pause.
      SessionPeerPolicy.remainingBeforeDeadline(clock, deadlineAtMs);
      int count = channel.send(data, offset, data.length - offset);
      if (count > 0) {
        offset += count;
        continue;
      }
      // Measured again as the wait starts: a send that used up the budget must not start a poll.
      SessionPeerPolicy.remainingBeforeDeadline(clock, deadlineAtMs);
      channel.awaitWritable(deadlineAtMs);
    }
  }
}
