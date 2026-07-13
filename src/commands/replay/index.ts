import type { CommandSchemaOverride } from '../../cli-schema/types.ts';
import { defineCommandFacet, defineCommandFamilyFromFacets } from '../family/types.ts';
import { defineExecutableCommand } from '../command-contract.ts';
import {
  booleanField,
  booleanSchema,
  integerField,
  jsonSchemaField,
  requiredField,
  stringArrayField,
  stringField,
  stringSchema,
} from '../command-input.ts';
import { defineFieldCommandMetadata } from '../field-command-contract.ts';
import {
  commonInputFromFlags,
  request,
  requiredDaemonString,
  requiredString,
} from '../cli-grammar/common.ts';
import type { CliReader, CommandInput, DaemonWriter } from '../cli-grammar/types.ts';
import { METRO_RELOAD_FLAGS, REPLAY_FLAGS } from '../cli-grammar/flag-groups.ts';
import { withCommandRuntimeHints } from '../runtime-hints.ts';

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
    metroHost: stringField('Metro/debug host hint inherited by replay-opened sessions.'),
    metroPort: integerField('Metro/debug port hint inherited by replay-opened sessions.'),
    bundleUrl: stringField('Bundle URL hint inherited by replay-opened sessions.'),
    // ADR 0012 decision 4 / migration step 5: replay-only resume. Named
    // `resumeFrom`/`resumePlanDigest` (not `from`/`planDigest`) because
    // `from` already means a gesture's `PointInput` on `CommandInput`
    // (shared flat type across every command). `test` deliberately has
    // neither field — it must stay a full, deterministic suite run.
    resumeFrom: integerField(),
    resumePlanDigest: stringField(),
    // ADR 0012 decision 6, R1/R6: arms agent-supervised re-record repair
    // from the first replay attempt; optional string value is the healed
    // script's output path.
    saveScript: jsonSchemaField<boolean | string>({ oneOf: [booleanSchema(), stringSchema()] }),
    // #1258: overwrite an existing --save-script target (arm-time preflight +
    // publish) instead of refusing. Alias: --overwrite.
    force: booleanField(),
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
    metroHost: stringField('Metro/debug host hint inherited by each test session.'),
    metroPort: integerField('Metro/debug port hint inherited by each test session.'),
    bundleUrl: stringField('Bundle URL hint inherited by each test session.'),
    failFast: booleanField(),
    timeoutMs: integerField(),
    retries: integerField(),
    recordVideo: booleanField(),
    artifactsDir: stringField(),
    shardAll: integerField(),
    shardSplit: integerField(),
  },
);

export const replayCommandDefinition = defineExecutableCommand(
  replayCommandMetadata,
  (client, input) => client.replay.run(withCommandRuntimeHints(input)),
);

export const testCommandDefinition = defineExecutableCommand(testCommandMetadata, (client, input) =>
  client.replay.test(withCommandRuntimeHints(input)),
);

const replayCliSchema = {
  usageOverride: 'replay <path> | replay export <file.ad> [--format maestro] [--out <path>]',
  helpDescription:
    'Replay a recorded session. For Maestro YAML compatibility flows, use replay <flow.yaml> --maestro and keep the target binding such as --platform ios on the replay command.',
  summary: replayCommandDescription,
  positionalArgs: ['path'],
  allowsExtraPositionals: true,
  allowedFlags: [
    'replayMaestro',
    'replayExportFormat',
    ...REPLAY_FLAGS,
    ...METRO_RELOAD_FLAGS,
    'replayFrom',
    'replayPlanDigest',
    'timeoutMs',
    'out',
    'saveScript',
    'force',
  ],
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
    ...METRO_RELOAD_FLAGS,
    'failFast',
    'timeoutMs',
    'retries',
    'recordVideo',
    'artifactsDir',
    'reporter',
    'reportJunit',
    'shardAll',
    'shardSplit',
  ],
} as const satisfies CommandSchemaOverride;

export const replayCliReader: CliReader = (positionals, flags) => ({
  ...commonInputFromFlags(flags),
  path: requiredString(positionals[0], 'replay requires path'),
  update: flags.replayUpdate,
  backend: flags.replayMaestro ? 'maestro' : undefined,
  env: flags.replayEnv,
  metroHost: flags.metroHost,
  metroPort: flags.metroPort,
  bundleUrl: flags.bundleUrl,
  resumeFrom: flags.replayFrom,
  resumePlanDigest: flags.replayPlanDigest,
  saveScript: flags.saveScript,
  force: flags.force,
});

export const testCliReader: CliReader = (positionals, flags) => ({
  ...commonInputFromFlags(flags),
  paths: positionals,
  update: flags.replayUpdate,
  backend: flags.replayMaestro ? 'maestro' : undefined,
  env: flags.replayEnv,
  metroHost: flags.metroHost,
  metroPort: flags.metroPort,
  bundleUrl: flags.bundleUrl,
  failFast: flags.failFast,
  timeoutMs: flags.timeoutMs,
  retries: flags.retries,
  recordVideo: flags.recordVideo,
  artifactsDir: flags.artifactsDir,
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
    replayFrom: input.resumeFrom,
    replayPlanDigest: input.resumePlanDigest,
    saveScript: input.saveScript,
  });

export const testDaemonWriter: DaemonWriter = (input) =>
  request(TEST_COMMAND_NAME, input.paths ?? [], {
    ...stripReplayTestPresentationInput(input),
    replayUpdate: input.update,
    replayBackend: readReplayBackend(input),
    replayEnv: input.env,
    replayShellEnv: collectReplayClientShellEnv(process.env),
  });

const replayCommandFacet = defineCommandFacet({
  name: REPLAY_COMMAND_NAME,
  metadata: replayCommandMetadata,
  definition: replayCommandDefinition,
  cliSchema: replayCliSchema,
  cliReader: replayCliReader,
  daemonWriter: replayDaemonWriter,
});

const testCommandFacet = defineCommandFacet({
  name: TEST_COMMAND_NAME,
  metadata: testCommandMetadata,
  definition: testCommandDefinition,
  cliSchema: testCliSchema,
  cliReader: testCliReader,
  daemonWriter: testDaemonWriter,
});

export const replayCommandFamily = defineCommandFamilyFromFacets({
  name: 'replay',
  commands: [replayCommandFacet, testCommandFacet],
});

function readReplayBackend(input: CommandInput): string | undefined {
  return input.backend ?? (input.maestro === true ? 'maestro' : undefined);
}

function stripReplayTestPresentationInput(input: CommandInput): CommandInput {
  const daemonInput = { ...input };
  delete daemonInput.reporter;
  delete daemonInput.reportJunit;
  return daemonInput;
}

function collectReplayClientShellEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string' && key.startsWith(REPLAY_SHELL_ENV_PREFIX)) result[key] = value;
  }
  return result;
}
