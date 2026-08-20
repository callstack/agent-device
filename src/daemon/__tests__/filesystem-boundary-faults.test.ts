import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { localRuntimeOwner } from '@agent-device/contracts/platform';
import { createDurableResourceEnvelope } from '@agent-device/capture-kit';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { acquireDeviceClaim } from '../device-claims.ts';
import { canonicalLocalDeviceKey } from '../device-claim-paths.ts';
import { createDurableCaptureResourceStore } from '../durable-capture-resource-store.ts';
import { writeDaemonShutdownReport } from '../daemon-shutdown-report.ts';
import { SessionScriptWriter } from '../session-script-writer.ts';
import { SessionStore } from '../session-store.ts';
import {
  repairPublication,
  makeRepairCompleteSession,
} from '../../__tests__/test-utils/session-factories.ts';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';

vi.mock('../../utils/host-process.ts', async (importOriginal) =>
  (await import('../../__tests__/test-utils/host-process-mock.ts')).pinOwnProcessStartTime(
    importOriginal,
  ),
);

type FilesystemErrno = 'EIO' | 'ENOSPC' | 'EMFILE';
type FaultPoint = 'write' | 'rename';
type FaultInjection = { wasInjected: () => boolean };

const FILESYSTEM_ERRNOS: readonly FilesystemErrno[] = ['EIO', 'ENOSPC', 'EMFILE'];
const FAULT_POINTS: readonly FaultPoint[] = ['write', 'rename'];
const REQUIRED_DAEMON_MATRIX_MODULES = [
  'durable-capture-resource-store/screen-recording',
  'durable-capture-resource-store/app-log',
  'device-claims',
  'session-script-writer',
  'daemon-shutdown-report',
  'session-store',
] as const;
const DURABLE_RESOURCE_CONFIGS = [
  {
    resourceKind: 'screen-recording',
    fileName: 'screen-recording.resource.json',
    displayName: 'Screen recording',
  },
  { resourceKind: 'app-log', fileName: 'app-log.resource.json', displayName: 'App-log' },
] as const;
const registeredDaemonMatrixRows: string[] = [];

type BoundaryFixture = {
  targetPath: string;
  matchesPublishPath: (value: unknown) => boolean;
  run: () => Promise<unknown>;
  expected: 'throw' | 'return';
  verifyReturn?: (value: unknown, errno: FilesystemErrno) => void;
};

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.AGENT_DEVICE_CLAIMS_DIR;
});

for (const config of DURABLE_RESOURCE_CONFIGS) {
  registerFilesystemMatrix(`durable-capture-resource-store/${config.resourceKind}`, (root) => {
    const store = createDurableCaptureResourceStore(config);
    const targetPath = store.resolvePath(path.join(root, 'sessions', 'default'));

    return {
      targetPath,
      // The durable store opens the temporary path and writes through its file
      // descriptor, so the write-side fault is identified by the descriptor.
      matchesPublishPath: (value) =>
        typeof value === 'number' || matchesTargetOrTemporary(value, targetPath),
      run: async () =>
        store.write(targetPath, resourceEnvelope(config.resourceKind, 'filesystem-fault')),
      expected: 'throw',
    };
  });
}

registerFilesystemMatrix('device-claims', (root) => {
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
    matchesPublishPath: (value) => matchesTargetOrTemporary(value, claimPath),
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
});

registerFilesystemMatrix('session-script-writer', (root) => {
  const targetPath = path.join(root, 'published.ad');
  const writer = new SessionScriptWriter(path.join(root, 'sessions'));
  const session = makeRepairCompleteSession('filesystem-fault', {
    scriptPublication: repairPublication('complete', { path: targetPath, force: true }),
    actions: [{ ts: 1, command: 'open', positionals: ['Demo'], flags: {} }],
  });

  return {
    targetPath,
    matchesPublishPath: (value) => matchesTargetOrTemporary(value, targetPath),
    run: async () => writer.write(session, { force: true }),
    expected: 'return',
    verifyReturn: (value, errno) => {
      const result = value as { written?: boolean; error?: { code?: string; message?: string } };
      assert.equal(result.written, false);
      assert.equal(result.error?.code, 'COMMAND_FAILED');
      assert.match(result.error?.message ?? '', new RegExp(errno));
    },
  };
});

registerFilesystemMatrix('daemon-shutdown-report', (root) => {
  const targetPath = path.join(root, 'daemon-shutdown.json');
  return {
    targetPath,
    matchesPublishPath: (value) => matchesTargetOrTemporary(value, targetPath),
    run: async () =>
      writeDaemonShutdownReport(root, {
        providerReleases: { released: [], pending: [] },
        claims: { released: [], orphaned: [], superseded: [] },
      }),
    expected: 'return',
  };
});

