import { PUBLIC_COMMANDS } from '@agent-device/command-registry/catalog';
import type { CommandSchemaOverride } from '@agent-device/command-registry/command-schema';
import type { CommandResultMap } from '@agent-device/command-registry/command-result';
import { DEVICE_KINDS, DEVICE_TARGETS, PUBLIC_PLATFORMS } from '@agent-device/kernel/device';
import {
  booleanField,
  booleanSchema,
  integerField,
  enumSchema,
  looseObjectSchema,
  numberSchema,
  objectSchema,
  stringSchema,
} from '../command-input.ts';
import type { JsonSchema } from '../command-contract.ts';
import { commonInputFromFlags, direct } from '../cli-grammar/common.ts';
import type { CliReader, DaemonWriter } from '../cli-grammar/types.ts';
import { defineCommandFacet } from '../family/types.ts';
import { defineFieldCommandMetadata } from '../field-command-contract.ts';
import { managementCliOutputFormatters } from './output.ts';

// boot / shutdown share the resolved-device header (packages/contracts/src/device.ts).
const deviceHeaderProperties: Record<string, JsonSchema> = {
  // Public leaf vocabulary (ios | macos | android | harmonyos | vega | linux | web): boot/shutdown
  // emit publicPlatformString, never the internal `apple` platform.
  platform: enumSchema(PUBLIC_PLATFORMS),
  target: enumSchema(DEVICE_TARGETS),
  device: stringSchema('Human-readable device name.'),
  id: stringSchema('Stable device id.'),
  kind: enumSchema(DEVICE_KINDS),
};
const deviceHeaderRequired = ['platform', 'target', 'device', 'id', 'kind'] as const;

// TargetShutdownResult (packages/contracts/src/target-shutdown-contract.ts).
const targetShutdownResultSchema: JsonSchema = objectSchema(
  {
    success: booleanSchema(),
    exitCode: numberSchema(),
    stdout: stringSchema(),
    stderr: stringSchema(),
    error: looseObjectSchema('Normalized error detail when shutdown failed.'),
  },
  ['success', 'exitCode', 'stdout', 'stderr'],
);

/**
 * This family's advertised MCP `outputSchema`s, keyed by daemon command name and projected into
 * the command map by `src/mcp/command-output-schemas.ts`. Non-strict like every other entry: no
 * `additionalProperties: false`, so additive response fields such as `cost` keep validating.
 * Neither command carries the post-action observation trait (#1652): both are device-runtime
 * commands, not interaction commands, so no settle graft applies here.
 */
export const DEVICE_MANAGEMENT_COMMAND_OUTPUT_SCHEMAS = {
  boot: objectSchema({ ...deviceHeaderProperties, booted: { type: 'boolean', const: true } }, [
    ...deviceHeaderRequired,
    'booted',
  ]),
  shutdown: objectSchema({ ...deviceHeaderProperties, shutdown: targetShutdownResultSchema }, [
    ...deviceHeaderRequired,
    'shutdown',
  ]),
} satisfies Pick<Record<keyof CommandResultMap, JsonSchema>, 'boot' | 'shutdown'>;

const devicesCommandMetadata = defineFieldCommandMetadata(
  'devices',
  'List available devices and simulators that can be selected for automation. Use platform, device, udid, or serial inputs on later commands to target one result.',
  {},
);

const capabilitiesCommandMetadata = defineFieldCommandMetadata(
  'capabilities',
  'List the commands supported by the selected device or active session. Use device-selection inputs when checking support before a session is open.',
  {},
);

const bootCommandMetadata = defineFieldCommandMetadata(
  'boot',
  'Boot or prepare the selected device or simulator so later commands can target it. The device is chosen through the device-selection inputs, not by naming it here.',
  {
    headless: booleanField('Boot without showing simulator UI when supported.'),
    timeoutMs: integerField(
      'Startup budget in milliseconds. Bounds the Simulator boot wait, so a never-booted Simulator can finish its first-boot migration; omit for the default startup behavior.',
      { min: 1 },
    ),
  },
);

const shutdownCommandMetadata = defineFieldCommandMetadata(
  'shutdown',
  'Shutdown a selected simulator or emulator.',
  {},
);

const bootCliSchema = {
  allowedFlags: ['headless', 'timeoutMs'],
} as const satisfies CommandSchemaOverride;

const devicesCliSchema = {} as const satisfies CommandSchemaOverride;

const capabilitiesCliSchema = {} as const satisfies CommandSchemaOverride;

const shutdownCliSchema = {} as const satisfies CommandSchemaOverride;

const commonCliReader: CliReader = (_positionals, flags) => commonInputFromFlags(flags);

const bootCliReader: CliReader = (_positionals, flags) => ({
  ...commonInputFromFlags(flags),
  headless: flags.headless,
  timeoutMs: flags.timeoutMs,
});

const devicesDaemonWriter: DaemonWriter = direct(PUBLIC_COMMANDS.devices);
const capabilitiesDaemonWriter: DaemonWriter = direct(PUBLIC_COMMANDS.capabilities);
const bootDaemonWriter: DaemonWriter = direct(PUBLIC_COMMANDS.boot);
const shutdownDaemonWriter: DaemonWriter = direct(PUBLIC_COMMANDS.shutdown);

const devicesCommandFacet = defineCommandFacet({
  name: 'devices',
  text: {
    summary: 'List available devices and simulators',
  },
  metadata: devicesCommandMetadata,
  run: (client, input) => client.devices.list(input),
  cliSchema: devicesCliSchema,
  cliReader: commonCliReader,
  daemonWriter: devicesDaemonWriter,
  cliOutputFormatter: managementCliOutputFormatters.devices,
});

const capabilitiesCommandFacet = defineCommandFacet({
  name: 'capabilities',
  text: {
    summary: 'List supported commands for the selected device',
    cliDetail: 'Select an explicit target with --platform/--device/--udid/--serial.',
  },
  metadata: capabilitiesCommandMetadata,
  run: (client, input) => client.devices.capabilities(input),
  cliSchema: capabilitiesCliSchema,
  cliReader: commonCliReader,
  daemonWriter: capabilitiesDaemonWriter,
  cliOutputFormatter: managementCliOutputFormatters.capabilities,
});

const bootCommandFacet = defineCommandFacet({
  name: 'boot',
  text: {
    summary: 'Boot target device/simulator',
  },
  metadata: bootCommandMetadata,
  run: (client, input) => client.devices.boot(input),
  cliSchema: bootCliSchema,
  cliReader: bootCliReader,
  daemonWriter: bootDaemonWriter,
  cliOutputFormatter: managementCliOutputFormatters.boot,
});

const shutdownCommandFacet = defineCommandFacet({
  name: 'shutdown',
  text: {
    summary: 'Shutdown target simulator/emulator',
  },
  metadata: shutdownCommandMetadata,
  run: (client, input) => client.devices.shutdown(input),
  cliSchema: shutdownCliSchema,
  cliReader: commonCliReader,
  daemonWriter: shutdownDaemonWriter,
  cliOutputFormatter: managementCliOutputFormatters.shutdown,
});

export const deviceManagementCommandFacets = [
  devicesCommandFacet,
  capabilitiesCommandFacet,
  bootCommandFacet,
  shutdownCommandFacet,
] as const;
