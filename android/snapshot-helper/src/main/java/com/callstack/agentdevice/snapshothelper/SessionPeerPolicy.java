package com.callstack.agentdevice.snapshothelper;

import java.io.ByteArrayOutputStream;
import java.io.EOFException;
import java.io.IOException;
import java.net.SocketTimeoutException;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CharsetDecoder;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;

/**
 * Admission and command framing for persistent-session connections. The reader takes an injected
 * stream and clock so tests can drive the same policy outside Android.
 *
 * <p>The session transport is an abstract {@code localabstract:} socket reached through
 * {@code adb forward tcp:<host port> localabstract:<name>}. The forwarded peer of such a
 * connection is adbd, which runs as root when adb is rooted and as shell otherwise; both uids are
 * the adb operator trust boundary, and the forwarded uid is not the original host user's identity.
 * Any other uid is an untrusted co-installed peer and is rejected before any command byte is read.
 *
 * <p>The host starts this transport with {@code -e mode authenticated-session-v1} and names the
 * socket with {@code -e sessionSocket <name>}. A helper that predates that mode rejects the launch
 * and opens no listener, so a session is never served by unauthenticated code.
 */
final class SessionPeerPolicy {
  /** The {@code mode} argument value that starts an authenticated session. */
  static final String AUTHENTICATED_SESSION_MODE = "authenticated-session-v1";

  /** adbd with {@code adb root} (a supported adb mode); the root-mode adb operator. */
  static final int PEER_UID_ROOT = 0;
  /** adbd in its default shell configuration. */
  static final int PEER_UID_SHELL = 2000;

  /**
   * Prefix of the abstract socket names this helper will bind. The host owns the whole name and
   * declares it in the launch; the helper binds it unchanged and refuses any name outside this
   * namespace, so it never binds a socket that belongs to something else. The name carries no
   * secret: admission is the peer uid, not name secrecy.
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
   * The slowest command delivery the read deadline waits for past its base. Each command byte that
   * arrives extends the deadline by 1 / 64 KiB of a second (about 0.5 Mbit/s), so the largest frame
   * gets about 10 s over a slow remote adb link, while a silent peer still closes at the base
   * deadline.
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
   * The socket the helper binds for a session, from the name the host launched it with. The host owns
   * the name; the helper binds it unchanged and refuses a name outside its own namespace, so it
   * cannot be talked into binding a socket that belongs to something else.
   */
  static String sessionSocketName(String launchedSocketName) {
    if (launchedSocketName == null || !launchedSocketName.startsWith(SESSION_SOCKET_PREFIX)) {
      throw new IllegalArgumentException("Session socket name is outside the helper namespace");
    }
    return launchedSocketName;
  }

  @FunctionalInterface
  interface MonotonicClock {
    long nowMs();
  }

  /** A connection that reads without blocking and can wait for data until an absolute deadline. */
  interface CommandSource {
    /** Reads ready bytes without blocking. Answers 0 when none are ready, -1 at end of stream. */
    int receive(byte[] data, int offset, int length) throws IOException;

    /**
     * Waits until the absolute deadline, or until data or the end of the stream is ready. The
     * implementation re-checks the deadline when the wait starts, so a pause between reading and
     * waiting cannot make it poll with a stale duration. A failed peer throws.
     */
    void awaitReadable(long deadlineAtMs) throws IOException;
  }

  @FunctionalInterface
  interface PeerWait {
    void await(long deadlineAtMs) throws IOException;
  }

  /**
   * How much time an absolute deadline has left, measured now. A deadline that has already expired
   * throws instead of answering with a duration a wait could still poll with, so every wait derives
   * its own duration from the deadline at the moment it starts.
   */
  static long remainingBeforeDeadline(MonotonicClock clock, long deadlineAtMs)
      throws SocketTimeoutException {
    long remainingMs = deadlineAtMs - clock.nowMs();
    if (remainingMs <= 0) {
      throw new SocketTimeoutException("session socket deadline exceeded");
    }
    return remainingMs;
  }

  /**
   * Refuses to wait once an absolute deadline has expired, measured now. The wait takes the
   * deadline itself and derives its own duration when it starts; a duration sampled earlier would
   * let a pause push the wait past the deadline.
   */
  static void awaitBeforeDeadline(MonotonicClock clock, long deadlineAtMs, PeerWait wait)
      throws IOException {
    remainingBeforeDeadline(clock, deadlineAtMs);
    wait.await(deadlineAtMs);
  }

