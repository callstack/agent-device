import { expect, test, type TestContext } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import { DAEMON_RPC_PROTOCOL_VERSION } from '@agent-device/contracts/daemon-http';
import type { LeaseAllocateOptions } from '@agent-device/contracts/client';
import {
  connectionWorkspace,
  createTestClient,
} from '../../__tests__/remote-connection.fixtures.ts';
import {
  closeLoopbackServer,
  listenOnLoopback,
  skipWhenLoopbackUnavailable,
} from '../../__tests__/test-utils/loopback.ts';
import { LeaseRegistry } from '../../daemon/lease-registry.ts';
import { materializeRemoteConnectionForCommand } from './connection-runtime.ts';

async function serveHealth(t: TestContext, health: Record<string, unknown>): Promise<string> {
  const server = http.createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({ ok: true, rpcProtocolVersion: DAEMON_RPC_PROTOCOL_VERSION, ...health }),
    );
  });
  const port = await listenOnLoopback(server);
  t.onTestFinished(() => closeLoopbackServer(server));
  return `http://127.0.0.1:${port}/agent-device`;
}

function workerFlags(daemonBaseUrl: string) {
  const { stateDir, remoteConfigPath } = connectionWorkspace('agent-device-host-shape-');
  fs.writeFileSync(
    remoteConfigPath,
    JSON.stringify({
      daemonBaseUrl,
      daemonAuthToken: 'host-service-token',
      tenant: 'proxy',
      runId: 'verify-812',
      leaseProvider: 'proxy',
      clientId: 'ab12cd34',
    }),
  );
  return {
    json: true,
    help: false,
    version: false,
    stateDir,
    remoteConfig: remoteConfigPath,
    session: 'verify',
    platform: 'ios' as const,
    device: 'iPhone 16',
  };
}

function recordingClient() {
  const registry = new LeaseRegistry();
  const allocations: LeaseAllocateOptions[] = [];
  let inventoryReads = 0;
  const client = createTestClient({
    listDevices: async () => {
      inventoryReads += 1;
      return [];
    },
    allocate: async (options) => {
      allocations.push(options);
      return registry.allocateLease({
        tenantId: options.tenant,
        runId: options.runId,
        clientId: options.clientId,
        leaseBackend: options.leaseBackend,
        leaseProvider: options.leaseProvider,
        deviceKey: 'ios:mobile:SIM-UDID-1',
      });
    },
  });
  return { client, allocations, inventoryReads: () => inventoryReads };
}

test('on a Host, --device sends the device type without resolving inventory', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const daemonBaseUrl = await serveHealth(t, {
    service: 'agent-device-host',
    instanceId: 'host-1',
    features: ['device-shape'],
    upstream: {
      service: 'agent-device-daemon',
      instanceId: 'daemon-1',
      features: ['device-shape'],
    },
  });
  const worker = recordingClient();

  const materialized = await materializeRemoteConnectionForCommand({
    command: 'open',
    positionals: ['com.example.app'],
    flags: workerFlags(daemonBaseUrl),
    client: worker.client,
  });

  expect(worker.inventoryReads()).toBe(0);
  expect(worker.allocations).toHaveLength(1);
  expect(worker.allocations[0]).toMatchObject({ platform: 'ios', device: 'iPhone 16' });
  expect(worker.allocations[0]?.udid).toBeUndefined();
  expect(materialized.connection).toMatchObject({ deviceKey: 'ios:mobile:SIM-UDID-1' });
  expect(materialized.flags).toMatchObject({ udid: 'SIM-UDID-1' });
  expect(materialized.flags.device).toBeUndefined();
});

const SHAPE_HOST = {
  service: 'agent-device-host',
  instanceId: 'host-2',
  features: ['device-shape'],
  upstream: { service: 'agent-device-daemon', instanceId: 'daemon-2' },
};

test('a Host refuses what it cannot allocate before any lease request', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const shapeHost = await serveHealth(t, SHAPE_HOST);
  const cases: Array<[string, string, Record<string, unknown>]> = [
    ['host-shape-unsupported', await serveHealth(t, { ...SHAPE_HOST, features: [] }), {}],
    ['host-unauthenticated', await serveHealth(t, { service: 'agent-device-host' }), {}],
    ['host-shape-invalid', shapeHost, { udid: 'SIM-X' }],
    ['host-shape-invalid', shapeHost, { device: undefined }],
    ['host-shape-platform-required', shapeHost, { platform: undefined }],
  ];
  for (const [reason, daemonBaseUrl, override] of cases) {
    const worker = recordingClient();
    await expect(
      materializeRemoteConnectionForCommand({
        command: 'open',
        positionals: ['com.example.app'],
        flags: { ...workerFlags(daemonBaseUrl), ...override },
        client: worker.client,
      }),
    ).rejects.toMatchObject({ details: { reason } });
    expect(worker.allocations, reason).toHaveLength(0);
    expect(worker.inventoryReads(), reason).toBe(0);
  }
});

test('a session holding one Host device type refuses another', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const flags = workerFlags(await serveHealth(t, SHAPE_HOST));
  const worker = recordingClient();
  const open = (device: string) =>
    materializeRemoteConnectionForCommand({
      command: 'open',
      positionals: ['com.example.app'],
      flags: { ...flags, device },
      client: worker.client,
    });

  await open('iPhone 16');
  await expect(open('iPad Pro')).rejects.toMatchObject({
    details: { reason: 'host-shape-mismatch' },
  });
});

test('plain proxy keeps resolving --device against remote inventory', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const daemonBaseUrl = await serveHealth(t, {
    service: 'agent-device-proxy',
    instanceId: 'proxy-1',
    upstream: { service: 'agent-device-daemon', instanceId: 'daemon-3' },
  });
  const worker = recordingClient();

  await expect(
    materializeRemoteConnectionForCommand({
      command: 'open',
      positionals: ['com.example.app'],
      flags: workerFlags(daemonBaseUrl),
      client: worker.client,
    }),
  ).rejects.toThrow();
  expect(worker.inventoryReads()).toBe(1);
  expect(worker.allocations).toHaveLength(0);
});
