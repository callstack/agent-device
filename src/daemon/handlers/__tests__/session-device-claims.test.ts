import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';

vi.mock('../../../core/dispatch.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/dispatch.ts')>();
  return { ...actual, dispatchCommand: vi.fn(), resolveTargetDevice: vi.fn() };
});
vi.mock('../../device-ready.ts', () => ({ ensureDeviceReady: vi.fn(async () => {}) }));

import { dispatchCommand, resolveTargetDevice } from '../../../core/dispatch.ts';
import { acquireAdvisoryDeviceClaim } from '../../device-claims.ts';
import { inspectDeviceClaims } from '../../device-claim-inspection.ts';
import { LeaseRegistry } from '../../lease-registry.ts';
import { SessionStore } from '../../session-store.ts';
import { handleCloseCommand } from '../session-close.ts';
import { handleOpenCommand } from '../session-open.ts';
import type { DeviceInfo } from '../../../kernel/device.ts';

const mockDispatch = vi.mocked(dispatchCommand);
const mockResolveTargetDevice = vi.mocked(resolveTargetDevice);
const roots: string[] = [];

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.AGENT_DEVICE_CLAIMS_DIR;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function setup(): { store: SessionStore; stateDir: string } {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-session-device-claim-'));
  const claimsDir = path.join(stateDir, 'claims');
  process.env.AGENT_DEVICE_CLAIMS_DIR = claimsDir;
  roots.push(stateDir);
  return { store: new SessionStore(path.join(stateDir, 'sessions')), stateDir };
}

const android: DeviceInfo = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel',
  kind: 'emulator',
  booted: true,
};

test('failed local open rolls its advisory claim back', async () => {
  const { store, stateDir } = setup();
  mockResolveTargetDevice.mockResolvedValue(android);
  mockDispatch.mockRejectedValue(new Error('open failed'));

  await assert.rejects(async () =>
    handleOpenCommand({
      req: {
        command: 'open',
        token: 'test',
        session: 'claim-rollback',
        positionals: ['Demo'],
        flags: { platform: 'android' },
      },
      sessionName: 'claim-rollback',
      logPath: path.join(stateDir, 'daemon.log'),
      sessionStore: store,
    }),
  );
  assert.deepEqual(inspectDeviceClaims({ serial: android.id }), []);
});

test('failed local open response rolls its advisory claim back', async () => {
  const { store, stateDir } = setup();
  mockResolveTargetDevice.mockResolvedValue(android);

  const response = await handleOpenCommand({
    req: {
      command: 'open',
      token: 'test',
      session: 'claim-response-rollback',
      positionals: ['Demo'],
      flags: { platform: 'android' },
      runtime: { metroHost: '10.0.0.10', metroPort: 70_000 },
    },
    sessionName: 'claim-response-rollback',
    logPath: path.join(stateDir, 'daemon.log'),
    sessionStore: store,
  });

  assert.equal(response.ok, false);
  assert.deepEqual(inspectDeviceClaims({ serial: android.id }), []);
});

test('remote open creates no host-local advisory claim', async () => {
  const { store, stateDir } = setup();
  mockResolveTargetDevice.mockResolvedValue(android);
  mockDispatch.mockResolvedValue({});

  const response = await handleOpenCommand({
    req: {
      command: 'open',
      token: 'test',
      session: 'remote-open',
      positionals: ['Demo'],
      flags: { platform: 'android' },
      meta: { leaseProvider: 'proxy', deviceKey: 'android:emulator-5554' },
    },
    sessionName: 'remote-open',
    logPath: path.join(stateDir, 'daemon.log'),
    sessionStore: store,
  });
  assert.equal(response.ok, true);
  assert.deepEqual(inspectDeviceClaims({ serial: android.id }), []);
  assert.equal(store.get('remote-open')?.deviceClaim, undefined);
});

test('local close clears its matching advisory claim after teardown', async () => {
  const { store, stateDir } = setup();
  const acquired = await acquireAdvisoryDeviceClaim({
    device: android,
    session: 'close-claim',
    workspace: process.cwd(),
    stateDir,
  });
  assert.ok(acquired.ownership);
  store.set('close-claim', {
    name: 'close-claim',
    device: android,
    deviceClaim: acquired.ownership,
    createdAt: Date.now(),
    actions: [],
  });
  mockDispatch.mockResolvedValue({});

  const response = await handleCloseCommand({
    req: { command: 'close', token: 'test', session: 'close-claim', positionals: [], flags: {} },
    sessionName: 'close-claim',
    logPath: path.join(stateDir, 'daemon.log'),
    sessionStore: store,
    leaseRegistry: new LeaseRegistry(),
  });
  assert.equal(response.ok, true);
  assert.deepEqual(inspectDeviceClaims({ serial: android.id }), []);
});
