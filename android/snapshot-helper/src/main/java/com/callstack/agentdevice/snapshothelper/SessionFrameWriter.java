package com.callstack.agentdevice.snapshothelper;

import java.io.IOException;
import java.net.SocketTimeoutException;

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

    /** Waits up to timeoutMs for send room. A closed or failed peer throws. */
    void awaitWritable(long timeoutMs) throws IOException;
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
      long remainingMs = deadlineAtMs - clock.nowMs();
      if (remainingMs <= 0) {
        throw new SocketTimeoutException("session response write deadline exceeded");
      }
      int count = channel.send(data, offset, data.length - offset);
      if (count > 0) {
        offset += count;
        continue;
      }
      // The send may have taken time, so the wait uses what is left now, not before the send.
      long waitMs = deadlineAtMs - clock.nowMs();
      if (waitMs <= 0) {
        throw new SocketTimeoutException("session response write deadline exceeded");
      }
      channel.awaitWritable(waitMs);
    }
  }
}
