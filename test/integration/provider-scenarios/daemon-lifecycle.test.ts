import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { parseIntegerEnv } from '../../../src/daemon/server/server-lifecycle.ts';
import { tryAcquireDaemonRegistration } from '../../../src/daemon-registration-owner.ts';
import { resolveDaemonPaths } from '../../../src/daemon-resolution.ts';
import { mkdtempForTestSync } from '../../../src/__tests__/test-utils/tmp-dir.ts';

test('Provider-backed integration daemon lifecycle writes metadata and protects acquisitions', async () => {
  const root = mkdtempForTestSync('agent-device-daemon-lifecycle-');
  const infoPath = path.join(root, 'daemon.json');
  const logPath = path.join(root, 'daemon.log');
  const paths = resolveDaemonPaths(root);
  const attempt = await tryAcquireDaemonRegistration(paths);
  assert.equal(attempt.status, 'acquired');
  if (attempt.status !== 'acquired') throw new Error('registration refused');
  const { owner } = attempt;

  try {
    owner.publish({
      socketPort: 4210,
      httpPort: 4310,
      token: 'provider-scenario-token',
      version: '0.0.0-provider-scenario',
      codeOrigin: 'checkout',
      codeSignature: 'graph:1:abc',
    });

    assert.equal(fs.existsSync(logPath), true);
    const info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
    assert.equal(info.transport, 'dual');
    assert.equal(info.port, 4210);
    assert.equal(info.httpPort, 4310);
    assert.equal(info.token, 'provider-scenario-token');
    assert.equal(info.stateDir, root);

    owner.publish({
      httpPort: 4311,
      token: 'http-only-token',
      version: '0.0.0-provider-scenario',
      codeOrigin: 'checkout',
      codeSignature: 'graph:1:http',
    });
    const httpOnlyInfo = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
    assert.equal(httpOnlyInfo.transport, 'http');
    assert.equal(httpOnlyInfo.port, undefined);
    assert.equal(httpOnlyInfo.httpPort, 4311);

    owner.publish({
      socketPort: 4211,
      token: 'socket-only-token',
      version: '0.0.0-provider-scenario',
      codeOrigin: 'checkout',
      codeSignature: 'graph:1:socket',
    });
    const socketOnlyInfo = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
    assert.equal(socketOnlyInfo.transport, 'socket');
    assert.equal(socketOnlyInfo.port, 4211);
    assert.equal(socketOnlyInfo.httpPort, undefined);
    assert.equal((await tryAcquireDaemonRegistration(paths)).status, 'busy');

    assert.equal(parseIntegerEnv('10'), 10);
    assert.equal(parseIntegerEnv('1.5'), undefined);
    assert.equal(parseIntegerEnv(undefined), undefined);
  } finally {
    assert.deepEqual(await owner.finish(), { state: 'removed' });
    assert.equal(fs.existsSync(infoPath), false);
    assert.equal(fs.existsSync(paths.lockPath), false);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
