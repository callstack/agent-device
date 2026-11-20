import type { ClipboardCommandOptions } from '@agent-device/contracts/client';
import { AppError } from '@agent-device/kernel/errors';
import type { CommandSchemaOverride } from '@agent-device/command-registry/command-schema';
import { commonInputFromFlags, direct } from '../cli-grammar/common.ts';
import type { CliReader, DaemonWriter } from '../cli-grammar/types.ts';
import {
  constSchema,
  enumField,
  readFieldInput,
  requiredField,
  stringField,
} from '../command-input.ts';
import { defineCommandFacet } from '../family/types.ts';
import { defineFieldCommandMetadata } from '../field-command-contract.ts';

const CLIPBOARD_COMMAND_NAME = 'clipboard';

const CLIPBOARD_ACTION_VALUES = ['read', 'write'] as const;

const clipboardCommandDescription =
  'Read the current device clipboard text, or replace its contents with the given text. Android runs both through the clipboard service shell command, and a build that implements none (Android 16 does not) refuses with UNSUPPORTED_OPERATION rather than reporting an empty clipboard.';

// `clipboard read` prints the clipboard content verbatim, so its warnings belong on stderr.
const clipboardFields = {
  action: requiredField(enumField(CLIPBOARD_ACTION_VALUES)),
  text: stringField(
    'Text for write; required for write ("" clears the clipboard), refused for read.',
    {
      allowEmpty: true,
    },
  ),
};

const clipboardFieldMetadata = defineFieldCommandMetadata(
  CLIPBOARD_COMMAND_NAME,
  clipboardCommandDescription,
  clipboardFields,
  {
    parseableOutput: true,
    readInput: (input: unknown) => {
      const { action, text, ...common } = readFieldInput(input, clipboardFields);
      if (action === 'read') {
        if (text !== undefined) {
          throw new AppError('INVALID_ARGS', 'clipboard read does not accept text.');
        }
        return { ...common, action };
      }
      if (text === undefined) {
        throw new AppError('INVALID_ARGS', 'clipboard write requires text (use "" to clear).');
      }
      return { ...common, action, text };
    },
  },
);

const clipboardCommandMetadata = {
  ...clipboardFieldMetadata,
  inputSchema: {
    ...clipboardFieldMetadata.inputSchema,
    oneOf: [
      { properties: { action: constSchema('write') }, required: ['text'] },
      { properties: { action: constSchema('read') }, not: { required: ['text'] } },
    ],
  },
};

const clipboardCliSchema = {
  usageOverride: 'clipboard read | clipboard write <text>',
  listUsageOverride: 'clipboard read | clipboard write <text>',
  positionalArgs: ['read|write', 'text?'],
  allowsExtraPositionals: true,
} as const satisfies CommandSchemaOverride;

export const clipboardCliReader: CliReader = (positionals, flags) => ({
  ...commonInputFromFlags(flags),
  ...readClipboardInput(positionals),
});

export const clipboardDaemonWriter: DaemonWriter = direct(CLIPBOARD_COMMAND_NAME, (input) =>
  clipboardPositionals(input as ClipboardCommandOptions),
);

export const clipboardCommandFacet = defineCommandFacet({
  name: CLIPBOARD_COMMAND_NAME,
  effect: 'destructive',
  text: {
    summary: 'Read or write device clipboard text',
    searchHint: 'copy paste pasteboard',
  },
  metadata: clipboardCommandMetadata,
  run: (client, input) => client.command.clipboard(input as ClipboardCommandOptions),
  cliSchema: clipboardCliSchema,
  cliReader: clipboardCliReader,
  daemonWriter: clipboardDaemonWriter,
});

function clipboardPositionals(input: ClipboardCommandOptions): string[] {
  return input.action === 'read' ? ['read'] : ['write', input.text];
}

function readClipboardInput(positionals: string[]): Record<string, unknown> {
  const action = positionals[0]?.toLowerCase();
  if (action !== 'read' && action !== 'write') {
    throw new AppError('INVALID_ARGS', 'clipboard requires a subcommand: read or write.');
  }
  if (action === 'read') {
    if (positionals.length !== 1) {
      throw new AppError('INVALID_ARGS', 'clipboard read does not accept additional arguments.');
    }
    return { action };
  }
  if (positionals.length < 2) {
    throw new AppError('INVALID_ARGS', 'clipboard write requires text.');
  }
  return { action, text: positionals.slice(1).join(' ') };
}
