import { PUBLIC_COMMANDS } from '../../command-catalog.ts';
import type { CommandSchemaOverride } from '../../cli-schema/types.ts';
import { booleanField } from '../command-input.ts';
import { defineExecutableCommand } from '../command-contract.ts';
import { commonInputFromFlags, direct } from '../cli-grammar/common.ts';
import type { CliReader, DaemonWriter } from '../cli-grammar/types.ts';
import { defineCommandFacet } from '../family/types.ts';
import { defineFieldCommandMetadata } from '../field-command-contract.ts';
import { managementCliOutputFormatters } from './output.ts';

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
  allowedFlags: ['headless'],
} as const satisfies CommandSchemaOverride;

const devicesCliSchema = {} as const satisfies CommandSchemaOverride;

const capabilitiesCliSchema = {} as const satisfies CommandSchemaOverride;

const shutdownCliSchema = {} as const satisfies CommandSchemaOverride;

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
  text: {
    summary: 'List available devices and simulators',
  },
  metadata: devicesCommandMetadata,
  definition: devicesCommandDefinition,
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
  definition: capabilitiesCommandDefinition,
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
  definition: bootCommandDefinition,
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
