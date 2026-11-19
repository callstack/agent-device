package com.callstack.agentdevice.snapshothelper;

import android.os.Bundle;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

/** Encodes persistent-session socket responses as newline-delimited headers plus a body. */
final class SessionResponseWriter {
  private SessionResponseWriter() {}

  static Bundle sessionResponseBundle(String requestId) {
    Bundle result = new Bundle();
    result.putString("agentDeviceProtocol", HelperProtocol.PROTOCOL);
    result.putString("helperApiVersion", HelperProtocol.HELPER_API_VERSION);
    result.putString("outputFormat", HelperProtocol.OUTPUT_FORMAT);
    result.putString("requestId", requestId);
    return result;
  }

  static void writeSessionOk(OutputStream output, String requestId) throws IOException {
    Bundle result = sessionResponseBundle(requestId);
    result.putString("ok", "true");
    writeSessionResponse(output, result, "");
  }

  static void writeSessionError(OutputStream output, String requestId, Throwable error)
      throws IOException {
    Bundle result = sessionResponseBundle(requestId);
    putSessionError(result, error);
    writeSessionResponse(output, result, "");
  }

  /**
   * Marks a session result as a failed attempt. `errorType` is the class the helper threw, which the
   * host classifies on. A null message repeats it; an empty message stays empty.
   */
  static void putSessionError(Bundle result, Throwable error) {
    String errorType = error.getClass().getName();
    String message = error.getMessage();
    result.putString("ok", "false");
    result.putString("errorType", errorType);
    result.putString("message", message == null ? errorType : message);
  }

  static void writeSessionResponse(OutputStream output, Bundle result, String body)
      throws IOException {
    StringBuilder headers = new StringBuilder();
    for (String key : result.keySet()) {
      Object value = result.get(key);
      if (value != null) {
        headers.append(key).append('=').append(sanitizeHeaderValue(value.toString())).append('\n');
      }
    }
    headers.append('\n');
    writeFrame(output, headers.toString(), body);
  }

  /**
   * Writes a frame with bounded socket writes and no flush. LocalSocket flush polls until the peer
   * drains the send queue, and the send timeout does not bound that poll. The socket owner closes
   * the connection after the frame.
   */
  static void writeFrame(OutputStream output, String headers, String body) throws IOException {
    output.write(headers.getBytes(StandardCharsets.UTF_8));
    output.write(body.getBytes(StandardCharsets.UTF_8));
  }

  /** One response frame, encoded and ready to write. */
  @FunctionalInterface
  interface Reply {
    void writeTo(OutputStream output) throws IOException;
  }

  /** Runs a command and encodes its reply. Any failure becomes the error reply. */
  @FunctionalInterface
  interface Execution {
    Reply run() throws Throwable;
  }

  @FunctionalInterface
  interface FailureReply {
    Reply of(Throwable error);
  }

  /**
   * Writes exactly one frame. Only command execution and encoding can turn into the error reply. A
   * failed write reaches the socket owner, which closes the connection without another frame.
   */
  static void respondOnce(OutputStream output, Execution execution, FailureReply failure)
      throws IOException {
    Reply reply;
    try {
      reply = execution.run();
    } catch (Throwable error) {
      reply = failure.of(error);
    }
    reply.writeTo(output);
  }

  private static String sanitizeHeaderValue(String value) {
    return value.replace('\r', ' ').replace('\n', ' ');
  }
}
