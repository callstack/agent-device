import { isIosFamily } from '../kernel/device.ts';
import type { RecordingGestureEvent, SessionState } from './types.ts';
import type { SnapshotState } from '../kernel/snapshot.ts';
import {
  resolveGestureDurationMs,
  resolveGestureOffsetMs,
  resolveTapVisualizationOffsetMs,
} from './recording-timing.ts';
import { emitDiagnostic } from '../utils/diagnostics.ts';
import {
  buildScrollGesturePlan,
  type ScrollDirection,
  type SwipePattern,
} from '../contracts/scroll-gesture.ts';
import {
  getSnapshotReferenceFrame,
  type TouchReferenceFrame as ReferenceFrame,
} from './touch-reference-frame.ts';
import { buildCanonicalGestureEvents, buildSwipeTravelEvent } from './recording-gesture-events.ts';
import { readRecordingNumber, resolveRecordingDurationMs } from './recording-values.ts';

const DEFAULT_TAP_GAP_MS = 90;
const DEFAULT_SWIPE_DURATION_MS = 250;
const DEFAULT_SCROLL_REFERENCE_FRAME: ReferenceFrame = {
  referenceWidth: 1000,
  referenceHeight: 1000,
};

export function recordTouchVisualizationEvent(
  session: SessionState,
  command: string,
  positionals: string[],
  result: Record<string, unknown> | void,
  fallback: Record<string, unknown> = {},
  startedAtMs = Date.now(),
  finishedAtMs = Date.now(),
): void {
  const recording = session.recording;
  if (!recording) return;

  const merged = { ...fallback, ...(result ?? {}) };
  const reportedDurationMs =
    readRecordingNumber(merged.effectiveDurationMs) ?? readRecordingNumber(merged.durationMs);
  const timingSource = {
    recordingStartedAt: recording.startedAt,
    gestureClockOriginAtMs: recording.gestureClockOriginAtMs,
    gestureClockOriginUptimeMs: recording.gestureClockOriginUptimeMs,
    runnerStartedAtUptimeMs:
      recording.platform === 'ios-device-runner' ? recording.runnerStartedAtUptimeMs : undefined,
    gestureStartUptimeMs: readRecordingNumber(merged.gestureStartUptimeMs),
    gestureEndUptimeMs: readRecordingNumber(merged.gestureEndUptimeMs),
    fallbackStartedAtMs: startedAtMs,
    fallbackFinishedAtMs: finishedAtMs,
  };
  const gestureDurationMs = resolveGestureDurationMs({
    gestureStartUptimeMs: readRecordingNumber(merged.gestureStartUptimeMs),
    gestureEndUptimeMs: readRecordingNumber(merged.gestureEndUptimeMs),
    reportedDurationMs,
    fallbackStartedAtMs: startedAtMs,
    fallbackFinishedAtMs: finishedAtMs,
  });
  const tMs =
    isIosFamily(session.device) &&
    readRecordingNumber(merged.gestureStartUptimeMs) === undefined &&
    shouldAnchorTapVisualizationNearCompletion(command, merged)
      ? resolveTapVisualizationOffsetMs({ ...timingSource, gestureDurationMs })
      : resolveGestureOffsetMs(timingSource);
  const referenceFrame = resolveEventReferenceFrame(session.snapshot, merged);
  const events = buildGestureEvents(
    command,
    positionals,
    merged,
    tMs,
    gestureDurationMs,
    referenceFrame,
  );
  if (events.length === 0) return;
  recording.gestureEvents.push(...events);
  emitDiagnostic({
    level: 'debug',
    phase: 'record_touch_visualization_event',
    data: {
      session: session.name,
      command,
      count: events.length,
      tMs,
      gestureDurationMs,
      kinds: events.map((event) => event.kind),
    },
  });
}

