import fs from 'node:fs';
import path from 'node:path';
import type { ScreenRecordingRuntimeHost } from '@agent-device/contracts/screen-recording-runtime-host';

export function createScreenRecordingOutputHost(): ScreenRecordingRuntimeHost['outputs'] {
  return Object.freeze({
    prepare: async (outputPath: string) => {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.rmSync(outputPath, { force: true });
    },
    copy: async ({ from, to }) => {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      // No force, no silent skip: copying a recording that is not there is the failure the stop
      // reports, and a half-written export is the thing this whole path exists to avoid.
      fs.copyFileSync(from, to);
    },
    remove: async (filePath) => {
      try {
        fs.rmSync(filePath, { force: true });
      } catch {
        return 'present';
      }
      return pathExists(filePath) ? 'present' : 'removed';
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
