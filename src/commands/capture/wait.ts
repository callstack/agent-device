import type { CliFlags } from '@agent-device/contracts/command';
import { PUBLIC_COMMANDS } from '@agent-device/command-registry/catalog';
import type { WaitCommandOptions } from '@agent-device/contracts/client';
import { parseWaitPositionals } from '@agent-device/command-registry/wait-positionals';
import type { WaitParsed } from '@agent-device/command-registry/wait-positionals';
import { SELECTOR_SNAPSHOT_FLAGS } from '../cli-grammar/flag-groups.ts';
import { AppError } from '@agent-device/kernel/errors';
import { isValidSelectorExpression } from '@agent-device/selectors';
import { booleanField, enumField, integerField, stringField } from '../command-input.ts';
import { optionalEnum } from '../input-readers.ts';
import {
  direct,
  optionalNumber,
  selectionOptionsFromFlags,
  selectorSnapshotOptionsFromFlags,
} from '../cli-grammar/common.ts';
import type { CliReader, DaemonWriter } from '../cli-grammar/types.ts';
import { defineCommandFacet } from '../family/types.ts';
import { defineFieldCommandMetadata } from '../field-command-contract.ts';
import { messageOutput } from '../output-common.ts';
import { WAIT_KIND_VALUES } from './wait-command-contract.ts';
import { absenceCaptureOptionRefusal } from '../../core/absence-observation.ts';
import { absenceCaptureOptionError } from '../../core/absence-observation-errors.ts';

const WAIT_COMMAND_NAME = 'wait';

const waitCommandDescription =
  'Wait for a duration, text, snapshot ref, selector to appear, selector to be strictly absent, or stable UI. Use the strict absence target when zero selector matches are required; stable waits until the UI stays quiet for the requested window.';

const waitCommandMetadata = defineFieldCommandMetadata(WAIT_COMMAND_NAME, waitCommandDescription, {
  kind: enumField(WAIT_KIND_VALUES),
  durationMs: integerField(),
  text: stringField(),
  ref: stringField(),
  selector: stringField(),
  absent: stringField(),
  stable: booleanField(),
  quietMs: integerField(),
  timeoutMs: integerField(),
  depth: integerField(),
  scope: stringField(),
  raw: booleanField(),
});

const waitCliSchema = {
  usageOverride:
    'wait <ms>|text <text>|@ref|<selector>|absent <selector> [timeoutMs]|stable [quietMs] [timeoutMs]',
  positionalArgs: ['durationOrSelector', 'timeoutMs?'],
  allowsExtraPositionals: true,
  allowedFlags: [...SELECTOR_SNAPSHOT_FLAGS],
} as const;

export const waitCliReader: CliReader = (positionals, flags) =>
  readWaitOptionsFromPositionals(positionals, flags);

export const waitDaemonWriter: DaemonWriter = direct(PUBLIC_COMMANDS.wait, (input) =>
  waitPositionals(input as WaitCommandOptions),
);

export const waitCommandFacet = defineCommandFacet({
  name: WAIT_COMMAND_NAME,
  text: {
    summary: 'Wait for a duration, text, selector, strict absence, or stable UI',
  },
  metadata: waitCommandMetadata,
  run: (client, input) => client.command.wait(waitInputToOptions(input)),
  cliSchema: waitCliSchema,
  cliReader: waitCliReader,
  daemonWriter: waitDaemonWriter,
  cliOutputFormatter: messageOutput,
});

function waitInputToOptions(input: Record<string, unknown>): WaitCommandOptions {
  optionalEnum(input, 'kind', WAIT_KIND_VALUES);
  const options = { ...input };
  delete options.kind;
  return options as WaitCommandOptions & { kind?: never };
}

