package com.callstack.agentdevice.snapshothelper;

import android.app.Instrumentation;
import android.app.UiAutomation;
import android.os.Bundle;
import android.util.Base64;
import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.lang.reflect.Field;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.concurrent.TimeoutException;

public final class SnapshotInstrumentation extends Instrumentation {
  private static final long GESTURE_UI_AUTOMATION_CONNECT_TIMEOUT_MS = 8_000;
  private static final int CHUNK_SIZE = 2 * 1024;
  // Match the host default: bounded wait for microinteraction reliability without the stock
  // uiautomator idle tax. Direct callers can pass 0 when immediate capture is preferred.
  private static final long DEFAULT_WAIT_FOR_IDLE_TIMEOUT_MS = 500;
  private static final long DEFAULT_WAIT_FOR_IDLE_QUIET_MS = 100;
  private static final long DEFAULT_TIMEOUT_MS = 8_000;
  private static final long ROOT_CAPTURE_STABILIZATION_TIMEOUT_MS = 500;
  private static final int DEFAULT_MAX_DEPTH = 128;
  private static final int DEFAULT_MAX_NODES = 5_000;
  private Bundle arguments;

  @Override
  public void onCreate(Bundle arguments) {
    super.onCreate(arguments);
    this.arguments = arguments;
    start();
  }

  @Override
  public void onStart() {
    super.onStart();
    long waitForIdleTimeoutMs =
        readLongArgument(arguments, "waitForIdleTimeoutMs", DEFAULT_WAIT_FOR_IDLE_TIMEOUT_MS);
    long waitForIdleQuietMs =
        readLongArgument(arguments, "waitForIdleQuietMs", DEFAULT_WAIT_FOR_IDLE_QUIET_MS);
    long timeoutMs = readLongArgument(arguments, "timeoutMs", DEFAULT_TIMEOUT_MS);
    int maxDepth = readIntArgument(arguments, "maxDepth", DEFAULT_MAX_DEPTH);
    int maxNodes = readIntArgument(arguments, "maxNodes", DEFAULT_MAX_NODES);
    String outputPath = readStringArgument(arguments, "outputPath");
    boolean emitChunks = readBooleanArgument(arguments, "emitChunks", true);
    int sessionPort = readIntArgument(arguments, "sessionPort", 0);
    String mode = readStringArgument(arguments, "mode");
    Bundle result = new Bundle();
    putBaseMetadata(result, waitForIdleTimeoutMs, waitForIdleQuietMs, timeoutMs, maxDepth, maxNodes);

    try {
      if ("viewport".equals(mode)) {
        runOneShotViewport(result);
        return;
      }
      if ("gesture".equals(mode)) {
        runOneShotGesture(result, readStringArgument(arguments, "payloadBase64"));
        return;
      }
      if (mode != null && !"snapshot".equals(mode)) {
        throw new IllegalArgumentException("Unsupported mode: " + mode);
      }
      if (sessionPort > 0) {
        runSnapshotSession(
            sessionPort, waitForIdleQuietMs, waitForIdleTimeoutMs, timeoutMs, maxDepth, maxNodes);
        result.putString("ok", "true");
        result.putString("sessionEnded", "true");
        finishSafely(0, result);
        return;
      }
      long startedAtMs = System.currentTimeMillis();
      AccessibilityTreeCapture.Result capture =
          captureXml(waitForIdleQuietMs, waitForIdleTimeoutMs, timeoutMs, maxDepth, maxNodes);
      writeOutputFile(outputPath, capture.xml);
      if (emitChunks) {
        emitChunks(capture.xml);
      }
      result.putString("ok", "true");
      putCaptureMetadata(result, capture, System.currentTimeMillis() - startedAtMs);
      finishSafely(0, result);
    } catch (Throwable error) {
      result.putString("ok", "false");
      result.putString("errorType", error.getClass().getName());
      result.putString(
          "message",
          error.getMessage() == null ? error.getClass().getName() : error.getMessage());
      finishSafely(1, result);
    }
  }

