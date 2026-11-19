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
      public void awaitWritable(long timeoutMs) {
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

  /** The JVM counterpart of LocalSocketFrameChannel: nonblocking sends and a select for room. */
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
    public void awaitWritable(long timeoutMs) throws IOException {
      selector.select(Math.max(1, timeoutMs));
      selector.selectedKeys().clear();
    }
  }
}
