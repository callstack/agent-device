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
import type { SnapshotState } from '../../../utils/snapshot.ts';
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
