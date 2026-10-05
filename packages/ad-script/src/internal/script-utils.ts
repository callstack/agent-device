import type { SessionAction } from '@agent-device/contracts/session';
import type { SessionRuntimeHints } from '@agent-device/kernel/contracts';
import { appendScreenshotScriptFlags } from '@agent-device/contracts/capture';
import { splitRefGenerationSuffix } from '@agent-device/kernel/snapshot';

const SCRIPT_RUNTIME_PLATFORMS = {
  ios: true,
  android: true,
  harmonyos: true,
} satisfies Record<NonNullable<SessionRuntimeHints['platform']>, true>;

function isScriptRuntimePlatform(
  value: unknown,
): value is NonNullable<SessionRuntimeHints['platform']> {
  return typeof value === 'string' && Object.hasOwn(SCRIPT_RUNTIME_PLATFORMS, value);
}

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
// A token may not start with `'`: the tokenizer reads a leading `'` as a
// single-quoted literal (#3197), so the writer must quote such values or the
// re-parse would strip the apostrophe.
const BARE_SCRIPT_TOKEN_RE = /^[^\s"'\\][^\s"\\]*$/;

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

/**
 * `scroll`'s stop condition, in the script grammar beside its `recorded: true`
 * declaration (#3197): the hunt for an off-screen element IS the step, so a
 * recorded `scroll down --until <selector>` carries it and a hand-written script
 * can say the same. Without this the tokens fall through as positionals and the
 * daemon reads `--until` as the scroll amount. Distance stays a positional
 * (`scroll down 0.8`): `--pixels` and `--duration-ms` are `recorded: false`, and a
 * script grammar that accepted a flag the recorder cannot carry would write a line
 * the recording path could never reproduce.
 */
const SCROLL_SCRIPT_FLAG_MAP = new Map<string, ScriptFlagEntry>([
  ['--until', { key: 'until', kind: 'string' }],
]);

/**
 * `wait`'s capture-scope flags (#3197): the command declares them
 * (`SELECTOR_SNAPSHOT_FLAGS`) and they are recorded, so the script grammar
 * recognizes them too. Otherwise they land inside the positional list and the
 * wait parser refuses the line as selector-shaped text. Long spellings only:
 * this is the spelling the writer emits for `wait`, so nothing the recorder can
 * write needs an alias, and matching `-d`/`-s` would reclassify realistic
 * waited text (`wait text -s so funny`) to buy almost nothing — the only line
 * losing its old reading is one whose whole token is a literal long flag word,
 * which a hand-written script can spell with the selector wrapped instead.
 */
const WAIT_SCRIPT_FLAG_MAP = new Map<string, ScriptFlagEntry>([
  ['--raw', { key: 'snapshotRaw', kind: 'boolean' }],
  ['--depth', { key: 'snapshotDepth', kind: 'int' }],
  ['--scope', { key: 'snapshotScope', kind: 'string' }],
]);

/** How one script flag token carries its value. */
type ScriptFlagEntry = {
  key: 'until' | 'snapshotRaw' | 'snapshotDepth' | 'snapshotScope';
  kind: 'boolean' | 'int' | 'string';
};

/** The commands whose script line carries flags (`scroll`, `wait`). */
export type ScriptFlagCommand = 'scroll' | 'wait';

/** Which script flag tokens each flag-carrying command reads. */
const SCRIPT_FLAG_MAPS: Record<ScriptFlagCommand, Map<string, ScriptFlagEntry>> = {
  scroll: SCROLL_SCRIPT_FLAG_MAP,
  wait: WAIT_SCRIPT_FLAG_MAP,
};

/** The commands whose script line carries flags, derived from the parse tables. */
export const SCRIPT_FLAG_COMMANDS = Object.keys(SCRIPT_FLAG_MAPS) as readonly ScriptFlagCommand[];

/**
 * The script flag tokens one command's line reads, with their value kinds and flag keys
 * (#3197). Exported for the root admission test
 * (`src/commands/replay/script-flag-admission.test.ts`), which proves the tables and the
 * flag declarations admit the same keys in both directions — the invariant that keeps the
 * script grammar and the flag declarations from diverging the way `--until` and
 * `wait --raw` did.
 */
export function scriptFlagEntries(
  command: string,
): ReadonlyArray<{ token: string } & ScriptFlagEntry> {
  const flagMap = scriptFlagMapFor(command);
  if (!flagMap) return [];
  return [...flagMap].map(([token, entry]) => ({ token, ...entry }));
}

function scriptFlagMapFor(command: string): Map<string, ScriptFlagEntry> | undefined {
  return isScriptFlagCommand(command) ? SCRIPT_FLAG_MAPS[command] : undefined;
}

