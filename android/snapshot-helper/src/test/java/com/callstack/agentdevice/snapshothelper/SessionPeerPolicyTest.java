package com.callstack.agentdevice.snapshothelper;

import java.io.ByteArrayInputStream;
import java.io.EOFException;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

public final class SessionPeerPolicyTest {
  private SessionPeerPolicyTest() {}

  static void run() throws Exception {
    admitsTheAdbdUids();
    rejectsNonAdbdUids();
    commandCompletedAtDeadlineIsAccepted();
    incompleteCommandAtDeadlineCannotStartAnotherRead();
    dripFedLineExpiresEvenWhenTheFinalReadReturnsANewline();
    readHonorsTheByteLimitAndEof();
    eofBeforeTheNewlineIsAnIncompleteFrame();
    overLimitFrameIsDecidedFromRawBytesBeforeTheNewline();
    malformedUtf8AtTheCapIsRejectedNotDecoded();
    aCompleteFrameWithMalformedUtf8NeverReachesTheParser();
    silentPeerIsWaitedForOnlyUntilTheDeadline();
    pauseBeforeTheWaitNeverPollsPastTheDeadline();
    waitTakesTheDeadlineNotAnEarlierDuration();
    maximumFrameAboveTheFloorRateArrivesAfterTheBaseDeadline();
    frameBelowTheFloorRateExpires();
    bytesAfterTheNewlineEarnNoReadTime();
    lateBytesEarnNoTimeBeforeTheExpiryCheck();
    socketNameComesFromTheLaunchedSocketName();
  }

  private static void admitsTheAdbdUids() {
    // adbd with `adb root`, and adbd in its default shell configuration.
    for (int uid : new int[] {0, 2000}) {
      if (!SessionPeerPolicy.isAdmittedPeer(uid)) {
        throw new AssertionError("Expected uid " + uid + " to be admitted");
      }
    }
  }

  private static void rejectsNonAdbdUids() {
    int[] rejected = {1, 1000, 1001, 10_212, 10_999, -1};
    for (int uid : rejected) {
      if (SessionPeerPolicy.isAdmittedPeer(uid)) {
        throw new AssertionError("Expected uid " + uid + " to be rejected");
      }
    }
  }

  private static void commandCompletedAtDeadlineIsAccepted() throws Exception {
    long[] nowMs = {100};
    ByteArrayInputStream input =
        new ByteArrayInputStream("ab\n".getBytes(StandardCharsets.UTF_8)) {
          @Override
          public int read(byte[] data, int offset, int length) {
            nowMs[0] = 110;
            return super.read(data, offset, length);
          }
        };
    String command = read(source(input), () -> nowMs[0], 110, 8);
    if (!"ab".equals(command)) {
      throw new AssertionError("Expected a complete command returned at the deadline");
    }
  }

  private static void incompleteCommandAtDeadlineCannotStartAnotherRead() throws Exception {
    long[] nowMs = {100};
    ByteArrayInputStream input =
        new ByteArrayInputStream("a\n".getBytes(StandardCharsets.UTF_8)) {
          @Override
          public int read(byte[] data, int offset, int length) {
            nowMs[0] = 110;
            return super.read(data, offset, Math.min(1, length));
          }
        };
    try {
      read(source(input), () -> nowMs[0], 110, 8);
      throw new AssertionError("Expected the deadline to stop an unfinished command");
    } catch (SocketTimeoutException expected) {
    }
  }

  private static void dripFedLineExpiresEvenWhenTheFinalReadReturnsANewline() throws Exception {
    long[] nowMs = {100};
    ByteArrayInputStream drip =
        new ByteArrayInputStream("ab\n".getBytes(StandardCharsets.UTF_8)) {
          @Override
          public int read(byte[] data, int offset, int length) {
            nowMs[0] += 4;
            return super.read(data, offset, Math.min(1, length));
          }
        };
    try {
      read(source(drip), () -> nowMs[0], 110, 8);
      throw new AssertionError("A command completed after its absolute deadline was accepted");
    } catch (SocketTimeoutException expected) {
    }
  }

