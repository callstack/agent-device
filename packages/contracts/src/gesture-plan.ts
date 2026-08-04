import { AppError } from '@agent-device/kernel/errors';
import type { PublicPlatform } from '@agent-device/kernel/device';
import type { Point, Rect } from '@agent-device/kernel/snapshot';
import {
  buildSwipePresetGesturePlan,
  gestureDirectionDelta,
  type SwipePreset,
} from './scroll-gesture.ts';
import {
  DEFAULT_DRAG_DESTINATION_HOLD_MS,
  DEFAULT_DRAG_MOVE_MS,
  DEFAULT_DRAG_SOURCE_HOLD_MS,
  GESTURE_DURATION_MAX_MS,
  GESTURE_DURATION_MIN_MS,
} from './gesture-plan-types.ts';
import type {
  GesturePlan,
  GestureExecutionProfile,
  GestureSemanticInput,
  MultiTouchGesturePlan,
  PointerTrajectory,
  SinglePointerGesturePlan,
  SinglePointerTrajectory,
} from './gesture-plan-types.ts';

export * from './gesture-plan-types.ts';

export const GESTURE_SAMPLE_INTERVAL_MS = 16;
export const GESTURE_INITIAL_ANGLE_DEGREES = -90;
const GESTURE_FLING_DEFAULT_DISTANCE = 180;

const GESTURE_INITIAL_SPAN_RATIO = 0.25;
const GESTURE_PINCH_INITIAL_SPAN_RATIO = 0.4;
const GESTURE_HORIZONTAL_ANGLE_DEGREES = 0;
const GESTURE_MINIMUM_RELIABLE_SPAN_PX = 48;
const GESTURE_VIEWPORT_INSET_PX = 1;
const DEFAULT_PAN_DURATION_MS = 500;
export const GESTURE_FLING_DURATION_MS = 100;
const DEFAULT_MULTI_TOUCH_DURATION_MS = 300;
const MAX_ROTATION_DEGREES_PER_SAMPLE = 3;
const MAX_ROTATION_DEFAULT_DURATION_MS = 2_400;

export type GestureSamplingProfile = 'default' | 'android';

type GesturePlatformProfile = {
  pinchAxisDegrees: number;
  samplingProfile: GestureSamplingProfile;
};

const DEFAULT_GESTURE_PLATFORM_PROFILE: GesturePlatformProfile = {
  pinchAxisDegrees: GESTURE_INITIAL_ANGLE_DEGREES,
  samplingProfile: 'default',
};
const GESTURE_PLATFORM_PROFILES = {
  ios: DEFAULT_GESTURE_PLATFORM_PROFILE,
  macos: DEFAULT_GESTURE_PLATFORM_PROFILE,
  android: {
    pinchAxisDegrees: GESTURE_HORIZONTAL_ANGLE_DEGREES,
    samplingProfile: 'android',
  },
  vega: DEFAULT_GESTURE_PLATFORM_PROFILE,
  linux: DEFAULT_GESTURE_PLATFORM_PROFILE,
  web: DEFAULT_GESTURE_PLATFORM_PROFILE,
} satisfies Record<PublicPlatform, GesturePlatformProfile>;

/** Plans one physical gesture. Public aliases must be normalized before this boundary. */
export function buildGesturePlan(
  input: GestureSemanticInput,
  viewport: Rect,
  platform?: PublicPlatform,
): GesturePlan {
  const frame = normalizeViewport(viewport);
  const profile = gesturePlatformProfile(platform);
  switch (input.intent) {
    case 'fling':
      return buildFlingPlan(input, frame);
    case 'pan':
      return buildPanPlan(input, frame, profile);
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
        profile,
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
        profile,
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
        profile,
      );
    }
  }
}

export function singlePointerPlanEndpoints(plan: SinglePointerGesturePlan): {
  start: Point;
  end: Point;
} {
  const [{ samples }] = plan.pointers;
  const start = samples[0];
  const end = samples.at(-1)!;
  return { start: start.point, end: end.point };
}

/**
 * Plans one uninterrupted pointer contact: activate at the source, move to the
 * destination, optionally hold there, then release. Element targets are
 * resolved by the interaction runtime before this portable planning seam.
 */
