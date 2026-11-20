import { FOLD_FLAGS } from '@agent-device/command-registry/flag-groups';
import {
  type FoldKeyframe,
  MAX_FOLD_DURATION_MS,
  MAX_FOLD_KEYFRAMES,
  parseFoldInput,
  parseFoldKeyframesJson,
  FOLD_POSES,
  FOLD_POSE_USAGE,
} from '@agent-device/contracts/device';
import type { CommandSchemaOverride } from '@agent-device/command-registry/command-schema';
import { commonInputFromFlags, request } from '../cli-grammar/common.ts';
import type { CliReader, DaemonWriter } from '../cli-grammar/types.ts';
import { enumField, jsonSchemaField, readFieldInput } from '../command-input.ts';
import { defineCommandFacet } from '../family/types.ts';
import { defineFieldCommandMetadata } from '../field-command-contract.ts';

const FOLD_COMMAND_NAME = 'fold';

const foldGuidance = {
  hingeEvent: 'simulator HID hinge event',
  permissions: 'Device Hub and host Accessibility permission are not required.',
} as const;

const foldCommandDescription = `Fold or unfold a foldable iPhone simulator (iPhone Duo) or a foldable Android emulator into the closed, half-open, or open pose. iOS sends a ${foldGuidance.hingeEvent}, then reads the hinge angle back inside the simulator to confirm it, and can follow timestamped angle keyframes; Android sets the emulator console posture, then confirms the device state the guest commits and reports the angle read from the hinge sensor, which can differ from the AVD profile's per-posture angles, and dismisses the lock screen a fold to the cover display can raise. On iOS a pose change moves the app to a different panel with a different point size; on Android a fold to or from closed moves the app between the cover and inner displays, and any pose change can reshape the app window, whose size the next snapshot reports. Either way every ref and coordinate from before it is stale. Taps, long presses, and scrolling target the app window on its current panel in closed, half-open, and open poses. Simulator and emulator only; iOS requires the iOS simulator SDK; ${foldGuidance.permissions} An iOS simulator in a scoped simulator set folds the same way as one in the default set.`;

const foldFields = {
  pose: enumField(FOLD_POSES, 'Instant preset; mutually exclusive with keyframes.'),
  keyframes: jsonSchemaField<readonly FoldKeyframe[]>({
    type: 'array',
    minItems: 2,
    maxItems: MAX_FOLD_KEYFRAMES,
    description:
      'Piecewise-linear hinge motion. Start at 0ms; strictly increasing timestamps, up to 60000ms. Repeated angles create holds. Mutually exclusive with pose.',
    items: {
      type: 'object',
      required: ['atMs', 'angle'],
      additionalProperties: false,
      properties: {
        atMs: { type: 'integer', minimum: 0, maximum: MAX_FOLD_DURATION_MS },
        angle: { type: 'number', minimum: 0, maximum: 180 },
      },
    },
  }),
};
const foldFieldMetadata = defineFieldCommandMetadata(
  FOLD_COMMAND_NAME,
  foldCommandDescription,
  foldFields,
  {
    readInput: (input) => {
      const fields = readFieldInput(input, foldFields);
      const { pose, keyframes, ...common } = fields;
      return { ...common, ...parseFoldInput({ pose, keyframes }) };
    },
    inputExample: { pose: 'half-open' },
  },
);

const foldCommandMetadata = {
  ...foldFieldMetadata,
  inputSchema: {
    ...foldFieldMetadata.inputSchema,
    oneOf: [
      { required: ['pose'], not: { required: ['keyframes'] } },
      { required: ['keyframes'], not: { required: ['pose'] } },
    ],
  },
};

const foldCliSchema = {
  usageOverride: `fold [${FOLD_POSE_USAGE}]`,
  positionalArgs: ['pose?'],
  allowedFlags: FOLD_FLAGS,
} as const satisfies CommandSchemaOverride;

export const foldCliReader: CliReader = (positionals, flags) => ({
  ...commonInputFromFlags(flags),
  ...parseFoldInput({
    pose: positionals[0],
    keyframes: flags.keyframes === undefined ? undefined : parseFoldKeyframesJson(flags.keyframes),
  }),
});

export const foldDaemonWriter: DaemonWriter = (input) => {
  const fold = parseFoldInput(input);
  return request(FOLD_COMMAND_NAME, fold.pose ? [fold.pose] : [], {
    ...input,
    keyframes: fold.keyframes ? JSON.stringify(fold.keyframes) : undefined,
  });
};

export const foldCommandFacet = defineCommandFacet({
  name: FOLD_COMMAND_NAME,
  effect: 'write',
  text: {
    summary: 'Fold or unfold a foldable iPhone simulator or Android emulator',
    searchHint: 'flip book clamshell',
    cliDetail: `iPhone Duo simulators and foldable Android emulators. iOS sends a ${foldGuidance.hingeEvent} and confirms the hinge angle inside the simulator; Android sets the emulator console posture and confirms the device state. Refs and coordinates do not survive a pose change.`,
  },
  metadata: foldCommandMetadata,
  run: (client, input) => client.command.fold(input),
  cliSchema: foldCliSchema,
  cliReader: foldCliReader,
  daemonWriter: foldDaemonWriter,
});
