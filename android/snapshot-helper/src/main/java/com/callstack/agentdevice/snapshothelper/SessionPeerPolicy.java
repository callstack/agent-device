package com.callstack.agentdevice.snapshothelper;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;

/**
 * Admission and command framing for persistent-session connections. The reader takes an injected
 * stream, clock and timeout setter so tests can drive the same policy outside Android.
 *
 * <p>The session transport is an abstract {@code localabstract:} socket reached through
 * {@code adb forward tcp:<host port> localabstract:<name>}. The forwarded peer of such a
 * connection is adbd, which runs as root when adb is rooted and as shell otherwise; both uids are
 * the adb operator trust boundary, and the forwarded uid is not the original host user's identity.
 * Any other uid is an untrusted co-installed peer and is rejected before any command byte is read.
 */
final class SessionPeerPolicy {
  /** adbd with {@code adb root} (a supported adb mode); the root-mode adb operator. */
  static final int PEER_UID_ROOT = 0;
  /** adbd in its default shell configuration. */
  static final int PEER_UID_SHELL = 2000;

  /**
   * Prefix of the abstract socket name, shared with the host's forward spec. The name is derived
   * from the session port and carries no secret: admission is the peer uid, not name secrecy.
   */
  static final String SESSION_SOCKET_PREFIX = "agentdevice-snapshot-helper-";

  /**
   * The per-connection command-line byte cap. Derived from the largest supported producer of this
   * channel. A 10 s two-contact gesture carries 1,252 densified samples, at most ~130 KB of Base64.
   * The documented 64 KiB {@code fill --text-stdin} contract is larger in the worst case: each
   * accepted control character such as U+001E is one UTF-8 byte that JSON escapes to six, so a
   * 65,536-byte value becomes 524,368 Base64 bytes before the action and request id. 513 KiB
   * (525,312 bytes) carries that frame. The IME helper's 64,000-Base64-char cap belongs to its
   * separate am/broadcast channel and is deliberately not reused here.
   */
  static final int MAX_COMMAND_LINE_BYTES = 513 * 1024;

  enum Admission {
    ADMITTED,
    REJECTED_UNAUTHORIZED_PEER
  }

  /** Why a command read closes the connection without writing a response. */
  enum ReadFailure {
    /** The read deadline fixed at accept passed before the newline arrived. */
    EXPIRED,
    /** The stream ended before the newline that terminates every command. */
    INCOMPLETE
  }

  /** A command read that ended without a complete frame. The connection closes without a reply. */
  static final class SessionReadClosed extends IOException {
    final ReadFailure reason;

    SessionReadClosed(ReadFailure reason) {
      super("session command read closed: " + reason);
      this.reason = reason;
    }
  }

  enum LineDecision {
    ACCEPTED,
    REJECTED_EMPTY,
    REJECTED_OVER_LIMIT
  }

  private SessionPeerPolicy() {}

  static Admission admitPeer(int uid) {
    return uid == PEER_UID_ROOT || uid == PEER_UID_SHELL
        ? Admission.ADMITTED
        : Admission.REJECTED_UNAUTHORIZED_PEER;
  }

  /**
   * The abstract socket name for a session port. Deterministic and secret-free, so the host and
   * the helper derive the same name from the same port without passing anything sensitive in argv.
   */
  static String sessionSocketName(int sessionPort) {
    return SESSION_SOCKET_PREFIX + sessionPort;
  }

  @FunctionalInterface
  interface ReadTimeout {
    void setMillis(int timeoutMs) throws IOException;
  }

  @FunctionalInterface
  interface MonotonicClock {
    long nowMs();
  }

  /**
   * Reads one newline-terminated command using the deadline fixed at accept and at most
   * maxBytes + 1 bytes. A read past the deadline or EOF before the newline throws
   * {@link SessionReadClosed}; a line over the cap returns its first maxBytes + 1 bytes. Android's
   * LocalSocket reports an SO_TIMEOUT expiry as a plain IOException (EAGAIN), not as
   * SocketTimeoutException, so the caller closes the connection on any IOException from here.
   */
  static String readSessionCommandLine(
      InputStream input, ReadTimeout timeout, MonotonicClock clock, long deadlineAtMs, int maxBytes)
      throws IOException {
    ByteArrayOutputStream bytes = new ByteArrayOutputStream();
    byte[] chunk = new byte[8 * 1024];
    while (bytes.size() <= maxBytes) {
      long remainingMs = deadlineAtMs - clock.nowMs();
      if (remainingMs <= 0) {
        throw new SessionReadClosed(ReadFailure.EXPIRED);
      }
      timeout.setMillis((int) remainingMs);
      int count;
      try {
        count = input.read(chunk, 0, Math.min(chunk.length, maxBytes + 1 - bytes.size()));
      } catch (SocketTimeoutException expired) {
        throw new SessionReadClosed(ReadFailure.EXPIRED);
      }
      if (clock.nowMs() > deadlineAtMs) {
        throw new SessionReadClosed(ReadFailure.EXPIRED);
      }
      if (count < 0) {
        throw new SessionReadClosed(ReadFailure.INCOMPLETE);
      }
      int end = 0;
      while (end < count && chunk[end] != '\n') end++;
      bytes.write(chunk, 0, end);
      if (end < count) break;
    }
    return new String(bytes.toByteArray(), StandardCharsets.UTF_8);
  }

  static LineDecision commandLineDecision(String line, int maxLineBytes) {
    if (line.isEmpty()) {
      return LineDecision.REJECTED_EMPTY;
    }
    return line.getBytes(StandardCharsets.UTF_8).length > maxLineBytes
        ? LineDecision.REJECTED_OVER_LIMIT
        : LineDecision.ACCEPTED;
  }
}
