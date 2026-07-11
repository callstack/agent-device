import { AppError } from '../kernel/errors.ts';
import type { PublicPlatform } from '../kernel/device.ts';
import type { Point, Rect } from '../kernel/snapshot.ts';
import type { ScrollDirection } from './scroll-gesture.ts';
import type {
  GesturePlan,
  GestureSemanticInput,
  MultiTouchGesturePlan,
  PointerTrajectory,
  SinglePointerGesturePlan,
} from './gesture-plan-types.ts';

export * from './gesture-plan-types.ts';

export const GESTURE_SAMPLE_INTERVAL_MS = 16;
export const GESTURE_INITIAL_ANGLE_DEGREES = -90;

const GESTURE_INITIAL_SPAN_RATIO = 0.25;
const GESTURE_PINCH_INITIAL_SPAN_RATIO = 0.4;
const GESTURE_HORIZONTAL_ANGLE_DEGREES = 0;
const GESTURE_MINIMUM_RELIABLE_SPAN_PX = 48;
const GESTURE_VIEWPORT_INSET_PX = 1;
const DEFAULT_PAN_DURATION_MS = 500;
const FLING_DURATION_MS = 100;
const DEFAULT_MULTI_TOUCH_DURATION_MS = 300;
const MAX_ROTATION_DEGREES_PER_SAMPLE = 3;
const MAX_ROTATION_DEFAULT_DURATION_MS = 2_400;

/** Plans one physical gesture. Public aliases must be normalized before this boundary. */
export function buildGesturePlan(
  input: GestureSemanticInput,
  viewport: Rect,
  platform?: PublicPlatform,
): GesturePlan {
  const frame = normalizeViewport(viewport);
  switch (input.intent) {
    case 'fling':
      return buildFlingPlan(input, frame, platform);
    case 'pan':
      return buildPanPlan(input, frame, platform);
    case 'pinch':
      return buildTransformPlan(
        {
          intent: 'pinch',
          origin: input.origin ?? centerOfViewport(frame),
          delta: { x: 0, y: 0 },
          scale: normalizeScale(input.scale, 'gesture pinch scale'),
          rotationDegrees: 0,
          durationMs: DEFAULT_MULTI_TOUCH_DURATION_MS,
        },
        frame,
        platform,
      );
    case 'rotate': {
      const rotationDegrees = finiteNumber(input.degrees, 'gesture rotate degrees');
      return buildTransformPlan(
        {
          intent: 'rotate',
          origin: input.origin ?? centerOfViewport(frame),
          delta: { x: 0, y: 0 },
          scale: 1,
          rotationDegrees,
          durationMs: defaultTransformDuration(rotationDegrees),
        },
        frame,
        platform,
      );
    }
    case 'transform': {
      const rotationDegrees = finiteNumber(input.degrees, 'gesture transform degrees');
      return buildTransformPlan(
        {
          intent: 'transform',
          origin: input.origin,
          delta: input.delta,
          scale: normalizeScale(input.scale, 'gesture transform scale'),
          rotationDegrees,
          durationMs: normalizeDuration(
            input.durationMs,
            defaultTransformDuration(rotationDegrees),
            'gesture transform durationMs',
          ),
        },
        frame,
        platform,
      );
    }
  }
}

export function singlePointerPlanEndpoints(plan: SinglePointerGesturePlan): {
  start: Point;
  end: Point;
} {
  const start = plan.pointers[0].samples[0]?.point;
  const end = plan.pointers[0].samples.at(-1)?.point;
  if (!start || !end) {
    throw new AppError('INVALID_ARGS', 'single-pointer gesture plan requires samples');
  }
  return { start, end };
}

function buildFlingPlan(
  input: Extract<GestureSemanticInput, { intent: 'fling' }>,
  viewport: Rect,
  platform?: PublicPlatform,
): SinglePointerGesturePlan {
  if ('from' in input) {
    return buildSinglePointerPlan(
      'fling',
      input.from,
      input.to,
      FLING_DURATION_MS,
      viewport,
      platform,
    );
  }
  const start = finitePoint(input.origin, 'gesture fling origin');
  const distance = positiveNumber(input.distance ?? 180, 'gesture fling distance');
  return buildSinglePointerPlan(
    'fling',
    start,
    offsetPointByDirection(start, input.direction, distance),
    FLING_DURATION_MS,
    viewport,
    platform,
  );
}

