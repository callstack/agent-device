import type { RecordingGestureEvent } from './types.ts';
import type { TouchReferenceFrame as ReferenceFrame } from './touch-reference-frame.ts';
import { readRecordingNumber, resolveRecordingDurationMs } from './recording-values.ts';

const DEFAULT_GESTURE_TRAVEL_DURATION_MS = 250;
const DEFAULT_PINCH_DURATION_MS = 280;

type SwipeTravelEventOptions = {
  referenceFrame?: ReferenceFrame;
  classifyBackSwipe?: boolean;
};

export function buildCanonicalGestureEvents(
  positionals: string[],
  result: Record<string, unknown>,
  tMs: number,
  gestureDurationMs: number,
  referenceFrame?: ReferenceFrame,
): RecordingGestureEvent[] {
  switch (result.kind) {
    case 'pan':
    case 'fling':
    case 'rotate':
    case 'transform': {
      const from = readPoint(result.from);
      const to = readPoint(result.to);
      if (!from || !to) return [];
      const allowBackSwipeClassification =
        (result.kind === 'pan' || result.kind === 'fling') &&
        readRecordingNumber(result.pointerCount) !== 2;
      return [
        buildSwipeTravelEvent(
          tMs,
          from.x,
          from.y,
          to.x,
          to.y,
          resolveRecordingDurationMs(
            gestureDurationMs,
            [result.durationMs],
            DEFAULT_GESTURE_TRAVEL_DURATION_MS,
          ),
          {
            referenceFrame,
            classifyBackSwipe: allowBackSwipeClassification,
          },
        ),
      ];
    }
    case 'pinch': {
      const center = readPoint(result.from);
      const scale = readRecordingNumber(result.scale) ?? readRecordingNumber(positionals[1]);
      if (!center || scale === undefined || scale <= 0) return [];
      return [
        {
          kind: 'pinch',
          tMs,
          x: center.x,
          y: center.y,
          ...referenceFrame,
          scale,
          durationMs: resolveRecordingDurationMs(
            gestureDurationMs,
            [result.durationMs],
            DEFAULT_PINCH_DURATION_MS,
          ),
        },
      ];
    }
    default:
      return [];
  }
}

export function buildSwipeTravelEvent(
  tMs: number,
  x: number,
  y: number,
  x2: number,
  y2: number,
  durationMs: number,
  options: SwipeTravelEventOptions = {},
): RecordingGestureEvent {
  const { referenceFrame, classifyBackSwipe = true } = options;
  const kind = classifyBackSwipe ? classifySwipeKind(x, y, x2, y2, referenceFrame) : 'swipe';
  if (kind === 'back-swipe') {
    return {
      kind,
      tMs,
      x,
      y,
      x2,
      y2,
      ...referenceFrame,
      durationMs,
      edge: resolveBackSwipeEdge(x, x2, referenceFrame),
    };
  }
  return { kind, tMs, x, y, x2, y2, ...referenceFrame, durationMs };
}

function classifySwipeKind(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  referenceFrame?: ReferenceFrame,
): 'swipe' | 'back-swipe' {
  if (!referenceFrame) return 'swipe';
  const horizontalDistance = Math.abs(x2 - x1);
  const verticalDistance = Math.abs(y2 - y1);
  if (horizontalDistance <= verticalDistance * 1.25) return 'swipe';

  const edgeInset = referenceFrame.referenceWidth * 0.08;
  if (x1 <= edgeInset && x2 > x1) return 'back-swipe';
  if (x1 >= referenceFrame.referenceWidth - edgeInset && x2 < x1) return 'back-swipe';
  return 'swipe';
}

function resolveBackSwipeEdge(
  startX: number,
  endX: number,
  referenceFrame?: ReferenceFrame,
): 'left' | 'right' {
  if (referenceFrame) {
    const edgeInset = referenceFrame.referenceWidth * 0.08;
    if (startX <= edgeInset) return 'left';
    if (startX >= referenceFrame.referenceWidth - edgeInset) return 'right';
  }
  return endX >= startX ? 'left' : 'right';
}

function readPoint(value: unknown): { x: number; y: number } | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const point = value as Record<string, unknown>;
  const x = readRecordingNumber(point.x);
  const y = readRecordingNumber(point.y);
  if (x === undefined || y === undefined) return undefined;
  return { x, y };
}
