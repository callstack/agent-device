import { AppError } from '../kernel/errors.ts';
import type { Point, Rect } from '../kernel/snapshot.ts';
import type { ScrollDirection, SwipePreset } from './scroll-gesture.ts';
import { buildSwipePresetGesturePlan } from './scroll-gesture.ts';
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
// One eighth keeps a useful span on phone-sized viewports while staying close to the
// Android helper's proven historical 160 px radius on a 1344 px-wide emulator.
const GESTURE_PREFERRED_MAX_RADIUS_RATIO = 0.125;
const GESTURE_MINIMUM_RELIABLE_RADIUS_PX = 24;
const GESTURE_VIEWPORT_INSET_PX = 1;

const DEFAULT_SWIPE_DURATION_MS = 300;
const DEFAULT_PAN_DURATION_MS = 500;
const DEFAULT_FLING_DURATION_MS = 50;
const DEFAULT_MULTI_TOUCH_DURATION_MS = 300;
const MAX_ROTATION_DEGREES_PER_SAMPLE = 3;
const MAX_ROTATION_DEFAULT_DURATION_MS = 2_400;

export function buildGesturePlan(input: GestureSemanticInput, viewport?: Rect): GesturePlan {
  switch (input.intent) {
    case 'swipe':
      return buildSwipePlan(input, viewport);
    case 'pan':
      return buildPanPlan(input, viewport);
    case 'fling':
      return buildFlingPlan(input);
    case 'pinch':
      return buildPinchPlan(input, viewport);
    case 'rotate':
      return buildRotatePlan(input, viewport);
    case 'transform':
      return buildTransformPlan(input, viewport);
  }
}

function buildSwipePlan(
  input: Extract<GestureSemanticInput, { intent: 'swipe' }>,
  viewport: Rect | undefined,
): SinglePointerGesturePlan {
  if ('preset' in input) {
    return buildSwipePresetPlan(input, requireViewport(viewport, 'gesture swipe'));
  }
  return buildSinglePointerPlan(
    'swipe',
    input.from,
    input.to,
    normalizeDuration(input.durationMs, DEFAULT_SWIPE_DURATION_MS, 'gesture swipe durationMs'),
  );
}

function buildPanPlan(
  input: Extract<GestureSemanticInput, { intent: 'pan' }>,
  viewport: Rect | undefined,
): GesturePlan {
  const durationMs = normalizeDuration(
    input.durationMs,
    DEFAULT_PAN_DURATION_MS,
    'gesture pan durationMs',
  );
  if (normalizePointerCount(input.pointerCount) === 1) {
    return buildSinglePointerPlan(
      'pan',
      input.origin,
      addPoints(input.origin, input.delta),
      durationMs,
    );
  }
  return buildMultiTouchPlan(
    {
      intent: 'pan',
      origin: input.origin,
      delta: input.delta,
      scale: 1,
      rotationDegrees: 0,
      durationMs,
    },
    requireViewport(viewport, 'two-finger pan'),
  );
}

function buildFlingPlan(
  input: Extract<GestureSemanticInput, { intent: 'fling' }>,
): SinglePointerGesturePlan {
  const start = requireFinitePoint(input.origin, 'gesture fling origin');
  const distance = normalizePositiveNumber(input.distance ?? 180, 'gesture fling distance');
  return buildSinglePointerPlan(
    'fling',
    start,
    offsetPointByDirection(start, input.direction, distance),
    normalizeDuration(input.durationMs, DEFAULT_FLING_DURATION_MS, 'gesture fling durationMs', {
      max: 1_000,
    }),
  );
}

function buildPinchPlan(
  input: Extract<GestureSemanticInput, { intent: 'pinch' }>,
  viewport: Rect | undefined,
): MultiTouchGesturePlan {
  const frame = requireViewport(viewport, 'gesture pinch');
  return buildMultiTouchPlan(
    {
      intent: 'pinch',
      origin: input.origin ?? centerOfViewport(frame),
      delta: { x: 0, y: 0 },
      scale: normalizeScale(input.scale, 'gesture pinch scale'),
      rotationDegrees: 0,
      durationMs: DEFAULT_MULTI_TOUCH_DURATION_MS,
    },
    frame,
  );
}

