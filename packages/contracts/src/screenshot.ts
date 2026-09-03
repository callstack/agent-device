import { AppError } from '@agent-device/kernel/errors';

export const SCREENSHOT_SCALE_LIMITS = { min: 0.01, max: 1 } as const;

/**
 * `--max-size` shipped in released CLIs, `.ad` scripts, Node options
 * (`maxSize`), request flags (`screenshotMaxSize`), and the derived
 * `AGENT_DEVICE_SCREENSHOT_MAX_SIZE` env var. Every surface that used to honor
 * it must refuse with this migration guidance — sizing must never disappear
 * silently.
 */
export const RETIRED_SCREENSHOT_MAX_SIZE = {
  flagKey: 'screenshotMaxSize',
  cliToken: '--max-size',
  envVar: 'AGENT_DEVICE_SCREENSHOT_MAX_SIZE',
  publicOptionKey: 'maxSize',
  migration: {
    screenshot:
      'screenshot --max-size was removed; use --scale <0.01-1> (or AGENT_DEVICE_SCREENSHOT_SCALE) to downscale proportionally',
    record: 'record --max-size was removed; recordings capture at native resolution',
  },
} as const;

type RetiredMaxSizeCommand = keyof typeof RETIRED_SCREENSHOT_MAX_SIZE.migration;

export function retiredScreenshotMaxSizeFlagError(
  command: RetiredMaxSizeCommand,
  flags: object | undefined,
): string | undefined {
  return flags && Object.hasOwn(flags, RETIRED_SCREENSHOT_MAX_SIZE.flagKey)
    ? RETIRED_SCREENSHOT_MAX_SIZE.migration[command]
    : undefined;
}

export function validateNoRetiredScreenshotMaxSize(
  command: RetiredMaxSizeCommand,
  input: object,
): void {
  if (
    Object.hasOwn(input, RETIRED_SCREENSHOT_MAX_SIZE.publicOptionKey) ||
    Object.hasOwn(input, RETIRED_SCREENSHOT_MAX_SIZE.flagKey)
  ) {
    throw new AppError('INVALID_ARGS', RETIRED_SCREENSHOT_MAX_SIZE.migration[command]);
  }
}

/**
 * Machine-readable `screenshot --crop-on` outcome taxonomy. Failures carry these
 * values in `error.details.reason`; `partialIntersection` doubles as the
 * success-path warning token. Callers branch on the values, never on message
 * text. `pendingPixelIdentityEvidence` is the acceptance-matrix rejection
 * reason, not a runtime failure.
 */
export const SCREENSHOT_CROP_REASONS = {
  selectorInvalid: 'CROP_SELECTOR_INVALID',
  targetNotFound: 'CROP_TARGET_NOT_FOUND',
  targetAmbiguous: 'CROP_TARGET_AMBIGUOUS',
  captureUnreadable: 'CROP_CAPTURE_UNREADABLE',
  captureIncomplete: 'CROP_CAPTURE_INCOMPLETE',
  emptyIntersection: 'CROP_EMPTY_INTERSECTION',
  partialIntersection: 'CROP_PARTIAL_INTERSECTION',
  targetNotAccepted: 'CROP_TARGET_NOT_ACCEPTED',
  frameMismatch: 'CROP_FRAME_MISMATCH',
  pendingPixelIdentityEvidence: 'PENDING_PIXEL_IDENTITY_EVIDENCE',
} as const;

export type ScreenshotCropReason =
  (typeof SCREENSHOT_CROP_REASONS)[keyof typeof SCREENSHOT_CROP_REASONS];

export const SCREENSHOT_COMMAND_FLAG_KEYS = [
  'out',
  'overlayRefs',
  'screenshotCropOn',
  'screenshotPixelDensity',
  'screenshotFullscreen',
  'screenshotScale',
  'screenshotNoStabilize',
  'screenshotNormalizeStatusBar',
] as const;

