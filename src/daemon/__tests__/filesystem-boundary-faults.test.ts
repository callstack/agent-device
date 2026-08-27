import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { afterEach, vi } from 'vitest';
import { localRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import { createDurableResourceEnvelope } from '@agent-device/capture-kit';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { acquireDeviceClaim } from '../device-claims.ts';
import { canonicalLocalDeviceKey } from '../device-claim-paths.ts';
import { createDurableCaptureResourceStore } from '../durable-capture-resource-store.ts';
import { writeDaemonShutdownReport } from '../daemon-shutdown-report.ts';
import { SessionScriptWriter, type SessionScriptWriteResult } from '../session-script-writer.ts';
import { SessionStore } from '../session-store.ts';
import {
  repairPublication,
  makeRepairCompleteSession,
} from '../../__tests__/test-utils/session-factories.ts';
import {
  registerFilesystemBoundaryMatrix,
  type FilesystemBoundaryOwner,
  type FilesystemBoundaryFixture,
} from '../../__tests__/test-utils/filesystem-boundary-faults.ts';

vi.mock('@agent-device/host-kit/process', async (importOriginal) =>
  (await import('../../__tests__/test-utils/host-process-mock.ts')).pinOwnProcessStartTime(
    importOriginal,
  ),
);

type DaemonFilesystemBoundaryOwner =
  | 'durable-capture-resource-store/screen-recording'
  | 'durable-capture-resource-store/app-log'
  | 'device-claims'
  | 'session-script-writer'
  | 'daemon-shutdown-report'
  | 'session-store';

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.AGENT_DEVICE_CLAIMS_DIR;
});

const DAEMON_FILESYSTEM_BOUNDARY_OWNERS = {
  'durable-capture-resource-store/screen-recording': createDurableResourceFixture({
    resourceKind: 'screen-recording',
    fileName: 'screen-recording.resource.json',
    displayName: 'Screen recording',
  }),
  'durable-capture-resource-store/app-log': createDurableResourceFixture({
    resourceKind: 'app-log',
    fileName: 'app-log.resource.json',
    displayName: 'App-log',
  }),
  'device-claims': createDeviceClaimFixture,
  'session-script-writer': createSessionScriptFixture,
  'daemon-shutdown-report': createShutdownReportFixture,
  'session-store': createSessionStoreFixture,
} as const satisfies Record<DaemonFilesystemBoundaryOwner, FilesystemBoundaryOwner>;

registerFilesystemBoundaryMatrix(DAEMON_FILESYSTEM_BOUNDARY_OWNERS, 'daemon');

function createDurableResourceFixture(
  config: Readonly<{
    resourceKind: 'screen-recording' | 'app-log';
    fileName: string;
    displayName: string;
  }>,
): FilesystemBoundaryOwner {
  return (root) => {
    const store = createDurableCaptureResourceStore(config);
    const targetPath = store.resolvePath(path.join(root, 'sessions', 'default'));
    return {
      targetPath,
      run: async () =>
        store.write(targetPath, resourceEnvelope(config.resourceKind, 'filesystem-fault')),
      expected: 'throw',
    };
  };
}

function createDeviceClaimFixture(root: string): FilesystemBoundaryFixture {
  const device: DeviceInfo = {
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel',
    kind: 'emulator',
    booted: true,
  };
  process.env.AGENT_DEVICE_CLAIMS_DIR = root;
  const deviceKey = canonicalLocalDeviceKey(device);
  const claimPath = path.join(
    root,
    `${crypto.createHash('sha256').update(deviceKey).digest('hex')}.json`,
  );

  return {
    targetPath: claimPath,
    run: async () =>
      acquireDeviceClaim({
        device,
        session: 'filesystem-fault',
        workspace: process.cwd(),
        stateDir: path.join(root, 'state'),
        reconcileOrphanedDeviceClaim: async () => ({
          status: 'retained' as const,
          reason: 'test-no-recovery',
        }),
      }),
    expected: 'throw',
  };
}

function createSessionScriptFixture(root: string): FilesystemBoundaryFixture {
  const targetPath = path.join(root, 'published.ad');
  const writer = new SessionScriptWriter(path.join(root, 'sessions'));
  const session = makeRepairCompleteSession('filesystem-fault', {
    scriptPublication: repairPublication('complete', { path: targetPath, force: true }),
    actions: [{ ts: 1, command: 'open', positionals: ['Demo'], flags: {} }],
  });

  return {
    targetPath,
    run: async () => writer.write(session, { force: true }),
    expected: 'return',
    verifyReturn: (value, errno) => {
      assert.ok(isSessionScriptWriteFailure(value));
      if (!isSessionScriptWriteFailure(value)) return;
      assert.equal(value.written, false);
      assert.equal(value.error?.code, 'COMMAND_FAILED');
      assert.match(value.error?.message ?? '', new RegExp(errno));
    },
  };
}

function createShutdownReportFixture(root: string): FilesystemBoundaryFixture {
  return {
    targetPath: path.join(root, 'daemon-shutdown.json'),
    run: async () =>
      writeDaemonShutdownReport(root, {
        providerReleases: { released: [], pending: [] },
        claims: { released: [], orphaned: [], superseded: [] },
      }),
    expected: 'return',
  };
}

function createSessionStoreFixture(root: string): FilesystemBoundaryFixture {
  const targetPath = path.join(root, 'published-by-teardown.ad');
  const store = new SessionStore(path.join(root, 'sessions'));
  const session = makeRepairCompleteSession('filesystem-fault', {
    scriptPublication: repairPublication('complete', { path: targetPath, force: true }),
  });

  return {
    targetPath,
    run: async () => store.finalizeRepairTeardown(session),
    expected: 'return',
    verifyReturn: (_value, errno) => {
      const tombstone = store.readRepairTombstone(session.name);
      assert.equal(tombstone?.commitFailure?.code, 'COMMAND_FAILED');
      assert.match(tombstone?.commitFailure?.message ?? '', new RegExp(errno));
    },
  };
}

function isSessionScriptWriteFailure(
  value: unknown,
): value is Extract<SessionScriptWriteResult, { written: false }> {
  return (
    typeof value === 'object' && value !== null && 'written' in value && value.written === false
  );
}

function resourceEnvelope<ResourceKind extends 'screen-recording' | 'app-log'>(
  resourceKind: ResourceKind,
  sessionId: string,
) {
  return createDurableResourceEnvelope({
    resourceKind,
    sessionId,
    device: { id: 'emulator-5554', family: 'android', kind: 'emulator' },
    owner: localRuntimeOwner('android'),
    fence: { token: `fence-${sessionId}`, generation: 1 },
    lifecycle: 'open',
    descriptor: { version: 1, body: {} },
  });
}
