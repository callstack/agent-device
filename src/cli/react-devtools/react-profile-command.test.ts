import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { InspectorSession } from './metro-inspector.ts';
import { commandHarness, TARGET } from './react-devtools-command.fixtures.ts';
import { FakeAppRuntime, MEMO_TYPE, encodeOperations } from './react-devtools-runtime.fixtures.ts';

const harness = (app?: FakeAppRuntime, targets?: unknown[]) =>
  commandHarness(['profile'], app, targets);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function recordRowRenders(app: FakeAppRuntime) {
  const rows = Array.from({ length: 12 }, (_, index) => 10 + index);
  app.renderer.commit(
    encodeOperations({
      add: [
        { id: 2, name: 'List' },
        ...rows.map((id) => ({ id, name: 'Memo(Row)', type: MEMO_TYPE, owner: 2 })),
      ],
    }),
  );
  for (let index = 0; index < 3; index += 1) {
    app.renderer.commit(encodeOperations({}), {
      timestamp: index * 200,
      duration: 40,
      updaters: [{ id: 2, displayName: 'List' }],
      fibers: [[2, 40, 1], ...rows.map((id): [number, number, number] => [id, 3, 3])],
      changes: [
        [2, { state: ['0'] }],
        ...rows.map((id): [number, Record<string, unknown>] => [id, { props: ['onPress'] }]),
      ],
    });
  }
  app.renderer.props.set(rows.at(-1)!, {
    data: { onPress: { type: 'function' } },
    cleaned: [['onPress']],
  });
}

test('profile start, an interaction, and profile stop print a compact diagnosis and save it', async () => {
  const { app, run, stateDir, requested } = harness();
  const started = await run('start');
  assert.equal(started.code, 0);
  assert.match(started.text, /^Profiling React renders in com\.example\.app\./);
  assert.deepEqual(requested, ['http://localhost:8081/json/list']);

  recordRowRenders(app);
  const stopped = await run('stop');
  assert.equal(stopped.code, 0);
  assert.equal(
    stopped.text.split('\n')[1],
    '1. memo-defeated Row: memo bypassed on 36/36 updates; new onPress (function) 36x from List -> wrap those props in useCallback/useMemo in List',
  );
  assert.ok(fs.existsSync(path.join(stateDir, 'react-profiles', 'qa.json')));

  const report = await run('report', 'Row');
  assert.match(
    report.text,
    /^Row \[memo\] self 108ms avg 3\.0ms max 3\.0ms renders 36 12 inst\ncauses: props 36\nchanged props: onPress 36 \(function\)/,
  );
  assert.match(
    (await run('report')).text,
    /^Components by self time:\n {2}Row \[memo\] self 108ms [^\n]*: props 36; changed props onPress 36\n/,
  );
  assert.match(
    (await run('commit', '--limit', '1')).text,
    /^Commits \(1 slowest of 3, --limit 3 for all\):\n {2}#0 \+0\.0s 40ms 13 rendered <- List\n$/,
  );
  assert.match(
    (await run('commit', '#1')).text,
    /^#1 \+0\.2s 40ms 13 rendered <- List\n {2}Row \[memo\] x12 self 36ms props/,
  );
});

test('profile stop --json returns the findings and where the profile was saved', async () => {
  const { app, run, options, stateDir } = harness();
  await run('start');
  recordRowRenders(app);
  options.flags = { json: true };
  const { text } = await run('stop', '--limit', '1');
  const parsed = JSON.parse(text) as {
    success: boolean;
    data: { findings: Array<{ kind: string }>; savedTo: string };
  };
  assert.equal(parsed.success, true);
  assert.deepEqual(
    parsed.data.findings.map((f) => f.kind),
    ['memo-defeated'],
  );
  assert.equal(parsed.data.savedTo, path.join(stateDir, 'react-profiles', 'qa.json'));
});

test('profile start twice keeps the running recording and what it captured', async () => {
  const { app, run } = harness();
  await run('start');
  recordRowRenders(app);
  assert.match(
    (await run('start')).text,
    /^Already profiling com\.example\.app for \d+\.\ds; run react-devtools profile stop/,
  );
  assert.match((await run('stop')).text, /^React profile \d+\.\ds: 3 commits/);
});

