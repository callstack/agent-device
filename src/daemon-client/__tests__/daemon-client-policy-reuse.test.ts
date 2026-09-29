import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';

vi.mock('@agent-device/host-kit/command', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/host-kit/command')>()),
  runCmdDetachedMonitored: vi.fn(),
}));

import { runCmdDetachedMonitored } from '@agent-device/host-kit/command';
import { readProcessStartTime } from '@agent-device/host-kit/process';
import { readVersion } from '@agent-device/host-kit/version';
import { AppError } from '@agent-device/kernel/errors';
import {
  currentDaemonCodeSignature,
  startHttpDaemonFixture,
} from '../../__tests__/test-utils/daemon-http-fixture.ts';
import { closeLoopbackServer, supportsLoopbackBind } from '../../__tests__/test-utils/loopback.ts';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';
import { loadDaemonPolicy } from '../../daemon-policy-file.ts';
import { resolveDaemonPaths } from '../../daemon-resolution.ts';
import { sendToDaemon } from '../daemon-client.ts';

// ADR 0029: a caller that names a daemon policy must not use a daemon that enforces another one.

const mockSpawnDaemon = vi.mocked(runCmdDetachedMonitored);

afterEach(() => {
  mockSpawnDaemon.mockReset();
  vi.unstubAllEnvs();
});

test('a caller naming a policy refuses a running daemon without that policy', async (t) => {
  if (!(await supportsLoopbackBind())) {
    t.skip('loopback listeners are not permitted in this environment');
    return;
  }
  const fixture = await startReusableDaemon({ policyDigest: undefined });
  try {
    await assert.rejects(
      () => sendSmoke(fixture.stateDir),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.details?.reason, 'DAEMON_POLICY_MISMATCH');
        assert.match(String(error.details?.hint), /agent-device daemon stop --state-dir /);
        return true;
      },
    );
    assert.deepEqual(fixture.seenPaths, ['GET /health'], 'no command reaches the daemon');
  } finally {
    await fixture.close();
  }
});

test('a caller naming a policy refuses a running daemon that enforces a different policy', async (t) => {
  if (!(await supportsLoopbackBind())) {
    t.skip('loopback listeners are not permitted in this environment');
    return;
  }
  const otherDigest = 'a'.repeat(64);
  const fixture = await startReusableDaemon({ policyDigest: otherDigest });
  try {
    await assert.rejects(
      () => sendSmoke(fixture.stateDir),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.details?.reason, 'DAEMON_POLICY_MISMATCH');
        assert.equal(error.details?.daemonPolicyDigest, otherDigest);
        assert.equal(error.details?.expectedPolicyDigest, loadDaemonPolicy()?.digest);
        return true;
      },
    );
    assert.deepEqual(fixture.seenPaths, ['GET /health'], 'no command reaches the daemon');
  } finally {
    await fixture.close();
  }
});

test('a caller naming a policy reuses a daemon that enforces the same policy', async (t) => {
  if (!(await supportsLoopbackBind())) {
    t.skip('loopback listeners are not permitted in this environment');
    return;
  }
  const fixture = await startReusableDaemon({ policyDigest: 'matching' });
  try {
    assert.deepEqual(await sendSmoke(fixture.stateDir), { ok: true, data: { via: 'http' } });
    assert.deepEqual(fixture.seenPaths, ['GET /health', 'POST /rpc']);
  } finally {
    await fixture.close();
  }
});

test('a caller naming a policy refuses a daemon another caller started without it', async (t) => {
  if (!(await supportsLoopbackBind())) {
    t.skip('loopback listeners are not permitted in this environment');
    return;
  }
  // No daemon runs yet. While this caller starts one, another caller's daemon without the policy
  // wins the state dir: its metadata is what startup finds.
  const fixture = await startReusableDaemon({ policyDigest: undefined, publish: 'on-spawn' });
  try {
    await assert.rejects(
      () => sendSmoke(fixture.stateDir),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.details?.reason, 'DAEMON_POLICY_MISMATCH');
        return true;
      },
    );
    assert.equal(mockSpawnDaemon.mock.calls.length, 1, 'this caller did start a daemon');
    assert.ok(!fixture.seenPaths.includes('POST /rpc'), 'no command reaches the daemon');
  } finally {
    await fixture.close();
  }
});

async function sendSmoke(stateDir: string) {
  return await sendToDaemon({
    session: 'default',
    command: 'policy-reuse-smoke',
    positionals: [],
    flags: { stateDir, daemonTransport: 'http' },
    meta: { requestId: 'req-policy-reuse' },
  });
}

async function startReusableDaemon(options: {
  policyDigest: string | undefined;
  publish?: 'now' | 'on-spawn';
}) {
  const stateDir = mkdtempForTestSync('agent-device-policy-reuse-');
  const policyPath = path.join(stateDir, 'policy.json');
  fs.writeFileSync(
    policyPath,
    JSON.stringify({ version: 1, capabilities: { deny: ['device-shutdown'] } }),
  );
  vi.stubEnv('AGENT_DEVICE_DAEMON_POLICY', policyPath);
  const daemon = await startHttpDaemonFixture({ via: 'http' });
  const paths = resolveDaemonPaths(stateDir);
  fs.mkdirSync(paths.baseDir, { recursive: true });
  const publishInfo = () =>
    fs.writeFileSync(
      paths.infoPath,
      `${JSON.stringify({
        httpPort: daemon.port,
        transport: 'http',
        token: 'local-secret',
        pid: process.pid,
        version: readVersion(),
        codeSignature: currentDaemonCodeSignature(),
        processStartTime: readProcessStartTime(process.pid) ?? undefined,
        policyDigest:
          options.policyDigest === 'matching' ? loadDaemonPolicy()?.digest : options.policyDigest,
      })}\n`,
    );
  if (options.publish === 'on-spawn') {
    mockSpawnDaemon.mockImplementation(() => {
      publishInfo();
      return { pid: process.pid, exited: new Promise(() => {}) };
    });
  } else {
    publishInfo();
  }
  return {
    stateDir,
    seenPaths: daemon.seenPaths,
    close: async () => {
      await closeLoopbackServer(daemon.server);
      fs.rmSync(stateDir, { recursive: true, force: true });
    },
  };
}
