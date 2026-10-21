import { AppError } from '@agent-device/kernel/errors';

/** Single source of truth for the discriminator the Apple owner sets and the MCP schema advertises. */
export const FOLD_SCREEN_COORDINATE_SPACE = 'native-panel' as const;
export type FoldScreenCoordinateSpace = typeof FOLD_SCREEN_COORDINATE_SPACE;

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

/** Reads an Android `Surface.ROTATION_*` index back into its rotation through the same table. */
export function deviceRotationFromSurfaceIndex(index: number): DeviceRotation | undefined {
  return DEVICE_ROTATIONS.find((rotation) => DEVICE_ROTATION_SURFACE_INDEX[rotation] === index);
}

export function isDeviceRotation(value: unknown): value is DeviceRotation {
  return typeof value === 'string' && (DEVICE_ROTATIONS as readonly string[]).includes(value);
}

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

/** The public entry for parsing one is `parseOrientationRequest`; this stays module-private. */
function parseDeviceRotation(input: string | undefined): DeviceRotation {
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

/** A rotation to lock the device in, or `auto` to hand rotation back to the sensor. */
export const ORIENTATION_REQUESTS = [...DEVICE_ROTATIONS, 'auto'] as const;
export type OrientationRequest = (typeof ORIENTATION_REQUESTS)[number];

export function parseOrientationRequest(input: string | undefined): OrientationRequest {
  return input?.trim().toLowerCase() === 'auto' ? 'auto' : parseDeviceRotation(input);
}

// ---- Hardware button ---------------------------------------------------------------------------
// The `hardware-button` command's positional vocabulary lives beside the rotation vocabulary
// because every entry that parses one command positional already evaluates this module; a module
// of its own would join the eager closure of the daemon, replay-port, session-journal and CLI
// entries that name a volume key (the eager-closure budgets in
// scripts/__tests__/eager-closure-budgets.ts). The runtime-press vocabulary — the button family,
// labels and binding — stays in system-button-runtime.ts. This module must not import from it,
// type-only included: system-button-runtime.ts reaches this module through the snapshot and
// interactor type graphs, so an edge back would close a contracts type cycle (layering R9/R10).
// The label owner pins the drift with a type-level check instead — see system-button-runtime.ts.

/**
 * The phone hardware keys the `hardware-button` command selects between by positional, the way
 * `keyboard <status|dismiss|enter>` selects a keyboard-family cell. `home`, `appSwitcher` and
 * `actionButton` keep their own public commands, so each button has exactly one public route.
 * Each name is a cell of {@link SYSTEM_BUTTONS}; system-button-runtime.ts checks that at
 * compile time. The cells stay module-internal: consumers select a button by its public name.
 */
const HARDWARE_BUTTONS = [
  'volumeUp',
  'volumeDown',
  'power',
  'mute',
  'sleep',
  'wake',
  'mediaPlayPause',
  'mediaNext',
  'mediaPrevious',
  'mediaRewind',
  'mediaFastForward',
] as const;

export type HardwareButton = (typeof HARDWARE_BUTTONS)[number];

/**
 * The public positional names of the hardware keys: the volume/power/mute keys, the explicit
 * sleep and wake events, and the five media keys. The literals are the same ones
 * SYSTEM_BUTTON_LABELS carries for these buttons; the label owner's type-level check and the
 * contracts tests refuse drift between the two lists.
 */
export type HardwareButtonName =
  | 'volume-up'
  | 'volume-down'
  | 'power'
  | 'mute'
  | 'sleep'
  | 'wake'
  | 'media-play-pause'
  | 'media-next'
  | 'media-previous'
  | 'media-rewind'
  | 'media-fast-forward';

/**
 * The accepted positional values, in command order. `satisfies` turns an out-of-vocabulary
 * typo into a build failure; the contracts test pins the list is exhaustive.
 */
export const HARDWARE_BUTTON_NAMES = [
  'volume-up',
  'volume-down',
  'power',
  'mute',
  'sleep',
  'wake',
  'media-play-pause',
  'media-next',
  'media-previous',
  'media-rewind',
  'media-fast-forward',
] as const satisfies readonly HardwareButtonName[];

/** The CLI synopsis tail naming the accepted positional names. */
export const HARDWARE_BUTTON_USAGE = `<${HARDWARE_BUTTON_NAMES.join('|')}>`;

/**
 * The public positional name each parsed button answers with, and the same literals
 * SYSTEM_BUTTON_LABELS carries. Readers in eager-closure entries take the label from here
 * rather than value-importing system-button-runtime.ts (#3848). The parse direction is
 * derived by inverting this table rather than restating it.
 */
export const HARDWARE_BUTTON_NAME_LABELS = {
  volumeUp: 'volume-up',
  volumeDown: 'volume-down',
  power: 'power',
  mute: 'mute',
  sleep: 'sleep',
  wake: 'wake',
  mediaPlayPause: 'media-play-pause',
  mediaNext: 'media-next',
  mediaPrevious: 'media-previous',
  mediaRewind: 'media-rewind',
  mediaFastForward: 'media-fast-forward',
} as const satisfies Record<HardwareButton, HardwareButtonName>;

const HARDWARE_BUTTON_NAME_MAP: ReadonlyMap<HardwareButtonName, HardwareButton> = new Map(
  (Object.entries(HARDWARE_BUTTON_NAME_LABELS) as [HardwareButton, HardwareButtonName][]).map(
    ([button, name]) => [name, button],
  ),
);

/**
 * Parses the `hardware-button` positional. Exact names only — no aliases — and an unknown name
 * refuses with `INVALID_ARGS` before any device dispatch.
 */
/** Public entry for parsing one positional is {@link parseHardwareButtonPositionals}. */
function parseHardwareButton(value: string | undefined): HardwareButton {
  const normalized = value?.toLowerCase();
  const button =
    normalized === undefined
      ? undefined
      : HARDWARE_BUTTON_NAME_MAP.get(normalized as HardwareButtonName);
  if (button) return button;
  throw new AppError(
    'INVALID_ARGS',
    `hardware-button button must be one of: ${HARDWARE_BUTTON_NAMES.join(', ')}.`,
  );
}

/**
 * Owns the whole `hardware-button` positional contract: exactly one name, then the parse. The CLI
 * reader and the daemon resolver both call this, so one typed answer serves both seams.
 */
export function parseHardwareButtonPositionals(positionals: readonly string[]): HardwareButton {
  if (positionals.length !== 1) {
    throw new AppError(
      'INVALID_ARGS',
      `hardware-button requires exactly one button: ${HARDWARE_BUTTON_NAMES.join(', ')}.`,
    );
  }
  return parseHardwareButton(positionals[0]);
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
    if (typeof input.pose !== 'string') {
      throw new AppError('INVALID_ARGS', 'fold pose must be a string');
    }
    return { pose: parseFoldPose(input.pose) };
  }
  if (input.pose !== undefined)
    throw new AppError('INVALID_ARGS', 'fold accepts either pose or keyframes');
  return { keyframes: parseFoldKeyframes(input.keyframes) };
}

function parseFoldKeyframes(frames: unknown): readonly FoldKeyframe[] {
  if (!Array.isArray(frames) || frames.length < 2 || frames.length > MAX_FOLD_KEYFRAMES) {
    throw new AppError('INVALID_ARGS', `fold requires 2–${MAX_FOLD_KEYFRAMES} keyframes`);
  }
  const keyframes = frames.map(parseKeyframe);
  if (
    keyframes[0]!.atMs !== 0 ||
    keyframes.some((frame, index) => index > 0 && frame.atMs <= keyframes[index - 1]!.atMs)
  ) {
    throw new AppError('INVALID_ARGS', 'Fold keyframes must start at 0ms and increase strictly');
  }
  return keyframes;
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
  return parseFoldKeyframes(decoded);
}
