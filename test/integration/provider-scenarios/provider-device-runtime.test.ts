import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import type { DeviceLease } from '@agent-device/contracts/device';
import { assertRpcError, assertRpcOk } from './assertions.ts';
import {
  createProviderScenarioHarness,
  withProviderScenarioResource,
  withProviderScenarioTempDir,
} from './harness.ts';
import {
  FAKE_PROVIDER,
  type FakeProviderCall,
  FakeProviderDeviceRuntime,
  createFakeProviderWorld,
  iosLeaseFlags,
  iosLeaseMeta,
  leaseFlags,
  leaseMeta,
} from './provider-device-runtime.fixtures.ts';
import { runProviderScenario, type ProviderScenarioStep } from './scenario.ts';

const DEVTOOLS_PORT_REVERSE = { devicePort: 8097, hostPort: 8097, portReverseName: 'devtools' };

test('Provider-backed scenario composes lease, inventory, dispatch, and port reverse providers', async () => {
  await withProviderScenarioResource(createFakeProviderWorld, async ({ daemon, runtime }) => {
    await runFakeProviderScenario(daemon, runtime);
  });
}, 15_000);

test('provider-owned iOS simulators relaunch without local CoreSimulator refresh', async () => {
  await withProviderScenarioResource(
    async () => await createFakeProviderWorld('ios'),
    async ({ daemon, runtime }) => {
      const lease = await allocateIosFakeProviderLease(daemon);
      const flags = iosLeaseFlags(lease.leaseId);
      const options = { meta: iosLeaseMeta(lease.leaseId) };

      assertRpcOk(await daemon.callCommand('open', ['com.example.demo'], flags, options));
      assertRpcOk(
        await daemon.callCommand(
          'open',
          ['com.example.demo'],
          { ...flags, relaunch: true },
          options,
        ),
      );

      assert.deepEqual(
        runtime.calls
          .filter((call) => call.type === 'open' || call.type === 'close')
          .map((call) => [call.type, call.deviceId]),
        [
          ['open', runtime.deviceIdForLease(lease.leaseId)],
          ['close', runtime.deviceIdForLease(lease.leaseId)],
          ['open', runtime.deviceIdForLease(lease.leaseId)],
        ],
      );
    },
  );
});

test('provider lease allocation fails when the daemon lacks the requested runtime', async () => {
  const daemon = await createProviderScenarioHarness({
    providerRuntimeIds: [FAKE_PROVIDER],
    providerRuntimeRequiredIds: ['limrun'],
    deviceInventoryProvider: async () => null,
  });
  try {
    const response = await daemon.callCommand(
      'lease_allocate',
      [],
      {
        platform: 'ios',
        tenant: 'team-a',
        runId: 'run-a',
        leaseProvider: 'limrun',
      },
      {
        meta: {
          tenantId: 'team-a',
          runId: 'run-a',
          leaseBackend: 'ios-instance',
          leaseProvider: 'limrun',
        },
      },
    );
    const error = assertRpcError(
      response,
      'UNSUPPORTED_OPERATION',
      /Provider "limrun" is not available in this daemon runtime/,
    );
    assert.match(String(error.hint), /Restart the daemon/);
  } finally {
    await daemon.close();
  }
});

test('proxy lease allocation remains daemon-local when direct runtimes are configured', async () => {
  const daemon = await createProviderScenarioHarness({
    providerRuntimeIds: [FAKE_PROVIDER],
    providerRuntimeRequiredIds: ['limrun'],
    deviceInventoryProvider: async () => null,
  });
  try {
    const response = await daemon.callCommand(
      'lease_allocate',
      [],
      { tenant: 'team-a', runId: 'run-a', leaseProvider: 'proxy' },
      {
        meta: {
          tenantId: 'team-a',
          runId: 'run-a',
          leaseProvider: 'proxy',
        },
      },
    );
    assert.equal(assertRpcOk<{ lease: DeviceLease }>(response).lease.leaseProvider, 'proxy');
  } finally {
    await daemon.close();
  }
});

async function runFakeProviderScenario(
  daemon: Awaited<ReturnType<typeof createProviderScenarioHarness>>,
  runtime: FakeProviderDeviceRuntime,
): Promise<void> {
  await withProviderScenarioTempDir('agent-device-provider-runtime-', async (tempDir) => {
    const appPath = path.join(tempDir, 'demo.apk');
    fs.writeFileSync(appPath, 'fake apk');
    const lease = await allocateFakeProviderLease(daemon);
    await runProviderScenario(daemon, providerScenarioSteps(appPath, lease, runtime), {
      flags: leaseFlags(lease.leaseId),
      meta: leaseMeta(lease.leaseId),
    });
    assertFakeProviderScenarioResult(daemon, runtime, lease, appPath);
  });
}

