import type { SessionAction } from '../daemon/types.ts';
import { appendScreenshotScriptFlags } from '../contracts/screenshot.ts';
import { splitRefGenerationSuffix } from '../kernel/snapshot.ts';

/**
 * #1076 versioned refs: a recorded ref positional may carry a `~s<generation>`
 * pin from the client that issued it (`@e12~s3`). Generations are meaningless
 * outside the session that minted them — a replayed script runs against a NEW
 * session with its own generation counter — so replay parsing and script
 * writing strip well-formed suffixes and IGNORE the generation instead of
 * re-validating it (which would only produce spurious staleness warnings).
 * Malformed suffixes are left untouched; they were never minted by us and the
 * daemon owns rejecting them.
 */
export function stripRecordedRefGeneration(token: string): string {
  if (!token.startsWith('@')) return token;
  const split = splitRefGenerationSuffix(token);
  return split?.base ?? token;
}

const NUMERIC_ARG_RE = /^-?\d+(\.\d+)?$/;
const BARE_SCRIPT_TOKEN_RE = /^[^\s"\\]+$/;

const CLICK_LIKE_NUMERIC_FLAG_MAP = new Map<string, 'count' | 'intervalMs' | 'holdMs' | 'jitterPx'>(
  [
    ['--count', 'count'],
    ['--interval-ms', 'intervalMs'],
    ['--hold-ms', 'holdMs'],
    ['--jitter-px', 'jitterPx'],
  ],
);

const SWIPE_NUMERIC_FLAG_MAP = new Map<string, 'count' | 'pauseMs'>([
  ['--count', 'count'],
  ['--pause-ms', 'pauseMs'],
]);
const GESTURE_NUMERIC_FLAG_MAP = new Map<string, 'pointerCount'>([
  ['--pointer-count', 'pointerCount'],
]);

const TYPING_NUMERIC_FLAG_MAP = new Map<string, 'delayMs'>([['--delay-ms', 'delayMs']]);

export function isClickLikeCommand(command: string): command is 'click' | 'press' {
  return command === 'click' || command === 'press';
}

export function isTouchTargetCommand(command: string): command is 'click' | 'press' | 'longpress' {
  return isClickLikeCommand(command) || command === 'longpress';
}

function isTypingCommand(command: string): command is 'type' | 'fill' {
  return command === 'type' || command === 'fill';
}

export function formatScriptArg(value: string): string {
  return formatScriptToken(value, isStructuralScriptToken);
}

// Use for literal values such as device labels where leading/trailing whitespace must survive round-trips.
export function formatScriptStringLiteral(value: string): string {
  return JSON.stringify(value);
}

// Preserve readable CLI-ish script output for ordinary tokens while still quoting whitespace.
function formatScriptArgQuoteIfNeeded(value: string): string {
  return formatScriptToken(value, isBareScriptToken);
}

function formatScriptToken(value: string, canStayBare: (value: string) => boolean): string {
  return canStayBare(value) ? value : formatScriptStringLiteral(value);
}

function isStructuralScriptToken(value: string): boolean {
  return (isBareScriptToken(value) && value.startsWith('@')) || NUMERIC_ARG_RE.test(value);
}

function isBareScriptToken(value: string): boolean {
  return BARE_SCRIPT_TOKEN_RE.test(value);
}

const TYPED_TEXT_COMMANDS = new Set(['fill', 'type']);

/**
 * Action summary safe for the divergence report / user-facing failure text.
 * For typing commands the typed value is categorically dropped and replaced
 * with a `<text>` marker — fill text is never serialized (ADR 0012), not
 * merely redacted-if-secret-shaped. The target (selector / @ref / point)
 * still shows so the caller can see WHICH field failed.
 */
export function formatDivergenceActionLabel(action: SessionAction): string {
  if (!TYPED_TEXT_COMMANDS.has(action.command)) {
    const values = (action.positionals ?? []).map((value) => formatScriptArg(value));
    return [action.command, ...values].join(' ');
  }
  const targetTokens = divergenceTypingTargetTokens(action);
  const targetLabel = targetTokens.map((value) => formatScriptArg(value)).join(' ');
  return [action.command, targetLabel, '<text>'].filter((part) => part.length > 0).join(' ');
}

/**
 * The identifying (non-text) positional tokens of a typing action:
 * `@ref`, a two-token point (`x y`), or a single selector. Everything after
 * is the typed value and is excluded.
 */
function divergenceTypingTargetTokens(action: SessionAction): string[] {
  if (action.command === 'type') return [];
  const positionals = action.positionals ?? [];
  const first = positionals[0];
  if (first === undefined) return [];
  if (first.startsWith('@')) return [first];
  if (
    positionals.length >= 3 &&
    NUMERIC_ARG_RE.test(first) &&
    NUMERIC_ARG_RE.test(positionals[1] ?? '')
  ) {
    return [first, positionals[1]!];
  }
  return [first];
}

// fallow-ignore-next-line complexity
export function appendScriptSeriesFlags(
  parts: string[],
  action: Pick<SessionAction, 'command' | 'flags'>,
): void {
  const flags = action.flags ?? {};
  if (isClickLikeCommand(action.command)) {
    if (typeof flags.count === 'number') parts.push('--count', String(flags.count));
    if (typeof flags.intervalMs === 'number') parts.push('--interval-ms', String(flags.intervalMs));
    if (typeof flags.holdMs === 'number') parts.push('--hold-ms', String(flags.holdMs));
    if (typeof flags.jitterPx === 'number') parts.push('--jitter-px', String(flags.jitterPx));
    if (flags.doubleTap === true) parts.push('--double-tap');
    const clickButton = flags.clickButton;
    if (clickButton && clickButton !== 'primary') {
      parts.push('--button', clickButton);
    }
    return;
  }
  if (action.command === 'swipe') {
    if (typeof flags.count === 'number') parts.push('--count', String(flags.count));
    if (typeof flags.pauseMs === 'number') parts.push('--pause-ms', String(flags.pauseMs));
    if (flags.pattern === 'one-way' || flags.pattern === 'ping-pong') {
      parts.push('--pattern', flags.pattern);
    }
    return;
  }
  if (action.command === 'gesture') {
    if (typeof flags.pointerCount === 'number') {
      parts.push('--pointer-count', String(flags.pointerCount));
    }
    return;
  }
  if (isTypingCommand(action.command) && typeof flags.delayMs === 'number') {
    parts.push('--delay-ms', String(flags.delayMs));
  }
}

export function appendRuntimeHintFlags(
  parts: string[],
  flags:
    | Pick<SessionAction, 'flags'>['flags']
    | {
        platform?: 'ios' | 'android';
        metroHost?: string;
        metroPort?: number;
        bundleUrl?: string;
        launchUrl?: string;
      }
    | undefined,
): void {
  if (!flags) return;
  if (flags.platform === 'ios' || flags.platform === 'android') {
    parts.push('--platform', flags.platform);
  }
  if (typeof flags.metroHost === 'string' && flags.metroHost.length > 0) {
    parts.push('--metro-host', formatScriptArgQuoteIfNeeded(flags.metroHost));
  }
  if (typeof flags.metroPort === 'number') {
    parts.push('--metro-port', String(flags.metroPort));
  }
  if (typeof flags.bundleUrl === 'string' && flags.bundleUrl.length > 0) {
    parts.push('--bundle-url', formatScriptArgQuoteIfNeeded(flags.bundleUrl));
  }
  if (typeof flags.launchUrl === 'string' && flags.launchUrl.length > 0) {
    parts.push('--launch-url', formatScriptArgQuoteIfNeeded(flags.launchUrl));
  }
}

export function appendRecordActionScriptArgs(parts: string[], action: SessionAction): void {
  const [subcommand, ...rest] = action.positionals ?? [];
  if (subcommand) {
    parts.push(formatScriptArgQuoteIfNeeded(subcommand));
  }
  for (const positional of rest) {
    parts.push(formatScriptArg(positional));
  }
  if (typeof action.flags?.fps === 'number') {
    parts.push('--fps', String(action.flags.fps));
  }
  if (typeof action.flags?.screenshotMaxSize === 'number') {
    parts.push('--max-size', String(action.flags.screenshotMaxSize));
  }
  if (typeof action.flags?.quality === 'number' || typeof action.flags?.quality === 'string') {
    parts.push('--quality', String(action.flags.quality));
  }
  if (action.flags?.hideTouches) {
    parts.push('--hide-touches');
  }
}

export function appendSnapshotActionScriptArgs(parts: string[], action: SessionAction): void {
  if (action.flags?.snapshotInteractiveOnly) parts.push('-i');
  if (typeof action.flags?.snapshotDepth === 'number') {
    parts.push('-d', String(action.flags.snapshotDepth));
  }
  if (action.flags?.snapshotScope) {
    parts.push('-s', formatScriptArg(action.flags.snapshotScope));
  }
  if (action.flags?.snapshotRaw) parts.push('--raw');
}

export function appendScreenshotActionScriptArgs(parts: string[], action: SessionAction): void {
  for (const positional of action.positionals ?? []) {
    parts.push(formatScriptArg(positional));
  }
  appendScreenshotScriptFlags(parts, action.flags);
}

export function appendRuntimeActionScriptArgs(
  parts: string[],
  action: SessionAction,
  options: { includeAllPositionals?: boolean } = {},
): void {
  const positionals = action.positionals ?? [];
  const selectedPositionals = options.includeAllPositionals ? positionals : positionals.slice(0, 1);
  for (const positional of selectedPositionals) {
    parts.push(formatScriptArgQuoteIfNeeded(positional));
  }
  appendRuntimeHintFlags(parts, action.flags);
}

export function appendGenericActionScriptArgs(parts: string[], action: SessionAction): void {
  for (const positional of action.positionals ?? []) {
    // wait @ref: recorded refs may carry a `~s<generation>` pin (#1076);
    // scripts store the plain ref (see stripRecordedRefGeneration).
    parts.push(
      formatScriptArg(
        action.command === 'wait' ? stripRecordedRefGeneration(positional) : positional,
      ),
    );
  }
  appendScriptSeriesFlags(parts, action);
}

// fallow-ignore-next-line complexity
export function parseReplaySeriesFlags(
  command: string,
  args: string[],
): { positionals: string[]; flags: SessionAction['flags'] } {
  const positionals: string[] = [];
  const flags: SessionAction['flags'] = {};

  const numericFlagMap = isClickLikeCommand(command)
    ? CLICK_LIKE_NUMERIC_FLAG_MAP
    : command === 'swipe'
      ? SWIPE_NUMERIC_FLAG_MAP
      : command === 'gesture'
        ? GESTURE_NUMERIC_FLAG_MAP
        : isTypingCommand(command)
          ? TYPING_NUMERIC_FLAG_MAP
          : undefined;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;

    if (isClickLikeCommand(command) && token === '--double-tap') {
      flags.doubleTap = true;
      continue;
    }
    const nextArg = args[index + 1];
    if (isClickLikeCommand(command) && token === '--button' && nextArg !== undefined) {
      const clickButton = nextArg;
      if (clickButton === 'primary' || clickButton === 'secondary' || clickButton === 'middle') {
        flags.clickButton = clickButton;
      }
      index += 1;
      continue;
    }

    const numericKey = numericFlagMap?.get(token);
    if (numericKey && nextArg !== undefined) {
      const parsed = parseNonNegativeIntToken(nextArg);
      if (parsed !== null) {
        flags[numericKey] = parsed;
        index += 1;
        continue;
      }
    }

    if (command === 'swipe' && token === '--pattern' && nextArg !== undefined) {
      const pattern = nextArg;
      if (pattern === 'one-way' || pattern === 'ping-pong') {
        flags.pattern = pattern;
      }
      index += 1;
      continue;
    }

    positionals.push(token);
  }

  return { positionals, flags };
}

