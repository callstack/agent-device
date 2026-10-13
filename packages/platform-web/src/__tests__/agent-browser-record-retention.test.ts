// The owned-process record gate end to end over one real record file: the provider's gate, a real
// daemon-scoped record store, and the real same-pid identity probe asking the host about real
// processes. Only the process-table scan is stood in for, which is what makes what is claimed here
// observable — a run of non-lifecycle commands leaves the recorded fleet in the file untouched, and
// a record the probe can no longer vouch for sends every later plain command back to the scan.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, test, vi } from 'vitest';
import type { OwnedProcessRecord } from '@agent-device/contracts/platform-runtime-host';
import {
  createOwnedProcessRecordStore,
  readProcessCommand,
  readProcessStartTime,
  type OwnedProcessRecordStore,
} from '@agent-device/host-kit/process';
import { withCommandExecutorOverride, type ExecResult } from '@agent-device/host-kit/command';
import { MANAGED_WEB_BROWSER_PROCESS_PURPOSE } from '../agent-browser-process-record.ts';
import { createAgentBrowserWebProvider } from '../agent-browser-provider.ts';
import type { WebProvider } from '../provider.ts';
import {
  agentBrowserJsonResult,
  installFakeManagedAgentBrowser,
  mkdtempForTestSync,
} from './test-utils.ts';

const { processRecordScanMock } = vi.hoisted(() => ({
  processRecordScanMock: vi.fn(async () => ({ count: 0, pids: [], processes: [] })),
}));

vi.mock('../agent-browser-process-record.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../agent-browser-process-record.ts')>()),
  recordManagedAgentBrowserProcesses: processRecordScanMock,
}));

const mockProcessRecordScan = vi.mocked(processRecordScanMock);

/** The identity proof a scan would have written for a live pid, read from the host itself. */
function recordOfLivePid(pid: number): OwnedProcessRecord | undefined {
  const startTime = readProcessStartTime(pid);
  const command = readProcessCommand(pid);
  if (startTime === null || command === null) return undefined;
  return { pid, startTime, command, purpose: MANAGED_WEB_BROWSER_PROCESS_PURPOSE };
}

/**
 * One live process a case can own, and the record of it. Exit is awaited through the child handle
 * rather than by polling liveness, because a killed child the host has not reaped yet still answers
 * `ps` as a zombie — which the probe reads as not-live, but which no liveness poll can wait out.
 */
type OwnedLiveProcess = {
  record: OwnedProcessRecord;
  stopAndAwaitExit(): Promise<void>;
};

const liveProcesses = new Set<OwnedLiveProcess>();

/**
 * Spawns a live process and records its identity, which is every case's subject. Spawning and
 * reading back that identity are host capabilities this suite is entitled to assume, so a host that
 * cannot do either fails the case instead of letting it pass without having asserted anything.
 */
function startOwnedLiveProcess(): OwnedLiveProcess {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120_000)'], {
    stdio: 'ignore',
  });
  const pid = child.pid;
  if (pid === undefined) throw new Error('no pid for the spawned process to own');
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  const record = recordOfLivePid(pid);
  if (record === undefined) {
    child.kill('SIGKILL');
    throw new Error(`the host named no identity for the live pid ${pid}`);
  }
  const live: OwnedLiveProcess = {
    record,
    stopAndAwaitExit: async () => {
      liveProcesses.delete(live);
      try {
        child.kill('SIGKILL');
      } catch {
        // Already gone, which is the outcome the caller wanted.
      }
      await exited;
    },
  };
  liveProcesses.add(live);
  return live;
}

