import { PUBLIC_COMMANDS } from '@agent-device/command-registry/catalog';
import type { InspectPointOptions, PointInspectionResult } from '@agent-device/contracts/client';
import { SNAPSHOT_BACKEND_CAPABILITIES } from '@agent-device/capture-kit/snapshot-quality-backend-capabilities';
import {
  SNAPSHOT_COMMAND_OPTION_KEYS,
  snapshotOptionsFromFlags,
} from '@agent-device/kernel/snapshot';
import { SNAPSHOT_FLAGS } from '@agent-device/command-registry/flag-groups';
import { AppError } from '@agent-device/kernel/errors';
import {
  booleanField,
  integerField,
  optionField,
  pointField,
  requiredField,
  stringField,
} from '../command-input.ts';
import {
  commonInputFromFlags,
  direct,
  observationRecordInputFromFlags,
} from '../cli-grammar/common.ts';
import type { CliReader, DaemonWriter } from '../cli-grammar/types.ts';
import { defineCommandFacet } from '../family/types.ts';
import { defineFieldCommandMetadata } from '../field-command-contract.ts';
import { captureCliOutputFormatters } from './output.ts';
import { resultOutput } from '../output-common.ts';

const SNAPSHOT_COMMAND_NAME = 'snapshot';

const snapshotCommandDescription =
  'Capture the accessibility tree or compare it with the previous session baseline. Use the returned refs for subsequent semantic interactions and the diff option to verify UI changes.';

const snapshotBackendCapabilityHelp = Object.entries(SNAPSHOT_BACKEND_CAPABILITIES)
  .map(([backend, capability]) => {
    const gaps = capability.knownGaps.map((gap) => `known gap ${gap}`);
    return `${backend}: hittable=${capability.hittable}, regular-depth=${capability.regularDepth}, deep-extension=${capability.deepExtension}, depth-ladder=${capability.depthLadder}${gaps.length > 0 ? `, ${gaps.join(', ')}` : ''}`;
  })
  .join('; ');

const snapshotCommandMetadata = defineFieldCommandMetadata(
  SNAPSHOT_COMMAND_NAME,
  snapshotCommandDescription,
  {
    interactiveOnly: booleanField(),
    depth: integerField(),
    scope: stringField(),
    raw: booleanField(),
    customActions: optionField('snapshotCustomActions'),
    forceFull: booleanField(),
    timeoutMs: integerField('Maximum wall-clock time for the snapshot command.'),
    // #1271 stage 2: `snapshot` is observation-only, so a repair-armed heal
    // excludes an out-of-band one by default (ADR 0012 amendment). Exposed
    // here so the Node SDK's typed options and the MCP tool schema can set
    // both flags, mirroring `--no-record`/`--record` on the CLI.
    noRecord: booleanField('Do not record this action.'),
    record: booleanField(
      'Force-record this out-of-band observation into a repair-armed heal (mutually exclusive with noRecord). Authored replay steps are recorded automatically and never need this.',
    ),
  },
);

const snapshotCliSchema = {
  allowedFlags: [
    'snapshotDiff',
    ...SNAPSHOT_FLAGS,
    'snapshotCustomActions',
    'snapshotForceFull',
    'timeoutMs',
    'record',
  ],
} as const;

export const snapshotCliReader: CliReader = (_positionals, flags) => ({
  ...commonInputFromFlags(flags),
  ...observationRecordInputFromFlags(flags),
  ...snapshotOptionsFromFlags(flags, SNAPSHOT_COMMAND_OPTION_KEYS),
  timeoutMs: flags.timeoutMs,
});

const snapshotDaemonWriter: DaemonWriter = direct(PUBLIC_COMMANDS.snapshot);

export const snapshotCommandFacet = defineCommandFacet({
  name: SNAPSHOT_COMMAND_NAME,
  text: {
    summary: 'Capture or diff the accessibility tree',
    cliDetail: `Repeated equivalent unfiltered Android snapshots return a compact unchanged acknowledgement. Use --force-full to re-emit the tree; --json and --raw retain full output. For iOS raw-coordinate fallback after a no-op ref press, inspect rects with snapshot -i --json, press the rect center, then verify with diff snapshot -i or snapshot --diff. iOS backend capability contract: ${snapshotBackendCapabilityHelp}.`,
  },
  metadata: snapshotCommandMetadata,
  run: (client, input) => client.capture.snapshot(input),
  cliSchema: snapshotCliSchema,
  cliReader: snapshotCliReader,
  daemonWriter: snapshotDaemonWriter,
  cliOutputFormatter: captureCliOutputFormatters.snapshot,
});

const inspectPointMetadata = defineFieldCommandMetadata(
  'inspect-point',
  'Inspect the live accessibility elements containing one screen coordinate.',
  { point: requiredField(pointField('Screen coordinate to inspect.')) },
);

export const inspectPointCliReader: CliReader = (_positionals, flags) => {
  if (typeof flags.pointX !== 'number' || typeof flags.pointY !== 'number') {
    throw new AppError('INVALID_ARGS', 'inspect-point requires --x and --y');
  }
  return { ...commonInputFromFlags(flags), point: { x: flags.pointX, y: flags.pointY } };
};

export const inspectPointDaemonWriter: DaemonWriter = direct(
  PUBLIC_COMMANDS['inspect-point'],
  (input) => {
    const { point } = input as InspectPointOptions;
    return [String(point.x), String(point.y)];
  },
);

export const inspectPointCommandFacet = defineCommandFacet({
  name: 'inspect-point',
  text: { summary: 'Inspect accessibility elements at a screen coordinate' },
  metadata: inspectPointMetadata,
  run: (client, input) => client.capture.inspectPoint(input),
  cliSchema: { allowedFlags: ['pointX', 'pointY'] },
  cliReader: inspectPointCliReader,
  daemonWriter: inspectPointDaemonWriter,
  cliOutputFormatter: resultOutput((result: PointInspectionResult) => ({
    data: result,
    text: JSON.stringify(result, null, 2),
  })),
});
