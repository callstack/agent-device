import { AppError } from '../../utils/errors.ts';
import type { CommandSchemaOverride } from '../../utils/cli-command-schema-types.ts';
import { enumField, requiredField, stringField } from '../command-input.ts';
import { defineCommandFamily } from '../family/types.ts';
import { defineExecutableCommand } from '../command-contract.ts';
import { defineFieldCommandMetadata } from '../field-command-contract.ts';
import { commonInputFromFlags } from '../cli-grammar/common.ts';
import type { CliReader } from '../cli-grammar/types.ts';
import { debuggingCliOutputFormatters } from './output.ts';

const DEBUG_COMMAND_NAME = 'debug';
const DEBUG_ACTION_VALUES = ['symbols'] as const;

const debugCommandDescription = 'Symbolicate crash artifacts with matching debug symbols.';

export const debugCommandMetadata = defineFieldCommandMetadata(
  DEBUG_COMMAND_NAME,
  debugCommandDescription,
  {
    action: requiredField(enumField(DEBUG_ACTION_VALUES)),
    artifact: requiredField(stringField('Apple crash artifact path (.ips, .crash, or .log).')),
    dsym: stringField('Path to a matching .dSYM bundle.'),
    searchPath: stringField('Directory to scan for matching .dSYM bundles.'),
    out: stringField('Output path for the symbolicated artifact.'),
  },
);

const debuggingCommandMetadata = [debugCommandMetadata] as const;

export const debugCommandDefinition = defineExecutableCommand(
  debugCommandMetadata,
  (client, input) => client.debug.symbols(input),
);

const debuggingCommandDefinitions = [debugCommandDefinition] as const;

const debugCliSchema = {
  usageOverride:
    'debug symbols --artifact <crash.ips|crash.log> (--dsym <App.dSYM> | --search-path <dir>) [--out <symbolicated>]',
  listUsageOverride: 'debug',
  helpDescription:
    'Symbolicate Apple crash artifacts with matching dSYM UUIDs. This debug namespace is intentionally narrow: use logs for app logs, network for HTTP evidence, perf for performance samples, record/trace for media and traces, and react-devtools for React Native profiles.',
  summary:
    'Symbolicate Apple crash artifacts with dSYMs; use logs/network/perf for other diagnostics',
  positionalArgs: ['symbols'],
  allowedFlags: ['artifact', 'dsym', 'searchPath', 'out'],
} as const satisfies CommandSchemaOverride;

const debuggingCliSchemas = {
  [DEBUG_COMMAND_NAME]: debugCliSchema,
} as const satisfies Record<string, CommandSchemaOverride>;

export const debugCliReader: CliReader = (positionals, flags) => ({
  ...commonInputFromFlags(flags),
  action: readDebugAction(positionals[0]),
  artifact: flags.artifact,
  dsym: flags.dsym,
  searchPath: flags.searchPath,
  out: flags.out,
});

const debuggingCliReaders = {
  debug: debugCliReader,
} satisfies Record<string, CliReader>;

export const debuggingCommandFamily = defineCommandFamily({
  name: 'debugging',
  metadata: debuggingCommandMetadata,
  definitions: debuggingCommandDefinitions,
  cliSchemas: debuggingCliSchemas,
  cliReaders: debuggingCliReaders,
  cliOutputFormatters: debuggingCliOutputFormatters,
});

function readDebugAction(value: string | undefined): 'symbols' {
  if (value === 'symbols') return value;
  throw new AppError(
    'INVALID_ARGS',
    'debug supports only symbols; use logs, network, perf, record, trace, or react-devtools for other diagnostics',
  );
}
