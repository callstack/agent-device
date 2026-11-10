import { bindTestCommandHost } from '@agent-device/test-kit';
// The owned-process record when sessions of one daemon open and close at overlapping times. The
// fleet decides whether a close may clear the record, so these cases hold one session's open at an
// explicit gate and close another session around it.
import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';
import {
  withCommandExecutorOverride,
  type CommandExecutorOverride,
} from '@agent-device/host-kit/command';
import { createAgentBrowserWebProvider } from '../agent-browser-provider.ts';
import { AppError } from '@agent-device/kernel/errors';
import {
  agentBrowserJsonResult,
  installFakeManagedAgentBrowser,
  managedAgentBrowserCliArgs,
  mkdtempForTestSync,
  ownedProcessRecordStore,
} from './test-utils.ts';

bindTestCommandHost();

const { processRecordScanMock } = vi.hoisted(() => ({
  processRecordScanMock: vi.fn(async () => ({ count: 0, pids: [], processes: [] })),
}));

vi.mock('../agent-browser-process-record.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../agent-browser-process-record.ts')>()),
  recordManagedAgentBrowserProcesses: processRecordScanMock,
  managedWebBrowserProcessRecordIsLive: vi.fn(async () => false),
}));

const mockProcessRecordScan = vi.mocked(processRecordScanMock);

beforeEach(() => {
  mockProcessRecordScan.mockReset();
  mockProcessRecordScan.mockResolvedValue({ count: 0, pids: [], processes: [] });
});

type Gate = { passed: Promise<void>; open(): void };

function createGate(): Gate {
  let open!: () => void;
  const passed = new Promise<void>((resolve) => (open = resolve));
  return { passed, open };
}

const succeedingBackend: CommandExecutorOverride = async () =>
  agentBrowserJsonResult({ success: true, data: {} });

/** Two sessions of one daemon over one record store; the daemon has published only `published`. */
function createTwoSessionDaemon() {
  const stateDir = mkdtempForTestSync('agent-device-web-fleet-');
  installFakeManagedAgentBrowser(stateDir);
  const store = ownedProcessRecordStore();
  let published = ['session-a'];
  const providerOf = (session: string) =>
    createAgentBrowserWebProvider({
      host: { env: process.env, cwd: process.cwd() },
      session,
      stateDir,
      openWebSessionNames: () => published,
      ownedProcessRecords: store,
    });
  return {
    store,
    providerOf,
    a: providerOf('session-a'),
    b: providerOf('session-b'),
    setPublished: (names: string[]) => {
      published = names;
    },
  };
}

test('a closed browser refuses later requests from new providers until an explicit reopen', async () => {
  const daemon = createTwoSessionDaemon();
  const commands: string[] = [];
  await withCommandExecutorOverride(
    async (_command, args) => {
      commands.push(managedAgentBrowserCliArgs(args)[0]!);
      return agentBrowserJsonResult({ success: true, data: {} });
    },
    async () => {
      await daemon.a.open('about:blank');
      await daemon.a.close();
      daemon.setPublished([]);
      const closed = daemon.providerOf('session-a');
      for (const command of [
        () => closed.snapshot(),
        () => closed.screenshot('/tmp/closed.png'),
        () => closed.clickRef!('@e1'),
      ]) {
        await assert.rejects(command, (error: unknown) => {
          assert.ok(error instanceof AppError);
          assert.equal(error.code, 'SESSION_NOT_FOUND');
          assert.equal(error.details?.reason, 'web_session_closed');
          assert.equal(error.details?.dispatched, 'no');
          return true;
        });
      }
      assert.deepEqual(commands, ['open', 'close']);
      await daemon.b.snapshot();
      await closed.open('about:blank');
      await daemon.providerOf('session-a').snapshot();
      assert.deepEqual(commands, ['open', 'close', 'snapshot', 'open', 'snapshot']);
    },
  );
});

