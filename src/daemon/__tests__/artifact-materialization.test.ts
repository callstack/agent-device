import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { AppError } from '../../kernel/errors.ts';
import { runCmdSync } from '../../utils/exec.ts';
import { cleanupMaterializedArtifact, materializeArtifact } from '../artifact-materialization.ts';

async function startHttpServer(handler: http.RequestListener): Promise<{
  server: http.Server;
  baseUrl: string;
}> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve());
    server.on('error', reject);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Failed to determine test server address');
  }

  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

async function withHttpServer(
  handler: http.RequestListener,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const { server, baseUrl } = await startHttpServer(handler);

  try {
    await run(baseUrl);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function writeIosInfoPlist(appDir: string, params: { bundleId: string; appName: string }): void {
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
  fs.writeFileSync(path.join(appDir, 'Info.plist'), plist, 'utf8');
}

test('materializeArtifact downloads Android artifacts with caller headers into request-scoped temp storage', async () => {
  let seenAuthorization = '';
  let result: Awaited<ReturnType<typeof materializeArtifact>> | undefined;

  await withHttpServer(
    (req, res) => {
      seenAuthorization = String(req.headers.authorization ?? '');
      res.statusCode = 200;
      res.setHeader('content-disposition', 'attachment; filename="Demo.apk"');
      res.end('apk-binary');
    },
    async (baseUrl) => {
      result = await materializeArtifact({
        platform: 'android',
        url: `${baseUrl}/download`,
        headers: { authorization: 'Bearer ephemeral-token' },
        requestId: 'req/123',
      });
    },
  );

  assert.equal(seenAuthorization, 'Bearer ephemeral-token');
  assert.ok(result);
  assert.equal(result.installablePath, result.archivePath);
  assert.match(result.archivePath, /agent-device-artifact-req-123-/);
  assert.equal(path.basename(result.archivePath), 'Demo.apk');
  assert.equal(result.detected.appName, 'Demo');
  assert.equal(fs.readFileSync(result.archivePath, 'utf8'), 'apk-binary');

  cleanupMaterializedArtifact(result);
  assert.equal(fs.existsSync(path.dirname(result.archivePath)), false);
});

test('materializeArtifact extracts iOS app bundle tar archives and returns the installable .app path', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-materialize-ios-'));
  const appDir = path.join(tempRoot, 'Demo.app');
  const archivePath = path.join(tempRoot, 'Demo.tar');
  let result: Awaited<ReturnType<typeof materializeArtifact>> | undefined;

  try {
    fs.mkdirSync(appDir, { recursive: true });
    writeIosInfoPlist(appDir, { bundleId: 'com.example.demo', appName: 'Demo App' });
    fs.writeFileSync(path.join(appDir, 'payload.txt'), 'demo', 'utf8');
    runCmdSync('tar', ['cf', archivePath, '-C', tempRoot, 'Demo.app']);

    await withHttpServer(
      (_req, res) => {
        res.statusCode = 200;
        res.setHeader('content-disposition', 'attachment; filename="Demo.tar"');
        res.end(fs.readFileSync(archivePath));
      },
      async (baseUrl) => {
        result = await materializeArtifact({
          platform: 'ios',
          url: `${baseUrl}/artifact`,
          requestId: 'ios-materialize',
        });
      },
    );

    assert.ok(result);
    assert.equal(path.basename(result.archivePath), 'Demo.tar');
    assert.equal(path.basename(result.installablePath), 'Demo.app');
    assert.equal(fs.readFileSync(path.join(result.installablePath, 'payload.txt'), 'utf8'), 'demo');
    assert.equal(result.detected.appName, 'Demo App');
    assert.equal(result.detected.bundleId, 'com.example.demo');

    cleanupMaterializedArtifact(result);
    assert.equal(fs.existsSync(path.dirname(result.archivePath)), false);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('materializeArtifact rejects iOS tar archives containing symlinks', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-materialize-bad-ios-'));
  const appDir = path.join(tempRoot, 'Bad.app');
  const archivePath = path.join(tempRoot, 'Bad.tar');

  try {
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(path.join(tempRoot, 'payload.txt'), 'payload', 'utf8');
    fs.symlinkSync('../payload.txt', path.join(appDir, 'linked.txt'));
    runCmdSync('tar', ['cf', archivePath, '-C', tempRoot, 'Bad.app']);

    await withHttpServer(
      (_req, res) => {
        res.statusCode = 200;
        res.setHeader('content-disposition', 'attachment; filename="Bad.tar"');
        res.end(fs.readFileSync(archivePath));
      },
      async (baseUrl) => {
        await assert.rejects(
          () =>
            materializeArtifact({
              platform: 'ios',
              url: `${baseUrl}/artifact`,
              requestId: 'bad-ios-materialize',
            }),
          /cannot contain symlinks or hard links/i,
        );
      },
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('materializeArtifact rejects cross-origin redirects when custom headers are provided', async () => {
  const target = await startHttpServer((_targetReq, targetRes) => {
    targetRes.statusCode = 200;
    targetRes.end('apk-binary');
  });
  const redirect = await startHttpServer((_req, redirectRes) => {
    redirectRes.statusCode = 302;
    redirectRes.setHeader('location', `${target.baseUrl}/download`);
    redirectRes.end();
  });

  try {
    await assert.rejects(
      () =>
        materializeArtifact({
          platform: 'android',
          url: `${redirect.baseUrl}/redirect`,
          headers: { authorization: 'Bearer ephemeral-token' },
          requestId: 'cross-origin-redirect',
        }),
      /redirect changed origin while custom headers were provided/i,
    );
  } finally {
    await new Promise<void>((resolve) => redirect.server.close(() => resolve()));
    await new Promise<void>((resolve) => target.server.close(() => resolve()));
  }
});

test('materializeArtifact infers APK type for opaque Android downloads', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-materialize-android-apk-'));
  const manifestPath = path.join(tempRoot, 'AndroidManifest.xml');
  const zipPath = path.join(tempRoot, 'opaque.zip');
  let result: Awaited<ReturnType<typeof materializeArtifact>> | undefined;

  try {
    fs.writeFileSync(manifestPath, '<manifest package="com.example.demo"/>', 'utf8');
    runCmdSync('zip', ['-q', zipPath, 'AndroidManifest.xml'], { cwd: tempRoot });

    await withHttpServer(
      (_req, res) => {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/octet-stream');
        res.end(fs.readFileSync(zipPath));
      },
      async (baseUrl) => {
        result = await materializeArtifact({
          platform: 'android',
          url: `${baseUrl}/artifact`,
          requestId: 'android-opaque-apk',
        });
      },
    );

    assert.ok(result);
    assert.equal(path.extname(result.archivePath), '.apk');
    assert.equal(result.installablePath, result.archivePath);
  } finally {
    if (result) cleanupMaterializedArtifact(result);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('materializeArtifact infers AAB type for opaque Android downloads', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-materialize-android-aab-'));
  const bundleConfigPath = path.join(tempRoot, 'BundleConfig.pb');
  const baseDir = path.join(tempRoot, 'base', 'manifest');
  const zipPath = path.join(tempRoot, 'opaque-aab.zip');
  let result: Awaited<ReturnType<typeof materializeArtifact>> | undefined;

  try {
    fs.mkdirSync(baseDir, { recursive: true });
    fs.writeFileSync(bundleConfigPath, 'bundle-config', 'utf8');
    fs.writeFileSync(path.join(baseDir, 'AndroidManifest.xml'), '<manifest/>', 'utf8');
    runCmdSync('zip', ['-qr', zipPath, 'BundleConfig.pb', 'base'], { cwd: tempRoot });

    await withHttpServer(
      (_req, res) => {
        res.statusCode = 200;
        res.end(fs.readFileSync(zipPath));
      },
      async (baseUrl) => {
        result = await materializeArtifact({
          platform: 'android',
          url: `${baseUrl}/artifact`,
          requestId: 'android-opaque-aab',
        });
      },
    );

    assert.ok(result);
    assert.equal(path.extname(result.archivePath), '.aab');
    assert.equal(result.installablePath, result.archivePath);
  } finally {
    if (result) cleanupMaterializedArtifact(result);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('materializeArtifact truncates large HTTP error bodies', async () => {
  const hugeBody = 'x'.repeat(10_000);

  await withHttpServer(
    (_req, res) => {
      res.statusCode = 502;
      res.end(hugeBody);
    },
    async (baseUrl) => {
      await assert.rejects(
        () =>
          materializeArtifact({
            platform: 'android',
            url: `${baseUrl}/artifact`,
            requestId: 'huge-error-body',
          }),
        (error) => {
          assert.ok(error instanceof AppError);
          assert.equal(error.message, 'Failed to download artifact');
          assert.equal(error.details?.statusCode, 502);
          const body = error.details?.body;
          assert.equal(typeof body, 'string');
          assert.ok(typeof body === 'string');
          assert.ok(body.endsWith('...<truncated>'));
          assert.ok(body.length <= 4096 + '...<truncated>'.length);
          return true;
        },
      );
    },
  );
});
