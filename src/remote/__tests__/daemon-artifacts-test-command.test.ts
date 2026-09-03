/**
 * #2246: a remote daemon's suite artifacts must never be resolved against the caller's `cwd` on
 * the daemon's own filesystem (that's what produced the reported `ENOENT` — `mkdir` on a path
 * that only exists on the caller's machine). This mirrors #1802's read-side fix for the same
 * command: the client resolves the real local artifacts root itself and redirects the daemon to
 * a temp path it owns, exactly as it already does for `screenshot`/`record start`.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'vitest';
import { prepareRemoteRequestArtifacts } from '../daemon-artifacts.ts';

const REMOTE = { baseUrl: 'http://remote-mac.example.test:7777/agent-device', token: 'secret' };
const LOCAL = { token: 'secret' };

function testRequest(artifactsDir: string | undefined, cwd = '/repo') {
  return {
    session: 'default',
    command: 'test',
    positionals: ['./qa-flows/open-grid-settings.ad'],
    flags: artifactsDir === undefined ? {} : { artifactsDir },
    meta: { cwd },
  };
}

test('a remote daemon redirects an explicit --artifacts-dir to a temp path it owns', async () => {
  const prepared = await prepareRemoteRequestArtifacts(
    testRequest('remote-device-artifacts/ad-test'),
    REMOTE,
  );

  const redirected = (prepared.flags as Record<string, unknown> | undefined)?.artifactsDir;
  assert.equal(typeof redirected, 'string');
  assert.ok((redirected as string).startsWith('/tmp/agent-device-test-artifacts-'));
  assert.equal(
    prepared.clientArtifactPaths?.artifactsDir,
    path.resolve('/repo', 'remote-device-artifacts/ad-test'),
  );
});

test('a remote daemon redirects the default artifacts directory too', async () => {
  const prepared = await prepareRemoteRequestArtifacts(testRequest(undefined), REMOTE);

  const redirected = (prepared.flags as Record<string, unknown> | undefined)?.artifactsDir;
  assert.equal(typeof redirected, 'string');
  assert.ok((redirected as string).startsWith('/tmp/agent-device-test-artifacts-'));
  assert.equal(
    prepared.clientArtifactPaths?.artifactsDir,
    path.resolve('/repo', '.agent-device/test-artifacts'),
  );
});

test('a remote daemon leaves an already-absolute --artifacts-dir as the download target', async () => {
  const prepared = await prepareRemoteRequestArtifacts(
    testRequest('/ci/artifacts/ad-test'),
    REMOTE,
  );

  const redirected = (prepared.flags as Record<string, unknown> | undefined)?.artifactsDir;
  assert.notEqual(redirected, '/ci/artifacts/ad-test');
  assert.equal(prepared.clientArtifactPaths?.artifactsDir, '/ci/artifacts/ad-test');
});

test('a local daemon leaves --artifacts-dir untouched', async () => {
  const prepared = await prepareRemoteRequestArtifacts(
    testRequest('remote-device-artifacts/ad-test'),
    LOCAL,
  );

  assert.equal(
    (prepared.flags as Record<string, unknown> | undefined)?.artifactsDir,
    'remote-device-artifacts/ad-test',
  );
  assert.equal(prepared.clientArtifactPaths, undefined);
});
