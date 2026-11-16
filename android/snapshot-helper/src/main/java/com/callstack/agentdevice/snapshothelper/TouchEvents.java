package com.callstack.agentdevice.snapshothelper;

import android.view.InputDevice;
import android.view.MotionEvent;

/** Builds the touchscreen finger events that taps and touch plans inject. */
final class TouchEvents {
  private TouchEvents() {}

  /** One pointer per coordinate pair; pointer ids follow the array order. */
  static MotionEvent obtain(
      long downTime, long eventTime, int action, float[] x, float[] y, int flags) {
    int count = x.length;
    MotionEvent.PointerProperties[] properties = new MotionEvent.PointerProperties[count];
    MotionEvent.PointerCoords[] coords = new MotionEvent.PointerCoords[count];
    for (int index = 0; index < count; index += 1) {
      properties[index] = new MotionEvent.PointerProperties();
      properties[index].id = index;
      properties[index].toolType = MotionEvent.TOOL_TYPE_FINGER;
      coords[index] = new MotionEvent.PointerCoords();
      coords[index].x = x[index];
      coords[index].y = y[index];
      coords[index].pressure = 1.0f;
      coords[index].size = 1.0f;
    }
    MotionEvent event = MotionEvent.obtain(downTime, eventTime, action, count, properties, coords,
        0, 0, 1.0f, 1.0f, 0, 0, InputDevice.SOURCE_TOUCHSCREEN, flags);
    event.setSource(InputDevice.SOURCE_TOUCHSCREEN);
    return event;
  }
}
