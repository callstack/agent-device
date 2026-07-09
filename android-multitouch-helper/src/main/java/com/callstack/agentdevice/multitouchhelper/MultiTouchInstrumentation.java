package com.callstack.agentdevice.multitouchhelper;

import android.app.Instrumentation;
import android.app.UiAutomation;
import android.os.Bundle;
import android.os.SystemClock;
import android.util.Base64;
import android.view.InputDevice;
import android.view.MotionEvent;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

public final class MultiTouchInstrumentation extends Instrumentation {
  private static final String PROTOCOL = "android-multitouch-helper-v1";
  private static final String HELPER_API_VERSION = "1";
  private static final int DEFAULT_RADIUS = 160;
  private static final int MIN_RADIUS = 24;
  private static final int MAX_RADIUS = 1200;
  private static final int MIN_DURATION_MS = 16;
  private static final int MAX_DURATION_MS = 10_000;
  private static final int MOVE_FRAME_INTERVAL_MS = 16;
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
    Bundle result = new Bundle();
    result.putString("agentDeviceProtocol", PROTOCOL);
    result.putString("helperApiVersion", HELPER_API_VERSION);
    try {
      long startedAtMs = System.currentTimeMillis();
      GestureSpec spec = readSpec(arguments);
      int injectedEvents = injectGesture(spec);
      result.putString("ok", "true");
      result.putString("kind", spec.kind);
      result.putString("injectedEvents", Integer.toString(injectedEvents));
      result.putString("elapsedMs", Long.toString(System.currentTimeMillis() - startedAtMs));
      finish(0, result);
    } catch (Throwable error) {
      result.putString("ok", "false");
      result.putString("errorType", error.getClass().getName());
      result.putString(
          "message",
          error.getMessage() == null ? error.getClass().getName() : error.getMessage());
      finish(1, result);
    }
  }

  private GestureSpec readSpec(Bundle arguments) throws Exception {
    String payloadBase64 = arguments.getString("payloadBase64", "");
    if (payloadBase64.isEmpty()) {
      throw new IllegalArgumentException("Missing payloadBase64");
    }
    String json =
        new String(Base64.decode(payloadBase64, Base64.DEFAULT), StandardCharsets.UTF_8);
    JSONObject payload = new JSONObject(json);
    String protocol = payload.optString("protocol", PROTOCOL);
    if (!PROTOCOL.equals(protocol)) {
      throw new IllegalArgumentException("Unsupported protocol: " + protocol);
    }
    String kind = payload.getString("kind");
    if (!"swipe".equals(kind)
        && !"pinch".equals(kind)
        && !"rotate".equals(kind)
        && !"transform".equals(kind)) {
      throw new IllegalArgumentException("Unsupported kind: " + kind);
    }
    int x = "swipe".equals(kind) ? payload.getInt("x1") : payload.getInt("x");
    int y = "swipe".equals(kind) ? payload.getInt("y1") : payload.getInt("y");
    int dx = payload.optInt("dx", 0);
    int dy = payload.optInt("dy", 0);
    int x2 = payload.optInt("x2", x + dx);
    int y2 = payload.optInt("y2", y + dy);
    int durationMs = clamp(payload.optInt("durationMs", 300), MIN_DURATION_MS, MAX_DURATION_MS);
    int radius = clamp(payload.optInt("radius", DEFAULT_RADIUS), MIN_RADIUS, MAX_RADIUS);
    double scale = payload.optDouble("scale", 1.0d);
    double degrees = payload.optDouble("degrees", 0.0d);
    if (("pinch".equals(kind) || "transform".equals(kind)) && (!isFinite(scale) || scale <= 0)) {
      throw new IllegalArgumentException("Scale must be > 0");
    }
    if (("rotate".equals(kind) || "transform".equals(kind)) && !isFinite(degrees)) {
      throw new IllegalArgumentException("Degrees must be finite");
    }
    return new GestureSpec(kind, x, y, dx, dy, x2, y2, durationMs, scale, degrees, radius);
  }

  private int injectGesture(GestureSpec spec) {
    if ("swipe".equals(spec.kind)) {
      return injectSinglePointerGesture(spec);
    }
    UiAutomation automation = getUiAutomation();
    long downTime = SystemClock.uptimeMillis();
    long eventTime = downTime;
    PointerPair start = pointerPairAt(spec, 0);
    PointerPair end = pointerPairAt(spec, 1);
    PointerPair activePointers = start.firstOnly();
    int count = 0;

    try {
      injectScheduledEvent(
          automation,
          motionEvent(downTime, eventTime, MotionEvent.ACTION_DOWN, activePointers),
          true);
      count += 1;
      eventTime += 8;
      injectScheduledEvent(
          automation,
          motionEvent(
              downTime,
              eventTime,
              MotionEvent.ACTION_POINTER_DOWN | (1 << MotionEvent.ACTION_POINTER_INDEX_SHIFT),
              start),
          true);
      count += 1;
      activePointers = start;

      int frameCount =
          Math.max(3, Math.round(spec.durationMs / (float) MOVE_FRAME_INTERVAL_MS));
      for (int index = 1; index < frameCount; index += 1) {
        double t = (double) index / (double) frameCount;
        PointerPair frame = pointerPairAt(spec, t);
        eventTime = downTime + Math.round(spec.durationMs * t);
        injectScheduledEvent(
            automation,
            motionEvent(downTime, eventTime, MotionEvent.ACTION_MOVE, frame),
            false);
        count += 1;
        activePointers = frame;
      }

      eventTime = downTime + spec.durationMs;
      injectScheduledEvent(
          automation,
          motionEvent(
              downTime,
              eventTime,
              MotionEvent.ACTION_POINTER_UP | (1 << MotionEvent.ACTION_POINTER_INDEX_SHIFT),
              end),
          true);
      count += 1;
      activePointers = end.firstOnly();
      injectScheduledEvent(
          automation,
          motionEvent(downTime, eventTime + 8, MotionEvent.ACTION_UP, activePointers),
          true);
      count += 1;
      return count;
    } catch (RuntimeException error) {
      if (count > 0) {
        injectCancel(automation, downTime, eventTime + 16, activePointers);
      }
      throw error;
    }
  }

  private int injectSinglePointerGesture(GestureSpec spec) {
    UiAutomation automation = getUiAutomation();
    long downTime = SystemClock.uptimeMillis();
    long eventTime = downTime;
    PointerPair activePointer = pointerPairAt(spec, 0);
    int count = 0;

    try {
      injectScheduledEvent(
          automation,
          motionEvent(downTime, eventTime, MotionEvent.ACTION_DOWN, activePointer),
          true);
      count += 1;

      int frameCount =
          Math.max(3, Math.round(spec.durationMs / (float) MOVE_FRAME_INTERVAL_MS));
      for (int index = 1; index < frameCount; index += 1) {
        double t = (double) index / (double) frameCount;
        PointerPair frame = pointerPairAt(spec, t);
        eventTime = downTime + Math.round(spec.durationMs * t);
        injectScheduledEvent(
            automation,
            motionEvent(downTime, eventTime, MotionEvent.ACTION_MOVE, frame),
            false);
        count += 1;
        activePointer = frame;
      }

      eventTime = downTime + spec.durationMs;
      activePointer = pointerPairAt(spec, 1);
      injectScheduledEvent(
          automation,
          motionEvent(downTime, eventTime, MotionEvent.ACTION_UP, activePointer),
          true);
      count += 1;
      return count;
    } catch (RuntimeException error) {
      if (count > 0) {
        injectCancel(automation, downTime, eventTime + 16, activePointer);
      }
      throw error;
    }
  }

  private static void injectScheduledEvent(
      UiAutomation automation, MotionEvent event, boolean waitForDispatch) {
    try {
      // Event timestamps alone do not pace UiAutomation injection; recognizers need real time.
      sleepUntil(event.getEventTime());
      if (!automation.injectInputEvent(event, waitForDispatch)) {
        throw new IllegalStateException("injectInputEvent returned false");
      }
    } finally {
      event.recycle();
    }
  }

  private static void sleepUntil(long targetUptimeMs) {
    long delayMs = targetUptimeMs - SystemClock.uptimeMillis();
    if (delayMs > 0) {
      SystemClock.sleep(delayMs);
    }
  }

  private static void injectCancel(
      UiAutomation automation, long downTime, long eventTime, PointerPair pair) {
    try {
      injectScheduledEvent(
          automation,
          motionEvent(downTime, eventTime, MotionEvent.ACTION_CANCEL, pair),
          true);
    } catch (RuntimeException ignored) {
      // Best-effort cleanup; preserve the original injection failure.
    }
  }

  private static MotionEvent motionEvent(long downTime, long eventTime, int action, PointerPair pair) {
    MotionEvent.PointerProperties[] properties =
        new MotionEvent.PointerProperties[pair.pointerCount];
    MotionEvent.PointerCoords[] coords = new MotionEvent.PointerCoords[pair.pointerCount];
    for (int index = 0; index < pair.pointerCount; index += 1) {
      properties[index] = new MotionEvent.PointerProperties();
      properties[index].id = index;
      properties[index].toolType = MotionEvent.TOOL_TYPE_FINGER;
      coords[index] = new MotionEvent.PointerCoords();
      coords[index].x = pair.x[index];
      coords[index].y = pair.y[index];
      coords[index].pressure = 1.0f;
      coords[index].size = 1.0f;
    }
    MotionEvent event =
        MotionEvent.obtain(
            downTime,
            eventTime,
            action,
            pair.pointerCount,
            properties,
            coords,
            0,
            0,
            1.0f,
            1.0f,
            0,
            0,
            InputDevice.SOURCE_TOUCHSCREEN,
            0);
    event.setSource(InputDevice.SOURCE_TOUCHSCREEN);
    return event;
  }

  private static PointerPair pointerPairAt(GestureSpec spec, double t) {
    if ("swipe".equals(spec.kind)) {
      return new PointerPair(
          new float[] {(float) (spec.x + (spec.x2 - spec.x) * t)},
          new float[] {(float) (spec.y + (spec.y2 - spec.y) * t)});
    }
    if ("pinch".equals(spec.kind)) {
      double startRadius = spec.radius / Math.max(spec.scale, 1.0d);
      double endRadius = spec.radius;
      if (spec.scale < 1.0d) {
        startRadius = spec.radius;
        endRadius = spec.radius * spec.scale;
      }
      double radius = startRadius + (endRadius - startRadius) * t;
      return new PointerPair(
          new float[] {(float) (spec.x - radius), (float) (spec.x + radius)},
          new float[] {(float) spec.y, (float) spec.y});
    }
    double centerX = spec.x;
    double centerY = spec.y;
    double radius = spec.radius;
    if ("transform".equals(spec.kind)) {
      centerX = spec.x + spec.dx * t;
      centerY = spec.y + spec.dy * t;
      double startRadius = spec.radius / Math.max(spec.scale, 1.0d);
      double endRadius = spec.radius;
      if (spec.scale < 1.0d) {
        startRadius = spec.radius;
        endRadius = spec.radius * spec.scale;
      }
      radius = startRadius + (endRadius - startRadius) * t;
    }
    double angle = Math.toRadians(-90 + spec.degrees * t);
    return new PointerPair(
        new float[] {
          (float) (centerX + Math.cos(angle) * radius),
          (float) (centerX - Math.cos(angle) * radius)
        },
        new float[] {
          (float) (centerY + Math.sin(angle) * radius),
          (float) (centerY - Math.sin(angle) * radius)
        });
  }

  private static int clamp(int value, int min, int max) {
    return Math.min(Math.max(value, min), max);
  }

  private static boolean isFinite(double value) {
    return !Double.isNaN(value) && !Double.isInfinite(value);
  }

  private static final class GestureSpec {
    final String kind;
    final int x;
    final int y;
    final int dx;
    final int dy;
    final int x2;
    final int y2;
    final int durationMs;
    final double scale;
    final double degrees;
    final int radius;

    GestureSpec(
        String kind,
        int x,
        int y,
        int dx,
        int dy,
        int x2,
        int y2,
        int durationMs,
        double scale,
        double degrees,
        int radius) {
      this.kind = kind;
      this.x = x;
      this.y = y;
      this.dx = dx;
      this.dy = dy;
      this.x2 = x2;
      this.y2 = y2;
      this.durationMs = durationMs;
      this.scale = scale;
      this.degrees = degrees;
      this.radius = radius;
    }
  }

  private static final class PointerPair {
    final int pointerCount;
    final float[] x;
    final float[] y;

    PointerPair(float[] x, float[] y) {
      this.pointerCount = x.length;
      this.x = x;
      this.y = y;
    }

    PointerPair firstOnly() {
      return new PointerPair(
          new float[] {x[0]},
          new float[] {y[0]});
    }
  }
}