async function allocateFakeProviderLease(
  daemon: Awaited<ReturnType<typeof createProviderScenarioHarness>>,
): Promise<DeviceLease> {
  const allocate = await daemon.callCommand('lease_allocate', [], leaseFlags(), {
    meta: leaseMeta(),
  });
  return assertRpcOk<{ lease: DeviceLease }>(allocate).lease;
}

async function allocateIosFakeProviderLease(
  daemon: Awaited<ReturnType<typeof createProviderScenarioHarness>>,
): Promise<DeviceLease> {
  const allocate = await daemon.callCommand('lease_allocate', [], iosLeaseFlags(), {
    meta: iosLeaseMeta(),
  });
  return assertRpcOk<{ lease: DeviceLease }>(allocate).lease;
}

function providerScenarioSteps(
  appPath: string,
  lease: DeviceLease,
  runtime: FakeProviderDeviceRuntime,
): ProviderScenarioStep[] {
  const portReverse = expectedPortReverseData(lease.leaseId);
  return [
    {
      name: 'heartbeat',
      command: 'lease_heartbeat',
      expectData: { provider: { provider: FAKE_PROVIDER } },
    },
    {
      name: 'port-reverse',
      command: 'runtime',
      positionals: ['port-reverse'],
      flags: DEVTOOLS_PORT_REVERSE,
      expectData: { action: 'port-reverse', ...portReverse },
    },
    {
      name: 'install',
      command: 'install',
      positionals: [appPath],
      expectData: { platform: 'android', packageName: 'com.example.installed' },
    },
    {
      name: 'open',
      command: 'open',
      positionals: ['com.example.demo'],
      expectData: {
        platform: 'android',
        id: runtime.deviceIdForLease(lease.leaseId),
        serial: runtime.deviceIdForLease(lease.leaseId),
      },
    },
    { name: 'click', command: 'click', positionals: ['10', '20'], expectData: { x: 10, y: 20 } },
    { name: 'snapshot', command: 'snapshot' },
    {
      name: 'diff',
      command: 'diff',
      positionals: ['snapshot'],
      expectData: {
        baselineInitialized: false,
        summary: { additions: 0, removals: 0, unchanged: 1 },
      },
    },
    {
      name: 'release',
      command: 'lease_release',
      expectData: { released: true, provider: { provider: FAKE_PROVIDER } },
    },
  ];
}

function expectedPortReverseData(leaseId: string): Record<string, unknown> {
  return {
    provider: FAKE_PROVIDER,
    leaseId,
    devicePort: DEVTOOLS_PORT_REVERSE.devicePort,
    hostPort: DEVTOOLS_PORT_REVERSE.hostPort,
    name: DEVTOOLS_PORT_REVERSE.portReverseName,
  };
}

function assertFakeProviderScenarioResult(
  daemon: Awaited<ReturnType<typeof createProviderScenarioHarness>>,
  runtime: FakeProviderDeviceRuntime,
  lease: DeviceLease,
  appPath: string,
): void {
  const deviceId = runtime.deviceIdForLease(lease.leaseId);
  const session = daemon.session();
  assert.equal(session?.device.id, deviceId);
  assert.equal(session?.lease?.leaseId, lease.leaseId);
  assert.deepEqual(
    runtime.calls.find((call) => call.type === 'install'),
    {
      type: 'install',
      deviceId,
      app: '',
      appPath,
    },
  );
  assert.deepEqual(
    runtime.calls.find((call) => call.type === 'open'),
    {
      type: 'open',
      deviceId,
      app: 'com.example.demo',
      url: undefined,
    },
  );
  assert.deepEqual(
    runtime.calls.find((call) => call.type === 'tap'),
    {
      type: 'tap',
      deviceId,
      x: 10,
      y: 20,
    },
  );
  assertFakeProviderCallOrder(runtime.calls);
}

function assertFakeProviderCallOrder(calls: FakeProviderCall[]): void {
  assert.deepEqual(
    calls.map((call) => call.type),
    [
      'lease.allocate',
      'lease.heartbeat',
      'inventory',
      'portReverse.ensure',
      'inventory',
      'install',
      'inventory',
      'open',
      'tap',
      'snapshot',
      'snapshot',
      'lease.release',
    ],
  );
}
