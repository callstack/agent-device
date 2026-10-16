import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  FakeAppRuntime,
  MEMO_TYPE,
  SUSPENSE_TYPE,
  encodeOperations,
} from './react-devtools-runtime.fixtures.ts';
import type { RawReactProfile } from './react-profile-renders.ts';

type Started = {
  ok: boolean;
  reason?: string;
  attach?: string;
  naming?: string;
  elapsedMs?: number;
};
type Stopped = { ok: true } & RawReactProfile;

test('start on a hook-attached backend flushes the queued tree so mounted components are named', () => {
  const app = new FakeAppRuntime();
  app.mount([
    { id: 2, name: 'App' },
    { id: 3, name: 'Row', parent: 2, owner: 2 },
  ]);
  app.renderer.names.clear();
  app.install();

  const started = app.call<Started>('start');
  assert.deepEqual(
    { ok: started.ok, attach: started.attach, naming: started.naming },
    { ok: true, attach: 'attached', naming: 'operations' },
  );
  assert.equal(app.renderer.flushes, 1);

  app.renderer.commit(encodeOperations({ baseDurations: [3] }), {
    timestamp: 100,
    duration: 4,
    fibers: [[3, 4, 3]],
    changes: [
      [3, { props: ['onPress'], state: null, hooks: null, context: null, didHooksChange: false }],
    ],
  });
  const stopped = app.call<Stopped>('stop');

  assert.equal(stopped.ok, true);
  assert.deepEqual(stopped.elements['3'], ['Row', 5, 2, 2, null]);
  assert.deepEqual(
    stopped.elements['2'],
    ['App', 5, 0, 0, null],
    'owners ride along for attribution',
  );
  assert.deepEqual(stopped.keys, ['onPress']);
  assert.deepEqual(stopped.commits[0]!.fibers, [3, 4, 3]);
  assert.deepEqual(stopped.commits[0]!.changes, { '3': [0, [0], null, null] });
});

test('components that mount and unmount during the profile keep their names', () => {
  const app = new FakeAppRuntime();
  app.install();
  app.call('start');
  app.renderer.commit(encodeOperations({ add: [{ id: 9, name: 'Toast', type: MEMO_TYPE }] }), {
    timestamp: 10,
    duration: 2,
    fibers: [[9, 2, 2]],
    changes: [[9, { isFirstMount: true }]],
  });
  app.renderer.commit(encodeOperations({ remove: [9] }));

  const stopped = app.call<Stopped>('stop');
  assert.deepEqual(stopped.elements['9'], ['Toast', MEMO_TYPE, 0, 0, null]);
  assert.deepEqual(stopped.commits[0]!.changes, { '9': 1 });
});

test('a render with no recorded change is omitted, so absence reads as a parent-driven render', () => {
  const app = new FakeAppRuntime();
  app.mount([{ id: 4, name: 'Cell' }]);
  app.install();
  app.call('start');
  app.renderer.commit(encodeOperations({}), {
    timestamp: 1,
    duration: 1,
    fibers: [[4, 1, 1]],
    changes: [[4, { props: [], state: null, hooks: null, context: false, didHooksChange: false }]],
  });

  assert.deepEqual(app.call<Stopped>('stop').commits[0]!.changes, {});
});

test('an operation the runtime cannot decode switches naming to lookups instead of guessing', () => {
  const app = new FakeAppRuntime();
  app.install();
  app.call('start');
  app.renderer.names.set(5, 'Looked up');
  app.renderer.commit(
    encodeOperations({ add: [{ id: 5, name: 'Parsed' }], extra: [42, 1, 2, 3] }),
    {
      timestamp: 1,
      duration: 1,
      fibers: [
        [5, 1, 1],
        [6, 1, 1],
      ],
    },
  );

  const stopped = app.call<Stopped>('stop');
  assert.equal(stopped.naming, 'lookup');
  assert.equal(stopped.elements['5']![0], 'Parsed');
  assert.equal(stopped.elements['6'], undefined);
});

test('a backend that needs a frontend attaches through the Fusebox domain with a stand-in binding', () => {
  const app = new FakeAppRuntime({ attachAtInject: false });
  app.install();

  const started = app.call<Started>('start');
  assert.equal(started.attach, 'fusebox-domain');
  assert.equal(app.domainInitializations, 1);
  assert.equal(app.renderer.flushes, 1);
  assert.equal(
    typeof (app.context as Record<string, unknown>).__CHROME_DEVTOOLS_FRONTEND_BINDING__,
    'function',
  );
});

