import assert from 'node:assert/strict';
import { test } from 'vitest';
import type {
  AgentDeviceBackend,
  BackendSnapshotOptions,
  BackendSnapshotResult,
} from '../../../backend.ts';
import { createLocalArtifactAdapter } from '../../../io.ts';
import {
  createAgentDevice,
  createMemorySessionStore,
  localCommandPolicy,
  type CommandSessionStore,
} from '../../../runtime.ts';
import { ref, selector } from '../../index.ts';
import type { SnapshotState } from '../../../kernel/snapshot.ts';
import { makeSnapshotState } from '../../../__tests__/test-utils/index.ts';

test('runtime get reads text from a selector target', async () => {
  const snapshot = selectorSnapshot();
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
  const snapshot = selectorSnapshot();
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
  const snapshot = selectorSnapshot();
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
  const snapshot = selectorSnapshot();
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

test('runtime selectors forward public snapshot options to backend capture', async () => {
  const snapshot = selectorSnapshot();
  let captureOptions: BackendSnapshotOptions | undefined;
  const device = createAgentDevice({
    backend: {
      platform: 'ios',
      captureSnapshot: async (_context, options) => {
        captureOptions = options;
        return { snapshot };
      },
    } satisfies AgentDeviceBackend,
    artifacts: createLocalArtifactAdapter(),
    sessions: createMemorySessionStore([{ name: 'default', snapshot }]),
    policy: localCommandPolicy(),
  });

  await device.selectors.is({
    session: 'default',
    predicate: 'exists',
    selector: 'label=Continue',
    depth: 2,
    scope: 'Login',
    raw: true,
  });

  assert.deepEqual(captureOptions, {
    interactiveOnly: false,
    depth: 2,
    scope: 'Login',
    raw: true,
    includeRects: false,
  });
});

test('runtime visibility predicates request snapshot rects', async () => {
  const snapshot = selectorSnapshot();
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

  await device.selectors.isVisible(selector('label=Continue'), {
    session: 'default',
  });

  assert.equal(captureOptions?.includeRects, true);
});

test('runtime is validates selector predicates', async () => {
  const device = createSelectorDevice(selectorSnapshot());

  const result = await device.selectors.is({
    session: 'default',
    predicate: 'exists',
    selector: 'label=Continue',
  });

  assert.deepEqual(result, {
    predicate: 'exists',
    pass: true,
    selector: 'label=Continue',
    matches: 1,
    selectorChain: ['label=Continue'],
  });
});

test('runtime find get_text reads the matched node', async () => {
  const device = createSelectorDevice(selectorSnapshot(), {
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
  const device = createSelectorDevice(selectorSnapshot());

  const result = await device.selectors.find({
    session: 'default',
    query: 'label="Continue"',
    action: 'exists',
  });

  assert.deepEqual(result, { kind: 'found', found: true });
});

test('runtime web find text does not pass locator text as browser selector scope', async () => {
  const snapshot = selectorSnapshot();
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
  const initialSnapshot = selectorSnapshot();
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

test('runtime wait can use backend text search', async () => {
  const device = createSelectorDevice(selectorSnapshot(), {
    findText: true,
    now: 10,
  });

  const result = await device.selectors.wait({
    session: 'default',
    target: { kind: 'text', text: 'Ready', timeoutMs: 100 },
  });

  assert.deepEqual(result, { kind: 'text', text: 'Ready', waitedMs: 0 });
});

test('runtime selector convenience methods use explicit target helpers', async () => {
  const device = createSelectorDevice(selectorSnapshot(), {
    readText: 'Continue',
    findText: true,
  });

  const text = await device.selectors.getText(selector('label=Continue'), { session: 'default' });
  const attrs = await device.selectors.getAttrs(ref('@e1'), { session: 'default' });
  const visible = await device.selectors.isVisible(selector('label=Continue'), {
    session: 'default',
  });
  const waited = await device.selectors.waitForText('Ready', {
    session: 'default',
    timeoutMs: 100,
  });

  assert.equal(text.kind, 'text');
  assert.equal(attrs.kind, 'attrs');
  assert.equal(visible.pass, true);
  assert.deepEqual(waited, { kind: 'text', text: 'Ready', waitedMs: 0 });
});

test('runtime wait stable settles after two unchanged captures', async () => {
  const snapshot = selectorSnapshot();
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
  const snapshot = selectorSnapshot();
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
  const snapshot = selectorSnapshot();
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

function createFakeClock(stepMs = 300): {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
} {
  let elapsed = 0;
  return {
    now: () => elapsed,
    sleep: async (ms: number) => {
      elapsed += ms > 0 ? ms : stepMs;
    },
  };
}

function selectorSnapshot(): SnapshotState {
  return makeSnapshotState([
    {
      index: 0,
      depth: 0,
      type: 'Button',
      label: 'Continue',
      value: 'Continue',
      rect: { x: 10, y: 20, width: 100, height: 40 },
    },
  ]);
}

function createSelectorDevice(
  snapshot: SnapshotState,
  options: {
    readText?: string;
    findText?: boolean;
    now?: number;
    captureSnapshot?: () => BackendSnapshotResult | Promise<BackendSnapshotResult>;
  } = {},
) {
  const session = { name: 'default', snapshot };
  const sessions = {
    get: () => session,
    set: (record) => {
      session.snapshot = record.snapshot ?? session.snapshot;
    },
  } satisfies CommandSessionStore;
  return createAgentDevice({
    backend: {
      platform: 'ios',
      captureSnapshot: async () =>
        options.captureSnapshot ? await options.captureSnapshot() : { snapshot },
      readText: async () => ({ text: options.readText ?? '' }),
      findText: async () => ({ found: options.findText ?? false }),
    } satisfies AgentDeviceBackend,
    artifacts: createLocalArtifactAdapter(),
    sessions,
    policy: localCommandPolicy(),
    clock: {
      now: () => options.now ?? 0,
      sleep: async () => {},
    },
  });
}
