import { AppError } from '../kernel/errors.ts';

export const SCREENSHOT_COMMAND_FLAG_KEYS = [
  'out',
  'overlayRefs',
  'screenshotPixelDensity',
  'screenshotFullscreen',
  'screenshotMaxSize',
  'screenshotNoStabilize',
  'screenshotNormalizeStatusBar',
] as const;

export const SCREENSHOT_ACTION_FLAG_KEYS = [
  'screenshotPixelDensity',
  'screenshotFullscreen',
  'screenshotMaxSize',
  'screenshotNoStabilize',
  'screenshotNormalizeStatusBar',
] as const;

type ScreenshotSpecificFlagKey = (typeof SCREENSHOT_ACTION_FLAG_KEYS)[number];

type ScreenshotSpecificFlagDefinition = {
  key: ScreenshotSpecificFlagKey;
  names: readonly string[];
  type: 'boolean' | 'int';
  min?: number;
  usageLabel: string;
  usageDescription: string;
};

export const SCREENSHOT_SPECIFIC_FLAG_DEFINITIONS: readonly ScreenshotSpecificFlagDefinition[] = [
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
    key: 'screenshotMaxSize',
    names: ['--max-size'],
    type: 'int',
    min: 1,
    usageLabel: '--max-size <px>',
    usageDescription: 'Screenshot/record: downscale so the longest edge is at most <px>',
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
  { token: '--max-size', key: 'screenshotMaxSize', label: 'screenshot --max-size' },
] as const;

export type ScreenshotRequestFlags = {
  out?: string;
  overlayRefs?: boolean;
  screenshotPixelDensity?: number;
  screenshotFullscreen?: boolean;
  screenshotMaxSize?: number;
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
  | 'screenshotPixelDensity'
  | 'screenshotFullscreen'
  | 'screenshotMaxSize'
  | 'screenshotNoStabilize'
  | 'screenshotNormalizeStatusBar'
>;

export type ScreenshotPublicOptions = {
  overlayRefs?: boolean;
  pixelDensity?: number;
  fullscreen?: boolean;
  maxSize?: number;
  stabilize?: boolean;
  normalizeStatusBar?: boolean;
};

export type ScreenshotRuntimeOptions = {
  overlayRefs?: boolean;
  pixelDensity?: number;
  fullscreen?: boolean;
  maxSize?: number;
  stabilize?: boolean;
  normalizeStatusBar?: boolean;
};

export function screenshotOptionsFromFlags(
  flags: Partial<ScreenshotRequestFlags> | undefined,
): ScreenshotRuntimeOptions {
  return stripUndefined({
    overlayRefs: flags?.overlayRefs,
    pixelDensity: flags?.screenshotPixelDensity,
    fullscreen: flags?.screenshotFullscreen,
    maxSize: flags?.screenshotMaxSize,
    stabilize: flags?.screenshotNoStabilize ? false : undefined,
    normalizeStatusBar: flags?.screenshotNormalizeStatusBar,
  });
}

export function screenshotFlagsFromOptions(
  options: ScreenshotPublicOptions & Partial<ScreenshotRequestFlags> = {},
): Partial<ScreenshotRequestFlags> {
  return stripUndefined({
    overlayRefs: options.overlayRefs,
    screenshotPixelDensity: options.screenshotPixelDensity ?? options.pixelDensity,
    screenshotFullscreen: options.screenshotFullscreen ?? options.fullscreen,
    screenshotMaxSize: options.screenshotMaxSize ?? options.maxSize,
    screenshotNoStabilize:
      options.screenshotNoStabilize ?? (options.stabilize === false ? true : undefined),
    screenshotNormalizeStatusBar:
      options.screenshotNormalizeStatusBar ?? options.normalizeStatusBar,
  });
}

export function appendScreenshotScriptFlags(
  parts: string[],
  flags: Partial<ScreenshotRequestFlags> | undefined,
): void {
  if (typeof flags?.screenshotPixelDensity === 'number') {
    parts.push('--pixel-density', String(flags.screenshotPixelDensity));
  }
  if (flags?.screenshotFullscreen) parts.push('--fullscreen');
  if (typeof flags?.screenshotMaxSize === 'number') {
    parts.push('--max-size', String(flags.screenshotMaxSize));
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
  return (
    readScreenshotBooleanScriptFlag(token, flags, index) ??
    readScreenshotIntScriptFlag({ args, index, flags, token }) ?? { handled: false }
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
  const value = params.args[params.index + 1];
  const parsed = value === undefined ? NaN : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new AppError('INVALID_ARGS', `${definition.label} requires a positive integer`);
  }
  params.flags[definition.key] = parsed;
  return { handled: true, nextIndex: params.index + 1 };
}
