import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { runCmdSync, withCommandExecutorOverride } from '@agent-device/host-kit/command';
import {
  ARCHIVE_EXTENSIONS,
  isTrustedInstallSourceUrl,
  materializeInstallablePath,
  validateDownloadSourceUrl,
} from '@agent-device/provision-kit/install-source';
import {
  isBlockedIpAddress,
  isBlockedSourceHostname,
} from '@agent-device/provision-kit/install-source-network';
import * as androidManifest from '../android/manifest.ts';
import { prepareAndroidInstallArtifact } from '../android/install-artifact.ts';
import { prepareIosInstallArtifact } from '../apple/core/install-artifact.ts';
import {
  createLocalAppleToolProvider,
  withAppleToolProvider,
} from '../apple/core/tool-provider.ts';
import { ANDROID_INSTALL_SOURCE_CONTRACT_EVIDENCE } from './install-source.coverage.ts';
import { mkdtempForTest } from '../../__tests__/test-utils/tmp-dir.ts';
import * as networkTransport from '@agent-device/provision-kit/install-source-network-transport';

test('validateDownloadSourceUrl rejects localhost and private literal addresses by default', async () => {
  await assert.rejects(
    async () => await validateDownloadSourceUrl(new URL('http://127.0.0.1/app.apk')),
    /not allowed|private or loopback/i,
  );
  await assert.rejects(
    async () => await validateDownloadSourceUrl(new URL('http://localhost/app.apk')),
    /not allowed|private or loopback/i,
  );
  await assert.rejects(
    async () => await validateDownloadSourceUrl(new URL('http://10.0.0.8/app.apk')),
    /not allowed|private or loopback/i,
  );
});

test('validateDownloadSourceUrl rejects unsupported protocols', async () => {
  await assert.rejects(
    async () => await validateDownloadSourceUrl(new URL('ftp://example.com/app.apk')),
    /Unsupported source URL protocol/i,
  );
});

test('install-source helpers expose the SSRF and archive surface', () => {
  assert.deepEqual(ARCHIVE_EXTENSIONS, ['.zip', '.tar', '.tar.gz', '.tgz']);
  assert.equal(Object.isFrozen(ARCHIVE_EXTENSIONS), true);
  assert.equal(isBlockedSourceHostname('localhost'), true);
  assert.equal(isBlockedSourceHostname('example.com'), false);
  assert.equal(isBlockedIpAddress('127.0.0.1'), true);
  assert.equal(isBlockedIpAddress('0.0.0.0'), true);
  assert.equal(isBlockedIpAddress('100.64.0.1'), true);
  assert.equal(isBlockedIpAddress('203.0.113.10'), true);
  assert.equal(isBlockedIpAddress('::ffff:127.0.0.1'), true);
  assert.equal(isBlockedIpAddress('93.184.216.34'), false);
});

test('validateDownloadSourceUrl fails closed when DNS returns no public address', async () => {
  const lookupMock = vi
    .spyOn(dns, 'lookup')
    .mockResolvedValue([] as unknown as Awaited<ReturnType<typeof dns.lookup>>);
  try {
    await assert.rejects(
      async () => await validateDownloadSourceUrl(new URL('https://example.com/app.apk')),
      /could not be resolved|public address/i,
    );
  } finally {
    lookupMock.mockRestore();
  }
});

test('isTrustedInstallSourceUrl recognizes supported artifact services', () => {
  assert.equal(
    isTrustedInstallSourceUrl('https://api.github.com/repos/acme/app/actions/artifacts/1/zip'),
    true,
  );
  assert.equal(
    isTrustedInstallSourceUrl('https://github.com/acme/app/actions/runs/123/artifacts/456'),
    true,
  );
  assert.equal(
    isTrustedInstallSourceUrl('https://github.com/acme/app/suites/789/artifacts/456'),
    true,
  );
  assert.equal(
    isTrustedInstallSourceUrl('https://expo.dev/accounts/acme/projects/app/builds/123'),
    true,
  );
  assert.equal(
    isTrustedInstallSourceUrl('https://download.expo.dev/artifacts/eas/build-123/app.apk'),
    true,
  );
  assert.equal(isTrustedInstallSourceUrl('https://example.com/app.zip'), false);
  assert.equal(
    isTrustedInstallSourceUrl('https://github.com/acme/app/archive/refs/heads/main.zip'),
    false,
  );
  assert.equal(isTrustedInstallSourceUrl('https://expo.dev/pricing'), false);
});

