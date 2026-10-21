import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, expect, test, vi } from 'vitest';
import { getResolveTargetDeviceMock } from '../../__tests__/support/request-router-dispatch-mocks.ts';
import { fakeCreateCommandSurface } from '../../__tests__/support/command-surface-fake.ts';

vi.mock('../device/device-ready.ts', () => ({ ensureDeviceReady: vi.fn(async () => {}) }));

import { hostAppDevice, type DeviceInfo } from '@agent-device/kernel/device';
import {
  ANDROID_EMULATOR,
  IOS_SIMULATOR,
  MACOS_DEVICE,
  mkdtempForTestSync,
  createTestHostEnvironment,
} from '@agent-device/test-kit';
import { createTestDeviceInventoryGateways } from '@agent-device/device-selection/inventory-gateways-fixtures';
import { makeIosSession } from '../../__tests__/support/session-factories.ts';
import { makeSessionStore } from '../../__tests__/support/store-factory.ts';
import { parseDaemonPolicy } from '@agent-device/daemon-contracts/daemon-policy-file';
import {
  assertDaemonPolicyAdmitsRequest,
  restrictDeviceInventoryToDaemonPolicy,
} from '../daemon-policy.ts';
import { AppError } from '@agent-device/kernel/errors';
import type { DaemonRequest } from '../daemon-request.ts';
import { LeaseRegistry } from '../../resources/lease-registry.ts';
import { hostDiagnosticsFixture } from '../../__tests__/support/host-diagnostics-fixture.ts';
import {
  createRequestHandler,
  lifecycleDeviceRuntimeGateway,
  systemRuntimeSpies,
} from '../../__tests__/support/test-device-runtime-gateway.ts';

const mockResolveTargetDevice = vi.mocked(getResolveTargetDeviceMock());
const OTHER_SIMULATOR: DeviceInfo = { ...IOS_SIMULATOR, id: 'sim-2', name: 'iPhone 16' };

beforeEach(() => {
  systemRuntimeSpies.appSwitcher.mockClear();
  mockResolveTargetDevice.mockReset();
  mockResolveTargetDevice.mockResolvedValue(IOS_SIMULATOR);
});

function policy(raw: Record<string, unknown>) {
  return parseDaemonPolicy({ version: 1, ...raw }, '/etc/agent-device/policy.json');
}

