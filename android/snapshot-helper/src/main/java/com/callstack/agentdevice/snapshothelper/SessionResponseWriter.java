package com.callstack.agentdevice.snapshothelper;

import android.os.Bundle;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.function.Function;

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
    writeSessionResponse(output, sessionErrorBundle(requestId, error), "");
  }

  static Bundle sessionErrorBundle(String requestId, Throwable error) {
    Bundle result = sessionResponseBundle(requestId);
    putSessionError(result, error);
    return result;
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

  /**
   * Writes a frame with one bounded socket write and no flush. LocalSocket flush polls until the
   * peer drains the send queue, and the send timeout does not bound that poll. The socket owner
   * closes the connection after the frame.
   */
  static void writeSessionResponse(OutputStream output, Bundle result, String body)
      throws IOException {
    output.write(encodeSessionResponse(result, body));
  }

  static byte[] encodeSessionResponse(Bundle result, String body) {
    StringBuilder frame = new StringBuilder();
    for (String key : result.keySet()) {
      Object value = result.get(key);
      if (value != null) {
        frame.append(key).append('=').append(sanitizeHeaderValue(value.toString())).append('\n');
      }
    }
    frame.append('\n').append(body);
    return frame.toString().getBytes(StandardCharsets.UTF_8);
  }

  /** Runs a command and returns its result. Any failure becomes the error result. */
  @FunctionalInterface
  interface Execution<Result> {
    Result run() throws Throwable;
  }

  /** Writes exactly one header-only frame for a command that returns a Bundle result. */
  static void respondOnce(
      OutputStream output, Execution<Bundle> execution, Function<Throwable, Bundle> failure)
      throws IOException {
    respondOnce(output, execution, failure, result -> encodeSessionResponse(result, ""));
  }

  /**
   * Writes exactly one frame. Command execution and encoding can turn into the error frame. The
   * write is outside that catch: a failed write reaches the socket owner, which closes the
   * connection without another frame.
   */
  static <Result> void respondOnce(
      OutputStream output,
      Execution<Result> execution,
      Function<Throwable, Result> failure,
      Function<Result, byte[]> encode)
      throws IOException {
    byte[] frame;
    try {
      frame = encode.apply(execution.run());
    } catch (Throwable error) {
      frame = encode.apply(failure.apply(error));
    }
    output.write(frame);
  }

  private static String sanitizeHeaderValue(String value) {
    return value.replace('\r', ' ').replace('\n', ' ');
  }
}