afterAll(() => {
  for (const live of liveProcesses) {
    try {
      process.kill(live.record.pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
});

beforeEach(() => {
  mockProcessRecordScan.mockReset();
  mockProcessRecordScan.mockResolvedValue({ count: 0, pids: [], processes: [] });
});

/** A run of plain, successful, non-lifecycle commands: the calls the probe is meant to cover. */
async function runPlainCommands(provider: WebProvider): Promise<void> {
  const succeed = async (): Promise<ExecResult> =>
    agentBrowserJsonResult({ success: true, data: {} });
  await withCommandExecutorOverride(succeed, async () => {
    await provider.snapshot();
    await provider.clickRef?.('@e3');
    await provider.screenshot('/tmp/page.png');
  });
}

function recordedFleetPids(store: OwnedProcessRecordStore): number[] {
  return store
    .read()
    .filter((entry) => entry.scope.kind === 'daemon' && entry.status === 'decoded')
    .flatMap((entry) => entry.records)
    .filter((record) => record.purpose === MANAGED_WEB_BROWSER_PROCESS_PURPOSE)
    .map((record) => record.pid);
}

/**
 * Drives one case against a provider over a real record store in a throwaway state dir, seeded with
 * the caller's fleet record, with the managed install present so the gate decides at all.
 */
async function withFleetRecordStore(
  seed: OwnedProcessRecord,
  runScenario: (scenario: {
    provider: WebProvider;
    store: OwnedProcessRecordStore;
    /** The daemon-scoped record file, which the store creates, rewrites, and removes. */
    recordsPath: string;
  }) => Promise<void>,
): Promise<void> {
  const stateDir = mkdtempForTestSync('agent-device-web-retention-');
  const sessionsDir = path.join(stateDir, 'sessions');
  installFakeManagedAgentBrowser(stateDir);
  const store = createOwnedProcessRecordStore({
    stateDir,
    sessionsDir,
    resolveSessionDir: (sessionId) => path.join(sessionsDir, sessionId),
  });
  store.replace({ kind: 'daemon' }, [seed]);
  await runScenario({
    provider: createAgentBrowserWebProvider({
      session: 'web-session',
      stateDir,
      openWebSessionNames: () => ['web-session'],
      ownedProcessRecords: store,
    }),
    store,
    recordsPath: path.join(stateDir, 'owned-processes.json'),
  });
}

test('a run of plain commands leaves the recorded fleet in the real record file', async () => {
  const fleet = startOwnedLiveProcess();
  await withFleetRecordStore(fleet.record, async (scenario) => {
    const fleetBefore = fs.readFileSync(scenario.recordsPath, 'utf8');
    await runPlainCommands(scenario.provider);
    // A scan would have re-derived the fleet from the process table, found none of this pretend
    // fleet in it, and written nothing. The file surviving unchanged is the probe answering for it.
    assert.equal(fs.readFileSync(scenario.recordsPath, 'utf8'), fleetBefore);
    assert.equal(mockProcessRecordScan.mock.calls.length, 0);
    assert.deepEqual(recordedFleetPids(scenario.store), [fleet.record.pid]);
  });
});

test('the fleet the host no longer names sends the next plain commands back to the scan', async () => {
  const fleet = startOwnedLiveProcess();
  await withFleetRecordStore(fleet.record, async (scenario) => {
    await runPlainCommands(scenario.provider);
    assert.equal(mockProcessRecordScan.mock.calls.length, 0);
    await fleet.stopAndAwaitExit();
    await runPlainCommands(scenario.provider);
    // No recorded pid survives the probe any more, so each later plain command pays the scan whose
    // job is to re-own whatever fleet is really there.
    assert.equal(mockProcessRecordScan.mock.calls.length, 3);
  });
});

test('an unreadable record file fails closed to the scan through the real store', async () => {
  const fleet = startOwnedLiveProcess();
  await withFleetRecordStore(fleet.record, async (scenario) => {
    fs.writeFileSync(scenario.recordsPath, '{ this is not an owned process record\n');
    await runPlainCommands(scenario.provider);
    // Undecodable evidence is unknown evidence: every plain command goes back to the scan rather
    // than trusting a record the store cannot read.
    assert.equal(mockProcessRecordScan.mock.calls.length, 3);
  });
});
