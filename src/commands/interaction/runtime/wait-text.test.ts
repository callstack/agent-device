import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { WAIT_REASONS } from '@agent-device/contracts/wait';
import type {
  AgentDeviceBackend,
  BackendCommandContext,
  BackendSnapshotResult,
} from '@agent-device/contracts/backend';
import { createLocalArtifactAdapter } from '../../../io.ts';
import { createAgentDevice } from '../../../runtime.ts';
import { localCommandPolicy } from '@agent-device/contracts/command-policy';
import { makeSnapshotState } from '@agent-device/selectors/snapshot-geometry-fixtures';
import {
  createFakeClock,
  createSelectorDevice,
  selectorReadSnapshot,
} from './__tests__/test-utils/index.ts';
import { createMemorySessionStore } from '../../../command-runtime/runtime-factory.ts';
import { abortWith } from './__tests__/test-utils/abort-with.ts';

function textWaitDevice(params: {
  captureSnapshot: NonNullable<AgentDeviceBackend['captureSnapshot']>;
  findText?: AgentDeviceBackend['findText'];
  readText?: AgentDeviceBackend['readText'];
  clock?: { now: () => number; sleep: (ms: number) => Promise<void> };
}) {
  return createAgentDevice({
    backend: {
      platform: 'ios',
      captureSnapshot: params.captureSnapshot,
      ...(params.findText ? { findText: params.findText } : {}),
      readText: params.readText ?? (async () => ({ text: '' })),
    } satisfies AgentDeviceBackend,
    artifacts: createLocalArtifactAdapter(),
    sessions: createMemorySessionStore([{ name: 'default' }]),
    policy: localCommandPolicy(),
    clock: params.clock ?? createFakeClock(),
  });
}

test('runtime wait resolves text from the polled snapshot', async () => {
  const captureSnapshot = vi.fn(async (): Promise<BackendSnapshotResult> => ({
    snapshot: selectorReadSnapshot(),
  }));
  const device = textWaitDevice({ captureSnapshot });

  const result = await device.selectors.wait({
    session: 'default',
    target: { kind: 'text', text: 'Continue', timeoutMs: 100 },
  });

  assert.deepEqual(result, { kind: 'text', text: 'Continue', waitedMs: 0 });
  assert.equal(captureSnapshot.mock.calls.length, 1);
});

test('runtime wait times out on text the polled snapshot does not carry', async () => {
  const device = createSelectorDevice(selectorReadSnapshot(), { clock: createFakeClock() });

  await assert.rejects(
    device.selectors.wait({
      session: 'default',
      target: { kind: 'text', text: 'Ready', timeoutMs: 100 },
    }),
    (error: AppError) => {
      assert.match(error.message, /wait timed out for text: Ready/);
      assert.equal(error.details?.reason, WAIT_REASONS.targetAbsent);
      assert.ok(Number(error.details?.readableCaptures) > 0);
      return true;
    },
  );
});

test('runtime wait falls back to a snapshot after a native text miss', async () => {
  const snapshot = selectorReadSnapshot();
  const captureContexts: BackendCommandContext[] = [];
  const findText = vi.fn(async (_context: BackendCommandContext, _text: string) => ({
    found: false,
  }));
  const captureSnapshot = vi.fn(
    async (context: BackendCommandContext): Promise<BackendSnapshotResult> => {
      captureContexts.push(context);
      return { snapshot };
    },
  );
  const device = textWaitDevice({ captureSnapshot, findText });

  const result = await device.selectors.wait({
    session: 'default',
    target: { kind: 'text', text: 'Continue', timeoutMs: 10_000 },
  });

  assert.equal(result.kind, 'text');
  if (result.kind === 'text') assert.equal(result.text, 'Continue');
  assert.equal(findText.mock.calls.length, 1);
  assert.equal(captureSnapshot.mock.calls.length, 1);
  assert.deepEqual(findText.mock.calls[0]?.[0], captureContexts[0]);
});

