package com.callstack.agentdevice.snapshothelper;

import android.util.Base64;
import java.nio.charset.StandardCharsets;
import org.json.JSONArray;
import org.json.JSONObject;

/** Validated planned-touch payload: one or two complete pointer trajectories. */
final class TouchPlan {
  static final String PAYLOAD_PROTOCOL = "android-touch-plan-v1";
  private static final int MIN_DURATION_MS = 0;
  private static final int MAX_DURATION_MS = 120_000;

  final String kind;
  final int durationMs;
  final PointerPath[] pointers;

  private TouchPlan(String kind, int durationMs, PointerPath[] pointers) {
    this.kind = kind;
    this.durationMs = durationMs;
    this.pointers = pointers;
  }

  static TouchPlan parseBase64(String payloadBase64) throws Exception {
    if (payloadBase64 == null || payloadBase64.isEmpty()) {
      throw new IllegalArgumentException("Missing payloadBase64");
    }
    String json =
        new String(Base64.decode(payloadBase64, Base64.DEFAULT), StandardCharsets.UTF_8);
    JSONObject payload = new JSONObject(json);
    String protocol = payload.optString("protocol", PAYLOAD_PROTOCOL);
    if (!PAYLOAD_PROTOCOL.equals(protocol)) {
      throw new IllegalArgumentException("Unsupported protocol: " + protocol);
    }
    String kind = payload.getString("kind");
    if (!"swipe".equals(kind) && !"transform".equals(kind)) {
      throw new IllegalArgumentException("Unsupported kind: " + kind);
    }
    int durationMs = requireDuration(payload.getInt("durationMs"));
    PointerPath[] pointers = readPointers(payload.getJSONArray("pointers"), kind, durationMs);
    return new TouchPlan(kind, durationMs, pointers);
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

  private static int requireDuration(int value) {
    if (value < MIN_DURATION_MS || value > MAX_DURATION_MS) {
      throw new IllegalArgumentException("durationMs must be between 0 and 120000");
    }
    return value;
  }

  private static boolean finite(double value) {
    return !Double.isNaN(value) && !Double.isInfinite(value);
  }

  static final class PointerPath {
    final PointerSample[] samples;

    PointerPath(PointerSample[] samples) {
      this.samples = samples;
    }
  }

  static final class PointerSample {
    final long offsetMs;
    final float x;
    final float y;

    PointerSample(long offsetMs, float x, float y) {
      this.offsetMs = offsetMs;
      this.x = x;
      this.y = y;
    }
  }
}
