import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import {
  acquireDaemonLock,
  parseIntegerEnv,
  releaseDaemonLock,
  removeInfoOwnedBy,
  writeInfo,
} from '../../../src/daemon/server/server-lifecycle.ts';

test('Provider-backed integration daemon lifecycle writes metadata and protects process-owned locks', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-daemon-lifecycle-'));
  const infoPath = path.join(root, 'daemon.json');
  const lockPath = path.join(root, 'daemon.lock');
  const logPath = path.join(root, 'daemon.log');

  try {
    writeInfo(root, infoPath, logPath, {
      socketPort: 4210,
      httpPort: 4310,
      token: 'provider-scenario-token',
      version: '0.0.0-provider-scenario',
      codeOrigin: 'checkout',
      codeSignature: 'graph:1:abc',
      processStartTime: 'start-time',
    });

    assert.equal(fs.existsSync(logPath), true);
    const info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
    assert.equal(info.transport, 'dual');
    assert.equal(info.port, 4210);
    assert.equal(info.httpPort, 4310);
    assert.equal(info.token, 'provider-scenario-token');
    assert.equal(info.stateDir, root);

    const httpOnlyInfoPath = path.join(root, 'daemon-http.json');
    writeInfo(root, httpOnlyInfoPath, path.join(root, 'daemon-http.log'), {
      httpPort: 4311,
      token: 'http-only-token',
      version: '0.0.0-provider-scenario',
      codeOrigin: 'checkout',
      codeSignature: 'graph:1:http',
      processStartTime: undefined,
    });
    const httpOnlyInfo = JSON.parse(fs.readFileSync(httpOnlyInfoPath, 'utf8'));
    assert.equal(httpOnlyInfo.transport, 'http');
    assert.equal(httpOnlyInfo.port, undefined);
    assert.equal(httpOnlyInfo.httpPort, 4311);

    const socketOnlyInfoPath = path.join(root, 'daemon-socket.json');
    writeInfo(root, socketOnlyInfoPath, path.join(root, 'daemon-socket.log'), {
      socketPort: 4211,
      token: 'socket-only-token',
      version: '0.0.0-provider-scenario',
      codeOrigin: 'checkout',
      codeSignature: 'graph:1:socket',
      processStartTime: undefined,
    });
    const socketOnlyInfo = JSON.parse(fs.readFileSync(socketOnlyInfoPath, 'utf8'));
    assert.equal(socketOnlyInfo.transport, 'socket');
    assert.equal(socketOnlyInfo.port, 4211);
    assert.equal(socketOnlyInfo.httpPort, undefined);

    assert.equal(
      acquireDaemonLock(root, lockPath, {
        pid: process.pid,
        version: '0.0.0-provider-scenario',
        startedAt: 1,
      }),
      true,
    );
    assert.equal(
      acquireDaemonLock(root, lockPath, {
        pid: process.pid,
        version: '0.0.0-provider-scenario',
        startedAt: 2,
      }),
      true,
    );
    releaseDaemonLock(lockPath);
    assert.equal(fs.existsSync(lockPath), false);

    assert.equal(parseIntegerEnv('10'), 10);
    assert.equal(parseIntegerEnv('1.5'), undefined);
    assert.equal(parseIntegerEnv(undefined), undefined);

    const owner = { pid: process.pid, startTime: 'start-time' };
    fs.writeFileSync(
      infoPath,
      JSON.stringify({ pid: process.pid, processStartTime: 'start-time', token: 't', port: 1 }),
    );
    assert.deepEqual(removeInfoOwnedBy(infoPath, owner), { removed: true });
    assert.equal(fs.existsSync(infoPath), false);

    // A successor's record survives this process's shutdown, which is what #3087 is about.
    const foreignPath = path.join(root, 'daemon-foreign.json');
    fs.writeFileSync(
      foreignPath,
      JSON.stringify({ pid: 999_999_999, processStartTime: 'other', token: 't', port: 1 }),
    );
    assert.deepEqual(removeInfoOwnedBy(foreignPath, owner), {
      removed: false,
      reason: 'replaced',
      registeredPid: 999_999_999,
    });
    assert.equal(fs.existsSync(foreignPath), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
