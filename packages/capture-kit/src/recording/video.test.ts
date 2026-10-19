import fs from 'node:fs';
import { createTestHost } from '../host-environment.fixtures.ts';
import path from 'node:path';
import { beforeEach, expect, test, vi } from 'vitest';
import { runCmd } from '@agent-device/host-kit/command';
import { likelyPlayableWebmContainer } from '../__tests__/test-utils/video-fixtures.ts';
import { mkdtempForTestSync } from '../tmp-dir.fixtures.ts';
import { mp4Atom, mp4MovieHeader } from './mp4.fixtures.ts';
import { Deadline } from '@agent-device/host-kit/retry';
import { compileSwiftSourceText } from './swift-cache.ts';
import { isPlayableVideo, waitForPlayableVideo } from './video.ts';

vi.mock('@agent-device/host-kit/command', () => ({
  runCmd: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
}));
vi.mock('./swift-cache.ts', () => ({
  buildSwiftToolEnv: () => ({}),
  getSwiftCacheRoot: (env: NodeJS.ProcessEnv) => env.AGENT_DEVICE_SWIFT_CACHE_DIR ?? '',
  compileSwiftSourceText: vi.fn(async () => '/bin/true'),
}));

beforeEach(() => {
  vi.mocked(runCmd).mockClear();
});

const directory = mkdtempForTestSync('agent-device-video-webm-');
const playableWebm = likelyPlayableWebmContainer();

test('accepts a real WebM video track and complete media block without AVFoundation', async () => {
  await expect(
    isPlayableVideo(writeFixture('capture.webm', playableWebm), createTestHost()),
  ).resolves.toBe(true);
});

test('does not infer WebM from bytes when the requested container is different', async () => {
  await expect(
    isPlayableVideo(writeFixture('capture.bin', playableWebm), createTestHost()),
  ).resolves.toBe(false);
});

function writeFixture(name: string, bytes: Buffer): string {
  const filePath = path.join(directory, name);
  fs.writeFileSync(filePath, bytes);
  return filePath;
}

const ftyp = mp4Atom('ftyp', Buffer.from('isom', 'latin1'));
const moov = mp4Atom(
  'moov',
  mp4Atom('mvhd', mp4MovieHeader({ version: 0, timescale: 1_000, duration: 2_000 })),
);

test('each Swift cache root compiles its own validator, and a root reuses the one it has', async () => {
  const mp4 = writeFixture('validated.mp4', Buffer.concat([ftyp, moov]));
  const hostIn = (cacheDir: string) => ({
    env: { AGENT_DEVICE_SWIFT_CACHE_DIR: cacheDir },
    cwd: directory,
  });
  vi.mocked(compileSwiftSourceText).mockClear();

  await isPlayableVideo(mp4, hostIn('/cache/one'));
  await isPlayableVideo(mp4, hostIn('/cache/one'));
  await isPlayableVideo(mp4, hostIn('/cache/two'));

  expect(
    vi
      .mocked(compileSwiftSourceText)
      .mock.calls.map(([params]) => params.host.env.AGENT_DEVICE_SWIFT_CACHE_DIR),
  ).toEqual(['/cache/one', '/cache/two']);
});

test('reaches the semantic validator with an MP4 container whose last box runs past the file', async () => {
  const truncated = Buffer.concat([ftyp, moov]).subarray(0, ftyp.length + moov.length - 4);
  await expect(
    isPlayableVideo(writeFixture('truncated.mp4', truncated), createTestHost()),
  ).resolves.toBe(true);
  expect(runCmd).toHaveBeenCalledTimes(1);
});

test('refuses an MP4 container that never declares a movie header', async () => {
  const container = Buffer.concat([ftyp, mp4Atom('mdat', Buffer.alloc(8))]);
  await expect(
    isPlayableVideo(writeFixture('no-moov.mp4', container), createTestHost()),
  ).resolves.toBe(false);
  expect(runCmd).not.toHaveBeenCalled();
});

test('waiting for a playable video stops polling once its deadline passes', async () => {
  const filePath = path.join(mkdtempForTestSync('agent-device-video-wait-'), 'never-playable.mp4');
  fs.writeFileSync(filePath, '');
  const started = Date.now();
  await waitForPlayableVideo(filePath, {
    host: createTestHost(),
    pollMs: 60_000,
    deadline: Deadline.fromTimeoutMs(0),
  });
  expect(Date.now() - started).toBeLessThan(1_000);
});
