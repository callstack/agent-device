import fs from 'node:fs';
import { once } from 'node:events';
import path from 'node:path';
import { buffer } from 'node:stream/consumers';
import { gunzipSync } from 'node:zlib';
import { expect, test } from 'vitest';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import { createRuntimeStateHandle } from '@agent-device/host-kit/runtime-slots';
import {
  cleanupDownloadableArtifact,
  openDownloadableArtifact,
  trackDownloadableArtifact,
  trackUploadedArtifact,
} from './artifact-tracking.ts';

test('disposing a runtime removes the temporary files it still tracks', () => {
  const root = mkdtempForTestSync('agent-device-artifact-dispose-');
  const artifactPath = path.join(root, 'artifact.txt');
  const uploadDir = path.join(root, 'upload');
  fs.writeFileSync(artifactPath, 'artifact');
  fs.mkdirSync(uploadDir);
  fs.writeFileSync(path.join(uploadDir, 'payload'), 'payload');
  const runtime = createRuntimeStateHandle();

  runtime.run(() => {
    trackDownloadableArtifact({
      artifactPath,
      artifactType: 'runtime-artifact',
      fileName: 'artifact.txt',
    });
    trackUploadedArtifact({ artifactPath: path.join(uploadDir, 'payload'), tempDir: uploadDir });
  });
  runtime.dispose();

  expect(fs.existsSync(uploadDir)).toBe(false);
  expect(fs.existsSync(artifactPath)).toBe(false);
});

test('a file tracked twice for one tenant keeps one id, and another tenant gets its own', () => {
  const root = mkdtempForTestSync('agent-device-artifact-reuse-');
  const artifactPath = path.join(root, 'recording.mp4');
  fs.writeFileSync(artifactPath, 'video');
  const runtime = createRuntimeStateHandle();

  const [first, again, otherTenant] = runtime.run(() => {
    const track = (tenantId: string) =>
      trackDownloadableArtifact({
        artifactPath,
        tenantId,
        artifactType: 'screen-recording',
        fileName: 'recording.mp4',
      });
    return [track('tenant-a'), track('tenant-a'), track('tenant-b')];
  });
  runtime.dispose();

  expect(again).toBe(first);
  expect(otherTenant).not.toBe(first);
});

test.each(
  (['old-first', 'new-first'] as const).flatMap((order) =>
    [true, false].map((deleteAfterDownload) => ({ order, deleteAfterDownload })),
  ),
)(
  're-registering a directory during deferred cleanup keeps both downloads alive ($order, deleteAfterDownload=$deleteAfterDownload)',
  async ({ order, deleteAfterDownload }) => {
    const root = mkdtempForTestSync('fu-art-register-');
    const artifactPath = path.join(root, 'capture.trace');
    fs.mkdirSync(artifactPath);
    const payloadPath = path.join(artifactPath, 'payload');
    fs.writeFileSync(payloadPath, 'original capture marker');
    const runtime = createRuntimeStateHandle();
    const streams: fs.ReadStream[] = [];
    const track = (deleteAfterDownload = true) =>
      runtime.run(() =>
        trackDownloadableArtifact({
          artifactPath,
          artifactType: 'trace-log',
          tenantId: 'tenant-a',
          deleteAfterDownload,
        }),
      );
    const open = async (id: string) => {
      const artifact = await runtime.run(() =>
        openDownloadableArtifact(id, 'tenant-a', process.env),
      );
      streams.push(artifact.stream);
      return artifact.stream;
    };
    const read = async (stream: fs.ReadStream, expected: string) => {
      const closed = once(stream, 'close');
      const bytes = await buffer(stream);
      await closed;
      expect(gunzipSync(bytes).includes(Buffer.from(expected))).toBe(true);
      expect(fs.existsSync(path.dirname(String(stream.path)))).toBe(false);
    };
    try {
      const firstId = track();
      const first = await open(firstId);
      runtime.run(() => cleanupDownloadableArtifact(firstId));
      fs.writeFileSync(payloadPath, 'replacement capture marker');
      const nextId = track(deleteAfterDownload);
      expect(nextId).not.toBe(firstId);
      if (order === 'old-first') {
        await read(first, 'original capture marker');
        expect(fs.existsSync(artifactPath)).toBe(true);
      }
      const next = await open(nextId);
      runtime.run(() => cleanupDownloadableArtifact(nextId));
      await read(next, 'replacement capture marker');
      if (order === 'new-first') {
        expect(fs.existsSync(artifactPath)).toBe(true);
        await read(first, 'original capture marker');
      }
      expect(fs.existsSync(artifactPath)).toBe(!deleteAfterDownload);
    } finally {
      for (const stream of streams) {
        if (stream.closed) continue;
        const closed = once(stream, 'close');
        stream.destroy();
        await closed;
      }
      runtime.dispose();
    }
  },
);
