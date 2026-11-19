package com.callstack.agentdevice.snapshothelper;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;

/**
 * Pure admission and bound decisions for persistent-session connections. Every decision is a
 * function of its inputs only, so the test suite drives it with synthetic peers: no socket, no
 * clock, no Android runtime.
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
   * channel, measured with the repository's own plan builders: a 10 s two-contact gesture carries
   * 1,252 densified samples (2 pointers x 626 samples on the 16 ms grid), whose base64 command line
   * is at most ~130 KB, and the documented 64 KiB {@code fill --text-stdin} contract encodes to
   * ~88 KB. 256 KiB bounds both with at least 2x headroom. The IME helper's 64,000-base64-char
   * cap belongs to its separate am/broadcast channel and is deliberately not reused here.
   */
  static final int MAX_COMMAND_LINE_BYTES = 256 * 1024;

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

  /** Reads one command using the deadline fixed at accept and at most maxBytes + 1 bytes. */
  static String readSessionCommandLine(
      InputStream input, ReadTimeout timeout, MonotonicClock clock, long deadlineAtMs, int maxBytes)
      throws IOException {
    ByteArrayOutputStream bytes = new ByteArrayOutputStream();
    byte[] chunk = new byte[8 * 1024];
    while (bytes.size() <= maxBytes) {
      long remainingMs = deadlineAtMs - clock.nowMs();
      if (remainingMs <= 0) {
        throw new SocketTimeoutException("session command read deadline exceeded");
      }
      timeout.setMillis((int) remainingMs);
      int count = input.read(chunk, 0, Math.min(chunk.length, maxBytes + 1 - bytes.size()));
      if (clock.nowMs() > deadlineAtMs) {
        throw new SocketTimeoutException("session command read deadline exceeded");
      }
      if (count < 0) {
        if (bytes.size() == 0) return null;
        break;
      }
      int end = 0;
      while (end < count && chunk[end] != '\n') end++;
      bytes.write(chunk, 0, end);
      if (end < count) break;
    }
    return new String(bytes.toByteArray(), StandardCharsets.UTF_8);
  }

  static LineDecision commandLineDecision(String line, int maxLineBytes) {
    if (line == null || line.isEmpty()) {
      return LineDecision.REJECTED_EMPTY;
    }
    return line.getBytes(StandardCharsets.UTF_8).length > maxLineBytes
        ? LineDecision.REJECTED_OVER_LIMIT
        : LineDecision.ACCEPTED;
  }
}