function buildPanPlan(
  input: Extract<GestureSemanticInput, { intent: 'pan' }>,
  viewport: Rect,
  platform?: PublicPlatform,
): GesturePlan {
  const durationMs = normalizeDuration(
    input.durationMs,
    DEFAULT_PAN_DURATION_MS,
    'gesture pan durationMs',
  );
  if ((input.pointerCount ?? 1) === 1) {
    const start = finitePoint(input.origin, 'gesture pan origin');
    const delta = finitePoint(input.delta, 'gesture pan delta');
    return buildSinglePointerPlan(
      'pan',
      start,
      addPoints(start, delta),
      durationMs,
      viewport,
      platform,
    );
  }
  if (input.pointerCount !== 2) {
    throw new AppError('INVALID_ARGS', 'gesture pan pointerCount must be 1 or 2');
  }
  return buildTransformPlan(
    {
      intent: 'pan',
      origin: input.origin,
      delta: input.delta,
      scale: 1,
      rotationDegrees: 0,
      durationMs,
    },
    viewport,
    platform,
  );
}

function buildSinglePointerPlan(
  intent: SinglePointerGesturePlan['intent'],
  from: Point,
  to: Point,
  durationMs: number,
  viewport: Rect,
  platform?: PublicPlatform,
): SinglePointerGesturePlan {
  const start = finitePoint(from, `gesture ${intent} start`);
  const end = finitePoint(to, `gesture ${intent} end`);
  const samples = sampleOffsets(durationMs, platform).map((offsetMs) => ({
    offsetMs,
    point: interpolatePoint(start, end, offsetMs / durationMs),
  }));
  assertSamplesInViewport(samples, viewport, { intent, pointerId: 0 });
  return {
    topology: 'single',
    intent,
    durationMs,
    viewport,
    pointers: [{ pointerId: 0, samples }],
  };
}

function buildTransformPlan(
  motion: {
    intent: MultiTouchGesturePlan['intent'];
    origin: Point;
    delta: Point;
    scale: number;
    rotationDegrees: number;
    durationMs: number;
  },
  viewport: Rect,
  platform?: PublicPlatform,
): MultiTouchGesturePlan {
  const start = finitePoint(motion.origin, `gesture ${motion.intent} origin`);
  const delta = finitePoint(motion.delta, `gesture ${motion.intent} delta`);
  const end = addPoints(start, delta);
  const maximumSpan =
    Math.min(viewport.width, viewport.height) * initialSpanRatioForIntent(motion.intent);
  const initialSpan = motion.scale > 1 ? maximumSpan / motion.scale : maximumSpan;
  const finalSpan = initialSpan * motion.scale;
  if (Math.min(initialSpan, finalSpan) < GESTURE_MINIMUM_RELIABLE_SPAN_PX) {
    throw trajectoryOutOfBounds({
      intent: motion.intent,
      viewport,
      initialSpan,
      finalSpan,
      minimumReliableSpan: GESTURE_MINIMUM_RELIABLE_SPAN_PX,
    });
  }
  const initialRadius = initialSpan / 2;

  const offsets = sampleOffsets(motion.durationMs, platform);
  const trajectory = (pointerId: 0 | 1, side: 1 | -1): PointerTrajectory => {
    const samples = offsets.map((offsetMs) => ({
      offsetMs,
      point: transformPointAt({
        ...motion,
        start,
        end,
        initialRadius,
        offsetMs,
        side,
        platform,
      }),
    }));
    assertSamplesInViewport(samples, viewport, { intent: motion.intent, pointerId });
    return { pointerId, samples };
  };

  return {
    topology: 'two',
    intent: motion.intent,
    durationMs: motion.durationMs,
    viewport,
    pointers: [trajectory(0, 1), trajectory(1, -1)],
  };
}

function transformPointAt(options: {
  intent: MultiTouchGesturePlan['intent'];
  start: Point;
  end: Point;
  initialRadius: number;
  scale: number;
  rotationDegrees: number;
  durationMs: number;
  offsetMs: number;
  side: 1 | -1;
  platform?: PublicPlatform;
}): Point {
  const progress = options.offsetMs / options.durationMs;
  const centroid = interpolatePoint(options.start, options.end, progress);
  const radius = options.initialRadius * (1 + (options.scale - 1) * progress);
  const angle = degreesToRadians(
    initialAngleForIntent(options.intent, options.platform) + options.rotationDegrees * progress,
  );
  return {
    x: centroid.x + Math.cos(angle) * radius * options.side,
    y: centroid.y + Math.sin(angle) * radius * options.side,
  };
}

function initialAngleForIntent(
  intent: MultiTouchGesturePlan['intent'],
  platform: PublicPlatform | undefined,
): number {
  return intent === 'pinch' && platform === 'android'
    ? GESTURE_HORIZONTAL_ANGLE_DEGREES
    : GESTURE_INITIAL_ANGLE_DEGREES;
}

function initialSpanRatioForIntent(intent: MultiTouchGesturePlan['intent']): number {
  return intent === 'pinch' ? GESTURE_PINCH_INITIAL_SPAN_RATIO : GESTURE_INITIAL_SPAN_RATIO;
}

