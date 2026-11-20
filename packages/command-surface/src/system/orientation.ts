import { ORIENTATION_REQUESTS, parseOrientationRequest } from '@agent-device/contracts/device';
import type { CommandSchemaOverride } from '@agent-device/command-registry/command-schema';
import { commonInputFromFlags, direct, requiredDaemonString } from '../cli-grammar/common.ts';
import type { CliReader, DaemonWriter } from '../cli-grammar/types.ts';
import { enumField, requiredField } from '../command-input.ts';
import { defineCommandFacet } from '../family/types.ts';
import { defineFieldCommandMetadata } from '../field-command-contract.ts';

const ORIENTATION_COMMAND_NAME = 'orientation';

const orientationCommandDescription =
  'Set device orientation on iOS and Android. auto hands rotation back to the sensor on ADB-backed Android (local and Limrun); other backends refuse it. In both default and scoped simulator sets, an iPhone Duo classified with more than one integrated panel refuses portrait-upside-down and rotates through the fold helper; it succeeds only when the lit panel shows the requested orientation, otherwise it fails with orientation-unverified, or orientation-panel-table-unavailable when the final guest panel table cannot be read. A simulator classified with one panel, or whose first classification read is unresolved, uses the standard runner rotation.';

const orientationCommandMetadata = defineFieldCommandMetadata(
  ORIENTATION_COMMAND_NAME,
  orientationCommandDescription,
  {
    orientation: requiredField(enumField(ORIENTATION_REQUESTS)),
  },
);

const orientationCliSchema = {
  usageOverride: `orientation <${ORIENTATION_REQUESTS.join('|')}>`,
  positionalArgs: ['orientation'],
} as const satisfies CommandSchemaOverride;

export const orientationCliReader: CliReader = (positionals, flags) => ({
  ...commonInputFromFlags(flags),
  orientation: parseOrientationRequest(positionals[0]),
});

export const orientationDaemonWriter: DaemonWriter = direct(ORIENTATION_COMMAND_NAME, (input) => [
  requiredDaemonString(input.orientation, 'orientation requires orientation'),
]);

export const orientationCommandFacet = defineCommandFacet({
  name: ORIENTATION_COMMAND_NAME,
  effect: 'write',
  text: {
    summary: 'Set device orientation',
    searchHint: 'rotate landscape',
  },
  metadata: orientationCommandMetadata,
  run: (client, input) => client.command.orientation(input),
  cliSchema: orientationCliSchema,
  cliReader: orientationCliReader,
  daemonWriter: orientationDaemonWriter,
});
