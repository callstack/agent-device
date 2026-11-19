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
    encodingFailureWritesTheErrorFrame();
  }

  /** LocalSocket flush polls until the peer drains its queue, which no send timeout bounds. */
  private static void frameWriteNeverWaitsForThePeerToDrain() throws Exception {
    ByteArrayOutputStream bytes = new ByteArrayOutputStream() {
      @Override
      public void flush() {
        throw new AssertionError("A response frame must not wait for the peer to drain it");
      }
    };
    respond(bytes, () -> "ok=true\n\nbody");
    if (!"ok=true\n\nbody".equals(bytes.toString(StandardCharsets.UTF_8.name()))) {
      throw new AssertionError("Expected the whole frame");
    }
  }

  private static void failedReplyWriteIsNotFollowedByAnErrorFrame() throws Exception {
    int[] writes = {0};
    OutputStream backpressured = new OutputStream() {
      @Override
      public void write(int value) throws IOException {
        writes[0] += 1;
        throw new IOException("send timed out");
      }

      @Override
      public void write(byte[] data, int offset, int length) throws IOException {
        write(0);
      }
    };
    try {
      respond(backpressured, () -> "a");
      throw new AssertionError("Expected the transport failure to reach the socket owner");
    } catch (IOException expected) {
      if (writes[0] != 1) {
        throw new AssertionError(
            "A failed reply write was followed by another frame: writes=" + writes[0]);
      }
    }
  }

  private static void commandFailureWritesOneErrorFrame() throws Exception {
    ByteArrayOutputStream bytes = new ByteArrayOutputStream();
    respond(bytes, () -> {
      throw new IllegalStateException("command failed");
    });
    if (!"error:command failed".equals(bytes.toString(StandardCharsets.UTF_8.name()))) {
      throw new AssertionError("Expected exactly the error frame for a failed command");
    }
  }

  /** A result that cannot be encoded, such as an oversized screenshot, still gets an error frame. */
  private static void encodingFailureWritesTheErrorFrame() throws Exception {
    ByteArrayOutputStream bytes = new ByteArrayOutputStream();
    SessionResponseWriter.<String>respondOnce(
        bytes,
        () -> "unencodable",
        error -> "error:" + error.getMessage(),
        result -> {
          if (result.equals("unencodable")) throw new OutOfMemoryError("frame too large");
          return result.getBytes(StandardCharsets.UTF_8);
        });
    if (!"error:frame too large".equals(bytes.toString(StandardCharsets.UTF_8.name()))) {
      throw new AssertionError("Expected the encoding failure to become the error frame");
    }
  }

  private static void respond(OutputStream output, SessionResponseWriter.Execution<String> command)
      throws IOException {
    SessionResponseWriter.<String>respondOnce(
        output,
        command,
        error -> "error:" + error.getMessage(),
        result -> result.getBytes(StandardCharsets.UTF_8));
  }
}
