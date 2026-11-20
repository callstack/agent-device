package com.callstack.agentdevice.snapshothelper;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

public final class SessionHandshakeTest {
  private SessionHandshakeTest() {}

  private static final byte[] SECRET = filled(32, 7);
  private static final byte[] SERVER_NONCE = filled(32, 9);
  private static final String CLIENT_NONCE = "ab".repeat(32);
  private static final String COMMAND = "snapshot req-1\n";

  static void run() throws Exception {
    provenPeerReachesTheCommand();
    connectionWithoutTheClientProofNeverReadsTheCommand();
    wrongClientProofNeverReadsTheCommand();
    replayedClientProofFails();
    serverProofBindsToTheClientNonce();
    malformedClientNonceGetsNoServerProof();
  }

  private static void provenPeerReachesTheCommand() throws Exception {
    Script peer = new Script(CLIENT_NONCE + "\n" + clientProof(SERVER_NONCE, CLIENT_NONCE) + "\n" + COMMAND);
    List<String> written = authenticate(peer, SERVER_NONCE);
    String command =
        SessionPeerPolicy.readSessionCommand(peer, () -> 0, 2_000, SessionPeerPolicy.MAX_COMMAND_LINE_BYTES);
    if (!"snapshot req-1".equals(command) || written.size() != 1) {
      throw new AssertionError("Expected the command after a proven handshake: " + command);
    }
  }

  /**
   * A peer that sends commands where the proof belongs is refused. The handshake reads at most one
   * proof-sized line for it, so the frame that would follow is never read.
   */
  private static void connectionWithoutTheClientProofNeverReadsTheCommand() throws Exception {
    String frame = "input req-2 " + "A".repeat(200) + "\n";
    Script peer = new Script(CLIENT_NONCE + "\n" + COMMAND + frame);
    expectRefused(peer, SERVER_NONCE);
    if (peer.consumed > 2 * (SessionPeerPolicy.PROOF_HEX_CHARS + 1)) {
      throw new AssertionError("The handshake read past its window: " + peer.consumed);
    }
  }

  private static void wrongClientProofNeverReadsTheCommand() throws Exception {
    Script peer = new Script(CLIENT_NONCE + "\n" + "00".repeat(32) + "\n" + COMMAND);
    expectRefused(peer, SERVER_NONCE);
    if (peer.consumed != 2 * (SessionPeerPolicy.PROOF_HEX_CHARS + 1)) {
      throw new AssertionError("The command bytes were read: consumed " + peer.consumed);
    }
  }

  /** A client proof recorded on one connection does not answer another connection's nonce. */
  private static void replayedClientProofFails() throws Exception {
    byte[] otherServerNonce = filled(32, 10);
    Script peer = new Script(CLIENT_NONCE + "\n" + clientProof(SERVER_NONCE, CLIENT_NONCE) + "\n" + COMMAND);
    expectRefused(peer, otherServerNonce);
  }

  /** The server proof covers the client nonce, so a recorded answer cannot serve another nonce. */
  private static void serverProofBindsToTheClientNonce() throws Exception {
    String otherClientNonce = "cd".repeat(32);
    String first = serverHello(CLIENT_NONCE);
    String second = serverHello(otherClientNonce);
    String server = SessionPeerPolicy.hex(SERVER_NONCE);
    String expected = server + " " + hmac("agent-device-session-server|" + CLIENT_NONCE + server) + "\n";
    if (!expected.equals(first) || first.equals(second)) {
      throw new AssertionError("Expected a server proof bound to the client nonce: " + first);
    }
  }

  private static void malformedClientNonceGetsNoServerProof() throws Exception {
    for (String nonce : new String[] {"", "AB".repeat(32), "ab".repeat(31), "ab".repeat(33)}) {
      Script peer = new Script(nonce + "\n");
      List<String> written = new ArrayList<>();
      try {
        SessionPeerPolicy.authenticatePeer(peer, frame -> written.add(text(frame)), () -> 0, 2_000, SECRET, SERVER_NONCE);
        throw new AssertionError("Expected nonce \"" + nonce + "\" to be refused");
      } catch (IOException expected) {
        if (!written.isEmpty()) throw new AssertionError("A malformed nonce got a server proof");
      }
    }
  }

  private static String serverHello(String clientNonce) throws Exception {
    // The client proof is wrong, so the handshake ends after the hello it wrote.
    Script peer = new Script(clientNonce + "\n" + "00".repeat(32) + "\n");
    List<String> written = new ArrayList<>();
    try {
      SessionPeerPolicy.authenticatePeer(peer, frame -> written.add(text(frame)), () -> 0, 2_000, SECRET, SERVER_NONCE);
    } catch (IOException expected) {
      // The wrong client proof ends the handshake.
    }
    return written.get(0);
  }

  private static List<String> authenticate(Script peer, byte[] serverNonce) throws IOException {
    List<String> written = new ArrayList<>();
    SessionPeerPolicy.authenticatePeer(peer, frame -> written.add(text(frame)), () -> 0, 2_000, SECRET, serverNonce);
    return written;
  }

  private static void expectRefused(Script peer, byte[] serverNonce) {
    try {
      authenticate(peer, serverNonce);
      throw new AssertionError("Expected the handshake to refuse the peer");
    } catch (IOException expected) {
      // The caller closes the connection without reading a command.
    }
  }

  private static String clientProof(byte[] serverNonce, String clientNonce) throws Exception {
    return hmac("agent-device-session-client|" + SessionPeerPolicy.hex(serverNonce) + clientNonce);
  }

  /** HMAC-SHA256 computed here, independently of the helper. */
  private static String hmac(String message) throws Exception {
    Mac mac = Mac.getInstance("HmacSHA256");
    mac.init(new SecretKeySpec(SECRET, "HmacSHA256"));
    StringBuilder hex = new StringBuilder();
    for (byte value : mac.doFinal(message.getBytes(StandardCharsets.US_ASCII))) {
      hex.append(String.format("%02x", value));
    }
    return hex.toString();
  }

  private static String text(SessionResponseWriter.Frame frame) {
    return new String(frame.head, StandardCharsets.US_ASCII) + new String(frame.body, StandardCharsets.US_ASCII);
  }

  private static byte[] filled(int length, int value) {
    byte[] bytes = new byte[length];
    Arrays.fill(bytes, (byte) value);
    return bytes;
  }

  /** A peer whose bytes are all ready; each receive takes at most what the reader asked for. */
  private static final class Script implements SessionPeerPolicy.CommandSource {
    private final byte[] bytes;
    int consumed;

    Script(String text) {
      this.bytes = text.getBytes(StandardCharsets.US_ASCII);
    }

    @Override
    public int receive(byte[] data, int offset, int length) {
      if (consumed >= bytes.length) return -1;
      int count = Math.min(length, bytes.length - consumed);
      System.arraycopy(bytes, consumed, data, offset, count);
      consumed += count;
      return count;
    }

    @Override
    public void awaitReadable(long deadlineAtMs) {
      throw new AssertionError("A scripted peer always has data or EOF");
    }
  }
}
