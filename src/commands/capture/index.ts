import { defineCommandFamilyFromFacets } from '../family/types.ts';
import { alertCommandFacet, alertCliReader, alertDaemonWriter } from './alert.ts';
import { diffCommandFacet, diffCliReader } from './diff.ts';
import {
  screenshotCommandFacet,
  screenshotCliReader,
  screenshotDaemonWriter,
} from './screenshot.ts';
import { settingsCliReader, settingsCommandFacet, settingsDaemonWriter } from './settings.ts';
import { snapshotCommandFacet, snapshotCliReader } from './snapshot.ts';
import { waitCommandFacet, waitCliReader, waitDaemonWriter } from './wait.ts';

const captureCommandFacets = [
  snapshotCommandFacet,
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

export {
  alertCliReader,
  alertDaemonWriter,
  diffCliReader,
  screenshotCliReader,
  screenshotDaemonWriter,
  settingsCliReader,
  settingsDaemonWriter,
  snapshotCliReader,
  waitCliReader,
  waitDaemonWriter,
};
