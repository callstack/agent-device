import { AppError } from '../utils/errors.ts';

export const SCREENSHOT_COMMAND_FLAG_KEYS = [
  'out',
  'overlayRefs',
  'screenshotFullscreen',
  'screenshotMaxSize',
  'screenshotNoStabilize',
] as const;

export const SCREENSHOT_ACTION_FLAG_KEYS = [
  'screenshotFullscreen',
  'screenshotMaxSize',
  'screenshotNoStabilize',
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
];

export type ScreenshotRequestFlags = {
  out?: string;
  overlayRefs?: boolean;
  screenshotFullscreen?: boolean;
  screenshotMaxSize?: number;
  screenshotNoStabilize?: boolean;
};

export type ScreenshotDispatchFlags = Pick<
  ScreenshotRequestFlags,
  'screenshotFullscreen' | 'screenshotNoStabilize'
>;

export type ScreenshotRuntimeFlags = Pick<
  ScreenshotRequestFlags,
  'screenshotFullscreen' | 'screenshotMaxSize' | 'screenshotNoStabilize'
>;

export type ScreenshotPublicOptions = {
  overlayRefs?: boolean;
  fullscreen?: boolean;
  maxSize?: number;
  stabilize?: boolean;
};

export type ScreenshotRuntimeOptions = {
  overlayRefs?: boolean;
  fullscreen?: boolean;
  maxSize?: number;
  stabilize?: boolean;
};

export function screenshotOptionsFromFlags(
  flags: Partial<ScreenshotRequestFlags> | undefined,
): ScreenshotRuntimeOptions {
  return stripUndefined({
    overlayRefs: flags?.overlayRefs,
    fullscreen: flags?.screenshotFullscreen,
    maxSize: flags?.screenshotMaxSize,
    stabilize: flags?.screenshotNoStabilize ? false : undefined,
  });
}

export function screenshotFlagsFromOptions(
  options: ScreenshotPublicOptions & Partial<ScreenshotRequestFlags> = {},
): Partial<ScreenshotRequestFlags> {
  return stripUndefined({
    overlayRefs: options.overlayRefs,
    screenshotFullscreen: options.screenshotFullscreen ?? options.fullscreen,
    screenshotMaxSize: options.screenshotMaxSize ?? options.maxSize,
    screenshotNoStabilize:
      options.screenshotNoStabilize ?? (options.stabilize === false ? true : undefined),
  });
}

export function appendScreenshotScriptFlags(
  parts: string[],
  flags: Partial<ScreenshotRequestFlags> | undefined,
): void {
  if (flags?.screenshotFullscreen) parts.push('--fullscreen');
  if (typeof flags?.screenshotMaxSize === 'number') {
    parts.push('--max-size', String(flags.screenshotMaxSize));
  }
  if (flags?.screenshotNoStabilize) parts.push('--no-stabilize');
}

export function readScreenshotScriptFlag(params: {
  args: readonly string[];
  index: number;
  flags: Partial<ScreenshotRequestFlags>;
}): { handled: true; nextIndex: number } | { handled: false } {
  const { args, flags, index } = params;
  const token = args[index];
  if (token === '--fullscreen' || token === '--full' || token === '-f') {
    flags.screenshotFullscreen = true;
    return { handled: true, nextIndex: index };
  }
  if (token === '--no-stabilize') {
    flags.screenshotNoStabilize = true;
    return { handled: true, nextIndex: index };
  }
  if (token === '--max-size') {
    const value = args[index + 1];
    const maxSize = value === undefined ? NaN : Number(value);
    if (!Number.isInteger(maxSize) || maxSize < 1) {
      throw new AppError('INVALID_ARGS', 'screenshot --max-size requires a positive integer');
    }
    flags.screenshotMaxSize = maxSize;
    return { handled: true, nextIndex: index + 1 };
  }
  return { handled: false };
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter((entry) => entry[1] !== undefined)) as T;
}
