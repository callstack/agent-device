package com.callstack.agentdevice.snapshothelper;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

public final class SessionResponseWriterTest {
  private SessionResponseWriterTest() {}

  static void run() throws Exception {
    frameWriteNeverWaitsForThePeerToDrain();
    failedReplyWriteIsNotFollowedByAnErrorFrame();
    commandFailureWritesOneErrorFrame();
  }

  /** LocalSocket flush polls until the peer drains its queue, which no send timeout bounds. */
  private static void frameWriteNeverWaitsForThePeerToDrain() throws Exception {
    ByteArrayOutputStream bytes = new ByteArrayOutputStream() {
      @Override
      public void flush() {
        throw new AssertionError("A response frame must not wait for the peer to drain it");
      }
    };
    SessionResponseWriter.writeFrame(bytes, "ok=true\n\n", "body");
    if (!"ok=true\n\nbody".equals(bytes.toString(StandardCharsets.UTF_8.name()))) {
      throw new AssertionError("Expected the headers and body in one frame");
    }
  }

  private static void failedReplyWriteIsNotFollowedByAnErrorFrame() throws Exception {
    int[] writes = {0};
    boolean[] failureEncoded = {false};
    OutputStream backpressured = new OutputStream() {
      @Override
      public void write(int value) throws IOException {
        writes[0] += 1;
        throw new IOException("send timed out");
      }
    };
    try {
      SessionResponseWriter.respondOnce(
          backpressured,
          () -> output -> output.write('a'),
          error -> {
            failureEncoded[0] = true;
            return output -> output.write('e');
          });
      throw new AssertionError("Expected the transport failure to reach the socket owner");
    } catch (IOException expected) {
      if (writes[0] != 1 || failureEncoded[0]) {
        throw new AssertionError(
            "A failed reply write was followed by another frame: writes=" + writes[0]);
      }
    }
  }

  private static void commandFailureWritesOneErrorFrame() throws Exception {
    ByteArrayOutputStream bytes = new ByteArrayOutputStream();
    SessionResponseWriter.respondOnce(
        bytes,
        () -> {
          throw new IllegalStateException("command failed");
        },
        error -> output -> output.write(error.getMessage().getBytes(StandardCharsets.UTF_8)));
    if (!"command failed".equals(bytes.toString(StandardCharsets.UTF_8.name()))) {
      throw new AssertionError("Expected exactly the error frame for a failed command");
    }
  }
}