// Scroll commands do not carry a concrete gesture path from the platform layer, so we
// synthesize one here before recording telemetry.
export function augmentScrollVisualizationResult(
  session: SessionState,
  command: string,
  positionals: string[],
  result: Record<string, unknown> | void,
): Record<string, unknown> | void {
  if (command !== 'scroll') return result;

  const referenceFrame = getSnapshotReferenceFrame(session.snapshot);
  const merged = { ...(result ?? {}) };
  const contentDirection = readDirection(merged.direction) ?? readDirection(positionals[0]);
  if (!contentDirection) return result;

  const amountValue = readRecordingNumber(merged.amount) ?? readRecordingNumber(positionals[1]);
  const pixelValue = readRecordingNumber(merged.pixels);
  const durationMs = readRecordingNumber(merged.durationMs) ?? DEFAULT_SWIPE_DURATION_MS;
  const explicitTravel = readTravelCoordinates(merged, []);
  const explicitReferenceWidth = readRecordingNumber(merged.referenceWidth);
  const explicitReferenceHeight = readRecordingNumber(merged.referenceHeight);
  const fallbackReferenceFrame =
    explicitReferenceWidth !== undefined &&
    explicitReferenceWidth > 0 &&
    explicitReferenceHeight !== undefined &&
    explicitReferenceHeight > 0
      ? {
          referenceWidth: explicitReferenceWidth,
          referenceHeight: explicitReferenceHeight,
        }
      : (referenceFrame ?? DEFAULT_SCROLL_REFERENCE_FRAME);

  if (
    explicitTravel &&
    (explicitTravel.x1 !== explicitTravel.x2 || explicitTravel.y1 !== explicitTravel.y2)
  ) {
    return {
      ...merged,
      x1: explicitTravel.x1,
      y1: explicitTravel.y1,
      x2: explicitTravel.x2,
      y2: explicitTravel.y2,
      contentDirection,
      ...(amountValue !== undefined ? { amount: amountValue } : {}),
      ...(pixelValue !== undefined ? { pixels: pixelValue } : {}),
      referenceWidth: fallbackReferenceFrame.referenceWidth,
      referenceHeight: fallbackReferenceFrame.referenceHeight,
      durationMs,
    };
  }

  const plan = buildScrollGesturePlan({
    direction: contentDirection,
    amount: amountValue,
    pixels: pixelValue,
    referenceWidth: fallbackReferenceFrame.referenceWidth,
    referenceHeight: fallbackReferenceFrame.referenceHeight,
  });

  return {
    ...merged,
    x1: plan.x1,
    y1: plan.y1,
    x2: plan.x2,
    y2: plan.y2,
    contentDirection,
    ...(amountValue !== undefined ? { amount: amountValue } : {}),
    ...(plan.pixels !== undefined ? { pixels: plan.pixels } : {}),
    referenceWidth: fallbackReferenceFrame.referenceWidth,
    referenceHeight: fallbackReferenceFrame.referenceHeight,
    durationMs,
  };
}

function buildGestureEvents(
  command: string,
  positionals: string[],
  result: Record<string, unknown>,
  tMs: number,
  gestureDurationMs: number,
  referenceFrame?: ReferenceFrame,
): RecordingGestureEvent[] {
  const builder = gestureEventBuilders[command];
  return builder?.(positionals, result, tMs, gestureDurationMs, referenceFrame) ?? [];
}

type GestureEventBuilder = (
  positionals: string[],
  result: Record<string, unknown>,
  tMs: number,
  gestureDurationMs: number,
  referenceFrame?: ReferenceFrame,
) => RecordingGestureEvent[];

const gestureEventBuilders: Record<string, GestureEventBuilder> = {
  click: (positionals, result, tMs, _durationMs, referenceFrame) =>
    buildPressEvents(positionals, result, tMs, referenceFrame),
  press: (positionals, result, tMs, _durationMs, referenceFrame) =>
    buildPressEvents(positionals, result, tMs, referenceFrame),
  'react-native': (positionals, result, tMs, _durationMs, referenceFrame) =>
    positionals[0] === 'dismiss-overlay'
      ? buildPressEvents(positionals, result, tMs, referenceFrame)
      : [],
  fill: (positionals, result, tMs, _durationMs, referenceFrame) =>
    buildFocusEvents(positionals, result, tMs, referenceFrame),
  focus: (positionals, result, tMs, _durationMs, referenceFrame) =>
    buildFocusEvents(positionals, result, tMs, referenceFrame),
  longpress: buildLongPressEvents,
  scroll: buildScrollEvents,
  gesture: buildCanonicalGestureEvents,
  swipe: buildSwipeEvents,
};