test('a text wait is satisfied by the owner native reading when the tree never carries it', async () => {
  let nativeReads = 0;
  const findText = vi.fn(async (_context: BackendCommandContext, text: string) => ({
    found: text === 'Last input: press' && ++nativeReads > 1,
  }));
  const captureSnapshot = vi.fn(async (): Promise<BackendSnapshotResult> => ({
    snapshot: makeSnapshotState([
      { index: 0, depth: 0, type: 'Button', label: 'Checkout', hittable: true },
    ]),
  }));
  const device = textWaitDevice({ captureSnapshot, findText });

  const result = await device.selectors.wait({
    session: 'default',
    target: { kind: 'text', text: 'Last input: press', timeoutMs: 2_000 },
  });

  assert.deepEqual(result.kind, 'text');
  assert.equal(findText.mock.calls.length, 2);
  assert.equal(captureSnapshot.mock.calls.length, 1);
  assert.equal(findText.mock.calls[0]?.[1], 'Last input: press');
  assert.equal(findText.mock.calls[1]?.[1], 'Last input: press');
});

test('runtime wait short-circuits capture when native text is found', async () => {
  const findText = vi.fn(async () => ({ found: true }));
  const captureSnapshot = vi.fn(async (): Promise<BackendSnapshotResult> => ({
    snapshot: makeSnapshotState([]),
  }));
  const device = textWaitDevice({ captureSnapshot, findText });

  const result = await device.selectors.wait({
    session: 'default',
    target: { kind: 'text', text: 'Ready', timeoutMs: 10_000 },
  });

  assert.equal(result.kind, 'text');
  assert.equal(findText.mock.calls.length, 1);
  assert.equal(captureSnapshot.mock.calls.length, 0);
});

test('runtime wait surfaces a canonical capture failure after a native text miss', async () => {
  const captureSnapshot = vi.fn(async (): Promise<BackendSnapshotResult> => {
    throw new AppError('COMMAND_FAILED', 'canonical capture failed', {
      reason: 'capture_failed',
    });
  });
  const findText = vi.fn(async () => ({ found: false }));
  const device = textWaitDevice({ captureSnapshot, findText });

  await assert.rejects(
    device.selectors.wait({
      session: 'default',
      target: { kind: 'text', text: 'Ready', timeoutMs: 10_000 },
    }),
    (error: AppError) =>
      error.message === 'canonical capture failed' && error.details?.reason === 'capture_failed',
  );

  assert.equal(findText.mock.calls.length, 1);
  assert.equal(captureSnapshot.mock.calls.length, 1);
});

test('a native text hit does not make an older captured tree fresh for the next read', async () => {
  const snapshots = [
    makeSnapshotState([{ index: 0, type: 'StaticText', label: 'Home' }]),
    makeSnapshotState([
      { index: 0, type: 'StaticText', label: 'Automation lab' },
      { index: 1, type: 'StaticText', label: 'cold.start' },
    ]),
  ];
  let attempts = 0;
  const findText = vi.fn(async () => {
    attempts += 1;
    return { found: attempts > 1 };
  });
  const captureSnapshot = vi.fn(async (): Promise<BackendSnapshotResult> => ({
    snapshot: snapshots.shift() ?? makeSnapshotState([]),
  }));
  const device = textWaitDevice({
    captureSnapshot,
    findText,
    readText: async () => ({ text: 'cold.start' }),
  });

  await device.selectors.wait({
    session: 'default',
    target: { kind: 'text', text: 'Automation lab', timeoutMs: 10_000 },
  });
  const result = await device.selectors.get({
    session: 'default',
    property: 'text',
    target: { kind: 'selector', selector: 'label="cold.start"' },
  });

  assert.equal(result.kind, 'text');
  assert.equal(result.text, 'cold.start');
  assert.equal(captureSnapshot.mock.calls.length, 2);
});

