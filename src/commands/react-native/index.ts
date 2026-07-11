import { AppError } from '../../kernel/errors.ts';
import type { CommandSchemaOverride } from '../../cli-schema/types.ts';
import { defineCommandFacet, defineCommandFamilyFromFacets } from '../family/types.ts';
import { defineExecutableCommand } from '../command-contract.ts';
import { enumField, requiredField } from '../command-input.ts';
import { defineFieldCommandMetadata } from '../field-command-contract.ts';
import { commonInputFromFlags, direct, requiredDaemonString } from '../cli-grammar/common.ts';
import type { CliReader, DaemonWriter } from '../cli-grammar/types.ts';

const REACT_NATIVE_COMMAND_NAME = 'react-native';
const REACT_NATIVE_ACTION_VALUES = ['dismiss-overlay'] as const;

const reactNativeCommandDescription = 'Run supported React Native app automation helpers.';

export const reactNativeCommandMetadata = defineFieldCommandMetadata(
  REACT_NATIVE_COMMAND_NAME,
  reactNativeCommandDescription,
  {
    action: requiredField(enumField(REACT_NATIVE_ACTION_VALUES)),
  },
);

export const reactNativeCommandDefinition = defineExecutableCommand(
  reactNativeCommandMetadata,
  (client, input) => client.command.reactNative(input),
);

const reactNativeCliSchema = {
  usageOverride: 'react-native dismiss-overlay',
  listUsageOverride: 'react-native dismiss-overlay',
  positionalArgs: ['dismiss-overlay'],
} as const satisfies CommandSchemaOverride;

export const reactNativeCliReader: CliReader = (positionals, flags) => ({
  ...commonInputFromFlags(flags),
  action: readReactNativeAction(positionals[0]),
});

export const reactNativeDaemonWriter: DaemonWriter = direct(REACT_NATIVE_COMMAND_NAME, (input) => [
  requiredDaemonString(input.action, 'react-native requires action'),
]);

const reactNativeCommandFacet = defineCommandFacet({
  name: REACT_NATIVE_COMMAND_NAME,
  metadata: reactNativeCommandMetadata,
  definition: reactNativeCommandDefinition,
  cliSchema: reactNativeCliSchema,
  cliReader: reactNativeCliReader,
  daemonWriter: reactNativeDaemonWriter,
});

export const reactNativeCommandFamily = defineCommandFamilyFromFacets({
  name: 'react-native',
  commands: [reactNativeCommandFacet],
});

function readReactNativeAction(value: string | undefined): 'dismiss-overlay' {
  if (value === 'dismiss-overlay') return value;
  throw new AppError('INVALID_ARGS', 'react-native supports only: dismiss-overlay');
}

export * from './overlay.ts';
