import { installFakeManagedAgentBrowser } from '@agent-device/test-kit';
// The two routes this family has for learning about processes it does not own: the fleet-record scan
// and the startup orphan reap. A managed plugin ships its own copy of the host kit, and the request's
// command-host and diagnostic scopes never enter that copy, so every one of these reads and every stop
// has to be asked of the host the plugin was set up with (`PlatformHost.processes`) rather than run
// through the bundled copy (R13). `spawn` is refused for the whole module graph below, so a read that
// reached the bundle's exec layer fails here instead of quietly running with the daemon's environment.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, test, vi } from 'vitest';
import type { OwnedProcessRecord } from '@agent-device/contracts/platform-runtime-host';
import {
  createOwnedProcessRecordStore,
  type HostProcessInfo,
  type OwnedProcessRecordStore,
} from '@agent-device/host-kit/process';
import {
  MANAGED_WEB_BROWSER_PROCESS_PURPOSE,
  recordManagedAgentBrowserProcesses,
} from '../agent-browser-process-record.ts';
import {
  cleanupManagedAgentBrowserOrphans,
  type AgentBrowserCleanupOptions,
} from '../agent-browser-lifecycle.ts';
import { getManagedAgentBrowserStatus } from '../agent-browser-tool.ts';
import { createWebHostStub, type WebHostStub } from '../toolbox.fixtures.ts';
import { mkdtempForTestSync } from './test-utils.ts';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: () => {
    spawnMock();
    throw new Error('a managed plugin may not spawn a process tool of its own');
  },
  spawnSync: () => {
    spawnMock();
    throw new Error('a managed plugin may not run a process tool of its own');
  },
}));

const mockSpawn = vi.mocked(spawnMock);

/** A managed install, a real record store, and the status both are read from. */
function createFleetState() {
  const stateDir = mkdtempForTestSync('agent-device-web-host-routing-');
  installFakeManagedAgentBrowser(stateDir);
  const store = createOwnedProcessRecordStore({
    stateDir,
    sessionsDir: path.join(stateDir, 'sessions'),
    resolveSessionDir: (sessionId) => path.join(stateDir, 'sessions', sessionId),
  });
  const status = getManagedAgentBrowserStatus({
    stateDir,
    host: { env: process.env, cwd: process.cwd() },
  });
  return { stateDir, store, status };
}

/**
 * The host the plugin reads through, answering the identity read with the command its own table
 * already showed for each pid — what a same-pid re-read of an unchanged process answers with.
 */
function createProcessAnsweringHost(
  stateDir: string,
  store: OwnedProcessRecordStore,
  processes: readonly HostProcessInfo[],
  executablePaths: ReadonlyMap<number, string>,
): WebHostStub {
  const commands = new Map(processes.map(({ pid, command }) => [pid, command]));
  return createWebHostStub({
    stateDir,
    processes: [...processes],
    ownedProcessRecords: store,
    readProcesses: () => ({
      identities: (pids) =>
        new Map(
          pids.flatMap((pid) => {
            const command = commands.get(pid);
            return command === undefined
              ? []
              : [[pid, { startTime: `start-${pid}`, command, zombie: false }]];
          }),
        ),
      executablePaths: (pids) =>
        new Map(
          pids.flatMap((pid) => {
            const executable = executablePaths.get(pid);
            return executable === undefined ? [] : [[pid, executable]];
          }),
        ),
    }),
  });
}

function nativeBinary(installDir: string): string {
  const binary = path.join(
    installDir,
    'package',
    'node_modules',
    'agent-browser',
    'bin',
    'agent-browser-darwin-arm64',
  );
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, 'fixture');
  return fs.realpathSync.native(binary);
}

function recordedFleetPids(store: OwnedProcessRecordStore): number[] {
  return store
    .read()
    .filter((entry) => entry.scope.kind === 'daemon' && entry.status === 'decoded')
    .flatMap((entry) => entry.records)
    .filter((record) => record.purpose === MANAGED_WEB_BROWSER_PROCESS_PURPOSE)
    .map((record) => record.pid);
}

beforeEach(() => {
  mockSpawn.mockReset();
});

test('the fleet scan asks the host for every identity and executable path it acts on', async () => {
  const fleet = createFleetState();
  const daemon = nativeBinary(fleet.status.installDir);
  const stub = createProcessAnsweringHost(
    fleet.stateDir,
    fleet.store,
    [{ pid: 101, ppid: 1, command: `${daemon} daemon` }],
    new Map([[101, daemon]]),
  );
  try {
    const summary = await recordManagedAgentBrowserProcesses(
      fleet.status,
      fleet.store,
      stub.toolbox,
    );

    // The scan still owns the process it was shown, so the host's answers were the ones it acted on.
    assert.deepEqual(summary.pids, [101]);
    assert.deepEqual(recordedFleetPids(fleet.store), [101]);
    assert.deepEqual(
      stub.processReads.map((read) => read.kind),
      ['table', 'identities', 'table', 'executable-paths', 'identities'],
    );
    assert.deepEqual(stub.processReads[1]!.pids, [101]);
    assert.deepEqual(stub.processReads[3]!.pids, [101]);
    assert.equal(mockSpawn.mock.calls.length, 0);
  } finally {
    fs.rmSync(fleet.stateDir, { recursive: true, force: true });
  }
});

test('the startup reap stops the recorded fleet through the host that owns the record', async () => {
  const fleet = createFleetState();
  const stub = createProcessAnsweringHost(fleet.stateDir, fleet.store, [], new Map());
  const record: OwnedProcessRecord = {
    pid: 101,
    startTime: 'start-101',
    command: 'agent-browser daemon',
    purpose: MANAGED_WEB_BROWSER_PROCESS_PURPOSE,
  };
  fleet.store.replace({ kind: 'daemon' }, [record]);
  const options: AgentBrowserCleanupOptions = {
    env: process.env,
    emitDiagnostic: () => {},
    processes: stub.host.processes,
    ownedProcessRecords: fleet.store,
  };
  try {
    const cleanup = await cleanupManagedAgentBrowserOrphans(
      fleet.status,
      'daemon-startup',
      options,
    );

    assert.deepEqual(cleanup.pids, []);
    const reaps = stub.processReads.filter((read) => read.kind === 'reap');
    assert.equal(reaps.length, 1);
    // The reap is handed the host's own store and this family's purpose, so the record it rewrites is
    // the one the daemon reads, and it stops nothing the plugin did not record as its own fleet.
    assert.equal(reaps[0]!.kind === 'reap' && reaps[0]!.store, fleet.store);
    assert.deepEqual(reaps[0]!.kind === 'reap' && reaps[0]!.options?.purposes, [
      MANAGED_WEB_BROWSER_PROCESS_PURPOSE,
    ]);
    assert.equal(mockSpawn.mock.calls.length, 0);
  } finally {
    fs.rmSync(fleet.stateDir, { recursive: true, force: true });
  }
});
