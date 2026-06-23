import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DAEMON_RPC_PROTOCOL_VERSION } from '../../src/daemon/http-health.ts';
import { skipWhenLoopbackUnavailable } from '../../src/__tests__/test-utils/loopback.ts';
import { stopProcessForTakeover } from '../../src/utils/process-identity.ts';
import { runCliJson } from './test-helpers.ts';

type DaemonInfo = {
  token: string;
  pid: number;
  processStartTime?: string;
  transport?: string;
  httpPort?: number;
};

test('daemon HTTP transport starts from CLI and accepts a command RPC', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) {
    return;
  }

  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-http-smoke-'));
  try {
    const cli = runCliJson(
      ['session', 'list', '--json', '--daemon-transport', 'http', '--state-dir', stateDir],
      {
        env: {
          ...process.env,
          AGENT_DEVICE_DAEMON_SERVER_MODE: 'http',
        },
      },
    );

    assert.equal(cli.status, 0, `${cli.stderr}\n${cli.stdout}`);
    assert.equal(cli.json?.success, true, JSON.stringify(cli.json));

    const info = readDaemonInfo(stateDir);
    assert.equal(info.transport, 'http');
    assert.equal(typeof info.httpPort, 'number');
    assert.ok((info.httpPort ?? 0) > 0);

    const health = await fetch(`http://127.0.0.1:${info.httpPort}/health`);
    assert.equal(health.status, 200);
    const healthPayload = (await health.json()) as Record<string, unknown>;
    assert.equal(healthPayload.ok, true);
    assert.equal(healthPayload.service, 'agent-device-daemon');
    assert.equal(typeof healthPayload.version, 'string');
    assert.equal(healthPayload.rpcProtocolVersion, DAEMON_RPC_PROTOCOL_VERSION);

    const rpc = await callCommandRpc(info, 'session_list');
    assert.equal(rpc.status, 200);
    assert.equal(rpc.body.result?.ok, true, JSON.stringify(rpc.body));

    const unauthorized = await callCommandRpc({ ...info, token: 'wrong-token' }, 'session_list');
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.body.error?.data?.code, 'UNAUTHORIZED');
  } finally {
    await stopDaemonForStateDir(stateDir);
  }
});

function readDaemonInfo(stateDir: string): DaemonInfo {
  const infoPath = path.join(stateDir, 'daemon.json');
  return JSON.parse(fs.readFileSync(infoPath, 'utf8')) as DaemonInfo;
}

async function callCommandRpc(
  info: DaemonInfo,
  command: string,
): Promise<{ status: number; body: any }> {
  const response = await fetch(`http://127.0.0.1:${info.httpPort}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: `rpc-${Date.now()}`,
      method: 'agent_device.command',
      params: {
        token: info.token,
        session: 'default',
        command,
        positionals: [],
        flags: {},
      },
    }),
  });
  return {
    status: response.status,
    body: await response.json(),
  };
}

async function stopDaemonForStateDir(stateDir: string): Promise<void> {
  try {
    const infoPath = path.join(stateDir, 'daemon.json');
    if (!fs.existsSync(infoPath)) return;
    const info = readDaemonInfo(stateDir);
    if (!Number.isInteger(info.pid) || info.pid <= 0) return;
    await stopProcessForTakeover(info.pid, {
      termTimeoutMs: 1500,
      killTimeoutMs: 1500,
      expectedStartTime: info.processStartTime,
    });
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}
