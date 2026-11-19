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
    silentPeerIsWaitedForOnlyUntilTheDeadline();
    pauseBeforeTheWaitNeverPollsPastTheDeadline();
    maximumFrameAboveTheFloorRateArrivesAfterTheBaseDeadline();
    frameBelowTheFloorRateExpires();
    bytesAfterTheNewlineEarnNoReadTime();
    eofBeforeTheNewlineIsAnIncompleteFrame();
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
    String command = SessionPeerPolicy.readSessionCommandLine(source(input), () -> nowMs[0], 110, 8);
    if (!"ab".equals(command)) {
      throw new AssertionError("Expected a complete command returned at the deadline");
    }
  }

  private static void incompleteCommandAtDeadlineCannotStartAnotherRead() throws Exception {
    long[] nowMs = {100};
    ByteArrayInputStream input = new ByteArrayInputStream("a\n".getBytes(StandardCharsets.UTF_8)) {
      @Override
      public int read(byte[] data, int offset, int length) {
        nowMs[0] = 110;
        return super.read(data, offset, Math.min(1, length));
      }
    };
    try {
      SessionPeerPolicy.readSessionCommandLine(source(input), () -> nowMs[0], 110, 8);
      throw new AssertionError("Expected the deadline to stop an unfinished command");
    } catch (SocketTimeoutException expected) {
    }
  }

  private static void dripFedLineExpiresEvenWhenTheFinalReadReturnsANewline() throws Exception {
    long[] nowMs = {100};
    ByteArrayInputStream drip = new ByteArrayInputStream("ab\n".getBytes(StandardCharsets.UTF_8)) {
      @Override
      public int read(byte[] data, int offset, int length) {
        nowMs[0] += 4;
        return super.read(data, offset, Math.min(1, length));
      }
    };
    try {
      SessionPeerPolicy.readSessionCommandLine(source(drip), () -> nowMs[0], 110, 8);
      throw new AssertionError("A command completed after its absolute deadline was accepted");
    } catch (SocketTimeoutException expected) {
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
    ByteArrayInputStream late = new ByteArrayInputStream(chunk) {
      @Override
      public int read(byte[] data, int offset, int length) {
        // The chunk lands 50 ms after the base deadline: inside a whole chunk's credit (125 ms),
        // outside the credit of the two command bytes.
        nowMs[0] = 150;
        return super.read(data, offset, length);
      }
    };
    try {
      SessionPeerPolicy.readSessionCommandLine(source(late), () -> nowMs[0], 100, 100_000);
      throw new AssertionError("Bytes after the newline extended the read deadline");
    } catch (SocketTimeoutException expected) {
      // Only the command bytes earned time.
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
    return SessionPeerPolicy.readSessionCommandLine(source(paced), () -> nowMs[0], 2_000, SessionPeerPolicy.MAX_COMMAND_LINE_BYTES);
  }

  /** A peer that sends nothing: one wait, for exactly what the deadline has left. */
  private static void silentPeerIsWaitedForOnlyUntilTheDeadline() throws Exception {
    long[] nowMs = {100};
    List<Long> waits = new ArrayList<>();
    SessionPeerPolicy.CommandSource silent = new SessionPeerPolicy.CommandSource() {
      @Override
      public int receive(byte[] data, int offset, int length) {
        return 0;
      }

      @Override
      public void awaitReadable(long timeoutMs) {
        waits.add(timeoutMs);
        nowMs[0] += timeoutMs;
      }
    };
    try {
      SessionPeerPolicy.readSessionCommandLine(silent, () -> nowMs[0], 2_100, 64);
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
    SessionPeerPolicy.CommandSource paused = new SessionPeerPolicy.CommandSource() {
      @Override
      public int receive(byte[] data, int offset, int length) {
        nowMs[0] = 4_100;
        return 0;
      }

      @Override
      public void awaitReadable(long timeoutMs) {
        throw new AssertionError("Waited " + timeoutMs + " ms after the deadline, at " + nowMs[0]);
      }
    };
    try {
      SessionPeerPolicy.readSessionCommandLine(paused, () -> nowMs[0], 2_100, 64);
      throw new AssertionError("Expected the used-up deadline to end the read");
    } catch (SocketTimeoutException expected) {
      // The read closed without waiting.
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
      public void awaitReadable(long timeoutMs) {
        throw new AssertionError("A stream fixture always has data or EOF");
      }
    };
  }

  private static String readFixture(String input, int maxBytes) throws Exception {
    return SessionPeerPolicy.readSessionCommandLine(
        source(new ByteArrayInputStream(input.getBytes(StandardCharsets.UTF_8))),
        () -> 100, 110, maxBytes);
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