test('a connected DevTools frontend keeps its operations stream: no second flush', () => {
  const app = new FakeAppRuntime();
  (app.context as Record<string, unknown>).__CHROME_DEVTOOLS_FRONTEND_BINDING__ = () => {};
  app.renderer.queue = null;
  app.install();

  const started = app.call<Started>('start');
  assert.equal(started.ok, true);
  assert.equal(app.renderer.flushes, 0);
});

test('an attached backend without Fusebox belongs to an external frontend: names come from lookups', () => {
  const app = new FakeAppRuntime({ fusebox: false });
  app.install();
  assert.equal(app.call<Started>('start').naming, 'lookup');
  assert.equal(app.renderer.flushes, 0);
});

test('another DevTools agent keeps its queue; new mounts are parsed and the rest looked up', () => {
  const app = new FakeAppRuntime();
  app.mount([{ id: 2, name: 'Existing' }]);
  app.renderer.queue = null;
  app.hook.sub('operations', () => {});
  app.install();

  const started = app.call<Started>('start');
  assert.equal(started.ok, true);
  assert.equal(started.naming, 'lookup');
  assert.equal(app.renderer.flushes, 0);
  app.renderer.commit(encodeOperations({ add: [{ id: 7, name: 'Fresh' }] }), {
    timestamp: 1,
    duration: 2,
    fibers: [
      [2, 1, 1],
      [7, 1, 1],
    ],
  });
  const stopped = app.call<Stopped>('stop');
  assert.equal(stopped.elements['7']![0], 'Fresh');
  assert.equal(stopped.elements['2']![0], 'Existing');
});

test('lookups use the React DevTools 5 name accessor when the backend predates element ids', () => {
  const app = new FakeAppRuntime({ fusebox: false });
  const renderer = app.renderer as unknown as Record<string, unknown>;
  renderer.getDisplayNameForFiberID = (id: number) => (id === 3 ? 'Chart' : null);
  renderer.getDisplayNameForElementID = undefined;
  app.install();
  app.call('start');
  app.renderer.commit(encodeOperations({}), { timestamp: 1, duration: 1, fibers: [[3, 1, 1]] });
  assert.equal(app.call<Stopped>('stop').elements['3']![0], 'Chart');
});

test('without Fusebox the runtime connects through react-devtools-core in the module registry', () => {
  const app = new FakeAppRuntime({
    attachAtInject: false,
    fusebox: false,
    devtoolsCoreModule: true,
  });
  app.install();

  assert.equal(app.call<Started>('start').attach, 'devtools-core');
  assert.equal(app.customConnections, 1);
});

test('start reports a typed reason when the app has nothing to attach to', () => {
  assert.equal(new FakeAppRuntime({ hook: false }).install(), 'installed');
  const noHook = new FakeAppRuntime({ hook: false });
  noHook.install();
  assert.equal(noHook.call<Started>('start').reason, 'no-devtools-hook');

  const noBackend = new FakeAppRuntime({ attachAtInject: false, fusebox: false });
  noBackend.install();
  assert.equal(noBackend.call<Started>('start').reason, 'no-devtools-backend');
});

test('start while recording reports the elapsed time measured on the device clock', () => {
  const app = new FakeAppRuntime();
  app.install();
  app.call('start');
  const again = app.call<Started>('start');
  assert.equal(again.reason, 'already-profiling');
  assert.equal(typeof again.elapsedMs, 'number');
  assert.equal(app.call<{ ok: boolean }>('stop').ok, true);
  assert.equal(app.call<{ reason: string }>('stop').reason, 'not-profiling');
});

test('installing a newer runtime adopts the names the previous one collected', () => {
  const app = new FakeAppRuntime();
  app.install('one');
  app.call('start');
  app.renderer.commit(encodeOperations({ add: [{ id: 8, name: 'Header' }] }));
  app.call('stop');

  assert.equal(app.install('one'), 'ready');
  assert.equal(app.install('two'), 'installed');
  app.call('start');
  app.renderer.commit(encodeOperations({}), { timestamp: 1, duration: 1, fibers: [[8, 1, 1]] });
  assert.equal(app.call<Stopped>('stop').elements['8']![0], 'Header');
});

