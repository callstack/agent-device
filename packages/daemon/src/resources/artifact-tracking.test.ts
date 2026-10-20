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
