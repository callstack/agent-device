import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import { createRuntimeStateHandle } from '@agent-device/host-kit/runtime-slots';
import { trackDownloadableArtifact, trackUploadedArtifact } from './artifact-tracking.ts';

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
