package com.callstack.agentdevice.snapshothelper;

import android.net.LocalSocket;
import android.system.ErrnoException;
import android.system.Os;
import android.system.OsConstants;
import android.system.StructPollfd;
import java.io.FileDescriptor;
import java.io.IOException;

/**
 * Nonblocking reads and sends on an accepted LocalSocket, with poll for readiness. API 21 and later.
 * The socket timeout is not used: Android 7.0 and 7.1.0 set only SO_SNDTIMEO for it, and where it
 * is set it bounds each blocking call, not the command.
 */
final class LocalSocketSessionChannel
    implements SessionPeerPolicy.CommandSource, SessionFrameWriter.Channel {
  // Linux MSG_DONTWAIT and MSG_NOSIGNAL. OsConstants has no public MSG_DONTWAIT before API 26 and
  // no public fcntl for O_NONBLOCK, so the flags make each call nonblocking instead.
  private static final int MSG_DONTWAIT = 0x40;
  private static final int MSG_NOSIGNAL = 0x4000;

  private final FileDescriptor fd;

  LocalSocketSessionChannel(LocalSocket socket) {
    this.fd = socket.getFileDescriptor();
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
  public void awaitReadable(long timeoutMs) throws IOException {
    // A closed peer is readable: the next receive reports the end of the stream.
    poll(OsConstants.POLLIN, timeoutMs, OsConstants.POLLERR | OsConstants.POLLNVAL);
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
  public void awaitWritable(long timeoutMs) throws IOException {
    poll(
        OsConstants.POLLOUT,
        timeoutMs,
        OsConstants.POLLERR | OsConstants.POLLHUP | OsConstants.POLLNVAL);
  }

  private void poll(int events, long timeoutMs, int failures) throws IOException {
    StructPollfd pollfd = new StructPollfd();
    pollfd.fd = fd;
    pollfd.events = (short) events;
    try {
      Os.poll(new StructPollfd[] {pollfd}, (int) Math.min(timeoutMs, Integer.MAX_VALUE));
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
