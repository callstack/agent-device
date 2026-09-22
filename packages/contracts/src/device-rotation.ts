import { AppError } from '@agent-device/kernel/errors';

export const DEVICE_ROTATIONS = [
  'portrait',
  'portrait-upside-down',
  'landscape-left',
  'landscape-right',
] as const;
export type DeviceRotation = (typeof DEVICE_ROTATIONS)[number];

/**
 * Android `Surface.ROTATION_*` index per rotation, which is also the value the `user_rotation`
 * system setting takes and, multiplied by 90, the `z` degrees the WebDriver `/rotation` endpoint
 * takes. One table so the adb path and the cloud WebDriver path cannot drift apart.
 */
export const DEVICE_ROTATION_SURFACE_INDEX = {
  portrait: 0,
  'landscape-left': 1,
  'portrait-upside-down': 2,
  'landscape-right': 3,
} as const satisfies Record<DeviceRotation, 0 | 1 | 2 | 3>;

export function deviceRotationSurfaceDegrees(rotation: DeviceRotation): 0 | 90 | 180 | 270 {
  return (DEVICE_ROTATION_SURFACE_INDEX[rotation] * 90) as 0 | 90 | 180 | 270;
}

/**
 * Collapses the four-way rotation onto the two values the WebDriver `/orientation` endpoint accepts.
 * Lossy by nature: both landscape rotations report `LANDSCAPE`, both portraits `PORTRAIT`.
 */
export function deviceRotationOrientation(rotation: DeviceRotation): 'PORTRAIT' | 'LANDSCAPE' {
  return DEVICE_ROTATION_SURFACE_INDEX[rotation] % 2 === 0 ? 'PORTRAIT' : 'LANDSCAPE';
}

export function parseDeviceRotation(input: string | undefined): DeviceRotation {
  if (input === undefined) {
    throw new AppError(
      'INVALID_ARGS',
      'orientation requires an orientation argument. Use portrait|portrait-upside-down|landscape-left|landscape-right.',
    );
  }
  const normalized = input?.trim().toLowerCase();
  switch (normalized) {
    case 'portrait':
      return 'portrait';
    case 'portrait-upside-down':
    case 'upside-down':
      return 'portrait-upside-down';
    case 'landscape-left':
    case 'left':
      return 'landscape-left';
    case 'landscape-right':
    case 'right':
      return 'landscape-right';
    default:
      throw new AppError(
        'INVALID_ARGS',
        `Invalid rotation: ${input}. Use portrait|portrait-upside-down|landscape-left|landscape-right.`,
      );
  }
}

// ---- Hinge pose ------------------------------------------------------------------------------
// Lives beside the rotation vocabulary because every entry that reads one device pose already
// evaluates this module; a module of its own would join the eager closure of entries that can
// never pose a hinge (the eager-closure budgets in scripts/__tests__/eager-closure-budgets.ts).

/**
 * The three hinge poses a foldable Apple device can be put in, named after what an agent sees
 * rather than after Apple's `UIHinge.Status` cases: `closed` lights the outer panel only,
 * `half-open` and `open` light the inner panel. Device Hub calls them Closed, Book, and Open;
 * `UIHinge.Status` calls them `.closed`, `.partiallyOpen`, and `.fullyOpen`.
 */
export const FOLD_POSES = ['closed', 'half-open', 'open'] as const;
export type FoldPose = (typeof FOLD_POSES)[number];

export const FOLD_POSE_USAGE = 'closed|half-open|open';

/**
 * `half-open` is the only pose whose hinge angle is not a fixed point: Device Hub's Book preset
 * measured 130° on the iOS 27.1 Duo, and Apple's own status calls every angle strictly between
 * closed and fully open `partiallyOpen`. The verifier therefore reads the pose from the angle
 * with the same open interval rather than pinning one preset value.
 */
export function foldPoseForHingeAngle(angleDegrees: number): FoldPose | undefined {
  if (!Number.isFinite(angleDegrees)) return undefined;
  if (angleDegrees <= FOLD_CLOSED_MAX_DEGREES) return 'closed';
  if (angleDegrees >= FOLD_OPEN_MIN_DEGREES) return 'open';
  return 'half-open';
}

