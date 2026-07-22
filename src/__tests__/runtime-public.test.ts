import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import {
  createAgentDevice,
  createMemorySessionStore,
  localCommandPolicy,
  restrictedCommandPolicy,
  type AgentDevice,
  type CommandSessionStore,
} from '../runtime.ts';
import type { AgentDeviceBackend } from '../backend.ts';
import { commands, type ScreenshotCommandOptions } from '../commands/index.ts';
import {
  createLocalArtifactAdapter,
  type ArtifactAdapter,
  type FileInputRef,
  type FileOutputRef,
} from '../io.ts';

const backend = {
  platform: 'ios',
  captureScreenshot: async () => {},
  typeText: async () => {},
  openApp: async () => {},
  closeApp: async () => {},
  listApps: async () => [{ id: 'com.example.app', name: 'Example', bundleId: 'com.example.app' }],
  getAppState: async (_context, app: string) => ({ bundleId: app, state: 'foreground' as const }),
  pushFile: async () => {},
  triggerAppEvent: async () => {},
  pressHome: async () => {},
  readLogs: async () => ({ entries: [{ message: 'ready' }] }),
  dumpNetwork: async () => ({ entries: [{ method: 'GET', url: 'https://example.test' }] }),
  measurePerf: async () => ({ metrics: [{ name: 'cpu', value: 1, unit: '%' }] }),
} satisfies AgentDeviceBackend;

const artifacts = {
  resolveInput: async (ref: FileInputRef) => ({
    path: ref.kind === 'path' ? ref.path : `/tmp/upload-${ref.id}`,
  }),
  reserveOutput: async (ref: FileOutputRef | undefined, options) => ({
    path: ref?.kind === 'path' ? ref.path : `/tmp/${options.field}${options.ext}`,
    visibility: options.visibility ?? 'client-visible',
    publish: async () => undefined,
  }),
  createTempFile: async (options) => ({
    path: `/tmp/${options.prefix}${options.ext}`,
    visibility: 'internal',
    cleanup: async () => {},
  }),
} satisfies ArtifactAdapter;

const sessions = {
  get: () => undefined,
  set: () => {},
} satisfies CommandSessionStore;

test('internal command runtime skeleton is available', async () => {
  const device: AgentDevice = createAgentDevice({
    backend,
    artifacts,
  });

  assert.equal(device.backend.platform, 'ios');
  assert.equal(device.policy.allowLocalInputPaths, false);
  assert.equal(typeof device.capture.screenshot, 'function');
  assert.equal(typeof device.interactions.click, 'function');
  assert.equal(typeof device.system.back, 'function');
  assert.equal(typeof device.apps.open, 'function');
  assert.equal(typeof device.admin.install, 'function');
  assert.equal(typeof device.recording.record, 'function');
  assert.equal(typeof device.observability.logs, 'function');
  const result = await device.capture.screenshot({});
  assert.equal(result.path, '/tmp/path.png');
});

test('runtime screenshot command cleans reserved output when publish fails', async () => {
  let cleanupCalled = false;
  const device = createAgentDevice({
    backend,
    artifacts: {
      ...artifacts,
      reserveOutput: async (ref: FileOutputRef | undefined, options) => ({
        path: ref?.kind === 'path' ? ref.path : `/tmp/${options.field}${options.ext}`,
        visibility: options.visibility ?? 'client-visible',
        publish: async () => {
          throw new Error('publish failed');
        },
        cleanup: async () => {
          cleanupCalled = true;
        },
      }),
    },
    sessions,
    policy: localCommandPolicy(),
  });

  await assert.rejects(
    () => device.capture.screenshot({ out: { kind: 'path', path: '/tmp/screen.png' } }),
    /publish failed/,
  );

  assert.equal(cleanupCalled, true);
});

test('runtime policy helpers expose local and restricted defaults', async () => {
  assert.equal(typeof createLocalArtifactAdapter, 'function');
  assert.equal(localCommandPolicy().allowLocalInputPaths, true);
  assert.equal(localCommandPolicy().allowLocalOutputPaths, true);
  assert.equal(restrictedCommandPolicy().allowLocalInputPaths, false);
  assert.equal(restrictedCommandPolicy({ allowLocalInputPaths: true }).allowLocalInputPaths, true);
  const store = createMemorySessionStore([{ name: 'default' }]);
  assert.equal((await store.get('default'))?.name, 'default');
});

test('local artifact adapter marks command outputs and temp files by visibility', async () => {
  const adapter = createLocalArtifactAdapter();
  const output = await adapter.reserveOutput(undefined, {
    field: 'path',
    ext: '.png',
    artifactType: 'screenshot',
    visibility: 'client-visible',
  });
  const temp = await adapter.createTempFile({
    prefix: 'agent-device-test',
    ext: '.txt',
  });

  assert.equal(output.visibility, 'client-visible');
  assert.equal(temp.visibility, 'internal');

  await output.cleanup?.();
  await temp.cleanup();
});