test('describeProps classifies changed prop values on a mounted instance', () => {
  const app = new FakeAppRuntime();
  app.install();
  app.renderer.props.set(3, {
    data: {
      onPress: { type: 'function', name: 'onPress' },
      style: { opacity: 1 },
      items: [1],
      label: 'x',
    },
    cleaned: [['onPress']],
  });

  assert.deepEqual(
    app.call('describeProps', {
      '3': ['onPress', 'style', 'items', 'label', 'missing'],
      '4': ['x'],
    }),
    {
      '3': { onPress: 'function', style: 'object', items: 'array', label: 'string' },
    },
  );
});

test('prop sampling and inspection use the renderer that owns the element', () => {
  const app = new FakeAppRuntime();
  app.install();
  app.renderer.props.set(3, { data: { label: 'owned' }, cleaned: [] });
  const foreign = Object.assign(Object.create(app.renderer), {
    hasElementWithId: () => false,
    inspectElement: () => ({ type: 'full-data', value: { props: { data: { label: 1 } } } }),
  });
  app.hook.rendererInterfaces.clear();
  app.hook.rendererInterfaces.set(1, foreign);
  app.hook.rendererInterfaces.set(2, app.renderer);
  assert.deepEqual(app.call('describeProps', { '3': ['label'] }), { '3': { label: 'string' } });
  const inspected = app.call<{ ok: boolean; elements: Record<string, { props: unknown }> }>(
    'inspect',
    [3],
  );
  assert.deepEqual(inspected.elements['3']?.props, { data: { label: 'owned' }, cleaned: [] });
});

for (const confirmedOwner of [false, true]) {
  test(`${confirmedOwner ? 'confirmed' : 'unconfirmed'} renderer failure respects element ownership`, () => {
    const app = new FakeAppRuntime();
    app.install();
    app.renderer.props.set(3, { data: { label: 'owned' }, cleaned: [] });
    const foreign = Object.assign(Object.create(app.renderer), {
      hasElementWithId: confirmedOwner ? () => true : undefined,
      inspectElement: () => {
        throw new Error('renderer unavailable');
      },
    });
    app.hook.rendererInterfaces.clear();
    app.hook.rendererInterfaces.set(1, foreign);
    app.hook.rendererInterfaces.set(2, app.renderer);
    assert.deepEqual(
      app.call('describeProps', { '3': ['label'] }),
      confirmedOwner ? {} : { '3': { label: 'string' } },
    );
    const inspected = app.call<{ elements: Record<string, { props?: unknown; error?: string }> }>(
      'inspect',
      [3],
    );
    if (confirmedOwner) assert.equal(inspected.elements['3']?.error, 'renderer unavailable');
    else
      assert.deepEqual(inspected.elements['3']?.props, { data: { label: 'owned' }, cleaned: [] });
  });
}

test('a renderer whose profiling data cannot be read fails the stop instead of returning no commits', () => {
  const app = new FakeAppRuntime();
  app.install();
  app.call('start');
  app.renderer.getProfilingData = () => {
    throw new Error('profiling data unavailable');
  };
  assert.deepEqual(app.call('stop'), {
    ok: false,
    reason: 'collect-failed',
    detail: 'profiling data unavailable',
  });
});

test('a profile read from only some renderers says which ones failed', () => {
  const app = new FakeAppRuntime();
  app.install();
  const broken = Object.assign(Object.create(app.renderer), {
    getProfilingData: () => {
      throw new Error('second root gone');
    },
  });
  app.hook.rendererInterfaces.set(2, broken);
  app.call('start');
  const stopped = app.call<Stopped & { failures: string[] }>('stop');
  assert.equal(stopped.ok, true);
  assert.deepEqual(stopped.failures, ['second root gone']);
});

type Tree = {
  ok: true;
  nodes: Array<[number, string, number, number, number, string | null]>;
  order: Record<string, number[]>;
  logs: Record<string, [number, number]>;
};

test('tree exports every mounted component with its key, child order, and logged problems', () => {
  const app = new FakeAppRuntime();
  app.mount([
    { id: 2, name: 'App', parent: 1 },
    { id: 3, name: 'Row', parent: 2, owner: 2, key: 'a' },
    { id: 4, name: 'Row', parent: 2, owner: 2, key: 'b' },
  ]);
  app.install();
  app.renderer.commit(
    encodeOperations({ reorder: [2, [4, 3]], logs: [[3, 1, 2]], add: [{ id: 5, name: 'Gone' }] }),
  );
  app.renderer.commit(encodeOperations({ remove: [5] }));

  const tree = app.call<Tree>('tree');
  assert.deepEqual(tree.nodes, [
    [2, 'App', 5, 1, 0, null],
    [3, 'Row', 5, 2, 2, 'a'],
    [4, 'Row', 5, 2, 2, 'b'],
  ]);
  assert.deepEqual(tree.order, { '2': [4, 3] });
  assert.deepEqual(tree.logs, { '3': [1, 2] });
});

