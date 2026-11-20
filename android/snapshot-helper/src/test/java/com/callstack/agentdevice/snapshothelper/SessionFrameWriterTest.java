package com.callstack.agentdevice.snapshothelper;

import java.io.IOException;
import java.io.InputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.SocketTimeoutException;
import java.nio.ByteBuffer;
import java.nio.channels.SelectionKey;
import java.nio.channels.Selector;
import java.nio.channels.ServerSocketChannel;
import java.nio.channels.SocketChannel;

public final class SessionFrameWriterTest {
  private SessionFrameWriterTest() {}

  private static final int LARGE_FRAME_BYTES = 32 * 1024 * 1024;

  static void run() throws Exception {
    tricklingPeerCannotExtendTheDeadlinePerSend();
    zeroProgressSendThatUsesTheBudgetNeverPolls();
    pollWaitsOnlyForWhatIsLeft();
    pauseBeforeTheWaitNeverPollsPastTheDeadline();
    stalledReaderUnderRealBackpressureClosesAtTheDeadline();
    readingPeerReceivesTheWholeFrame();
  }

  /**
   * A peer that takes one byte per send and stalls between sends. A send timeout that restarts on
   * every send never expires; one deadline per frame does.
   */
  private static void tricklingPeerCannotExtendTheDeadlinePerSend() throws Exception {
    long[] nowMs = {0};
    int[] sent = {0};
    SessionFrameWriter.Channel trickle = new SessionFrameWriter.Channel() {
      @Override
      public int send(byte[] data, int offset, int length) {
        nowMs[0] += 100;
        sent[0] += 1;
        return 1;
      }

      @Override
      public void awaitWritable(long deadlineAtMs) {
        throw new AssertionError("The trickle always takes a byte");
      }
    };
    // 1,000 ms base plus 1,000 bytes at 1,000 B/s: the deadline is 2,000 ms after the first byte.
    SessionFrameWriter writer = new SessionFrameWriter(trickle, () -> nowMs[0], 1_000, 1_000);
    try {
      writer.write(frame(1_000));
      throw new AssertionError("Expected the frame deadline to stop a trickling peer");
    } catch (SocketTimeoutException expected) {
      if (nowMs[0] > 2_100 || sent[0] > 21) {
        throw new AssertionError("The deadline moved: " + nowMs[0] + " ms, " + sent[0] + " sends");
      }
    }
  }

  /** The send itself takes the rest of the budget and moves no bytes: no poll may start. */
  private static void zeroProgressSendThatUsesTheBudgetNeverPolls() throws Exception {
    long[] nowMs = {0};
    SessionFrameWriter.Channel stalled = new SessionFrameWriter.Channel() {
      @Override
      public int send(byte[] data, int offset, int length) {
        nowMs[0] += 5_000;
        return 0;
      }

      @Override
      public void awaitWritable(long deadlineAtMs) {
        throw new AssertionError("Polled until " + deadlineAtMs + " after the deadline at " + nowMs[0]);
      }
    };
    try {
      new SessionFrameWriter(stalled, () -> nowMs[0], 1_000, Integer.MAX_VALUE).write(frame(10));
      throw new AssertionError("Expected the used-up budget to end the write");
    } catch (SocketTimeoutException expected) {
      // The writer gave up without polling.
    }
  }

  /** A slow zero-progress send leaves less to wait for; the poll gets only the remainder. */
  private static void pollWaitsOnlyForWhatIsLeft() throws Exception {
    long[] nowMs = {0};
    final java.util.List<Long> waits = new java.util.ArrayList<>();
    SessionFrameWriter.Channel slow = new SessionFrameWriter.Channel() {
      @Override
      public int send(byte[] data, int offset, int length) {
        nowMs[0] += 400;
        return 0;
      }

      @Override
      public void awaitWritable(long deadlineAtMs) throws IOException {
        // The wait derives its own duration from the deadline it was given, which is what the real
        // channel does before Os.poll.
        waits.add(SessionPeerPolicy.remainingBeforeDeadline(() -> nowMs[0], deadlineAtMs));
        nowMs[0] = deadlineAtMs;
      }
    };
    try {
      new SessionFrameWriter(slow, () -> nowMs[0], 1_000, Integer.MAX_VALUE).write(frame(10));
      throw new AssertionError("Expected the deadline to end the write");
    } catch (SocketTimeoutException expected) {
      if (!waits.equals(java.util.Arrays.asList(600L)) || nowMs[0] > 1_400) {
        throw new AssertionError("Expected one 600 ms wait, got " + waits + " ending at " + nowMs[0]);
      }
    }
  }

