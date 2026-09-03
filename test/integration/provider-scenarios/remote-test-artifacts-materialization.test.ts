import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import type { ReplaySuiteResult } from '@agent-device/contracts/replay';
import {
  cleanupDownloadableArtifact,
  trackDownloadableArtifact,
} from '../../../src/daemon/artifact-tracking.ts';
import type { DaemonRequest } from '../../../src/daemon/types.ts';
import { createDaemonHttpServer } from '../../../src/daemon/server/http-server.ts';
import { attachRemoteReplayTestArtifacts } from '../../../src/daemon/replay/internal/test-command.ts';
import {
  downloadRemoteArtifact,
  materializeRemoteArtifacts,
} from '../../../src/remote/daemon-artifacts.ts';
import {
  closeLoopbackServer,
  listenOnLoopback,
  skipWhenLoopbackUnavailable,
} from '../../../src/__tests__/test-utils/loopback.ts';

const SUITE_INVOCATION_ID = 'cd5f9c01feec8d70';

test('the composed daemon and client path owners report the directory that was materialized', async (t) => {
  if (await skipWhenLoopbackUnavailable(t, 'remote test-artifacts materialization coverage'))
    return;

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-remote-suite-response-'));
  const daemonSuiteDir = path.join(tempDir, 'daemon-side', SUITE_INVOCATION_ID);
  const daemonAttemptDir = path.join(daemonSuiteDir, 'flow.ad', 'attempt-1');
  const clientRoot = path.join(tempDir, 'caller-side', 'artifacts');
  const clientSuiteDir = path.join(clientRoot, SUITE_INVOCATION_ID);
  fs.mkdirSync(daemonAttemptDir, { recursive: true });
  fs.writeFileSync(path.join(daemonAttemptDir, 'replay.ad'), 'open "Demo"\n');
  fs.writeFileSync(path.join(daemonAttemptDir, 'result.txt'), 'status: passed\n');

  const request: DaemonRequest = {
    token: 'daemon-token',
    session: 'default',
    command: 'test',
    positionals: [],
    meta: { clientArtifactPaths: { artifactsDir: clientRoot } },
  };
  const suite: ReplaySuiteResult = {
    total: 1,
    executed: 1,
    passed: 1,
    failed: 0,
    skipped: 0,
    notRun: 0,
    durationMs: 1,
    failures: [],
    artifactsDir: daemonSuiteDir,
    tests: [
      {
        file: 'flow.ad',
        session: 'default:test:1',
        status: 'passed',
        durationMs: 1,
        attempts: 1,
        artifactsDir: daemonAttemptDir,
        replayed: 1,
        healed: 0,
      },
    ],
  };
  const response = {
    ok: true as const,
    data: attachRemoteReplayTestArtifacts(suite, request),
  };
  const artifact = response.data.artifacts?.[0];
  assert.ok(artifact?.path);
  const artifactId = trackDownloadableArtifact({
    artifactPath: artifact.path,
    artifactType: artifact.artifactType,
    fileName: artifact.fileName,
  });
  response.data.artifacts = [{ ...artifact, artifactId }];

  const server = await createDaemonHttpServer({
    token: 'daemon-token',
    handleRequest: async () => {
      throw new Error('not exercised: this test only hits the /artifacts route');
    },
  });

  try {
    const port = await listenOnLoopback(server);
    const materialized = await materializeRemoteArtifacts(
      { baseUrl: `http://127.0.0.1:${port}`, token: 'daemon-token' },
      request,
      response,
    );

    assert.equal(materialized.ok, true);
    if (!materialized.ok) return;
    assert.equal(materialized.data?.artifactsDir, clientSuiteDir);
    assert.equal(materialized.data?.artifacts?.[0]?.localPath, clientSuiteDir);
    assert.equal(
      fs.readFileSync(path.join(clientSuiteDir, 'flow.ad', 'attempt-1', 'replay.ad'), 'utf8'),
      'open "Demo"\n',
    );
    assert.equal(
      fs.readFileSync(path.join(clientSuiteDir, 'flow.ad', 'attempt-1', 'result.txt'), 'utf8'),
      'status: passed\n',
    );
  } finally {
    cleanupDownloadableArtifact(artifactId);
    await closeLoopbackServer(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('directory downloads stage beside the destination and finish timeout cleanup before rejecting', async (t) => {
  if (await skipWhenLoopbackUnavailable(t, 'remote test-artifacts atomic staging coverage')) return;

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-remote-suite-timeout-'));
  const clientRoot = path.join(tempDir, 'caller-side', 'artifacts');
  const server = http.createServer((_req, res) => {
    res.statusCode = 200;
    res.write('partial archive');
  });

  try {
    const port = await listenOnLoopback(server);
    const download = downloadRemoteArtifact({
      baseUrl: `http://127.0.0.1:${port}`,
      token: 'daemon-token',
      artifactId: 'stalled-directory',
      destinationPath: clientRoot,
      requestScope: {},
      isDirectory: true,
      timeoutMs: 80,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const stagingWhileActive = fs.existsSync(clientRoot)
      ? fs.readdirSync(clientRoot).filter((entry) => entry.startsWith('.agent-device-download-'))
      : [];
    await assert.rejects(download, /timed out/);
    assert.equal(stagingWhileActive.length, 1);
    assert.deepEqual(
      fs.existsSync(clientRoot)
        ? fs.readdirSync(clientRoot).filter((entry) => entry.startsWith('.agent-device-download-'))
        : [],
      [],
    );
  } finally {
    await closeLoopbackServer(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