test('materializeInstallablePath rejects archive extraction when disabled', async () => {
  const tempRoot = await mkdtempForTest('agent-device-install-source-archive-');
  const archivePath = path.join(tempRoot, 'bundle.zip');
  await fs.writeFile(archivePath, 'placeholder');
  try {
    await assert.rejects(
      async () =>
        await materializeInstallablePath({
          source: { kind: 'path', path: archivePath },
          isInstallablePath: () => false,
          installableLabel: 'Android installable (.apk or .aab)',
          allowArchiveExtraction: false,
        }),
      /archive extraction is not allowed/i,
    );
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test.sequential('materializeInstallablePath extracts zip archives without ditto', async () => {
  const unzipPath = findExecutableInPath('unzip');
  assert.ok(unzipPath, 'unzip must be available for portable zip extraction');

  const tempRoot = await mkdtempForTest('agent-device-install-source-unzip-');
  const archivePath = path.join(tempRoot, 'bundle.zip');
  const binDir = path.join(tempRoot, 'bin');
  const payloadDir = path.join(tempRoot, 'payload');
  const apkPath = path.join(payloadDir, 'Sample.apk');
  const previousPath = process.env.PATH;

  try {
    await fs.mkdir(binDir);
    await fs.symlink(unzipPath, path.join(binDir, 'unzip'));
    await fs.mkdir(payloadDir);
    await fs.writeFile(apkPath, 'placeholder apk', 'utf8');
    runCmdSync('zip', ['-qr', archivePath, 'payload'], { cwd: tempRoot });

    process.env.PATH = binDir;
    const result = await materializeInstallablePath({
      source: { kind: 'path', path: archivePath },
      isInstallablePath: (candidatePath, stat) => stat.isFile() && candidatePath.endsWith('.apk'),
      installableLabel: 'Android installable (.apk or .aab)',
      allowArchiveExtraction: true,
    });

    try {
      assert.equal(path.basename(result.installablePath), 'Sample.apk');
      assert.equal(await fs.readFile(result.installablePath, 'utf8'), 'placeholder apk');
    } finally {
      await result.cleanup();
    }
  } finally {
    process.env.PATH = previousPath;
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('materializeInstallablePath extracts tar.gz archives', async () => {
  const tempRoot = await mkdtempForTest('agent-device-install-source-tar-');
  const archivePath = path.join(tempRoot, 'bundle.tar.gz');
  const payloadDir = path.join(tempRoot, 'payload');
  const apkPath = path.join(payloadDir, 'Sample.apk');

  try {
    await fs.mkdir(payloadDir);
    await fs.writeFile(apkPath, 'placeholder apk', 'utf8');
    runCmdSync('tar', ['-czf', archivePath, '-C', payloadDir, 'Sample.apk']);

    const result = await materializeInstallablePath({
      source: { kind: 'path', path: archivePath },
      isInstallablePath: (candidatePath, stat) => stat.isFile() && candidatePath.endsWith('.apk'),
      installableLabel: 'Android installable (.apk or .aab)',
      allowArchiveExtraction: true,
    });

    try {
      assert.equal(path.basename(result.installablePath), 'Sample.apk');
      assert.equal(await fs.readFile(result.installablePath, 'utf8'), 'placeholder apk');
    } finally {
      await result.cleanup();
    }
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('prepareIosInstallArtifact rejects untrusted URL sources', async () => {
  await assert.rejects(
    async () =>
      await prepareIosInstallArtifact({
        kind: 'url',
        url: 'https://example.com/app.ipa',
      }),
    /only supported for trusted artifact services/i,
  );
});

test(ANDROID_INSTALL_SOURCE_CONTRACT_EVIDENCE.testName, async () => {
  const tempRoot = await mkdtempForTest('agent-device-direct-apk-url-');
  try {
    const manifestPath = path.join(tempRoot, 'AndroidManifest.xml');
    const apkPath = path.join(tempRoot, 'fixture.apk');
    await fs.writeFile(
      manifestPath,
      '<manifest package="io.example.directurl" xmlns:android="http://schemas.android.com/apk/res/android" />',
      'utf8',
    );
    runCmdSync('zip', ['-q', apkPath, 'AndroidManifest.xml'], { cwd: tempRoot });
    const apkBytes = await fs.readFile(apkPath);

    await withMockedInstallSourceFetch(
      apkBytes,
      async () => {
        const result = await prepareAndroidInstallArtifact({
          kind: 'url',
          url: 'https://example.com/app.apk',
        });

        try {
          assert.equal(result.packageName, 'io.example.directurl');
        } finally {
          await result.cleanup();
        }
      },
      { filename: 'app.apk', contentType: 'application/vnd.android.package-archive' },
    );
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('prepareAndroidInstallArtifact rejects private direct APK URL sources', async () => {
  await assert.rejects(
    async () =>
      await prepareAndroidInstallArtifact({
        kind: 'url',
        url: 'http://127.0.0.1/app.apk',
      }),
    /not allowed|private or loopback/i,
  );
});

test('prepareAndroidInstallArtifact accepts direct AAB URL sources', async () => {
  const tempRoot = await mkdtempForTest('agent-device-direct-aab-url-');
  try {
    const manifestDir = path.join(tempRoot, 'base', 'manifest');
    const aabPath = path.join(tempRoot, 'fixture.aab');
    await fs.mkdir(manifestDir, { recursive: true });
    await fs.writeFile(
      path.join(manifestDir, 'AndroidManifest.xml'),
      '<manifest package="io.example.directaab" xmlns:android="http://schemas.android.com/apk/res/android" />',
      'utf8',
    );
    await fs.writeFile(path.join(tempRoot, 'BundleConfig.pb'), 'bundle-config', 'utf8');
    runCmdSync('zip', ['-qr', aabPath, 'BundleConfig.pb', 'base'], { cwd: tempRoot });
    const aabBytes = await fs.readFile(aabPath);

    await withMockedInstallSourceFetch(
      aabBytes,
      async () => {
        const result = await prepareAndroidInstallArtifact({
          kind: 'url',
          url: 'https://example.com/app.aab',
        });

        try {
          assert.equal(result.packageName, 'io.example.directaab');
        } finally {
          await result.cleanup();
        }
      },
      { filename: 'app.aab', contentType: 'application/octet-stream' },
    );
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('prepareAndroidInstallArtifact cleans URL materialization when identity inspection fails', async () => {
  await withIsolatedInstallTempRoot(async (tempRoot) => {
    const manifestSpy = vi
      .spyOn(androidManifest, 'resolveAndroidArchivePackageName')
      .mockRejectedValue(new Error('identity failed'));
    try {
      await withMockedInstallSourceFetch(
        Buffer.from('invalid apk'),
        async () => {
          await assert.rejects(
            async () =>
              await prepareAndroidInstallArtifact({
                kind: 'url',
                url: 'https://example.com/app.apk',
              }),
            /identity failed/,
          );
        },
        { filename: 'app.apk', contentType: 'application/vnd.android.package-archive' },
      );
      assert.deepEqual(await fs.readdir(tempRoot), []);
    } finally {
      manifestSpy.mockRestore();
    }
  });
});

test('prepareAndroidInstallArtifact extracts trusted GitHub artifact ZIP containing one APK', async () => {
  await withArchiveFixture(
    {
      extractions: [
        {
          command: 'unzip',
          populate: async (outputPath) => {
            await fs.writeFile(path.join(outputPath, 'app.apk'), 'apk fixture');
          },
        },
      ],
      zipEntries: {
        'AndroidManifest.xml':
          '<manifest package="io.example.githubapk" xmlns:android="http://schemas.android.com/apk/res/android" />',
      },
    },
    async () => {
      await withMockedInstallSourceFetch(Buffer.from('artifact fixture'), async () => {
        const result = await prepareAndroidInstallArtifact({
          kind: 'url',
          url: 'https://api.github.com/repos/acme/app/actions/artifacts/123/zip',
        });

        try {
          assert.equal(path.basename(result.installablePath), 'app.apk');
          assert.equal(result.packageName, 'io.example.githubapk');
        } finally {
          await result.cleanup();
        }
      });
    },
  );
});

test('prepareAndroidInstallArtifact extracts trusted GitHub artifact ZIP containing one AAB', async () => {
  await withArchiveFixture(
    {
      extractions: [
        {
          command: 'unzip',
          populate: async (outputPath) => {
            await fs.writeFile(path.join(outputPath, 'app.aab'), 'aab fixture');
          },
        },
      ],
      zipEntries: {
        'base/manifest/AndroidManifest.xml':
          '<manifest package="io.example.githubaab" xmlns:android="http://schemas.android.com/apk/res/android" />',
      },
    },
    async () => {
      await withMockedInstallSourceFetch(Buffer.from('artifact fixture'), async () => {
        const result = await prepareAndroidInstallArtifact({
          kind: 'url',
          url: 'https://api.github.com/repos/acme/app/actions/artifacts/456/zip',
        });

        try {
          assert.equal(path.basename(result.installablePath), 'app.aab');
          assert.equal(result.packageName, 'io.example.githubaab');
        } finally {
          await result.cleanup();
        }
      });
    },
  );
});

test('prepareIosInstallArtifact extracts trusted GitHub artifact ZIP containing nested app tar', async () => {
  await withArchiveFixture(
    {
      extractions: [
        {
          command: 'unzip',
          populate: async (outputPath) => {
            await fs.writeFile(path.join(outputPath, 'Demo.app.tar.gz'), 'tar fixture');
          },
        },
        {
          command: 'tar',
          populate: async (outputPath) => {
            await fs.mkdir(path.join(outputPath, 'Demo.app'));
          },
        },
      ],
    },
    async () => {
      await withIosBundleInfo('com.example.githubtar', 'GitHub Tar', async () => {
        await withMockedInstallSourceFetch(Buffer.from('artifact fixture'), async () => {
          const result = await prepareIosInstallArtifact({
            kind: 'url',
            url: 'https://api.github.com/repos/acme/app/actions/artifacts/789/zip',
          });

          try {
            assert.equal(path.basename(result.installablePath), 'Demo.app');
            assert.equal(result.bundleId, 'com.example.githubtar');
            assert.equal(result.appName, 'GitHub Tar');
          } finally {
            await result.cleanup();
          }
        });
      });
    },
  );
});

test('prepareIosInstallArtifact extracts trusted GitHub artifact ZIP containing one IPA', async () => {
  await withArchiveFixture(
    {
      extractions: [
        {
          command: 'unzip',
          populate: async (outputPath) => {
            await fs.writeFile(path.join(outputPath, 'Demo.ipa'), 'ipa fixture');
          },
        },
        {
          command: 'unzip',
          populate: async (outputPath) => {
            await fs.mkdir(path.join(outputPath, 'Payload', 'Demo.app'), { recursive: true });
          },
        },
      ],
    },
    async () => {
      await withIosBundleInfo('com.example.githubipa', 'GitHub IPA', async () => {
        await withMockedInstallSourceFetch(Buffer.from('artifact fixture'), async () => {
          const result = await prepareIosInstallArtifact({
            kind: 'url',
            url: 'https://api.github.com/repos/acme/app/actions/artifacts/987/zip',
          });

          try {
            assert.equal(path.basename(result.installablePath), 'Demo.app');
            assert.equal(result.bundleId, 'com.example.githubipa');
            assert.equal(result.appName, 'GitHub IPA');
          } finally {
            await result.cleanup();
          }
        });
      });
    },
  );
});

test('prepareIosInstallArtifact cleans URL materialization when IPA payload resolution fails', async () => {
  await withArchiveFixture(
    {
      extractions: [
        {
          command: 'unzip',
          populate: async (outputPath) => {
            await fs.writeFile(path.join(outputPath, 'Multi.ipa'), 'ipa fixture');
          },
        },
        {
          command: 'unzip',
          populate: async (outputPath) => {
            await fs.mkdir(path.join(outputPath, 'Payload', 'One.app'), { recursive: true });
            await fs.mkdir(path.join(outputPath, 'Payload', 'Two.app'), { recursive: true });
          },
        },
      ],
    },
    async () => {
      await withMockedInstallSourceFetch(Buffer.from('artifact fixture'), async () => {
        await withIsolatedInstallTempRoot(async (materializeTempRoot) => {
          await assert.rejects(
            async () =>
              await prepareIosInstallArtifact({
                kind: 'url',
                url: 'https://api.github.com/repos/acme/app/actions/artifacts/988/zip',
              }),
            /found 2 .app bundles/,
          );
          assert.deepEqual(await fs.readdir(materializeTempRoot), []);
        });
      });
    },
  );
});

test('prepareAndroidInstallArtifact rejects trusted artifact archives with multiple installables', async () => {
  const tempRoot = await mkdtempForTest('agent-device-github-multiple-');
  const archivePath = path.join(tempRoot, 'artifact.zip');
  await fs.writeFile(path.join(tempRoot, 'one.apk'), 'one', 'utf8');
  await fs.writeFile(path.join(tempRoot, 'two.apk'), 'two', 'utf8');
  runCmdSync('zip', ['-q', archivePath, 'one.apk', 'two.apk'], { cwd: tempRoot });

  await withMockedInstallSourceFetch(await fs.readFile(archivePath), async () => {
    await assert.rejects(
      async () =>
        await prepareAndroidInstallArtifact({
          kind: 'url',
          url: 'https://api.github.com/repos/acme/app/actions/artifacts/654/zip',
        }),
      /multiple Android installable/i,
    );
  });
  await fs.rm(tempRoot, { recursive: true, force: true });
});

test('prepareAndroidInstallArtifact rejects untrusted URL archives instead of extracting them', async () => {
  const tempRoot = await mkdtempForTest('agent-device-untrusted-archive-');
  const archivePath = path.join(tempRoot, 'artifact.zip');
  await fs.writeFile(path.join(tempRoot, 'app.apk'), 'apk', 'utf8');
  runCmdSync('zip', ['-q', archivePath, 'app.apk'], { cwd: tempRoot });
  const archiveBytes = await fs.readFile(archivePath);

  try {
    await withMockedInstallSourceFetch(
      archiveBytes,
      async () => {
        await assert.rejects(
          async () =>
            await prepareAndroidInstallArtifact({
              kind: 'url',
              url: 'https://example.com/artifact.zip',
            }),
          /archive extraction is not allowed/i,
        );
      },
      { filename: 'artifact.zip', contentType: 'application/zip' },
    );
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

function findExecutableInPath(command: string): string | undefined {
  const pathValue = process.env.PATH;
  if (!pathValue) return undefined;
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, command);
    try {
      if (!fsSync.statSync(candidate).isFile()) continue;
      fsSync.accessSync(candidate, fsSync.constants.X_OK);
      return candidate;
    } catch {
      // Keep scanning PATH.
    }
  }
  return undefined;
}

type ArchiveExtractionFixture = {
  command: 'unzip' | 'tar';
  populate: (outputPath: string) => Promise<void>;
};

let generatedArchiveFixture: Buffer | undefined;

async function withArchiveFixture(
  fixture: {
    extractions: ArchiveExtractionFixture[];
    zipEntries?: Record<string, string>;
  },
  run: () => Promise<void>,
): Promise<void> {
  const tempRoot = await mkdtempForTest('agent-device-archive-fixture-');
  const outerArchive = path.join(tempRoot, 'artifact.zip');
  try {
    await buildArchiveFixture(fixture.extractions, 0, outerArchive, tempRoot);
    generatedArchiveFixture = await fs.readFile(outerArchive);
    await withCommandExecutorOverride((command, args) => {
      if (command !== 'unzip' || args[0] !== '-p') return undefined;
      const contents = fixture.zipEntries?.[String(args[2])];
      return Promise.resolve({
        exitCode: contents === undefined ? 1 : 0,
        stdout: '',
        stderr: '',
        stdoutBuffer: contents === undefined ? Buffer.alloc(0) : Buffer.from(contents),
      });
    }, run);
  } finally {
    generatedArchiveFixture = undefined;
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

async function buildArchiveFixture(
  extractions: ArchiveExtractionFixture[],
  index: number,
  archivePath: string,
  tempRoot: string,
): Promise<void> {
  const extraction = extractions[index];
  assert.ok(extraction, `Missing archive fixture at index ${index}`);
  const payload = path.join(tempRoot, `payload-${index}`);
  await fs.mkdir(payload);
  await extraction.populate(payload);
  if (index + 1 < extractions.length) {
    const nested = await findNestedArchive(payload);
    assert.ok(nested, `Archive fixture ${index} did not create its nested archive placeholder`);
    await buildArchiveFixture(extractions, index + 1, nested, tempRoot);
  }
  await fs.rm(archivePath, { force: true });
  if (extraction.command === 'unzip') {
    runCmdSync('zip', ['-qr', archivePath, '.'], { cwd: payload });
  } else {
    const compression =
      archivePath.endsWith('.gz') || archivePath.endsWith('.tgz') ? '-czf' : '-cf';
    runCmdSync('tar', [compression, archivePath, '-C', payload, '.']);
  }
}

async function findNestedArchive(root: string): Promise<string | undefined> {
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = await findNestedArchive(candidate);
      if (nested) return nested;
    } else if (/\.(?:ipa|zip|tar|tar\.gz|tgz)$/i.test(entry.name)) {
      return candidate;
    }
  }
  return undefined;
}

async function withIosBundleInfo(
  bundleId: string,
  appName: string,
  run: () => Promise<void>,
): Promise<void> {
  const provider = createLocalAppleToolProvider({
    plist: {
      readJson: async () => ({
        CFBundleIdentifier: bundleId,
        CFBundleDisplayName: appName,
      }),
    },
  });
  await withAppleToolProvider(provider, run);
}

async function withMockedInstallSourceFetch(
  bytes: Buffer,
  run: () => Promise<void>,
  options?: { filename?: string; contentType?: string },
): Promise<void> {
  const responseBytes = generatedArchiveFixture ?? bytes;
  const lookupMock = vi
    .spyOn(dns, 'lookup')
    .mockImplementation(
      async () =>
        [{ address: '93.184.216.34', family: 4 }] as unknown as Awaited<
          ReturnType<typeof dns.lookup>
        >,
    );
  const requestMock = vi.spyOn(networkTransport, 'requestApprovedUrl').mockResolvedValue({
    statusCode: 200,
    headers: {
      'content-disposition': `attachment; filename="${options?.filename ?? 'artifact.zip'}"`,
      'content-type': options?.contentType ?? 'application/zip',
    },
    body: Readable.from(responseBytes),
    close: async () => {},
  });
  try {
    await run();
  } finally {
    requestMock.mockRestore();
    lookupMock.mockRestore();
  }
}

async function withIsolatedInstallTempRoot(
  run: (tempRoot: string) => Promise<void>,
): Promise<void> {
  const tempRoot = await mkdtempForTest('agent-device-install-source-root-');
  const tmpdirSpy = vi.spyOn(os, 'tmpdir').mockReturnValue(tempRoot);
  try {
    await run(tempRoot);
  } finally {
    tmpdirSpy.mockRestore();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}
