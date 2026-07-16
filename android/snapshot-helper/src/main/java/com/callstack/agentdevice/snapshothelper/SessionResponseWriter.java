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

  static void writeSessionError(
      OutputStream output, String requestId, String errorType, String message) throws IOException {
    Bundle result = sessionResponseBundle(requestId);
    result.putString("ok", "false");
    result.putString("errorType", errorType);
    result.putString("message", message);
    writeSessionResponse(output, result, "");
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
    output.write(headers.toString().getBytes(StandardCharsets.UTF_8));
    output.write(body.getBytes(StandardCharsets.UTF_8));
    output.flush();
  }

  private static String sanitizeHeaderValue(String value) {
    return value.replace('\r', ' ').replace('\n', ' ');
  }
}
