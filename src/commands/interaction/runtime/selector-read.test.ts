import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { AgentDeviceBackend, BackendSnapshotOptions } from '../../../backend.ts';
import { createLocalArtifactAdapter } from '../../../io.ts';
import {
  createAgentDevice,
  createMemorySessionStore,
  localCommandPolicy,
  type CommandSessionStore,
} from '../../../runtime.ts';
import { ref, selector } from './selector-read-utils.ts';
import { makeSnapshotState } from '../../../__tests__/test-utils/snapshot-builders.ts';
import {
  createFakeClock,
  createSelectorDevice,
  selectorReadSnapshot,
} from './__tests__/test-utils/index.ts';
import { AppError } from '@agent-device/kernel/errors';

test('runtime get reads text from a selector target', async () => {
  const snapshot = selectorReadSnapshot();
  const device = createSelectorDevice(snapshot, {
    readText: 'Backend expanded text',
  });

  const result = await device.selectors.get({
    session: 'default',
    property: 'text',
    target: { kind: 'selector', selector: 'label=Continue' },
  });

  assert.equal(result.kind, 'text');
  assert.deepEqual(result.target, { kind: 'selector', selector: 'label=Continue' });
  assert.equal(result.text, 'Backend expanded text');
  assert.equal(result.node.label, 'Continue');
  assert.deepEqual(result.selectorChain, [
    'role="button" label="Continue"',
    'label="Continue"',
    'value="Continue"',
  ]);
});

test('runtime get selector target captures fresh snapshot without a stored session snapshot', async () => {
  const snapshot = selectorReadSnapshot();
  const sessions = createMemorySessionStore([{ name: 'default' }]);
  let captures = 0;
  const device = createAgentDevice({
    backend: {
      platform: 'ios',
      captureSnapshot: async () => {
        captures += 1;
        return { snapshot };
      },
      readText: async () => ({ text: 'Fresh text' }),
    } satisfies AgentDeviceBackend,
    artifacts: createLocalArtifactAdapter(),
    sessions,
    policy: localCommandPolicy(),
  });

  const result = await device.selectors.getText(selector('label=Continue'), {
    session: 'default',
  });

  assert.equal(result.kind, 'text');
  assert.equal(result.text, 'Fresh text');
  assert.equal(captures, 1);
  assert.equal((await sessions.get('default'))?.snapshot?.nodes[0]?.label, 'Continue');
});

test('runtime get returns attrs for a ref target without recapturing', async () => {
  const snapshot = selectorReadSnapshot();
  let captures = 0;
  const device = createSelectorDevice(snapshot, {
    captureSnapshot: () => {
      captures += 1;
      return { snapshot };
    },
  });

  const result = await device.selectors.get({
    session: 'default',
    property: 'attrs',
    target: { kind: 'ref', ref: '@e1' },
  });

  assert.equal(result.kind, 'attrs');
  assert.deepEqual(result.target, { kind: 'ref', ref: '@e1' });
  assert.equal(result.node.label, 'Continue');
  assert.equal(captures, 0);
});

test('runtime selectors pass runtime signal to backend snapshot capture', async () => {
  const snapshot = selectorReadSnapshot();
  const controller = new AbortController();
  let signal: AbortSignal | undefined;
  const device = createAgentDevice({
    backend: {
      platform: 'ios',
      captureSnapshot: async (context) => {
        signal = context.signal;
        return { snapshot };
      },
    } satisfies AgentDeviceBackend,
    artifacts: createLocalArtifactAdapter(),
    sessions: createMemorySessionStore([{ name: 'default', snapshot }]),
    policy: localCommandPolicy(),
    signal: controller.signal,
  });

  const result = await device.selectors.getAttrs(selector('label=Continue'), {
    session: 'default',
  });

  assert.equal(result.kind, 'attrs');
  assert.equal(signal, controller.signal);
});