test('a failed reopen does not authorize calls on a closed browser', async () => {
  const daemon = createTwoSessionDaemon();
  await withCommandExecutorOverride(succeedingBackend, async () => {
    await daemon.a.open('about:blank');
    await daemon.a.close();
  });
  daemon.setPublished([]);
  await withCommandExecutorOverride(
    async () => agentBrowserJsonResult({ success: false, error: 'open failed' }, 1),
    async () => {
      await assert.rejects(() => daemon.a.open('about:blank'));
    },
  );
  let calls = 0;
  await withCommandExecutorOverride(
    async () => {
      calls += 1;
      return agentBrowserJsonResult({ success: true, data: {} });
    },
    async () => {
      await assert.rejects(() => daemon.providerOf('session-a').snapshot(), {
        code: 'SESSION_NOT_FOUND',
      });
    },
  );
  assert.equal(calls, 0);
});

test('a failed close leaves browser requests available for cleanup and retry', async () => {
  const daemon = createTwoSessionDaemon();
  await withCommandExecutorOverride(
    async (_command, args) =>
      managedAgentBrowserCliArgs(args)[0] === 'close'
        ? agentBrowserJsonResult({ success: false, error: 'close failed' }, 1)
        : agentBrowserJsonResult({ success: true, data: {} }),
    async () => {
      await daemon.a.open('about:blank');
      await assert.rejects(() => daemon.a.close());
      await daemon.providerOf('session-a').snapshot();
    },
  );
});

test('a close that ends while another session is opening keeps the fleet record', async () => {
  const daemon = createTwoSessionDaemon();
  const openStarted = createGate();
  const openReleased = createGate();
  const gatedOpenBackend: CommandExecutorOverride = async (_command, args) => {
    if (managedAgentBrowserCliArgs(args)[0] === 'open') {
      openStarted.open();
      await openReleased.passed;
    }
    return agentBrowserJsonResult({ success: true, data: {} });
  };

  await withCommandExecutorOverride(gatedOpenBackend, async () => {
    const opening = daemon.b.open('about:blank');
    await openStarted.passed;
    await daemon.a.close();
    assert.equal(vi.mocked(daemon.store.clear).mock.calls.length, 0);
    openReleased.open();
    await opening;
  });
  assert.equal(vi.mocked(daemon.store.clear).mock.calls.length, 0);

  daemon.setPublished([]);
  await withCommandExecutorOverride(succeedingBackend, async () => {
    await daemon.b.close();
  });
  assert.deepEqual(vi.mocked(daemon.store.clear).mock.calls, [[{ kind: 'daemon' }]]);
});

test('a close that ends after another session launched but before the daemon published it keeps the fleet record', async () => {
  const daemon = createTwoSessionDaemon();

  await withCommandExecutorOverride(succeedingBackend, async () => {
    await daemon.b.open('about:blank');
    await daemon.a.close();
  });
  assert.equal(vi.mocked(daemon.store.clear).mock.calls.length, 0);

  daemon.setPublished([]);
  await withCommandExecutorOverride(succeedingBackend, async () => {
    await daemon.b.close();
  });
  assert.deepEqual(vi.mocked(daemon.store.clear).mock.calls, [[{ kind: 'daemon' }]]);
});

test('a record update waits for the update in progress to finish', async () => {
  const daemon = createTwoSessionDaemon();
  const firstScanStarted = createGate();
  const firstScanReleased = createGate();
  mockProcessRecordScan.mockImplementationOnce(async () => {
    firstScanStarted.open();
    await firstScanReleased.passed;
    return { count: 0, pids: [], processes: [] };
  });
  const closeRan = createGate();
  const backend: CommandExecutorOverride = async (_command, args) => {
    if (managedAgentBrowserCliArgs(args)[0] === 'close') closeRan.open();
    return agentBrowserJsonResult({ success: true, data: {} });
  };

  await withCommandExecutorOverride(backend, async () => {
    const opening = daemon.b.open('about:blank');
    await firstScanStarted.passed;
    const closing = daemon.a.close();
    await closeRan.passed;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(mockProcessRecordScan.mock.calls.length, 1);
    firstScanReleased.open();
    await Promise.all([opening, closing]);
  });
  assert.equal(mockProcessRecordScan.mock.calls.length, 2);
});