const FOLD_CLOSED_MAX_DEGREES = 1;
const FOLD_OPEN_MIN_DEGREES = 179;

export function parseFoldPose(input: string | undefined): FoldPose {
  if (input === undefined) {
    throw new AppError('INVALID_ARGS', `fold requires a pose argument. Use ${FOLD_POSE_USAGE}.`);
  }
  const normalized = input.trim().toLowerCase();
  switch (normalized) {
    case 'closed':
    case 'close':
    case 'fold':
    case 'folded':
      return 'closed';
    case 'half-open':
    case 'half':
    case 'half-unfolded':
    case 'partially-open':
    case 'book':
      return 'half-open';
    case 'open':
    case 'unfold':
    case 'unfolded':
    case 'fully-open':
    case 'flat':
      return 'open';
    default:
      throw new AppError('INVALID_ARGS', `Invalid fold pose: ${input}. Use ${FOLD_POSE_USAGE}.`);
  }
}

export type FoldKeyframe = Readonly<{ atMs: number; angle: number }>;
export type SetFoldPoseInput =
  | Readonly<{ pose: FoldPose; keyframes?: never }>
  | Readonly<{ keyframes: readonly FoldKeyframe[]; pose?: never }>;

export const MAX_FOLD_DURATION_MS = 60_000;
export const MAX_FOLD_KEYFRAMES = 64;

/** Validates both public structured input and decoded daemon intent before any mutation. */
export function parseFoldInput(input: { pose?: unknown; keyframes?: unknown }): SetFoldPoseInput {
  if (input.keyframes === undefined) {
    if (input.pose === undefined)
      throw new AppError('INVALID_ARGS', 'fold requires a pose or keyframes');
    if (input.pose !== undefined && typeof input.pose !== 'string') {
      throw new AppError('INVALID_ARGS', 'fold pose must be a string');
    }
    return { pose: parseFoldPose(input.pose) };
  }
  const frames = input.keyframes;
  if (
    input.pose !== undefined ||
    !Array.isArray(frames) ||
    frames.length < 2 ||
    frames.length > MAX_FOLD_KEYFRAMES
  ) {
    throw new AppError(
      'INVALID_ARGS',
      `fold requires either pose or 2–${MAX_FOLD_KEYFRAMES} keyframes`,
    );
  }
  const keyframes = frames.map(parseKeyframe);
  if (
    keyframes[0]!.atMs !== 0 ||
    keyframes.some((frame, index) => index > 0 && frame.atMs <= keyframes[index - 1]!.atMs)
  ) {
    throw new AppError('INVALID_ARGS', 'Fold keyframes must start at 0ms and increase strictly');
  }
  return { keyframes };
}

function isBoundedNumber(value: unknown, maximum: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= maximum;
}

function parseKeyframe(frame: unknown): FoldKeyframe {
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) {
    throw new AppError('INVALID_ARGS', 'Each fold keyframe requires atMs and angle');
  }
  const { atMs, angle } = frame as Record<string, unknown>;
  if (Object.keys(frame).some((key) => key !== 'atMs' && key !== 'angle')) {
    throw new AppError('INVALID_ARGS', 'Fold keyframes only accept atMs and angle');
  }
  if (!isBoundedNumber(atMs, MAX_FOLD_DURATION_MS) || !Number.isSafeInteger(atMs)) {
    throw new AppError(
      'INVALID_ARGS',
      `Fold keyframe times must be integers from 0 to ${MAX_FOLD_DURATION_MS}ms`,
    );
  }
  if (!isBoundedNumber(angle, 180)) {
    throw new AppError('INVALID_ARGS', 'Fold keyframe angles must be finite numbers from 0 to 180');
  }
  return { atMs, angle };
}

export function parseFoldKeyframesJson(value: string): readonly FoldKeyframe[] {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    throw new AppError(
      'INVALID_ARGS',
      '--keyframes requires a JSON array of {atMs, angle} objects',
    );
  }
  const input = parseFoldInput({ keyframes: decoded });
  if (!input.keyframes) throw new AppError('INVALID_ARGS', '--keyframes requires keyframes');
  return input.keyframes;
}