  /**
   * One command frame as read from the connection, kept as raw bytes until it is known to be a
   * complete frame within the cap. A frame over the cap is decided from the raw byte count as soon
   * as it crosses the cap: a capped, unterminated prefix must not be decoded to decide anything,
   * because platforms before Android 7.1 decode malformed UTF-8 to fewer bytes than they occupy
   * (#4519 review).
   */
  static final class CommandFrame {
    private final byte[] bytes;
    private final boolean overLimit;

    private CommandFrame(byte[] bytes, boolean overLimit) {
      this.bytes = bytes;
      this.overLimit = overLimit;
    }

    LineDecision decision() {
      if (overLimit) {
        return LineDecision.REJECTED_OVER_LIMIT;
      }
      return bytes.length == 0 ? LineDecision.REJECTED_EMPTY : LineDecision.ACCEPTED;
    }

    /**
     * Decodes the frame strictly. Only an ACCEPTED frame may be decoded for dispatch: an over-limit
     * frame carries no command, and a byte sequence that is not well-formed UTF-8 throws instead of
     * becoming replacement text that would reach the command parser differently on every platform.
     */
    String line() throws IOException {
      if (overLimit) {
        throw new IllegalStateException("an over-limit frame carries no command to decode");
      }
      CharsetDecoder decoder =
          StandardCharsets.UTF_8
              .newDecoder()
              .onMalformedInput(CodingErrorAction.REPORT)
              .onUnmappableCharacter(CodingErrorAction.REPORT);
      try {
        return decoder.decode(java.nio.ByteBuffer.wrap(bytes)).toString();
      } catch (CharacterCodingException error) {
        throw new IOException("session command is not well-formed UTF-8", error);
      }
    }
  }

  /**
   * Reads one newline-terminated command. The deadline is absolute, fixed at accept for the base
   * allowance, and each received command byte extends it at {@link #MIN_COMMAND_BYTES_PER_SECOND}.
   * Every read is nonblocking, and the reader waits for data only while the deadline allows.
   * A wait takes the deadline itself, so a pause between the last check and the wait cannot start
   * a stale-duration poll. Expiry is checked after each receive before its bytes are credited, so
   * late bytes never earn more time. A frame whose raw bytes cross maxBytes returns over-limit
   * immediately, before its newline. A read past the deadline throws SocketTimeoutException, and
   * EOF before the newline throws EOFException.
   */
  static CommandFrame readSessionCommand(
      CommandSource source, MonotonicClock clock, long baseDeadlineAtMs, int maxBytes)
      throws IOException {
    ByteArrayOutputStream bytes = new ByteArrayOutputStream();
    byte[] chunk = new byte[8 * 1024];
    while (true) {
      long deadlineAtMs = readDeadlineAtMs(baseDeadlineAtMs, bytes.size());
      if (clock.nowMs() >= deadlineAtMs) {
        throw new SocketTimeoutException("session command read deadline exceeded");
      }
      int count = source.receive(chunk, 0, Math.min(chunk.length, maxBytes + 1 - bytes.size()));
      // Check expiry against the bytes credited before this receive, so bytes that arrive late
      // cannot buy the read more time before they are counted.
      if (clock.nowMs() > deadlineAtMs) {
        throw new SocketTimeoutException("session command read deadline exceeded");
      }
      if (count < 0) {
        throw new EOFException("session command ended before its newline");
      }
      if (count == 0) {
        awaitBeforeDeadline(clock, deadlineAtMs, source::awaitReadable);
        continue;
      }
      int end = 0;
      while (end < count && chunk[end] != '\n') {
        end++;
      }
      // Only command bytes earn read time; bytes after the newline are never part of the frame.
      bytes.write(chunk, 0, end);
      if (bytes.size() > maxBytes) {
        return new CommandFrame(new byte[0], true);
      }
      if (end < count) {
        return new CommandFrame(bytes.toByteArray(), false);
      }
    }
  }

  private static long readDeadlineAtMs(long baseDeadlineAtMs, int receivedBytes) {
    return baseDeadlineAtMs + receivedBytes * 1000L / MIN_COMMAND_BYTES_PER_SECOND;
  }
}
