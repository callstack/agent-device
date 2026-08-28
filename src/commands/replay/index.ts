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
import type { AsyncDaemonWriter, CliReader, CommandInput } from '../cli-grammar/types.ts';
import { METRO_RELOAD_FLAGS, REPLAY_FLAGS } from '../cli-grammar/flag-groups.ts';
import { withCommandRuntimeHints } from '../runtime-hints.ts';
import {
  collectReplayShellEnv,
  parseReplayCliEnvEntries,
  readReplayCliEnvEntries,
} from '@agent-device/ad-script';
import { loadReplayScriptSourceBundle } from './script-source-bundle.ts';
import { discoverReplaySourcePaths } from './source-discovery.ts';

const REPLAY_COMMAND_NAME = 'replay';
const TEST_COMMAND_NAME = 'test';

const REPLAY_SHELL_ENV_PREFIX = 'AD_VAR_';

const replayCommandDescription =
  'Run a recorded automation script, including compatible Maestro YAML flows. A script without a terminal close leaves its session active for subsequent automation.';
const testCommandDescription = 'Run one or more replay scripts as a serial test suite';

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
    keepSession: booleanField(
      'Leave the session active by suppressing exactly an authored terminal close in native .ad.',
    ),
    timeoutMs: integerField('Maximum wall-clock duration for the replay request.'),
    // ADR 0012 decision 6, R1/R6: arms agent-supervised re-record repair
    // from the first replay attempt; optional string value is the healed
    // script's output path.
    saveScript: jsonSchemaField<boolean | string>({
      oneOf: [booleanSchema(), stringSchema()],
    }),
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
  usageOverride: 'replay <path> | replay export <file.ad> [--out <path>]',
  positionalArgs: ['path'],
  allowsExtraPositionals: true,
  allowedFlags: [
    'replayMaestro',
    ...REPLAY_FLAGS,
    ...METRO_RELOAD_FLAGS,
    'replayFrom',
    'replayPlanDigest',
    'replayKeepSession',
    'timeoutMs',
    'out',
    'saveScript',
    'force',
  ],
  // ADR 0012 decision 6: on replay, --save-script arms a repair transaction from step 1 (not the
  // open/close authoring lifecycle the shared flag description documents) and the healed script
  // commits on that transaction's own teardown, not on a plain close.
  flagDescriptionOverrides: {
    saveScript:
      'Arm a repair transaction from this replay (ADR 0012): recording starts at step 1, and the healed script commits when the repair-armed session tears down (close, close --save-script, or idle-reap). Independent of the open/close authoring arm-on-open. Optional custom output path.',
  },
} as const satisfies CommandSchemaOverride;

const testCliSchema = {
  usageOverride: 'test <path-or-glob>...',
  listUsageOverride: 'test <path-or-glob>...',
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
  keepSession: flags.replayKeepSession,
  timeoutMs: flags.timeoutMs,
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

export const replayDaemonWriter: AsyncDaemonWriter = async (input) => {
  const inputPath = requiredDaemonString(input.path, 'replay requires path');
  const replayBackend = readReplayBackend(input);
  const replayShellEnv = collectReplayClientShellEnv(process.env);
  return request(REPLAY_COMMAND_NAME, [inputPath], {
    ...input,
    replayUpdate: input.update,
    replayBackend,
    replayEnv: input.env,
    replayShellEnv,
    // #1802: the caller owns the flow files, so it reads them here — the same
    // client-collects-local-input move `replayShellEnv` already makes — and
    // the daemon executes only what arrives in this bundle.
    replayScriptSource: await loadReplayScriptSourceBundle({
      inputPath,
      cwd: readReplayClientCwd(input),
      replayBackend,
      env: readReplayScriptSourceEnv(input, replayShellEnv),
    }),
    replayFrom: input.resumeFrom,
    replayPlanDigest: input.resumePlanDigest,
    replayKeepSession: input.keepSession,
    saveScript: input.saveScript,
  });
};

export const testDaemonWriter: AsyncDaemonWriter = async (input) => {
  const inputs = input.paths ?? [];
  const replayBackend = readReplayBackend(input);
  const cwd = readReplayClientCwd(input);
  const replayShellEnv = collectReplayClientShellEnv(process.env);
  const env = readReplayScriptSourceEnv(input, replayShellEnv);
  return request(TEST_COMMAND_NAME, inputs, {
    ...stripReplayTestPresentationInput(input),
    replayUpdate: input.update,
    replayBackend,
    replayEnv: input.env,
    replayShellEnv,
    // #1802: `test` inputs are paths, directories, and globs on the CALLER's
    // filesystem. Expanding them here keeps discovery order identical for a
    // local and a remote daemon and ships each discovered source's text.
    replayScriptSources: await Promise.all(
      discoverReplaySourcePaths({ inputs, cwd, replayBackend }).map(
        async (inputPath) =>
          await loadReplayScriptSourceBundle({ inputPath, cwd, replayBackend, env }),
      ),
    ),
  });
};

const replayCommandFacet = defineCommandFacet({
  name: REPLAY_COMMAND_NAME,
  text: {
    summary: 'Replay a recorded session or Maestro flow',
    cliDetail:
      'For Maestro YAML compatibility flows, use replay <flow.yaml> --maestro and keep the target binding such as --platform ios on the replay command. A script with no terminal close leaves its session (and daemon) running until you close it or it idle-reaps — no different from a session opened interactively. For native .ad scripts, --keep-session suppresses exactly an authored terminal close so you can continue interactively.',
  },
  metadata: replayCommandMetadata,
  definition: replayCommandDefinition,
  cliSchema: replayCliSchema,
  cliReader: replayCliReader,
  daemonWriter: replayDaemonWriter,
});

const testCommandFacet = defineCommandFacet({
  name: TEST_COMMAND_NAME,
  text: {
    summary: 'Run replay test suites',
  },
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

/**
 * The `${VAR}` values a Maestro `runFlow` include path can be resolved from before the run
 * starts — the same shell (`AD_VAR_*`) and `-e KEY=VALUE` sources the run itself merges into its
 * environment, read here so collection sees what the run will see.
 */
function readReplayScriptSourceEnv(
  input: CommandInput,
  replayShellEnv: Record<string, string>,
): Record<string, string> {
  return {
    ...collectReplayShellEnv(replayShellEnv),
    ...parseReplayCliEnvEntries(readReplayCliEnvEntries(input.env)),
  };
}

function readReplayClientCwd(input: CommandInput): string {
  return typeof input.cwd === 'string' && input.cwd.length > 0 ? input.cwd : process.cwd();
}

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
