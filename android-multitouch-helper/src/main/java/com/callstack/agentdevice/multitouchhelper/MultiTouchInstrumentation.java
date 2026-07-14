package com.callstack.agentdevice.multitouchhelper;

import android.app.Instrumentation;
import android.app.UiAutomation;
import android.os.Bundle;
import android.os.SystemClock;
import android.util.Base64;
import android.view.InputDevice;
import android.view.MotionEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;
import android.graphics.Rect;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.TimeoutException;
import org.json.JSONArray;
import org.json.JSONObject;

public final class MultiTouchInstrumentation extends Instrumentation {
  private static final String PROTOCOL = "android-multitouch-helper-v1";
  private static final String HELPER_API_VERSION = "1";
  private static final int MIN_DURATION_MS = 0;
  private static final int MAX_DURATION_MS = 120_000;
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
      if ("viewport".equals(arguments.getString("mode", "gesture"))) {
        Rect viewport = readActiveApplicationViewport();
        result.putString("ok", "true");
        result.putString("kind", "viewport");
        result.putString("x", Integer.toString(viewport.left));
        result.putString("y", Integer.toString(viewport.top));
        result.putString("width", Integer.toString(viewport.width()));
        result.putString("height", Integer.toString(viewport.height()));
        finish(0, result);
        return;
      }
      GesturePlan plan = readPlan(arguments);
      int injectedEvents = injectPlan(plan);
      result.putString("ok", "true");
      result.putString("kind", plan.kind);
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

  @SuppressWarnings("deprecation")
  private Rect readActiveApplicationViewport() {
    UiAutomation automation = getUiAutomation();
    try {
      automation.waitForIdle(100, 2_000);
    } catch (TimeoutException ignored) {
      // Window/root state can still be usable when the app is animating continuously.
    }
    List<AccessibilityWindowInfo> windows = automation.getWindows();
    AccessibilityWindowInfo fallback = null;
    for (AccessibilityWindowInfo window : windows) {
      if (window.getType() != AccessibilityWindowInfo.TYPE_APPLICATION) continue;
      if (window.isActive() || window.isFocused()) {
        Rect bounds = new Rect();
        window.getBoundsInScreen(bounds);
        if (!bounds.isEmpty()) return bounds;
      }
      if (fallback == null) fallback = window;
    }
    AccessibilityNodeInfo activeRoot = automation.getRootInActiveWindow();
    if (activeRoot != null) {
      try {
        Rect bounds = new Rect();
        activeRoot.getBoundsInScreen(bounds);
        if (!bounds.isEmpty()) return bounds;
      } finally {
        activeRoot.recycle();
      }
    }
    if (fallback != null) {
      Rect bounds = new Rect();
      fallback.getBoundsInScreen(bounds);
      if (!bounds.isEmpty()) return bounds;
    }
    throw new IllegalStateException("Active application interaction viewport is unavailable");
  }

  private GesturePlan readPlan(Bundle arguments) throws Exception {
    String payloadBase64 = arguments.getString("payloadBase64", "");
    if (payloadBase64.isEmpty()) throw new IllegalArgumentException("Missing payloadBase64");
    String json =
        new String(Base64.decode(payloadBase64, Base64.DEFAULT), StandardCharsets.UTF_8);
    JSONObject payload = new JSONObject(json);
    String protocol = payload.optString("protocol", PROTOCOL);
    if (!PROTOCOL.equals(protocol)) {
      throw new IllegalArgumentException("Unsupported protocol: " + protocol);
    }
    String kind = payload.getString("kind");
    if (!"swipe".equals(kind) && !"transform".equals(kind)) {
      throw new IllegalArgumentException("Unsupported kind: " + kind);
    }
    int durationMs = requireDuration(payload.getInt("durationMs"));
    PointerPath[] pointers = readPointers(payload.getJSONArray("pointers"), kind, durationMs);
    return new GesturePlan(kind, durationMs, pointers);
  }

