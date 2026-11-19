package com.callstack.agentdevice.snapshothelper;

import java.io.ByteArrayOutputStream;
import java.io.EOFException;
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

  /**
   * The slowest command delivery the read deadline waits for past its base. Each byte that arrives
   * extends the deadline by 1 / 64 KiB of a second (about 0.5 Mbit/s), so the largest frame gets
   * about 10 s over a slow remote adb link, while a silent peer still closes at the base deadline.
   */
  static final int MIN_COMMAND_BYTES_PER_SECOND = 64 * 1024;

  enum Admission {
    ADMITTED,
    REJECTED_UNAUTHORIZED_PEER
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
   * Reads one newline-terminated command and at most maxBytes + 1 bytes. The deadline starts at
   * baseDeadlineAtMs, fixed at accept, and each received byte extends it at
   * {@link #MIN_COMMAND_BYTES_PER_SECOND}. A read past the deadline throws
   * SocketTimeoutException, and EOF before the newline throws EOFException. A line over the cap
   * returns its first maxBytes + 1 bytes. Android's LocalSocket reports an SO_TIMEOUT expiry as a
   * plain IOException (EAGAIN), so the caller closes the connection on any IOException from here.
   */
  static String readSessionCommandLine(
      InputStream input,
      ReadTimeout timeout,
      MonotonicClock clock,
      long baseDeadlineAtMs,
      int maxBytes)
      throws IOException {
    ByteArrayOutputStream bytes = new ByteArrayOutputStream();
    byte[] chunk = new byte[8 * 1024];
    while (bytes.size() <= maxBytes) {
      long remainingMs = readDeadlineAtMs(baseDeadlineAtMs, bytes.size()) - clock.nowMs();
      if (remainingMs <= 0) {
        throw new SocketTimeoutException("session command read deadline exceeded");
      }
      timeout.setMillis((int) remainingMs);
      int count = input.read(chunk, 0, Math.min(chunk.length, maxBytes + 1 - bytes.size()));
      if (count < 0) {
        throw new EOFException("session command ended before its newline");
      }
      int end = 0;
      while (end < count && chunk[end] != '\n') end++;
      // Only command bytes earn read time; bytes after the newline are never part of the frame.
      if (clock.nowMs() > readDeadlineAtMs(baseDeadlineAtMs, bytes.size() + end)) {
        throw new SocketTimeoutException("session command read deadline exceeded");
      }
      bytes.write(chunk, 0, end);
      if (end < count) break;
    }
    return new String(bytes.toByteArray(), StandardCharsets.UTF_8);
  }

  private static long readDeadlineAtMs(long baseDeadlineAtMs, int receivedBytes) {
    return baseDeadlineAtMs + receivedBytes * 1000L / MIN_COMMAND_BYTES_PER_SECOND;
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
