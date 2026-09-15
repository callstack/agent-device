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

test('copies a recording file and leaves the source alone', async () => {
  const root = mkdtempForTestSync('agent-device-recording-copy-');
  const from = path.join(root, 'capture.native.mp4');
  const to = path.join(root, 'nested', 'capture.collected.mp4');
  fs.writeFileSync(from, 'recorded');

  await createScreenRecordingOutputHost().copy({ from, to });

  expect(fs.readFileSync(to, 'utf8')).toBe('recorded');
  expect(fs.existsSync(from)).toBe(true);
});

test('copies over whatever already sits at the destination', async () => {
  const root = mkdtempForTestSync('agent-device-recording-copy-');
  const from = path.join(root, 'capture.collected.mp4');
  const to = path.join(root, 'capture.mp4');
  fs.writeFileSync(from, 'recorded');
  fs.writeFileSync(to, 'stale');

  await createScreenRecordingOutputHost().copy({ from, to });

  expect(fs.readFileSync(to, 'utf8')).toBe('recorded');
});

test('copying a recording that is not there fails rather than passing quietly', async () => {
  const root = mkdtempForTestSync('agent-device-recording-copy-');
  await expect(
    createScreenRecordingOutputHost().copy({
      from: path.join(root, 'capture.native.mp4'),
      to: path.join(root, 'capture.collected.mp4'),
    }),
  ).rejects.toThrow(/ENOENT/);
});

test('removes a recording file and says so, including one that was already gone', async () => {
  const root = mkdtempForTestSync('agent-device-recording-remove-');
  const filePath = path.join(root, 'capture.native.mp4');
  fs.writeFileSync(filePath, 'recorded');

  expect(await createScreenRecordingOutputHost().remove(filePath)).toBe('removed');
  expect(fs.existsSync(filePath)).toBe(false);
  expect(await createScreenRecordingOutputHost().remove(filePath)).toBe('removed');
});

test('says a recording file it could not remove is still there instead of throwing', async () => {
  const root = mkdtempForTestSync('agent-device-recording-remove-');
  // A path the host cannot unlink is the case the answer exists for: the caller is told the file may
  // still be there instead of being promised it is gone.
  const filePath = path.join(root, 'capture.native.mp4');
  fs.mkdirSync(filePath);

  expect(await createScreenRecordingOutputHost().remove(filePath)).toBe('present');
  expect(fs.existsSync(filePath)).toBe(true);
});
