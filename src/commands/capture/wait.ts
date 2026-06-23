import { PUBLIC_COMMANDS } from '../../command-catalog.ts';
import type { WaitCommandOptions } from '../../client-types.ts';
import { parseWaitPositionals } from '../../core/wait-positionals.ts';
import { SELECTOR_SNAPSHOT_FLAGS, type CliFlags } from '../../utils/cli-flags.ts';
import { AppError } from '../../utils/errors.ts';
import { tryParseSelectorChain } from '../../utils/selectors-parse.ts';
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
  selectionOptionsFromFlags,
  selectorSnapshotOptionsFromFlags,
} from '../cli-grammar/common.ts';
import type { CliReader, DaemonWriter } from '../cli-grammar/types.ts';
import { defineCommandFacet } from '../family/types.ts';
import { defineFieldCommandMetadata } from '../field-command-contract.ts';
import { messageOutput } from '../output-common.ts';
import { WAIT_KIND_VALUES } from './wait-command-contract.ts';

const WAIT_COMMAND_NAME = 'wait';

const waitCommandDescription = 'Wait for duration, text, ref, or selector.';

const waitCommandMetadata = defineFieldCommandMetadata(WAIT_COMMAND_NAME, waitCommandDescription, {
  kind: enumField(WAIT_KIND_VALUES),
  durationMs: integerField(),
  text: stringField(),
  ref: stringField(),
  selector: stringField(),
  timeoutMs: integerField(),
  depth: integerField(),
  scope: stringField(),
  raw: booleanField(),
});

const waitCommandDefinition = defineExecutableCommand(waitCommandMetadata, (client, input) =>
  client.command.wait(waitInputToOptions(input)),
);

const waitCliSchema = {
  usageOverride: 'wait <ms>|text <text>|@ref|<selector> [timeoutMs]',
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
      'wait requires <ms>, text <text>, @ref, or <selector> [timeoutMs].',
    );
  }
  const base = {
    ...selectionOptionsFromFlags(flags),
    ...selectorSnapshotOptionsFromFlags(flags),
  };
  if (parsed.kind === 'sleep') return { ...base, durationMs: parsed.durationMs };
  if (parsed.kind === 'text') {
    if (!parsed.text) throw new AppError('INVALID_ARGS', 'wait requires text.');
    return { ...base, text: parsed.text, ...readTimeoutOption(parsed.timeoutMs) };
  }
  if (parsed.kind === 'ref') {
    return { ...base, ref: parsed.rawRef, ...readTimeoutOption(parsed.timeoutMs) };
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
  ].filter(Boolean);
  if (targets.length !== 1) {
    throw new AppError(
      'INVALID_ARGS',
      'wait command requires exactly one of durationMs, text, ref, or selector.',
    );
  }
  if (options.durationMs !== undefined) return [String(options.durationMs)];
  const timeout = optionalNumber(options.timeoutMs);
  if (options.text !== undefined) return ['text', options.text, ...timeout];
  if (options.ref !== undefined) return [options.ref, ...timeout];
  const selector = options.selector!;
  if (!tryParseSelectorChain(selector)) {
    throw new AppError('INVALID_ARGS', `Invalid wait selector: ${selector}`);
  }
  return [selector, ...timeout];
}

function readTimeoutOption(timeoutMs: number | null): { timeoutMs?: number } {
  return timeoutMs === null ? {} : { timeoutMs };
}
