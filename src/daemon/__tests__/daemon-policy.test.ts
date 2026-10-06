import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, expect, test, vi } from 'vitest';
import { getResolveTargetDeviceMock } from './request-router-dispatch-mocks.ts';

vi.mock('../device/device-ready.ts', () => ({ ensureDeviceReady: vi.fn(async () => {}) }));

import type { DeviceInfo } from '@agent-device/kernel/device';
import { ANDROID_EMULATOR, IOS_SIMULATOR } from '../../__tests__/test-utils/device-fixtures.ts';
import { createTestDeviceInventoryGateways } from '../../__tests__/test-utils/device-inventory-gateways.ts';
import { makeIosSession } from '../../__tests__/test-utils/session-factories.ts';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';
import { parseDaemonPolicy } from '../../daemon-policy-file.ts';
import { assertDaemonPolicyAdmitsRequest } from '../daemon-policy.ts';
import type { DaemonRequest } from '../daemon-request.ts';
import { LeaseRegistry } from '../lease-registry.ts';
import { createHostDiagnostics } from '../../platform-runtime-host-diagnostics.ts';
import {
  createRequestHandler,
  lifecycleDeviceRuntimeGateway,
  systemRuntimeSpies,
} from './test-device-runtime-gateway.ts';

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
    hostDiagnostics: createHostDiagnostics(),
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
