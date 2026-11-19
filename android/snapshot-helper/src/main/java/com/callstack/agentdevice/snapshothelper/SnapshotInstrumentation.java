package com.callstack.agentdevice.snapshothelper;

import android.app.Instrumentation;
import android.app.UiAutomation;
import android.content.res.Resources;
import android.net.Credentials;
import android.net.LocalServerSocket;
import android.net.LocalSocket;
import android.os.Build;
import android.os.Bundle;
import android.os.SystemClock;
import android.text.TextUtils;
import android.util.Base64;
import android.util.DisplayMetrics;
import java.io.ByteArrayOutputStream;
import java.io.EOFException;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.lang.reflect.Field;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.concurrent.TimeoutException;

public final class SnapshotInstrumentation extends Instrumentation {
  private static final long GESTURE_UI_AUTOMATION_CONNECT_TIMEOUT_MS = 8_000;
  private static final int CHUNK_SIZE = 2 * 1024;
  private static final long DEFAULT_TIMEOUT_MS = 8_000;
  private static final long SHORT_IDLE_TIMEOUT_MS = 100;
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
        readLongArgument(
            arguments, "waitForIdleTimeoutMs", AccessibilityTreeCapture.DEFAULT_WAIT_FOR_IDLE_TIMEOUT_MS);
    long waitForIdleQuietMs =
        readLongArgument(
            arguments, "waitForIdleQuietMs", AccessibilityTreeCapture.DEFAULT_WAIT_FOR_IDLE_QUIET_MS);
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
      DisplayExtent.Extent beforeDump = DisplayExtent.read(getContext());
      AccessibilityTreeCapture.Result capture =
          captureXml(waitForIdleQuietMs, waitForIdleTimeoutMs, timeoutMs, maxDepth, maxNodes);
      DisplayExtent.Extent display =
          DisplayExtent.whenBothAgree(beforeDump, DisplayExtent.read(getContext()));
      writeOutputFile(outputPath, capture.xml);
      if (emitChunks) {
        emitChunks(capture.xml);
      }
      result.putString("ok", "true");
      putCaptureMetadata(result, capture, display, System.currentTimeMillis() - startedAtMs);
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
      Bundle result,
      AccessibilityTreeCapture.Result capture,
      DisplayExtent.Extent display,
      long elapsedMs) {
    result.putString("rootPresent", Boolean.toString(capture.rootPresent));
    result.putString("cacheInvalidated", Boolean.toString(capture.cacheInvalidated));
    result.putString("captureMode", capture.captureMode);
    result.putString("windowCount", Integer.toString(capture.windowCount));
    result.putString(
        "missingRootWindowTypes", TextUtils.join(",", capture.missingRootWindowTypes));
    result.putString("nodeCount", Integer.toString(capture.nodeCount));
    result.putString("truncated", Boolean.toString(capture.truncated));
    result.putString("elapsedMs", Long.toString(elapsedMs));
    // Physical pixels per dp of the display the bounds above were measured on, from the same
    // configuration the framework lays out with (a `wm density` override included), so a host that
    // works in dp has the factor beside the pixels instead of a second adb round trip.
    DisplayMetrics metrics = Resources.getSystem().getDisplayMetrics();
    result.putString("pixelDensity", Float.toString(metrics.density));
    // The real extent of the display those bounds are measured in, read around the tree dump and
    // published only when both reads agreed, so the host can publish the box the bounds live in
    // without reading the tree for it. Published by absence: a display this helper could not
    // address, or one that rotated mid-dump, adds no keys, which the host reads as unknown rather
    // than as a screen of no size or of another rotation's size (#3182).
    if (display != null) {
      result.putString("displayWidth", Integer.toString(display.width));
      result.putString("displayHeight", Integer.toString(display.height));
    }
  }

  private void runOneShotViewport(Bundle result) throws InterruptedException {
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
    // The session socket lives in the abstract namespace, reached from the host through
    // `adb forward tcp:<port> localabstract:<name>`; the forwarded peer is adbd, and its uid is
    // checked before any command byte is read. The name is derived from the port and carries no
    // secret — admission is the peer uid, not name secrecy.
    try (LocalServerSocket server =
        new LocalServerSocket(SessionPeerPolicy.sessionSocketName(sessionPort))) {
      Bundle ready = new Bundle();
      putBaseMetadata(
          ready, waitForIdleTimeoutMs, waitForIdleQuietMs, timeoutMs, maxDepth, maxNodes);
      ready.putString("sessionReady", "true");
      ready.putString("sessionTransport", "localabstract-peer-uid-v1");
      ready.putString("sessionCommands", "input,screenshot,focus,snapshot-immediate,snapshot-short-idle"
          + (android.os.Build.VERSION.SDK_INT >= 31 ? ",app" : ""));
      ready.putString("sessionPort", Integer.toString(sessionPort));
      sendStatus(2, ready);

      // Each connection's command read is bounded by the session's own timeout, fixed at accept
      // time: a host sends its command immediately after connecting, so a peer silent past that
      // budget is answered with an error instead of occupying the command reader.
      long readBudgetMs =
          SessionPeerPolicy.commandReadDeadlineMs(timeoutMs, DEFAULT_TIMEOUT_MS);
      while (!Thread.currentThread().isInterrupted()) {
        try (LocalSocket socket = server.accept()) {
          // Positive peer identity first: a peer that is not adbd (shell uid 2000, or root uid 0
          // under `adb root`) — or whose credentials cannot be read at all — is rejected before
          // any command byte is read and before any response is written.
          if (!admitSessionPeer(socket)) {
            continue;
          }
          long deadlineAtMs =
              SessionPeerPolicy.commandReadDeadlineAtMs(SystemClock.elapsedRealtime(), readBudgetMs);
          String requestId = "";
          try {
            String command =
                readSessionCommandLine(socket, deadlineAtMs, SessionPeerPolicy.MAX_COMMAND_LINE_BYTES);
            SessionPeerPolicy.LineDecision lineDecision =
                SessionPeerPolicy.commandLineDecision(command, SessionPeerPolicy.MAX_COMMAND_LINE_BYTES);
            if (lineDecision == SessionPeerPolicy.LineDecision.REJECTED_EMPTY) {
              SessionResponseWriter.writeSessionError(
                  socket.getOutputStream(), "", new EOFException("empty command"));
              continue;
            }
            if (lineDecision == SessionPeerPolicy.LineDecision.REJECTED_OVER_LIMIT) {
              SessionResponseWriter.writeSessionError(
                  socket.getOutputStream(), "",
                  new IllegalArgumentException("session command over the byte limit"));
              continue;
            }
            String[] parts = command.trim().split("\\s+", 3);
            String action = parts.length > 0 ? parts[0] : "";
            requestId = parts.length > 1 ? parts[1] : "";
            if ("quit".equals(action)) {
              writeSessionOkQuietly(socket, requestId);
              return;
            }
            // The automation context is acquired per connection, after admission: a connect
            // failure is this connection's failure, answered like the capture failure below
            // instead of ending the session for the next peer.
            UiAutomation automation;
            try {
              automation = getConnectedUiAutomationUnchecked();
            } catch (RuntimeException error) {
              SessionResponseWriter.writeSessionError(socket.getOutputStream(), requestId, error);
              continue;
            }
            if ("input".equals(action) || "screenshot".equals(action) || "focus".equals(action) || "app".equals(action)) {
              AutomationCommandHandler.writeSessionResponse(
                  socket.getOutputStream(), requestId, action,
                  parts.length > 2 ? parts[2] : "", automation, getContext());
              continue;
            }
            if ("viewport".equals(action)) {
              TouchCommandHandler.writeSessionViewport(
                  socket.getOutputStream(), requestId, automation);
              continue;
            }
            if ("gesture".equals(action)) {
              TouchCommandHandler.writeSessionGesture(
                  socket.getOutputStream(),
                  requestId,
                  parts.length > 2 ? parts[2] : "",
                  automation);
              continue;
            }
            if (!"snapshot".equals(action) && !"snapshot-immediate".equals(action)
                && !"snapshot-short-idle".equals(action)) {
              SessionResponseWriter.writeSessionError(
                  socket.getOutputStream(),
                  requestId,
                  new IllegalArgumentException("unknown session command"));
              continue;
            }
            writeSessionSnapshot(
                socket.getOutputStream(),
                requestId,
                waitForIdleQuietMs,
                "snapshot-immediate".equals(action) ? 0
                    : "snapshot-short-idle".equals(action) ? Math.min(waitForIdleTimeoutMs, SHORT_IDLE_TIMEOUT_MS)
                    : waitForIdleTimeoutMs,
                timeoutMs,
                maxDepth,
                maxNodes);
          } catch (IOException error) {
            // One connection's expected I/O failure — a silent peer past the absolute read
            // deadline, a command line over the byte cap, a response the peer never read — is
            // answered with an error and contained here, so the session keeps serving the next
            // connection. Command handlers contain their own throwables and answer with session
            // errors themselves.
            try {
              SessionResponseWriter.writeSessionError(socket.getOutputStream(), requestId, error);
            } catch (IOException ignored) {
              // The peer is already gone; nothing is left to tell it.
            }
          }
        }
      }
    }
  }

  /**
   * Reads the peer's kernel credentials and admits only adbd. A credential read that fails for any
   * reason is a peer that cannot be positively identified, so it is rejected: the session never
   * serves a peer it could not verify.
   */
  private static boolean admitSessionPeer(LocalSocket socket) {
    Credentials credentials;
    try {
      credentials = socket.getPeerCredentials();
    } catch (Throwable error) {
      return false;
    }
    return SessionPeerPolicy.admitPeer(credentials.getUid()) == SessionPeerPolicy.Admission.ADMITTED;
  }

  /**
   * Reads one newline-terminated command line under an absolute deadline fixed at accept time and
   * a hard byte cap. Each read gets only the budget still left before the deadline, so a peer that
   * drip-feeds bytes cannot extend the connection past it the way a rolling SO_TIMEOUT would. The
   * buffer holds at most {@code maxBytes + 1} bytes: past the cap the read stops and the line is
   * returned for the policy to reject, so the over-limit response has one owner. Returns null on
   * end-of-stream before any byte.
   */
  private static String readSessionCommandLine(LocalSocket socket, long deadlineAtMs, int maxBytes)
      throws IOException {
    InputStream input = socket.getInputStream();
    ByteArrayOutputStream bytes = new ByteArrayOutputStream();
    byte[] chunk = new byte[8 * 1024];
    while (bytes.size() <= maxBytes) {
      long remainingMs =
          SessionPeerPolicy.remainingBudgetMs(deadlineAtMs, SystemClock.elapsedRealtime());
      if (remainingMs <= 0) {
        throw new SocketTimeoutException("session command read deadline exceeded");
      }
      socket.setSoTimeout((int) remainingMs);
      int count = input.read(chunk, 0, Math.min(chunk.length, maxBytes + 1 - bytes.size()));
      if (SystemClock.elapsedRealtime() >= deadlineAtMs) {
        throw new SocketTimeoutException("session command read deadline exceeded");
      }
      if (count < 0) {
        if (bytes.size() == 0) return null;
        break;
      }
      int end = 0;
      while (end < count && chunk[end] != '\n') end++;
      bytes.write(chunk, 0, end);
      if (end < count) break;
    }
    return new String(bytes.toByteArray(), StandardCharsets.UTF_8);
  }

  private static void writeSessionOkQuietly(LocalSocket socket, String requestId) {
    try {
      SessionResponseWriter.writeSessionOk(socket.getOutputStream(), requestId);
    } catch (IOException ignored) {
      // A quit the peer never read still ends the session; the host reads release from the
      // process exit, not from this acknowledgement.
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
      DisplayExtent.Extent beforeDump = DisplayExtent.read(getContext());
      AccessibilityTreeCapture.Result capture =
          captureXml(waitForIdleQuietMs, waitForIdleTimeoutMs, timeoutMs, maxDepth, maxNodes);
      DisplayExtent.Extent display =
          DisplayExtent.whenBothAgree(beforeDump, DisplayExtent.read(getContext()));
      result.putString("ok", "true");
      putCaptureMetadata(result, capture, display, System.currentTimeMillis() - startedAtMs);
      result.putString("byteLength", Integer.toString(capture.xml.getBytes(StandardCharsets.UTF_8).length));
      SessionResponseWriter.writeSessionResponse(output, result, capture.xml);
    } catch (Throwable error) {
      SessionResponseWriter.writeSessionError(output, requestId, error);
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
    AccessibilityTreeCapture.prepare(automation, waitForIdleQuietMs, waitForIdleTimeoutMs);
    return AccessibilityTreeCapture.capture(
        automation, maxDepth, maxNodes, ROOT_CAPTURE_STABILIZATION_TIMEOUT_MS);
  }

  private UiAutomation getConnectedUiAutomation(long timeoutMs)
      throws InterruptedException, TimeoutException {
    return BoundedUiAutomationConnection.await(this::tryGetConnectedUiAutomation, timeoutMs);
  }

  private UiAutomation tryGetConnectedUiAutomation() {
    UiAutomation automation;
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
      automation = getUiAutomation(UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES);
    } else {
      automation = getUiAutomation();
    }
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