function shouldAnchorTapVisualizationNearCompletion(
  command: string,
  result: Record<string, unknown>,
): boolean {
  switch (command) {
    case 'click':
    case 'fill':
    case 'focus':
      return true;
    case 'press': {
      const count = clampInt(readRecordingNumber(result.count), 1) ?? 1;
      const doubleTap = result.doubleTap === true;
      const holdMs = clampInt(readRecordingNumber(result.holdMs), 1);
      return count === 1 && !doubleTap && holdMs === undefined;
    }
    case 'react-native':
      return result.action === 'dismiss-overlay';
    default:
      return false;
  }
}

function buildPressEvents(
  positionals: string[],
  result: Record<string, unknown>,
  tMs: number,
  referenceFrame?: ReferenceFrame,
): RecordingGestureEvent[] {
  const coordinates = readCoordinates(result, positionals);
  if (!coordinates) return [];
  const { x, y } = coordinates;

  const count = clampInt(readRecordingNumber(result.count), 1) ?? 1;
  const intervalMs = clampInt(readRecordingNumber(result.intervalMs), 0) ?? 0;
  const doubleTap = result.doubleTap === true;
  const holdMs = clampInt(readRecordingNumber(result.holdMs), 1);
  const events: RecordingGestureEvent[] = [];

  for (let index = 0; index < count; index += 1) {
    const baseTime = tMs + index * intervalMs;
    if (holdMs !== undefined && holdMs > 0) {
      events.push(makeLongPressEvent(baseTime, x, y, holdMs, referenceFrame));
      continue;
    }
    events.push(makeTapEvent(baseTime, x, y, referenceFrame));
    if (doubleTap) {
      events.push(makeTapEvent(baseTime + DEFAULT_TAP_GAP_MS, x, y, referenceFrame));
    }
  }
  return events;
}

function buildFocusEvents(
  positionals: string[],
  result: Record<string, unknown>,
  tMs: number,
  referenceFrame?: ReferenceFrame,
): RecordingGestureEvent[] {
  const coordinates = readCoordinates(result, positionals);
  if (!coordinates) return [];
  const { x, y } = coordinates;
  return [makeTapEvent(tMs, x, y, referenceFrame)];
}

function buildLongPressEvents(
  positionals: string[],
  result: Record<string, unknown>,
  tMs: number,
  gestureDurationMs: number,
  referenceFrame?: ReferenceFrame,
): RecordingGestureEvent[] {
  const coordinates = readCoordinates(result, positionals);
  if (!coordinates) return [];
  const { x, y } = coordinates;
  const durationMs = resolveRecordingDurationMs(
    gestureDurationMs,
    [readRecordingNumber(result.durationMs), readRecordingNumber(positionals[2])],
    800,
  );
  return [makeLongPressEvent(tMs, x, y, durationMs, referenceFrame)];
}

function buildSwipeEvents(
  positionals: string[],
  result: Record<string, unknown>,
  tMs: number,
  gestureDurationMs: number,
  referenceFrame?: ReferenceFrame,
): RecordingGestureEvent[] {
  const coordinates = readTravelCoordinates(result, positionals);
  if (!coordinates) return [];
  const { x1, y1, x2, y2 } = coordinates;

  const durationMs = resolveRecordingDurationMs(
    gestureDurationMs,
    [
      readRecordingNumber(result.effectiveDurationMs),
      readRecordingNumber(result.durationMs),
      readRecordingNumber(positionals[4]),
    ],
    DEFAULT_SWIPE_DURATION_MS,
  );
  const count = clampInt(readRecordingNumber(result.count), 1) ?? 1;
  const pauseMs = clampInt(readRecordingNumber(result.pauseMs), 0) ?? 0;
  const pattern = result.pattern === 'ping-pong' ? 'ping-pong' : 'one-way';
  return Array.from({ length: count }, (_, index) => {
    const { startX, startY, endX, endY } = resolveSwipePathForIndex(index, pattern, x1, y1, x2, y2);
    const startTime = tMs + index * (durationMs + pauseMs);
    return buildSwipeTravelEvent(startTime, startX, startY, endX, endY, durationMs, {
      referenceFrame,
    });
  });
}

