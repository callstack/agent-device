package com.callstack.agentdevice.snapshothelper;

import android.net.LocalSocket;
import android.system.ErrnoException;
import android.system.Os;
import android.system.OsConstants;
import android.system.StructPollfd;
import java.io.FileDescriptor;
import java.io.IOException;

/** Nonblocking sends on an accepted LocalSocket, with poll for send room. API 21 and later. */
final class LocalSocketFrameChannel implements SessionFrameWriter.Channel {
  // Linux MSG_DONTWAIT and MSG_NOSIGNAL. OsConstants has no public MSG_DONTWAIT before API 26 and
  // no public fcntl for O_NONBLOCK, so the flags make each send nonblocking instead.
  private static final int MSG_DONTWAIT = 0x40;
  private static final int MSG_NOSIGNAL = 0x4000;

  private final FileDescriptor fd;

  LocalSocketFrameChannel(LocalSocket socket) {
    this.fd = socket.getFileDescriptor();
  }

  @Override
  public int send(byte[] data, int offset, int length) throws IOException {
    try {
      return Os.sendto(fd, data, offset, length, MSG_DONTWAIT | MSG_NOSIGNAL, null, 0);
    } catch (ErrnoException error) {
      if (error.errno == OsConstants.EAGAIN || error.errno == OsConstants.EINTR) return 0;
      throw new IOException("session response send failed", error);
    }
  }

  @Override
  public void awaitWritable(long timeoutMs) throws IOException {
    StructPollfd pollfd = new StructPollfd();
    pollfd.fd = fd;
    pollfd.events = (short) OsConstants.POLLOUT;
    try {
      Os.poll(new StructPollfd[] {pollfd}, (int) Math.min(timeoutMs, Integer.MAX_VALUE));
    } catch (ErrnoException error) {
      if (error.errno == OsConstants.EINTR) return;
      throw new IOException("session response poll failed", error);
    }
    if ((pollfd.revents & (OsConstants.POLLERR | OsConstants.POLLHUP | OsConstants.POLLNVAL)) != 0) {
      throw new IOException("session peer closed during the response");
    }
  }
}