test('runtime wait passes its polling deadline signal to snapshot capture', async () => {
  let observedSignal: AbortSignal | undefined;
  const snapshot = makeSnapshotState([]);
  const capture = vi.fn(async (context: BackendCommandContext): Promise<BackendSnapshotResult> => {
    observedSignal = context.signal;
    const signal = context.signal;
    if (!signal) return { snapshot };
    return await new Promise((resolve) => {
      if (signal.aborted) {
        resolve({ snapshot });
        return;
      }
      signal.addEventListener('abort', () => resolve({ snapshot }), { once: true });
    });
  });
  const device = createAgentDevice({
    backend: {
      platform: 'ios',
      captureSnapshot: capture,
    } satisfies AgentDeviceBackend,
    artifacts: createLocalArtifactAdapter(),
    sessions: createMemorySessionStore([{ name: 'default', snapshot }]),
    policy: localCommandPolicy(),
  });

  await assert.rejects(
    device.selectors.wait({
      session: 'default',
      target: { kind: 'text', text: 'Never appears', timeoutMs: 10 },
    }),
    /timed out/i,
  );

  assert.equal(capture.mock.calls.length, 1);
  assert.equal(observedSignal?.aborted, true);
});

test('a positive wait whose steady-state capture is cancelled reports the deadline, not readiness', async () => {
  vi.useFakeTimers();
  try {
    let captures = 0;
    const captureSnapshot = vi.fn(
      async (context: BackendCommandContext): Promise<BackendSnapshotResult> => {
        captures += 1;
        if (captures === 1) {
          return {
            snapshot: makeSnapshotState([
              { index: 0, depth: 0, type: 'Button', label: 'Checkout', hittable: true },
            ]),
          };
        }
        return await abortWith(context.signal, new AppError('COMMAND_FAILED', 'capture cancelled'));
      },
    );
    const device = textWaitDevice({
      captureSnapshot,
      clock: { now: () => 0, sleep: async (_durationMs: number) => {} },
    });
    const pending = device.selectors.wait({
      session: 'default',
      target: { kind: 'text', text: 'Ready', timeoutMs: 20 },
    });
    const failure = assert.rejects(pending, (error: AppError) => {
      assert.equal(error.details?.reason, WAIT_REASONS.deadlineExceeded);
      assert.equal(error.details?.readableCaptures, 1);
      assert.equal(error.details?.readinessPhase, undefined);
      return true;
    });

    await vi.advanceTimersByTimeAsync(20);
    await failure;
    assert.equal(captureSnapshot.mock.calls.length, 2);
  } finally {
    vi.useRealTimers();
  }
});

test('a stalled capture reports capture-stalled with no readable captures', async () => {
  vi.useFakeTimers();
  try {
    const captureSnapshot = vi.fn(
      async (context: BackendCommandContext) =>
        await abortWith(context.signal, new AppError('COMMAND_FAILED', 'capture cancelled')),
    );
    const device = textWaitDevice({
      captureSnapshot,
      clock: { now: () => 0, sleep: async (_durationMs: number) => {} },
    });
    const pending = device.selectors.wait({
      session: 'default',
      target: { kind: 'text', text: 'Ready', timeoutMs: 20 },
    });
    const failure = assert.rejects(pending, (error: AppError) => {
      assert.equal(error.details?.reason, WAIT_REASONS.captureStalled);
      assert.equal(error.details?.captureStalled, true);
      assert.equal(error.details?.readableCaptures, 0);
      return true;
    });

    await vi.advanceTimersByTimeAsync(20);
    await failure;
    assert.equal(captureSnapshot.mock.calls.length, 1);
  } finally {
    vi.useRealTimers();
  }
});

/**
 * #2484 follow-up: the iOS runner refuses every command with a retriable `RUNNER_BUSY` while it
 * drains the abandoned main-thread work of a command that exceeded its execution watchdog. A
 * budgeted wait is a retry loop, so it must poll through that refusal rather than hand the caller
 * a failure the runner itself says will clear in a few seconds.
 */
test('runtime wait polls through a retriable capture refusal and resolves the text', async () => {
  const snapshot = selectorReadSnapshot();
  let attempts = 0;
  const device = createSelectorDevice(snapshot, {
    clock: createFakeClock(),
    captureSnapshot: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new AppError('COMMAND_FAILED', 'runner is still finishing a previous command', {
          runnerErrorCode: 'RUNNER_BUSY',
          retriable: true,
        });
      }
      return { snapshot };
    },
  });

  const result = await device.selectors.wait({
    session: 'default',
    target: { kind: 'text', text: 'Continue', timeoutMs: 10_000 },
  });

  assert.equal(result.kind, 'text');
  assert.equal(attempts, 2);
});
