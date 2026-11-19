package com.callstack.agentdevice.snapshothelper;

import java.nio.charset.StandardCharsets;

public final class SessionPeerPolicyTest {
  private SessionPeerPolicyTest() {}

  static void run() {
    admitsTheAdbdUids();
    rejectsNonAdbdUids();
    deadlineFollowsTheSessionTimeout();
    deadlineFallsBackWhenTheSessionTimeoutIsUnset();
    deadlineFitsSocketTimeout();
    deadlineIsAbsoluteFromAcceptTime();
    remainingBudgetNeverGoesNegative();
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

  private static void deadlineIsAbsoluteFromAcceptTime() {
    long deadline = SessionPeerPolicy.commandReadDeadlineAtMs(1_000, 8_000);
    if (deadline != 9_000) {
      throw new AssertionError("Expected the deadline to be fixed at accept plus the budget");
    }
    // A peer that drip-feeds reads still sees the same fixed deadline: the budget shrinks with the
    // clock, it does not reset per read.
    if (SessionPeerPolicy.remainingBudgetMs(deadline, 5_000) != 4_000) {
      throw new AssertionError("Expected the remaining budget to shrink with elapsed time");
    }
    if (SessionPeerPolicy.remainingBudgetMs(deadline, 9_000) != 0) {
      throw new AssertionError("Expected the budget to be spent at the deadline");
    }
  }

  private static void remainingBudgetNeverGoesNegative() {
    if (SessionPeerPolicy.remainingBudgetMs(1_000, 5_000) != 0) {
      throw new AssertionError("Expected a spent deadline to report zero, not a negative budget");
    }
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
