import { bindTestCommandHost } from '@agent-device/test-kit';
// agent-browser-provider's owned-process record gate: which agent-browser calls pay the
// process-table scan that rewrites the managed fleet record. The scan exists so the startup
// reaper and the leak oracle can see the fleet; re-deriving it after every command does not make
// the fleet safer, it only makes every web command slower.
import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';
import { withCommandExecutorOverride } from '@agent-device/host-kit/command';
import { AppError } from '@agent-device/kernel/errors';
import {
  agentBrowserJsonResult,
  ownedProcessRecordStore,
  recordingAgentBrowserExecutor,
  withManagedAgentBrowserProvider,
} from './test-utils.ts';

bindTestCommandHost();

const { processRecordScanMock, fleetRecordLiveMock } = vi.hoisted(() => ({
  processRecordScanMock: vi.fn(async () => ({ count: 0, pids: [], processes: [] })),
  fleetRecordLiveMock: vi.fn(async () => false),
}));

vi.mock('../agent-browser-process-record.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../agent-browser-process-record.ts')>();
  return {
    ...actual,
    recordManagedAgentBrowserProcesses: processRecordScanMock,
    managedWebBrowserProcessRecordIsLive: fleetRecordLiveMock,
  };
});

const mockProcessRecordScan = vi.mocked(processRecordScanMock);
const mockFleetRecordLive = vi.mocked(fleetRecordLiveMock);

/** What the provider appends to every CLI call, after the command itself. */
const CLI_TAIL = ['--json', '--session', 'web-session'];

/** A session with a fleet record to consult, which is what makes the gate decide at all. */
function providerOptions() {
  return {
    session: 'web-session',
    openWebSessionNames: () => ['web-session'],
    ownedProcessRecords: ownedProcessRecordStore(),
  };
}

beforeEach(() => {
  mockProcessRecordScan.mockReset();
  mockProcessRecordScan.mockResolvedValue({ count: 0, pids: [], processes: [] });
  mockFleetRecordLive.mockReset();
  mockFleetRecordLive.mockResolvedValue(false);
});

test('a plain successful command with a record the probe vouches for does not scan the fleet', async () => {
  mockFleetRecordLive.mockResolvedValue(true);
  const ownedProcessRecords = ownedProcessRecordStore();
  const executor = recordingAgentBrowserExecutor();
  await withManagedAgentBrowserProvider(
    { ...providerOptions(), ownedProcessRecords },
    async (provider) => {
      await withCommandExecutorOverride(executor.override, async () => {
        await provider.snapshot();
        await provider.screenshot('/tmp/page.png');
        await provider.clickRef?.('@e3');
      });
    },
  );
  assert.equal(mockProcessRecordScan.mock.calls.length, 0);
  assert.equal(mockFleetRecordLive.mock.calls.length, 3);
  assert.equal(vi.mocked(ownedProcessRecords.clear).mock.calls.length, 0);
});

test('the command that cannot vouch for the fleet record re-derives it', async () => {
  mockFleetRecordLive.mockResolvedValue(false);
  const executor = recordingAgentBrowserExecutor();
  await withManagedAgentBrowserProvider(providerOptions(), async (provider) => {
    await withCommandExecutorOverride(executor.override, async () => {
      await provider.snapshot();
    });
  });
  assert.equal(mockProcessRecordScan.mock.calls.length, 1);
});

test('open re-derives the fleet record without consulting the probe', async () => {
  mockFleetRecordLive.mockResolvedValue(true);
  const executor = recordingAgentBrowserExecutor();
  await withManagedAgentBrowserProvider(providerOptions(), async (provider) => {
    await withCommandExecutorOverride(executor.override, async () => {
      await provider.open('https://example.test');
    });
  });
  assert.equal(mockProcessRecordScan.mock.calls.length, 1);
  assert.equal(mockFleetRecordLive.mock.calls.length, 0);
});

test('recording re-derives the fleet record without consulting the probe', async () => {
  // The pinned CLI's `record start` mints an ffmpeg child of the agent-browser daemon, outside Chrome's
  // tree. The probe vouches for recorded pids only, so a scan is the only path that can own it.
  mockFleetRecordLive.mockResolvedValue(true);
  const executor = recordingAgentBrowserExecutor();
  await withManagedAgentBrowserProvider(providerOptions(), async (provider) => {
    await withCommandExecutorOverride(executor.override, async () => {
      await provider.startRecording?.('/tmp/clip.webm');
    });
  });
  assert.equal(mockProcessRecordScan.mock.calls.length, 1);
  assert.equal(mockFleetRecordLive.mock.calls.length, 0);
  assert.deepEqual(executor.commands()[0], ['record', 'start', '/tmp/clip.webm', ...CLI_TAIL]);
});

