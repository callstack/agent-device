import { defineCommandFamilyFromFacets } from '../family/types.ts';
import { alertCommandFacet } from './alert.ts';
import { diffCommandFacet } from './diff.ts';
import { screenshotCommandFacet } from './screenshot.ts';
import { settingsCommandFacet } from './settings.ts';
import { inspectPointCommandFacet, snapshotCommandFacet } from './snapshot.ts';
import { waitCommandFacet } from './wait.ts';

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