test('a React DevTools 7+ backend adds a name prop to each element and emits Suspense ops', () => {
  const app = new FakeAppRuntime({ nameProps: true });
  app.mount([
    { id: 2, name: 'App', parent: 1 },
    { id: 3, name: 'Suspense', type: SUSPENSE_TYPE, parent: 2, owner: 2, nameProp: 'feed' },
  ]);
  app.install();
  const suspenseAdd = [8, 3, 1, 0, 1, 2, 0, 0, 10, 20, 0, 0, 5, 5];
  const suspenseResize = [11, 3, -1];
  const suspenders = [12, 2, 3, 1, 1500, 0, 1, 1, 4, 0, 900, 1, 0];
  const activitySlice = [13, 0];
  app.renderer.commit(
    encodeOperations({
      nameProps: true,
      add: [{ id: 4, name: 'Row', parent: 3, owner: 2, key: 'a', nameProp: 'first' }],
      extra: [...suspenseAdd, ...suspenseResize, ...suspenders, ...activitySlice, 10, 3, 1, 4],
    }),
  );
  app.renderer.commit(encodeOperations({ nameProps: true, logs: [[4, 1, 0]], extra: [9, 1, 3] }));

  const tree = app.call<Tree>('tree');
  assert.deepEqual(tree.nodes, [
    [2, 'App', 5, 1, 0, null],
    [3, 'Suspense', SUSPENSE_TYPE, 2, 2, null],
    [4, 'Row', 5, 3, 2, 'a'],
  ]);
  assert.deepEqual(tree.logs, { '4': [1, 0] });
});

test('a component that unmounts while a profile records leaves the tree but keeps its name', () => {
  const app = new FakeAppRuntime();
  app.mount([{ id: 2, name: 'App' }]);
  app.install();
  app.call('start');
  app.renderer.commit(encodeOperations({ add: [{ id: 9, name: 'Toast' }] }));
  app.renderer.commit(encodeOperations({ remove: [9] }));
  assert.deepEqual(
    app.call<Tree>('tree').nodes.map((node) => node[1]),
    ['App'],
  );
});

test('without the operations history there is no tree to export', () => {
  const app = new FakeAppRuntime({ fusebox: false });
  app.install();
  assert.deepEqual(app.call('tree'), { ok: false, reason: 'tree-unavailable' });
});

test('inspect returns props, hooks, owners, and logged problems of mounted components', () => {
  const app = new FakeAppRuntime();
  app.mount([{ id: 3, name: 'Row', key: 'a' }]);
  app.install();
  const props = { data: { label: 'First' }, cleaned: [], unserializable: [] };
  const hooks = {
    data: [{ id: 0, name: 'State', value: 2, subHooks: [] }],
    cleaned: [],
    unserializable: [],
  };
  const owners = [{ id: 2, displayName: 'List', type: 5, key: null }];
  app.renderer.inspected.set(3, {
    type: 5,
    key: 'a',
    props,
    state: null,
    hooks,
    context: null,
    owners,
    errors: [['boom', 2]],
    warnings: [],
    isErrored: false,
  });
  const result = app.call<{ ok: true; elements: Record<string, Record<string, unknown>> }>(
    'inspect',
    [3, 99],
  );
  assert.deepEqual(result.elements['3'], {
    name: 'Row',
    type: 5,
    key: 'a',
    props,
    state: null,
    hooks,
    context: null,
    owners,
    errors: [['boom', 2]],
    warnings: [],
    isErrored: false,
  });
  assert.deepEqual(result.elements['99'], { missing: true });
});

test('stop reads only the renderers that started, so a failed export of the one recording fails', () => {
  const app = new FakeAppRuntime();
  app.install();
  const unstarted = Object.assign(Object.create(app.renderer), {
    startProfiling: () => {
      throw new Error('profiling unsupported');
    },
    getProfilingData: () => ({ dataForRoots: [] }),
  });
  app.hook.rendererInterfaces.set(2, unstarted);
  app.call('start');
  app.renderer.getProfilingData = () => {
    throw new Error('profiling data unavailable');
  };
  assert.deepEqual(app.call('stop'), {
    ok: false,
    reason: 'collect-failed',
    detail: 'profiling data unavailable',
  });
});