test('runtime find get_text reads the matched node', async () => {
  const device = createSelectorDevice(selectorReadSnapshot(), {
    readText: 'Continue',
  });

  const result = await device.selectors.find({
    session: 'default',
    locator: 'text',
    query: 'Continue',
    action: 'get_text',
  });

  assert.equal(result.kind, 'text');
  assert.equal(result.ref, '@e1');
  assert.equal(result.text, 'Continue');
  assert.equal(result.node.label, 'Continue');
});

test('runtime find accepts selector expression queries', async () => {
  const device = createSelectorDevice(selectorReadSnapshot());

  const result = await device.selectors.find({
    session: 'default',
    query: 'label="Continue"',
    action: 'exists',
  });

  assert.deepEqual(result, { kind: 'found', found: true });
});

test('runtime web find text does not pass locator text as browser selector scope', async () => {
  const snapshot = selectorReadSnapshot();
  let captureOptions: BackendSnapshotOptions | undefined;
  const device = createAgentDevice({
    backend: {
      platform: 'web',
      captureSnapshot: async (_context, options) => {
        captureOptions = options;
        return { snapshot };
      },
    } satisfies AgentDeviceBackend,
    artifacts: createLocalArtifactAdapter(),
    sessions: createMemorySessionStore([{ name: 'default', snapshot }]),
    policy: localCommandPolicy(),
  });

  const result = await device.selectors.find({
    session: 'default',
    locator: 'text',
    query: 'Continue',
    action: 'exists',
  });

  assert.deepEqual(result, { kind: 'found', found: true });
  assert.equal(captureOptions?.scope, undefined);
});

test('runtime find wait reports sparse snapshot verdicts on the selector-read route', async () => {
  const initialSnapshot = selectorReadSnapshot();
  const session = { name: 'default', snapshot: initialSnapshot };
  const sessions = {
    get: () => session,
    set: (record) => {
      session.snapshot = record.snapshot ?? session.snapshot;
    },
  } satisfies CommandSessionStore;
  const sparseSnapshot = makeSnapshotState([
    {
      index: 0,
      type: 'Application',
    },
  ]);
  const device = createAgentDevice({
    backend: {
      platform: 'ios',
      captureSnapshot: async () => ({
        nodes: sparseSnapshot.nodes,
        backend: 'xctest',
        quality: {
          state: 'sparse',
          backend: 'private-ax',
          reason: 'sparse tree',
          reasonCode: 'sparse-tree',
        },
      }),
    } satisfies AgentDeviceBackend,
    artifacts: createLocalArtifactAdapter(),
    sessions,
    policy: localCommandPolicy(),
    clock: {
      now: () => 0,
      sleep: async () => {},
    },
  });

  await assert.rejects(
    () =>
      device.selectors.find({
        session: 'default',
        locator: 'text',
        query: 'Never appears',
        action: 'wait',
        timeoutMs: 100,
      }),
    (error: unknown) =>
      error instanceof Error &&
      error.message === 'find could not read the current accessibility tree' &&
      (error as { details?: { reason?: string } }).details?.reason === 'sparse tree',
  );
  assert.equal(session.snapshot, initialSnapshot);
});

test('runtime find wait skips hidden-content hint derivation on every poll (#1270)', async () => {
  // A `wait`'s presence check never consumes scroll hints, so every poll must ask the capture
  // layer to skip deriving them — otherwise a single pathological `dumpsys activity top` call
  // can eat the whole wait budget from inside this loop.
  const snapshot = selectorReadSnapshot();
  const captureOptionsCalls: Array<BackendSnapshotOptions | undefined> = [];
  let elapsed = 0;
  const device = createAgentDevice({
    backend: {
      platform: 'android',
      captureSnapshot: async (_context, options) => {
        captureOptionsCalls.push(options);
        return { snapshot };
      },
    } satisfies AgentDeviceBackend,
    artifacts: createLocalArtifactAdapter(),
    sessions: createMemorySessionStore([{ name: 'default', snapshot }]),
    policy: localCommandPolicy(),
    clock: {
      now: () => elapsed,
      sleep: async () => {
        elapsed += 300;
      },
    },
  });

  await assert.rejects(
    () =>
      device.selectors.find({
        session: 'default',
        locator: 'text',
        query: 'Never appears',
        action: 'wait',
        timeoutMs: 500,
      }),
    /find wait timed out/,
  );

  assert.equal(captureOptionsCalls.length >= 2, true);
  for (const options of captureOptionsCalls) {
    assert.equal(options?.includeHiddenContentHints, false);
  }
});

