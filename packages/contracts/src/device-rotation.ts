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

// ---- Telephony -------------------------------------------------------------------------------
// The CLI and session journal load this module eagerly; moving these values to a module of their
// own would grow their eager closures past scripts/__tests__/eager-closure-budgets.ts. The types
// live in telephony-runtime.ts.

/**
 * The telephony events an emulator can be asked to simulate: an incoming voice call (`call`),
 * answering it (`accept`), ending it (`cancel`), and an inbound text message (`sms`).
 */
export const TELEPHONY_CALL_ACTIONS = ['call', 'accept', 'cancel'] as const;
export const TELEPHONY_ACTIONS = [...TELEPHONY_CALL_ACTIONS, 'sms'] as const;
type TelephonyAction = (typeof TELEPHONY_ACTIONS)[number];
type TelephonyCallAction = (typeof TELEPHONY_CALL_ACTIONS)[number];

export const TELEPHONY_USAGE =
  'telephony call|accept|cancel <number> | telephony sms <number> <text>';

/**
 * A caller number: digits with an optional leading `+`, at most the 15 digits of an E.164 number,
 * which also fits the emulator modem's 16-character call number field.
 */
const TELEPHONY_NUMBER_PATTERN = /^\+?\d{1,15}$/;
/**
 * The emulator console reads one command per line, so a line break inside the text would end the
 * `sms send` command and start another. Line breaks are escaped for the console instead (a CRLF
 * pair counts as one); every other control character, including a lone CR, is refused.
 */
// eslint-disable-next-line no-control-regex
const TELEPHONY_TEXT_FORBIDDEN_CHARACTERS = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/;

/** Neutral intent for one telephony event, already validated by {@link parseTelephonyEventInput}. */
export type TelephonyEventInput =
  | Readonly<{ action: TelephonyCallAction; number: string }>
  | Readonly<{ action: 'sms'; number: string; text: string }>;

function parseTelephonyAction(input: unknown): TelephonyAction {
  if (input === undefined) {
    throw new AppError('INVALID_ARGS', `telephony requires an action. Use ${TELEPHONY_USAGE}.`);
  }
  const normalized = typeof input === 'string' ? input.trim().toLowerCase() : undefined;
  const action = TELEPHONY_ACTIONS.find((candidate) => candidate === normalized);
  if (!action) {
    throw new AppError(
      'INVALID_ARGS',
      `Invalid telephony action: ${String(input)}. Use ${TELEPHONY_ACTIONS.join(', ')}.`,
    );
  }
  return action;
}

export function parseTelephonyEventInput(
  input: Readonly<{ action?: unknown; number?: unknown; text?: unknown }>,
): TelephonyEventInput {
  const action = parseTelephonyAction(input.action);
  const number = parseTelephonyNumber(input.number, action);
  if (action !== 'sms') {
    if (input.text !== undefined) {
      throw new AppError('INVALID_ARGS', `telephony ${action} takes only a phone number.`);
    }
    return { action, number };
  }
  return { action, number, text: parseTelephonySmsText(input.text) };
}

/**
 * `telephony <action> <number> [text…]` as the CLI and the daemon receive it. The words after the
 * number are the SMS text, joined with single spaces the way an unquoted shell argument list splits.
 */
export function parseTelephonyPositionals(positionals: readonly string[]): TelephonyEventInput {
  const [action, number, ...words] = positionals;
  return parseTelephonyEventInput({
    action,
    number,
    text: words.length > 0 ? words.join(' ') : undefined,
  });
}

/** The daemon positionals for one validated event; the inverse of {@link parseTelephonyPositionals}. */
export function telephonyPositionals(input: TelephonyEventInput): string[] {
  return input.action === 'sms'
    ? [input.action, input.number, input.text]
    : [input.action, input.number];
}

function parseTelephonyNumber(input: unknown, action: TelephonyAction): string {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new AppError('INVALID_ARGS', `telephony ${action} requires a phone number.`);
  }
  const number = input.trim();
  if (!TELEPHONY_NUMBER_PATTERN.test(number)) {
    throw new AppError('INVALID_ARGS', `Invalid phone number: ${number}.`, {
      hint: 'Use digits with an optional leading +, for example 5551234 or +15551234567.',
    });
  }
  return number;
}

function parseTelephonySmsText(input: unknown): string {
  if (typeof input !== 'string' || input === '') {
    throw new AppError('INVALID_ARGS', 'telephony sms requires message text.');
  }
  const text = input.replaceAll('\r\n', '\n');
  if (TELEPHONY_TEXT_FORBIDDEN_CHARACTERS.test(text)) {
    throw new AppError('INVALID_ARGS', 'telephony sms text must not contain control characters.', {
      hint: 'Line breaks (LF or CRLF) are allowed; tabs, lone carriage returns, and other control characters are not.',
    });
  }
  return text;
}
