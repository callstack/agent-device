import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { DaemonArtifact } from '@agent-device/kernel/contracts';
import { expect, test, type TestContext } from 'vitest';
import {
  closeLoopbackServer,
  createTestHostEnvironment,
  listenOnLoopback,
  mkdtempForTestSync,
  skipWhenLoopbackUnavailable,
} from '@agent-device/test-kit';
import { materializeRemoteArtifacts } from '../daemon-artifacts.ts';

async function withRecordingServer(
  t: TestContext,
  run: (cwd: string, stop: ReturnType<typeof recordStop>) => Promise<void>,
): Promise<void> {
  if (await skipWhenLoopbackUnavailable(t, 'remote recording download')) return;
  const root = mkdtempForTestSync('agent-device-record-download-');
  const cwd = path.join(root, 'cwd');
  fs.mkdirSync(cwd);
  const server = http.createServer((req, res) => res.end(path.basename(req.url ?? '')));
  try {
    const port = await listenOnLoopback(server);
    await run(cwd, recordStop(`http://127.0.0.1:${port}`, cwd, path.join(root, 'state')));
  } finally {
    await closeLoopbackServer(server);
  }
}

function recordStop(baseUrl: string, cwd: string, stateDir: string) {
  return async (artifacts: DaemonArtifact[], requested?: string, chunks?: unknown) => {
    const response = await materializeRemoteArtifacts(
      { baseUrl, token: 'secret' },
      {
        token: 'secret',
        command: 'record',
        session: 'capture',
        positionals: requested ? ['stop', requested] : ['stop'],
        meta: { cwd },
      },
      { ok: true, data: { artifacts, chunks, outPath: '/daemon/other.mp4' } },
      createTestHostEnvironment(),
      stateDir,
    );
    if (!response.ok) throw new Error(response.error.message);
    return response.data;
  };
}

const video = {
  artifactId: 'video',
  field: 'outPath',
  artifactType: 'screen-recording',
  path: '/daemon/clip.mp4',
  fileName: 'clip.mp4',
} satisfies DaemonArtifact;

test('record stop ignores the daemon localPath and warns about the cwd download', async (t) => {
  await withRecordingServer(t, async (cwd, stop) => {
    const hostile = path.resolve(cwd, '../hostile.mp4');
    const data = await stop([{ ...video, localPath: hostile }]);
    const fallback = path.join(cwd, 'clip.mp4');
    expect(fs.existsSync(hostile)).toBe(false);
    expect(fs.readFileSync(fallback, 'utf8')).toBe('video');
    expect(data).toMatchObject({
      outPath: fallback,
      recordingDestinationWarnings: [
        { reason: 'recording_destination_not_requested', field: 'outPath', path: fallback },
      ],
      warnings: [expect.stringContaining(fallback)],
    });
  });
});

test('record stop uses the destination named in the current request', async (t) => {
  await withRecordingServer(t, async (cwd, stop) => {
    const hostile = path.resolve(cwd, '../hostile.mp4');
    const data = await stop([{ ...video, localPath: hostile }], '../requested.mp4');
    const requested = path.resolve(cwd, '../requested.mp4');
    expect(fs.existsSync(hostile)).toBe(false);
    expect(fs.readFileSync(requested, 'utf8')).toBe('video');
    expect(data?.outPath).toBe(requested);
    expect(data?.recordingDestinationWarnings).toBeUndefined();
  });
});

test('record stop replaces a destination symlink without writing through it', async (t) => {
  await withRecordingServer(t, async (cwd, stop) => {
    const destination = path.join(cwd, 'clip.mp4');
    const target = path.resolve(cwd, '../target');
    fs.writeFileSync(target, 'original');
    fs.symlinkSync(target, destination);
    await stop([video]);
    expect(fs.readFileSync(target, 'utf8')).toBe('original');
    expect(fs.lstatSync(destination).isFile()).toBe(true);
    expect(fs.readFileSync(destination, 'utf8')).toBe('video');
    expect(fs.readdirSync(cwd)).toEqual(['clip.mp4']);
  });
});

test.for([
  'C:foo.mp4',
  'clip.mp4:stream',
  '..',
  'CON.mp4',
  'nested/clip.mp4',
  String.raw`x\clip.mp4`,
  'x\n.mp4',
])('record stop generates a name in cwd for %j', async (fileName, t) => {
  await withRecordingServer(t, async (cwd, stop) => {
    const data = await stop([{ ...video, fileName }]);
    const names = fs.readdirSync(cwd);
    expect(names).toHaveLength(1);
    expect(names).not.toContain(fileName);
    expect(names).not.toContain(path.posix.basename(fileName));
    expect(names).not.toContain(path.win32.basename(fileName));
    const destination = path.join(cwd, names[0]!);
    expect(data?.outPath).toBe(destination);
    expect(fs.readFileSync(destination, 'utf8')).toBe('video');
    expect(data?.recordingDestinationWarnings).toEqual([
      { reason: 'recording_destination_not_requested', field: 'outPath', path: destination },
    ]);
  });
});

test('record stop downloads each chunk and telemetry to cwd', async (t) => {
  await withRecordingServer(t, async (cwd, stop) => {
    const data = await stop(
      [
        video,
        {
          artifactId: 'chunk',
          field: 'chunkPath',
          artifactType: 'screen-recording-chunk',
          fileName: 'second.mp4',
          localPath: path.resolve(cwd, '../second.mp4'),
        },
        {
          artifactId: 'telemetry',
          field: 'telemetryPath',
          artifactType: 'screen-recording-telemetry',
          fileName: 'telemetry.json',
          localPath: path.resolve(cwd, '../telemetry.json'),
        },
      ],
      undefined,
      [
        { index: 0, path: video.path },
        { index: 1, path: '/daemon/second.mp4' },
      ],
    );
    const second = path.join(cwd, 'second.mp4');
    const telemetry = path.join(cwd, 'telemetry.json');
    expect(fs.readFileSync(path.join(cwd, 'clip.mp4'), 'utf8')).toBe('video');
    expect(fs.readFileSync(second, 'utf8')).toBe('chunk');
    expect(fs.readFileSync(telemetry, 'utf8')).toBe('telemetry');
    expect(fs.existsSync(path.resolve(cwd, '../second.mp4'))).toBe(false);
    expect(fs.existsSync(path.resolve(cwd, '../telemetry.json'))).toBe(false);
    expect(data).toMatchObject({
      chunks: [
        { index: 0, path: path.join(cwd, 'clip.mp4') },
        { index: 1, path: second },
      ],
      telemetryPath: telemetry,
      recordingDestinationWarnings: [
        { field: 'outPath', path: path.join(cwd, 'clip.mp4') },
        { field: 'chunkPath', path: second },
        { field: 'telemetryPath', path: telemetry },
      ],
    });
  });
});