function buildRotatePlan(
  input: Extract<GestureSemanticInput, { intent: 'rotate' }>,
  viewport: Rect | undefined,
): MultiTouchGesturePlan {
  const frame = requireViewport(viewport, 'gesture rotate');
  const degrees = normalizeFiniteNumber(input.degrees, 'gesture rotate degrees');
  return buildMultiTouchPlan(
    {
      intent: 'rotate',
      origin: input.origin ?? centerOfViewport(frame),
      delta: { x: 0, y: 0 },
      scale: 1,
      rotationDegrees: degrees,
      velocity: normalizeRotateVelocity(input.velocity, degrees),
      durationMs: defaultMultiTouchDuration(degrees),
    },
    frame,
  );
}

function normalizeRotateVelocity(value: number | undefined, degrees: number): number | undefined {
  const velocity = normalizeFiniteNumber(value ?? 1, 'gesture rotate velocity');
  if (velocity === 0) {
    throw new AppError('INVALID_ARGS', 'gesture rotate velocity must be a non-zero number');
  }
  return Math.abs(velocity) * (degrees >= 0 ? 1 : -1);
}

function buildTransformPlan(
  input: Extract<GestureSemanticInput, { intent: 'transform' }>,
  viewport: Rect | undefined,
): MultiTouchGesturePlan {
  const degrees = normalizeFiniteNumber(input.degrees, 'gesture transform degrees');
  return buildMultiTouchPlan(
    {
      intent: 'transform',
      origin: input.origin,
      delta: input.delta,
      scale: normalizeScale(input.scale, 'gesture transform scale'),
      rotationDegrees: degrees,
      durationMs: normalizeDuration(
        input.durationMs,
        defaultMultiTouchDuration(degrees),
        'gesture transform durationMs',
      ),
    },
    requireViewport(viewport, 'gesture transform'),
  );
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

function buildSwipePresetPlan(
  input: Extract<GestureSemanticInput, { intent: 'swipe'; preset: SwipePreset }>,
  viewport: Rect,
): SinglePointerGesturePlan {
  const relative = buildSwipePresetGesturePlan(input.preset, {
    referenceWidth: viewport.width,
    referenceHeight: viewport.height,
  });
  return buildSinglePointerPlan(
    'swipe',
    { x: viewport.x + relative.x1, y: viewport.y + relative.y1 },
    { x: viewport.x + relative.x2, y: viewport.y + relative.y2 },
    normalizeDuration(input.durationMs, DEFAULT_SWIPE_DURATION_MS, 'gesture swipe durationMs'),
  );
}

function buildSinglePointerPlan(
  intent: SinglePointerGesturePlan['intent'],
  from: Point,
  to: Point,
  durationMs: number,
): SinglePointerGesturePlan {
  const start = requireFinitePoint(from, `gesture ${intent} start`);
  const end = requireFinitePoint(to, `gesture ${intent} end`);
  return {
    topology: 'single',
    intent,
    durationMs,
    pointers: [
      {
        pointerId: 0,
        samples: sampleOffsets(durationMs).map((offsetMs) => ({
          offsetMs,
          point: interpolatePoint(start, end, offsetMs / durationMs),
        })),
      },
    ],
  };
}

function buildMultiTouchPlan(
  motion: {
    intent: MultiTouchGesturePlan['intent'];
    origin: Point;
    delta: Point;
    scale: number;
    rotationDegrees: number;
    velocity?: number;
    durationMs: number;
  },
  viewport: Rect,
): MultiTouchGesturePlan {
  const normalizedViewport = normalizeViewport(viewport);
  const start = requireFinitePoint(motion.origin, `gesture ${motion.intent} origin`);
  const delta = requireFinitePoint(motion.delta, `gesture ${motion.intent} delta`);
  const end = addPoints(start, delta);
  const maxScale = Math.max(1, motion.scale);
  const shorterSide = Math.min(normalizedViewport.width, normalizedViewport.height);
  const preferredInitialRadius = (shorterSide * GESTURE_PREFERRED_MAX_RADIUS_RATIO) / maxScale;
  const availableInitialRadius =
    minimumCentroidEdgeMargin(start, end, normalizedViewport) / maxScale;
  const initialRadius = Math.min(preferredInitialRadius, availableInitialRadius);

  if (initialRadius < GESTURE_MINIMUM_RELIABLE_RADIUS_PX) {
    throw outOfBoundsError({
      intent: motion.intent,
      viewport: normalizedViewport,
      start,
      end,
      scale: motion.scale,
      availableInitialSpan: Math.max(0, availableInitialRadius * 2),
    });
  }

  const offsets = sampleOffsets(motion.durationMs);
  const buildTrajectory = (pointerId: 0 | 1, side: 1 | -1): PointerTrajectory => ({
    pointerId,
    samples: offsets.map((offsetMs) => {
      const point = multiTouchPointAt({
        intent: motion.intent,
        start,
        end,
        initialRadius,
        scale: motion.scale,
        rotationDegrees: motion.rotationDegrees,
        offsetMs,
        durationMs: motion.durationMs,
        side,
      });
      assertPointInViewport(point, normalizedViewport, {
        intent: motion.intent,
        pointerId,
        offsetMs,
        start,
        end,
        scale: motion.scale,
      });
      return { offsetMs, point };
    }),
  });
  const trajectories: [PointerTrajectory, PointerTrajectory] = [
    buildTrajectory(0, 1),
    buildTrajectory(1, -1),
  ];

  return {
    topology: 'two',
    intent: motion.intent,
    durationMs: motion.durationMs,
    viewport: normalizedViewport,
    centroid: { start, end },
    scale: motion.scale,
    rotationDegrees: motion.rotationDegrees,
    ...(motion.velocity !== undefined ? { velocity: motion.velocity } : {}),
    initialSpan: initialRadius * 2,
    initialAngleDegrees: GESTURE_INITIAL_ANGLE_DEGREES,
    pointers: trajectories,
  };
}

function multiTouchPointAt(options: {
  intent: MultiTouchGesturePlan['intent'];
  start: Point;
  end: Point;
  initialRadius: number;
  scale: number;
  rotationDegrees: number;
  offsetMs: number;
  durationMs: number;
  side: 1 | -1;
}): Point {
  const progress = options.offsetMs / options.durationMs;
  const componentProgress = multiTouchComponentProgress(options, progress);
  const centroid = interpolatePoint(options.start, options.end, componentProgress.translation);
  const radius = options.initialRadius * (1 + (options.scale - 1) * componentProgress.scale);
  const angle = degreesToRadians(
    GESTURE_INITIAL_ANGLE_DEGREES + options.rotationDegrees * componentProgress.rotation,
  );
  return {
    x: centroid.x + Math.cos(angle) * radius * options.side,
    y: centroid.y + Math.sin(angle) * radius * options.side,
  };
}

function multiTouchComponentProgress(
  options: Pick<
    Parameters<typeof multiTouchPointAt>[0],
    'intent' | 'start' | 'end' | 'scale' | 'rotationDegrees'
  >,
  progress: number,
): { translation: number; scale: number; rotation: number } {
  if (options.intent !== 'transform') {
    return { translation: progress, scale: progress, rotation: progress };
  }
  const active = {
    translation: options.start.x !== options.end.x || options.start.y !== options.end.y,
    scale: options.scale !== 1,
    rotation: options.rotationDegrees !== 0,
  };
  const componentCount =
    Number(active.translation) + Number(active.scale) + Number(active.rotation);
  let componentIndex = 0;
  const stagedProgress = (isActive: boolean): number => {
    if (!isActive) return 0;
    const start = componentIndex / componentCount;
    componentIndex += 1;
    const end = componentIndex / componentCount;
    return Math.min(Math.max((progress - start) / (end - start), 0), 1);
  };
  return {
    translation: stagedProgress(active.translation),
    scale: stagedProgress(active.scale),
    rotation: stagedProgress(active.rotation),
  };
}

function sampleOffsets(durationMs: number): number[] {
  const offsets: number[] = [];
  for (let offsetMs = 0; offsetMs < durationMs; offsetMs += GESTURE_SAMPLE_INTERVAL_MS) {
    offsets.push(offsetMs);
  }
  offsets.push(durationMs);
  return offsets;
}

function defaultMultiTouchDuration(rotationDegrees: number): number {
  const rotationDuration =
    Math.ceil(Math.abs(rotationDegrees) / MAX_ROTATION_DEGREES_PER_SAMPLE) *
    GESTURE_SAMPLE_INTERVAL_MS;
  return Math.min(
    Math.max(DEFAULT_MULTI_TOUCH_DURATION_MS, rotationDuration),
    MAX_ROTATION_DEFAULT_DURATION_MS,
  );
}

function normalizeDuration(
  value: number | undefined,
  fallback: number,
  field: string,
  bounds: { min?: number; max?: number } = {},
): number {
  const durationMs = value ?? fallback;
  const min = bounds.min ?? 16;
  const max = bounds.max ?? 10_000;
  if (
    !Number.isFinite(durationMs) ||
    !Number.isInteger(durationMs) ||
    durationMs < min ||
    durationMs > max
  ) {
    throw new AppError('INVALID_ARGS', `${field} must be an integer between ${min} and ${max}`);
  }
  return durationMs;
}

function normalizeViewport(viewport: Rect): Rect {
  const normalized = {
    x: normalizeFiniteNumber(viewport.x, 'gesture viewport x'),
    y: normalizeFiniteNumber(viewport.y, 'gesture viewport y'),
    width: normalizeFiniteNumber(viewport.width, 'gesture viewport width'),
    height: normalizeFiniteNumber(viewport.height, 'gesture viewport height'),
  };
  if (normalized.width <= 0 || normalized.height <= 0) {
    throw new AppError('INVALID_ARGS', 'gesture viewport width and height must be positive');
  }
  return normalized;
}

function requireViewport(viewport: Rect | undefined, gesture: string): Rect {
  if (!viewport) {
    throw new AppError('COMMAND_FAILED', `Cannot infer viewport for ${gesture}`, {
      hint: 'Open an app with a visible window, then retry the gesture.',
      reason: 'GESTURE_VIEWPORT_UNAVAILABLE',
    });
  }
  return normalizeViewport(viewport);
}

function centerOfViewport(viewport: Rect): Point {
  return {
    x: viewport.x + viewport.width / 2,
    y: viewport.y + viewport.height / 2,
  };
}

function minimumCentroidEdgeMargin(start: Point, end: Point, viewport: Rect): number {
  const maxX = viewport.x + viewport.width;
  const maxY = viewport.y + viewport.height;
  return (
    Math.min(
      start.x - viewport.x,
      maxX - start.x,
      start.y - viewport.y,
      maxY - start.y,
      end.x - viewport.x,
      maxX - end.x,
      end.y - viewport.y,
      maxY - end.y,
    ) - GESTURE_VIEWPORT_INSET_PX
  );
}

function assertPointInViewport(
  point: Point,
  viewport: Rect,
  details: Record<string, unknown>,
): void {
  const maxX = viewport.x + viewport.width;
  const maxY = viewport.y + viewport.height;
  if (
    point.x >= viewport.x + GESTURE_VIEWPORT_INSET_PX &&
    point.x <= maxX - GESTURE_VIEWPORT_INSET_PX &&
    point.y >= viewport.y + GESTURE_VIEWPORT_INSET_PX &&
    point.y <= maxY - GESTURE_VIEWPORT_INSET_PX
  ) {
    return;
  }
  throw outOfBoundsError({ ...details, point, viewport });
}

function outOfBoundsError(details: Record<string, unknown>): AppError {
  return new AppError(
    'INVALID_ARGS',
    'Gesture trajectory does not fit inside the visible viewport',
    {
      ...details,
      reason: 'GESTURE_TRAJECTORY_OUT_OF_BOUNDS',
      hint: 'Move the gesture center away from the edge or reduce its translation, scale, or rotation.',
    },
  );
}

function requireFinitePoint(point: Point, field: string): Point {
  return {
    x: normalizeFiniteNumber(point.x, `${field} x`),
    y: normalizeFiniteNumber(point.y, `${field} y`),
  };
}

function normalizeFiniteNumber(value: number, field: string): number {
  if (!Number.isFinite(value)) {
    throw new AppError('INVALID_ARGS', `${field} must be a finite number`);
  }
  return value;
}

function normalizeScale(value: number, field: string): number {
  const scale = normalizeFiniteNumber(value, field);
  if (scale <= 0) throw new AppError('INVALID_ARGS', `${field} must be greater than 0`);
  return scale;
}

function normalizePositiveNumber(value: number, field: string): number {
  const normalized = normalizeFiniteNumber(value, field);
  if (normalized <= 0) throw new AppError('INVALID_ARGS', `${field} must be a positive number`);
  return normalized;
}

function normalizePointerCount(value: number | undefined): 1 | 2 {
  const pointerCount = value ?? 1;
  if (pointerCount !== 1 && pointerCount !== 2) {
    throw new AppError('INVALID_ARGS', 'gesture pan pointerCount must be 1 or 2');
  }
  return pointerCount;
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