export function buildDragGesturePlan(
  input: {
    from: Point;
    to: Point;
    sourceHoldMs?: number;
    moveMs?: number;
    destinationHoldMs?: number;
  },
  viewport: Rect,
): SinglePointerGesturePlan {
  const frame = normalizeViewport(viewport);
  const sourceHoldMs = normalizePositiveDuration(
    input.sourceHoldMs,
    DEFAULT_DRAG_SOURCE_HOLD_MS,
    'gesture drag sourceHoldMs',
  );
  const moveMs = normalizeDuration(input.moveMs, DEFAULT_DRAG_MOVE_MS, 'gesture drag moveMs');
  const destinationHoldMs = normalizeNonNegativeDuration(
    input.destinationHoldMs,
    DEFAULT_DRAG_DESTINATION_HOLD_MS,
    'gesture drag destinationHoldMs',
  );
  const durationMs = sourceHoldMs + moveMs + destinationHoldMs;
  if (durationMs > GESTURE_DURATION_MAX_MS) {
    throw new AppError(
      'INVALID_ARGS',
      `gesture drag total duration must be at most ${GESTURE_DURATION_MAX_MS}`,
    );
  }
  const move = buildSinglePointerPlan('pan', input.from, input.to, moveMs, frame, 'timed-pan');
  return withContactHolds(move, sourceHoldMs, destinationHoldMs);
}

function withContactHolds(
  plan: SinglePointerGesturePlan,
  sourceHoldMs: number,
  destinationHoldMs: number,
): SinglePointerGesturePlan {
  const pointer = plan.pointers[0];
  const [moveStart, moveEnd] = pointer.samples;
  const durationMs = sourceHoldMs + plan.durationMs + destinationHoldMs;
  const samples: SinglePointerTrajectory['samples'] = [
    { offsetMs: 0, point: moveStart.point },
    { ...moveStart, offsetMs: moveStart.offsetMs + sourceHoldMs },
    { ...moveEnd, offsetMs: moveEnd.offsetMs + sourceHoldMs },
    ...(destinationHoldMs > 0 ? [{ offsetMs: durationMs, point: moveEnd.point }] : []),
  ];
  return {
    ...plan,
    durationMs,
    pointers: [
      {
        ...pointer,
        samples,
      },
    ],
  };
}

function buildFlingPlan(
  input: Extract<GestureSemanticInput, { intent: 'fling' }>,
  viewport: Rect,
): SinglePointerGesturePlan {
  if ('preset' in input) {
    const { from, to } = presetGestureEndpoints(input.preset, viewport);
    return buildSinglePointerPlan(
      'fling',
      from,
      to,
      GESTURE_FLING_DURATION_MS,
      viewport,
      'endpoint-hold',
    );
  }
  if ('from' in input) {
    return buildSinglePointerPlan(
      'fling',
      input.from,
      input.to,
      GESTURE_FLING_DURATION_MS,
      viewport,
      'endpoint-hold',
    );
  }
  const start = finitePoint(input.origin, 'gesture fling origin');
  const distance = positiveNumber(
    input.distance ?? GESTURE_FLING_DEFAULT_DISTANCE,
    'gesture fling distance',
  );
  return buildSinglePointerPlan(
    'fling',
    start,
    addPoints(start, gestureDirectionDelta(input.direction, distance)),
    GESTURE_FLING_DURATION_MS,
    viewport,
    'endpoint-hold',
  );
}

function buildPanPlan(
  input: Extract<GestureSemanticInput, { intent: 'pan' }>,
  viewport: Rect,
  profile: GesturePlatformProfile,
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
      input.executionProfile ?? 'timed-pan',
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
    profile,
  );
}