export const SCREENSHOT_ACTION_FLAG_KEYS = [
  'screenshotCropOn',
  'screenshotPixelDensity',
  'screenshotFullscreen',
  'screenshotScale',
  'screenshotNoStabilize',
  'screenshotNormalizeStatusBar',
] as const;

type ScreenshotSpecificFlagKey = (typeof SCREENSHOT_ACTION_FLAG_KEYS)[number];

type ScreenshotSpecificFlagDefinition = {
  key: ScreenshotSpecificFlagKey;
  names: readonly string[];
  type: 'boolean' | 'int' | 'number' | 'string';
  min?: number;
  max?: number;
  usageLabel: string;
  usageDescription: string;
};

export const SCREENSHOT_SPECIFIC_FLAG_DEFINITIONS: readonly ScreenshotSpecificFlagDefinition[] = [
  {
    key: 'screenshotCropOn',
    names: ['--crop-on'],
    type: 'string',
    usageLabel: '--crop-on <selector-expression>',
    usageDescription:
      'Screenshot: crop the capture to the frame of the selector resolved on the same screen',
  },
  {
    key: 'screenshotPixelDensity',
    names: ['--pixel-density'],
    type: 'int',
    min: 1,
    usageLabel: '--pixel-density <n>',
    usageDescription:
      'Screenshot: output PNG pixel density in pixels per logical point (currently supported on iOS simulators)',
  },
  {
    key: 'screenshotFullscreen',
    names: ['--fullscreen', '--full', '-f'],
    type: 'boolean',
    usageLabel: '--fullscreen, --full, -f',
    usageDescription:
      'Screenshot: on web capture the full page; on macOS app sessions capture the full desktop instead of the app window',
  },
  {
    key: 'screenshotScale',
    names: ['--scale'],
    type: 'number',
    min: SCREENSHOT_SCALE_LIMITS.min,
    max: SCREENSHOT_SCALE_LIMITS.max,
    usageLabel: '--scale <0.01-1>',
    usageDescription:
      'Screenshot: resize both dimensions by this factor (or use AGENT_DEVICE_SCREENSHOT_SCALE)',
  },
  {
    key: 'screenshotNoStabilize',
    names: ['--no-stabilize'],
    type: 'boolean',
    usageLabel: '--no-stabilize',
    usageDescription:
      'Screenshot: skip Android demo-mode/status-bar stabilization and settle delay for low-latency capture loops',
  },
  {
    key: 'screenshotNormalizeStatusBar',
    names: ['--normalize-status-bar'],
    type: 'boolean',
    usageLabel: '--normalize-status-bar',
    usageDescription:
      'Screenshot: on iOS simulators temporarily normalize status-bar chrome for deterministic screenshot diffs',
  },
];

const SCREENSHOT_SCRIPT_BOOLEAN_FLAGS = [
  { tokens: ['--fullscreen', '--full', '-f'], key: 'screenshotFullscreen' },
  { tokens: ['--no-stabilize'], key: 'screenshotNoStabilize' },
  { tokens: ['--normalize-status-bar'], key: 'screenshotNormalizeStatusBar' },
] as const;

const SCREENSHOT_SCRIPT_INT_FLAGS = [
  {
    token: '--pixel-density',
    key: 'screenshotPixelDensity',
    label: 'screenshot --pixel-density',
  },
] as const;

const SCREENSHOT_SCRIPT_NUMBER_FLAGS = [
  {
    token: '--scale',
    key: 'screenshotScale',
    label: 'screenshot --scale',
    min: SCREENSHOT_SCALE_LIMITS.min,
    max: SCREENSHOT_SCALE_LIMITS.max,
  },
] as const;

const SCREENSHOT_SCRIPT_STRING_FLAGS = [
  {
    token: '--crop-on',
    key: 'screenshotCropOn',
    label: 'screenshot --crop-on',
  },
] as const;

