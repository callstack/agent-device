import { PUBLIC_COMMANDS } from '@agent-device/command-registry/catalog';
import type { CommandSchemaOverride } from '@agent-device/command-registry/command-schema';
import { AppError } from '@agent-device/kernel/errors';
import { booleanField, jsonSchemaField, requiredField } from '../command-input.ts';
import { commonInputFromFlags, direct, request } from '../cli-grammar/common.ts';
import type { CliReader, DaemonWriter } from '../cli-grammar/types.ts';
import { defineCommandFacet } from '../family/types.ts';
import { defineFieldCommandMetadata } from '../field-command-contract.ts';
import { managementCliOutputFormatters } from './output.ts';
import type { WearableSelector } from '@agent-device/contracts/wearable-pairing-runtime';

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

const pairWearableCommandMetadata = defineFieldCommandMetadata(
  'pair-wearable',
  'Pair an iPhone Simulator with a watchOS Simulator, or prepare Android phone and Wear OS transports and report any remaining human setup step.',
  {
    phone: requiredField(
      jsonSchemaField<{ platform: 'ios' | 'android'; deviceId: string }>({
        type: 'object',
        description: 'Phone endpoint containing platform and deviceId.',
        properties: {
          platform: { type: 'string', enum: ['ios', 'android'] },
          deviceId: { type: 'string' },
        },
        required: ['platform', 'deviceId'],
        additionalProperties: false,
      }),
    ),
    wearable: jsonSchemaField<WearableSelector>({
      type: 'object',
      description: 'Optional wearable selector by deviceId, name, or both.',
      properties: {
        deviceId: { type: 'string' },
        name: { type: 'string' },
      },
      oneOf: [
        { required: ['deviceId'], not: { required: ['name'] } },
        { required: ['name'], not: { required: ['deviceId'] } },
        { required: ['deviceId', 'name'] },
      ],
      additionalProperties: false,
    }),
    boot: requiredField(booleanField('Boot the selected wearable before pairing.')),
  },
);

const bootCliSchema = {
  allowedFlags: ['headless'],
} as const satisfies CommandSchemaOverride;

const devicesCliSchema = {} as const satisfies CommandSchemaOverride;

const capabilitiesCliSchema = {} as const satisfies CommandSchemaOverride;

const shutdownCliSchema = {} as const satisfies CommandSchemaOverride;
const pairWearableCliSchema = {
  allowedFlags: ['boot'],
  positionalArgs: ['phone-device-id', 'wearable-device-id?'],
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
const pairWearableDaemonWriter: DaemonWriter = (input) =>
  request(PUBLIC_COMMANDS.pairWearable, [], input, {
    phone: input.phone,
    ...(input.wearable ? { wearable: input.wearable } : {}),
    boot: input.boot,
  });

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

const pairWearableCommandFacet = defineCommandFacet({
  name: 'pair-wearable',
  text: {
    summary: 'Pair a phone with a watchOS or Wear OS target',
    cliDetail:
      'Usage: pair-wearable <phone-device-id> [wearable-device-id] --platform ios|android [--boot].',
  },
  metadata: pairWearableCommandMetadata,
  run: (client, input) => client.devices.pairWearable(input),
  cliSchema: pairWearableCliSchema,
  cliReader: (positionals, flags) => {
    if (flags.platform !== 'ios' && flags.platform !== 'android') {
      throw new AppError(
        'INVALID_ARGS',
        'pair-wearable requires --platform ios or --platform android.',
      );
    }
    if (!positionals[0]?.trim()) {
      throw new AppError('INVALID_ARGS', 'pair-wearable requires a phone device id.');
    }
    return {
      ...commonInputFromFlags(flags),
      phone: { platform: flags.platform, deviceId: positionals[0] },
      ...(positionals[1]?.trim() ? { wearable: { deviceId: positionals[1].trim() } } : {}),
      boot: flags.boot === true,
    };
  },
  daemonWriter: pairWearableDaemonWriter,
  cliOutputFormatter: managementCliOutputFormatters.pairWearable,
});

export const deviceManagementCommandFacets = [
  devicesCommandFacet,
  capabilitiesCommandFacet,
  bootCommandFacet,
  shutdownCommandFacet,
  pairWearableCommandFacet,
] as const;