  /**
   * The write wait takes the absolute deadline, not a duration measured before the wait, and it
   * re-checks the deadline when it starts. A socket that pauses between the deadline check and its
   * poll must not poll at all once the deadline has gone (#4519 review, item 2).
   */
  private static void pauseBeforeTheWaitNeverPollsPastTheDeadline() throws Exception {
    long[] nowMs = {0};
    final long[] waitedUntilMs = {-1};
    final boolean[] polled = {false};
    SessionFrameWriter.Channel pausing = new SessionFrameWriter.Channel() {
      @Override
      public int send(byte[] data, int offset, int length) {
        nowMs[0] = 900;
        return 0;
      }

      @Override
      public void awaitWritable(long deadlineAtMs) throws IOException {
        waitedUntilMs[0] = deadlineAtMs;
        // A pause before polling. The time left has to be measured here, and a poll may only start
        // when the deadline still allows it.
        nowMs[0] = 5_000;
        SessionPeerPolicy.remainingBeforeDeadline(() -> nowMs[0], deadlineAtMs);
        polled[0] = true;
      }
    };
    try {
      new SessionFrameWriter(pausing, () -> nowMs[0], 1_000, Integer.MAX_VALUE).write(frame(10));
      throw new AssertionError("Expected the expired deadline to end the write");
    } catch (SocketTimeoutException expected) {
      if (waitedUntilMs[0] != 1_000) {
        throw new AssertionError(
            "Expected the wait to be given the deadline, got " + waitedUntilMs[0]);
      }
      if (polled[0]) {
        throw new AssertionError("A poll ran with a stale duration after the deadline expired");
      }
    }
  }

  /** A real loopback socket whose reader accepts and never reads, so the kernel buffers fill. */
  private static void stalledReaderUnderRealBackpressureClosesAtTheDeadline() throws Exception {
    try (ServerSocketChannel server = loopbackServer();
        SocketChannel client = SocketChannel.open(server.getLocalAddress());
        SocketChannel stalled = server.accept();
        Selector selector = Selector.open()) {
      client.configureBlocking(false);
      NioChannel channel = new NioChannel(client, selector);
      long startedAtNs = System.nanoTime();
      try {
        new SessionFrameWriter(channel, SessionFrameWriterTest::nowMs, 300, Integer.MAX_VALUE)
            .write(frame(LARGE_FRAME_BYTES));
        throw new AssertionError("Expected the stalled reader to hit the deadline");
      } catch (SocketTimeoutException expected) {
        long elapsedMs = (System.nanoTime() - startedAtNs) / 1_000_000;
        if (channel.sent == 0 || channel.sent >= LARGE_FRAME_BYTES) {
          throw new AssertionError("Expected partial progress before the stall: " + channel.sent);
        }
        if (elapsedMs < 300 || elapsedMs > 2_000) {
          throw new AssertionError("Expected a close at the 300 ms deadline, took " + elapsedMs);
        }
      }
      // The accept loop serves the next connection at once.
      try (SocketChannel next = SocketChannel.open(server.getLocalAddress());
          SocketChannel accepted = server.accept()) {
        if (accepted == null || !next.isConnected()) {
          throw new AssertionError("Expected the next connection to be accepted");
        }
      }
    }
  }

  private static void readingPeerReceivesTheWholeFrame() throws Exception {
    try (ServerSocketChannel server = loopbackServer();
        SocketChannel client = SocketChannel.open(server.getLocalAddress());
        SocketChannel reader = server.accept();
        Selector selector = Selector.open()) {
      client.configureBlocking(false);
      long[] received = {0};
      Thread drain = new Thread(() -> {
        try (InputStream input = reader.socket().getInputStream()) {
          byte[] buffer = new byte[64 * 1024];
          int count;
          while ((count = input.read(buffer)) > 0) received[0] += count;
        } catch (IOException ignored) {
          // The test checks the count.
        }
      });
      drain.start();
      new SessionFrameWriter(new NioChannel(client, selector), SessionFrameWriterTest::nowMs, 5_000, 64 * 1024)
          .write(frame(LARGE_FRAME_BYTES));
      client.close();
      drain.join(10_000);
      if (received[0] != LARGE_FRAME_BYTES + 1) {
        throw new AssertionError("Expected the whole frame, got " + received[0]);
      }
    }
  }

  private static ServerSocketChannel loopbackServer() throws IOException {
    ServerSocketChannel server = ServerSocketChannel.open();
    server.bind(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0));
    return server;
  }

  private static long nowMs() {
    return System.nanoTime() / 1_000_000;
  }

  private static SessionResponseWriter.Frame frame(int bodyBytes) {
    return new SessionResponseWriter.Frame(new byte[] {'\n'}, new byte[bodyBytes]);
  }

  /** The JVM counterpart of LocalSocketSessionChannel: nonblocking sends and a select for room. */
  private static final class NioChannel implements SessionFrameWriter.Channel {
    private final SocketChannel socket;
    private final Selector selector;
    long sent;

    NioChannel(SocketChannel socket, Selector selector) throws IOException {
      this.socket = socket;
      this.selector = selector;
      socket.register(selector, SelectionKey.OP_WRITE);
    }

    @Override
    public int send(byte[] data, int offset, int length) throws IOException {
      int count = socket.write(ByteBuffer.wrap(data, offset, length));
      sent += count;
      return count;
    }

    @Override
    public void awaitWritable(long deadlineAtMs) throws IOException {
      long remainingMs =
          SessionPeerPolicy.remainingBeforeDeadline(SessionFrameWriterTest::nowMs, deadlineAtMs);
      selector.select(Math.max(1, remainingMs));
      selector.selectedKeys().clear();
    }
  }
}