  private static void readHonorsTheByteLimitAndEof() throws Exception {
    if (!"abcd".equals(readFixture("abcd\nignored", 4))) {
      throw new AssertionError("Expected a newline after exactly maxBytes to be accepted");
    }
    // The cap is reached before the newline, so no decode of the capped prefix decides anything.
    for (String overCap : new String[] {"abcde\n", "abcdefg\n"}) {
      try {
        readFixture(overCap, 4);
        throw new AssertionError("Expected the reader to reject more than maxBytes raw bytes");
      } catch (SessionPeerPolicy.CommandRejected expected) {
      }
    }
    try {
      readFixture("\n", 4);
      throw new AssertionError("Expected an empty line to be rejected");
    } catch (SessionPeerPolicy.CommandRejected expected) {
    }
    if (!"snapshot req-1".equals(readFixture("snapshot req-1\n", 64))) {
      throw new AssertionError("Expected a command at the limit to be accepted");
    }
    // Two '€' chars are two chars but six UTF-8 bytes: the cap counts the bytes.
    if (!"€€".equals(readFixture("€€\n", 6))) {
      throw new AssertionError("Expected six bytes at a limit of six to be accepted");
    }
    try {
      readFixture("€€\n", 5);
      throw new AssertionError("Expected six bytes at a limit of five to be rejected");
    } catch (SessionPeerPolicy.CommandRejected expected) {
    }
  }

  /**
   * The frame cap is a raw-byte rule. A capped, unterminated prefix must never be decoded to decide
   * it: on Android 6.0.1 and 7.0, malformed UTF-8 decodes to fewer characters than it occupies, so
   * re-encoding a decoded prefix can read as within the cap and dispatch a truncated command.
   */
  private static void overLimitFrameIsDecidedFromRawBytesBeforeTheNewline() throws Exception {
    byte[] frame = new byte[5];
    Arrays.fill(frame, (byte) 'a');
    // The reader stops as soon as the cap is crossed, without waiting for the newline, and keeps
    // nothing that could be decoded and dispatched.
    try {
      SessionPeerPolicy.readSessionCommand(
          source(new ByteArrayInputStream(frame)), () -> 100, 110, 4);
      throw new AssertionError("Expected the raw byte count to decide an over-cap frame");
    } catch (SessionPeerPolicy.CommandRejected expected) {
    }
  }

  /** Malformed UTF-8 that pushes the raw count past the cap is rejected, not decoded shorter. */
  private static void malformedUtf8AtTheCapIsRejectedNotDecoded() throws Exception {
    // '€' is three bytes; each broken sequence below is one byte that no platform decodes to a
    // whole character. Six raw bytes at a cap of five is over the cap whatever decoding does.
    byte[] frame = new byte[] {'a', 'b', (byte) 0xC3, (byte) 0x28, (byte) 0xA0, 0x00, '\n'};
    try {
      SessionPeerPolicy.readSessionCommand(
          source(new ByteArrayInputStream(frame)), () -> 100, 110, 5);
      throw new AssertionError("Expected a capped malformed frame to be over the limit");
    } catch (SessionPeerPolicy.CommandRejected expected) {
    }
  }

  /** A complete frame whose bytes are not UTF-8 fails closed instead of reaching the parser. */
  private static void aCompleteFrameWithMalformedUtf8NeverReachesTheParser() throws Exception {
    byte[] frame = new byte[] {'s', 'n', (byte) 0xC3, (byte) 0x28, '\n'};
    try {
      SessionPeerPolicy.readSessionCommand(
          source(new ByteArrayInputStream(frame)), () -> 100, 110, 64);
      throw new AssertionError("Expected malformed bytes to be refused instead of replaced");
    } catch (SessionPeerPolicy.CommandRejected unexpected) {
      throw new AssertionError("Expected malformed bytes to fail as a decode error", unexpected);
    } catch (java.io.IOException expected) {
      // The connection closes without dispatch.
    }
  }

  private static void eofBeforeTheNewlineIsAnIncompleteFrame() throws Exception {
    // A prefix that parses as an action must never reach dispatch without its terminator.
    for (String input : new String[] {"", "snapshot req-1", "quit req-1"}) {
      try {
        String command = readFixture(input, 64);
        throw new AssertionError("EOF before the newline returned a command: " + command);
      } catch (EOFException expected) {
        // The connection closes before parsing.
      }
    }
  }

  /** The largest fill frame over a slow remote adb link: 80 KiB/s, slower than 2 s allows. */
  private static void maximumFrameAboveTheFloorRateArrivesAfterTheBaseDeadline() throws Exception {
    int frameBytes = SessionPeerPolicy.MAX_COMMAND_LINE_BYTES;
    String command = readPaced(frameBytes, 8 * 1024, 100);
    if (command.length() != frameBytes) {
      throw new AssertionError("Expected the whole frame, got " + command.length() + " bytes");
    }
  }