  private static void putBaseMetadata(
      Bundle result,
      long waitForIdleTimeoutMs,
      long waitForIdleQuietMs,
      long timeoutMs,
      int maxDepth,
      int maxNodes) {
    result.putString("agentDeviceProtocol", HelperProtocol.PROTOCOL);
    result.putString("helperApiVersion", HelperProtocol.HELPER_API_VERSION);
    result.putString("outputFormat", HelperProtocol.OUTPUT_FORMAT);
    result.putString("waitForIdleTimeoutMs", Long.toString(waitForIdleTimeoutMs));
    result.putString("waitForIdleQuietMs", Long.toString(waitForIdleQuietMs));
    result.putString("timeoutMs", Long.toString(timeoutMs));
    result.putString("maxDepth", Integer.toString(maxDepth));
    result.putString("maxNodes", Integer.toString(maxNodes));
  }

  private static void putCaptureMetadata(
      Bundle result, AccessibilityTreeCapture.Result capture, long elapsedMs) {
    result.putString("rootPresent", Boolean.toString(capture.rootPresent));
    result.putString("captureMode", capture.captureMode);
    result.putString("windowCount", Integer.toString(capture.windowCount));
    result.putString("nodeCount", Integer.toString(capture.nodeCount));
    result.putString("truncated", Boolean.toString(capture.truncated));
    result.putString("elapsedMs", Long.toString(elapsedMs));
  }

  private void runOneShotViewport(Bundle result) {
    TouchCommandHandler.populateViewport(result, getConnectedUiAutomationUnchecked());
    finishSafely(0, result);
  }

  private void runOneShotGesture(Bundle result, String payloadBase64) throws Exception {
    TouchCommandHandler.populateGesture(result, getConnectedUiAutomationUnchecked(), payloadBase64);
    finishSafely(0, result);
  }

  private UiAutomation getConnectedUiAutomationUnchecked() {
    try {
      return getConnectedUiAutomation(GESTURE_UI_AUTOMATION_CONNECT_TIMEOUT_MS);
    } catch (InterruptedException error) {
      Thread.currentThread().interrupt();
      throw new IllegalStateException("Interrupted while connecting Android UiAutomation", error);
    } catch (TimeoutException error) {
      throw new IllegalStateException(error.getMessage(), error);
    }
  }

