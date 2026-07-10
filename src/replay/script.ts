import fs from 'node:fs';
import { AppError } from '../kernel/errors.ts';
import { recordingQualityInputToExportQuality } from '../core/recording-export-quality.ts';
import { readScreenshotScriptFlag } from '../contracts/screenshot.ts';
import type { DeviceTarget, PlatformSelector } from '../kernel/device.ts';
import { PLATFORM_SELECTORS, publicPlatformString } from '../kernel/device.ts';
import { parseReplayOpenFlags } from './open-script.ts';
import { formatPortableActionLine, formatTargetAnnotationLines } from './script-formatting.ts';
import type { SessionAction, SessionState } from '../daemon/types.ts';
import {
  formatScriptStringLiteral,
  isClickLikeCommand,
  parseReplaySeriesFlags,
  parseReplayRuntimeFlags,
  stripRecordedRefGeneration,
} from './script-utils.ts';
import { parseTargetAnnotationCommentLine } from './target-identity.ts';
import { REPLAY_VAR_KEY_RE } from './vars.ts';

// Replay metadata `context platform=` lines support every accepted `--platform`
// selector except 'web' (not yet a supported replay target). Legacy `ios`/`macos`
// and the collapsed `apple` selector all resolve through the same device-selection
// path — keep the type and the runtime allow-list derived from the canonical
// PLATFORM_SELECTORS source.
type ReplayScriptPlatform = Exclude<PlatformSelector, 'web'>;

export const REPLAY_METADATA_PLATFORMS = new Set<ReplayScriptPlatform>(
  PLATFORM_SELECTORS.filter((p): p is ReplayScriptPlatform => p !== 'web'),
);
const REPLAY_METADATA_TARGETS = new Set<DeviceTarget>(['mobile', 'tv', 'desktop']);

export type ReplayScriptMetadata = {
  platform?: ReplayScriptPlatform;
  target?: DeviceTarget;
  timeoutMs?: number;
  retries?: number;
  env?: Record<string, string>;
};

export type ParsedReplayScript = {
  actions: SessionAction[];
  actionLines: number[];
  /**
   * Per-action source file path, parallel to `actionLines`; `undefined` =
   * the top-level replay file. A Maestro action inlined from a `runFlow`
   * include carries the include's resolved path.
   */
  actionSourcePaths?: (string | undefined)[];
};

type PendingTargetAnnotation = { evidence: SessionAction['targetEvidence']; line: number };

// fallow-ignore-next-line complexity
export function parseReplayScriptDetailed(script: string): ParsedReplayScript {
  const actions: SessionAction[] = [];
  const actionLines: number[] = [];
  const lines = script.split(/\r?\n/);
  let sawAction = false;
  let pending: PendingTargetAnnotation | undefined;

  const rejectUnbound = (
    annotation: PendingTargetAnnotation,
    index: number,
    why: string,
  ): never => {
    throw new AppError(
      'INVALID_ARGS',
      `target-v1 annotation on line ${annotation.line} must be immediately followed by its action line (line ${index + 1} ${why}).`,
    );
  };

  for (const [index, rawLine] of lines.entries()) {
    const trimmed = rawLine.trim();
    if (trimmed.length === 0) {
      if (pending) rejectUnbound(pending, index, 'is blank');
      continue;
    }
    if (trimmed.startsWith('#')) {
      const annotation = parseTargetAnnotationCommentLine(trimmed);
      if (annotation.kind === 'v1') {
        if (pending) rejectUnbound(pending, index, 'is another target-v1 annotation');
        pending = { evidence: annotation.evidence, line: index + 1 };
        continue;
      }
      // An ordinary or future-target-vN comment still counts as an
      // intervening line for a pending annotation.
      if (pending) rejectUnbound(pending, index, 'is a comment');
      continue;
    }
    if (isReplayEnvLine(trimmed)) {
      if (pending) rejectUnbound(pending, index, 'is an env directive');
      if (sawAction) {
        throw new AppError(
          'INVALID_ARGS',
          `env directives must precede all actions (line ${index + 1}).`,
        );
      }
      continue;
    }
    const parsed = parseReplayScriptLine(rawLine);
    if (!parsed) {
      if (pending) rejectUnbound(pending, index, 'did not parse as an action');
      continue;
    }
    if (pending) {
      parsed.targetEvidence = pending.evidence;
      pending = undefined;
    }
    actions.push(parsed);
    actionLines.push(index + 1);
    sawAction = true;
  }
  if (pending) {
    throw new AppError(
      'INVALID_ARGS',
      `target-v1 annotation on line ${pending.line} must be immediately followed by its action line (end of script reached).`,
    );
  }
  return { actions, actionLines };
}

