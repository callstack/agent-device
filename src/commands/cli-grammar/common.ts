import type {
  ElementTarget,
  InteractionTarget,
  InternalRequestOptions,
} from '../../client/client-types.ts';
import { splitSelectorFromArgs } from '../../utils/selectors-parse.ts';
import type { CliFlags } from '../../cli/parser/cli-flags.ts';
import { AppError } from '../../kernel/errors.ts';
import { compactRecord, type SelectorSnapshotInput } from '../command-input.ts';
import type {
  DaemonWriter,
  SelectionOptions,
  DaemonCommandRequest,
  CommandInput,
} from './types.ts';

export function direct(
  command: string,
  positionals?: (input: CommandInput) => string[],
): DaemonWriter {
  return (input) => request(command, positionals ? positionals(input) : [], input);
}

export function request(
  command: string,
  positionals: string[],
  options: CommandInput,
): DaemonCommandRequest {
  return { command, positionals, options: normalizeCommonRequestOptions(options) };
}

function normalizeCommonRequestOptions(options: CommandInput): InternalRequestOptions {
  const normalizedTarget = readDeviceTarget(options.deviceTarget ?? options.target);
  if (normalizedTarget === undefined && options.target === undefined) {
    return options as InternalRequestOptions;
  }
  const { target: _target, ...rest } = options;
  return (
    normalizedTarget === undefined ? rest : { ...rest, target: normalizedTarget }
  ) as InternalRequestOptions;
}

function readDeviceTarget(value: unknown): InternalRequestOptions['target'] | undefined {
  return value === 'mobile' || value === 'tv' || value === 'desktop' ? value : undefined;
}

export function commonInputFromFlags(flags: CliFlags): Record<string, unknown> {
  return compactRecord({
    session: flags.session,
    platform: flags.platform,
    deviceTarget: flags.target,
    device: flags.device,
    udid: flags.udid,
    serial: flags.serial,
    iosSimulatorDeviceSet: flags.iosSimulatorDeviceSet,
    iosXctestrunFile: flags.iosXctestrunFile,
    iosXctestDerivedDataPath: flags.iosXctestDerivedDataPath,
    iosXctestEnvDir: flags.iosXctestEnvDir,
    androidDeviceAllowlist: flags.androidDeviceAllowlist,
  });
}

export function selectionOptionsFromFlags(flags: CliFlags): SelectionOptions {
  return {
    platform: flags.platform,
    target: flags.target,
    device: flags.device,
    udid: flags.udid,
    serial: flags.serial,
    iosSimulatorDeviceSet: flags.iosSimulatorDeviceSet,
    androidDeviceAllowlist: flags.androidDeviceAllowlist,
  };
}

export function selectorSnapshotInputFromFlags(flags: CliFlags): Record<string, unknown> {
  return compactRecord({
    depth: flags.snapshotDepth,
    scope: flags.snapshotScope,
    raw: flags.snapshotRaw,
  });
}

export function selectorSnapshotOptionsFromFlags(flags: CliFlags): SelectorSnapshotInput {
  return {
    depth: flags.snapshotDepth,
    scope: flags.snapshotScope,
    raw: flags.snapshotRaw,
  };
}

// Descriptor post-action observation commands use --settle (#1101).
// --timeout doubles as the settle deadline only when --settle is present; a
// bare --timeout stays compatible and is ignored by touch commands.
export function settleInputFromFlags(flags: CliFlags): Record<string, unknown> {
  return compactRecord({
    settle: flags.settle,
    settleQuietMs: flags.settleQuietMs,
    timeoutMs: flags.timeoutMs,
  });
}

export function repeatedInputFromFlags(flags: CliFlags): Record<string, unknown> {
  return compactRecord({
    count: flags.count,
    intervalMs: flags.intervalMs,
    holdMs: flags.holdMs,
    jitterPx: flags.jitterPx,
    doubleTap: flags.doubleTap,
  });
}

export function targetInputFromClientTarget(
  target: InteractionTarget | ElementTarget,
): Record<string, unknown> {
  if ('ref' in target && target.ref !== undefined) {
    return compactRecord({ kind: 'ref', ref: target.ref, label: target.label });
  }
  if ('selector' in target && target.selector !== undefined) {
    return { kind: 'selector', selector: target.selector };
  }
  const point = target as { x: number; y: number };
  return { kind: 'point', x: point.x, y: point.y };
}

