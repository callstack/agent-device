import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import {
  createProviderDeviceRuntimeRequestProviders,
  type ProviderDeviceRuntime,
  type ProviderPortReverseOptions,
} from '../../../src/provider-device-runtime.ts';
import type { DeviceInventoryProvider } from '../../../src/core/dispatch-resolve.ts';
import type { Interactor, SnapshotResult } from '../../../src/core/interactor-types.ts';
import type { LeaseLifecycleProvider } from '../../../src/daemon/handlers/lease.ts';
import type { DeviceLease } from '../../../src/daemon/lease-registry.ts';
import type { DaemonRequest } from '../../../src/daemon/types.ts';
import type { DeviceInfo } from '../../../src/kernel/device.ts';
import { assertRpcError, assertRpcOk } from './assertions.ts';
import {
  createProviderScenarioHarness,
  withProviderScenarioResource,
  withProviderScenarioTempDir,
} from './harness.ts';
import { runProviderScenario, type ProviderScenarioStep } from './scenario.ts';

const FAKE_PROVIDER = 'fake-provider';
const DEVTOOLS_PORT_REVERSE = { devicePort: 8097, hostPort: 8097, portReverseName: 'devtools' };
const ABSENT_FAKE_PROVIDER_INTERACTOR_PROPERTIES = new Set([
  'then',
  'tapElementSelector',
  'fillElementSelector',
  'setViewport',
]);

type FakeProviderCall = {
  type:
    | 'lease.allocate'
    | 'lease.heartbeat'
    | 'lease.release'
    | 'inventory'
    | 'install'
    | 'open'
    | 'close'
    | 'tap'
    | 'snapshot'
    | 'portReverse.ensure';
  [key: string]: unknown;
};

type FakeProviderSession = {
  device: DeviceInfo;
  interactor: Interactor;
};

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
      name: 'port-reverse',
      command: 'runtime',
      positionals: ['port-reverse'],
      flags: DEVTOOLS_PORT_REVERSE,
      expectData: { action: 'port-reverse', ...portReverse },
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
      'install',
      'inventory',
      'open',
      'tap',
      'snapshot',
      'portReverse.ensure',
      'lease.release',
    ],
  );
}

async function createFakeProviderWorld(platform: 'android' | 'ios' = 'android') {
  const runtime = new FakeProviderDeviceRuntime(platform);
  const providerRuntimeProviders = createProviderDeviceRuntimeRequestProviders([runtime]);
  const daemon = await createProviderScenarioHarness({
    ...providerRuntimeProviders,
    deviceInventoryProvider: providerRuntimeProviders.deviceInventoryProvider!,
  });
  return {
    daemon,
    runtime,
    close: async () => {
      await runtime.shutdown();
      await daemon.close();
    },
  };
}

class FakeProviderDeviceRuntime implements ProviderDeviceRuntime {
  readonly provider = FAKE_PROVIDER;
  readonly calls: FakeProviderCall[] = [];
  private readonly sessionsByLeaseId = new Map<string, FakeProviderSession>();
  private readonly platform: 'android' | 'ios';

  constructor(platform: 'android' | 'ios' = 'android') {
    this.platform = platform;
  }

  readonly leaseLifecycle: LeaseLifecycleProvider = {
    allocate: async (lease) => {
      if (lease.leaseProvider !== this.provider) return undefined;
      const device = this.createDevice(lease);
      const interactor = createFakeProviderInteractor(device, this.calls);
      this.sessionsByLeaseId.set(lease.leaseId, { device, interactor });
      this.calls.push({
        type: 'lease.allocate',
        leaseId: lease.leaseId,
        provider: lease.leaseProvider,
        deviceId: device.id,
      });
      return { provider: this.provider, deviceId: device.id };
    },
    heartbeat: async (lease) => {
      if (lease.leaseProvider !== this.provider) return undefined;
      this.calls.push({
        type: 'lease.heartbeat',
        leaseId: lease.leaseId,
        provider: lease.leaseProvider,
      });
      return { provider: this.provider };
    },
    release: async (lease) => {
      if (lease.leaseProvider !== this.provider) return undefined;
      this.sessionsByLeaseId.delete(lease.leaseId);
      this.calls.push({
        type: 'lease.release',
        leaseId: lease.leaseId,
        provider: lease.leaseProvider,
      });
      return { provider: this.provider };
    },
  };

  readonly deviceInventoryProvider: DeviceInventoryProvider = async (request) => {
    if (request.leaseProvider !== this.provider) return null;
    const leaseId = request.leaseId;
    if (!leaseId) return [];
    const session = this.sessionsByLeaseId.get(leaseId);
    if (!session) return [];
    this.calls.push({
      type: 'inventory',
      leaseId,
      platform: request.platform,
    });
    return [session.device];
  };

