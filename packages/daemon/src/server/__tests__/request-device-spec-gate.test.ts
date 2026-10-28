import path from 'node:path';
import { beforeEach, expect, test, vi } from 'vitest';
import { getResolveTargetDeviceMock } from '../../__tests__/support/request-router-dispatch-mocks.ts';
import { fakeCreateCommandSurface } from '../../__tests__/support/command-surface-fake.ts';

vi.mock('../../core/device/device-ready.ts', () => ({ ensureDeviceReady: vi.fn(async () => {}) }));

import {
  IOS_SIMULATOR,
  createTestHostEnvironment,
  mkdtempForTestSync,
} from '@agent-device/test-kit';
import { createTestDeviceInventoryGateways } from '@agent-device/device-selection/inventory-gateways-fixtures';
import type { CommandFlags } from '@agent-device/contracts/command';
import { makeIosSession } from '../../__tests__/support/session-factories.ts';
import { makeSessionStore } from '../../__tests__/support/store-factory.ts';
import { LeaseRegistry } from '../../resources/lease-registry.ts';
import { hostDiagnosticsFixture } from '../../__tests__/support/host-diagnostics-fixture.ts';
import {
  createRequestHandler,
  lifecycleDeviceRuntimeGateway,
  systemRuntimeSpies,
} from '../../__tests__/support/test-device-runtime-gateway.ts';

beforeEach(() => {
  systemRuntimeSpies.appSwitcher.mockClear();
  vi.mocked(getResolveTargetDeviceMock()).mockReset().mockResolvedValue(IOS_SIMULATOR);
});

function makeHandler() {
  const sessionStore = makeSessionStore('agent-device-device-spec-gate-');
  sessionStore.publish('default', makeIosSession('default', { appBundleId: 'com.example.app' }));
  return createRequestHandler({
    host: createTestHostEnvironment(),
    createCommandSurface: fakeCreateCommandSurface,
    logPath: path.join(mkdtempForTestSync('device-spec-gate'), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    deviceRuntimeGateway: lifecycleDeviceRuntimeGateway,
    deviceInventoryGateways: createTestDeviceInventoryGateways({ local: async () => [] }),
    trackDownloadableArtifact: () => 'artifact-id',
    hostDiagnostics: hostDiagnosticsFixture(),
  });
}

async function sendAppSwitcher(flags: Partial<CommandFlags>) {
  return await makeHandler()({
    token: 'test-token',
    session: 'default',
    command: 'app-switcher',
    positionals: [],
    flags: flags as CommandFlags,
    meta: { requestId: 'device-spec-gate', sessionExplicit: true },
  });
}

// The SDK and MCP send command flags to the daemon as given; the CLI drops these values first.
test('a command whose blank osVersion, blank imageTag and physical: false name no spec runs', async () => {
  const response = await sendAppSwitcher({ osVersion: '', imageTag: '  ', physical: false });

  expect(response).toMatchObject({ ok: true });
  expect(systemRuntimeSpies.appSwitcher).toHaveBeenCalledTimes(1);
});

test('a command naming a spec is refused with device-spec-unsupported before it runs', async () => {
  const response = await sendAppSwitcher({ osVersion: '18', physical: false });

  expect(response).toMatchObject({
    ok: false,
    error: {
      code: 'UNSUPPORTED_OPERATION',
      details: { reason: 'device-spec-unsupported', keys: ['osVersion'] },
    },
  });
  expect(systemRuntimeSpies.appSwitcher).not.toHaveBeenCalled();
});

test('a command giving a spec key the wrong type is refused with device-spec-invalid before it runs', async () => {
  // The named osVersion would be refused as unsupported; the invalid key is reported instead.
  const response = await sendAppSwitcher({
    osVersion: '18',
    physical: 'yes' as unknown as boolean,
  });

  expect(response).toMatchObject({
    ok: false,
    error: {
      code: 'INVALID_ARGS',
      details: { reason: 'device-spec-invalid', keys: ['physical'] },
    },
  });
  expect(systemRuntimeSpies.appSwitcher).not.toHaveBeenCalled();
});
