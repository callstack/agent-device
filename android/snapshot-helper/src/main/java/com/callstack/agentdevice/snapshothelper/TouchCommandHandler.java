package com.callstack.agentdevice.snapshothelper;

import android.app.UiAutomation;
import android.graphics.Rect;
import android.os.Bundle;
import java.io.IOException;
import java.io.OutputStream;

/**
 * Populates viewport/gesture results against an already-connected {@link UiAutomation}, for both
 * the one-shot instrumentation result and the persistent-session socket responses. The caller owns
 * connecting to UiAutomation and finishing/flushing the surrounding transport.
 */
final class TouchCommandHandler {
  private TouchCommandHandler() {}

  static void populateViewport(Bundle result, UiAutomation automation) {
    Rect viewport = GestureViewportReader.read(automation);
    result.putString("ok", "true");
    result.putString("kind", "viewport");
    putViewportMetadata(result, viewport);
  }

  static void populateGesture(Bundle result, UiAutomation automation, String payloadBase64)
      throws Exception {
    long startedAtMs = System.currentTimeMillis();
    TouchPlan plan = TouchPlan.parseBase64(payloadBase64);
    int injectedEvents = TouchPlanInjector.inject(automation, plan);
    result.putString("ok", "true");
    result.putString("kind", plan.kind);
    result.putString("injectedEvents", Integer.toString(injectedEvents));
    result.putString("elapsedMs", Long.toString(System.currentTimeMillis() - startedAtMs));
  }

  static void writeSessionViewport(OutputStream output, String requestId, UiAutomation automation)
      throws IOException {
    Bundle result = SessionResponseWriter.sessionResponseBundle(requestId);
    try {
      populateViewport(result, automation);
      SessionResponseWriter.writeSessionResponse(output, result, "");
    } catch (Throwable error) {
      SessionResponseWriter.writeSessionError(
          output,
          requestId,
          error.getClass().getName(),
          error.getMessage() == null ? error.getClass().getName() : error.getMessage());
    }
  }

  static void writeSessionGesture(
      OutputStream output, String requestId, String payloadBase64, UiAutomation automation)
      throws IOException {
    Bundle result = SessionResponseWriter.sessionResponseBundle(requestId);
    try {
      populateGesture(result, automation, payloadBase64);
      SessionResponseWriter.writeSessionResponse(output, result, "");
    } catch (Throwable error) {
      SessionResponseWriter.writeSessionError(
          output,
          requestId,
          error.getClass().getName(),
          error.getMessage() == null ? error.getClass().getName() : error.getMessage());
    }
  }

  private static void putViewportMetadata(Bundle result, Rect viewport) {
    result.putString("x", Integer.toString(viewport.left));
    result.putString("y", Integer.toString(viewport.top));
    result.putString("width", Integer.toString(viewport.width()));
    result.putString("height", Integer.toString(viewport.height()));
  }
}
