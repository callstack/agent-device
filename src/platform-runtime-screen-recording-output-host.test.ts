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

test('collects the recorder file as a copy and leaves the recorder file alone', async () => {
  const root = mkdtempForTestSync('agent-device-recording-collect-');
  const recorderPath = path.join(root, 'capture.native.mp4');
  const collectedPath = path.join(root, 'nested', 'capture.collected.mp4');
  fs.writeFileSync(recorderPath, 'recorded');

  await createScreenRecordingOutputHost().collectFromRecorder({ recorderPath, collectedPath });

  expect(fs.readFileSync(collectedPath, 'utf8')).toBe('recorded');
  expect(fs.existsSync(recorderPath)).toBe(true);
});

test('collecting a recording that is not there fails rather than passing quietly', async () => {
  const root = mkdtempForTestSync('agent-device-recording-collect-');
  await expect(
    createScreenRecordingOutputHost().collectFromRecorder({
      recorderPath: path.join(root, 'capture.native.mp4'),
      collectedPath: path.join(root, 'capture.collected.mp4'),
    }),
  ).rejects.toThrow(/ENOENT/);
});

test('writes the export from the collected copy over whatever is already there', async () => {
  const root = mkdtempForTestSync('agent-device-recording-export-');
  const collectedPath = path.join(root, 'capture.collected.mp4');
  const exportPath = path.join(root, 'nested', 'capture.mp4');
  fs.writeFileSync(collectedPath, 'recorded');
  fs.mkdirSync(path.dirname(exportPath), { recursive: true });
  fs.writeFileSync(exportPath, 'stale');

  await createScreenRecordingOutputHost().writeExportFromCollected({ collectedPath, exportPath });

  expect(fs.readFileSync(exportPath, 'utf8')).toBe('recorded');
});

test('retires the recorder file once the export exists', async () => {
  const root = mkdtempForTestSync('agent-device-recording-retire-');
  const recorderPath = path.join(root, 'capture.native.mp4');
  fs.writeFileSync(recorderPath, 'recorded');

  expect(await createScreenRecordingOutputHost().retireRecorderFile(recorderPath)).toBe('retired');
  expect(fs.existsSync(recorderPath)).toBe(false);
});

test('says a recorder file it could not remove is still there', async () => {
  const root = mkdtempForTestSync('agent-device-recording-retire-');
  // A path the host cannot unlink is the case the disposition exists for: the caller is told the
  // file may still be there instead of being promised it is gone.
  const recorderPath = path.join(root, 'capture.native.mp4');
  fs.mkdirSync(recorderPath);

  expect(await createScreenRecordingOutputHost().retireRecorderFile(recorderPath)).toBe(
    'retirable',
  );
  expect(fs.existsSync(recorderPath)).toBe(true);
});

test('discards the collected copy once the export stands', async () => {
  const root = mkdtempForTestSync('agent-device-recording-discard-');
  const collectedPath = path.join(root, 'capture.collected.mp4');
  fs.writeFileSync(collectedPath, 'recorded');

  await createScreenRecordingOutputHost().discardCollectedFile(collectedPath);

  expect(fs.existsSync(collectedPath)).toBe(false);
  await expect(
    createScreenRecordingOutputHost().discardCollectedFile(collectedPath),
  ).resolves.toBeUndefined();
});