// fallow-ignore-next-line complexity
export function readReplayScriptMetadata(script: string): ReplayScriptMetadata {
  const lines = script.split(/\r?\n/);
  const metadata: ReplayScriptMetadata = {};
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    if (isReplayEnvLine(trimmed)) {
      ingestEnvLine(metadata, trimmed, index + 1);
      continue;
    }
    if (!trimmed.startsWith('context ')) break;
    const platformMatch = trimmed.match(/(?:^|\s)platform=([^\s]+)/);
    if (platformMatch) {
      const platform = platformMatch[1] as ReplayScriptPlatform | undefined;
      if (platform && REPLAY_METADATA_PLATFORMS.has(platform)) {
        assignReplayMetadataValue(metadata, 'platform', platform);
      }
    }
    const targetMatch = trimmed.match(/(?:^|\s)target=([^\s]+)/);
    if (targetMatch) {
      const target = targetMatch[1] as DeviceTarget | undefined;
      if (target && REPLAY_METADATA_TARGETS.has(target)) {
        assignReplayMetadataValue(metadata, 'target', target);
      }
    }
    const timeoutMatch = trimmed.match(/(?:^|\s)timeout=(\d+)/);
    if (timeoutMatch) {
      const timeoutMs = Number(timeoutMatch[1]);
      if (Number.isFinite(timeoutMs) && timeoutMs >= 1) {
        assignReplayMetadataValue(metadata, 'timeoutMs', Math.floor(timeoutMs));
      }
    }
    const retriesMatch = trimmed.match(/(?:^|\s)retries=(\d+)/);
    if (retriesMatch) {
      const retries = Number(retriesMatch[1]);
      if (Number.isFinite(retries) && retries >= 0) {
        assignReplayMetadataValue(metadata, 'retries', Math.floor(retries));
      }
    }
  }
  return metadata;
}

function isReplayEnvLine(trimmed: string): boolean {
  return trimmed === 'env' || trimmed.startsWith('env ') || trimmed.startsWith('env\t');
}

function parseReplayEnvLine(trimmed: string, lineNumber: number): { key: string; value: string } {
  const body = trimmed.slice(3).replace(/^[\s]+/, '');
  const eqIndex = body.indexOf('=');
  if (eqIndex <= 0) {
    throw new AppError(
      'INVALID_ARGS',
      `Invalid env directive on line ${lineNumber}: expected "env KEY=VALUE".`,
    );
  }
  const key = body.slice(0, eqIndex);
  if (!REPLAY_VAR_KEY_RE.test(key)) {
    throw new AppError(
      'INVALID_ARGS',
      `Invalid env key "${key}" on line ${lineNumber}: keys must be uppercase letters, digits, and underscores (e.g. APP_ID).`,
    );
  }
  if (key.startsWith('AD_')) {
    throw new AppError(
      'INVALID_ARGS',
      `Invalid env key "${key}" on line ${lineNumber}: the AD_* namespace is reserved for built-in variables. Rename ${key} to avoid the AD_ prefix.`,
    );
  }
  const rawValue = body.slice(eqIndex + 1);
  const value = decodeReplayEnvValue(rawValue, lineNumber);
  return { key, value };
}

function decodeReplayEnvValue(raw: string, lineNumber: number): string {
  if (raw.length === 0) return '';
  if (raw.startsWith('"')) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed !== 'string') {
        throw new Error('not a string literal');
      }
      return parsed;
    } catch {
      throw new AppError('INVALID_ARGS', `Invalid quoted env value on line ${lineNumber}.`);
    }
  }
  return raw;
}

function ingestEnvLine(metadata: ReplayScriptMetadata, trimmed: string, lineNumber: number): void {
  const { key, value } = parseReplayEnvLine(trimmed, lineNumber);
  const env = metadata.env ?? {};
  if (Object.prototype.hasOwnProperty.call(env, key)) {
    throw new AppError('INVALID_ARGS', `Duplicate env directive "${key}" on line ${lineNumber}.`);
  }
  env[key] = value;
  metadata.env = env;
}

function assignReplayMetadataValue<Key extends keyof ReplayScriptMetadata>(
  metadata: ReplayScriptMetadata,
  key: Key,
  value: NonNullable<ReplayScriptMetadata[Key]>,
): void {
  const previous = metadata[key];
  if (previous !== undefined) {
    const duplicateMessage =
      previous === value
        ? `Duplicate replay test metadata "${key}" in context header.`
        : `Conflicting replay test metadata "${key}" in context header: ${String(previous)} vs ${String(value)}.`;
    throw new AppError('INVALID_ARGS', duplicateMessage);
  }
  metadata[key] = value as ReplayScriptMetadata[Key];
}

