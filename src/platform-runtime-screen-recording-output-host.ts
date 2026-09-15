import fs from 'node:fs';
import path from 'node:path';
import type { ScreenRecordingRuntimeHost } from '@agent-device/contracts/screen-recording-runtime-host';

export function createScreenRecordingOutputHost(): ScreenRecordingRuntimeHost['outputs'] {
  return Object.freeze({
    prepare: async (outputPath: string) => {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.rmSync(outputPath, { force: true });
    },
    collectFromRecorder: async ({ recorderPath, collectedPath }) => {
      fs.mkdirSync(path.dirname(collectedPath), { recursive: true });
      // No force, no silent skip: copying a recording that is not there is the failure the stop
      // reports, and a half-written export is the thing this whole path exists to avoid.
      fs.copyFileSync(recorderPath, collectedPath);
    },
    writeExportFromCollected: async ({ collectedPath, exportPath }) => {
      fs.mkdirSync(path.dirname(exportPath), { recursive: true });
      fs.copyFileSync(collectedPath, exportPath);
    },
    retireRecorderFile: async (recorderPath) => {
      try {
        fs.rmSync(recorderPath, { force: true });
      } catch {
        return 'retirable';
      }
      return pathExists(recorderPath) ? 'retirable' : 'retired';
    },
    discardCollectedFile: async (collectedPath) => {
      fs.rmSync(collectedPath, { force: true });
    },
  });
}

function pathExists(filePath: string): boolean {
  try {
    fs.accessSync(filePath);
    return true;
  } catch {
    return false;
  }
}
