import { PUBLIC_COMMANDS } from '@agent-device/command-registry/catalog';
import type { CommandSchemaOverride } from '@agent-device/command-registry/command-schema';
import type { CommandResultMap } from '@agent-device/command-registry/command-result';
import { DEVICE_KINDS, PUBLIC_PLATFORMS } from '@agent-device/kernel/device';
import {
  constSchema,
  enumField,
  enumSchema,
  integerField,
  numberSchema,
  objectSchema,
  requiredField,
  stringSchema,
} from '../command-input.ts';
import {
  commonInputFromFlags,
  direct,
  requiredDaemonString,
  requiredString,
} from '../cli-grammar/common.ts';
import type { CliReader, DaemonWriter } from '../cli-grammar/types.ts';
import type { JsonSchema } from '../command-contract.ts';
import { defineCommandFacet } from '../family/types.ts';
import { defineFieldCommandMetadata } from '../field-command-contract.ts';
import { managementCliOutputFormatters } from './output.ts';

const PREPARE_ACTION_VALUES = ['ios-runner'] as const;

/**
 * This family's advertised MCP `outputSchema`, keyed by daemon command name and projected into
 * the command map by `src/mcp/command-output-schemas.ts`. Non-strict like every other entry: no
 * `additionalProperties: false`, so additive response fields keep validating. prepare is not
 * MCP-exposed, but the schema stays map-complete with `CommandResultMap`.
 */
export const PREPARE_COMMAND_OUTPUT_SCHEMAS = {
  // packages/contracts/src/prepare.ts
  prepare: objectSchema(
    {
      action: constSchema('ios-runner'),
      // PublicPlatform leaf, mirroring PrepareCommandResult (packages/contracts/src/prepare.ts).
      platform: enumSchema(PUBLIC_PLATFORMS),
      deviceId: stringSchema(),
      deviceName: stringSchema(),
      kind: enumSchema(DEVICE_KINDS),
      durationMs: numberSchema(),
      runner: objectSchema({}, []),
      cache: enumSchema(['exact', 'miss', 'external']),
      artifact: enumSchema(['valid', 'rebuilt']),
      buildMs: numberSchema(),
      connectMs: numberSchema(),
      healthCheckMs: numberSchema(),
      xctestrunPath: stringSchema(),
      recoveryReason: stringSchema(),
      failureReason: stringSchema(),
      timing: objectSchema(
        {
          totalMs: numberSchema(),
          additiveParts: objectSchema(
            {
              buildMs: numberSchema(),
              connectAfterBuildMs: numberSchema(),
              healthCheckMs: numberSchema(),
            },
            ['connectAfterBuildMs', 'healthCheckMs'],
          ),
          containment: objectSchema(
            {
              connectMs: { type: 'array', items: constSchema('buildMs') },
              healthCheckMs: { type: 'array', items: stringSchema() },
            },
            ['healthCheckMs'],
          ),
          note: stringSchema(),
        },
        ['totalMs', 'additiveParts', 'containment', 'note'],
      ),
      message: stringSchema(),
    },
    [
      'action',
      'platform',
      'deviceId',
      'deviceName',
      'kind',
      'durationMs',
      'runner',
      'connectMs',
      'healthCheckMs',
      'timing',
      'message',
    ],
  ),
} satisfies Pick<Record<keyof CommandResultMap, JsonSchema>, 'prepare'>;

const prepareCommandMetadata = defineFieldCommandMetadata(
  'prepare',
  'Prepare platform helper infrastructure. ios-runner builds/reuses, starts, and health-checks the XCTest runner so later Apple snapshots and interactions do not pay first-use startup cost. In JSON output, top-level buildMs/connectMs/healthCheckMs are diagnostic fields and may overlap; use timing.additiveParts for additive wall-clock phase totals. In CI, run it after boot/install and before replay/test; if replay/test starts a separate daemon, stop the prepare daemon before replay/test so it does not keep the prepared runner lease. It is not a recovery step for "runner already owned by another agent-device daemon"; stop the owning daemon on the Mac with simulator access instead. Runner build/start output is written to the session runner.log; daemon.log is for daemon lifecycle/startup issues.',
  {
    action: requiredField(enumField(PREPARE_ACTION_VALUES)),
    timeoutMs: integerField('Maximum wall-clock time for the prepare command.'),
  },
);

const prepareCliSchema = {
  usageOverride: 'prepare ios-runner --platform ios|macos',
  listUsageOverride: 'prepare',
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
  text: {
    summary: 'Pre-warm platform helpers before automation',
  },
  metadata: prepareCommandMetadata,
  run: (client, input) => client.command.prepare(input),
  cliSchema: prepareCliSchema,
  cliReader: prepareCliReader,
  daemonWriter: prepareDaemonWriter,
  cliOutputFormatter: managementCliOutputFormatters.prepare,
});
