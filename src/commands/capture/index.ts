import { defineCommandFacet, defineCommandFamilyFromFacets } from '../family/types.ts';
import { PUBLIC_COMMANDS } from '@agent-device/command-registry/catalog';
import type { InspectPointOptions, PointInspectionResult } from '@agent-device/contracts/client';
import { AppError } from '@agent-device/kernel/errors';
import { pointField, requiredField } from '../command-input.ts';
import { commonInputFromFlags, direct } from '../cli-grammar/common.ts';
import type { CliReader, DaemonWriter } from '../cli-grammar/types.ts';
import { defineFieldCommandMetadata } from '../field-command-contract.ts';
import { resultOutput } from '../output-common.ts';
import { alertCommandFacet } from './alert.ts';
import { diffCommandFacet } from './diff.ts';
import { screenshotCommandFacet } from './screenshot.ts';
import { settingsCommandFacet } from './settings.ts';
import { snapshotCommandFacet } from './snapshot.ts';
import { waitCommandFacet } from './wait.ts';

const inspectPointMetadata = defineFieldCommandMetadata(
  'inspect-point',
  'Inspect the live accessibility elements containing one screen coordinate.',
  { point: requiredField(pointField('Screen coordinate to inspect.')) },
);

const inspectPointCliReader: CliReader = (_positionals, flags) => {
  if (typeof flags.pointX !== 'number' || typeof flags.pointY !== 'number') {
    throw new AppError('INVALID_ARGS', 'inspect-point requires --x and --y');
  }
  return { ...commonInputFromFlags(flags), point: { x: flags.pointX, y: flags.pointY } };
};

const inspectPointDaemonWriter: DaemonWriter = direct(PUBLIC_COMMANDS['inspect-point'], (input) => {
  const { point } = input as InspectPointOptions;
  return [String(point.x), String(point.y)];
});

const inspectPointCommandFacet = defineCommandFacet({
  name: 'inspect-point',
  text: { summary: 'Inspect elements at a screen coordinate' },
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

const captureCommandFacets = [
  snapshotCommandFacet,
  inspectPointCommandFacet,
  screenshotCommandFacet,
  diffCommandFacet,
  waitCommandFacet,
  alertCommandFacet,
  settingsCommandFacet,
] as const;

export const captureCommandFamily = defineCommandFamilyFromFacets({
  name: 'capture',
  commands: captureCommandFacets,
});