// fallow-ignore-next-line complexity
function parseReplayScriptLine(line: string): SessionAction | null {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.startsWith('#')) return null;
  const tokens = tokenizeReplayLine(trimmed);
  const [command, ...args] = tokens;
  if (command === undefined) return null;
  if (command === 'context') return null;

  const action: SessionAction = {
    ts: Date.now(),
    command,
    positionals: [],
    flags: {},
  };

  if (command === 'snapshot') {
    action.positionals = [];
    for (let index = 0; index < args.length; index += 1) {
      const token = args[index];
      if (token === '-i') {
        action.flags.snapshotInteractiveOnly = true;
        continue;
      }
      if (token === '-c') {
        continue;
      }
      if (token === '--raw') {
        action.flags.snapshotRaw = true;
        continue;
      }
      if (token === '--force-full') {
        action.flags.snapshotForceFull = true;
        continue;
      }
      if ((token === '-d' || token === '--depth') && index + 1 < args.length) {
        const parsedDepth = Number(args[index + 1]);
        if (Number.isFinite(parsedDepth) && parsedDepth >= 0) {
          action.flags.snapshotDepth = Math.floor(parsedDepth);
        }
        index += 1;
        continue;
      }
      if ((token === '-s' || token === '--scope') && index + 1 < args.length) {
        action.flags.snapshotScope = args[index + 1];
        index += 1;
        continue;
      }
      if (token === '--backend' && index + 1 < args.length) {
        // Backward compatibility: ignore legacy snapshot backend token.
        index += 1;
        continue;
      }
    }
    return action;
  }

  if (command === 'open') {
    const parsed = parseReplayOpenFlags(args);
    action.positionals = parsed.positionals;
    Object.assign(action.flags, parsed.flags);
    action.runtime = parsed.runtime;
    return action;
  }

  if (command === 'runtime') {
    const parsed = parseReplayRuntimeFlags(args);
    action.positionals = parsed.positionals;
    Object.assign(action.flags, parsed.flags);
    return action;
  }

  if (isClickLikeCommand(command)) {
    const parsed = parseReplaySeriesFlags(command, args);
    Object.assign(action.flags, parsed.flags);
    const target = parsed.positionals[0];
    if (target === undefined) return action;
    if (target.startsWith('@')) {
      // Recorded refs may carry a `~s<generation>` pin — strip and IGNORE it
      // (see stripRecordedRefGeneration: generations are session-scoped).
      action.positionals = [stripRecordedRefGeneration(target)];
      if (parsed.positionals[1]) {
        action.result = { refLabel: parsed.positionals[1] };
      }
      return action;
    }
    const maybeX = parsed.positionals[0];
    const maybeY = parsed.positionals[1];
    if (isNumericToken(maybeX) && isNumericToken(maybeY) && parsed.positionals.length >= 2) {
      action.positionals = [maybeX, maybeY];
      return action;
    }
    action.positionals = [parsed.positionals.join(' ')];
    return action;
  }

  if (command === 'fill') {
    const parsed = parseReplaySeriesFlags(command, args);
    Object.assign(action.flags, parsed.flags);
    if (!hasFillTargetAndText(parsed.positionals)) {
      action.positionals = parsed.positionals;
      return action;
    }
    const [target, text, ...textRest] = parsed.positionals;
    if (target.startsWith('@')) {
      const ref = stripRecordedRefGeneration(target);
      if (textRest.length > 0) {
        action.positionals = [ref, textRest.join(' ')];
        action.result = { refLabel: text };
        return action;
      }
      action.positionals = [ref, text];
      return action;
    }
    action.positionals = [target, [text, ...textRest].join(' ')];
    return action;
  }

  if (command === 'get') {
    const sub = args[0];
    const target = args[1];
    if (sub === undefined || target === undefined) {
      action.positionals = args;
      return action;
    }
    if (target.startsWith('@')) {
      action.positionals = [sub, stripRecordedRefGeneration(target)];
      if (args[2]) {
        action.result = { refLabel: args[2] };
      }
      return action;
    }
    action.positionals = [sub, args.slice(1).join(' ')];
    return action;
  }

  if (command === 'swipe' || command === 'type') {
    const parsed = parseReplaySeriesFlags(command, args);
    Object.assign(action.flags, parsed.flags);
    action.positionals = parsed.positionals;
    return action;
  }

  if (command === 'record') {
    const positionals: string[] = [];
    for (let index = 0; index < args.length; index += 1) {
      const token = args[index]!;
      if (token === '--hide-touches') {
        action.flags.hideTouches = true;
        continue;
      }
      if (token === '--fps' && index + 1 < args.length) {
        const parsedFps = Number(args[index + 1]);
        if (Number.isFinite(parsedFps)) {
          action.flags.fps = Math.floor(parsedFps);
        }
        index += 1;
        continue;
      }
      if (token === '--quality' && index + 1 < args.length) {
        const value = args[index + 1]!;
        const exportQuality = recordingQualityInputToExportQuality(value);
        if (exportQuality !== undefined) {
          action.flags.quality = exportQuality;
        }
        index += 1;
        continue;
      }
      if (token === '--max-size' && index + 1 < args.length) {
        const parsedMaxSize = Number(args[index + 1]);
        if (Number.isFinite(parsedMaxSize)) {
          action.flags.screenshotMaxSize = Math.floor(parsedMaxSize);
        }
        index += 1;
        continue;
      }
      positionals.push(token);
    }
    action.positionals = positionals;
    return action;
  }

  if (command === 'screenshot') {
    const positionals: string[] = [];
    for (let index = 0; index < args.length; index += 1) {
      const token = args[index]!;
      const screenshotFlag = readScreenshotScriptFlag({ args, index, flags: action.flags });
      if (screenshotFlag.handled) {
        index = screenshotFlag.nextIndex;
        continue;
      }
      positionals.push(token);
    }
    action.positionals = positionals;
    return action;
  }

  // wait @ref [timeout] and longpress @ref [durationMs] flow through this
  // generic branch: strip recorded generation pins like the branches above.
  action.positionals =
    command === 'wait' || command === 'longpress'
      ? args.map((token) => stripRecordedRefGeneration(token))
      : args;
  return action;
}

