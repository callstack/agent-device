/**
 * #2246: the download half of the fix. The daemon's artifact transport already tar's a
 * directory artifact on the fly (`artifact-tracking.ts`'s `ensureDirectoryArchive`) — this test
 * is the first to exercise that path all the way through `downloadRemoteArtifact` on the client,
 * which used to only ever write a response body straight to one file (screenshot/recording).
 * `test`'s suite artifacts are a whole directory tree, so the client must detect the
 * `application/gzip` directory-archive response and extract it instead.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import {
  cleanupDownloadableArtifact,
  trackDownloadableArtifact,
} from '../../../src/daemon/artifact-tracking.ts';
import { createDaemonHttpServer } from '../../../src/daemon/server/http-server.ts';
import { downloadRemoteArtifact } from '../../../src/remote/daemon-artifacts.ts';
import {
  closeLoopbackServer,
  listenOnLoopback,
  skipWhenLoopbackUnavailable,
} from '../../../src/__tests__/test-utils/loopback.ts';

const SUITE_INVOCATION_ID = 'cd5f9c01feec8d70';

test('downloadRemoteArtifact extracts a directory artifact into the caller-local artifacts root', async (t) => {
  if (await skipWhenLoopbackUnavailable(t, 'remote test-artifacts directory download coverage'))
    return;

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-remote-test-artifacts-'));
  // Mirrors what the daemon actually produces: `<remote temp root>/<suiteInvocationId>/...`.
  const daemonSuiteDir = path.join(tempDir, 'daemon-side', SUITE_INVOCATION_ID);
  const attemptDir = path.join(daemonSuiteDir, 'qa-flows__open-grid-settings.ad', 'attempt-1');
  fs.mkdirSync(attemptDir, { recursive: true });
  fs.writeFileSync(path.join(attemptDir, 'replay.ad'), 'context platform=ios\nopen "Demo"\n');
  fs.writeFileSync(path.join(attemptDir, 'result.txt'), 'status: passed\n');

  // The caller-local artifacts root the client resolved before the request was sent
  // (`resolveClientArtifactOutputRoot` in `daemon-artifacts.ts`) — a plain directory that, in
  // the real CLI, may already hold earlier suite runs.
  const callerArtifactsRoot = path.join(
    tempDir,
    'caller-side',
    'remote-device-artifacts',
    'ad-test',
  );
  fs.mkdirSync(callerArtifactsRoot, { recursive: true });
  fs.writeFileSync(path.join(callerArtifactsRoot, 'previous-run-marker.txt'), 'keep me');

  const artifactId = trackDownloadableArtifact({
    artifactPath: daemonSuiteDir,
    artifactType: 'test-artifacts',
    fileName: SUITE_INVOCATION_ID,
  });
  const server = await createDaemonHttpServer({
    token: 'daemon-token',
    handleRequest: async () => {
      throw new Error('not exercised: this test only hits the /artifacts route');
    },
  });

  try {
    const port = await listenOnLoopback(server);
    await downloadRemoteArtifact({
      baseUrl: `http://127.0.0.1:${port}`,
      token: 'daemon-token',
      artifactId,
      destinationPath: callerArtifactsRoot,
      requestScope: {},
      isDirectory: true,
    });

    const downloadedResult = path.join(
      callerArtifactsRoot,
      SUITE_INVOCATION_ID,
      'qa-flows__open-grid-settings.ad',
      'attempt-1',
      'result.txt',
    );
    assert.equal(fs.readFileSync(downloadedResult, 'utf8'), 'status: passed\n');
    assert.equal(
      fs.readFileSync(
        path.join(
          callerArtifactsRoot,
          SUITE_INVOCATION_ID,
          'qa-flows__open-grid-settings.ad',
          'attempt-1',
          'replay.ad',
        ),
        'utf8',
      ),
      'context platform=ios\nopen "Demo"\n',
    );
    // Earlier runs already in the caller's artifacts root must survive untouched.
    assert.equal(
      fs.readFileSync(path.join(callerArtifactsRoot, 'previous-run-marker.txt'), 'utf8'),
      'keep me',
    );
  } finally {
    cleanupDownloadableArtifact(artifactId);
    await closeLoopbackServer(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('a failed directory download leaves the caller-local artifacts root untouched', async (t) => {
  if (await skipWhenLoopbackUnavailable(t, 'remote test-artifacts directory download coverage'))
    return;

  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'agent-device-remote-test-artifacts-fail-'),
  );
  const callerArtifactsRoot = path.join(tempDir, 'remote-device-artifacts', 'ad-test');
  fs.mkdirSync(callerArtifactsRoot, { recursive: true });
  fs.writeFileSync(path.join(callerArtifactsRoot, 'previous-run-marker.txt'), 'keep me');

  const server = await createDaemonHttpServer({
    token: 'daemon-token',
    handleRequest: async () => {
      throw new Error('not exercised: this test only hits the /artifacts route');
    },
  });

  try {
    const port = await listenOnLoopback(server);
    // An id nothing tracked: the server answers 404, exercising the error path before any
    // directory-archive bytes ever arrive.
    await assert.rejects(
      async () =>
        await downloadRemoteArtifact({
          baseUrl: `http://127.0.0.1:${port}`,
          token: 'daemon-token',
          artifactId: 'does-not-exist',
          destinationPath: callerArtifactsRoot,
          requestScope: {},
          isDirectory: true,
        }),
    );

    // The pre-existing directory — and everything already in it — must survive: it is the
    // caller's own `--artifacts-dir` root, not a file this download owns.
    assert.equal(fs.existsSync(callerArtifactsRoot), true);
    assert.equal(
      fs.readFileSync(path.join(callerArtifactsRoot, 'previous-run-marker.txt'), 'utf8'),
      'keep me',
    );
  } finally {
    await closeLoopbackServer(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('a directory artifact containing a symlink is rejected, not extracted', async (t) => {
  if (await skipWhenLoopbackUnavailable(t, 'remote test-artifacts directory download coverage'))
    return;

  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'agent-device-remote-test-artifacts-evil-'),
  );
  // A remote (possibly compromised) daemon returning an archive with a symlink entry — the
  // real-world shape `extractArchiveSafely` guards against, since raw `tar xzf` would otherwise
  // follow it wherever it points on extraction.
  const daemonSuiteDir = path.join(tempDir, 'daemon-side', SUITE_INVOCATION_ID);
  fs.mkdirSync(daemonSuiteDir, { recursive: true });
  const escapeTarget = path.join(tempDir, 'outside-destination.txt');
  fs.writeFileSync(escapeTarget, 'should never be linked to');
  fs.symlinkSync(escapeTarget, path.join(daemonSuiteDir, 'evil-link'));

  const callerArtifactsRoot = path.join(
    tempDir,
    'caller-side',
    'remote-device-artifacts',
    'ad-test',
  );
  fs.mkdirSync(callerArtifactsRoot, { recursive: true });

  const artifactId = trackDownloadableArtifact({
    artifactPath: daemonSuiteDir,
    artifactType: 'test-artifacts',
    fileName: SUITE_INVOCATION_ID,
  });
  const server = await createDaemonHttpServer({
    token: 'daemon-token',
    handleRequest: async () => {
      throw new Error('not exercised: this test only hits the /artifacts route');
    },
  });

  try {
    const port = await listenOnLoopback(server);
    await assert.rejects(
      async () =>
        await downloadRemoteArtifact({
          baseUrl: `http://127.0.0.1:${port}`,
          token: 'daemon-token',
          artifactId,
          destinationPath: callerArtifactsRoot,
          requestScope: {},
          isDirectory: true,
        }),
      (error: unknown) =>
        error instanceof AppError && error.details?.reason === 'ARCHIVE_UNSAFE_ENTRY',
    );

    assert.equal(fs.existsSync(path.join(callerArtifactsRoot, SUITE_INVOCATION_ID)), false);
  } finally {
    cleanupDownloadableArtifact(artifactId);
    await closeLoopbackServer(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
