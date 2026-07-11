import { PUBLIC_COMMANDS } from '../../command-catalog.ts';
import type { CommandSchemaOverride } from '../../cli-schema/types.ts';
import { enumField, integerField, requiredField } from '../command-input.ts';
import { defineExecutableCommand } from '../command-contract.ts';
import {
  commonInputFromFlags,
  direct,
  requiredDaemonString,
  requiredString,
} from '../cli-grammar/common.ts';
import type { CliReader, DaemonWriter } from '../cli-grammar/types.ts';
import { defineCommandFacet } from '../family/types.ts';
import { defineFieldCommandMetadata } from '../field-command-contract.ts';
import { managementCliOutputFormatters } from './output.ts';

const PREPARE_ACTION_VALUES = ['ios-runner'] as const;

const prepareCommandMetadata = defineFieldCommandMetadata(
  'prepare',
  'Prepare platform helper infrastructure.',
  {
    action: requiredField(enumField(PREPARE_ACTION_VALUES)),
    timeoutMs: integerField('Maximum wall-clock time for the prepare command.'),
  },
);

const prepareCommandDefinition = defineExecutableCommand(prepareCommandMetadata, (client, input) =>
  client.command.prepare(input),
);

const prepareCliSchema = {
  usageOverride: 'prepare ios-runner --platform ios|macos [--timeout <ms>]',
  listUsageOverride: 'prepare',
  helpDescription:
    'Prepare platform helper infrastructure. ios-runner builds/reuses, starts, and health-checks the XCTest runner so later Apple snapshots and interactions do not pay first-use startup cost. In JSON output, top-level buildMs/connectMs/healthCheckMs are diagnostic fields and may overlap; use timing.additiveParts for additive wall-clock phase totals. In CI, run it after boot/install and before replay/test; if replay/test starts a separate daemon, stop the prepare daemon before replay/test so it does not keep the prepared runner lease. It is not a recovery step for "runner already owned by another agent-device daemon"; stop the owning daemon on the Mac with simulator access instead. Runner build/start output is written to the session runner.log; daemon.log is for daemon lifecycle/startup issues.',
  summary:
    'Pre-warm platform helpers, especially the iOS/macOS XCTest runner before Apple automation',
  positionalArgs: ['ios-runner'],
  allowedFlags: ['timeoutMs'],
} as const satisfies CommandSchemaOverride;

const prepareCliReader: CliReader = (positionals, flags) => ({
  ...commonInputFromFlags(flags),
  action: requiredString(positionals[0], 'prepare requires subcommand'),
  timeoutMs: flags.timeoutMs,
});

const prepareDaemonWriter: DaemonWriter = direct(PUBLIC_COMMANDS.prepare, (input) => [
  requiredDaemonString(input.action, 'prepare requires subcommand'),
]);

export const prepareCommandFacet = defineCommandFacet({
  name: 'prepare',
  metadata: prepareCommandMetadata,
  definition: prepareCommandDefinition,
  cliSchema: prepareCliSchema,
  cliReader: prepareCliReader,
  daemonWriter: prepareDaemonWriter,
  cliOutputFormatter: managementCliOutputFormatters.prepare,
});
