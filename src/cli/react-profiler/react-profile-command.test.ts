import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { mkdtempForTestSync } from '@agent-device/test-kit/tmp-dir';
import {
  runReactProfileCommand,
  type ReactProfileCommandOptions,
} from './react-profile-command.ts';
import { FakeAppRuntime, MEMO_TYPE, encodeOperations } from './react-profiler-runtime.fixtures.ts';

const TARGET = {
  id: 'device-1',
  title: 'com.example.app (Pixel)',
  appId: 'com.example.app',
  webSocketDebuggerUrl: 'ws://127.0.0.1:8081/inspector/debug?device=1&page=1',
  reactNative: { logicalDeviceId: 'device' },
};

function harness(app = new FakeAppRuntime()) {
  const stateDir = mkdtempForTestSync('react-profile-');
  const output: string[] = [];
  const requested: string[] = [];
  const options: ReactProfileCommandOptions = {
    stateDir,
    session: 'qa',
    write: (text) => output.push(text),
    fetchImpl: (async (url: URL) => {
      requested.push(String(url));
      return new Response(JSON.stringify([TARGET]), { status: 200 });
    }) as typeof fetch,
    connect: async () => ({
      evaluate: async (expression: string) => vm.runInContext(expression, app.context),
      close: () => {},
    }),
  };
  const run = async (...args: string[]) => {
    output.length = 0;
    const code = await runReactProfileCommand(args, options);
    return { code, text: output.join('') };
  };
  return { app, run, options, stateDir, requested };
}

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
    '1. memo-defeated Row: memo bypassed on 36/36 updates; new onPress (function) every render from List -> wrap those props in useCallback/useMemo in List',
  );
  assert.ok(fs.existsSync(path.join(stateDir, 'react-profiles', 'qa.json')));

  const report = await run('report', 'Row');
  assert.match(
    report.text,
    /^Row \[memo\] self 108ms avg 3\.0ms max 3\.0ms renders 36 12 inst\ncauses: props 36\nchanged props: onPress 36 \(function\)/,
  );
  assert.match(
    (await run('timeline', '--sort', 'duration', '--limit', '1')).text,
    /^Slowest commits \(1 of 3\):\n {2}#0 \+0\.0s 40ms 13 rendered <- List/,
  );
  assert.match(
    (await run('commit', '#1')).text,
    /^#1 \+0\.2s 40ms 13 rendered <- List\n {2}Row x12 self 36ms props/,
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

test('profile start twice keeps the running recording', async () => {
  const { run } = harness();
  await run('start');
  assert.match(
    (await run('start')).text,
    /^Already profiling com\.example\.app for \d+\.\ds; run react-devtools profile stop/,
  );
  assert.match((await run('status')).text, /^Profiling com\.example\.app for \d+\.\ds\.$/m);
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
  await assert.rejects(harness().run('slow'), /No React profile saved for session qa/);
});

test('explicit dev-server flags override the session binding', async () => {
  const { run, requested } = harness();
  await run('status', '--metro-port', '8082');
  assert.deepEqual(requested, ['http://localhost:8082/json/list']);
});

test('the session Metro binding picks the dev server', async () => {
  const { run, requested, stateDir } = harness();
  fs.mkdirSync(path.join(stateDir, 'metro-sessions'), { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, 'metro-sessions', 'qa.json'),
    JSON.stringify({ controlBaseUrl: 'http://127.0.0.1:19000/' }),
  );
  await run('status');
  assert.deepEqual(requested, ['http://127.0.0.1:19000/json/list']);
});

test('a remote bridge profiles through the public dev-server URL without its bundle path', async () => {
  const { run, requested, options } = harness();
  options.flags = {
    leaseBackend: 'android-instance',
    metroPublicBaseUrl: 'https://metro.example.test/index.bundle?platform=android',
  };
  await run('status');
  assert.deepEqual(requested, ['https://metro.example.test/json/list']);
});

test('a corrupt saved profile asks for a new recording', async () => {
  const { run, stateDir } = harness();
  fs.mkdirSync(path.join(stateDir, 'react-profiles'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'react-profiles', 'qa.json'), '{"analysis":');
  await assert.rejects(run('slow'), /unsupported format/);
});

test('unknown profile commands and bad options are invalid arguments', async () => {
  const { run } = harness();
  await assert.rejects(run('export', 'out.json'), /Unknown react-devtools profile command: export/);
  await assert.rejects(run('slow', '--limit', '0'), /Invalid --limit: 0/);
  await assert.rejects(run('timeline', '--sort', 'name'), /Invalid --sort: name/);
});
