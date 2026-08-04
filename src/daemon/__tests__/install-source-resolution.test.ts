import { test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { resolveInstallSource } from '../install-source-resolution.ts';
import { trackUploadedArtifact } from '../artifact-tracking.ts';
import type { DaemonRequest } from '../types.ts';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';

function makeRequest(meta?: DaemonRequest['meta']): DaemonRequest {
  return {
    token: 't',
    session: 'default',
    command: 'install_source',
    positionals: [],
    flags: { platform: 'android' },
    meta,
  };
}

test('resolveInstallSource uses uploaded artifact path for uploaded path sources', () => {
  const tempRoot = mkdtempForTestSync('agent-device-install-source-upload-');
  const artifactPath = path.join(tempRoot, 'Sample.apk');
  fs.writeFileSync(artifactPath, 'apk-binary');
  const uploadedArtifactId = trackUploadedArtifact({ artifactPath, tempDir: tempRoot });

  const resolved = resolveInstallSource(
    makeRequest({
      uploadedArtifactId,
      installSource: {
        kind: 'path',
        path: '/Users/dev/Downloads/Sample.apk',
      },
    }),
  );

  expect(resolved.source.kind).toBe('path');
  if (resolved.source.kind === 'path') {
    expect(resolved.source.path).toBe(artifactPath);
  }

  resolved.cleanup();
  expect(fs.existsSync(tempRoot)).toBe(false);
});

test('resolveInstallSource leaves URL sources unchanged even when upload metadata exists', () => {
  const resolved = resolveInstallSource(
    makeRequest({
      uploadedArtifactId: 'upload-123',
      installSource: {
        kind: 'url',
        url: 'https://example.com/app.apk',
        headers: {},
      },
    }),
  );

  expect(resolved.source).toEqual({
    kind: 'url',
    url: 'https://example.com/app.apk',
    headers: {},
  });
  resolved.cleanup();
});

test('resolveInstallSource rejects GitHub Actions artifact sources on the local daemon', () => {
  expect(() =>
    resolveInstallSource(
      makeRequest({
        installSource: {
          kind: 'github-actions-artifact',
          owner: 'acme',
          repo: 'mobile',
          artifactId: 1234567890,
        },
      }),
    ),
  ).toThrow(/compatible remote daemon/i);
});