test('local artifact adapter can constrain explicit local paths to a root', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-local-root-'));
  try {
    const adapter = createLocalArtifactAdapter({ cwd: root, rootDir: root });

    assert.deepEqual(
      await adapter.resolveInput({ kind: 'path', path: 'input.png' }, { usage: 'test' }),
      {
        path: path.join(root, 'input.png'),
      },
    );
    await assert.rejects(
      () => adapter.resolveInput({ kind: 'path', path: '../outside.png' }, { usage: 'test' }),
      /outside the artifact adapter root/,
    );
    await assert.rejects(
      () =>
        adapter.reserveOutput(
          { kind: 'path', path: path.join(path.dirname(root), 'outside.png') },
          { field: 'path', ext: '.png', artifactType: 'screenshot' },
        ),
      /outside the artifact adapter root/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('memory session store does not expose mutable record references', async () => {
  const store = createMemorySessionStore([
    {
      name: 'default',
      appName: 'Demo',
      snapshot: {
        nodes: [{ ref: 'e1', index: 0, depth: 0, label: 'Initial' }],
        createdAt: 1,
      },
    },
  ]);
  const record = await store.get('default');
  assert.equal(record?.appName, 'Demo');

  if (record) {
    record.appName = 'Mutated';
    if (record.snapshot) record.snapshot.nodes[0]!.label = 'Mutated';
  }

  assert.equal((await store.get('default'))?.appName, 'Demo');
  assert.equal((await store.get('default'))?.snapshot?.nodes[0]?.label, 'Initial');

  const next = {
    name: 'default',
    snapshot: {
      nodes: [{ ref: 'e1', index: 0, depth: 0, label: 'Stored' }],
      createdAt: 2,
    },
  };
  await store.set(next);
  next.snapshot.nodes[0]!.label = 'Mutated after set';

  assert.equal((await store.get('default'))?.snapshot?.nodes[0]?.label, 'Stored');
  const list = await store.list?.();
  if (list?.[0]?.snapshot) list[0].snapshot.nodes[0]!.label = 'Mutated from list';
  assert.equal((await store.get('default'))?.snapshot?.nodes[0]?.label, 'Stored');
});

test('runtime commands work with async command session stores', async () => {
  const records = new Map<string, Awaited<ReturnType<CommandSessionStore['get']>>>();
  records.set('default', { name: 'default' });
  const asyncStore = {
    get: async (name) => records.get(name),
    set: async (record) => {
      records.set(record.name, record);
    },
  } satisfies CommandSessionStore;
  const device = createAgentDevice({
    backend: {
      platform: 'ios',
      captureSnapshot: async () => ({
        snapshot: {
          nodes: [{ ref: 'e1', index: 0, depth: 0, label: 'Ready' }],
          createdAt: 1,
        },
      }),
    },
    artifacts,
    sessions: asyncStore,
    policy: localCommandPolicy(),
  });

  const result = await device.capture.snapshot({ session: 'default' });

  assert.equal(result.nodes[0]?.label, 'Ready');
  assert.equal(records.get('default')?.snapshot?.nodes[0]?.label, 'Ready');
});

test('internal backend, commands, and io modules are usable', () => {
  const options = {
    out: { kind: 'path', path: '/tmp/screen.png' },
  } satisfies ScreenshotCommandOptions;
  assert.equal(options.out.kind, 'path');
  assert.equal(typeof commands.capture.screenshot, 'function');
  assert.equal(typeof commands.capture.diffScreenshot, 'function');
  assert.equal(typeof commands.capture.snapshot, 'function');
  assert.equal(typeof commands.capture.diffSnapshot, 'function');
  assert.equal(typeof commands.selectors.find, 'function');
  assert.equal(typeof commands.selectors.get, 'function');
  assert.equal(typeof commands.selectors.getText, 'function');
  assert.equal(typeof commands.selectors.is, 'function');
  assert.equal(typeof commands.selectors.isVisible, 'function');
  assert.equal(typeof commands.selectors.wait, 'function');
  assert.equal(typeof commands.selectors.waitForText, 'function');
  assert.equal(typeof commands.interactions.click, 'function');
  assert.equal(typeof commands.interactions.press, 'function');
  assert.equal(typeof commands.interactions.fill, 'function');
  assert.equal(typeof commands.interactions.typeText, 'function');
  assert.equal(typeof commands.interactions.focus, 'function');
  assert.equal(typeof commands.interactions.longPress, 'function');
  assert.equal(typeof commands.interactions.scroll, 'function');
  assert.equal(typeof commands.interactions.gesture, 'function');
  assert.equal(typeof commands.system.back, 'function');
  assert.equal(typeof commands.system.home, 'function');
  assert.equal(typeof commands.system.orientation, 'function');
  assert.equal(typeof commands.system.keyboard, 'function');
  assert.equal(typeof commands.system.clipboard, 'function');
  assert.equal(typeof commands.system.settings, 'function');
  assert.equal(typeof commands.system.alert, 'function');
  assert.equal(typeof commands.system.appSwitcher, 'function');
  assert.equal(typeof commands.system.tvRemote, 'function');
  assert.equal(typeof commands.admin.devices, 'function');
  assert.equal(typeof commands.admin.install, 'function');
  assert.equal(typeof commands.recording.record, 'function');
  assert.equal(typeof commands.recording.trace, 'function');
  assert.equal(typeof commands.diagnostics.logs, 'function');
  assert.equal(typeof commands.diagnostics.network, 'function');
  assert.equal(typeof commands.diagnostics.perf, 'function');
});