  private int injectPlan(GesturePlan plan) {
    UiAutomation automation = getUiAutomation();
    long downTime = SystemClock.uptimeMillis();
    long eventTime = downTime;
    PointerState active = pointerStateAt(plan, 0).firstOnly();
    int count = 0;
    try {
      for (PointerEventSchedule.Step step :
          PointerEventSchedule.create(plan.pointers.length, sampleOffsets(plan))) {
        active = pointerStateAt(plan, step.sampleIndex);
        if (step.pointerCount == 1) active = active.firstOnly();
        eventTime = downTime + step.offsetMs;
        inject(
            automation,
            motionEvent(downTime, eventTime, motionEventAction(step.action), active),
            step.waitForDispatch);
        count += 1;
      }
      return count;
    } catch (RuntimeException error) {
      if (count > 0) injectCancel(automation, downTime, SystemClock.uptimeMillis(), active);
      throw error;
    }
  }

  private static long[] sampleOffsets(GesturePlan plan) {
    PointerSample[] samples = plan.pointers[0].samples;
    long[] offsets = new long[samples.length];
    for (int index = 0; index < samples.length; index += 1) {
      offsets[index] = samples[index].offsetMs;
    }
    return offsets;
  }

  private static int motionEventAction(PointerEventSchedule.Action action) {
    switch (action) {
      case DOWN:
        return MotionEvent.ACTION_DOWN;
      case POINTER_DOWN:
        return MotionEvent.ACTION_POINTER_DOWN | (1 << MotionEvent.ACTION_POINTER_INDEX_SHIFT);
      case MOVE:
        return MotionEvent.ACTION_MOVE;
      case POINTER_UP:
        return MotionEvent.ACTION_POINTER_UP | (1 << MotionEvent.ACTION_POINTER_INDEX_SHIFT);
      case UP:
        return MotionEvent.ACTION_UP;
      default:
        throw new IllegalArgumentException("Unsupported pointer event action: " + action);
    }
  }

  private static PointerPath[] readPointers(JSONArray pointers, String kind, int durationMs)
      throws Exception {
    int expectedCount = "swipe".equals(kind) ? 1 : 2;
    if (pointers.length() != expectedCount) {
      throw new IllegalArgumentException(
          "Planned " + kind + " gesture requires exactly " + expectedCount + " pointer paths");
    }
    PointerPath[] result = new PointerPath[expectedCount];
    for (int pointerIndex = 0; pointerIndex < expectedCount; pointerIndex += 1) {
      JSONObject pointer = pointers.getJSONObject(pointerIndex);
      if (pointer.getInt("pointerId") != pointerIndex) {
        throw new IllegalArgumentException("Planned pointer ids must be ordered from 0");
      }
      JSONArray samples = pointer.getJSONArray("samples");
      if (samples.length() < 2) {
        throw new IllegalArgumentException("Planned pointer path requires at least two samples");
      }
      PointerSample[] parsed = new PointerSample[samples.length()];
      long previousOffsetMs = -1;
      for (int sampleIndex = 0; sampleIndex < samples.length(); sampleIndex += 1) {
        JSONObject sample = samples.getJSONObject(sampleIndex);
        double rawOffsetMs = sample.getDouble("offsetMs");
        double x = sample.getDouble("x");
        double y = sample.getDouble("y");
        if (!finite(rawOffsetMs) || rawOffsetMs != Math.rint(rawOffsetMs)) {
          throw new IllegalArgumentException("Planned sample offsetMs must be a finite integer");
        }
        if (!finite(x) || !finite(y)) {
          throw new IllegalArgumentException("Planned sample coordinates must be finite");
        }
        long offsetMs = (long) rawOffsetMs;
        if (offsetMs < previousOffsetMs
            || (offsetMs == previousOffsetMs && durationMs != 0)) {
          throw new IllegalArgumentException("Planned sample offsets must be strictly increasing");
        }
        parsed[sampleIndex] = new PointerSample(offsetMs, (float) x, (float) y);
        previousOffsetMs = offsetMs;
      }
      if (parsed[0].offsetMs != 0 || parsed[parsed.length - 1].offsetMs != durationMs) {
        throw new IllegalArgumentException("Pointer path must start at 0 and end at durationMs");
      }
      result[pointerIndex] = new PointerPath(parsed);
    }
    if (expectedCount == 2) assertMatchingSamples(result[0], result[1]);
    return result;
  }

