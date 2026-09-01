import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { test, vi } from 'vitest';
import * as networkTransport from '@agent-device/provision-kit/install-source-network-transport';
import { mkdtempForTest } from './test-utils/tmp-dir.ts';
import { prepareAndroidInstallArtifact } from '../install-artifact.ts';
import * as manifest from '../manifest.ts';

test('aborts an in-flight Android artifact identity probe', async () => {
  const tempRoot = await mkdtempForTest('agent-device-android-artifact-abort-');
  const archivePath = path.join(tempRoot, 'app.apk');
  await fs.writeFile(archivePath, 'fixture');
  const controller = new AbortController();
  const probe = vi
    .spyOn(manifest, 'resolveAndroidArchivePackageName')
    .mockImplementation(async (_path, signal) => {
      assert.equal(signal, controller.signal);
      await new Promise<never>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });

  try {
    const pending = prepareAndroidInstallArtifact(
      { kind: 'path', path: archivePath },
      { signal: controller.signal },
    );
    await vi.waitFor(() => assert.equal(probe.mock.calls.length, 1));
    controller.abort(new DOMException('cancelled', 'AbortError'));
    await assert.rejects(pending, { name: 'AbortError' });
  } finally {
    probe.mockRestore();
  }
});

test('cleans URL materialization when identity inspection fails', async () => {
  const tempRoot = await mkdtempForTest('agent-device-android-artifact-cleanup-');
  const tmpdirSpy = vi.spyOn(os, 'tmpdir').mockReturnValue(tempRoot);
  const lookupSpy = vi
    .spyOn(dns, 'lookup')
    .mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as unknown as Awaited<
      ReturnType<typeof dns.lookup>
    >);
  const requestSpy = vi.spyOn(networkTransport, 'requestApprovedUrl').mockResolvedValue({
    statusCode: 200,
    headers: {
      'content-disposition': 'attachment; filename="app.apk"',
      'content-type': 'application/vnd.android.package-archive',
    },
    body: Readable.from(Buffer.from('invalid apk')),
    close: async () => {},
  });
  const manifestSpy = vi
    .spyOn(manifest, 'resolveAndroidArchivePackageName')
    .mockRejectedValue(new Error('identity failed'));

  try {
    await assert.rejects(
      () =>
        prepareAndroidInstallArtifact({
          kind: 'url',
          url: 'https://example.com/app.apk',
        }),
      /identity failed/,
    );
    assert.deepEqual(await fs.readdir(tempRoot), []);
  } finally {
    manifestSpy.mockRestore();
    requestSpy.mockRestore();
    lookupSpy.mockRestore();
    tmpdirSpy.mockRestore();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