registerFilesystemMatrix('session-store', (root) => {
  const targetPath = path.join(root, 'published-by-teardown.ad');
  const store = new SessionStore(path.join(root, 'sessions'));
  const session = makeRepairCompleteSession('filesystem-fault', {
    scriptPublication: repairPublication('complete', { path: targetPath, force: true }),
  });

  return {
    targetPath,
    matchesPublishPath: (value) => matchesTargetOrTemporary(value, targetPath),
    run: async () => store.finalizeRepairTeardown(session),
    expected: 'return',
    verifyReturn: (_value, errno) => {
      const tombstone = store.readRepairTombstone(session.name);
      assert.equal(tombstone?.commitFailure?.code, 'COMMAND_FAILED');
      assert.match(tombstone?.commitFailure?.message ?? '', new RegExp(errno));
    },
  };
});

test('filesystem errno matrix declares every scoped daemon row', () => {
  const expectedRows = REQUIRED_DAEMON_MATRIX_MODULES.flatMap((moduleName) =>
    FAULT_POINTS.flatMap((faultPoint) =>
      FILESYSTEM_ERRNOS.map((errno) => `${moduleName}:${faultPoint}:${errno}`),
    ),
  );
  assert.deepEqual([...registeredDaemonMatrixRows].sort(), expectedRows.sort());
});

function registerFilesystemMatrix(
  moduleName: string,
  createFixture: (root: string) => BoundaryFixture,
): void {
  for (const faultPoint of FAULT_POINTS) {
    for (const errno of FILESYSTEM_ERRNOS) {
      registeredDaemonMatrixRows.push(`${moduleName}:${faultPoint}:${errno}`);
      test(`${moduleName} ${faultPoint} ${errno} leaves no unpublished temporary file`, async () => {
        const root = mkdtempForTestSync(
          `agent-device-${moduleName.replaceAll('/', '-')}-boundary-`,
        );
        const fixture = createFixture(root);
        const fault = installFilesystemFault(faultPoint, errno, fixture.matchesPublishPath);

        let value: unknown;
        let thrown: unknown;
        try {
          value = await fixture.run();
        } catch (error) {
          thrown = error;
        }

        if (fixture.expected === 'throw') {
          assert.ok(thrown, `${moduleName} should surface ${errno}`);
          assert.equal((thrown as NodeJS.ErrnoException).code, errno);
        } else {
          assert.equal(thrown, undefined);
          fixture.verifyReturn?.(value, errno);
        }
        assert.equal(fault.wasInjected(), true, `${moduleName} ${faultPoint} fault was injected`);
        assert.equal(fs.existsSync(fixture.targetPath), false);
        assert.deepEqual(listTemporaryFiles(root), []);
      });
    }
  }
}

function installFilesystemFault(
  faultPoint: FaultPoint,
  errno: FilesystemErrno,
  matchesPublishPath: (value: unknown) => boolean,
): FaultInjection {
  const failure = createErrno(errno);
  let injected = false;
  if (faultPoint === 'write') {
    const originalWriteFileSync = fs.writeFileSync;
    vi.spyOn(fs, 'writeFileSync').mockImplementation((...args) => {
      if (matchesPublishPath(args[0])) {
        injected = true;
        Reflect.apply(originalWriteFileSync, fs, args);
        throw failure;
      }
      return Reflect.apply(originalWriteFileSync, fs, args);
    });
    return { wasInjected: () => injected };
  }

  const originalRenameSync = fs.renameSync;
  vi.spyOn(fs, 'renameSync').mockImplementation((...args) => {
    if (matchesPublishPath(args[0]) || matchesPublishPath(args[1])) {
      injected = true;
      throw failure;
    }
    return Reflect.apply(originalRenameSync, fs, args);
  });
  return { wasInjected: () => injected };
}

function createErrno(errno: FilesystemErrno): NodeJS.ErrnoException {
  const error = new Error(`injected filesystem ${errno}`) as NodeJS.ErrnoException;
  error.code = errno;
  return error;
}

function matchesTargetOrTemporary(value: unknown, targetPath: string): boolean {
  const candidate = String(value);
  const targetName = path.basename(targetPath);
  const candidateName = path.basename(candidate);
  return (
    candidate === targetPath ||
    candidateName.startsWith(`.${targetName}.`) ||
    candidateName.startsWith(`${targetName}.`)
  );
}

function listTemporaryFiles(root: string): string[] {
  const temporaryFiles: string[] = [];
  visit(root);
  return temporaryFiles;

  function visit(directory: string): void {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
      } else if (entry.name.endsWith('.tmp')) {
        temporaryFiles.push(entryPath);
      }
    }
  }
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