  private static void assertMatchingSamples(PointerPath first, PointerPath second) {
    if (first.samples.length != second.samples.length) {
      throw new IllegalArgumentException("Planned pointer paths must have matching samples");
    }
    for (int index = 0; index < first.samples.length; index += 1) {
      if (first.samples[index].offsetMs != second.samples[index].offsetMs) {
        throw new IllegalArgumentException("Planned pointer sample offsets must match");
      }
    }
  }

  private static PointerState pointerStateAt(GesturePlan plan, int sampleIndex) {
    int pointerCount = plan.pointers.length;
    float[] x = new float[pointerCount];
    float[] y = new float[pointerCount];
    for (int index = 0; index < pointerCount; index += 1) {
      PointerSample sample = plan.pointers[index].samples[sampleIndex];
      x[index] = sample.x;
      y[index] = sample.y;
    }
    return new PointerState(x, y);
  }

  private static void inject(UiAutomation automation, MotionEvent event, boolean waitForDispatch) {
    try {
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
    if (delayMs > 0) SystemClock.sleep(delayMs);
  }

  private static void injectCancel(
      UiAutomation automation, long downTime, long eventTime, PointerState pointers) {
    try {
      inject(
          automation,
          motionEvent(downTime, eventTime, MotionEvent.ACTION_CANCEL, pointers),
          true);
    } catch (RuntimeException ignored) {
      // Preserve the original injection failure.
    }
  }

  private static MotionEvent motionEvent(
      long downTime, long eventTime, int action, PointerState pointers) {
    MotionEvent.PointerProperties[] properties =
        new MotionEvent.PointerProperties[pointers.count];
    MotionEvent.PointerCoords[] coords = new MotionEvent.PointerCoords[pointers.count];
    for (int index = 0; index < pointers.count; index += 1) {
      properties[index] = new MotionEvent.PointerProperties();
      properties[index].id = index;
      properties[index].toolType = MotionEvent.TOOL_TYPE_FINGER;
      coords[index] = new MotionEvent.PointerCoords();
      coords[index].x = pointers.x[index];
      coords[index].y = pointers.y[index];
      coords[index].pressure = 1.0f;
      coords[index].size = 1.0f;
    }
    MotionEvent event =
        MotionEvent.obtain(
            downTime,
            eventTime,
            action,
            pointers.count,
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

  private static int requireDuration(int value) {
    if (value < MIN_DURATION_MS || value > MAX_DURATION_MS) {
      throw new IllegalArgumentException("durationMs must be between 0 and 120000");
    }
    return value;
  }

  private static boolean finite(double value) {
    return !Double.isNaN(value) && !Double.isInfinite(value);
  }

  private static final class GesturePlan {
    final String kind;
    final int durationMs;
    final PointerPath[] pointers;

    GesturePlan(String kind, int durationMs, PointerPath[] pointers) {
      this.kind = kind;
      this.durationMs = durationMs;
      this.pointers = pointers;
    }
  }

  private static final class PointerPath {
    final PointerSample[] samples;

    PointerPath(PointerSample[] samples) {
      this.samples = samples;
    }
  }

  private static final class PointerSample {
    final long offsetMs;
    final float x;
    final float y;

    PointerSample(long offsetMs, float x, float y) {
      this.offsetMs = offsetMs;
      this.x = x;
      this.y = y;
    }
  }

  private static final class PointerState {
    final int count;
    final float[] x;
    final float[] y;

    PointerState(float[] x, float[] y) {
      this.count = x.length;
      this.x = x;
      this.y = y;
    }

    PointerState firstOnly() {
      return new PointerState(new float[] {x[0]}, new float[] {y[0]});
    }
  }
}
