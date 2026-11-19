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
import java.io.EOFException;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.lang.reflect.Field;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.concurrent.TimeoutException;

public final class SnapshotInstrumentation extends Instrumentation {
  private static final long GESTURE_UI_AUTOMATION_CONNECT_TIMEOUT_MS = 8_000;
  private static final int CHUNK_SIZE = 2 * 1024;
  private static final long DEFAULT_TIMEOUT_MS = 8_000;
  private static final int SESSION_COMMAND_READ_BASE_TIMEOUT_MS = 2_000;
  private static final int SESSION_RESPONSE_WRITE_BASE_TIMEOUT_MS = 8_000;
  // A response deadline grows with the frame at this floor rate, like the command read deadline.
  private static final int SESSION_RESPONSE_MIN_BYTES_PER_SECOND =
      SessionPeerPolicy.MIN_COMMAND_BYTES_PER_SECOND;
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
      // Versioned activation (#4519): the host names this transport in argv, so a helper that does
      // not implement it rejects the launch instead of serving an unauthenticated listener. This
      // helper reads no `sessionPort`, so it cannot be talked into the old TCP session either.
      if (SessionPeerPolicy.AUTHENTICATED_SESSION_MODE.equals(mode)) {
        String sessionSocket = readStringArgument(arguments, "sessionSocket");
        if (sessionSocket == null) {
          throw new IllegalArgumentException("authenticated-session-v1 requires sessionSocket");
        }
        runSnapshotSession(
            sessionSocket,
            waitForIdleQuietMs,
            waitForIdleTimeoutMs,
            timeoutMs,
            maxDepth,
            maxNodes);
        result.putString("ok", "true");
        result.putString("sessionEnded", "true");
        finishSafely(0, result);
        return;
      }
      if (mode != null && !"snapshot".equals(mode)) {
        throw new IllegalArgumentException("Unsupported mode: " + mode);
      }
      String xml =
          captureInto(
              result, waitForIdleQuietMs, waitForIdleTimeoutMs, timeoutMs, maxDepth, maxNodes);
      writeOutputFile(outputPath, xml);
      if (emitChunks) {
        emitChunks(xml);
      }
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
      String launchedSocketName,
      long waitForIdleQuietMs,
      long waitForIdleTimeoutMs,
      long timeoutMs,
      int maxDepth,
      int maxNodes)
      throws IOException {
    // Android's LocalServerSocket(String) binds in the abstract namespace. The host reaches it
    // through `adb forward tcp:<port> localabstract:<name>`; the forwarded peer is adbd, and its uid
    // is checked before any command byte is read. The name comes from the host's `sessionSocket`
    // argument and carries no secret — admission is the peer uid, not name secrecy.
    try (LocalServerSocket server =
        new LocalServerSocket(SessionPeerPolicy.sessionSocketName(launchedSocketName))) {
      Bundle ready = new Bundle();
      putBaseMetadata(
          ready, waitForIdleTimeoutMs, waitForIdleQuietMs, timeoutMs, maxDepth, maxNodes);
      ready.putString("sessionReady", "true");
      ready.putString("sessionSocket", launchedSocketName);
      ready.putString("sessionCommands", "input,screenshot,focus,snapshot-immediate,snapshot-short-idle"
          + (android.os.Build.VERSION.SDK_INT >= 31 ? ",app" : ""));
      sendStatus(2, ready);

      while (!Thread.currentThread().isInterrupted()) {
        try (LocalSocket socket = server.accept()) {
          long baseDeadlineAtMs = SystemClock.elapsedRealtime() + SESSION_COMMAND_READ_BASE_TIMEOUT_MS;
          // Positive peer identity first: a peer that is not adbd (shell uid 2000, or root uid 0
          // under `adb root`) — or whose credentials cannot be read at all — is rejected before
          // any command byte is read and before any response is written.
          if (!admitSessionPeer(socket)) {
            continue;
          }
          try {
            // An expired, incomplete or failed read closes the connection without a reply: a peer
            // that never reads could otherwise hold the only accept loop with the reply.
            LocalSocketSessionChannel channel =
                new LocalSocketSessionChannel(socket, SystemClock::elapsedRealtime);
            SessionPeerPolicy.CommandFrame command =
                SessionPeerPolicy.readSessionCommand(
                    channel,
                    SystemClock::elapsedRealtime,
                    baseDeadlineAtMs,
                    SessionPeerPolicy.MAX_COMMAND_LINE_BYTES);
            // Each response goes out in nonblocking sends under one deadline from its first byte.
            SessionResponseWriter.FrameSink sink =
                new SessionFrameWriter(
                    channel,
                    SystemClock::elapsedRealtime,
                    SESSION_RESPONSE_WRITE_BASE_TIMEOUT_MS,
                    SESSION_RESPONSE_MIN_BYTES_PER_SECOND);
            if (command.decision() == SessionPeerPolicy.LineDecision.REJECTED_EMPTY) {
              sink.write(SessionResponseWriter.errorFrame("", new EOFException("empty command")));
              continue;
            }
            if (command.decision() == SessionPeerPolicy.LineDecision.REJECTED_OVER_LIMIT) {
              sink.write(
                  SessionResponseWriter.errorFrame(
                      "", new IllegalArgumentException("session command over the byte limit")));
              continue;
            }
            String[] parts = command.line().trim().split("\\s+", 3);
            String action = parts.length > 0 ? parts[0] : "";
            String requestId = parts.length > 1 ? parts[1] : "";
            if ("quit".equals(action)) {
              writeSessionOkQuietly(sink, requestId);
              return;
            }
            boolean automationCommand =
                "input".equals(action) || "screenshot".equals(action)
                    || "focus".equals(action) || "app".equals(action);
            if (automationCommand || "viewport".equals(action) || "gesture".equals(action)) {
              UiAutomation automation;
              try {
                automation = getConnectedUiAutomationUnchecked();
              } catch (RuntimeException error) {
                sink.write(SessionResponseWriter.errorFrame(requestId, error));
                continue;
              }
              if (automationCommand) {
                AutomationCommandHandler.writeSessionResponse(
                    sink, requestId, action,
                    parts.length > 2 ? parts[2] : "", automation, getContext());
              } else if ("viewport".equals(action)) {
                TouchCommandHandler.writeSessionViewport(sink, requestId, automation);
              } else {
                TouchCommandHandler.writeSessionGesture(
                    sink, requestId, parts.length > 2 ? parts[2] : "", automation);
              }
              continue;
            }
            if (!"snapshot".equals(action) && !"snapshot-immediate".equals(action)
                && !"snapshot-short-idle".equals(action)) {
              sink.write(
                  SessionResponseWriter.errorFrame(
                      requestId, new IllegalArgumentException("unknown session command")));
              continue;
            }
            writeSessionSnapshot(
                sink,
                requestId,
                waitForIdleQuietMs,
                "snapshot-immediate".equals(action) ? 0
                    : "snapshot-short-idle".equals(action) ? Math.min(waitForIdleTimeoutMs, SHORT_IDLE_TIMEOUT_MS)
                    : waitForIdleTimeoutMs,
                timeoutMs,
                maxDepth,
                maxNodes);
          } catch (IOException ignored) {
            // Close the failed connection without appending another frame to a partial response.
          }
        }
      }
    }
  }

  /**
   * Reads the peer's kernel credentials and admits only adbd. A credential read that fails, or that
   * answers with nothing, is a peer that cannot be positively identified, so it is rejected: the
   * session never serves a peer it could not verify.
   */
  private static boolean admitSessionPeer(LocalSocket socket) {
    Credentials credentials;
    try {
      credentials = socket.getPeerCredentials();
    } catch (Throwable error) {
      return false;
    }
    return credentials != null
        && SessionPeerPolicy.admitPeer(credentials.getUid())
            == SessionPeerPolicy.Admission.ADMITTED;
  }

  private static void writeSessionOkQuietly(
      SessionResponseWriter.FrameSink sink, String requestId) {
    try {
      sink.write(SessionResponseWriter.okFrame(requestId));
    } catch (IOException ignored) {
      // A quit the peer never read still ends the session; the host reads release from the
      // process exit, not from this acknowledgement.
    }
  }

  /**
   * Captures and encodes a snapshot inside the command failure boundary, so an out-of-memory while
   * the frame is built fails only this request. The XML is encoded once, as the frame body.
   */
  private void writeSessionSnapshot(
      SessionResponseWriter.FrameSink sink,
      String requestId,
      long waitForIdleQuietMs,
      long waitForIdleTimeoutMs,
      long timeoutMs,
      int maxDepth,
      int maxNodes)
      throws IOException {
    SessionResponseWriter.respondOnce(
        sink,
        () -> {
          Bundle result = new Bundle();
          putBaseMetadata(
              result, waitForIdleTimeoutMs, waitForIdleQuietMs, timeoutMs, maxDepth, maxNodes);
          result.putString("requestId", requestId);
          String xml =
              captureInto(
                  result, waitForIdleQuietMs, waitForIdleTimeoutMs, timeoutMs, maxDepth, maxNodes);
          byte[] body = xml.getBytes(StandardCharsets.UTF_8);
          result.putString("byteLength", Integer.toString(body.length));
          return SessionResponseWriter.encodeSessionResponse(result, body);
        },
        error -> SessionResponseWriter.errorFrame(requestId, error));
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
  /** Captures the tree, records its metadata in result, and returns the XML. */
  private String captureInto(
      Bundle result,
      long waitForIdleQuietMs,
      long waitForIdleTimeoutMs,
      long timeoutMs,
      int maxDepth,
      int maxNodes)
      throws TimeoutException,
          InterruptedException,
          AccessibilityCaptureStabilizer.IncompleteCaptureException {
    long startedAtMs = System.currentTimeMillis();
    DisplayExtent.Extent beforeDump = DisplayExtent.read(getContext());
    AccessibilityTreeCapture.Result capture =
        captureXml(waitForIdleQuietMs, waitForIdleTimeoutMs, timeoutMs, maxDepth, maxNodes);
    DisplayExtent.Extent display =
        DisplayExtent.whenBothAgree(beforeDump, DisplayExtent.read(getContext()));
    result.putString("ok", "true");
    putCaptureMetadata(result, capture, display, System.currentTimeMillis() - startedAtMs);
    return capture.xml;
  }

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