  ownsDevice(device: DeviceInfo): boolean {
    return device.id.startsWith(`fake-provider:${this.platform}:`);
  }

  getInteractor(device: DeviceInfo): Interactor | undefined {
    return [...this.sessionsByLeaseId.values()].find((session) => session.device.id === device.id)
      ?.interactor;
  }

  async installApp(
    device: DeviceInfo,
    app: string,
    appPath: string,
  ): Promise<{ packageName: string; appName: string; launchTarget: string } | undefined> {
    if (!this.ownsDevice(device)) return undefined;
    this.calls.push({ type: 'install', deviceId: device.id, app, appPath });
    return {
      packageName: 'com.example.installed',
      appName: 'Installed Demo',
      launchTarget: 'com.example.installed',
    };
  }

  async configurePortReverse(
    options: ProviderPortReverseOptions,
  ): Promise<Record<string, unknown> | undefined> {
    if (options.provider !== this.provider) return undefined;
    this.calls.push({ type: 'portReverse.ensure', options });
    return { provider: this.provider, ...options };
  }

  async shutdown(): Promise<void> {
    this.sessionsByLeaseId.clear();
  }

  deviceIdForLease(leaseId: string): string {
    return `fake-provider:${this.platform}:${leaseId}`;
  }

  private createDevice(lease: DeviceLease): DeviceInfo {
    if (this.platform === 'ios') {
      return {
        platform: 'apple',
        appleOs: 'ios',
        id: this.deviceIdForLease(lease.leaseId),
        name: 'Fake Provider iOS Simulator',
        kind: 'simulator',
        target: 'mobile',
        booted: true,
      };
    }
    return {
      platform: 'android',
      id: this.deviceIdForLease(lease.leaseId),
      name: 'Fake Provider Android',
      kind: 'device',
      target: 'mobile',
      booted: true,
    };
  }
}

function createFakeProviderInteractor(device: DeviceInfo, calls: FakeProviderCall[]): Interactor {
  return new Proxy<Partial<Interactor>>(
    {
      open: async (app, options) => {
        calls.push({ type: 'open', deviceId: device.id, app, url: options?.url });
      },
      close: async (app) => {
        calls.push({ type: 'close', deviceId: device.id, app });
      },
      tap: async (x, y) => {
        calls.push({ type: 'tap', deviceId: device.id, x, y });
        return { backend: 'fake-provider', x, y };
      },
      snapshot: async (options): Promise<SnapshotResult> => {
        calls.push({
          type: 'snapshot',
          deviceId: device.id,
          interactiveOnly: options?.interactiveOnly,
        });
        return {
          backend: 'android',
          nodes: [
            {
              index: 0,
              type: 'TextView',
              label: 'Provider Ready',
              rect: { x: 0, y: 0, width: 120, height: 40 },
              enabled: true,
              visibleToUser: true,
            },
          ],
        };
      },
    },
    {
      get(target, property, receiver) {
        if (property in target) return Reflect.get(target, property, receiver);
        if (
          typeof property === 'string' &&
          ABSENT_FAKE_PROVIDER_INTERACTOR_PROPERTIES.has(property)
        ) {
          return undefined;
        }
        if (typeof property === 'string') {
          return () => throwUnexpectedProviderInteraction(property);
        }
        return undefined;
      },
    },
  ) as Interactor;
}

function leaseFlags(leaseId?: string): DaemonRequest['flags'] {
  return {
    platform: 'android',
    tenant: 'team-a',
    runId: 'run-a',
    leaseId,
    leaseProvider: FAKE_PROVIDER,
  };
}

function leaseMeta(leaseId?: string): DaemonRequest['meta'] {
  return {
    tenantId: 'team-a',
    runId: 'run-a',
    leaseId,
    leaseBackend: 'android-instance',
    leaseProvider: FAKE_PROVIDER,
    deviceKey: 'android-a',
    clientId: 'client-a',
  };
}

function iosLeaseFlags(leaseId?: string): DaemonRequest['flags'] {
  return { ...leaseFlags(leaseId), platform: 'ios' };
}

function iosLeaseMeta(leaseId?: string): DaemonRequest['meta'] {
  return { ...leaseMeta(leaseId), leaseBackend: 'ios-instance', deviceKey: 'ios-a' };
}

function throwUnexpectedProviderInteraction(method: string): never {
  throw new Error(`Unexpected fake provider interactor call: ${method}`);
}
