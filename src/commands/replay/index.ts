import type { CommandSchemaOverride } from '../../utils/cli-command-schema-types.ts';
import { defineCommandFamily } from '../family/types.ts';
import { defineExecutableCommand } from '../command-contract.ts';
import {
  booleanField,
  integerField,
  requiredField,
  stringArrayField,
  stringField,
} from '../command-input.ts';
import { defineFieldCommandMetadata } from '../field-command-contract.ts';
import {
  commonInputFromFlags,
  request,
  requiredDaemonString,
  requiredString,
} from '../cli-grammar/common.ts';
import type { CliReader, CommandInput, DaemonWriter } from '../cli-grammar/types.ts';
import { REPLAY_FLAGS } from '../../utils/cli-flags.ts';

const REPLAY_COMMAND_NAME = 'replay';
const TEST_COMMAND_NAME = 'test';

const REPLAY_SHELL_ENV_PREFIX = 'AD_VAR_';

const replayCommandDescription = 'Replay a recorded session.';
const testCommandDescription = 'Run one or more replay scripts.';

export const replayCommandMetadata = defineFieldCommandMetadata(
  REPLAY_COMMAND_NAME,
  replayCommandDescription,
  {
    path: requiredField(stringField()),
    update: booleanField(),
    backend: stringField(),
    maestro: booleanField(),
    env: stringArrayField(),
  },
);

export const testCommandMetadata = defineFieldCommandMetadata(
  TEST_COMMAND_NAME,
  testCommandDescription,
  {
    paths: requiredField(stringArrayField()),
    update: booleanField(),
    backend: stringField(),
    maestro: booleanField(),
    env: stringArrayField(),
    failFast: booleanField(),
    timeoutMs: integerField(),
    retries: integerField(),
    recordVideo: booleanField(),
    artifactsDir: stringField(),
    reportJunit: stringField(),
    shardAll: integerField(),
    shardSplit: integerField(),
  },
);

const replayCommandMetadataList = [replayCommandMetadata, testCommandMetadata] as const;

export const replayCommandDefinition = defineExecutableCommand(
  replayCommandMetadata,
  (client, input) => client.replay.run(input),
);

export const testCommandDefinition = defineExecutableCommand(testCommandMetadata, (client, input) =>
  client.replay.test(input),
);

const replayCommandDefinitions = [replayCommandDefinition, testCommandDefinition] as const;

const replayCliSchema = {
  usageOverride: 'replay <path> | replay export <file.ad> [--format maestro] [--out <path>]',
  helpDescription:
    'Replay a recorded session. For Maestro YAML compatibility flows, use replay <flow.yaml> --maestro and keep the target binding such as --platform ios on the replay command.',
  summary: replayCommandDescription,
  positionalArgs: ['path'],
  allowsExtraPositionals: true,
  allowedFlags: ['replayMaestro', 'replayExportFormat', ...REPLAY_FLAGS, 'timeoutMs', 'out'],
} as const satisfies CommandSchemaOverride;

const testCliSchema = {
  usageOverride: 'test <path-or-glob>...',
  listUsageOverride: 'test <path-or-glob>...',
  helpDescription: 'Run one or more replay scripts as a serial test suite',
  summary: 'Run replay test suites',
  positionalArgs: ['pathOrGlob'],
  allowsExtraPositionals: true,
  allowedFlags: [
    'replayMaestro',
    ...REPLAY_FLAGS,
    'failFast',
    'timeoutMs',
    'retries',
    'recordVideo',
    'artifactsDir',
    'reportJunit',
    'shardAll',
    'shardSplit',
  ],
} as const satisfies CommandSchemaOverride;

const replayCliSchemas = {
  [REPLAY_COMMAND_NAME]: replayCliSchema,
  [TEST_COMMAND_NAME]: testCliSchema,
} as const satisfies Record<string, CommandSchemaOverride>;

export const replayCliReader: CliReader = (positionals, flags) => ({
  ...commonInputFromFlags(flags),
  path: requiredString(positionals[0], 'replay requires path'),
  update: flags.replayUpdate,
  backend: flags.replayMaestro ? 'maestro' : undefined,
  env: flags.replayEnv,
});

export const testCliReader: CliReader = (positionals, flags) => ({
  ...commonInputFromFlags(flags),
  paths: positionals,
  update: flags.replayUpdate,
  backend: flags.replayMaestro ? 'maestro' : undefined,
  env: flags.replayEnv,
  failFast: flags.failFast,
  timeoutMs: flags.timeoutMs,
  retries: flags.retries,
  recordVideo: flags.recordVideo,
  artifactsDir: flags.artifactsDir,
  reportJunit: flags.reportJunit,
  shardAll: flags.shardAll,
  shardSplit: flags.shardSplit,
});

export const replayDaemonWriter: DaemonWriter = (input) =>
  request(REPLAY_COMMAND_NAME, [requiredDaemonString(input.path, 'replay requires path')], {
    ...input,
    replayUpdate: input.update,
    replayBackend: readReplayBackend(input),
    replayEnv: input.env,
    replayShellEnv: collectReplayClientShellEnv(process.env),
  });

export const testDaemonWriter: DaemonWriter = (input) =>
  request(TEST_COMMAND_NAME, input.paths ?? [], {
    ...input,
    replayUpdate: input.update,
    replayBackend: readReplayBackend(input),
    replayEnv: input.env,
    replayShellEnv: collectReplayClientShellEnv(process.env),
  });

const replayCliReaders = {
  replay: replayCliReader,
  test: testCliReader,
} satisfies Record<string, CliReader>;

const replayDaemonWriters = {
  replay: replayDaemonWriter,
  test: testDaemonWriter,
} satisfies Record<string, DaemonWriter>;

export const replayCommandFamily = defineCommandFamily({
  name: 'replay',
  metadata: replayCommandMetadataList,
  definitions: replayCommandDefinitions,
  cliSchemas: replayCliSchemas,
  cliReaders: replayCliReaders,
  daemonWriters: replayDaemonWriters,
});

function readReplayBackend(input: CommandInput): string | undefined {
  return input.backend ?? (input.maestro === true ? 'maestro' : undefined);
}

function collectReplayClientShellEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string' && key.startsWith(REPLAY_SHELL_ENV_PREFIX)) result[key] = value;
  }
  return result;
}