function buildSinglePointerPlan(
  intent: SinglePointerGesturePlan['intent'],
  from: Point,
  to: Point,
  durationMs: number,
  viewport: Rect,
  executionProfile: GestureExecutionProfile,
): SinglePointerGesturePlan {
  const start = finitePoint(from, `gesture ${intent} start`);
  const end = finitePoint(to, `gesture ${intent} end`);
  const samples: SinglePointerTrajectory['samples'] = [
    { offsetMs: 0, point: start },
    { offsetMs: durationMs, point: end },
  ];
  assertSamplesInViewport(samples, viewport, { intent, pointerId: 0 });
  return {
    topology: 'single',
    intent,
    executionProfile,
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
  profile: GesturePlatformProfile,
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

  const offsets = sampleGestureOffsets(motion.durationMs, profile.samplingProfile);
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
        profile,
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
  profile: GesturePlatformProfile;
}): Point {
  const progress = options.offsetMs / options.durationMs;
  const centroid = interpolateGesturePoint(options.start, options.end, progress);
  const radius = options.initialRadius * (1 + (options.scale - 1) * progress);
  const angle = degreesToRadians(
    initialAngleForIntent(options.intent, options.profile) + options.rotationDegrees * progress,
  );
  return {
    x: centroid.x + Math.cos(angle) * radius * options.side,
    y: centroid.y + Math.sin(angle) * radius * options.side,
  };
}

function initialAngleForIntent(
  intent: MultiTouchGesturePlan['intent'],
  profile: GesturePlatformProfile,
): number {
  return intent === 'pinch' ? profile.pinchAxisDegrees : GESTURE_INITIAL_ANGLE_DEGREES;
}

function initialSpanRatioForIntent(intent: MultiTouchGesturePlan['intent']): number {
  return intent === 'pinch' ? GESTURE_PINCH_INITIAL_SPAN_RATIO : GESTURE_INITIAL_SPAN_RATIO;
}

/** The floor of three frames is what lets transport lowering claim a denser-than-endpoints path. */
export function sampleGestureOffsets(
  durationMs: number,
  profile: GestureSamplingProfile,
): number[] {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new AppError('INVALID_ARGS', 'gesture sample duration must be a positive finite number');
  }
  const rawFrameCount = durationMs / GESTURE_SAMPLE_INTERVAL_MS;
  const frameCount = Math.max(
    3,
    profile === 'android' ? Math.round(rawFrameCount) : Math.floor(rawFrameCount),
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
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new AppError('INVALID_ARGS', 'Gesture motion produces non-finite pointer coordinates', {
        ...details,
        reason: 'GESTURE_TRAJECTORY_NON_FINITE',
        hint: 'Reduce the requested rotation, translation, or scale.',
      });
    }
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
  if (
    !Number.isInteger(durationMs) ||
    durationMs < GESTURE_DURATION_MIN_MS ||
    durationMs > GESTURE_DURATION_MAX_MS
  ) {
    throw new AppError(
      'INVALID_ARGS',
      `${field} must be an integer between ${GESTURE_DURATION_MIN_MS} and ${GESTURE_DURATION_MAX_MS}`,
    );
  }
  return durationMs;
}

function normalizePositiveDuration(value: number | undefined, fallback: number, field: string) {
  const durationMs = value ?? fallback;
  if (!Number.isInteger(durationMs) || durationMs < 1 || durationMs > GESTURE_DURATION_MAX_MS) {
    throw new AppError(
      'INVALID_ARGS',
      `${field} must be an integer between 1 and ${GESTURE_DURATION_MAX_MS}`,
    );
  }
  return durationMs;
}

function normalizeNonNegativeDuration(value: number | undefined, fallback: number, field: string) {
  const durationMs = value ?? fallback;
  if (!Number.isInteger(durationMs) || durationMs < 0 || durationMs > GESTURE_DURATION_MAX_MS) {
    throw new AppError(
      'INVALID_ARGS',
      `${field} must be an integer between 0 and ${GESTURE_DURATION_MAX_MS}`,
    );
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

export function interpolateGesturePoint(start: Point, end: Point, progress: number): Point {
  return {
    x: start.x + (end.x - start.x) * progress,
    y: start.y + (end.y - start.y) * progress,
  };
}

function presetGestureEndpoints(preset: SwipePreset, viewport: Rect): { from: Point; to: Point } {
  const relative = buildSwipePresetGesturePlan(preset, {
    referenceWidth: viewport.width,
    referenceHeight: viewport.height,
  });
  return {
    from: { x: viewport.x + relative.x1, y: viewport.y + relative.y1 },
    to: { x: viewport.x + relative.x2, y: viewport.y + relative.y2 },
  };
}

function gesturePlatformProfile(platform: PublicPlatform | undefined): GesturePlatformProfile {
  return platform === undefined
    ? DEFAULT_GESTURE_PLATFORM_PROFILE
    : GESTURE_PLATFORM_PROFILES[platform];
}

function degreesToRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}