export type ScreenshotRequestFlags = {
  out?: string;
  overlayRefs?: boolean;
  screenshotCropOn?: string;
  screenshotPixelDensity?: number;
  screenshotFullscreen?: boolean;
  screenshotScale?: number;
  screenshotNoStabilize?: boolean;
  screenshotNormalizeStatusBar?: boolean;
};

export type ScreenshotDispatchFlags = Pick<
  ScreenshotRequestFlags,
  | 'screenshotPixelDensity'
  | 'screenshotFullscreen'
  | 'screenshotNoStabilize'
  | 'screenshotNormalizeStatusBar'
>;

export type ScreenshotRuntimeFlags = Pick<
  ScreenshotRequestFlags,
  | 'screenshotCropOn'
  | 'screenshotPixelDensity'
  | 'screenshotFullscreen'
  | 'screenshotScale'
  | 'screenshotNoStabilize'
  | 'screenshotNormalizeStatusBar'
>;

export type ScreenshotPublicOptions = {
  overlayRefs?: boolean;
  cropOn?: string;
  pixelDensity?: number;
  fullscreen?: boolean;
  scale?: number;
  stabilize?: boolean;
  normalizeStatusBar?: boolean;
};

export type ScreenshotRuntimeOptions = {
  overlayRefs?: boolean;
  cropOn?: string;
  pixelDensity?: number;
  fullscreen?: boolean;
  scale?: number;
  stabilize?: boolean;
  normalizeStatusBar?: boolean;
};

export function screenshotOptionsFromFlags(
  flags: Partial<ScreenshotRequestFlags> | undefined,
): ScreenshotRuntimeOptions {
  return stripUndefined({
    overlayRefs: flags?.overlayRefs,
    cropOn: flags?.screenshotCropOn,
    pixelDensity: flags?.screenshotPixelDensity,
    fullscreen: flags?.screenshotFullscreen,
    scale: flags?.screenshotScale,
    stabilize: flags?.screenshotNoStabilize ? false : undefined,
    normalizeStatusBar: flags?.screenshotNormalizeStatusBar,
  });
}

export function screenshotFlagsFromOptions(
  options: ScreenshotPublicOptions & Partial<ScreenshotRequestFlags> = {},
): Partial<ScreenshotRequestFlags> {
  return stripUndefined({
    overlayRefs: options.overlayRefs,
    screenshotCropOn: options.screenshotCropOn ?? options.cropOn,
    screenshotPixelDensity: options.screenshotPixelDensity ?? options.pixelDensity,
    screenshotFullscreen: options.screenshotFullscreen ?? options.fullscreen,
    screenshotScale: options.screenshotScale,
    screenshotNoStabilize:
      options.screenshotNoStabilize ?? (options.stabilize === false ? true : undefined),
    screenshotNormalizeStatusBar:
      options.screenshotNormalizeStatusBar ?? options.normalizeStatusBar,
  });
}

/**
 * Also maps the public `scale` option. `screenshotFlagsFromOptions` is fed
 * generic cross-command option bags where a bare `scale` key belongs to the
 * pinch gesture, so only this screenshot-boundary projection may read it.
 */
export function screenshotFlagsFromPublicOptions(
  options: ScreenshotPublicOptions & Partial<ScreenshotRequestFlags> = {},
): Partial<ScreenshotRequestFlags> {
  return screenshotFlagsFromOptions({
    ...options,
    screenshotScale: options.screenshotScale ?? options.scale,
  });
}

export function validateScreenshotScale(options: Pick<ScreenshotPublicOptions, 'scale'>): void {
  const { min, max } = SCREENSHOT_SCALE_LIMITS;
  if (
    options.scale !== undefined &&
    (!Number.isFinite(options.scale) || options.scale < min || options.scale > max)
  ) {
    throw new AppError('INVALID_ARGS', `screenshot scale must be between ${min} and ${max}`);
  }
}