test('one app on two devices fails closed until --metro-device picks one', async () => {
  const second = {
    ...TARGET,
    id: 'tablet-1',
    deviceName: 'Tablet',
    webSocketDebuggerUrl: 'ws://127.0.0.1:8081/inspector/debug?device=tablet&page=1',
    reactNative: { logicalDeviceId: 'tablet' },
  };
  const { run } = harness(new FakeAppRuntime(), [{ ...TARGET, deviceName: 'Pixel' }, second]);
  await assert.rejects(run('start'), (error: { code: string }) => error.code === 'INVALID_ARGS');
  assert.equal(vi.mocked(InspectorSession.connect).mock.calls.length, 0);
  assert.match((await run('start', '--metro-device', 'Tablet')).text, /^Profiling React renders/);
  assert.deepEqual(
    vi.mocked(InspectorSession.connect).mock.calls.map(([url]) => url),
    ['ws://localhost:8081/inspector/debug?device=tablet&page=1'],
  );
});

test('a failed prop inspection becomes a note instead of failing the stop', async () => {
  const { app, run } = harness();
  await run('start');
  recordRowRenders(app);
  vi.spyOn(InspectorSession, 'connect').mockImplementation(
    async () =>
      ({
        evaluate: async (expression: string) => {
          if (expression.includes('.describeProps(')) throw new Error('inspector gone');
          return vm.runInContext(expression, app.context);
        },
        close: () => {},
      }) as unknown as InspectorSession,
  );
  const { text } = await run('stop');
  assert.match(text, /changed onPress 36x from List \(value kinds not inspected\)/);
  assert.match(text, /\nNote: Changed prop values could not be inspected: inspector gone\n/);
});

test('runtime failures carry a typed reason and a hint', async () => {
  const { run } = harness(new FakeAppRuntime({ hook: false }));
  await assert.rejects(
    run('start'),
    (error: { code: string; details: { reason: string; hint: string } }) => {
      assert.equal(error.code, 'COMMAND_FAILED');
      assert.equal(error.details.reason, 'no-devtools-hook');
      assert.match(error.details.hint, /development build/);
      return true;
    },
  );
  await assert.rejects(
    harness().run('stop'),
    (error: { details: { reason: string } }) => error.details.reason === 'not-profiling',
  );
});

test('drill-down views need a saved profile', async () => {
  await assert.rejects(harness().run('report'), /No React profile saved for session qa/);
});

test('a corrupt saved profile asks for a new recording', async () => {
  const { run, stateDir } = harness();
  fs.mkdirSync(path.join(stateDir, 'react-profiles'), { recursive: true });
  const file = path.join(stateDir, 'react-profiles', 'qa.json');
  fs.writeFileSync(file, '{"profile":');
  await assert.rejects(run('report'), /unsupported format/);
  fs.writeFileSync(file, JSON.stringify({ version: 1, analysis: { components: [] } }));
  await assert.rejects(run('report'), /unsupported format/);
});

test('unknown profile commands and malformed options are invalid arguments', async () => {
  const { run } = harness();
  const cases: Array<[string[], RegExp]> = [
    [['export', 'out.json'], /Unknown react-devtools profile command: export/],
    [['report', '--limit', '0'], /Invalid --limit: 0/],
    [['report', '--limit', '10garbage'], /Invalid --limit: 10garbage/],
    [['commit', '--limit', '1.5'], /Invalid --limit: 1\.5/],
    [['stop', 'extra'], /Unexpected argument for react-devtools profile stop: extra/],
    [['start', '--limit', '5'], /react-devtools profile start does not take --limit/],
    [
      ['report', 'Row', 'extra'],
      /Unexpected argument for react-devtools profile report <Component>: extra/,
    ],
    [
      ['report', 'Row', '--limit', '2'],
      /react-devtools profile report <Component> does not take --limit/,
    ],
    [['commit', '--sort', 'duration'], /Unknown option '--sort'/],
  ];
  for (const [args, message] of cases) {
    await assert.rejects(run(...args), (error: { code: string; message: string }) => {
      assert.equal(error.code, 'INVALID_ARGS', args.join(' '));
      assert.match(error.message, message);
      return true;
    });
  }
});

