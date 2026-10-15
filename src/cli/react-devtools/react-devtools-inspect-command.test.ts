import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { isInspectCommand, runReactInspectCommand } from './react-devtools-inspect-command.ts';
import { commandHarness } from './react-devtools-command.fixtures.ts';
import { FakeAppRuntime, MEMO_TYPE, encodeOperations } from './react-devtools-runtime.fixtures.ts';
import type { ReactDevtoolsCommandOptions } from './react-devtools-connection.ts';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function inspectCommand(args: string[], options: ReactDevtoolsCommandOptions) {
  const [command, ...rest] = args;
  assert.ok(isInspectCommand(command));
  return await runReactInspectCommand(command, rest, options);
}

/** An app whose list renders two memoized rows, one of which logged an error. */
function listApp(): FakeAppRuntime {
  const app = new FakeAppRuntime();
  app.mount([
    { id: 2, name: 'App' },
    { id: 3, name: 'List', parent: 2, owner: 2 },
    { id: 4, name: 'Row', type: MEMO_TYPE, parent: 3, owner: 3, key: 'a' },
    { id: 5, name: 'Row', type: MEMO_TYPE, parent: 3, owner: 3, key: 'b' },
    { id: 6, name: 'Footer', parent: 2, owner: 2 },
  ]);
  app.renderer.commit(encodeOperations({ logs: [[5, 1, 0]] }));
  app.renderer.inspected.set(5, {
    type: MEMO_TYPE,
    key: 'b',
    props: { data: { label: 'Second' }, cleaned: [], unserializable: [] },
    hooks: {
      data: [{ id: 0, name: 'State', value: true, subHooks: [] }],
      cleaned: [],
      unserializable: [],
    },
    owners: [{ id: 3, displayName: 'List' }],
    errors: [['Failed prop type: label', 2]],
    warnings: [],
  });
  return app;
}

const harness = (app = listApp()) => commandHarness(inspectCommand, app);

test('tree prints the mounted components with refs', async () => {
  const { run } = harness();
  assert.equal(
    (await run('tree')).text,
    [
      'React tree in com.example.app: 5 components',
      '@c2 App',
      '  @c3 List',
      '    @c4 Row [memo] key=a',
      '    @c5 Row [memo] key=b (1 error)',
      '  @c6 Footer',
      '',
    ].join('\n'),
  );
  assert.match(
    (await run('tree', '@c3', '--depth', '1')).text,
    /^React tree under @c3 List: 3 components\n@c3 List \(\+2 below\)\n\+2 components not shown/,
  );
});

test('find lists matching components with their owners', async () => {
  const { run } = harness();
  assert.equal(
    (await run('find', 'row')).text,
    '2 mounted components match "row":\n  @c4 Row [memo] key=a in List < App\n  @c5 Row [memo] key=b (1 error) in List < App\n',
  );
  assert.match((await run('find', 'row', '--exact')).text, /^No mounted component name is "row"\./);
});

test('inspect by ref prints props, hooks, owners, and logged problems', async () => {
  const { run } = harness();
  assert.equal(
    (await run('inspect', '@c5')).text,
    [
      '@c5 Row [memo] key=b',
      'rendered by: List @c3',
      'props:',
      '  label: "Second"',
      'hooks:',
      '  State: true',
      'logged while rendering:',
      '  error: Failed prop type: label (x2)',
      '',
    ].join('\n'),
  );
});

test('inspect by a name several components share asks for a ref', async () => {
  const { run } = harness();
  await assert.rejects(run('inspect', 'Row'), /2 mounted components are named Row: @c4, @c5\./);
  await assert.rejects(
    run('inspect', '@c99'),
    (error: { details: { reason: string } }) => error.details.reason === 'element-not-found',
  );
});

test('errors lists the components that logged while rendering, with their messages', async () => {
  const { run } = harness();
  assert.equal(
    (await run('errors')).text,
    '1 mounted component logged errors or warnings while rendering:\n  @c5 Row: 1 error\n    error: Failed prop type: label (x2)\n',
  );
});

test('a runtime whose tree another DevTools frontend owns fails with a typed reason', async () => {
  const app = new FakeAppRuntime();
  app.mount([{ id: 2, name: 'App' }]);
  app.renderer.queue = null;
  app.hook.sub('operations', () => {});
  const { run } = harness(app);
  await assert.rejects(
    run('tree'),
    (error: { details: { reason: string } }) => error.details.reason === 'tree-unavailable',
  );
});

test('errors says when the messages of a component could not be read instead of listing none', async () => {
  const app = listApp();
  app.renderer.inspectElement = () => ({ type: 'error', message: 'hooks threw' });
  const { run, options } = harness(app);
  assert.match(
    (await run('errors')).text,
    /\n {2}@c5 Row: 1 error\n {4}messages unavailable: hooks threw\n$/,
  );
  options.flags = { json: true };
  const parsed = JSON.parse((await run('errors')).text) as {
    data: { components: Array<{ messagesUnavailable?: string; errors?: unknown }> };
  };
  assert.deepEqual(parsed.data.components[0]?.messagesUnavailable, 'hooks threw');
  assert.equal(parsed.data.components[0]?.errors, undefined);
});

test('errors returns the same shape when nothing logged', async () => {
  const app = new FakeAppRuntime();
  app.mount([{ id: 2, name: 'App' }]);
  const { run, options } = harness(app);
  options.flags = { json: true };
  assert.deepEqual(JSON.parse((await run('errors')).text).data, {
    total: 0,
    logsTracked: true,
    components: [],
  });
});

test('errors says its list can be incomplete when the backend does not track logs per component', async () => {
  const app = new FakeAppRuntime({ consoleSettings: false });
  app.mount([{ id: 2, name: 'App' }]);
  const { run } = harness(app);
  assert.equal(
    (await run('errors')).text,
    [
      'No mounted component logged an error or warning while rendering.',
      "Note: this app's React DevTools backend does not attribute every console error and warning to a component, so this list can be incomplete; check agent-device logs as well.",
      '',
    ].join('\n'),
  );
});

test('each command refuses options it does not read', async () => {
  const { run } = harness();
  await assert.rejects(
    run('inspect', '@c5', '--limit', '2'),
    /react-devtools inspect <@ref\|Name> does not take --limit/,
  );
  await assert.rejects(run('find'), /react-devtools find <Name> needs an argument/);
  await assert.rejects(
    run('errors', 'extra'),
    /Unexpected argument for react-devtools errors: extra/,
  );
});