export function appendScreenshotScriptFlags(
  parts: string[],
  flags: Partial<ScreenshotRequestFlags> | undefined,
): void {
  if (typeof flags?.screenshotPixelDensity === 'number') {
    parts.push('--pixel-density', String(flags.screenshotPixelDensity));
  }
  if (flags?.screenshotFullscreen) parts.push('--fullscreen');
  if (typeof flags?.screenshotScale === 'number') {
    parts.push('--scale', String(flags.screenshotScale));
  }
  if (flags?.screenshotNoStabilize) parts.push('--no-stabilize');
  if (flags?.screenshotNormalizeStatusBar) parts.push('--normalize-status-bar');
}

export function readScreenshotScriptFlag(params: {
  args: readonly string[];
  index: number;
  flags: Partial<ScreenshotRequestFlags>;
}): { handled: true; nextIndex: number } | { handled: false } {
  const { args, flags, index } = params;
  const token = args[index];
  if (token === RETIRED_SCREENSHOT_MAX_SIZE.cliToken) {
    throw new AppError('INVALID_ARGS', RETIRED_SCREENSHOT_MAX_SIZE.migration.screenshot);
  }
  return (
    readScreenshotBooleanScriptFlag(token, flags, index) ??
    readScreenshotIntScriptFlag({ args, index, flags, token }) ??
    readScreenshotNumberScriptFlag({ args, index, flags, token }) ??
    readScreenshotStringScriptFlag({ args, index, flags, token }) ?? { handled: false }
  );
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter((entry) => entry[1] !== undefined)) as T;
}

function readScreenshotBooleanScriptFlag(
  token: string | undefined,
  flags: Partial<ScreenshotRequestFlags>,
  index: number,
): { handled: true; nextIndex: number } | undefined {
  const definition = SCREENSHOT_SCRIPT_BOOLEAN_FLAGS.find((entry) =>
    entry.tokens.some((candidate) => candidate === token),
  );
  if (!definition) return undefined;
  flags[definition.key] = true;
  return { handled: true, nextIndex: index };
}

function readScreenshotIntScriptFlag(params: {
  args: readonly string[];
  index: number;
  flags: Partial<ScreenshotRequestFlags>;
  token: string | undefined;
}): { handled: true; nextIndex: number } | undefined {
  const definition = SCREENSHOT_SCRIPT_INT_FLAGS.find((entry) => entry.token === params.token);
  if (!definition) return undefined;
  const parsed = Number(params.args[params.index + 1]);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new AppError('INVALID_ARGS', `${definition.label} requires a positive integer`);
  }
  params.flags[definition.key] = parsed;
  return { handled: true, nextIndex: params.index + 1 };
}

function readScreenshotNumberScriptFlag(params: {
  args: readonly string[];
  index: number;
  flags: Partial<ScreenshotRequestFlags>;
  token: string | undefined;
}): { handled: true; nextIndex: number } | undefined {
  const definition = SCREENSHOT_SCRIPT_NUMBER_FLAGS.find((entry) => entry.token === params.token);
  if (!definition) return undefined;
  const parsed = Number(params.args[params.index + 1]);
  if (!Number.isFinite(parsed) || parsed < definition.min || parsed > definition.max) {
    throw new AppError(
      'INVALID_ARGS',
      `${definition.label} requires a number from ${definition.min} to ${definition.max}`,
    );
  }
  params.flags[definition.key] = parsed;
  return { handled: true, nextIndex: params.index + 1 };
}

function readScreenshotStringScriptFlag(params: {
  args: readonly string[];
  index: number;
  flags: Partial<ScreenshotRequestFlags>;
  token: string | undefined;
}): { handled: true; nextIndex: number } | undefined {
  const definition = SCREENSHOT_SCRIPT_STRING_FLAGS.find((entry) => entry.token === params.token);
  if (!definition) return undefined;
  const value = params.args[params.index + 1];
  if (typeof value !== 'string' || value.length === 0) {
    throw new AppError('INVALID_ARGS', `${definition.label} requires a selector expression`);
  }
  params.flags[definition.key] = value;
  return { handled: true, nextIndex: params.index + 1 };
}
