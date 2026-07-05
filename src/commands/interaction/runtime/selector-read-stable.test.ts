import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { AgentDeviceBackend, BackendSnapshotResult } from '../../../backend.ts';
import { createLocalArtifactAdapter } from '../../../io.ts';
import {
  createAgentDevice,
  createMemorySessionStore,
  localCommandPolicy,
} from '../../../runtime.ts';
import { makeSnapshotState } from '../../../__tests__/test-utils/index.ts';
import { createFakeClock, selectorReadSnapshot } from './__tests__/test-utils/index.ts';

test('runtime wait stable settles after two unchanged captures', async () => {
  const snapshot = selectorReadSnapshot();
  const clock = createFakeClock();
  let captures = 0;
  const device = createAgentDevice({
    backend: {
      platform: 'ios',
      captureSnapshot: async () => {
        captures += 1;
        return { snapshot };
      },
    } satisfies AgentDeviceBackend,
    artifacts: createLocalArtifactAdapter(),
    sessions: createMemorySessionStore([{ name: 'default', snapshot }]),
    policy: localCommandPolicy(),
    clock,
  });

  const result = await device.selectors.wait({
    session: 'default',
    target: { kind: 'stable', quietMs: 500, timeoutMs: 10_000 },
  });

  // Poll cadence is 300ms; a 500ms quiet window needs a 3rd identical capture to
  // accumulate enough elapsed time since the first (baseline) capture.
  assert.equal(result.kind, 'stable');
  if (result.kind === 'stable') {
    assert.equal(result.captures, 3);
    assert.equal(result.nodeCount, snapshot.nodes.length);
  }
  assert.equal(captures, 3);
});

test('runtime wait stable hints when it settles on a nearly-empty tree', async () => {
  const tinySnapshot = makeSnapshotState([
    {
      index: 0,
      depth: 0,
      type: 'Button',
      label: 'One',
      rect: { x: 0, y: 0, width: 10, height: 10 },
    },
    {
      index: 1,
      depth: 0,
      type: 'Button',
      label: 'Two',
      rect: { x: 0, y: 20, width: 10, height: 10 },
    },
    {
      index: 2,
      depth: 0,
      type: 'Button',
      label: 'Three',
      rect: { x: 0, y: 40, width: 10, height: 10 },
    },
  ]);
  const device = createAgentDevice({
    backend: {
      platform: 'ios',
      captureSnapshot: async () => ({ snapshot: tinySnapshot }),
    } satisfies AgentDeviceBackend,
    artifacts: createLocalArtifactAdapter(),
    sessions: createMemorySessionStore([{ name: 'default', snapshot: tinySnapshot }]),
    policy: localCommandPolicy(),
    clock: createFakeClock(),
  });

  const result = await device.selectors.wait({
    session: 'default',
    target: { kind: 'stable', quietMs: 500, timeoutMs: 10_000 },
  });

  assert.equal(result.kind, 'stable');
  if (result.kind === 'stable') {
    assert.equal(result.nodeCount, 3);
    assert.equal(
      result.hint,
      'Settled on a nearly-empty tree — the app may still be loading. Wait for specific content (wait text ...) before interacting.',
    );
  }
});

test('runtime wait stable omits the loading hint for a normal-sized tree', async () => {
  const normalSnapshot = makeSnapshotState(
    Array.from({ length: 6 }, (_, index) => ({
      index,
      depth: 0,
      type: 'Button',
      label: `Item ${index}`,
      rect: { x: 0, y: index * 20, width: 10, height: 10 },
    })),
  );
  const device = createAgentDevice({
    backend: {
      platform: 'ios',
      captureSnapshot: async () => ({ snapshot: normalSnapshot }),
    } satisfies AgentDeviceBackend,
    artifacts: createLocalArtifactAdapter(),
    sessions: createMemorySessionStore([{ name: 'default', snapshot: normalSnapshot }]),
    policy: localCommandPolicy(),
    clock: createFakeClock(),
  });

  const result = await device.selectors.wait({
    session: 'default',
    target: { kind: 'stable', quietMs: 500, timeoutMs: 10_000 },
  });

  assert.equal(result.kind, 'stable');
  if (result.kind === 'stable') {
    assert.equal(result.nodeCount, 6);
    assert.equal('hint' in result, false);
  }
});

