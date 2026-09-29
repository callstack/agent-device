import { NATIVE_PATH_DISPOSITION_VALUES } from '@agent-device/contracts/recording-native-path';
import { RECORDER_OBSERVATION_VALUES } from '@agent-device/contracts/recording-stop-observation';
import type { CommandResultMap } from '@agent-device/command-registry/command-result';
import type { JsonSchema } from '../command-contract.ts';
import {
  booleanSchema,
  constSchema,
  enumSchema,
  looseObjectSchema,
  numberSchema,
  objectSchema,
  stringSchema,
} from '../command-input.ts';

const artifactSchema = objectSchema(
  {
    field: stringSchema(),
    artifactType: stringSchema(),
    path: stringSchema(),
    localPath: stringSchema(),
    fileName: stringSchema(),
  },
  ['field'],
);

/**
 * This family's advertised MCP `outputSchema`s, keyed by daemon command name and projected into
 * the command map by `src/mcp/command-output-schemas.ts`. Non-strict like every other entry: no
 * `additionalProperties: false`, so additive response fields keep validating. Neither command
 * carries the post-action observation trait (#1652): both fire-and-report a recording or trace
 * lifecycle change, not an interaction, so no settle-graft copy applies here.
 */
export const RECORDING_COMMAND_OUTPUT_SCHEMAS = {
  // packages/contracts/src/recording.ts
  record: {
    type: 'object',
    oneOf: [
      objectSchema(
        {
          recording: constSchema('started'),
          outPath: stringSchema(),
          sessionStateDir: stringSchema(),
          recordingBackend: stringSchema(),
          recordingScope: stringSchema(),
          recordOnlySession: booleanSchema(),
          activeSessionApp: looseObjectSchema(),
          showTouches: booleanSchema(),
        },
        ['recording', 'outPath', 'sessionStateDir', 'showTouches'],
      ),
      objectSchema(
        {
          recording: constSchema('stopped'),
          outPath: stringSchema(),
          telemetryPath: stringSchema(),
          artifacts: { type: 'array', items: artifactSchema },
          recordingBackend: stringSchema(),
          recordingScope: stringSchema(),
          recordOnlySession: booleanSchema(),
          activeSessionApp: looseObjectSchema(),
          durationMs: numberSchema(),
          capturedDurationMs: numberSchema(),
          recorder: enumSchema(
            RECORDER_OBSERVATION_VALUES,
            'What the recorder was observed doing when the recording was stopped: confirmed, or lost when the session holding it died. ADR 0024 reserves unconfirmed for the step that gains the probe.',
          ),
          nativePathDisposition: enumSchema(
            NATIVE_PATH_DISPOSITION_VALUES,
            'What became of the artifact path the recorder writes to: retirable while it still owes a removal, retired once that removal was verified. ADR 0024 reserves pending.',
          ),
          showTouches: booleanSchema(),
          warning: stringSchema(),
          overlayWarning: stringSchema(),
          chunks: { type: 'array', items: looseObjectSchema() },
        },
        ['recording', 'outPath', 'artifacts', 'durationMs', 'showTouches'],
      ),
    ],
  },
  trace: {
    type: 'object',
    oneOf: [
      objectSchema({ trace: constSchema('started'), outPath: stringSchema() }, [
        'trace',
        'outPath',
      ]),
      objectSchema(
        {
          trace: constSchema('stopped'),
          outPath: stringSchema(),
          artifacts: { type: 'array', items: artifactSchema },
        },
        ['trace', 'outPath', 'artifacts'],
      ),
    ],
  },
} satisfies Pick<Record<keyof CommandResultMap, JsonSchema>, 'record' | 'trace'>;
