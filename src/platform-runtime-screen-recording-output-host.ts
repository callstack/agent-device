import fs from 'node:fs';
import path from 'node:path';
import type { ScreenRecordingRuntimeHost } from '@agent-device/contracts/screen-recording-runtime-host';

export function createScreenRecordingOutputHost(): ScreenRecordingRuntimeHost['outputs'] {
  return Object.freeze({
    prepare: async (outputPath: string) => {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.rmSync(outputPath, { force: true });
    },
  });
}
