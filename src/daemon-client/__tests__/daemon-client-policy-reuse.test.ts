import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { computeDaemonCodeSignature } from '@agent-device/host-kit/code-signature';
import { readProcessStartTime } from '@agent-device/host-kit/process';
import { findProjectRoot, readVersion } from '@agent-device/host-kit/version';
import { AppError } from '@agent-device/kernel/errors';
import {
  closeLoopbackServer,
  listenOnLoopback,
  supportsLoopbackBind,
} from '../../__tests__/test-utils/loopback.ts';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';
import { loadDaemonPolicy } from '../../daemon-policy-file.ts';
import { resolveDaemonPaths } from '../../daemon-resolution.ts';
import { sendToDaemon } from '../daemon-client.ts';

// ADR 0029: a caller that names a daemon policy must not reuse a daemon that enforces another one.

afterEach(() => {
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

async function sendSmoke(stateDir: string) {
  return await sendToDaemon({
    session: 'default',
    command: 'policy-reuse-smoke',
    positionals: [],
    flags: { stateDir, daemonTransport: 'http' },
    meta: { requestId: 'req-policy-reuse' },
  });
}

async function startReusableDaemon(options: { policyDigest: 'matching' | undefined }) {
  const stateDir = mkdtempForTestSync('agent-device-policy-reuse-');
  const policyPath = path.join(stateDir, 'policy.json');
  fs.writeFileSync(
    policyPath,
    JSON.stringify({ version: 1, capabilities: { deny: ['device-shutdown'] } }),
  );
  vi.stubEnv('AGENT_DEVICE_DAEMON_POLICY', policyPath);
  const seenPaths: string[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    seenPaths.push(`${req.method ?? 'GET'} ${url.pathname}`);
    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200);
      res.end('ok');
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      const rpc = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id: string };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { ok: true, data: { via: 'http' } } }),
      );
    });
  });
  const httpPort = await listenOnLoopback(server);
  const paths = resolveDaemonPaths(stateDir);
  fs.mkdirSync(paths.baseDir, { recursive: true });
  fs.writeFileSync(
    paths.infoPath,
    `${JSON.stringify({
      httpPort,
      transport: 'http',
      token: 'local-secret',
      pid: process.pid,
      version: readVersion(),
      codeSignature: currentDaemonCodeSignature(),
      processStartTime: readProcessStartTime(process.pid) ?? undefined,
      policyDigest: options.policyDigest === 'matching' ? loadDaemonPolicy()?.digest : undefined,
    })}\n`,
  );
  return {
    stateDir,
    seenPaths,
    close: async () => {
      await closeLoopbackServer(server);
      fs.rmSync(stateDir, { recursive: true, force: true });
    },
  };
}

function currentDaemonCodeSignature(): string {
  const root = findProjectRoot();
  const distPath = path.join(root, 'dist', 'src', 'internal', 'daemon.js');
  const sourcePath = path.join(root, 'src', 'daemon.ts');
  const entryPath =
    process.execArgv.includes('--experimental-strip-types') || !fs.existsSync(distPath)
      ? sourcePath
      : distPath;
  return computeDaemonCodeSignature(entryPath, root);
}