  /** Below the floor rate the read still expires, so a slow peer cannot hold the loop for long. */
  private static void frameBelowTheFloorRateExpires() throws Exception {
    try {
      readPaced(SessionPeerPolicy.MAX_COMMAND_LINE_BYTES, 8 * 1024, 200);
      throw new AssertionError("Expected a frame below the floor rate to expire");
    } catch (SocketTimeoutException expected) {
      // The read deadline closed the connection.
    }
  }

  /** A full chunk whose command ends early: the trailing bytes must not extend the deadline. */
  private static void bytesAfterTheNewlineEarnNoReadTime() throws Exception {
    byte[] chunk = new byte[8 * 1024];
    Arrays.fill(chunk, (byte) 'A');
    chunk[2] = '\n';
    long[] nowMs = {0};
    ByteArrayInputStream late =
        new ByteArrayInputStream(chunk) {
          @Override
          public int read(byte[] data, int offset, int length) {
            // The chunk lands 50 ms after the base deadline: inside a whole chunk's credit (125 ms),
            // outside the credit of the two command bytes.
            nowMs[0] = 150;
            return super.read(data, offset, length);
          }
        };
    try {
      read(source(late), () -> nowMs[0], 100, 100_000);
      throw new AssertionError("Bytes after the newline extended the read deadline");
    } catch (SocketTimeoutException expected) {
      // Only the command bytes earned time.
    }
  }

  /**
   * A receive that lands after the deadline, carrying a whole command: the expiry check runs before
   * its bytes are credited, so they never buy the read more time.
   */
  private static void lateBytesEarnNoTimeBeforeTheExpiryCheck() throws Exception {
    long[] nowMs = {100};
    ByteArrayInputStream late =
        new ByteArrayInputStream("snapshot req-1\n".getBytes(StandardCharsets.UTF_8)) {
          @Override
          public int read(byte[] data, int offset, int length) {
            nowMs[0] = 5_100;
            return super.read(data, offset, length);
          }
        };
    try {
      read(source(late), () -> nowMs[0], 2_000, 4_096);
      throw new AssertionError("A late receive extended the read deadline");
    } catch (SocketTimeoutException expected) {
      // The read closed on the deadline it already had.
    }
  }

  /** Reads a newline-terminated frame delivered in chunks, each advancing the clock. */
  private static String readPaced(int frameBytes, int chunkBytes, long msPerChunk) throws Exception {
    byte[] frame = new byte[frameBytes + 1];
    Arrays.fill(frame, (byte) 'A');
    frame[frameBytes] = '\n';
    long[] nowMs = {0};
    ByteArrayInputStream paced =
        new ByteArrayInputStream(frame) {
          @Override
          public int read(byte[] data, int offset, int length) {
            nowMs[0] += msPerChunk;
            return super.read(data, offset, Math.min(chunkBytes, length));
          }
        };
    return read(
        source(paced), () -> nowMs[0], 2_000, SessionPeerPolicy.MAX_COMMAND_LINE_BYTES);
  }

  /** A peer that sends nothing: one wait, for exactly what the deadline has left. */
  private static void silentPeerIsWaitedForOnlyUntilTheDeadline() throws Exception {
    long[] nowMs = {100};
    List<Long> waits = new ArrayList<>();
    SessionPeerPolicy.CommandSource silent =
        new SessionPeerPolicy.CommandSource() {
          @Override
          public int receive(byte[] data, int offset, int length) {
            return 0;
          }

          @Override
          public void awaitReadable(long deadlineAtMs) {
            waits.add(deadlineAtMs - nowMs[0]);
            nowMs[0] = deadlineAtMs;
          }
        };
    try {
      SessionPeerPolicy.readSessionCommand(silent, () -> nowMs[0], 2_100, 64);
      throw new AssertionError("Expected a silent peer to expire");
    } catch (SocketTimeoutException expected) {
      if (!waits.equals(Arrays.asList(2_000L)) || nowMs[0] != 2_100) {
        throw new AssertionError("Expected one 2,000 ms wait ending at the deadline: " + waits);
      }
    }
  }

