package com.callstack.agentdevice.snapshothelper;

import android.net.LocalSocket;
import android.system.ErrnoException;
import android.system.Os;
import android.system.OsConstants;
import android.system.StructPollfd;
import java.io.FileDescriptor;
import java.io.IOException;
import java.net.SocketTimeoutException;

/**
 * Nonblocking reads and sends on an accepted LocalSocket, with poll for readiness. API 21 and later.
 * Every wait takes the absolute deadline and derives its own poll duration when it starts: a
 * duration sampled earlier would let a pause between the deadline check and the poll wait past the
 * deadline. The socket timeout is not used: Android 7.0 and 7.1.0 set only SO_SNDTIMEO for it, and
 * where it is set it bounds each blocking call, not the command.
 */
final class LocalSocketSessionChannel
    implements SessionPeerPolicy.CommandSource, SessionFrameWriter.Channel {
  // Linux MSG_DONTWAIT and MSG_NOSIGNAL. OsConstants has no public MSG_DONTWAIT before API 26 and
  // no public fcntl for O_NONBLOCK, so the flags make each call nonblocking instead.
  private static final int MSG_DONTWAIT = 0x40;
  private static final int MSG_NOSIGNAL = 0x4000;

  private final FileDescriptor fd;
  private final SessionPeerPolicy.MonotonicClock clock;

  LocalSocketSessionChannel(LocalSocket socket, SessionPeerPolicy.MonotonicClock clock) {
    this.fd = socket.getFileDescriptor();
    this.clock = clock;
  }

  @Override
  public int receive(byte[] data, int offset, int length) throws IOException {
    try {
      int count = Os.recvfrom(fd, data, offset, length, MSG_DONTWAIT, null);
      return count == 0 ? -1 : count;
    } catch (ErrnoException error) {
      if (isRetry(error)) return 0;
      throw new IOException("session command receive failed", error);
    }
  }

  @Override
  public void awaitReadable(long deadlineAtMs) throws IOException {
    // A closed peer is readable: the next receive reports the end of the stream.
    pollUntil(OsConstants.POLLIN, deadlineAtMs, OsConstants.POLLERR | OsConstants.POLLNVAL);
  }

  @Override
  public int send(byte[] data, int offset, int length) throws IOException {
    try {
      return Os.sendto(fd, data, offset, length, MSG_DONTWAIT | MSG_NOSIGNAL, null, 0);
    } catch (ErrnoException error) {
      if (isRetry(error)) return 0;
      throw new IOException("session response send failed", error);
    }
  }

  @Override
  public void awaitWritable(long deadlineAtMs) throws IOException {
    pollUntil(
        OsConstants.POLLOUT,
        deadlineAtMs,
        OsConstants.POLLERR | OsConstants.POLLHUP | OsConstants.POLLNVAL);
  }

  private void pollUntil(int events, long deadlineAtMs, int failures) throws IOException {
    // Sample the clock here, not at the caller: the duration must be what the deadline has left
    // when Os.poll starts, or a pause before this call would extend it.
    long remainingMs = deadlineAtMs - clock.nowMs();
    if (remainingMs <= 0) {
      throw new SocketTimeoutException("session socket deadline exceeded");
    }
    StructPollfd pollfd = new StructPollfd();
    pollfd.fd = fd;
    pollfd.events = (short) events;
    try {
      Os.poll(new StructPollfd[] {pollfd}, (int) Math.min(remainingMs, Integer.MAX_VALUE));
    } catch (ErrnoException error) {
      if (error.errno == OsConstants.EINTR) return;
      throw new IOException("session socket poll failed", error);
    }
    if ((pollfd.revents & failures) != 0) {
      throw new IOException("session peer failed during the exchange");
    }
  }

  private static boolean isRetry(ErrnoException error) {
    return error.errno == OsConstants.EAGAIN || error.errno == OsConstants.EINTR;
  }
}
