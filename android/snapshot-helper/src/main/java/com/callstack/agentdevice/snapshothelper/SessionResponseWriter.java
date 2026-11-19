package com.callstack.agentdevice.snapshothelper;

import android.os.Bundle;
import java.io.IOException;
import java.nio.charset.StandardCharsets;

/** Encodes persistent-session socket responses as newline-delimited headers plus a body. */
final class SessionResponseWriter {
  private SessionResponseWriter() {}

  /** One response: the encoded header block and the body, written under one deadline. */
  static final class Frame {
    final byte[] head;
    final byte[] body;

    Frame(byte[] head, byte[] body) {
      this.head = head;
      this.body = body;
    }
  }

  /** Runs a command and encodes its response. Any failure here becomes the error frame. */
  interface FrameSource {
    Frame encode() throws Throwable;
  }

  /** Encodes the error frame for a failed command, from a fresh header set. */
  interface FailureFrame {
    Frame encode(Throwable error);
  }

  /** Writes one frame to the peer. */
  interface FrameSink {
    void write(Frame frame) throws IOException;
  }

  static Bundle sessionResponseBundle(String requestId) {
    Bundle result = new Bundle();
    result.putString("agentDeviceProtocol", HelperProtocol.PROTOCOL);
    result.putString("helperApiVersion", HelperProtocol.HELPER_API_VERSION);
    result.putString("outputFormat", HelperProtocol.OUTPUT_FORMAT);
    result.putString("requestId", requestId);
    return result;
  }

  /**
   * Writes exactly one frame. Command execution and frame encoding can turn into the error frame.
   * The write is outside that boundary: a failed write reaches the socket owner, which closes the
   * connection without another frame. An error frame that cannot be encoded closes the connection
   * the same way.
   */
  static void respondOnce(FrameSink sink, FrameSource source, FailureFrame failure)
      throws IOException {
    Frame frame;
    try {
      frame = source.encode();
    } catch (Throwable error) {
      try {
        frame = failure.encode(error);
      } catch (Throwable encodingError) {
        throw new IOException("session error frame could not be encoded", encodingError);
      }
    }
    sink.write(frame);
  }

  /** Encodes a result Bundle's headers. The body bytes are written as they are, without a copy. */
  static Frame encodeSessionResponse(Bundle result, byte[] body) {
    StringBuilder head = new StringBuilder();
    for (String key : result.keySet()) {
      Object value = result.get(key);
      if (value != null) appendHeader(head, key, value.toString());
    }
    head.append('\n');
    return new Frame(head.toString().getBytes(StandardCharsets.UTF_8), body);
  }

  static Frame okFrame(String requestId) {
    StringBuilder head = protocolHeaders(requestId);
    appendHeader(head, "ok", "true");
    head.append('\n');
    return new Frame(head.toString().getBytes(StandardCharsets.UTF_8), new byte[0]);
  }

  /**
   * A minimal error frame built from fresh headers, so it never carries a success payload such as
   * screenshot bytes. `errorType` is the class the helper threw, which the host classifies on. A
   * null message repeats it; an empty message stays empty. Extra headers come in key, value pairs.
   */
  static Frame errorFrame(String requestId, Throwable error, String... extraHeaders) {
    StringBuilder head = protocolHeaders(requestId);
    String errorType = error.getClass().getName();
    String message = error.getMessage();
    appendHeader(head, "ok", "false");
    appendHeader(head, "errorType", errorType);
    appendHeader(head, "message", message == null ? errorType : message);
    for (int i = 0; i + 1 < extraHeaders.length; i += 2) {
      appendHeader(head, extraHeaders[i], extraHeaders[i + 1]);
    }
    head.append('\n');
    return new Frame(head.toString().getBytes(StandardCharsets.UTF_8), new byte[0]);
  }

  private static StringBuilder protocolHeaders(String requestId) {
    StringBuilder head = new StringBuilder();
    appendHeader(head, "agentDeviceProtocol", HelperProtocol.PROTOCOL);
    appendHeader(head, "helperApiVersion", HelperProtocol.HELPER_API_VERSION);
    appendHeader(head, "outputFormat", HelperProtocol.OUTPUT_FORMAT);
    appendHeader(head, "requestId", requestId);
    return head;
  }

  private static void appendHeader(StringBuilder head, String key, String value) {
    head.append(key).append('=').append(value.replace('\r', ' ').replace('\n', ' ')).append('\n');
  }
}