test('runtime find wait cancels and joins a capture that consumes its full deadline', async () => {
  const initial = selectorReadSnapshot();
  const sessions = createMemorySessionStore([{ name: 'default', snapshot: initial }]);
  let captureCount = 0;
  const device = createAgentDevice({
    backend: {
      platform: 'android',
      captureSnapshot: async (context) => {
        captureCount += 1;
        return await new Promise((resolve) => {
          context.signal?.addEventListener(
            'abort',
            () => {
              setTimeout(
                () =>
                  resolve({
                    snapshot: makeSnapshotState([
                      { index: 0, depth: 0, type: 'Other', label: 'Late screen' },
                    ]),
                  }),
                5,
              );
            },
            { once: true },
          );
        });
      },
    } satisfies AgentDeviceBackend,
    artifacts: createLocalArtifactAdapter(),
    sessions,
    policy: localCommandPolicy(),
  });

  await assert.rejects(
    device.selectors.find({
      session: 'default',
      locator: 'text',
      query: 'Never appears',
      action: 'wait',
      timeoutMs: 20,
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      const details = (error as { details?: Record<string, unknown> }).details;
      assert.equal(details?.reason, 'wait_capture_stalled');
      assert.equal(details?.captureStalled, true);
      return true;
    },
  );
  assert.equal(captureCount, 1);
  assert.deepEqual((await sessions.get('default'))?.snapshot, initial);
});

test('runtime selector convenience methods use explicit target helpers', async () => {
  const device = createSelectorDevice(selectorReadSnapshot(), {
    readText: 'Continue',
  });

  const text = await device.selectors.getText(selector('label=Continue'), { session: 'default' });
  const attrs = await device.selectors.getAttrs(ref('@e1'), { session: 'default' });
  const visible = await device.selectors.isVisible(selector('label=Continue'), {
    session: 'default',
  });
  const waited = await device.selectors.waitForText('Continue', {
    session: 'default',
    timeoutMs: 100,
  });

  assert.equal(text.kind, 'text');
  assert.equal(attrs.kind, 'attrs');
  assert.equal(visible.pass, true);
  assert.deepEqual(waited, { kind: 'text', text: 'Continue', waitedMs: 0 });
});

// ---------------------------------------------------------------------------
// Wait polls ride out captures that judged the screen unreadable (the
// mid-transition Android helper content verdicts) instead of aborting the
// wait — the live-validated destination-guard gap from #1349's PR review.
// (#1349's own in-loop landmark identity verification tests — the
// `target.recordedLandmark` cases — moved to `selector-wait.test.ts`, the
// 1:1 topology location for `selector-wait.ts`; #1478 P5 step 2 cell 7.)
// ---------------------------------------------------------------------------

function landmarkScreen(parentLabel: string) {
  return makeSnapshotState([
    { index: 0, depth: 0, type: 'Other', label: parentLabel },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'StaticText',
      label: 'Screen X',
      rect: { x: 0, y: 0, width: 100, height: 20 },
    },
  ]);
}

function unreadableCaptureError() {
  return new AppError(
    'COMMAND_FAILED',
    'Android snapshot helper returned insufficient foreground app content',
    {
      androidSnapshotHelperFailureReason: 'content-poor-app-window',
      retriable: true,
    },
  );
}

