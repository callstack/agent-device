import { PUBLIC_COMMANDS } from '../../command-catalog.ts';
import type { WaitCommandOptions } from '../../client/client-types.ts';
import { parseWaitPositionals } from '../../core/wait-positionals.ts';
import { SELECTOR_SNAPSHOT_FLAGS } from '../cli-grammar/flag-groups.ts';
import { type CliFlags } from '../cli-grammar/flag-types.ts';
import { AppError } from '../../kernel/errors.ts';
import { tryParseSelectorChain } from '../../selectors/parse.ts';
import {
  booleanField,
  enumField,
  integerField,
  optionalEnum,
  stringField,
} from '../command-input.ts';
import { defineExecutableCommand } from '../command-contract.ts';
import {
  direct,
  optionalNumber,
  recordControlInputFromFlags,
  selectionOptionsFromFlags,
  selectorSnapshotOptionsFromFlags,
} from '../cli-grammar/common.ts';
import type { CliReader, DaemonWriter } from '../cli-grammar/types.ts';
import { defineCommandFacet } from '../family/types.ts';
import { defineFieldCommandMetadata } from '../field-command-contract.ts';
import { messageOutput } from '../output-common.ts';
import { WAIT_KIND_VALUES } from './wait-command-contract.ts';

const WAIT_COMMAND_NAME = 'wait';

const waitCommandDescription = 'Wait for duration, text, ref, selector, or stable UI.';

const waitCommandMetadata = defineFieldCommandMetadata(WAIT_COMMAND_NAME, waitCommandDescription, {
  kind: enumField(WAIT_KIND_VALUES),
  durationMs: integerField(),
  text: stringField(),
  ref: stringField(),
  selector: stringField(),
  stable: booleanField(),
  quietMs: integerField(),
  timeoutMs: integerField(),
  depth: integerField(),
  scope: stringField(),
  raw: booleanField(),
});

const waitCommandDefinition = defineExecutableCommand(waitCommandMetadata, (client, input) =>
  client.command.wait(waitInputToOptions(input)),
);

const waitCliSchema = {
  usageOverride: 'wait <ms>|text <text>|@ref|<selector>|stable [quietMs] [timeoutMs]',
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
  metadata: waitCommandMetadata,
  definition: waitCommandDefinition,
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
      'wait requires <ms>, text <text>, @ref, <selector> [timeoutMs], or stable [quietMs] [timeoutMs].',
    );
  }
  const base = {
    ...selectionOptionsFromFlags(flags),
    ...selectorSnapshotOptionsFromFlags(flags),
    ...recordControlInputFromFlags(flags),
  };
  if (parsed.kind === 'sleep') return { ...base, durationMs: parsed.durationMs };
  if (parsed.kind === 'text') {
    if (!parsed.text) throw new AppError('INVALID_ARGS', 'wait requires text.');
    return { ...base, text: parsed.text, ...readTimeoutOption(parsed.timeoutMs) };
  }
  if (parsed.kind === 'ref') {
    return { ...base, ref: parsed.rawRef, ...readTimeoutOption(parsed.timeoutMs) };
  }
  if (parsed.kind === 'stable') {
    return {
      ...base,
      stable: true,
      ...readQuietOption(parsed.quietMs),
      ...readTimeoutOption(parsed.timeoutMs),
    };
  }
  return {
    ...base,
    selector: parsed.selectorExpression,
    ...readTimeoutOption(parsed.timeoutMs),
  };
}

// fallow-ignore-next-line complexity
function waitPositionals(options: WaitCommandOptions): string[] {
  const targets = [
    options.durationMs !== undefined ? 'durationMs' : undefined,
    options.text !== undefined ? 'text' : undefined,
    options.ref !== undefined ? 'ref' : undefined,
    options.selector !== undefined ? 'selector' : undefined,
    options.stable !== undefined ? 'stable' : undefined,
  ].filter(Boolean);
  if (targets.length !== 1) {
    throw new AppError(
      'INVALID_ARGS',
      'wait command requires exactly one of durationMs, text, ref, selector, or stable.',
    );
  }
  if (options.durationMs !== undefined) return [String(options.durationMs)];
  const timeout = optionalNumber(options.timeoutMs);
  if (options.text !== undefined) return ['text', options.text, ...timeout];
  if (options.ref !== undefined) return [options.ref, ...timeout];
  if (options.stable !== undefined) {
    const quiet = optionalNumber(options.quietMs);
    if (quiet.length === 0 && timeout.length > 0) {
      throw new AppError('INVALID_ARGS', 'wait stable requires quietMs before timeoutMs.');
    }
    return ['stable', ...quiet, ...timeout];
  }
  const selector = options.selector!;
  if (!tryParseSelectorChain(selector)) {
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