function resolveSwipePathForIndex(
  index: number,
  pattern: SwipePattern,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): { startX: number; startY: number; endX: number; endY: number } {
  const reverse = pattern === 'ping-pong' && index % 2 === 1;
  return reverse
    ? { startX: x2, startY: y2, endX: x1, endY: y1 }
    : { startX: x1, startY: y1, endX: x2, endY: y2 };
}

function buildScrollEvents(
  positionals: string[],
  result: Record<string, unknown>,
  tMs: number,
  gestureDurationMs: number,
  referenceFrame?: ReferenceFrame,
): RecordingGestureEvent[] {
  const coordinates = readTravelCoordinates(result, positionals);
  const contentDirection =
    readDirection(result.contentDirection) ?? readDirection(result.direction);
  if (!coordinates || !contentDirection) {
    return [];
  }
  const { x1, y1, x2, y2 } = coordinates;

  const durationMs = resolveRecordingDurationMs(gestureDurationMs, [], DEFAULT_SWIPE_DURATION_MS);
  const amount = readRecordingNumber(result.amount) ?? readRecordingNumber(positionals[1]);
  const pixels = readRecordingNumber(result.pixels);
  return [
    {
      kind: 'scroll',
      tMs,
      x: x1,
      y: y1,
      x2,
      y2,
      ...referenceFrame,
      durationMs,
      contentDirection,
      ...(amount !== undefined ? { amount } : {}),
      ...(pixels !== undefined ? { pixels } : {}),
    },
  ];
}

function makeTapEvent(
  tMs: number,
  x: number,
  y: number,
  referenceFrame?: ReferenceFrame,
): RecordingGestureEvent {
  return { kind: 'tap', tMs, x, y, ...referenceFrame };
}

function makeLongPressEvent(
  tMs: number,
  x: number,
  y: number,
  durationMs: number,
  referenceFrame?: ReferenceFrame,
): RecordingGestureEvent {
  return { kind: 'longpress', tMs, x, y, ...referenceFrame, durationMs };
}

function resolveEventReferenceFrame(
  snapshot: SnapshotState | undefined,
  result: Record<string, unknown>,
): ReferenceFrame | undefined {
  const referenceWidth = readRecordingNumber(result.referenceWidth);
  const referenceHeight = readRecordingNumber(result.referenceHeight);
  if (
    referenceWidth !== undefined &&
    referenceWidth > 0 &&
    referenceHeight !== undefined &&
    referenceHeight > 0
  ) {
    return { referenceWidth, referenceHeight };
  }

  return getSnapshotReferenceFrame(snapshot);
}

function readDirection(value: unknown): ScrollDirection | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case 'up':
    case 'down':
    case 'left':
    case 'right':
      return normalized as ScrollDirection;
    default:
      return undefined;
  }
}

function clampInt(value: number | undefined, min: number): number | undefined {
  if (value === undefined) return undefined;
  const normalized = Math.floor(value);
  return normalized >= min ? normalized : undefined;
}

function readCoordinates(
  result: Record<string, unknown>,
  positionals: string[],
  positionalOffset = 0,
): { x: number; y: number } | undefined {
  const x = readRecordingNumber(result.x) ?? readRecordingNumber(positionals[positionalOffset]);
  const y = readRecordingNumber(result.y) ?? readRecordingNumber(positionals[positionalOffset + 1]);
  if (x === undefined || y === undefined) {
    return undefined;
  }
  return { x, y };
}

function readTravelCoordinates(
  result: Record<string, unknown>,
  positionals: string[],
): { x1: number; y1: number; x2: number; y2: number } | undefined {
  const x1 = readFirstNumber(result.x1, result.x, positionals[0]);
  const y1 = readFirstNumber(result.y1, result.y, positionals[1]);
  const x2 = readFirstNumber(result.x2, positionals[2]);
  const y2 = readFirstNumber(result.y2, positionals[3]);
  if (x1 === undefined || y1 === undefined || x2 === undefined || y2 === undefined) {
    return undefined;
  }
  return { x1, y1, x2, y2 };
}

function readFirstNumber(...values: unknown[]): number | undefined {
  return values.map(readRecordingNumber).find((value) => value !== undefined);
}