function waitDeviceWithCaptures(captures: Array<() => ReturnType<typeof landmarkScreen>>) {
  let call = 0;
  return createAgentDevice({
    backend: {
      platform: 'android',
      captureSnapshot: async () => {
        const produce = captures[Math.min(call, captures.length - 1)]!;
        call += 1;
        return { snapshot: produce() };
      },
    } satisfies AgentDeviceBackend,
    artifacts: createLocalArtifactAdapter(),
    sessions: createMemorySessionStore([{ name: 'default' }]),
    policy: localCommandPolicy(),
    clock: createFakeClock(),
  });
}

test('runtime wait rides out an unreadable mid-transition capture and succeeds on the next poll', async () => {
  const device = waitDeviceWithCaptures([
    () => {
      throw unreadableCaptureError();
    },
    () => landmarkScreen('Detail Screen'),
  ]);

  const result = await device.selectors.wait({
    session: 'default',
    target: { kind: 'selector', selector: 'label="Screen X"', timeoutMs: 5000 },
  });

  assert.equal(result.kind, 'selector');
  if (result.kind !== 'selector') throw new Error('unreachable');
  assert.equal(result.waitedMs >= 300, true);
});

test('runtime wait rethrows the capture verdict when the screen never became readable', async () => {
  const device = waitDeviceWithCaptures([
    () => {
      throw unreadableCaptureError();
    },
  ]);

  await assert.rejects(
    device.selectors.wait({
      session: 'default',
      target: { kind: 'selector', selector: 'label="Screen X"', timeoutMs: 1000 },
    }),
    /insufficient foreground app content/,
  );
});

test('runtime wait classifies readable no-match polls as target absent', async () => {
  const empty = () => makeSnapshotState([{ index: 0, depth: 0, type: 'Other', label: 'Loading' }]);
  const device = waitDeviceWithCaptures([
    empty,
    () => {
      throw unreadableCaptureError();
    },
  ]);

  await assert.rejects(
    device.selectors.wait({
      session: 'default',
      target: { kind: 'selector', selector: 'label="Screen X"', timeoutMs: 1000 },
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, 'wait timed out for selector: label="Screen X"');
      const details = (error as { details?: Record<string, unknown> }).details;
      assert.equal(details?.reason, 'wait_target_absent');
      assert.equal((details?.readableCaptures as number) > 0, true);
      return true;
    },
  );
});

test('runtime wait reports a stalled final capture after earlier unreadable verdicts', async () => {
  let captureCount = 0;
  const initial = makeSnapshotState([{ index: 0, depth: 0, type: 'Other', label: 'Initial' }]);
  const sessions = createMemorySessionStore([{ name: 'default', snapshot: initial }]);
  const device = createAgentDevice({
    backend: {
      platform: 'android',
      captureSnapshot: (context) => {
        captureCount += 1;
        if (captureCount === 1) throw unreadableCaptureError();
        return new Promise((resolve) => {
          context.signal?.addEventListener(
            'abort',
            () => {
              setTimeout(
                () =>
                  resolve({
                    snapshot: makeSnapshotState([
                      { index: 0, depth: 0, type: 'Other', label: 'Late capture' },
                    ]),
                  }),
                5,
              );
            },
            { once: true },
          );
        });
      },
    } satisfies AgentDeviceBackend,
    artifacts: createLocalArtifactAdapter(),
    sessions,
    policy: localCommandPolicy(),
    clock: createFakeClock(),
  });

  await assert.rejects(
    device.selectors.wait({
      session: 'default',
      target: { kind: 'selector', selector: 'label="Screen X"', timeoutMs: 400 },
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, 'wait timed out for selector: label="Screen X"');
      const details = (error as { details?: Record<string, unknown> }).details;
      assert.equal(details?.reason, 'wait_capture_stalled');
      assert.equal(details?.retriable, true);
      assert.equal(details?.readableCaptures, 0);
      assert.equal(typeof details?.waitedMs, 'number');
      return true;
    },
  );
  assert.deepEqual((await sessions.get('default'))?.snapshot, initial);
});

