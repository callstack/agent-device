import http from 'node:http';
import path from 'node:path';
import { expect, test } from 'vitest';
import { closeLoopbackServer, listenOnLoopback, mkdtempForTestSync } from '@agent-device/test-kit';
import { DAEMON_HTTP_INSTANCE_MISMATCH_HEADER } from '@agent-device/contracts/daemon-http';
import { sendToDaemon } from '../index.ts';

// A request whose reused lease no heartbeat checked reads `lease-admission` from the `/health` gate
// it already passes, so it costs `/health` and `/rpc` and nothing more. Without the capability it is
// refused before the send, so the caller can fall back to its heartbeat.

const LEASE_ADMISSION = ['script-artifacts', 'lease-admission'];

async function sendAdmissionChecked(
  health: () => Record<string, unknown>,
  onRpc?: (res: http.ServerResponse) => boolean,
) {
  const routes: string[] = [];
  const server = http.createServer((req, res) => {
    routes.push(req.url ?? '');
    res.setHeader('content-type', 'application/json');
    if (req.url === '/health') {
      res.end(JSON.stringify({ ok: true, ...health() }));
      return;
    }
    if (onRpc?.(res)) return;
    res.end(JSON.stringify({ jsonrpc: '2.0', id: 'test', result: { ok: true, data: {} } }));
  });
  const root = mkdtempForTestSync('lease-admission-');
  try {
    const result = await sendToDaemon(
      {
        command: 'snapshot',
        session: 'remote',
        positionals: [],
        flags: {
          daemonBaseUrl: `http://127.0.0.1:${await listenOnLoopback(server)}`,
          stateDir: path.join(root, 'state'),
        },
        meta: { tenantId: 'proxy', runId: 'run', leaseId: 'a'.repeat(32) },
      },
      { authToken: 'test', leaseCheckedByAdmission: true },
    ).catch((error: unknown) => error);
    return { result, routes };
  } finally {
    await closeLoopbackServer(server);
  }
}

test.each([
  { name: 'daemon', health: { instanceId: 'daemon', capabilities: LEASE_ADMISSION } },
  {
    name: 'proxy in front of the daemon',
    health: {
      instanceId: 'proxy',
      upstream: { instanceId: 'daemon', capabilities: LEASE_ADMISSION },
    },
  },
])('a lease-admission $name answers in /health and /rpc', async ({ health }) => {
  const { result, routes } = await sendAdmissionChecked(() => health);

  expect(result).toMatchObject({ ok: true });
  expect(routes).toEqual(['/health', '/rpc']);
});

test.each([
  { name: 'legacy daemon', health: { instanceId: 'daemon', capabilities: ['script-artifacts'] } },
  {
    name: 'upgraded proxy in front of a legacy daemon',
    health: { instanceId: 'proxy', capabilities: LEASE_ADMISSION, upstream: { instanceId: 'd' } },
  },
])('a $name is refused before the send', async ({ health }) => {
  const { result, routes } = await sendAdmissionChecked(() => health);

  expect(result).toMatchObject({
    code: 'UNSUPPORTED_OPERATION',
    details: { reason: 'lease_admission_unsupported', daemonRequestSent: false, dispatched: 'no' },
  });
  expect(routes).toEqual(['/health']);
});

test('a replacement daemon without lease admission is refused before the resend', async () => {
  let replaced = false;
  const { result, routes } = await sendAdmissionChecked(
    () =>
      replaced
        ? { instanceId: 'legacy', capabilities: ['script-artifacts'] }
        : { instanceId: 'capable', capabilities: LEASE_ADMISSION },
    (res) => {
      replaced = true;
      res.statusCode = 409;
      res.setHeader(DAEMON_HTTP_INSTANCE_MISMATCH_HEADER, 'true');
      res.end(
        JSON.stringify({ jsonrpc: '2.0', id: 'test', error: { code: -32000, message: 'x' } }),
      );
      return true;
    },
  );

  expect(result).toMatchObject({
    details: { reason: 'lease_admission_unsupported', daemonRequestSent: false, dispatched: 'no' },
  });
  expect(routes).toEqual(['/health', '/rpc', '/health']);
});
