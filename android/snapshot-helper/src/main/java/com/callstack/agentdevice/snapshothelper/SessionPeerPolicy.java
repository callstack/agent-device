package com.callstack.agentdevice.snapshothelper;

import java.io.ByteArrayOutputStream;
import java.io.EOFException;
import java.io.IOException;
import java.net.SocketTimeoutException;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CharsetDecoder;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;

/**
 * Peer admission and command framing for persistent-session connections, with an injected stream and
 * clock so tests can drive the same policy outside Android.
 *
 * <p>The session transport is an abstract {@code localabstract:} socket reached through {@code adb
 * forward tcp:<host port> localabstract:<name>}. The forwarded peer of such a connection is adbd,
 * which runs as shell uid 2000, or as root uid 0 when adb is rooted; both are the adb operator trust
 * boundary, and the forwarded uid is not the original host user's identity. Any other uid is an
 * untrusted co-installed peer and is rejected before any command byte is read.
 *
 * <p>The host starts this transport with {@code -e mode authenticated-session-v1} and names the
 * socket with {@code -e sessionSocket <name>}. A helper that predates that mode rejects the launch
 * and opens no listener.
 */
final class SessionPeerPolicy {
  /** The {@code mode} argument value that starts an authenticated session. */
  static final String AUTHENTICATED_SESSION_MODE = "authenticated-session-v1";

  /**
   * Prefix of the abstract socket names this helper will bind. The host owns the whole name and
   * declares it in the launch; the name carries no secret, because admission is the peer uid.
   */
  static final String SESSION_SOCKET_PREFIX = "agentdevice-snapshot-helper-";

  /**
   * The per-connection command-line byte cap, derived from the largest supported producer of this
   * channel: the documented 64 KiB {@code fill --text-stdin} contract, whose worst case is JSON
   * escapes — one accepted control character such as U+001E becomes six bytes — so a 65,536-byte
   * value encodes to 524,368 Base64 bytes before the action and request id. 513 KiB (525,312 bytes)
   * carries that frame; a 10 s two-contact gesture needs only ~130 KB. The IME helper's
   * 64,000-Base64-char cap belongs to its separate am/broadcast channel.
   */
  static final int MAX_COMMAND_LINE_BYTES = 513 * 1024;

  /**
   * The slowest command delivery the read deadline waits for past its 2 s base: each command byte
   * extends the deadline by 1 / 64 KiB of a second (about 0.5 Mbit/s), so the largest frame gets
   * about 10 s over a slow remote adb link while a silent peer still closes at the base.
   */
  static final int MIN_COMMAND_BYTES_PER_SECOND = 64 * 1024;

  private SessionPeerPolicy() {}

  /** Whether a forwarded peer's uid is adbd, in its shell or supported root configuration. */
  static boolean isAdmittedPeer(int uid) {
    return uid == 0 || uid == 2000;
  }

  /**
   * The socket to bind, from the name the host launched with. The host owns the name; the helper
   * refuses a name outside its own namespace so it cannot bind a socket belonging to something else.
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
     * Waits until the absolute deadline, or until data or the end of the stream is ready. A failed
     * peer throws.
     */
    void awaitReadable(long deadlineAtMs) throws IOException;
  }

  /** A frame the reader will not dispatch, answered with an error frame instead of a command. */
  static final class CommandRejected extends IOException {
    CommandRejected(String message) {
      super(message);
    }
  }

  /**
   * What an absolute deadline has left, measured now. An expired deadline throws rather than answer
   * with a duration a wait could still poll with, so every wait derives its own duration at its own
   * start and a pause before it cannot extend it.
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
   * Reads one newline-terminated command under one absolute deadline that each received byte extends
   * at {@link #MIN_COMMAND_BYTES_PER_SECOND}. Reads are nonblocking, expiry is checked before late
   * bytes are credited, and the cap is decided from the raw byte count as soon as it is crossed: a
   * capped prefix is never decoded, because platforms before Android 7.1 decode malformed UTF-8 to
   * fewer bytes than it occupies. Throws SocketTimeoutException past the deadline, EOFException
   * before the newline, {@link CommandRejected} for an empty or over-cap frame, and IOException when
   * a complete frame is not well-formed UTF-8.
   */
  static String readSessionCommand(
      CommandSource source, MonotonicClock clock, long baseDeadlineAtMs, int maxBytes)
      throws IOException {
    ByteArrayOutputStream bytes = new ByteArrayOutputStream();
    byte[] chunk = new byte[8 * 1024];
    while (true) {
      long deadlineAtMs = baseDeadlineAtMs + bytes.size() * 1000L / MIN_COMMAND_BYTES_PER_SECOND;
      if (clock.nowMs() >= deadlineAtMs) {
        throw new SocketTimeoutException("session command read deadline exceeded");
      }
      int count = source.receive(chunk, 0, Math.min(chunk.length, maxBytes + 1 - bytes.size()));
      if (clock.nowMs() > deadlineAtMs) {
        throw new SocketTimeoutException("session command read deadline exceeded");
      }
      if (count < 0) {
        throw new EOFException("session command ended before its newline");
      }
      if (count == 0) {
        remainingBeforeDeadline(clock, deadlineAtMs);
        source.awaitReadable(deadlineAtMs);
        continue;
      }
      int end = 0;
      while (end < count && chunk[end] != '\n') {
        end++;
      }
      // Only command bytes earn read time; bytes after the newline are not part of the frame.
      bytes.write(chunk, 0, end);
      if (bytes.size() > maxBytes) {
        throw new CommandRejected("session command over the byte limit");
      }
      if (end < count) {
        return decodeCommand(bytes.toByteArray());
      }
    }
  }

  /** Decodes a complete frame strictly, so malformed bytes never become replacement text. */
  private static String decodeCommand(byte[] bytes) throws IOException {
    if (bytes.length == 0) {
      throw new CommandRejected("session command is empty");
    }
    CharsetDecoder decoder =
        StandardCharsets.UTF_8
            .newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT);
    try {
      return decoder.decode(ByteBuffer.wrap(bytes)).toString();
    } catch (CharacterCodingException error) {
      throw new IOException("session command is not well-formed UTF-8", error);
    }
  }
}