function sampleOffsets(durationMs: number, platform?: PublicPlatform): number[] {
  const rawFrameCount = durationMs / GESTURE_SAMPLE_INTERVAL_MS;
  const frameCount = Math.max(
    3,
    platform === 'android' ? Math.round(rawFrameCount) : Math.floor(rawFrameCount),
  );
  return Array.from({ length: frameCount + 1 }, (_, index) =>
    Math.round((durationMs * index) / frameCount),
  );
}

function assertSamplesInViewport(
  samples: readonly { offsetMs: number; point: Point }[],
  viewport: Rect,
  details: Record<string, unknown>,
): void {
  const maxX = viewport.x + viewport.width - GESTURE_VIEWPORT_INSET_PX;
  const maxY = viewport.y + viewport.height - GESTURE_VIEWPORT_INSET_PX;
  for (const sample of samples) {
    const { x, y } = sample.point;
    if (
      x < viewport.x + GESTURE_VIEWPORT_INSET_PX ||
      x > maxX ||
      y < viewport.y + GESTURE_VIEWPORT_INSET_PX ||
      y > maxY
    ) {
      throw trajectoryOutOfBounds({ ...details, viewport, sample });
    }
  }
}

function trajectoryOutOfBounds(details: Record<string, unknown>): AppError {
  return new AppError('INVALID_ARGS', 'Gesture trajectory does not fit inside the viewport', {
    ...details,
    reason: 'GESTURE_TRAJECTORY_OUT_OF_BOUNDS',
    hint: 'Move the gesture away from the edge or reduce its translation, scale, or rotation.',
  });
}

function normalizeViewport(viewport: Rect): Rect {
  const frame = {
    x: finiteNumber(viewport.x, 'gesture viewport x'),
    y: finiteNumber(viewport.y, 'gesture viewport y'),
    width: finiteNumber(viewport.width, 'gesture viewport width'),
    height: finiteNumber(viewport.height, 'gesture viewport height'),
  };
  if (frame.width <= 0 || frame.height <= 0) {
    throw new AppError('INVALID_ARGS', 'gesture viewport width and height must be positive');
  }
  return frame;
}

function normalizeDuration(value: number | undefined, fallback: number, field: string): number {
  const durationMs = value ?? fallback;
  if (!Number.isInteger(durationMs) || durationMs < 16 || durationMs > 10_000) {
    throw new AppError('INVALID_ARGS', `${field} must be an integer between 16 and 10000`);
  }
  return durationMs;
}

function defaultTransformDuration(rotationDegrees: number): number {
  const rotationDuration =
    Math.ceil(Math.abs(rotationDegrees) / MAX_ROTATION_DEGREES_PER_SAMPLE) *
    GESTURE_SAMPLE_INTERVAL_MS;
  return Math.min(
    Math.max(DEFAULT_MULTI_TOUCH_DURATION_MS, rotationDuration),
    MAX_ROTATION_DEFAULT_DURATION_MS,
  );
}

function finitePoint(point: Point, field: string): Point {
  return {
    x: finiteNumber(point.x, `${field} x`),
    y: finiteNumber(point.y, `${field} y`),
  };
}

function finiteNumber(value: number, field: string): number {
  if (!Number.isFinite(value)) {
    throw new AppError('INVALID_ARGS', `${field} must be a finite number`);
  }
  return value;
}

function normalizeScale(value: number, field: string): number {
  const scale = finiteNumber(value, field);
  if (scale <= 0) throw new AppError('INVALID_ARGS', `${field} must be greater than 0`);
  return scale;
}

function positiveNumber(value: number, field: string): number {
  const number = finiteNumber(value, field);
  if (number <= 0) throw new AppError('INVALID_ARGS', `${field} must be a positive number`);
  return number;
}

function centerOfViewport(viewport: Rect): Point {
  return { x: viewport.x + viewport.width / 2, y: viewport.y + viewport.height / 2 };
}

function addPoints(left: Point, right: Point): Point {
  return { x: left.x + right.x, y: left.y + right.y };
}

function interpolatePoint(start: Point, end: Point, progress: number): Point {
  return {
    x: start.x + (end.x - start.x) * progress,
    y: start.y + (end.y - start.y) * progress,
  };
}

function offsetPointByDirection(
  origin: Point,
  direction: ScrollDirection,
  distance: number,
): Point {
  switch (direction) {
    case 'up':
      return { x: origin.x, y: origin.y - distance };
    case 'down':
      return { x: origin.x, y: origin.y + distance };
    case 'left':
      return { x: origin.x - distance, y: origin.y };
    case 'right':
      return { x: origin.x + distance, y: origin.y };
  }
}

function degreesToRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}