test('profile commit --json honors --limit like the text view', async () => {
  const { app, run, options } = harness();
  await run('start');
  recordRowRenders(app);
  await run('stop');
  options.flags = { json: true };
  const { text } = await run('commit', '1', '--limit', '1');
  const parsed = JSON.parse(text) as {
    data: { components: Array<{ name: string }>; rendered: number };
  };
  assert.deepEqual(
    parsed.data.components.map((entry) => entry.name),
    ['Row'],
  );
  assert.equal(parsed.data.rendered, 13);
});

test('commit selectors must be whole indexes', async () => {
  const { app, run } = harness();
  await run('start');
  recordRowRenders(app);
  await run('stop');
  await assert.rejects(
    run('commit', '#1junk'),
    (error: { code: string }) => error.code === 'INVALID_ARGS',
  );
  assert.match((await run('commit', '#1')).text, /^#1 /);
});

test('a profile the backend cannot export fails the stop with its reason', async () => {
  const { app, run } = harness();
  await run('start');
  app.renderer.getProfilingData = () => {
    throw new Error('profiling data unavailable');
  };
  await assert.rejects(
    run('stop'),
    (error: { code: string; message: string; details: { reason: string } }) => {
      assert.equal(error.code, 'COMMAND_FAILED');
      assert.equal(error.details.reason, 'collect-failed');
      assert.match(error.message, /profiling data unavailable$/);
      return true;
    },
  );
});

test('drill-down views read the saved recording, not a trimmed analysis', async () => {
  const { app, run, stateDir } = harness();
  await run('start');
  recordRowRenders(app);
  await run('stop');
  const saved = JSON.parse(
    fs.readFileSync(path.join(stateDir, 'react-profiles', 'qa.json'), 'utf8'),
  ) as { version: number; profile: { commits: unknown[] }; propKinds: unknown };
  assert.equal(saved.version, 2);
  assert.equal(saved.profile.commits.length, 3);
  assert.match((await run('report', 'Row')).text, /changed props: onPress 36 \(function\)/);
  assert.doesNotMatch((await run('report', 'Row')).text, /collection may have been interrupted/);
});

test('stop saves the raw recording before optional prop inspection', async () => {
  const { app, run, stateDir } = harness();
  await run('start');
  recordRowRenders(app);
  let checkpoint:
    | { profile: { commits: unknown[] }; propKinds: unknown; notes: string[] }
    | undefined;
  vi.mocked(InspectorSession.connect).mockResolvedValue({
    evaluate: async (expression: string) => {
      if (expression.includes('.describeProps(')) {
        const file = path.join(stateDir, 'react-profiles', 'qa.json');
        if (fs.existsSync(file)) checkpoint = JSON.parse(fs.readFileSync(file, 'utf8'));
        throw new Error('inspection unavailable');
      }
      return vm.runInContext(expression, app.context);
    },
    close: () => {},
  } as unknown as InspectorSession);
  const stopped = await run('stop');
  assert.equal(checkpoint?.profile.commits.length, 3);
  assert.deepEqual(checkpoint?.propKinds, {});
  assert.deepEqual(checkpoint?.notes, [
    'Changed prop values have not been inspected; collection may have been interrupted.',
  ]);
  assert.match(stopped.text, /Changed prop values could not be inspected: inspection unavailable/);
  assert.match((await run('report', 'Row')).text, /renders 36/);
});

test('a renderer that fails while another records nothing is named in the empty summary', async () => {
  const { app, run } = harness();
  const broken = Object.assign(Object.create(app.renderer), {
    getProfilingData: () => {
      throw new Error('second root gone');
    },
  });
  app.hook.rendererInterfaces.set(2, broken);
  await run('start');
  assert.equal(
    (await run('stop')).text,
    [
      'React profile: no commits recorded. Start profiling, then perform the interaction before stopping.',
      "Note: A React renderer's profile could not be read: second root gone",
      '',
    ].join('\n'),
  );
});
