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

// A clock whose sleep lands `undershootMs` short of what was asked, modelling
// the real defect: `setTimeout(n)` can advance `Date.now()` by only n-1,
// because libuv times the sleep on the monotonic loop clock while `now()` reads
// the wall clock. It yields to the event loop like a real sleep does, so a loop
// that fails to terminate fails the test on its timeout rather than starving
// the runner on microtasks.
function createUndershootingClock(undershootMs = 1): {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
} {
  let elapsed = 0;
  return {
    now: () => elapsed,
    sleep: async (ms: number) => {
      elapsed += Math.max(0, ms - undershootMs);
      await new Promise((resolve) => {
        setImmediate(resolve);
      });
    },
  };
}

function createStableCaptureDevice(clock: {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}) {
  const snapshot = selectorReadSnapshot();
  const counter = { captures: 0 };
  const device = createAgentDevice({
    backend: {
      platform: 'ios',
      captureSnapshot: async () => {
        counter.captures += 1;
        return { snapshot };
      },
    } satisfies AgentDeviceBackend,
    artifacts: createLocalArtifactAdapter(),
    sessions: createMemorySessionStore([{ name: 'default', snapshot }]),
    policy: localCommandPolicy(),
    clock,
  });
  return { device, counter };
}

test('runtime wait stable settles at the second capture even when the sleep undershoots', async () => {
  // A 300ms quiet window equals the poll cadence, so the second capture is the
  // one that decides `settled` — and a sleep that lands 1ms short must not
  // change the verdict (#1306).
  const { device, counter } = createStableCaptureDevice(createUndershootingClock());

  const result = await device.selectors.wait({
    session: 'default',
    target: { kind: 'stable', quietMs: 300, timeoutMs: 10_000 },
  });

  assert.equal(result.kind, 'stable');
  if (result.kind === 'stable') assert.equal(result.captures, 2);
  assert.equal(counter.captures, 2);
});

test('runtime wait stable still takes its settling capture when the budget barely clears the window', async () => {
  // One millisecond of budget past the quiet window is enough to settle, and
  // the deadline-aware sleep must not spend it on the epsilon: overshooting the
  // deadline would drop the settling capture the plain cadence would have taken.
  const { device, counter } = createStableCaptureDevice(createFakeClock());

  const result = await device.selectors.wait({
    session: 'default',
    target: { kind: 'stable', quietMs: 300, timeoutMs: 301 },
  });

  assert.equal(result.kind, 'stable');
  if (result.kind === 'stable') {
    assert.equal(result.captures, 2);
    assert.ok(
      result.waitedMs <= 301,
      `waitedMs must stay within the budget, got ${result.waitedMs}`,
    );
  }
  assert.equal(counter.captures, 2);
});

test('runtime wait stable cannot settle when the budget only reaches the quiet deadline', async () => {
  // The other side of the boundary: the window has to ELAPSE inside the budget,
  // so a budget equal to it leaves no instant where two captures span it. The
  // deadline-aware sleep must neither manufacture a settle here nor run past
  // the budget once no further capture can land inside it.
  const clock = createFakeClock();
  const { device } = createStableCaptureDevice(clock);

  await assert.rejects(
    () =>
      device.selectors.wait({
        session: 'default',
        target: { kind: 'stable', quietMs: 300, timeoutMs: 300 },
      }),
    (error: unknown) =>
      error instanceof Error &&
      (error as { details?: { reason?: string } }).details?.reason === 'wait_stable_timeout',
  );
  assert.ok(clock.now() <= 300, `loop must not run past its budget, elapsed ${clock.now()}ms`);
});

test('runtime wait stable uses the final budget without spinning when sleep undershoots', async () => {
  // The two hazards combined: a budget that leaves a 1ms landing window, and a
  // sleep that loses 1ms to skew. Asking for that 1ms buys no time, so a loop
  // that trusts the sleep to carry it past the deadline never gets there and
  // hammers the device with captures instead. Spending the full 2ms advances
  // this clock to 300ms and earns the valid settling capture; an exact clock
  // would land on the 301ms deadline and exit without another capture.
  const clock = createUndershootingClock();
  const { device, counter } = createStableCaptureDevice(clock);

  const result = await device.selectors.wait({
    session: 'default',
    target: { kind: 'stable', quietMs: 300, timeoutMs: 301 },
  });

  assert.equal(result.kind, 'stable');
  if (result.kind === 'stable') {
    assert.equal(result.captures, 3);
    assert.ok(result.waitedMs <= 301, `waitedMs must stay within budget, got ${result.waitedMs}`);
  }
  assert.equal(counter.captures, 3, `loop must not spin, took ${counter.captures} captures`);
  assert.ok(clock.now() <= 301, `loop must not run past its budget, elapsed ${clock.now()}ms`);
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