test('runtime wait stable requires quiet captures after instability before settling', async () => {
  const snapshot = selectorReadSnapshot();
  const changedSnapshot = makeSnapshotState([
    {
      index: 0,
      depth: 0,
      type: 'Button',
      label: 'Loading',
      rect: { x: 0, y: 0, width: 1, height: 1 },
    },
  ]);
  const clock = createFakeClock();
  let captures = 0;
  const device = createAgentDevice({
    backend: {
      platform: 'ios',
      captureSnapshot: async () => {
        captures += 1;
        // First capture unstable/changed relative to the initial nothing-seen-yet state,
        // second capture changes again (still unstable), then two identical captures settle.
        if (captures <= 2) return { snapshot: captures === 1 ? snapshot : changedSnapshot };
        return { snapshot: changedSnapshot };
      },
    } satisfies AgentDeviceBackend,
    artifacts: createLocalArtifactAdapter(),
    sessions: createMemorySessionStore([{ name: 'default', snapshot }]),
    policy: localCommandPolicy(),
    clock,
  });

  const result = await device.selectors.wait({
    session: 'default',
    target: { kind: 'stable', quietMs: 500, timeoutMs: 10_000 },
  });

  assert.equal(result.kind, 'stable');
  // capture 1: baseline; capture 2: changed (reset quiet window); capture 3+4: unchanged -> settle.
  assert.equal(captures, 4);
});

test('runtime wait stable times out with capture stats when never settling', async () => {
  const clock = createFakeClock();
  let captures = 0;
  const device = createAgentDevice({
    backend: {
      platform: 'ios',
      captureSnapshot: async () => {
        captures += 1;
        return {
          snapshot: makeSnapshotState([
            {
              index: 0,
              depth: 0,
              type: 'Button',
              label: `Item ${captures}`,
              rect: { x: 0, y: 0, width: 1, height: 1 },
            },
          ]),
        };
      },
    } satisfies AgentDeviceBackend,
    artifacts: createLocalArtifactAdapter(),
    sessions: createMemorySessionStore([{ name: 'default' }]),
    policy: localCommandPolicy(),
    clock,
  });

  await assert.rejects(
    () =>
      device.selectors.wait({
        session: 'default',
        target: { kind: 'stable', quietMs: 500, timeoutMs: 1_000 },
      }),
    (error: unknown) =>
      error instanceof Error &&
      error.message === 'wait timed out waiting for a stable UI' &&
      (error as { details?: { reason?: string; captures?: number } }).details?.reason ===
        'wait_stable_timeout' &&
      typeof (error as { details?: { captures?: number } }).details?.captures === 'number',
  );
  assert.ok(captures > 1);
});

test('runtime wait stable times out when a backend capture stalls past the wait budget', async () => {
  const clock = createFakeClock();
  const device = createAgentDevice({
    backend: {
      platform: 'macos',
      // Simulates the stalled macOS AX capture: the promise never settles, so
      // only the real-timer deadline can end the wait.
      captureSnapshot: () => new Promise<BackendSnapshotResult>(() => {}),
    } satisfies AgentDeviceBackend,
    artifacts: createLocalArtifactAdapter(),
    sessions: createMemorySessionStore([{ name: 'default' }]),
    policy: localCommandPolicy(),
    clock,
  });

  await assert.rejects(
    () =>
      device.selectors.wait({
        session: 'default',
        target: { kind: 'stable', quietMs: 100, timeoutMs: 250 },
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, 'wait timed out waiting for a stable UI');
      const details = (error as { details?: Record<string, unknown> }).details;
      assert.equal(details?.reason, 'wait_stable_timeout');
      assert.equal(details?.captureStalled, true);
      assert.equal(details?.captures, 0);
      return true;
    },
  );
});

test('runtime wait stable uses provided defaults when quietMs/timeoutMs are omitted', async () => {
  const snapshot = selectorReadSnapshot();
  const clock = createFakeClock();
  let captures = 0;
  const device = createAgentDevice({
    backend: {
      platform: 'ios',
      captureSnapshot: async () => {
        captures += 1;
        return { snapshot };
      },
    } satisfies AgentDeviceBackend,
    artifacts: createLocalArtifactAdapter(),
    sessions: createMemorySessionStore([{ name: 'default', snapshot }]),
    policy: localCommandPolicy(),
    clock,
  });

  const result = await device.selectors.wait({
    session: 'default',
    target: { kind: 'stable' },
  });

  assert.equal(result.kind, 'stable');
  assert.equal(captures, 3);
});
