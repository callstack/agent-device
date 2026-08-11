import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { mkdtempForTestSync } from './__tests__/test-utils/tmp-dir.ts';
import { createScreenRecordingOutputHost } from './platform-runtime-screen-recording-output-host.ts';

test('prepares the closed recording output path after semantic validation', async () => {
  const root = mkdtempForTestSync('agent-device-recording-output-');
  const outputPath = path.join(root, 'nested', 'capture.mp4');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, 'stale');

  await createScreenRecordingOutputHost().prepare(outputPath);

  expect(fs.existsSync(path.dirname(outputPath))).toBe(true);
  expect(fs.existsSync(outputPath)).toBe(false);
});