test('runtime wait does not call a deadline-truncated poll stalled after a readable capture', async () => {
  let captureCount = 0;
  const loading = makeSnapshotState([{ index: 0, depth: 0, type: 'Other', label: 'Loading' }]);
  const sessions = createMemorySessionStore([{ name: 'default' }]);
  const device = createAgentDevice({
    backend: {
      platform: 'android',
      captureSnapshot: async (context) => {
        captureCount += 1;
        if (captureCount === 1) return { snapshot: loading };
        return await new Promise((resolve) => {
          context.signal?.addEventListener(
            'abort',
            () => {
              setTimeout(() => resolve({ snapshot: loading }), 5);
            },
            { once: true },
          );
        });
      },
    } satisfies AgentDeviceBackend,
    artifacts: createLocalArtifactAdapter(),
    sessions,
    policy: localCommandPolicy(),
    clock: createFakeClock(),
  });

  await assert.rejects(
    device.selectors.wait({
      session: 'default',
      target: { kind: 'selector', selector: 'label="Screen X"', timeoutMs: 400 },
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, 'wait timed out for selector: label="Screen X"');
      const details = (error as { details?: Record<string, unknown> }).details;
      assert.equal(details?.reason, 'wait_deadline_exceeded');
      assert.equal(details?.captureTruncated, true);
      assert.equal(details?.captureStalled, undefined);
      return true;
    },
  );
  assert.equal(captureCount, 2);
  assert.deepEqual((await sessions.get('default'))?.snapshot, loading);
});

function failingWaitDevice(produceError: () => Error): {
  device: ReturnType<typeof createAgentDevice>;
  attempts: () => number;
} {
  let attempts = 0;
  const device = createAgentDevice({
    backend: {
      platform: 'android',
      captureSnapshot: async () => {
        attempts += 1;
        throw produceError();
      },
    } satisfies AgentDeviceBackend,
    artifacts: createLocalArtifactAdapter(),
    sessions: createMemorySessionStore([{ name: 'default' }]),
    policy: localCommandPolicy(),
    clock: createFakeClock(),
  });
  return { device, attempts: () => attempts };
}

test('runtime wait still fails immediately on a non-content capture failure', async () => {
  const { device, attempts } = failingWaitDevice(
    () => new AppError('COMMAND_FAILED', 'adb device offline'),
  );

  await assert.rejects(
    device.selectors.wait({
      session: 'default',
      target: { kind: 'selector', selector: 'label="Screen X"', timeoutMs: 5000 },
    }),
    /adb device offline/,
  );
  // Fail-FAST, not fail-at-deadline: a single capture attempt, no polling.
  assert.equal(attempts(), 1);
});

test('runtime wait fails immediately on a helper MECHANISM failure even though it carries androidSnapshotHelperFailureReason', async () => {
  // The realistic wrapper shape: androidSnapshotHelperCaptureError /
  // androidSnapshotHelperUnavailableError stamp the SAME details key as the
  // content verdicts, but with free-form mechanism reasons. Those must not be
  // polled until the wait deadline — the broad any-string classifier would
  // ride this to the deadline and rethrow the same error, so the attempt
  // count (not the eventual message) is what makes this regression bite.
  const { device, attempts } = failingWaitDevice(
    () =>
      new AppError(
        'COMMAND_FAILED',
        'Android snapshot helper failed: instrumentation run timed out after 120000ms',
        {
          androidSnapshotHelperFailureReason: 'instrumentation run timed out after 120000ms',
          hint: 'The device may be busy; retry once it settles.',
        },
      ),
  );

  await assert.rejects(
    device.selectors.wait({
      session: 'default',
      target: { kind: 'selector', selector: 'label="Screen X"', timeoutMs: 5000 },
    }),
    /instrumentation run timed out/,
  );
  assert.equal(attempts(), 1);
});