// Membership comes from the tables' own keys, so a third command cannot compile into the
// type while the guard silently refuses to read its flags.
function isScriptFlagCommand(command: string): command is ScriptFlagCommand {
  return (SCRIPT_FLAG_COMMANDS as readonly string[]).includes(command);
}

/**
 * Splits a `scroll` or `wait` script line into positionals and the command's own
 * flags (#3197). A token is a flag only when it names one of the command's
 * declared script flags and, for a value kind, a value token follows; anything
 * else stays positional, so a hand-written target or text value is untouched.
 */
export function parseReplayCommandFlags(
  command: ScriptFlagCommand,
  args: string[],
): { positionals: string[]; flags: SessionAction['flags'] } {
  const positionals: string[] = [];
  const flags: SessionAction['flags'] = {};
  const flagMap = SCRIPT_FLAG_MAPS[command];

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    const entry = flagMap.get(token);
    const nextArg = args[index + 1];
    if (entry === undefined || (entry.kind !== 'boolean' && nextArg === undefined)) {
      positionals.push(token);
      continue;
    }
    if (entry.kind === 'boolean') {
      Object.assign(flags, { [entry.key]: true });
      continue;
    }
    if (entry.kind === 'int') {
      const parsed = parseNonNegativeIntToken(nextArg);
      if (parsed === null) {
        positionals.push(token);
        continue;
      }
      Object.assign(flags, { [entry.key]: parsed });
    } else {
      Object.assign(flags, { [entry.key]: nextArg });
    }
    index += 1;
  }

  return { positionals, flags };
}

export function isClickLikeCommand(command: string): command is 'click' | 'press' {
  return command === 'click' || command === 'press';
}

export function isTouchTargetCommand(
  command: string,
): command is 'click' | 'press' | 'longpress' | 'hover' {
  return isClickLikeCommand(command) || command === 'longpress' || command === 'hover';
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

type DivergenceActionLabelInput = {
  command: string;
  positionals: readonly string[];
};

/**
 * Action summary safe for the divergence report / user-facing failure text.
 * For typing commands the typed value is categorically dropped and replaced
 * with a `<text>` marker — fill text is never serialized (ADR 0012), not
 * merely redacted-if-secret-shaped. The target (selector / @ref / point)
 * still shows so the caller can see WHICH field failed.
 */
export function formatDivergenceActionLabel(action: DivergenceActionLabelInput): string {
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
function divergenceTypingTargetTokens(action: DivergenceActionLabelInput): string[] {
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
  flags: Pick<SessionAction, 'flags'>['flags'] | SessionRuntimeHints | undefined,
): void {
  if (!flags) return;
  if (isScriptRuntimePlatform(flags.platform)) {
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
  const cropOn = action.flags?.screenshotCropOn;
  if (typeof cropOn === 'string' && cropOn.length > 0) {
    parts.push('--crop-on', formatScriptArgQuoteIfNeeded(cropOn));
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
  if (action.command === 'fold' && action.flags?.keyframes !== undefined) {
    parts.push('--keyframes', formatScriptArg(action.flags.keyframes));
  }
  // #3197: `scroll`'s stop condition is part of the step's meaning, so the writer
  // emits it beside the parser that reads it back. Only `--until` is declared
  // recorded, so only `--until` can arrive here on a recorded action.
  if (action.command === 'scroll' && typeof action.flags?.until === 'string') {
    parts.push('--until', formatScriptArg(action.flags.until));
  }
  if (action.command === 'wait') {
    appendWaitSnapshotScriptFlags(parts, action.flags);
  }
  appendScriptSeriesFlags(parts, action);
}

/**
 * `wait`'s capture-scope flags, written back in the long spelling its script
 * parser reads (`SELECTOR_SNAPSHOT_FLAGS`, all declared recorded).
 */
function appendWaitSnapshotScriptFlags(
  parts: string[],
  flags: SessionAction['flags'] | undefined,
): void {
  if (!flags) return;
  if (flags.snapshotRaw === true) parts.push('--raw');
  if (typeof flags.snapshotDepth === 'number') parts.push('--depth', String(flags.snapshotDepth));
  if (typeof flags.snapshotScope === 'string') {
    parts.push('--scope', formatScriptArg(flags.snapshotScope));
  }
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
    if (command === 'fold' && token === '--keyframes' && nextArg !== undefined) {
      flags.keyframes = nextArg;
      index += 1;
      continue;
    }
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
  flags: SessionRuntimeHints;
} {
  const positionals: string[] = [];
  const flags: SessionRuntimeHints = {};

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    const nextArg = args[index + 1];
    if (token === '--platform' && nextArg !== undefined) {
      const platform = nextArg;
      if (isScriptRuntimePlatform(platform)) {
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
