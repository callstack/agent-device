package com.callstack.agentdevice.snapshothelper;

import android.app.UiAutomation;
import android.os.SystemClock;
import android.view.InputDevice;
import android.view.MotionEvent;

/** Injects a validated touch plan through UiAutomation with real-time sample pacing. */
final class TouchPlanInjector {
  private TouchPlanInjector() {}

  static int inject(UiAutomation automation, TouchPlan plan) {
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
        injectEvent(
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

  private static long[] sampleOffsets(TouchPlan plan) {
    TouchPlan.PointerSample[] samples = plan.pointers[0].samples;
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

  private static TouchPlanInjector.PointerState pointerStateAt(TouchPlan plan, int sampleIndex) {
    int pointerCount = plan.pointers.length;
    float[] x = new float[pointerCount];
    float[] y = new float[pointerCount];
    for (int index = 0; index < pointerCount; index += 1) {
      TouchPlan.PointerSample sample = plan.pointers[index].samples[sampleIndex];
      x[index] = sample.x;
      y[index] = sample.y;
    }
    return new PointerState(x, y);
  }

  private static void injectEvent(
      UiAutomation automation, MotionEvent event, boolean waitForDispatch) {
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
      injectEvent(
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
