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
import type { DaemonRequest } from '../daemon-request.ts';
import { LeaseRegistry } from '../lease-registry.ts';
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
  options: { inventory?: readonly DeviceInfo[] } = {},
) {
  const sessionStore = makeSessionStore('agent-device-daemon-policy-');
  sessionStore.set('default', makeIosSession('default', { appBundleId: 'com.example.app' }));
  const bind = vi.fn(lifecycleDeviceRuntimeGateway.bind);
  const inspectFacts = vi.fn(lifecycleDeviceRuntimeGateway.inspectFacts);
  const handler = createRequestHandler({
    logPath: path.join(mkdtempForTestSync('daemon-policy'), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    deviceRuntimeGateway: { ...lifecycleDeviceRuntimeGateway, bind, inspectFacts },
    deviceInventoryGateways: createTestDeviceInventoryGateways({
      local: async () => options.inventory ?? [],
    }),
    trackDownloadableArtifact: () => 'artifact-id',
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
