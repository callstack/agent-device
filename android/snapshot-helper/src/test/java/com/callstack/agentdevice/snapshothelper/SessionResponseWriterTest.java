package com.callstack.agentdevice.snapshothelper;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

public final class SessionResponseWriterTest {
  private SessionResponseWriterTest() {}

  static void run() throws Exception {
    failedFrameWriteIsNotFollowedByAnErrorFrame();
    commandFailureWritesOneErrorFrame();
    snapshotEncodingFailureWritesAMinimalErrorFrame();
    screenshotEncodingFailureNeverEncodesThePayloadAgain();
    inputThatNeverReachedTheInjectorSaysSo();
    unencodableErrorFrameClosesWithoutAFrame();
  }

  private static void failedFrameWriteIsNotFollowedByAnErrorFrame() throws Exception {
    int[] writes = {0};
    try {
      SessionResponseWriter.respondOnce(
          frame -> {
            writes[0] += 1;
            throw new IOException("send timed out");
          },
          () -> frameOf("ok=true\n\n"),
          error -> frameOf("error\n\n"));
      throw new AssertionError("Expected the transport failure to reach the socket owner");
    } catch (IOException expected) {
      if (writes[0] != 1) {
        throw new AssertionError("A failed frame write was followed by another: " + writes[0]);
      }
    }
  }

  private static void commandFailureWritesOneErrorFrame() throws Exception {
    List<String> frames = collect(
        () -> {
          throw new IllegalStateException("command failed");
        },
        error -> SessionResponseWriter.errorFrame("req-1", error));
    expectOneFrame(frames, "ok=false", "errorType=java.lang.IllegalStateException", "requestId=req-1");
  }

  /** The snapshot source builds its frame inside the boundary; an OOM there fails one request. */
  private static void snapshotEncodingFailureWritesAMinimalErrorFrame() throws Exception {
    String xml = "<hierarchy secret=\"node-text\"/>";
    List<String> frames = collect(
        () -> {
          byte[] body = xml.getBytes(StandardCharsets.UTF_8);
          if (body.length > 0) throw new OutOfMemoryError("frame encoding");
          return frameOf("");
        },
        error -> SessionResponseWriter.errorFrame("snapshot-1", error));
    expectOneFrame(frames, "ok=false", "errorType=java.lang.OutOfMemoryError", "requestId=snapshot-1");
    if (frames.get(0).contains("node-text")) {
      throw new AssertionError("The error frame carried snapshot content: " + frames.get(0));
    }
  }

  private static void screenshotEncodingFailureNeverEncodesThePayloadAgain() throws Exception {
    String payload = "iVBORw0KGgo-screenshot-bytes";
    List<String> frames = collect(
        () -> {
          String header = "payloadBase64=" + payload;
          if (!header.isEmpty()) throw new OutOfMemoryError("screenshot frame");
          return frameOf(header);
        },
        error -> AutomationCommandHandler.errorFrame("shot-1", "screenshot", false, error));
    expectOneFrame(frames, "ok=false", "errorType=java.lang.OutOfMemoryError", "requestId=shot-1");
    if (frames.get(0).contains(payload) || frames.get(0).contains("injected=")) {
      throw new AssertionError("Expected a fresh minimal error frame: " + frames.get(0));
    }
  }

  private static void inputThatNeverReachedTheInjectorSaysSo() throws Exception {
    List<String> notAttempted = collect(
        () -> {
          throw new IllegalArgumentException("bad payload");
        },
        error -> AutomationCommandHandler.errorFrame("in-1", "input", false, error));
    expectOneFrame(notAttempted, "injected=false");
    List<String> attempted = collect(
        () -> {
          throw new IllegalStateException("injection failed");
        },
        error -> AutomationCommandHandler.errorFrame("in-2", "input", true, error));
    if (attempted.get(0).contains("injected=")) {
      throw new AssertionError("An attempted input must not claim it was not injected");
    }
  }

  private static void unencodableErrorFrameClosesWithoutAFrame() throws Exception {
    List<String> frames = new ArrayList<>();
    try {
      SessionResponseWriter.respondOnce(
          frame -> frames.add(text(frame)),
          () -> {
            throw new OutOfMemoryError("frame");
          },
          error -> {
            throw new OutOfMemoryError("error frame");
          });
      throw new AssertionError("Expected the connection to close");
    } catch (IOException expected) {
      if (!frames.isEmpty()) throw new AssertionError("Expected no frame: " + frames);
    }
  }

  private static List<String> collect(
      SessionResponseWriter.FrameSource source, SessionResponseWriter.FailureFrame failure)
      throws IOException {
    List<String> frames = new ArrayList<>();
    SessionResponseWriter.respondOnce(frame -> frames.add(text(frame)), source, failure);
    return frames;
  }

  private static void expectOneFrame(List<String> frames, String... headers) {
    if (frames.size() != 1) throw new AssertionError("Expected one frame, got " + frames);
    for (String header : headers) {
      if (!frames.get(0).contains(header + "\n")) {
        throw new AssertionError("Expected " + header + " in " + frames.get(0));
      }
    }
  }

  private static SessionResponseWriter.Frame frameOf(String head) {
    return new SessionResponseWriter.Frame(head.getBytes(StandardCharsets.UTF_8), new byte[0]);
  }

  private static String text(SessionResponseWriter.Frame frame) {
    return new String(frame.head, StandardCharsets.UTF_8) + new String(frame.body, StandardCharsets.UTF_8);
  }
}
