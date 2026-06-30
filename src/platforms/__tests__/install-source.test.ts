import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import dns from 'node:dns/promises';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ARCHIVE_EXTENSIONS,
  isBlockedIpAddress,
  isBlockedSourceHostname,
  isTrustedInstallSourceUrl,
  materializeInstallablePath,
  validateDownloadSourceUrl,
} from '../install-source.ts';
import * as androidManifest from '../android/manifest.ts';
import { prepareAndroidInstallArtifact } from '../android/install-artifact.ts';
import { prepareIosInstallArtifact } from '../apple/core/install-artifact.ts';

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
  assert.equal(isBlockedIpAddress('203.0.113.10'), false);
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
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-install-source-archive-'));
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

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-install-source-unzip-'));
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
    execFileSync('zip', ['-qr', archivePath, 'payload'], { cwd: tempRoot });

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

test('prepareAndroidInstallArtifact resolves package identity for direct APK URL sources', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-direct-apk-url-'));
  try {
    const manifestPath = path.join(tempRoot, 'AndroidManifest.xml');
    const apkPath = path.join(tempRoot, 'fixture.apk');
    await fs.writeFile(
      manifestPath,
      '<manifest package="io.example.directurl" xmlns:android="http://schemas.android.com/apk/res/android" />',
      'utf8',
    );
    execFileSync('zip', ['-q', apkPath, 'AndroidManifest.xml'], { cwd: tempRoot });
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
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-direct-aab-url-'));
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
    execFileSync('zip', ['-qr', aabPath, 'BundleConfig.pb', 'base'], { cwd: tempRoot });
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
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-github-apk-'));
  const archivePath = path.join(tempRoot, 'artifact.zip');
  const apkPath = path.join(tempRoot, 'app.apk');
  await fs.writeFile(
    path.join(tempRoot, 'AndroidManifest.xml'),
    '<manifest package="io.example.githubapk" xmlns:android="http://schemas.android.com/apk/res/android" />',
    'utf8',
  );
  execFileSync('zip', ['-q', apkPath, 'AndroidManifest.xml'], { cwd: tempRoot });
  execFileSync('zip', ['-q', archivePath, 'app.apk'], { cwd: tempRoot });

  await withMockedInstallSourceFetch(await fs.readFile(archivePath), async () => {
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
  await fs.rm(tempRoot, { recursive: true, force: true });
});

test('prepareAndroidInstallArtifact extracts trusted GitHub artifact ZIP containing one AAB', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-github-aab-'));
  const archivePath = path.join(tempRoot, 'artifact.zip');
  const manifestDir = path.join(tempRoot, 'base', 'manifest');
  const aabPath = path.join(tempRoot, 'app.aab');
  await fs.mkdir(manifestDir, { recursive: true });
  await fs.writeFile(
    path.join(manifestDir, 'AndroidManifest.xml'),
    '<manifest package="io.example.githubaab" xmlns:android="http://schemas.android.com/apk/res/android" />',
    'utf8',
  );
  await fs.writeFile(path.join(tempRoot, 'BundleConfig.pb'), 'bundle-config', 'utf8');
  execFileSync('zip', ['-qr', aabPath, 'BundleConfig.pb', 'base'], { cwd: tempRoot });
  execFileSync('zip', ['-q', archivePath, 'app.aab'], { cwd: tempRoot });

  await withMockedInstallSourceFetch(await fs.readFile(archivePath), async () => {
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
  await fs.rm(tempRoot, { recursive: true, force: true });
});

test('prepareIosInstallArtifact extracts trusted GitHub artifact ZIP containing nested app tar', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-github-app-tar-'));
  const payloadDir = path.join(tempRoot, 'payload');
  const appDir = path.join(payloadDir, 'Demo.app');
  const tarPath = path.join(tempRoot, 'Demo.app.tar.gz');
  const archivePath = path.join(tempRoot, 'artifact.zip');
  await fs.mkdir(appDir, { recursive: true });
  await writeIosInfoPlist(appDir, {
    bundleId: 'com.example.githubtar',
    appName: 'GitHub Tar',
  });
  execFileSync('tar', ['-czf', tarPath, '-C', payloadDir, 'Demo.app']);
  execFileSync('zip', ['-q', archivePath, 'Demo.app.tar.gz'], { cwd: tempRoot });

  await withMockedInstallSourceFetch(await fs.readFile(archivePath), async () => {
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
  await fs.rm(tempRoot, { recursive: true, force: true });
});

test('prepareIosInstallArtifact extracts trusted GitHub artifact ZIP containing one IPA', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-github-ipa-'));
  const payloadAppDir = path.join(tempRoot, 'Payload', 'Demo.app');
  const ipaPath = path.join(tempRoot, 'Demo.ipa');
  const archivePath = path.join(tempRoot, 'artifact.zip');
  await fs.mkdir(payloadAppDir, { recursive: true });
  await writeIosInfoPlist(payloadAppDir, {
    bundleId: 'com.example.githubipa',
    appName: 'GitHub IPA',
  });
  execFileSync('zip', ['-qr', ipaPath, 'Payload'], { cwd: tempRoot });
  execFileSync('zip', ['-q', archivePath, 'Demo.ipa'], { cwd: tempRoot });

  await withMockedInstallSourceFetch(await fs.readFile(archivePath), async () => {
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
  await fs.rm(tempRoot, { recursive: true, force: true });
});

test('prepareIosInstallArtifact cleans URL materialization when IPA payload resolution fails', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-ios-multi-ipa-'));
  const payloadDir = path.join(tempRoot, 'Payload');
  const oneAppDir = path.join(payloadDir, 'One.app');
  const twoAppDir = path.join(payloadDir, 'Two.app');
  const ipaPath = path.join(tempRoot, 'Multi.ipa');
  const archivePath = path.join(tempRoot, 'artifact.zip');
  await fs.mkdir(oneAppDir, { recursive: true });
  await fs.mkdir(twoAppDir, { recursive: true });
  execFileSync('zip', ['-qr', ipaPath, 'Payload'], { cwd: tempRoot });
  execFileSync('zip', ['-q', archivePath, 'Multi.ipa'], { cwd: tempRoot });

  try {
    await withMockedInstallSourceFetch(await fs.readFile(archivePath), async () => {
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
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('prepareAndroidInstallArtifact rejects trusted artifact archives with multiple installables', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-github-multiple-'));
  const archivePath = path.join(tempRoot, 'artifact.zip');
  await fs.writeFile(path.join(tempRoot, 'one.apk'), 'one', 'utf8');
  await fs.writeFile(path.join(tempRoot, 'two.apk'), 'two', 'utf8');
  execFileSync('zip', ['-q', archivePath, 'one.apk', 'two.apk'], { cwd: tempRoot });

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
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-untrusted-archive-'));
  const archivePath = path.join(tempRoot, 'artifact.zip');
  await fs.writeFile(path.join(tempRoot, 'app.apk'), 'apk', 'utf8');
  execFileSync('zip', ['-q', archivePath, 'app.apk'], { cwd: tempRoot });
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

async function withMockedInstallSourceFetch(
  bytes: Buffer,
  run: () => Promise<void>,
  options?: { filename?: string; contentType?: string },
): Promise<void> {
  const lookupMock = vi
    .spyOn(dns, 'lookup')
    .mockImplementation(
      async () =>
        [{ address: '203.0.113.10', family: 4 }] as unknown as Awaited<
          ReturnType<typeof dns.lookup>
        >,
    );
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        'content-disposition': `attachment; filename="${options?.filename ?? 'artifact.zip'}"`,
        'content-type': options?.contentType ?? 'application/zip',
      },
    }),
  );
  try {
    await run();
  } finally {
    fetchMock.mockRestore();
    lookupMock.mockRestore();
  }
}

async function withIsolatedInstallTempRoot(
  run: (tempRoot: string) => Promise<void>,
): Promise<void> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-install-source-root-'));
  const tmpdirSpy = vi.spyOn(os, 'tmpdir').mockReturnValue(tempRoot);
  try {
    await run(tempRoot);
  } finally {
    tmpdirSpy.mockRestore();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

async function writeIosInfoPlist(
  appDir: string,
  params: { bundleId: string; appName: string },
): Promise<void> {
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>${params.bundleId}</string>
  <key>CFBundleDisplayName</key>
  <string>${params.appName}</string>
</dict>
</plist>
`;
  await fs.writeFile(path.join(appDir, 'Info.plist'), plist, 'utf8');
}
