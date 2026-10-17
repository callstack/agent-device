import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { mkdtempForTestSync } from '../../tmp-dir.fixtures.ts';

vi.mock('@agent-device/host-kit/command', async () => {
  const fs = await import('node:fs');
  return {
    runCmd: vi.fn(async (_cmd: string, args: string[]) => {
      fs.writeFileSync(args[args.indexOf('--output') + 1]!, 'processed');
      return { stdout: '', stderr: '', exitCode: 0 };
    }),
  };
});
vi.mock('../video.ts', () => ({ waitForPlayableVideo: vi.fn(async () => {}) }));
vi.mock('../swift-cache.ts', () => ({
  buildSwiftToolEnv: () => ({}),
  compileSwiftSourceFile: vi.fn(async () => '/bin/true'),
  resolveRecordingScriptPath: vi.fn(
    (name: string, _projectRoot: string, cwd: string) => `${cwd}/${name}`,
  ),
}));

import { overlayRecordingTouches, startRecordingOverlayBudget } from '../overlay.ts';
import { compileSwiftSourceFile } from '../swift-cache.ts';

test('a helper script path is resolved per host working directory, not once per process', async () => {
  const root = mkdtempForTestSync('agent-device-overlay-script-paths-');
  const videoPath = path.join(root, 'recording.mp4');
  const telemetryPath = path.join(root, 'recording.gesture-telemetry.json');
  fs.writeFileSync(telemetryPath, '{"events":[]}');
  const overlay = async (cwd: string) => {
    fs.writeFileSync(videoPath, 'original');
    await overlayRecordingTouches({
      host: { env: {}, cwd },
      videoPath,
      telemetryPath,
      deadline: startRecordingOverlayBudget(),
    });
  };

  await overlay('/cwd/one');
  await overlay('/cwd/two');
  await overlay('/cwd/one');

  expect(vi.mocked(compileSwiftSourceFile).mock.calls.map(([params]) => params.sourcePath)).toEqual(
    [
      '/cwd/one/recording-overlay.swift',
      '/cwd/two/recording-overlay.swift',
      '/cwd/one/recording-overlay.swift',
    ],
  );
});
