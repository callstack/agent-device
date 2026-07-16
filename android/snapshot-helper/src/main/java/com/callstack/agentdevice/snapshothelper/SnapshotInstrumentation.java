package com.callstack.agentdevice.snapshothelper;

import android.accessibilityservice.AccessibilityServiceInfo;
import android.app.Instrumentation;
import android.app.UiAutomation;
import android.graphics.Rect;
import android.os.Build;
import android.os.Bundle;
import android.util.Base64;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityNodeInfo.AccessibilityAction;
import android.view.accessibility.AccessibilityWindowInfo;
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
import java.util.List;
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
      CaptureResult capture =
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

  private static void putCaptureMetadata(Bundle result, CaptureResult capture, long elapsedMs) {
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
      CaptureResult capture =
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
  private CaptureResult captureXml(
      long waitForIdleQuietMs,
      long waitForIdleTimeoutMs,
      long timeoutMs,
      int maxDepth,
      int maxNodes)
      throws TimeoutException {
    UiAutomation automation = getConnectedUiAutomation(timeoutMs);
    enableInteractiveWindowRetrieval(automation);
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
    clearAccessibilityCache(automation);

    CaptureStats stats = new CaptureStats();
    StringBuilder xml = new StringBuilder();
    xml.append("<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>");
    xml.append("<hierarchy rotation=\"0\">");
    int windowCount = appendInteractiveWindowRoots(xml, automation, maxDepth, maxNodes, stats);
    String captureMode = "interactive-windows";
    if (windowCount == 0) {
      AccessibilityNodeInfo root = automation.getRootInActiveWindow();
      try {
        if (root != null) {
          appendNode(xml, root, 0, 0, maxDepth, maxNodes, stats, null);
          windowCount = 1;
        }
        captureMode = "active-window";
      } finally {
        if (root != null) {
          root.recycle();
        }
      }
    }
    xml.append("</hierarchy>");
    return new CaptureResult(
        xml.toString(), windowCount > 0, captureMode, windowCount, stats.nodeCount, stats.truncated);
  }

  private static void clearAccessibilityCache(UiAutomation automation) {
    // Navigation 3 and any in-place content swap that keeps the same window/Activity render every
    // destination inside one AndroidComposeView. A persistent helper session reuses a single
    // UiAutomation connection across captures, and its per-connection accessibility node cache is
    // not always invalidated by such a swap, so getWindows()/getRootInActiveWindow() can keep
    // returning the previous screen. Drop the cache before each traversal so every capture re-reads
    // the live tree, the way a fresh `uiautomator dump` (new connection, empty cache) does.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      try {
        automation.clearCache();
        return;
      } catch (RuntimeException ignored) {
        // Fall back to the setServiceInfo() flush below if the platform rejects the public API.
      }
    }
    clearAccessibilityCacheViaServiceInfo(automation);
  }

  private static void clearAccessibilityCacheViaServiceInfo(UiAutomation automation) {
    // Platforms before API 34 lack UiAutomation.clearCache(). Re-applying the current service info
    // is the supported public-API way to drop the cache there: UiAutomation.setServiceInfo() calls
    // AccessibilityInteractionClient.clearCache() before forwarding the config (verified in AOSP
    // from API 24 through 33). Reflecting the internal clearCache() directly is not an option — it
    // is a blocklisted non-SDK member, so hidden-API enforcement makes it unreachable from the
    // helper process. Best-effort: if the flush fails the capture proceeds with the current tree.
    try {
      automation.setServiceInfo(automation.getServiceInfo());
    } catch (RuntimeException ignored) {
      // No reliable cache reset on this platform; leave capture behavior unchanged.
    }
  }

  private UiAutomation getConnectedUiAutomation(long timeoutMs) throws TimeoutException {
    long deadlineMs = System.currentTimeMillis() + Math.max(1, timeoutMs);
    UiAutomation automation = getUiAutomation();
    RuntimeException lastError = null;
    while (System.currentTimeMillis() <= deadlineMs) {
      try {
        automation.getServiceInfo();
        return automation;
      } catch (IllegalStateException error) {
        if (!isUiAutomationConnectingError(error) && !isUiAutomationNotConnectedError(error)) {
          throw error;
        }
        lastError = error;
      }
      sleep(50);
    }
    TimeoutException timeout =
        new TimeoutException("Timed out waiting for Android UiAutomation to connect");
    if (lastError != null) {
      timeout.initCause(lastError);
    }
    throw timeout;
  }

  private static void enableInteractiveWindowRetrieval(UiAutomation automation) {
    AccessibilityServiceInfo serviceInfo;
    try {
      serviceInfo = automation.getServiceInfo();
    } catch (RuntimeException error) {
      return;
    }
    if (serviceInfo == null) {
      return;
    }
    if ((serviceInfo.flags & AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS) != 0) {
      return;
    }
    serviceInfo.flags |= AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS;
    try {
      automation.setServiceInfo(serviceInfo);
    } catch (RuntimeException ignored) {
      // Fall back to active-window capture if the platform rejects dynamic service flags.
    }
  }

  @SuppressWarnings("deprecation")
  private static int appendInteractiveWindowRoots(
      StringBuilder xml,
      UiAutomation automation,
      int maxDepth,
      int maxNodes,
      CaptureStats stats) {
    List<AccessibilityWindowInfo> windows;
    try {
      windows = automation.getWindows();
    } catch (RuntimeException error) {
      return 0;
    }
    int windowCount = 0;
    for (int index = 0; index < windows.size(); index += 1) {
      if (stats.nodeCount >= maxNodes) {
        stats.truncated = true;
        break;
      }
      AccessibilityWindowInfo window = windows.get(index);
      AccessibilityNodeInfo root = null;
      try {
        root = window.getRoot();
        if (root == null) {
          continue;
        }
        StringBuilder windowXml = new StringBuilder();
        CaptureStats windowStats = stats.copy();
        appendNode(
            windowXml,
            root,
            windowCount,
            0,
            maxDepth,
            maxNodes,
            windowStats,
            readWindowMetadata(window, windowCount));
        xml.append(windowXml);
        stats.copyFrom(windowStats);
        windowCount += 1;
      } catch (RuntimeException ignored) {
        // Accessibility windows can disappear while traversing; keep the rest of the snapshot.
      } finally {
        if (root != null) {
          root.recycle();
        }
        // UiAutomation.getWindows() transfers recyclable AccessibilityWindowInfo instances.
        window.recycle();
      }
    }
    return windowCount;
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

  @SuppressWarnings("deprecation")
  private static void appendNode(
      StringBuilder xml,
      AccessibilityNodeInfo node,
      int nodeIndex,
      int depth,
      int maxDepth,
      int maxNodes,
      CaptureStats stats,
      WindowMetadata windowMetadata) {
    if (stats.nodeCount >= maxNodes) {
      stats.truncated = true;
      return;
    }
    stats.nodeCount += 1;
    Rect bounds = new Rect();
    node.getBoundsInScreen(bounds);
    xml.append("<node");
    // Emit only fields consumed by the host parser. Extra boolean attrs made every node larger
    // without affecting current snapshot semantics; add fields back here when TS starts reading
    // them.
    appendAttribute(xml, "index", Integer.toString(nodeIndex));
    if (windowMetadata != null) {
      appendWindowMetadata(xml, windowMetadata);
    }
    appendNonEmptyAttribute(xml, "text", node.getText());
    appendNonEmptyAttribute(xml, "resource-id", node.getViewIdResourceName());
    appendAttribute(xml, "class", node.getClassName());
    appendNonEmptyAttribute(xml, "package", node.getPackageName());
    appendNonEmptyAttribute(xml, "content-desc", node.getContentDescription());
    appendAttribute(xml, "visible-to-user", Boolean.toString(node.isVisibleToUser()));
    appendDrawingOrderAttribute(xml, node);
    appendTrueAttribute(xml, "clickable", node.isClickable());
    appendAttribute(xml, "enabled", Boolean.toString(node.isEnabled()));
    appendTrueAttribute(xml, "focusable", node.isFocusable());
    appendTrueAttribute(xml, "focused", node.isFocused());
    boolean scrollable = node.isScrollable();
    if (scrollable) {
      appendAttribute(xml, "scrollable", "true");
      appendAttribute(
          xml,
          "can-scroll-forward",
          Boolean.toString(
              hasAccessibilityAction(node, AccessibilityAction.ACTION_SCROLL_FORWARD)));
      appendAttribute(
          xml,
          "can-scroll-backward",
          Boolean.toString(
              hasAccessibilityAction(node, AccessibilityAction.ACTION_SCROLL_BACKWARD)));
    }
    appendTrueAttribute(xml, "password", node.isPassword());
    appendAttribute(
        xml,
        "bounds",
        String.format(
            Locale.ROOT,
            "[%d,%d][%d,%d]",
            bounds.left,
            bounds.top,
            bounds.right,
            bounds.bottom));

    int childCount = depth >= maxDepth ? 0 : node.getChildCount();
    if (depth >= maxDepth && node.getChildCount() > 0) {
      stats.truncated = true;
    }
    if (childCount <= 0) {
      xml.append(" />");
      return;
    }

    xml.append(">");
    for (int index = 0; index < childCount; index += 1) {
      if (stats.nodeCount >= maxNodes) {
        stats.truncated = true;
        break;
      }
      AccessibilityNodeInfo child = node.getChild(index);
      if (child == null) {
        continue;
      }
      try {
        appendNode(xml, child, index, depth + 1, maxDepth, maxNodes, stats, null);
      } finally {
        child.recycle();
      }
    }
    xml.append("</node>");
  }

  private static void appendNonEmptyAttribute(StringBuilder xml, String name, CharSequence value) {
    if (value == null || value.length() == 0) {
      return;
    }
    appendAttribute(xml, name, value);
  }

  private static void appendTrueAttribute(StringBuilder xml, String name, boolean value) {
    if (value) {
      appendAttribute(xml, name, "true");
    }
  }

  private static void appendDrawingOrderAttribute(StringBuilder xml, AccessibilityNodeInfo node) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
      appendAttribute(xml, "drawing-order", Integer.toString(node.getDrawingOrder()));
    }
  }

  private static void appendWindowMetadata(StringBuilder xml, WindowMetadata metadata) {
    appendAttribute(xml, "window-index", Integer.toString(metadata.index));
    appendAttribute(xml, "window-type", Integer.toString(metadata.type));
    appendAttribute(xml, "window-layer", Integer.toString(metadata.layer));
    appendAttribute(xml, "window-active", Boolean.toString(metadata.active));
    appendAttribute(xml, "window-focused", Boolean.toString(metadata.focused));
    appendAttribute(
        xml,
        "window-bounds",
        String.format(
            Locale.ROOT,
            "[%d,%d][%d,%d]",
            metadata.bounds.left,
            metadata.bounds.top,
            metadata.bounds.right,
            metadata.bounds.bottom));
  }

  @SuppressWarnings("deprecation")
  private static WindowMetadata readWindowMetadata(AccessibilityWindowInfo window, int index) {
    Rect bounds = new Rect();
    window.getBoundsInScreen(bounds);
    return new WindowMetadata(
        index, window.getType(), window.getLayer(), window.isActive(), window.isFocused(), bounds);
  }

  private static void appendAttribute(StringBuilder xml, String name, CharSequence value) {
    String stringValue = value == null ? "" : value.toString();
    xml.append(' ');
    xml.append(name);
    xml.append("=\"");
    appendEscaped(xml, stringValue);
    xml.append('"');
  }

  private static boolean hasAccessibilityAction(
      AccessibilityNodeInfo node, AccessibilityAction action) {
    List<AccessibilityAction> actions = node.getActionList();
    return actions != null && actions.contains(action);
  }

  private static void appendEscaped(StringBuilder xml, String value) {
    for (int index = 0; index < value.length(); index += 1) {
      char character = value.charAt(index);
      switch (character) {
        case '&':
          xml.append("&amp;");
          break;
        case '<':
          xml.append("&lt;");
          break;
        case '>':
          xml.append("&gt;");
          break;
        case '"':
          xml.append("&quot;");
          break;
        case '\'':
          xml.append("&apos;");
          break;
        case '\n':
          xml.append("&#10;");
          break;
        case '\r':
          xml.append("&#13;");
          break;
        case '\t':
          xml.append("&#9;");
          break;
        default:
          xml.append(character);
          break;
      }
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

  private static final class CaptureStats {
    int nodeCount;
    boolean truncated;

    CaptureStats copy() {
      CaptureStats next = new CaptureStats();
      next.nodeCount = nodeCount;
      next.truncated = truncated;
      return next;
    }

    void copyFrom(CaptureStats next) {
      nodeCount = next.nodeCount;
      truncated = next.truncated;
    }
  }

  private static final class CaptureResult {
    final String xml;
    final boolean rootPresent;
    final String captureMode;
    final int windowCount;
    final int nodeCount;
    final boolean truncated;

    CaptureResult(
        String xml,
        boolean rootPresent,
        String captureMode,
        int windowCount,
        int nodeCount,
        boolean truncated) {
      this.xml = xml;
      this.rootPresent = rootPresent;
      this.captureMode = captureMode;
      this.windowCount = windowCount;
      this.nodeCount = nodeCount;
      this.truncated = truncated;
    }
  }

  private static final class WindowMetadata {
    final int index;
    final int type;
    final int layer;
    final boolean active;
    final boolean focused;
    final Rect bounds;

    WindowMetadata(int index, int type, int layer, boolean active, boolean focused, Rect bounds) {
      this.index = index;
      this.type = type;
      this.layer = layer;
      this.active = active;
      this.focused = focused;
      this.bounds = bounds;
    }
  }
}
