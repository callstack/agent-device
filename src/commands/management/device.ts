import { PUBLIC_COMMANDS } from '../../command-catalog.ts';
import type { CommandSchemaOverride } from '../../utils/cli-command-schema-types.ts';
import { booleanField } from '../command-input.ts';
import { defineExecutableCommand } from '../command-contract.ts';
import { commonInputFromFlags, direct } from '../cli-grammar/common.ts';
import type { CliReader, DaemonWriter } from '../cli-grammar/types.ts';
import { defineCommandFacet } from '../family/types.ts';
import { defineFieldCommandMetadata } from '../field-command-contract.ts';
import { managementCliOutputFormatters } from './output.ts';

const devicesCommandMetadata = defineFieldCommandMetadata('devices', 'List available devices.', {});

const capabilitiesCommandMetadata = defineFieldCommandMetadata(
  'capabilities',
  'List commands supported by the selected device.',
  {},
);

const bootCommandMetadata = defineFieldCommandMetadata(
  'boot',
  'Boot or prepare a selected device without using CLI positional arguments.',
  {
    headless: booleanField('Boot without showing simulator UI when supported.'),
  },
);

const shutdownCommandMetadata = defineFieldCommandMetadata(
  'shutdown',
  'Shutdown a selected simulator or emulator.',
  {},
);

const devicesCommandDefinition = defineExecutableCommand(devicesCommandMetadata, (client, input) =>
  client.devices.list(input),
);

const capabilitiesCommandDefinition = defineExecutableCommand(
  capabilitiesCommandMetadata,
  (client, input) => client.devices.capabilities(input),
);

const bootCommandDefinition = defineExecutableCommand(bootCommandMetadata, (client, input) =>
  client.devices.boot(input),
);

const shutdownCommandDefinition = defineExecutableCommand(
  shutdownCommandMetadata,
  (client, input) => client.devices.shutdown(input),
);

const bootCliSchema = {
  summary: 'Boot target device/simulator',
  allowedFlags: ['headless'],
} as const satisfies CommandSchemaOverride;

const capabilitiesCliSchema = {
  summary: 'List supported commands for the selected device',
  helpDescription:
    'List command names supported by the selected session device or explicit --platform/--device/--udid/--serial target.',
} as const satisfies CommandSchemaOverride;

const shutdownCliSchema = {
  summary: 'Shutdown target simulator/emulator',
} as const satisfies CommandSchemaOverride;

const commonCliReader: CliReader = (_positionals, flags) => commonInputFromFlags(flags);

const bootCliReader: CliReader = (_positionals, flags) => ({
  ...commonInputFromFlags(flags),
  headless: flags.headless,
});

const devicesDaemonWriter: DaemonWriter = direct(PUBLIC_COMMANDS.devices);
const capabilitiesDaemonWriter: DaemonWriter = direct(PUBLIC_COMMANDS.capabilities);
const bootDaemonWriter: DaemonWriter = direct(PUBLIC_COMMANDS.boot);
const shutdownDaemonWriter: DaemonWriter = direct(PUBLIC_COMMANDS.shutdown);

const devicesCommandFacet = defineCommandFacet({
  name: 'devices',
  metadata: devicesCommandMetadata,
  definition: devicesCommandDefinition,
  cliReader: commonCliReader,
  daemonWriter: devicesDaemonWriter,
  cliOutputFormatter: managementCliOutputFormatters.devices,
});

const capabilitiesCommandFacet = defineCommandFacet({
  name: 'capabilities',
  metadata: capabilitiesCommandMetadata,
  definition: capabilitiesCommandDefinition,
  cliSchema: capabilitiesCliSchema,
  cliReader: commonCliReader,
  daemonWriter: capabilitiesDaemonWriter,
  cliOutputFormatter: managementCliOutputFormatters.capabilities,
});

const bootCommandFacet = defineCommandFacet({
  name: 'boot',
  metadata: bootCommandMetadata,
  definition: bootCommandDefinition,
  cliSchema: bootCliSchema,
  cliReader: bootCliReader,
  daemonWriter: bootDaemonWriter,
  cliOutputFormatter: managementCliOutputFormatters.boot,
});

const shutdownCommandFacet = defineCommandFacet({
  name: 'shutdown',
  metadata: shutdownCommandMetadata,
  definition: shutdownCommandDefinition,
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
