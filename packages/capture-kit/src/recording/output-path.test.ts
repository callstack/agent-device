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

test.each([
  ['android', '.mp4'],
  ['web', '.webm'],
] as const)(
  'records a remote caller default on the daemon host and completes its %s destination',
  (platform, extension) => {
    const paths = resolveRecordingOutputPaths({
      clientOutputPath: '/client/project/recording-1',
      platform,
      cwd: '/client/project',
    });
    expect(paths.clientOutputPath).toBe(`/client/project/recording-1${extension}`);
    expect(paths.requestedPath).toBe(paths.clientOutputPath);
    expect(paths.outputPath).toMatch(
      new RegExp(`^/tmp/agent-device-recording-\\d+-[a-z0-9]+\\${extension}$`),
    );
  },
);

test('keeps a remote caller explicit path on the redirected daemon temp path', () => {
  expect(
    resolveRecordingOutputPaths({
      requestedPath: '/tmp/agent-device-recording-1-abc.mp4',
      clientOutputPath: '/client/project/capture.mp4',
      platform: 'android',
      cwd: '/client/project',
    }),
  ).toEqual({
    requestedPath: '/tmp/agent-device-recording-1-abc.mp4',
    outputPath: '/tmp/agent-device-recording-1-abc.mp4',
    clientOutputPath: '/client/project/capture.mp4',
  });
});
