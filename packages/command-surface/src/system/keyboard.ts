import { AppError } from '@agent-device/kernel/errors';
import type { CommandSchemaOverride } from '@agent-device/command-registry/command-schema';
import { commonInputFromFlags, direct, optionalString } from '../cli-grammar/common.ts';
import type { CliReader, DaemonWriter } from '../cli-grammar/types.ts';
import { enumField } from '../command-input.ts';
import { compactRecord } from '../input-readers.ts';
import { defineCommandFacet } from '../family/types.ts';
import { defineFieldCommandMetadata } from '../field-command-contract.ts';

const KEYBOARD_COMMAND_NAME = 'keyboard';

const KEYBOARD_METADATA_ACTION_VALUES = ['status', 'dismiss', 'enter', 'return'] as const;

const keyboardCommandDescription =
  'status (alias get) reads the keyboard state; a visible keyboard reports returnKey and its label. Unreadable Apple keyboard state reports OBSERVATION_UNAVAILABLE. Enter (alias return) sends Return to the focused input; it may submit, move focus, or insert a newline, and unconfirmed delivery reports keyboard_return_unavailable with dispatched: unknown (Return may have landed). On the native iOS runner, dismiss is a no-op when the keyboard is hidden; a visible keyboard returns keyboard_dismiss_unavailable with dispatched: no. When Return would submit or finish the edit (search, go, done, send), that refusal names keyboard enter. Press the visible Hide Keyboard key or an app control that ends editing, or gesture pan down from the scrollable content with interactive dismissal, and verify with status. Android dismiss sends platform dismissal.';

const keyboardCommandMetadata = defineFieldCommandMetadata(
  KEYBOARD_COMMAND_NAME,
  keyboardCommandDescription,
  {
    action: enumField(KEYBOARD_METADATA_ACTION_VALUES),
  },
);

const keyboardCliSchema = {
  usageOverride: 'keyboard [status|get|dismiss|enter|return]',
  positionalArgs: ['action?'],
} as const satisfies CommandSchemaOverride;

export const keyboardCliReader: CliReader = (positionals, flags) => ({
  ...commonInputFromFlags(flags),
  ...readKeyboardInput(positionals),
});

export const keyboardDaemonWriter: DaemonWriter = direct(KEYBOARD_COMMAND_NAME, (input) =>
  optionalString(input.action),
);

export const keyboardCommandFacet = defineCommandFacet({
  name: KEYBOARD_COMMAND_NAME,
  effect: 'destructive',
  text: {
    summary: 'Inspect, press, or dismiss the device keyboard',
    searchHint: 'ime gboard',
  },
  metadata: keyboardCommandMetadata,
  run: (client, input) => client.command.keyboard(input),
  cliSchema: keyboardCliSchema,
  cliReader: keyboardCliReader,
  daemonWriter: keyboardDaemonWriter,
});

function readKeyboardInput(positionals: string[]): Record<string, unknown> {
  if (positionals.length > 1) {
    throw new AppError('INVALID_ARGS', 'keyboard accepts at most one action argument.');
  }
  return compactRecord({ action: readKeyboardAction(positionals[0]) });
}

function readKeyboardAction(
  value: string | undefined,
): 'status' | 'dismiss' | 'enter' | 'return' | undefined {
  const action = value?.toLowerCase();
  if (action === 'get') return 'status';
  if (
    action === undefined ||
    action === 'status' ||
    action === 'dismiss' ||
    action === 'enter' ||
    action === 'return'
  ) {
    return action;
  }
  throw new AppError(
    'INVALID_ARGS',
    'keyboard action must be status, get, dismiss, enter, or return.',
  );
}
