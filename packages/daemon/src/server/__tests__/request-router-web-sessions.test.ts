import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, expect, test, vi } from 'vitest';
import { createTestDeviceInventoryGateways } from '@agent-device/device-selection/inventory-gateways-fixtures';
import { webSessionDevice, type DeviceInfo } from '@agent-device/kernel/device';
import {
  WEB_DESKTOP_DEVICE,
  createTestHostEnvironment,
  mkdtempForTestSync,
} from '@agent-device/test-kit';
import { getResolveTargetDeviceMock } from '../../__tests__/support/request-router-dispatch-mocks.ts';
import { fakeCreateCommandSurface } from '../../__tests__/support/command-surface-fake.ts';
import { replayScriptSourceBundleFor } from '../../__tests__/support/replay-script-source-fixture.ts';
import { makeSessionStore } from '../../__tests__/support/store-factory.ts';
import {
  createRequestHandler,
  lifecycleDeviceRuntimeGateway,
} from '../../__tests__/support/test-device-runtime-gateway.ts';
import type { DaemonRequest } from '../../core/daemon-request.ts';
import { LeaseRegistry } from '../../resources/lease-registry.ts';
import { resolveRequestExecutionLockPlan } from '../request-binding.ts';

vi.mock('../../core/device/device-ready.ts', () => ({ ensureDeviceReady: vi.fn(async () => {}) }));

const mockResolveTargetDevice = vi.mocked(getResolveTargetDeviceMock());

beforeEach(() => {
  mockResolveTargetDevice.mockReset();
});

const webSessionResolution = async (
  _flags: unknown,
  options?: { webSessionName?: string },
): Promise<DeviceInfo> =>
  options?.webSessionName
    ? webSessionDevice(WEB_DESKTOP_DEVICE, options.webSessionName)
    : WEB_DESKTOP_DEVICE;

function freshWebRequest(
  command: 'batch' | 'replay',
  session: string,
  replayPath: string,
): DaemonRequest {
  const flags =
    command === 'batch'
      ? {
          platform: 'web' as const,
          batchSteps: [{ command: 'open', positionals: ['about:blank'] }],
        }
      : { platform: 'web' as const, replayScriptSource: replayScriptSourceBundleFor(replayPath) };
  return {
    token: 'test-token',
    session,
    command,
    positionals: command === 'replay' ? [replayPath] : [],
    flags,
    meta: { requestId: `req-${command}-${session}`, sessionExplicit: true },
  };
}

test.each(['batch', 'replay'] as const)(
  'two fresh web %s requests of different sessions lock their own devices and run in parallel',
  async (command) => {
    mockResolveTargetDevice.mockImplementation(webSessionResolution);
    const root = mkdtempForTestSync('agent-device-router-web-parallel-');
    const replayPath = path.join(root, 'flow.ad');
    fs.writeFileSync(replayPath, 'context platform=web\nopen about:blank\n');
    const claimsDir = mkdtempForTestSync('agent-device-router-web-parallel-claims-');
    vi.stubEnv('AGENT_DEVICE_CLAIMS_DIR', claimsDir);
    const sessionStore = makeSessionStore('agent-device-router-web-parallel-');
    try {
      const names = ['web-a', 'web-b'];
      for (const name of names) {
        const { keys } = await resolveRequestExecutionLockPlan({
          req: freshWebRequest(command, name, replayPath),
          sessionName: name,
          sessionStore,
        });
        expect(keys).toEqual([
          `session:${name}`,
          `device:${WEB_DESKTOP_DEVICE.id}:session:${name}`,
        ]);
      }

      // A run binds its device while it holds its locks and waits there until the other session
      // has bound its own: a run that held the shared host device would keep the other from
      // starting, and neither would finish.
      const bound = new Set<string>();
      let bothBound!: () => void;
      const both = new Promise<void>((resolve) => (bothBound = resolve));
      const handler = createRequestHandler({
        host: createTestHostEnvironment(),
        createCommandSurface: fakeCreateCommandSurface,
        logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
        token: 'test-token',
        sessionStore,
        leaseRegistry: new LeaseRegistry(),
        deviceRuntimeGateway: {
          ...lifecycleDeviceRuntimeGateway,
          bind: async (request) => {
            bound.add(request.device.id);
            if (bound.size >= names.length) bothBound();
            await both;
            return await lifecycleDeviceRuntimeGateway.bind(request);
          },
        },
        deviceInventoryGateways: createTestDeviceInventoryGateways(),
        trackDownloadableArtifact: () => 'artifact-id',
      });
      const responses = await Promise.all(
        names.map((name) => handler(freshWebRequest(command, name, replayPath))),
      );

      for (const response of responses) expect(response).toMatchObject({ ok: true });
      expect([...bound].sort()).toEqual(
        names.map((name) => `${WEB_DESKTOP_DEVICE.id}:session:${name}`),
      );
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(claimsDir, { recursive: true, force: true });
    }
  },
);
