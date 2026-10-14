import { test } from 'vitest';
import assert from 'node:assert/strict';
import { FakeAppRuntime, MEMO_TYPE, encodeOperations } from './react-profiler-runtime.fixtures.ts';
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
    { ok: started.ok, attach: started.attach, naming: app.call<Started>('status').naming },
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
  assert.deepEqual(stopped.elements['3'], ['Row', 5, 2, 2]);
  assert.deepEqual(stopped.elements['2'], ['App', 5, 0, 0], 'owners ride along for attribution');
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
  assert.deepEqual(stopped.elements['9'], ['Toast', MEMO_TYPE, 0, 0]);
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
  app.call('start');
  assert.equal(app.call<Started>('status').naming, 'lookup');
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
  assert.equal(app.call<Started>('status').naming, 'lookup');
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
