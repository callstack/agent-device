package com.callstack.agentdevice.snapshothelper;

import java.io.ByteArrayInputStream;
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
    deadlineFollowsTheSessionTimeout();
    deadlineFallsBackWhenTheSessionTimeoutIsUnset();
    deadlineFitsSocketTimeout();
    dripFedLineExpiresEvenWhenTheFinalReadReturnsANewline();
    readHonorsTheByteLimitAndEof();
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

  private static void deadlineFollowsTheSessionTimeout() {
    if (SessionPeerPolicy.commandReadDeadlineMs(8_000, 500) != 8_000) {
      throw new AssertionError("Expected the session timeout to bound the read");
    }
    if (SessionPeerPolicy.commandReadDeadlineMs(1, 8_000) != 1) {
      throw new AssertionError("Expected even a one-millisecond session timeout to be honored");
    }
  }

  private static void deadlineFallsBackWhenTheSessionTimeoutIsUnset() {
    if (SessionPeerPolicy.commandReadDeadlineMs(0, 8_000) != 8_000) {
      throw new AssertionError("Expected a zero session timeout to fall back");
    }
    if (SessionPeerPolicy.commandReadDeadlineMs(-5, 8_000) != 8_000) {
      throw new AssertionError("Expected a negative session timeout to fall back");
    }
  }

  private static void deadlineFitsSocketTimeout() {
    if (SessionPeerPolicy.commandReadDeadlineMs(Long.MAX_VALUE, 8_000) != Integer.MAX_VALUE) {
      throw new AssertionError("Expected the read budget to fit LocalSocket.setSoTimeout");
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
    } catch (SocketTimeoutException expected) {
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
    if (readFixture("", 4) != null) {
      throw new AssertionError("Expected EOF before any byte to return null");
    }
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
    if (SessionPeerPolicy.commandLineDecision(null, 64) != SessionPeerPolicy.LineDecision.REJECTED_EMPTY) {
      throw new AssertionError("Expected an end-of-stream line to be rejected as empty");
    }
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