  private void runSnapshotSession(
      int sessionPort,
      long waitForIdleQuietMs,
      long waitForIdleTimeoutMs,
      long timeoutMs,
      int maxDepth,
      int maxNodes)
      throws IOException {
    try (ServerSocket server =
        new ServerSocket(sessionPort, 1, InetAddress.getByName("127.0.0.1"))) {
      Bundle ready = new Bundle();
      putBaseMetadata(
          ready, waitForIdleTimeoutMs, waitForIdleQuietMs, timeoutMs, maxDepth, maxNodes);
      ready.putString("sessionReady", "true");
      ready.putString("sessionPort", Integer.toString(sessionPort));
      sendStatus(2, ready);

      while (!Thread.currentThread().isInterrupted()) {
        try (Socket socket = server.accept()) {
          String command =
              new BufferedReader(
                      new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8))
                  .readLine();
          if (command == null) {
            SessionResponseWriter.writeSessionError(
                socket.getOutputStream(), "", "java.io.EOFException", "empty command");
            continue;
          }
          String[] parts = command.trim().split("\\s+", 3);
          String action = parts.length > 0 ? parts[0] : "";
          String requestId = parts.length > 1 ? parts[1] : "";
          if ("quit".equals(action)) {
            SessionResponseWriter.writeSessionOk(socket.getOutputStream(), requestId);
            return;
          }
          if ("viewport".equals(action)) {
            TouchCommandHandler.writeSessionViewport(
                socket.getOutputStream(), requestId, getConnectedUiAutomationUnchecked());
            continue;
          }
          if ("gesture".equals(action)) {
            TouchCommandHandler.writeSessionGesture(
                socket.getOutputStream(),
                requestId,
                parts.length > 2 ? parts[2] : "",
                getConnectedUiAutomationUnchecked());
            continue;
          }
          if (!"snapshot".equals(action)) {
            SessionResponseWriter.writeSessionError(
                socket.getOutputStream(),
                requestId,
                "java.lang.IllegalArgumentException",
                "unknown session command");
            continue;
          }
          writeSessionSnapshot(
              socket.getOutputStream(),
              requestId,
              waitForIdleQuietMs,
              waitForIdleTimeoutMs,
              timeoutMs,
              maxDepth,
              maxNodes);
        }
      }
    }
  }

  private void writeSessionSnapshot(
      OutputStream output,
      String requestId,
      long waitForIdleQuietMs,
      long waitForIdleTimeoutMs,
      long timeoutMs,
      int maxDepth,
      int maxNodes)
      throws IOException {
    Bundle result = new Bundle();
    putBaseMetadata(result, waitForIdleTimeoutMs, waitForIdleQuietMs, timeoutMs, maxDepth, maxNodes);
    result.putString("requestId", requestId);
    try {
      long startedAtMs = System.currentTimeMillis();
      AccessibilityTreeCapture.Result capture =
          captureXml(waitForIdleQuietMs, waitForIdleTimeoutMs, timeoutMs, maxDepth, maxNodes);
      result.putString("ok", "true");
      putCaptureMetadata(result, capture, System.currentTimeMillis() - startedAtMs);
      result.putString("byteLength", Integer.toString(capture.xml.getBytes(StandardCharsets.UTF_8).length));
      SessionResponseWriter.writeSessionResponse(output, result, capture.xml);
    } catch (Throwable error) {
      SessionResponseWriter.writeSessionError(
          output,
          requestId,
          error.getClass().getName(),
          error.getMessage() == null ? error.getClass().getName() : error.getMessage());
    }
  }

  private static String readStringArgument(Bundle arguments, String key) {
    if (arguments == null || !arguments.containsKey(key)) {
      return null;
    }
    String value = arguments.getString(key);
    return value == null || value.trim().isEmpty() ? null : value.trim();
  }

  private static void writeOutputFile(String outputPath, String xml) throws IOException {
    if (outputPath == null) {
      return;
    }
    File file = new File(outputPath);
    File parent = file.getParentFile();
    if (parent != null) {
      parent.mkdirs();
    }
    try (FileOutputStream stream = new FileOutputStream(file, false)) {
      stream.write(xml.getBytes(StandardCharsets.UTF_8));
    }
  }

  private void finishSafely(int resultCode, Bundle result) {
    RuntimeException lastError = null;
    for (int attempt = 0; attempt < 100; attempt += 1) {
      try {
        finish(resultCode, result);
        return;
      } catch (IllegalStateException error) {
        if (!isUiAutomationConnectingError(error)) {
          throw error;
        }
        lastError = error;
        sleep(100);
      }
    }
    detachUiAutomationBeforeFinish();
    try {
      finish(resultCode, result);
      return;
    } catch (IllegalStateException error) {
      if (!isUiAutomationConnectingError(error)) {
        throw error;
      }
      lastError = error;
    }
    throw lastError;
  }

  private void detachUiAutomationBeforeFinish() {
    try {
      Field field = Instrumentation.class.getDeclaredField("mUiAutomation");
      field.setAccessible(true);
      field.set(this, null);
    } catch (ReflectiveOperationException | RuntimeException ignored) {
      // If the platform blocks reflection, preserve the original finish failure below.
    }
  }

  private static boolean isUiAutomationConnectingError(IllegalStateException error) {
    String message = error.getMessage();
    return message != null && message.contains("while connecting");
  }

  private static boolean isUiAutomationNotConnectedError(IllegalStateException error) {
    String message = error.getMessage();
    return message != null && message.toLowerCase(Locale.ROOT).contains("not connected");
  }

  private static void sleep(long millis) {
    try {
      Thread.sleep(millis);
    } catch (InterruptedException error) {
      Thread.currentThread().interrupt();
    }
  }

  @SuppressWarnings("deprecation")
  private AccessibilityTreeCapture.Result captureXml(
      long waitForIdleQuietMs,
      long waitForIdleTimeoutMs,
      long timeoutMs,
      int maxDepth,
      int maxNodes)
      throws TimeoutException,
          InterruptedException,
          AccessibilityCaptureStabilizer.IncompleteCaptureException {
    UiAutomation automation = getConnectedUiAutomation(timeoutMs);
    AccessibilityTreeCapture.enableInteractiveWindowRetrieval(automation);
    if (waitForIdleTimeoutMs > 0) {
      try {
        // Best-effort settle: wait for the accessibility stream to become idle, but require only
        // a short quiet window once it does. Using the full timeout as the quiet window made every
        // stable snapshot pay a fixed 500 ms tax.
        long quietMs = Math.min(waitForIdleQuietMs, waitForIdleTimeoutMs);
        automation.waitForIdle(quietMs, waitForIdleTimeoutMs);
      } catch (TimeoutException ignored) {
        // Busy or animated apps can still expose a usable root; capture whatever is available.
      }
    }
    return AccessibilityTreeCapture.capture(
        automation, maxDepth, maxNodes, ROOT_CAPTURE_STABILIZATION_TIMEOUT_MS);
  }

  private UiAutomation getConnectedUiAutomation(long timeoutMs)
      throws InterruptedException, TimeoutException {
    return BoundedUiAutomationConnection.await(this::tryGetConnectedUiAutomation, timeoutMs);
  }

  private UiAutomation tryGetConnectedUiAutomation() {
    UiAutomation automation = getUiAutomation();
    if (automation == null) {
      return null;
    }
    try {
      automation.getServiceInfo();
      return automation;
    } catch (IllegalStateException error) {
      if (isUiAutomationConnectingError(error) || isUiAutomationNotConnectedError(error)) {
        return null;
      }
      throw error;
    }
  }

  private void emitChunks(String payload) {
    byte[] bytes = payload.getBytes(StandardCharsets.UTF_8);
    int chunkCount = Math.max(1, (bytes.length + CHUNK_SIZE - 1) / CHUNK_SIZE);
    for (int index = 0; index < chunkCount; index += 1) {
      int start = index * CHUNK_SIZE;
      int end = Math.min(bytes.length, start + CHUNK_SIZE);
      Bundle status = new Bundle();
      status.putString("agentDeviceProtocol", HelperProtocol.PROTOCOL);
      status.putString("helperApiVersion", HelperProtocol.HELPER_API_VERSION);
      status.putString("outputFormat", HelperProtocol.OUTPUT_FORMAT);
      status.putString("chunkIndex", Integer.toString(index));
      status.putString("chunkCount", Integer.toString(chunkCount));
      status.putString(
          "payloadBase64", Base64.encodeToString(bytes, start, end - start, Base64.NO_WRAP));
      sendStatus(1, status);
    }
  }

  private static long readLongArgument(Bundle arguments, String name, long fallback) {
    if (arguments == null) {
      return fallback;
    }
    String raw = arguments.getString(name);
    if (raw == null || raw.trim().isEmpty()) {
      return fallback;
    }
    try {
      return Math.max(0, Long.parseLong(raw.trim()));
    } catch (NumberFormatException error) {
      return fallback;
    }
  }

  private static int readIntArgument(Bundle arguments, String name, int fallback) {
    if (arguments == null) {
      return fallback;
    }
    String raw = arguments.getString(name);
    if (raw == null || raw.trim().isEmpty()) {
      return fallback;
    }
    try {
      return Math.max(0, Integer.parseInt(raw.trim()));
    } catch (NumberFormatException error) {
      return fallback;
    }
  }

  private static boolean readBooleanArgument(Bundle arguments, String name, boolean fallback) {
    if (arguments == null) {
      return fallback;
    }
    String raw = arguments.getString(name);
    if (raw == null || raw.trim().isEmpty()) {
      return fallback;
    }
    return Boolean.parseBoolean(raw.trim());
  }
}