  /** The reader is paused after a receive that found nothing, past the deadline: no wait may start. */
  private static void pauseBeforeTheWaitNeverPollsPastTheDeadline() throws Exception {
    long[] nowMs = {100};
    SessionPeerPolicy.CommandSource paused =
        new SessionPeerPolicy.CommandSource() {
          @Override
          public int receive(byte[] data, int offset, int length) {
            nowMs[0] = 4_100;
            return 0;
          }

          @Override
          public void awaitReadable(long deadlineAtMs) {
            throw new AssertionError(
                "Waited until " + deadlineAtMs + " after the deadline, at " + nowMs[0]);
          }
        };
    try {
      SessionPeerPolicy.readSessionCommand(paused, () -> nowMs[0], 2_100, 64);
      throw new AssertionError("Expected the used-up deadline to end the read");
    } catch (SocketTimeoutException expected) {
      // The read closed without waiting.
    }
  }

  /**
   * The wait gets the deadline, not a duration measured before the wait. A connection that pauses
   * between the deadline check and Os.poll must still derive its own duration from the deadline.
   */
  private static void waitTakesTheDeadlineNotAnEarlierDuration() throws Exception {
    long[] nowMs = {1_000};
    long[] askedToWaitUntil = {0};
    SessionPeerPolicy.CommandSource pausing =
        new SessionPeerPolicy.CommandSource() {
          @Override
          public int receive(byte[] data, int offset, int length) {
            return 0;
          }

          @Override
          public void awaitReadable(long deadlineAtMs) throws java.io.IOException {
            askedToWaitUntil[0] = deadlineAtMs;
            // A pause before the poll would make a duration sampled earlier wait past the deadline.
            nowMs[0] += 3_000;
            long remainingMs =
                SessionPeerPolicy.remainingBeforeDeadline(() -> nowMs[0], deadlineAtMs);
            throw new IllegalStateException(
                "Expected the deadline to have expired, left " + remainingMs);
          }
        };
    try {
      SessionPeerPolicy.readSessionCommand(pausing, () -> nowMs[0], 2_000, 64);
      throw new AssertionError("Expected the expired deadline to end the wait");
    } catch (SocketTimeoutException expected) {
      if (askedToWaitUntil[0] != 2_000) {
        throw new AssertionError(
            "Expected the wait to be given the deadline: " + askedToWaitUntil[0]);
      }
    }
  }

  /** Adapts a test stream: each receive returns what the stream gives, and never waits. */
  private static SessionPeerPolicy.CommandSource source(java.io.InputStream input) {
    return new SessionPeerPolicy.CommandSource() {
      @Override
      public int receive(byte[] data, int offset, int length) throws java.io.IOException {
        return input.read(data, offset, length);
      }

      @Override
      public void awaitReadable(long deadlineAtMs) {
        throw new AssertionError("A stream fixture always has data or EOF");
      }
    };
  }

  private static String read(
      SessionPeerPolicy.CommandSource source,
      SessionPeerPolicy.MonotonicClock clock,
      long baseDeadlineAtMs,
      int maxBytes)
      throws Exception {
    return SessionPeerPolicy.readSessionCommand(source, clock, baseDeadlineAtMs, maxBytes);
  }

  private static String readFixture(String input, int maxBytes) throws Exception {
    return read(
        source(new ByteArrayInputStream(input.getBytes(StandardCharsets.UTF_8))),
        () -> 100,
        110,
        maxBytes);
  }

  private static void socketNameComesFromTheLaunchedSocketName() {
    // The host owns the name; the helper binds it unchanged.
    if (!"agentdevice-snapshot-helper-18093".equals(
        SessionPeerPolicy.sessionSocketName("agentdevice-snapshot-helper-18093"))) {
      throw new AssertionError("Expected the launched socket name to be bound unchanged");
    }
    // A name outside the helper's own namespace is refused: the session cannot bind a socket that
    // belongs to something else on the device.
    for (String refused : new String[] {"abstract-socket", "", "agentdevice"}) {
      try {
        SessionPeerPolicy.sessionSocketName(refused);
        throw new AssertionError("Expected a name outside the namespace to be refused: " + refused);
      } catch (IllegalArgumentException expected) {
      }
    }
    try {
      SessionPeerPolicy.sessionSocketName(null);
      throw new AssertionError("Expected a missing socket name to be refused");
    } catch (IllegalArgumentException expected) {
    }
    if (!"authenticated-session-v1".equals(SessionPeerPolicy.AUTHENTICATED_SESSION_MODE)) {
      throw new AssertionError("Expected the activation mode the host launches with");
    }
  }
}