function hasFillTargetAndText(positionals: string[]): positionals is [string, string, ...string[]] {
  return positionals.length >= 2;
}

function isNumericToken(token: string | undefined): token is string {
  if (!token) return false;
  return !Number.isNaN(Number(token));
}

function tokenizeReplayLine(line: string): string[] {
  const tokens: string[] = [];
  let cursor = 0;
  while (cursor < line.length) {
    cursor = skipReplayWhitespace(line, cursor);
    if (cursor >= line.length) break;
    const parsed =
      line[cursor] === '"'
        ? readQuotedReplayToken(line, cursor)
        : readBareReplayToken(line, cursor);
    tokens.push(parsed.value);
    cursor = parsed.nextCursor;
  }
  return tokens;
}

function skipReplayWhitespace(line: string, cursor: number): number {
  let nextCursor = cursor;
  while (nextCursor < line.length && /\s/.test(line.charAt(nextCursor))) {
    nextCursor += 1;
  }
  return nextCursor;
}

function readQuotedReplayToken(
  line: string,
  cursor: number,
): { value: string; nextCursor: number } {
  const tokenStart = cursor + 1;
  let escaped = false;
  let end = tokenStart;
  for (; end < line.length; end += 1) {
    const char = line.charAt(end);
    if (char === '"' && !escaped) break;
    if (escaped) {
      escaped = false;
      continue;
    }
    escaped = char === '\\';
  }
  if (end >= line.length) {
    throw new AppError('INVALID_ARGS', `Invalid replay script line: ${line}`);
  }
  return {
    value: JSON.parse(line.slice(cursor, end + 1)) as string,
    nextCursor: end + 1,
  };
}

function readBareReplayToken(line: string, cursor: number): { value: string; nextCursor: number } {
  let end = cursor;
  while (end < line.length && !/\s/.test(line.charAt(end))) {
    end += 1;
  }
  return { value: line.slice(cursor, end), nextCursor: end };
}

export function writeReplayScript(
  filePath: string,
  actions: SessionAction[],
  session?: SessionState,
) {
  const lines: string[] = [];
  // Session can be missing if the replay session is closed/deleted between execution and update write.
  // In that case we still persist healed actions and omit only the context header.
  if (session) {
    const kind = session.device.kind ? ` kind=${session.device.kind}` : '';
    const target = session.device.target ? ` target=${session.device.target}` : '';
    // approach (b): heal-write the PUBLIC leaf platform (ios/macos), never the
    // internal `apple` — keeps healed `.ad` scripts byte-compatible with checked-in
    // fixtures and machine consumers.
    lines.push(
      `context platform=${publicPlatformString(session.device)}${target} device=${formatScriptStringLiteral(session.device.name)}${kind} theme=unknown`,
    );
  }
  for (const action of actions) {
    // ADR 0012 decision 3: rewrites preserve v1 annotations in canonical form.
    lines.push(...formatTargetAnnotationLines(action));
    lines.push(formatReplayActionLine(action));
  }
  const serialized = `${lines.join('\n')}\n`;
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, serialized);
  fs.renameSync(tmpPath, filePath);
}

function formatReplayActionLine(action: SessionAction): string {
  return formatPortableActionLine(action, { runtimeIncludeAllPositionals: true });
}