function makeHandler(
  daemonPolicy: ReturnType<typeof policy>,
  options: {
    inventory?: readonly DeviceInfo[];
    providerInventory?: readonly DeviceInfo[];
    leaseRegistry?: LeaseRegistry;
  } = {},
) {
  const sessionStore = makeSessionStore('agent-device-daemon-policy-');
  sessionStore.publish('default', makeIosSession('default', { appBundleId: 'com.example.app' }));
  const bind = vi.fn(lifecycleDeviceRuntimeGateway.bind);
  const inspectFacts = vi.fn(lifecycleDeviceRuntimeGateway.inspectFacts);
  const handler = createRequestHandler({
    host: createTestHostEnvironment(),
    createCommandSurface: fakeCreateCommandSurface,
    logPath: path.join(mkdtempForTestSync('daemon-policy'), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry: options.leaseRegistry ?? new LeaseRegistry(),
    deviceRuntimeGateway: { ...lifecycleDeviceRuntimeGateway, bind, inspectFacts },
    deviceInventoryGateways: createTestDeviceInventoryGateways({
      local: async () => options.inventory ?? [],
      provider: options.providerInventory
        ? {
            discover: async () => ({
              kind: 'inventory',
              devices: [...(options.providerInventory ?? [])],
            }),
          }
        : undefined,
    }),
    trackDownloadableArtifact: () => 'artifact-id',
    hostDiagnostics: hostDiagnosticsFixture(),
    daemonPolicy,
  });
  return { handler, bind, inspectFacts };
}

function request(command: string, extra: Partial<DaemonRequest> = {}): DaemonRequest {
  return {
    token: 'test-token',
    session: 'default',
    command,
    positionals: [],
    ...extra,
    meta: { requestId: `policy-${command}`, sessionExplicit: true, ...extra.meta },
  };
}

function expectPolicyDenied(response: unknown, rule: string) {
  expect(response).toMatchObject({
    ok: false,
    error: { code: 'UNAUTHORIZED', details: { reason: 'DAEMON_POLICY_DENIED', rule } },
  });
}

test('a denied command is refused before it binds a device', async () => {
  const { handler, bind } = makeHandler(policy({ commands: { deny: ['app-switcher'] } }));

  const response = await handler(request('app-switcher'));

  expectPolicyDenied(response, 'command');
  expect(bind).not.toHaveBeenCalled();
  expect(systemRuntimeSpies.appSwitcher).not.toHaveBeenCalled();
});

test('an allow list admits only the commands it names', async () => {
  const { handler } = makeHandler(policy({ commands: { allow: ['app-switcher'] } }));

  expect(await handler(request('app-switcher'))).toMatchObject({ ok: true });
  expectPolicyDenied(await handler(request('shutdown')), 'command');
});

test('a batch naming a denied step is refused before any step runs', async () => {
  const { handler } = makeHandler(policy({ commands: { deny: ['shutdown'] } }));

  const response = await handler(
    request('batch', {
      flags: { batchSteps: [{ command: 'app-switcher' }, { command: 'shutdown' }] },
    }),
  );

  expectPolicyDenied(response, 'command');
  expect(systemRuntimeSpies.appSwitcher).not.toHaveBeenCalled();
});

test('batch steps re-enter lease admission, so a step before open under a macos-app lease is refused', async () => {
  vi.stubEnv('AGENT_DEVICE_MACOS_APP_BACKEND', 'native');
  const leaseRegistry = new LeaseRegistry();
  const lease = leaseRegistry.putHostLease('a1b2c3d4e5f60718293a4b5c6d7e8f90', {
    tenantId: 'stim',
    runId: 'run-1',
    leaseBackend: 'macos-app',
    deviceKey: 'com.example.app',
  });
  const { handler, bind } = makeHandler(policy({ leases: { require: 'macos-app' } }), {
    leaseRegistry,
  });

  const response = await handler(
    request('batch', {
      session: 'leased',
      flags: {
        platform: 'macos',
        batchSteps: [
          { command: 'snapshot' },
          { command: 'open', positionals: ['com.example.app'] },
        ],
      },
      meta: {
        tenantId: 'stim',
        runId: 'run-1',
        leaseId: lease.leaseId,
        leaseBackend: 'macos-app',
        deviceKey: 'com.example.app',
      },
    }),
  );
  vi.unstubAllEnvs();

  expect(response).toMatchObject({
    ok: false,
    error: {
      code: 'UNAUTHORIZED',
      details: { reason: 'MACOS_APP_LEASE_DENIED', rule: 'session', step: 1, executed: 0 },
    },
  });
  expect(bind).not.toHaveBeenCalled();
});

test('replay actions re-enter policy admission', async () => {
  const root = mkdtempForTestSync('agent-device-daemon-policy-replay-');
  const replayPath = path.join(root, 'flow.ad');
  fs.writeFileSync(replayPath, 'app-switcher\n');
  const { handler } = makeHandler(policy({ commands: { deny: ['app-switcher'] } }));

  const response = await handler(
    request('replay', { positionals: [replayPath], meta: { cwd: root } }),
  );

  expect(response.ok).toBe(false);
  expect(JSON.stringify(response)).toContain('DAEMON_POLICY_DENIED');
  expect(systemRuntimeSpies.appSwitcher).not.toHaveBeenCalled();
});

test('close --shutdown is refused when the policy denies device-shutdown', async () => {
  const { handler, bind } = makeHandler(policy({ capabilities: { deny: ['device-shutdown'] } }));

  const response = await handler(request('close', { flags: { shutdown: true } }));

  expectPolicyDenied(response, 'capability');
  expect(bind).not.toHaveBeenCalled();
});

test('an explicit device outside the policy is refused', async () => {
  const { handler } = makeHandler(policy({ devices: { allow: [{ udid: IOS_SIMULATOR.id }] } }));

  const response = await handler(request('open', { flags: { udid: OTHER_SIMULATOR.id } }));

  expectPolicyDenied(response, 'device');
});

test('a session bound to a device outside the policy cannot inspect or bind it', async () => {
  const { handler, bind, inspectFacts } = makeHandler(
    policy({ devices: { allow: [{ udid: 'sim-pinned' }] } }),
  );

  const response = await handler(request('app-switcher'));

  expectPolicyDenied(response, 'device');
  expect(inspectFacts).not.toHaveBeenCalled();
  expect(bind).not.toHaveBeenCalled();
  expect(systemRuntimeSpies.appSwitcher).not.toHaveBeenCalled();
});

test('device inventory lists only the devices the policy allows', async () => {
  const { handler } = makeHandler(policy({ devices: { allow: [{ udid: IOS_SIMULATOR.id }] } }), {
    inventory: [IOS_SIMULATOR, OTHER_SIMULATOR, ANDROID_EMULATOR],
  });

  const response = await handler(request('devices', { session: undefined }));

  expect(response).toMatchObject({
    ok: true,
    data: { devices: [expect.objectContaining({ id: IOS_SIMULATOR.id })] },
  });
});

test('a batch step that shuts down or names a foreign device is refused before any step runs', async () => {
  const { handler } = makeHandler(
    policy({
      devices: { allow: [{ udid: IOS_SIMULATOR.id }] },
      capabilities: { deny: ['device-shutdown'] },
    }),
  );

  const shutdownStep = await handler(
    request('batch', {
      flags: {
        batchSteps: [{ command: 'app-switcher' }, { command: 'close', flags: { shutdown: true } }],
      },
    }),
  );
  const foreignStep = await handler(
    request('batch', {
      flags: {
        batchSteps: [
          { command: 'app-switcher' },
          { command: 'open', flags: { udid: OTHER_SIMULATOR.id } },
        ],
      },
    }),
  );

  expectPolicyDenied(shutdownStep, 'capability');
  expectPolicyDenied(foreignStep, 'device');
  expect(systemRuntimeSpies.appSwitcher).not.toHaveBeenCalled();
});

test('an empty device selector names no device and is not a policy denial', () => {
  const pinned = policy({ devices: { allow: [{ udid: IOS_SIMULATOR.id }] } });

  expect(() =>
    assertDaemonPolicyAdmitsRequest(pinned, request('open', { flags: { udid: '', serial: ' ' } })),
  ).not.toThrow();
});

test('a provider answering with only out-of-scope devices does not hide allowed local ones', async () => {
  const { handler } = makeHandler(policy({ devices: { allow: [{ udid: IOS_SIMULATOR.id }] } }), {
    inventory: [IOS_SIMULATOR],
    providerInventory: [OTHER_SIMULATOR],
  });

  const response = await handler(request('devices', { session: undefined }));

  expect(response).toMatchObject({
    ok: true,
    data: { devices: [expect.objectContaining({ id: IOS_SIMULATOR.id })] },
  });
});

test('an allow list denies the internal runtime command unless it names runtime', async () => {
  const { handler, bind } = makeHandler(policy({ commands: { allow: ['snapshot'] } }));
  const runtimeClear = request('runtime', { positionals: ['clear'] });

  const response = await handler(runtimeClear);

  expectPolicyDenied(response, 'command');
  expect(response).toMatchObject({ error: { details: { command: 'runtime' } } });
  expect(bind).not.toHaveBeenCalled();
  expect(deniedCommand(policy({ commands: { allow: ['runtime'] } }), runtimeClear)).toBeUndefined();
});

test('command rules name internal device commands the registry way', () => {
  const denyRuntime = policy({ commands: { deny: ['runtime', 'install-from-source'] } });
  const allowSnapshot = policy({ commands: { allow: ['snapshot'] } });

  expect(deniedCommand(denyRuntime, request('runtime'))).toBe('runtime');
  expect(deniedCommand(denyRuntime, request('install_source'))).toBe('install-from-source');
  // Protocol plumbing (leases, session bookkeeping) is never decided by command rules.
  expect(deniedCommand(allowSnapshot, request('lease_heartbeat'))).toBeUndefined();
  // A name the registry does not know fails closed under an allow list.
  expect(deniedCommand(allowSnapshot, request('not-a-command'))).toBe('not-a-command');
});

/** The command a policy denial names, or undefined when the policy admits the request. */
function deniedCommand(daemonPolicy: ReturnType<typeof policy>, req: DaemonRequest) {
  try {
    assertDaemonPolicyAdmitsRequest(daemonPolicy, req);
    return undefined;
  } catch (error) {
    expect(error).toMatchObject({
      code: 'UNAUTHORIZED',
      details: { reason: 'DAEMON_POLICY_DENIED', rule: 'command' },
    });
    return (error as { details: { command: string } }).details.command;
  }
}

test('doctor counts only the devices the policy allows', async () => {
  const { handler } = makeHandler(policy({ devices: { allow: [{ udid: IOS_SIMULATOR.id }] } }), {
    inventory: [IOS_SIMULATOR, OTHER_SIMULATOR],
  });

  const response = await handler(
    request('doctor', { session: undefined, flags: { platform: 'ios' } }),
  );

  expect(response).toMatchObject({
    ok: true,
    data: {
      checks: expect.arrayContaining([
        expect.objectContaining({
          id: 'device',
          evidence: expect.objectContaining({ available: 1 }),
        }),
      ]),
    },
  });
});

const TEXT_EDIT = hostAppDevice(MACOS_DEVICE, 'com.apple.TextEdit');
const CALCULATOR = hostAppDevice(MACOS_DEVICE, 'com.apple.calculator');

/** A fresh native open resolves the app device of the Mac selection found, as production does. */
function openApp(device: DeviceInfo, flags: DaemonRequest['flags'] = {}) {
  mockResolveTargetDevice.mockResolvedValue(device);
  return request('open', {
    session: `open-${device.id}`,
    positionals: [device.hostApp?.bundleId ?? 'com.example.app'],
    flags: { platform: 'macos', ...flags },
  });
}

test('a policy id with `:app:` in it matches a device id spelled in another case', async () => {
  const providerDevice: DeviceInfo = { ...IOS_SIMULATOR, id: 'pool:app:ABC' };
  const { handler } = makeHandler(policy({ devices: { allow: [{ udid: 'pool:app:ABC' }] } }), {
    inventory: [providerDevice],
  });

  expect(await handler(request('devices', { session: undefined }))).toMatchObject({
    ok: true,
    data: { devices: [expect.objectContaining({ id: 'pool:app:ABC' })] },
  });
});

test('a policy that allows the Mac admits a native open of its app device', async () => {
  const { handler, bind } = makeHandler(
    policy({ devices: { allow: [{ udid: MACOS_DEVICE.id }] } }),
  );

  const response = await handler(openApp(TEXT_EDIT));

  expect(response).toMatchObject({ ok: true });
  expect(bind).toHaveBeenCalledWith(expect.objectContaining({ device: TEXT_EDIT }));
});

test('a policy that allows one app of the Mac admits that app only, never the whole Mac', async () => {
  const { handler, bind } = makeHandler(policy({ devices: { allow: [{ udid: TEXT_EDIT.id }] } }), {
    inventory: [MACOS_DEVICE, OTHER_SIMULATOR],
  });

  // Selection still finds the Mac, because it derives the allowed app device from it.
  expect(await handler(request('devices', { session: undefined }))).toMatchObject({
    ok: true,
    data: { devices: [expect.objectContaining({ id: MACOS_DEVICE.id })] },
  });
  expect(await handler(openApp(TEXT_EDIT))).toMatchObject({ ok: true });

  bind.mockClear();
  for (const denied of [
    openApp(CALCULATOR),
    openApp(MACOS_DEVICE, { surface: 'desktop' }),
    request('open', { session: 'by-udid', flags: { platform: 'macos', udid: MACOS_DEVICE.id } }),
  ]) {
    expectPolicyDenied(await handler(denied), 'device');
  }
  expect(bind).not.toHaveBeenCalled();
});

test('on a Mac the policy does not allow, app resolution reports nothing the Mac has installed', async () => {
  const gateways = restrictDeviceInventoryToDaemonPolicy(
    createTestDeviceInventoryGateways({
      resolveAppDevice: async () => {
        throw new AppError('AMBIGUOUS_MATCH', 'Multiple apps matched "Notes"', {
          matches: ['com.apple.Notes', 'com.example.notes'],
        });
      },
    }),
    policy({ devices: { allow: [{ udid: TEXT_EDIT.id }] } }),
  );
  await expect(gateways.resolveAppDevice!(MACOS_DEVICE, 'Notes')).resolves.toBeUndefined();

  // An installed app the policy does not allow answers like a missing one, so nothing is learned.
  const resolving = restrictDeviceInventoryToDaemonPolicy(
    createTestDeviceInventoryGateways({
      resolveAppDevice: async (host, appTarget) => hostAppDevice(host, appTarget),
    }),
    policy({ devices: { allow: [{ udid: TEXT_EDIT.id }] } }),
  );
  await expect(
    resolving.resolveAppDevice!(MACOS_DEVICE, 'com.apple.calculator'),
  ).resolves.toBeUndefined();
  await expect(resolving.resolveAppDevice!(MACOS_DEVICE, 'com.apple.TextEdit')).resolves.toEqual(
    TEXT_EDIT,
  );

  const hostAllowed = restrictDeviceInventoryToDaemonPolicy(
    createTestDeviceInventoryGateways({
      resolveAppDevice: async () => {
        throw new AppError('APP_NOT_INSTALLED', 'No app found matching "Notes"');
      },
    }),
    policy({ devices: { allow: [{ udid: MACOS_DEVICE.id }] } }),
  );
  await expect(hostAllowed.resolveAppDevice!(MACOS_DEVICE, 'Notes')).rejects.toMatchObject({
    code: 'APP_NOT_INSTALLED',
  });
});
