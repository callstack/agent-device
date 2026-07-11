package com.callstack.agentdevice.multitouchhelper;

import android.app.Instrumentation;
import android.app.UiAutomation;
import android.os.Bundle;
import android.os.SystemClock;
import android.util.Base64;
import android.view.InputDevice;
import android.view.MotionEvent;
import java.nio.charset.StandardCharsets;
import org.json.JSONArray;
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
    boolean hasPlannedPointers = payload.has("pointers");
    int x = hasPlannedPointers
        ? 0
        : ("swipe".equals(kind) ? payload.getInt("x1") : payload.getInt("x"));
    int y = hasPlannedPointers
        ? 0
        : ("swipe".equals(kind) ? payload.getInt("y1") : payload.getInt("y"));
    int dx = payload.optInt("dx", 0);
    int dy = payload.optInt("dy", 0);
    int x2 = payload.optInt("x2", x + dx);
    int y2 = payload.optInt("y2", y + dy);
    int requestedDurationMs = payload.optInt("durationMs", 300);
    int durationMs = hasPlannedPointers
        ? requireInRange(requestedDurationMs, MIN_DURATION_MS, MAX_DURATION_MS, "durationMs")
        : clamp(requestedDurationMs, MIN_DURATION_MS, MAX_DURATION_MS);
    int radius = clamp(payload.optInt("radius", DEFAULT_RADIUS), MIN_RADIUS, MAX_RADIUS);
    double scale = payload.optDouble("scale", 1.0d);
    double degrees = payload.optDouble("degrees", 0.0d);
    if (("pinch".equals(kind) || "transform".equals(kind)) && (!isFinite(scale) || scale <= 0)) {
      throw new IllegalArgumentException("Scale must be > 0");
    }
    if (("rotate".equals(kind) || "transform".equals(kind)) && !isFinite(degrees)) {
      throw new IllegalArgumentException("Degrees must be finite");
    }
    PlannedPointerPath[] plannedPointers = hasPlannedPointers
        ? readPlannedPointers(payload.getJSONArray("pointers"), kind, durationMs)
        : null;
    return new GestureSpec(
        kind, x, y, dx, dy, x2, y2, durationMs, scale, degrees, radius, plannedPointers);
  }

  private int injectGesture(GestureSpec spec) {
    if (spec.plannedPointers != null) {
      return injectPlannedGesture(spec);
    }
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

  private int injectPlannedGesture(GestureSpec spec) {
    return spec.plannedPointers.length == 1
        ? injectPlannedSinglePointerGesture(spec)
        : injectPlannedTwoPointerGesture(spec);
  }

  private int injectPlannedSinglePointerGesture(GestureSpec spec) {
    UiAutomation automation = getUiAutomation();
    long downTime = SystemClock.uptimeMillis();
    long eventTime = downTime;
    PointerPair activePointer = plannedPointerPairAt(spec, 0);
    int count = 0;

    try {
      injectScheduledEvent(
          automation,
          motionEvent(downTime, eventTime, MotionEvent.ACTION_DOWN, activePointer),
          true);
      count += 1;

      int lastIndex = spec.plannedPointers[0].samples.length - 1;
      for (int index = 1; index <= lastIndex; index += 1) {
        activePointer = plannedPointerPairAt(spec, index);
        eventTime = downTime + spec.plannedPointers[0].samples[index].offsetMs;
        injectScheduledEvent(
            automation,
            motionEvent(downTime, eventTime, MotionEvent.ACTION_MOVE, activePointer),
            false);
        count += 1;
      }

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

  private int injectPlannedTwoPointerGesture(GestureSpec spec) {
    UiAutomation automation = getUiAutomation();
    long downTime = SystemClock.uptimeMillis();
    long eventTime = downTime;
    PointerPair start = plannedPointerPairAt(spec, 0);
    PointerPair activePointers = start.firstOnly();
    int count = 0;

    try {
      injectScheduledEvent(
          automation,
          motionEvent(downTime, eventTime, MotionEvent.ACTION_DOWN, activePointers),
          true);
      count += 1;

      long firstMoveOffset = spec.plannedPointers[0].samples[1].offsetMs;
      long secondPointerOffset = Math.max(1, Math.min(8, firstMoveOffset - 1));
      eventTime = downTime + secondPointerOffset;
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

      int lastIndex = spec.plannedPointers[0].samples.length - 1;
      for (int index = 1; index <= lastIndex; index += 1) {
        activePointers = plannedPointerPairAt(spec, index);
        eventTime = downTime + spec.plannedPointers[0].samples[index].offsetMs;
        injectScheduledEvent(
            automation,
            motionEvent(downTime, eventTime, MotionEvent.ACTION_MOVE, activePointers),
            false);
        count += 1;
      }

      injectScheduledEvent(
          automation,
          motionEvent(
              downTime,
              eventTime,
              MotionEvent.ACTION_POINTER_UP | (1 << MotionEvent.ACTION_POINTER_INDEX_SHIFT),
              activePointers),
          true);
      count += 1;
      activePointers = activePointers.firstOnly();
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
      return twoPointerPairAt(spec.x, spec.y, radius, 0.0d);
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
    return twoPointerPairAt(centerX, centerY, radius, spec.degrees * t);
  }

  private static PointerPair twoPointerPairAt(
      double centerX, double centerY, double radius, double rotationDegrees) {
    float[][] coordinates = TwoPointerGeometry.pointsAt(
        centerX, centerY, radius, rotationDegrees);
    return new PointerPair(
        coordinates[0], coordinates[1]);
  }

  private static PlannedPointerPath[] readPlannedPointers(
      JSONArray pointers, String kind, int durationMs) throws Exception {
    int expectedCount = "swipe".equals(kind) ? 1 : 2;
    if (pointers.length() != expectedCount) {
      throw new IllegalArgumentException(
          "Planned " + kind + " gesture requires exactly " + expectedCount + " pointer paths");
    }
    PlannedPointerPath[] result = new PlannedPointerPath[expectedCount];
    for (int pointerIndex = 0; pointerIndex < expectedCount; pointerIndex += 1) {
      JSONObject pointer = pointers.getJSONObject(pointerIndex);
      int pointerId = pointer.getInt("pointerId");
      if (pointerId != pointerIndex) {
        throw new IllegalArgumentException("Planned pointer ids must be ordered from 0");
      }
      JSONArray samples = pointer.getJSONArray("samples");
      if (samples.length() < 2) {
        throw new IllegalArgumentException("Planned pointer path requires at least two samples");
      }
      PlannedPointerSample[] parsedSamples = new PlannedPointerSample[samples.length()];
      long previousOffsetMs = -1;
      for (int sampleIndex = 0; sampleIndex < samples.length(); sampleIndex += 1) {
        JSONObject sample = samples.getJSONObject(sampleIndex);
        double rawOffsetMs = sample.getDouble("offsetMs");
        double x = sample.getDouble("x");
        double y = sample.getDouble("y");
        if (!isFinite(rawOffsetMs) || rawOffsetMs != Math.rint(rawOffsetMs)) {
          throw new IllegalArgumentException("Planned sample offsetMs must be a finite integer");
        }
        if (!isFinite(x) || !isFinite(y)) {
          throw new IllegalArgumentException("Planned sample coordinates must be finite");
        }
        long offsetMs = (long) rawOffsetMs;
        if (offsetMs <= previousOffsetMs) {
          throw new IllegalArgumentException("Planned sample offsets must be strictly increasing");
        }
        parsedSamples[sampleIndex] = new PlannedPointerSample(offsetMs, (float) x, (float) y);
        previousOffsetMs = offsetMs;
      }
      if (parsedSamples[0].offsetMs != 0
          || parsedSamples[parsedSamples.length - 1].offsetMs != durationMs) {
        throw new IllegalArgumentException(
            "Planned pointer path must start at 0 and end at durationMs");
      }
      result[pointerIndex] = new PlannedPointerPath(pointerId, parsedSamples);
    }
    if (expectedCount == 2) {
      PlannedPointerSample[] first = result[0].samples;
      PlannedPointerSample[] second = result[1].samples;
      if (first.length != second.length) {
        throw new IllegalArgumentException("Planned pointer paths must have matching samples");
      }
      for (int index = 0; index < first.length; index += 1) {
        if (first[index].offsetMs != second[index].offsetMs) {
          throw new IllegalArgumentException("Planned pointer sample offsets must match");
        }
      }
    }
    return result;
  }

  private static PointerPair plannedPointerPairAt(GestureSpec spec, int sampleIndex) {
    int pointerCount = spec.plannedPointers.length;
    float[] x = new float[pointerCount];
    float[] y = new float[pointerCount];
    for (int pointerIndex = 0; pointerIndex < pointerCount; pointerIndex += 1) {
      PlannedPointerSample sample = spec.plannedPointers[pointerIndex].samples[sampleIndex];
      x[pointerIndex] = sample.x;
      y[pointerIndex] = sample.y;
    }
    return new PointerPair(x, y);
  }

  private static int clamp(int value, int min, int max) {
    return Math.min(Math.max(value, min), max);
  }

  private static int requireInRange(int value, int min, int max, String field) {
    if (value < min || value > max) {
      throw new IllegalArgumentException(field + " must be between " + min + " and " + max);
    }
    return value;
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
    final PlannedPointerPath[] plannedPointers;

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
        int radius,
        PlannedPointerPath[] plannedPointers) {
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
      this.plannedPointers = plannedPointers;
    }
  }

  private static final class PlannedPointerPath {
    final int pointerId;
    final PlannedPointerSample[] samples;

    PlannedPointerPath(int pointerId, PlannedPointerSample[] samples) {
      this.pointerId = pointerId;
      this.samples = samples;
    }
  }

  private static final class PlannedPointerSample {
    final long offsetMs;
    final float x;
    final float y;

    PlannedPointerSample(long offsetMs, float x, float y) {
      this.offsetMs = offsetMs;
      this.x = x;
      this.y = y;
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
