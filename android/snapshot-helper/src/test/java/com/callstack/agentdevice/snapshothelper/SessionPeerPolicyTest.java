package com.callstack.agentdevice.snapshothelper;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
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
    maximumFrameAboveTheFloorRateArrivesAfterTheBaseDeadline();
    frameBelowTheFloorRateExpires();
    eofBeforeTheNewlineIsAnIncompleteFrame();
    socketReadTimeoutIsAnExpiredRead();
    socketNameIsDerivedFromThePortAndCarriesNoSecret();
    acceptsCommandLinesUpToTheByteLimit();
    rejectsEmptyCommandLines();
    rejectsCommandLinesOverTheByteLimit();
    countsUtf8BytesNotChars();
  }

  private static void admitsTheAdbdUids() {
    expectAdmitted(SessionPeerPolicy.PEER_UID_ROOT);
    expectAdmitted(SessionPeerPolicy.PEER_UID_SHELL);
  }

  private static void rejectsNonAdbdUids() {
    int[] rejected = {1, 1000, 1001, 10_212, 10_999, -1};
    for (int uid : rejected) {
      if (SessionPeerPolicy.admitPeer(uid) != SessionPeerPolicy.Admission.REJECTED_UNAUTHORIZED_PEER) {
        throw new AssertionError("Expected uid " + uid + " to be rejected");
      }
    }
  }

  private static void commandCompletedAtDeadlineIsAccepted() throws Exception {
    long[] nowMs = {100};
    ByteArrayInputStream input = new ByteArrayInputStream("ab\n".getBytes(StandardCharsets.UTF_8)) {
      @Override
      public int read(byte[] data, int offset, int length) {
        nowMs[0] = 110;
        return super.read(data, offset, length);
      }
    };
    String command = SessionPeerPolicy.readSessionCommandLine(
        input, ignored -> {}, () -> nowMs[0], 110, 8);
    if (!"ab".equals(command)) {
      throw new AssertionError("Expected a complete command returned at the deadline");
    }
  }

  private static void incompleteCommandAtDeadlineCannotStartAnotherRead() throws Exception {
    long[] nowMs = {100};
    List<Integer> timeouts = new ArrayList<>();
    ByteArrayInputStream input = new ByteArrayInputStream("a\n".getBytes(StandardCharsets.UTF_8)) {
      @Override
      public int read(byte[] data, int offset, int length) {
        nowMs[0] = 110;
        return super.read(data, offset, Math.min(1, length));
      }
    };
    try {
      SessionPeerPolicy.readSessionCommandLine(input, timeouts::add, () -> nowMs[0], 110, 8);
      throw new AssertionError("Expected the deadline to stop an unfinished command");
    } catch (SessionPeerPolicy.SessionReadClosed expected) {
      expectReason(expected, SessionPeerPolicy.ReadFailure.EXPIRED);
      if (!timeouts.equals(Arrays.asList(10))) {
        throw new AssertionError("Expected one bounded read and no zero timeout: " + timeouts);
      }
    }
  }

  private static void dripFedLineExpiresEvenWhenTheFinalReadReturnsANewline() throws Exception {
    long[] nowMs = {100};
    List<Integer> timeouts = new ArrayList<>();
    ByteArrayInputStream drip = new ByteArrayInputStream("ab\n".getBytes(StandardCharsets.UTF_8)) {
      @Override
      public int read(byte[] data, int offset, int length) {
        nowMs[0] += 4;
        return super.read(data, offset, Math.min(1, length));
      }
    };
    try {
      SessionPeerPolicy.readSessionCommandLine(drip, timeouts::add, () -> nowMs[0], 110, 8);
      throw new AssertionError("A command completed after its absolute deadline was accepted");
    } catch (SessionPeerPolicy.SessionReadClosed expected) {
      expectReason(expected, SessionPeerPolicy.ReadFailure.EXPIRED);
      if (!timeouts.equals(Arrays.asList(10, 6, 2))) {
        throw new AssertionError("The timeout must shrink before each read: " + timeouts);
      }
    }
  }

  private static void readHonorsTheByteLimitAndEof() throws Exception {
    String atLimit = readFixture("abcd\nignored", 4);
    if (!"abcd".equals(atLimit)
        || SessionPeerPolicy.commandLineDecision(atLimit, 4) != SessionPeerPolicy.LineDecision.ACCEPTED) {
      throw new AssertionError("Expected a newline after exactly maxBytes to be accepted");
    }
    String overLimit = readFixture("abcdef\n", 4);
    if (!"abcde".equals(overLimit)
        || SessionPeerPolicy.commandLineDecision(overLimit, 4)
            != SessionPeerPolicy.LineDecision.REJECTED_OVER_LIMIT) {
      throw new AssertionError("Expected the reader to stop and reject maxBytes + 1");
    }
  }

  private static void eofBeforeTheNewlineIsAnIncompleteFrame() throws Exception {
    // A prefix that parses as an action must never reach dispatch without its terminator.
    for (String input : new String[] {"", "snapshot req-1", "quit req-1"}) {
      try {
        String command = readFixture(input, 64);
        throw new AssertionError("EOF before the newline returned a command: " + command);
      } catch (SessionPeerPolicy.SessionReadClosed expected) {
        expectReason(expected, SessionPeerPolicy.ReadFailure.INCOMPLETE);
      }
    }
  }

  private static void socketReadTimeoutIsAnExpiredRead() throws Exception {
    InputStream silent = new InputStream() {
      @Override
      public int read() throws IOException {
        throw new SocketTimeoutException("Read timed out");
      }

      @Override
      public int read(byte[] data, int offset, int length) throws IOException {
        throw new SocketTimeoutException("Read timed out");
      }
    };
    try {
      SessionPeerPolicy.readSessionCommandLine(silent, ignored -> {}, () -> 100, 110, 8);
      throw new AssertionError("Expected a socket read timeout to close the read");
    } catch (SessionPeerPolicy.SessionReadClosed expected) {
      expectReason(expected, SessionPeerPolicy.ReadFailure.EXPIRED);
    }
  }

  private static void expectReason(
      SessionPeerPolicy.SessionReadClosed closed, SessionPeerPolicy.ReadFailure reason) {
    if (closed.reason != reason) {
      throw new AssertionError("Expected read failure " + reason + ", got " + closed.reason);
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

  /** Reads a newline-terminated frame delivered in chunks, each advancing the clock. */
  private static String readPaced(int frameBytes, int chunkBytes, long msPerChunk) throws Exception {
    byte[] frame = new byte[frameBytes + 1];
    Arrays.fill(frame, (byte) 'A');
    frame[frameBytes] = '\n';
    long[] nowMs = {0};
    ByteArrayInputStream paced = new ByteArrayInputStream(frame) {
      @Override
      public int read(byte[] data, int offset, int length) {
        nowMs[0] += msPerChunk;
        return super.read(data, offset, Math.min(chunkBytes, length));
      }
    };
    return SessionPeerPolicy.readSessionCommandLine(
        paced, ignored -> {}, () -> nowMs[0], 2_000, SessionPeerPolicy.MAX_COMMAND_LINE_BYTES);
  }

  private static String readFixture(String input, int maxBytes) throws Exception {
    return SessionPeerPolicy.readSessionCommandLine(
        new ByteArrayInputStream(input.getBytes(StandardCharsets.UTF_8)),
        ignored -> {}, () -> 100, 110, maxBytes);
  }

  private static void socketNameIsDerivedFromThePortAndCarriesNoSecret() {
    if (!"agentdevice-snapshot-helper-18093".equals(SessionPeerPolicy.sessionSocketName(18_093))) {
      throw new AssertionError("Expected the socket name to derive from the session port");
    }
    if (!SessionPeerPolicy.sessionSocketName(1).equals(SessionPeerPolicy.sessionSocketName(1))) {
      throw new AssertionError("Expected the socket name derivation to be deterministic");
    }
    if (SessionPeerPolicy.sessionSocketName(1).equals(SessionPeerPolicy.sessionSocketName(2))) {
      throw new AssertionError("Expected distinct ports to name distinct sockets");
    }
  }

  private static void acceptsCommandLinesUpToTheByteLimit() {
    if (SessionPeerPolicy.commandLineDecision("snapshot req-1", 64) != SessionPeerPolicy.LineDecision.ACCEPTED) {
      throw new AssertionError("Expected a short command line to be accepted");
    }
    String atLimit = repeat('a', 64);
    if (SessionPeerPolicy.commandLineDecision(atLimit, 64) != SessionPeerPolicy.LineDecision.ACCEPTED) {
      throw new AssertionError("Expected a line of exactly the limit to be accepted");
    }
  }

  private static void rejectsEmptyCommandLines() {
    if (SessionPeerPolicy.commandLineDecision("", 64) != SessionPeerPolicy.LineDecision.REJECTED_EMPTY) {
      throw new AssertionError("Expected an empty line to be rejected as empty");
    }
  }

  private static void rejectsCommandLinesOverTheByteLimit() {
    String overLimit = repeat('a', 65);
    if (SessionPeerPolicy.commandLineDecision(overLimit, 64) != SessionPeerPolicy.LineDecision.REJECTED_OVER_LIMIT) {
      throw new AssertionError("Expected a line over the limit to be rejected");
    }
  }

  private static void countsUtf8BytesNotChars() {
    // Two '€' chars are two chars but six UTF-8 bytes.
    String multibyte = "€€";
    if (multibyte.getBytes(StandardCharsets.UTF_8).length != 6) {
      throw new AssertionError("Expected the multibyte fixture to be six bytes");
    }
    if (SessionPeerPolicy.commandLineDecision(multibyte, 6) != SessionPeerPolicy.LineDecision.ACCEPTED) {
      throw new AssertionError("Expected six bytes at a limit of six to be accepted");
    }
    if (SessionPeerPolicy.commandLineDecision(multibyte, 5) != SessionPeerPolicy.LineDecision.REJECTED_OVER_LIMIT) {
      throw new AssertionError("Expected six bytes at a limit of five to be rejected");
    }
  }

  private static void expectAdmitted(int uid) {
    if (SessionPeerPolicy.admitPeer(uid) != SessionPeerPolicy.Admission.ADMITTED) {
      throw new AssertionError("Expected uid " + uid + " to be admitted");
    }
  }

  private static String repeat(char value, int count) {
    StringBuilder builder = new StringBuilder(count);
    for (int i = 0; i < count; i += 1) {
      builder.append(value);
    }
    return builder.toString();
  }
}