test('stopping a recording re-derives the fleet record without consulting the probe', async () => {
  mockFleetRecordLive.mockResolvedValue(true);
  const executor = recordingAgentBrowserExecutor();
  await withManagedAgentBrowserProvider(providerOptions(), async (provider) => {
    await withCommandExecutorOverride(executor.override, async () => {
      await provider.stopRecording?.();
    });
  });
  assert.equal(mockProcessRecordScan.mock.calls.length, 1);
  assert.equal(mockFleetRecordLive.mock.calls.length, 0);
  assert.deepEqual(executor.commands()[0], ['record', 'stop', ...CLI_TAIL]);
});

test('a command the backend answers with a failure re-derives the fleet record', async () => {
  mockFleetRecordLive.mockResolvedValue(true);
  await withManagedAgentBrowserProvider(providerOptions(), async (provider) => {
    await withCommandExecutorOverride(
      async () => agentBrowserJsonResult({ success: false, error: 'browser died mid-click' }, 1),
      async () => {
        await assert.rejects(async () => await provider.clickRef?.('@e3'));
      },
    );
  });
  assert.equal(mockProcessRecordScan.mock.calls.length, 1);
  assert.equal(mockFleetRecordLive.mock.calls.length, 0);
});

test('a command that never reached the backend re-derives the fleet record', async () => {
  mockFleetRecordLive.mockResolvedValue(false);
  await withManagedAgentBrowserProvider(providerOptions(), async (provider) => {
    await withCommandExecutorOverride(
      async () => {
        throw new AppError('TOOL_MISSING', 'Managed web browser backend is not installed.');
      },
      async () => {
        await assert.rejects(async () => await provider.snapshot());
      },
    );
  });
  assert.equal(mockProcessRecordScan.mock.calls.length, 1);
});

test('close with another web session still open refreshes the record instead of clearing it', async () => {
  mockFleetRecordLive.mockResolvedValue(true);
  const ownedProcessRecords = ownedProcessRecordStore();
  const executor = recordingAgentBrowserExecutor();
  await withManagedAgentBrowserProvider(
    {
      ...providerOptions(),
      openWebSessionNames: () => ['web-session', 'other-session'],
      ownedProcessRecords,
    },
    async (provider) => {
      await withCommandExecutorOverride(executor.override, async () => {
        await provider.close();
      });
    },
  );
  assert.equal(vi.mocked(ownedProcessRecords.clear).mock.calls.length, 0);
  assert.equal(mockProcessRecordScan.mock.calls.length, 1);
});

test('close with no other web session clears the fleet record without scanning the fleet', async () => {
  const ownedProcessRecords = ownedProcessRecordStore();
  const executor = recordingAgentBrowserExecutor();
  await withManagedAgentBrowserProvider(
    { ...providerOptions(), ownedProcessRecords },
    async (provider) => {
      await withCommandExecutorOverride(executor.override, async () => {
        await provider.close();
      });
    },
  );
  assert.deepEqual(vi.mocked(ownedProcessRecords.clear).mock.calls, [[{ kind: 'daemon' }]]);
  assert.equal(mockProcessRecordScan.mock.calls.length, 0);
  assert.equal(mockFleetRecordLive.mock.calls.length, 0);
});

test('a close that failed does not clear the fleet record another session may still need', async () => {
  const ownedProcessRecords = ownedProcessRecordStore();
  await withManagedAgentBrowserProvider(
    { ...providerOptions(), ownedProcessRecords },
    async (provider) => {
      await withCommandExecutorOverride(
        async () => {
          throw new Error('close failed before execution');
        },
        async () => {
          await assert.rejects(async () => await provider.close());
        },
      );
    },
  );
  assert.equal(vi.mocked(ownedProcessRecords.clear).mock.calls.length, 0);
});

test('a close the backend refused does not clear the fleet record', async () => {
  const ownedProcessRecords = ownedProcessRecordStore();
  await withManagedAgentBrowserProvider(
    { ...providerOptions(), ownedProcessRecords },
    async (provider) => {
      await withCommandExecutorOverride(
        async () =>
          agentBrowserJsonResult({
            success: false,
            code: 'CLOSE_FAILED',
            error: 'browser stayed open',
          }),
        async () => {
          await assert.rejects(async () => await provider.close());
        },
      );
    },
  );
  assert.equal(vi.mocked(ownedProcessRecords.clear).mock.calls.length, 0);
});

test('a provider with no record store neither scans nor probes', async () => {
  const executor = recordingAgentBrowserExecutor();
  await withManagedAgentBrowserProvider({ session: 'web-session' }, async (provider) => {
    await withCommandExecutorOverride(executor.override, async () => {
      await provider.snapshot();
    });
  });
  assert.equal(mockProcessRecordScan.mock.calls.length, 0);
  assert.equal(mockFleetRecordLive.mock.calls.length, 0);
});