function readWaitOptionsFromPositionals(
  positionals: string[],
  flags: CliFlags,
): WaitCommandOptions {
  const parsed = parseWaitPositionals(positionals);
  if (!parsed) {
    throw new AppError(
      'INVALID_ARGS',
      'wait requires <ms>, text <text>, @ref, <selector> [timeoutMs], absent <selector> [timeoutMs], or stable [quietMs] [timeoutMs].',
    );
  }
  const base = {
    ...selectionOptionsFromFlags(flags),
    ...selectorSnapshotOptionsFromFlags(flags),
  };
  switch (parsed.kind) {
    case 'absent':
      return readAbsentWaitOptions(base, parsed);
    case 'sleep':
      return { ...base, durationMs: parsed.durationMs };
    case 'text':
      return readTextWaitOptions(base, parsed);
    case 'ref':
      return { ...base, ref: parsed.rawRef, ...readTimeoutOption(parsed.timeoutMs) };
    case 'stable':
      return {
        ...base,
        stable: true,
        ...readQuietOption(parsed.quietMs),
        ...readTimeoutOption(parsed.timeoutMs),
      };
    case 'invalid':
      throw new AppError('INVALID_ARGS', parsed.message);
    case 'selector':
      return {
        ...base,
        selector: parsed.selectorExpression,
        ...readTimeoutOption(parsed.timeoutMs),
      };
    default:
      return assertNever(parsed);
  }
}

type WaitCliBaseOptions = ReturnType<typeof selectionOptionsFromFlags> &
  ReturnType<typeof selectorSnapshotOptionsFromFlags>;

function readAbsentWaitOptions(
  base: WaitCliBaseOptions,
  parsed: Extract<WaitParsed, { kind: 'absent' }>,
): WaitCommandOptions {
  const refusedOption = absenceCaptureOptionRefusal(base);
  if (refusedOption) throw absenceCaptureOptionError(refusedOption, 'wait');
  return {
    ...base,
    absent: parsed.selectorExpression,
    ...readTimeoutOption(parsed.timeoutMs),
  };
}

function readTextWaitOptions(
  base: WaitCliBaseOptions,
  parsed: Extract<WaitParsed, { kind: 'text' }>,
): WaitCommandOptions {
  if (!parsed.text) throw new AppError('INVALID_ARGS', 'wait requires text.');
  return { ...base, text: parsed.text, ...readTimeoutOption(parsed.timeoutMs) };
}

// fallow-ignore-next-line complexity
function waitPositionals(options: WaitCommandOptions): string[] {
  const targets = [
    options.durationMs !== undefined ? 'durationMs' : undefined,
    options.text !== undefined ? 'text' : undefined,
    options.ref !== undefined ? 'ref' : undefined,
    options.selector !== undefined ? 'selector' : undefined,
    options.absent !== undefined ? 'absent' : undefined,
    options.stable !== undefined ? 'stable' : undefined,
  ].filter(Boolean);
  if (targets.length !== 1) {
    throw new AppError(
      'INVALID_ARGS',
      'wait command requires exactly one of durationMs, text, ref, selector, absent, or stable.',
    );
  }
  if (options.durationMs !== undefined) return [String(options.durationMs)];
  const timeout = optionalNumber(options.timeoutMs);
  if (options.text !== undefined) return ['text', options.text, ...timeout];
  if (options.ref !== undefined) return [options.ref, ...timeout];
  if (options.absent !== undefined) {
    const refusedOption = absenceCaptureOptionRefusal(options);
    if (refusedOption) throw absenceCaptureOptionError(refusedOption, 'wait');
    if (!isValidSelectorExpression(options.absent)) {
      throw new AppError('INVALID_ARGS', `Invalid wait absent selector: ${options.absent}`);
    }
    return ['absent', options.absent, ...timeout];
  }
  if (options.stable !== undefined) {
    const quiet = optionalNumber(options.quietMs);
    if (quiet.length === 0 && timeout.length > 0) {
      throw new AppError('INVALID_ARGS', 'wait stable requires quietMs before timeoutMs.');
    }
    return ['stable', ...quiet, ...timeout];
  }
  const selector = options.selector!;
  if (!isValidSelectorExpression(selector)) {
    throw new AppError('INVALID_ARGS', `Invalid wait selector: ${selector}`);
  }
  return [selector, ...timeout];
}

function readTimeoutOption(timeoutMs: number | null): { timeoutMs?: number } {
  return timeoutMs === null ? {} : { timeoutMs };
}

function readQuietOption(quietMs: number | null): { quietMs?: number } {
  return quietMs === null ? {} : { quietMs };
}

function assertNever(value: never): never {
  throw new Error(`Unsupported wait positional target: ${String(value)}`);
}
