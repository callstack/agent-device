import { expect, test } from 'vitest';
import { resolveRecordingOutputPaths } from './output-path.ts';

test('preserves platform-specific default recording extensions', () => {
  const defaults = resolveRecordingOutputPaths({ platform: 'web', cwd: '/workspace' });
  expect(defaults.requestedPath).toMatch(/^\.\/recording-\d+\.webm$/);
  expect(defaults.outputPath).toMatch(/^\/workspace\/recording-\d+\.webm$/);
  expect(resolveRecordingOutputPaths({ requestedPath: '/tmp/capture', platform: 'web' })).toEqual({
    requestedPath: '/tmp/capture.webm',
    outputPath: '/tmp/capture.webm',
  });
});

test('keeps display paths distinct from expanded native output paths', () => {
  expect(
    resolveRecordingOutputPaths({
      requestedPath: './capture.mp4',
      platform: 'android',
      cwd: '/workspace/project',
    }),
  ).toEqual({
    requestedPath: './capture.mp4',
    outputPath: '/workspace/project/capture.mp4',
  });

  const homePaths = resolveRecordingOutputPaths({
    requestedPath: '~/capture.mp4',
    platform: 'android',
  });
  expect(homePaths.requestedPath).toBe('~/capture.mp4');
  expect(homePaths.outputPath).not.toBe(homePaths.requestedPath);
  expect(homePaths.outputPath).toMatch(/\/capture\.mp4$/);
});
