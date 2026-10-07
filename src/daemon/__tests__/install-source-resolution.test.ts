import { test, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { resolveInstallSource, toDownloadableSource } from '../install-source-resolution.ts';
import { trackUploadedArtifact } from '../artifact-tracking.ts';
import type { DaemonRequest } from '../daemon-request.ts';
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

test('a GitHub Actions artifact is resolved with the daemon host token, never one from the request', async () => {
  vi.stubEnv('AGENT_DEVICE_GITHUB_TOKEN', '');
  try {
    const req = makeRequest({
      installSource: {
        kind: 'github-actions-artifact',
        owner: 'acme',
        repo: 'mobile',
        artifactId: 1234567890,
        headers: { authorization: 'Bearer client-token' },
      } as never,
    });
    const { source } = resolveInstallSource(req);
    expect(source.kind).toBe('github-actions-artifact');
    await expect(toDownloadableSource(source, req)).rejects.toMatchObject({
      details: { reason: 'github-token-missing' },
    });
  } finally {
    vi.unstubAllEnvs();
  }
});

test('resolveInstallSource refuses an unknown upload id rather than reading the wire path', () => {
  expect(() =>
    resolveInstallSource(
      makeRequest({
        uploadedArtifactId: 'not-a-real-upload',
        installSource: { kind: 'path', path: '/etc/passwd' },
      }),
    ),
  ).toThrow();
});