// fallow-ignore-next-line complexity
export function parseReplayRuntimeFlags(args: string[]): {
  positionals: string[];
  flags: {
    platform?: 'ios' | 'android';
    metroHost?: string;
    metroPort?: number;
    bundleUrl?: string;
    launchUrl?: string;
  };
} {
  const positionals: string[] = [];
  const flags: {
    platform?: 'ios' | 'android';
    metroHost?: string;
    metroPort?: number;
    bundleUrl?: string;
    launchUrl?: string;
  } = {};

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    const nextArg = args[index + 1];
    if (token === '--platform' && nextArg !== undefined) {
      const platform = nextArg;
      if (platform === 'ios' || platform === 'android') {
        flags.platform = platform;
      }
      index += 1;
      continue;
    }
    if (token === '--metro-host' && nextArg !== undefined) {
      flags.metroHost = nextArg;
      index += 1;
      continue;
    }
    if (token === '--metro-port' && nextArg !== undefined) {
      const parsedPort = parseNonNegativeIntToken(nextArg);
      if (parsedPort !== null) {
        flags.metroPort = parsedPort;
      }
      index += 1;
      continue;
    }
    if (token === '--bundle-url' && nextArg !== undefined) {
      flags.bundleUrl = nextArg;
      index += 1;
      continue;
    }
    if (token === '--launch-url' && nextArg !== undefined) {
      flags.launchUrl = nextArg;
      index += 1;
      continue;
    }
    positionals.push(token);
  }

  return { positionals, flags };
}

function parseNonNegativeIntToken(token: string | undefined): number | null {
  if (!token) return null;
  const value = Number(token);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.floor(value);
}