export function interactionTargetPositionals(input: InteractionTarget | CommandInput): string[] {
  const target = readTargetRecord(input);
  if (typeof target.ref === 'string') return [target.ref, ...optionalTargetLabel(target.label)];
  if (typeof target.selector === 'string') return [target.selector];
  if (target.kind === 'point' || target.x !== undefined || target.y !== undefined) {
    return [
      String(requiredTargetNumber(target.x, 'x')),
      String(requiredTargetNumber(target.y, 'y')),
    ];
  }
  throw new AppError('INVALID_ARGS', 'interaction requires @ref, selector, or point target');
}

export function elementTargetPositionals(input: ElementTarget | CommandInput): string[] {
  const target = readTargetRecord(input);
  if (typeof target.ref === 'string') return [target.ref, ...optionalTargetLabel(target.label)];
  if (typeof target.selector === 'string') return [target.selector];
  throw new AppError('INVALID_ARGS', 'element command requires @ref or selector target');
}

function readTargetRecord(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new AppError('INVALID_ARGS', 'Expected target object.');
  }
  const record = input as Record<string, unknown>;
  const nestedTarget = record.target;
  if (nestedTarget && typeof nestedTarget === 'object' && !Array.isArray(nestedTarget)) {
    return nestedTarget as Record<string, unknown>;
  }
  return record;
}

function requiredTargetNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new AppError('INVALID_ARGS', `point target requires numeric ${field}.`);
  }
  return value;
}

function optionalTargetLabel(value: unknown): string[] {
  return typeof value === 'string' && value.length > 0 ? [value] : [];
}

export function readElementTargetFromPositionals(positionals: string[]): ElementTarget {
  if (positionals[0]?.startsWith('@')) {
    return { ref: positionals[0], label: optionalTrimmedText(positionals.slice(1)) };
  }
  const selector = positionals.join(' ').trim();
  if (!selector) throw new AppError('INVALID_ARGS', 'get requires @ref or selector expression');
  return { selector };
}

export function readGetFormat(value: string | undefined): 'text' | 'attrs' {
  if (value === 'text' || value === 'attrs') return value;
  throw new AppError('INVALID_ARGS', 'get only supports text or attrs');
}

export function splitRequiredSelector(
  positionals: string[],
  options: { preferTrailingValue?: boolean } = {},
) {
  const split = splitSelectorFromArgs(positionals, options);
  if (!split) throw new AppError('INVALID_ARGS', 'is requires a selector expression');
  return split;
}

export function readJsonObject(value: string, label: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {}
  throw new AppError('INVALID_ARGS', `${label} must be a JSON object`);
}

function optionalTrimmedText(values: string[]): string | undefined {
  const text = values.join(' ').trim();
  return text || undefined;
}

export function setOf<T extends string>(...values: T[]): ReadonlySet<T> {
  return new Set(values);
}

export function isOneOf<T extends string>(
  value: string | undefined,
  values: ReadonlySet<T>,
): value is T {
  return value !== undefined && values.has(value as T);
}

export function isFiniteNumberString(value: string | undefined): boolean {
  if (value === undefined || value.trim() === '') return false;
  return Number.isFinite(Number(value));
}

export function readFiniteNumber(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (Number.isFinite(parsed)) return parsed;
  throw new AppError('INVALID_ARGS', `${label} must be a finite number.`);
}

export function optionalCliNumber(value: string | undefined): number | undefined {
  return value === undefined ? undefined : Number(value);
}

export function optionalString(value: string | undefined): string[] {
  return value === undefined ? [] : [value];
}

export function optionalNumber(value: number | undefined): string[] {
  return value === undefined ? [] : [String(value)];
}

export function requiredString(value: string | undefined, message: string): string {
  if (value === undefined || value === '') throw new AppError('INVALID_ARGS', message);
  return value;
}

export function requiredDaemonString(value: unknown, message: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new AppError('INVALID_ARGS', message);
  }
  return value;
}
