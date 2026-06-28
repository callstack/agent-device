import { test } from 'vitest';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCliCapture } from './cli-capture.ts';

function makeFailedReplayResult() {
  return {
    file: '/tmp/02-fail.ad',
    title: 'Checkout failure',
    session: 'default:test:suite:2',
    status: 'failed',
    durationMs: 5,
    attempts: 2,
    artifactsDir: '/tmp/test-artifacts/02-fail',
    error: { message: 'Replay failed at step 1 (open Demo): boom' },
  };
}

function makeReplaySuiteResponse() {
  const failedReplayResult = makeFailedReplayResult();

  return {
    ok: true as const,
    data: {
      total: 3,
      executed: 2,
      passed: 1,
      failed: 1,
      skipped: 1,
      notRun: 0,
      durationMs: 25,
      failures: [failedReplayResult],
      tests: [
        {
          file: '/tmp/01-pass.ad',
          session: 'default:test:suite:1',
          status: 'passed',
          durationMs: 10,
          attempts: 1,
        },
        failedReplayResult,
        {
          file: '/tmp/03-skip.ad',
          status: 'skipped',
          durationMs: 0,
          message: 'missing platform metadata for --platform android',
        },
      ],
    },
  };
}

test('network dump prints parsed entries and metadata', async () => {
  const result = await runCliCapture(['network', 'dump', '10', '--include', 'all'], async () => ({
    ok: true,
    data: {
      path: '/tmp/app.log',
      include: 'all',
      active: true,
      state: 'active',
      backend: 'android',
      scannedLines: 120,
      matchedLines: 2,
      entries: [
        {
          timestamp: '2026-02-24T10:00:01Z',
          method: 'POST',
          url: 'https://api.example.com/v1/login',
          status: 401,
          durationMs: 377,
          headers: '{"x-id":"abc"}',
          requestBody: '{"email":"u@example.com"}',
          responseBody: '{"error":"denied"}',
        },
        {
          timestamp: '2026-06-22T09:08:19.500Z',
          method: 'GET',
          url: 'https://example.test/api',
          status: 200,
          requestHeaders: { Accept: 'application/json' },
          responseHeaders: { 'content-type': 'application/json' },
        },
      ],
      notes: ['best-effort parser'],
    },
  }));

  assert.equal(result.code, null);
  assert.equal(result.calls.length, 1);
  const request = result.calls[0];
  assert.ok(request);
  assert.deepEqual(request.positionals, ['dump', '10']);
  assert.equal(request.flags?.networkInclude, 'all');
  assert.match(result.stdout, /\/tmp\/app\.log/);
  assert.match(
    result.stdout,
    /2026-02-24T10:00:01Z POST https:\/\/api\.example\.com\/v1\/login status=401 durationMs=377/,
  );
  assert.match(result.stdout, /headers:/);
  assert.match(result.stdout, /request:/);
  assert.match(result.stdout, /response:/);
  assert.match(result.stdout, /request headers: \{"Accept":"application\/json"\}/);
  assert.match(result.stdout, /response headers: \{"content-type":"application\/json"\}/);
  assert.match(result.stderr, /active=true/);
  assert.match(result.stderr, /include=all/);
  assert.match(result.stderr, /matchedLines=2/);
  assert.match(result.stderr, /best-effort parser/);
});

test('non-json commands opt into generic progress streaming', async () => {
  const result = await runCliCapture(['snapshot'], async () => ({
    ok: true,
    data: { nodes: [], truncated: false },
  }));

  assert.equal(result.code, null);
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0]?.command, 'snapshot');
  assert.equal(result.calls[0]?.meta?.requestProgress, 'command');
});

test('json commands do not opt into progress streaming', async () => {
  const result = await runCliCapture(['snapshot', '--json'], async () => ({
    ok: true,
    data: { nodes: [], truncated: false },
  }));

  assert.equal(result.code, null);
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0]?.command, 'snapshot');
  assert.equal(result.calls[0]?.meta?.requestProgress, undefined);
});

test('test command prints suite summary and exits non-zero on failures', async () => {
  const result = await runCliCapture(['test', './suite'], async () => makeReplaySuiteResponse());

  assert.equal(result.code, 1);
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0]?.meta?.requestProgress, 'replay-test');
  assert.doesNotMatch(result.stderr, /Running replay suite\.\.\./);
  assert.doesNotMatch(result.stdout, /✓ 01-pass\.ad \(0\.01s\)/);
  assert.doesNotMatch(result.stdout, /⨯ "Checkout failure" in 02-fail\.ad/);
  assert.match(result.stdout, /Replay failed at step 1 \(open Demo\): boom/);
  assert.match(result.stdout, /artifacts: \/tmp\/test-artifacts\/02-fail/);
  assert.doesNotMatch(result.stdout, /SKIP \/tmp\/03-skip\.ad/);
  assert.match(result.stdout, /Test summary: 1 passed, 1 failed in 0\.025s/);
});

test('test command --verbose prints all test statuses', async () => {
  const result = await runCliCapture(['test', './suite', '--verbose'], async () =>
    makeReplaySuiteResponse(),
  );

  assert.equal(result.code, 1);
  assert.equal(result.calls[0]?.meta?.debug, false);
  assert.doesNotMatch(result.stderr, /Running replay suite\.\.\./);
  assert.doesNotMatch(result.stdout, /✓ 01-pass\.ad \(0\.01s\)/);
  assert.doesNotMatch(result.stdout, /SKIP 03-skip\.ad/);
  assert.match(result.stdout, /Test summary: 1 passed, 1 failed in 0\.025s/);
});

test('test command --verbose omits step telemetry for passing tests without debug mode', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-cli-test-verbose-'));
  const artifactsDir = path.join(tmpDir, 'auth-flow');
  const attemptDir = path.join(artifactsDir, 'attempt-1');
  await fs.mkdir(attemptDir, { recursive: true });
  await fs.writeFile(
    path.join(attemptDir, 'replay-timing.ndjson'),
    [
      {
        type: 'replay_action_start',
        step: 1,
        line: 3,
        command: '__maestroTapOn',
        positionals: ['text="Log in"'],
      },
      {
        type: 'replay_action_stop',
        step: 1,
        line: 3,
        command: '__maestroTapOn',
        ok: true,
        durationMs: 250,
      },
      {
        type: 'replay_action_start',
        step: 2,
        line: 4,
        command: '__maestroAssertVisible',
        positionals: ['text="Home"'],
      },
      {
        type: 'replay_action_stop',
        step: 2,
        line: 4,
        command: '__maestroAssertVisible',
        ok: true,
        durationMs: 75,
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n'),
  );

  try {
    const result = await runCliCapture(['test', './suite', '--verbose'], async () => ({
      ok: true,
      data: {
        total: 1,
        executed: 1,
        passed: 1,
        failed: 0,
        skipped: 0,
        notRun: 0,
        durationMs: 500,
        failures: [],
        tests: [
          {
            file: '/tmp/auth-flow.yml',
            title: 'Authentication flow',
            session: 'default:test:suite:1',
            status: 'passed',
            durationMs: 500,
            finalAttemptDurationMs: 500,
            attempts: 1,
            artifactsDir,
            replayed: 2,
            healed: 0,
          },
        ],
      },
    }));

    assert.equal(result.code, null);
    assert.equal(result.calls[0]?.meta?.debug, false);
    assert.doesNotMatch(result.stdout, /✓ "Authentication flow" in auth-flow\.yml \(0\.5s\)/);
    assert.doesNotMatch(result.stdout, /steps:/);
    assert.doesNotMatch(result.stdout, /tapOn "text=\\"Log in\\""/);
    assert.doesNotMatch(result.stdout, /assertVisible "text=\\"Home\\""/);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('test command --verbose omits nested passing step telemetry', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-cli-test-verbose-retry-'));
  const artifactsDir = path.join(tmpDir, 'material-top-tabs');
  const attemptDir = path.join(artifactsDir, 'attempt-1');
  await fs.mkdir(attemptDir, { recursive: true });
  await fs.writeFile(
    path.join(attemptDir, 'replay-timing.ndjson'),
    [
      {
        type: 'replay_action_start',
        step: 2,
        line: 4,
        command: 'retry',
        positionals: ['3'],
      },
      {
        type: 'replay_action_start',
        step: 2,
        line: 4,
        command: 'open',
        positionals: ['org.reactnavigation.playground', 'rne://material-top-tabs-basic'],
      },
      {
        type: 'replay_action_stop',
        step: 2,
        line: 4,
        command: 'open',
        ok: true,
        durationMs: 727,
      },
      {
        type: 'replay_action_start',
        step: 2.001,
        line: 4,
        command: '__maestroAssertVisible',
        positionals: ['label="Chat" || text="Chat" || id="Chat"', '60000'],
      },
      {
        type: 'replay_action_stop',
        step: 2.001,
        line: 4,
        command: '__maestroAssertVisible',
        ok: true,
        durationMs: 2580,
      },
      {
        type: 'replay_action_stop',
        step: 2,
        line: 4,
        command: 'retry',
        ok: true,
        durationMs: 3310,
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n'),
  );

  try {
    const result = await runCliCapture(['test', './suite', '--verbose'], async () => ({
      ok: true,
      data: {
        total: 1,
        executed: 1,
        passed: 1,
        failed: 0,
        skipped: 0,
        notRun: 0,
        durationMs: 3310,
        failures: [],
        tests: [
          {
            file: '/tmp/material-top-tabs.yml',
            title: 'Material Top Tabs - Basic',
            session: 'default:test:suite:1',
            status: 'passed',
            durationMs: 3310,
            finalAttemptDurationMs: 3310,
            attempts: 1,
            artifactsDir,
            replayed: 1,
            healed: 0,
          },
        ],
      },
    }));

    assert.equal(result.code, null);
    assert.doesNotMatch(
      result.stdout,
      /open "org\.reactnavigation\.playground" "rne:\/\/material-top-tabs-basic" \(line 4, 0\.727s\)/,
    );
    assert.doesNotMatch(
      result.stdout,
      /assertVisible "label=\\"Chat\\" \|\| text=\\"Chat\\" \|\| id=\\"Chat\\"" "60000" \(line 4, 2\.58s\)/,
    );
    assert.doesNotMatch(result.stdout, /retry "3" \(line 4, 3\.31s\)/);
    assert.doesNotMatch(
      result.stdout,
      /open "org\.reactnavigation\.playground" "rne:\/\/material-top-tabs-basic" \(line 4, 3\.31s\)/,
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('test command reports flaky passed-on-retry cases in the default summary', async () => {
  const result = await runCliCapture(['test', './suite'], async () => ({
    ok: true,
    data: {
      total: 1,
      executed: 1,
      passed: 1,
      failed: 0,
      skipped: 0,
      notRun: 0,
      durationMs: 25,
      failures: [],
      tests: [
        {
          file: '/tmp/auth-flow.yml',
          title: 'Authentication flow',
          session: 'default:test:suite:1',
          status: 'passed',
          durationMs: 112151,
          finalAttemptDurationMs: 17492,
          attempts: 2,
          attemptFailures: [
            {
              attempt: 1,
              message: 'Replay failed at step 3 (tapOn "Log in"): selector not found',
              durationMs: 94659,
            },
          ],
        },
      ],
    },
  }));

  assert.equal(result.code, null);
  assert.doesNotMatch(result.stderr, /Running replay suite\.\.\./);
  assert.doesNotMatch(result.stdout, /FLAKY/);
  assert.doesNotMatch(
    result.stdout,
    /^✓ "Authentication flow" in auth-flow\.yml \(passed attempt 17\.5s, total 112\.2s\)$/m,
  );
  assert.match(result.stdout, /Test summary: 1 passed, 0 failed, 1 flaky in 0\.025s/);
  assert.match(result.stdout, /Flaky tests:/);
  assert.match(
    result.stdout,
    /✓ "Authentication flow" in auth-flow\.yml after 2 attempts \(passed attempt 17\.5s, total 112\.2s\)/,
  );
  assert.match(
    result.stdout,
    /attempt 1 failed \(94\.7s\): Replay failed at step 3 \(tapOn "Log in"\): selector not found/,
  );
});

test('test command --debug prints failed attempt step window when timing trace exists', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-cli-test-steps-'));
  const artifactsDir = path.join(tmpDir, 'checkout-flow');
  const attemptDir = path.join(artifactsDir, 'attempt-2');
  await fs.mkdir(attemptDir, { recursive: true });
  await fs.writeFile(
    path.join(attemptDir, 'replay-timing.ndjson'),
    [
      {
        type: 'replay_action_start',
        step: 0,
        line: 2,
        command: 'close',
        positionals: ['Demo'],
      },
      {
        type: 'replay_action_stop',
        step: 0,
        line: 2,
        command: 'close',
        ok: true,
        durationMs: 50,
      },
      {
        type: 'replay_action_start',
        step: 1,
        line: 3,
        command: 'open',
        positionals: ['Demo'],
      },
      {
        type: 'replay_action_stop',
        step: 1,
        line: 3,
        command: 'open',
        ok: true,
        durationMs: 125,
        resultTiming: { launchMs: 100 },
      },
      {
        type: 'replay_action_start',
        step: 2,
        line: 4,
        command: '__maestroTapOn',
        positionals: ['text="Pay"'],
      },
      {
        type: 'replay_action_stop',
        step: 2,
        line: 4,
        command: '__maestroTapOn',
        ok: true,
        durationMs: 200,
      },
      {
        type: 'replay_action_start',
        step: 3,
        line: 5,
        command: '__maestroAssertVisible',
        positionals: ['text="Receipt"', '3000'],
      },
      {
        type: 'replay_action_stop',
        step: 3,
        line: 5,
        command: '__maestroAssertVisible',
        ok: false,
        durationMs: 1500,
        errorCode: 'ASSERTION_FAILED',
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n'),
  );

  try {
    const failedReplayResult = {
      file: '/tmp/checkout-flow.yml',
      title: 'Checkout flow',
      session: 'default:test:suite:1',
      status: 'failed',
      durationMs: 2000,
      attempts: 2,
      artifactsDir,
      error: {
        code: 'ASSERTION_FAILED',
        message: 'Replay failed at step 3 (assertVisible "Receipt"): selector not found',
      },
    };
    const result = await runCliCapture(['test', './suite', '--debug'], async () => ({
      ok: true,
      data: {
        total: 1,
        executed: 1,
        passed: 0,
        failed: 1,
        skipped: 0,
        notRun: 0,
        durationMs: 2000,
        failures: [failedReplayResult],
        tests: [failedReplayResult],
      },
    }));

    assert.equal(result.code, 1);
    assert.equal(result.calls[0]?.meta?.debug, true);
    assert.match(
      result.stdout,
      /Replay failed at step 3 \(assertVisible "Receipt"\): selector not found/,
    );
    assert.match(result.stdout, /steps \(attempt 2\):/);
    assert.doesNotMatch(result.stdout, /close "Demo" \(line 2, 0\.050s\)/);
    assert.match(result.stdout, /open "Demo" \(line 3, 0\.125s, timing \{"launchMs":100\}\)/);
    assert.match(result.stdout, /tapOn "text=\\"Pay\\"" \(line 4, 0\.2s\)/);
    assert.match(
      result.stdout,
      /\[FAIL\] assertVisible "text=\\"Receipt\\"" "3000" \(line 5, 1\.50s, ASSERTION_FAILED\)/,
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('test --maestro forwards Maestro backend and platform for directory suites', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-cli-maestro-suite-'));
  await fs.writeFile(
    path.join(tmpDir, 'auth-flow.yml'),
    ['appId: demo.app', '---', '- launchApp', ''].join('\n'),
  );

  try {
    const result = await runCliCapture(
      ['test', '--maestro', '--platform', 'android', tmpDir],
      async () => ({
        ok: true,
        data: {
          total: 1,
          executed: 1,
          passed: 1,
          failed: 0,
          skipped: 0,
          notRun: 0,
          durationMs: 5,
          failures: [],
          tests: [],
        },
      }),
    );

    assert.equal(result.code, null);
    assert.equal(result.calls.length, 1);
    assert.equal(result.calls[0]?.command, 'test');
    assert.deepEqual(result.calls[0]?.positionals, [tmpDir]);
    assert.equal(result.calls[0]?.flags?.replayBackend, 'maestro');
    assert.equal(result.calls[0]?.flags?.platform, 'android');
    assert.equal(result.calls[0]?.meta?.requestProgress, 'replay-test');
    assert.doesNotMatch(result.stderr, /Running replay suite\.\.\./);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('test forwards shard flags and comma device lists', async () => {
  const result = await runCliCapture(
    ['test', '--maestro', '--device', 'udid1,emulator-5554', '--shard-all', '2', './suite'],
    async () => ({
      ok: true,
      data: {
        total: 0,
        executed: 0,
        passed: 0,
        failed: 0,
        skipped: 0,
        notRun: 0,
        durationMs: 1,
        failures: [],
        tests: [],
      },
    }),
  );

  assert.equal(result.code, null);
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0]?.flags?.replayBackend, 'maestro');
  assert.equal(result.calls[0]?.flags?.device, 'udid1,emulator-5554');
  assert.equal(result.calls[0]?.flags?.shardAll, 2);
});

test('test command writes JUnit report with failure metadata', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-junit-test-'));
  const reportPath = path.join(tmpDir, 'replays.junit.xml');

  try {
    const result = await runCliCapture(
      ['test', './suite', '--report-junit', reportPath],
      async () => ({
        ok: true,
        data: {
          total: 3,
          executed: 3,
          passed: 1,
          failed: 1,
          skipped: 1,
          notRun: 0,
          durationMs: 25,
          failures: [
            {
              file: '/tmp/02-fail.ad',
              session: 'default:test:suite:2',
              status: 'failed',
              durationMs: 5,
              attempts: 2,
              artifactsDir: '/tmp/test-artifacts/02-fail',
              error: {
                code: 'COMMAND_FAILED',
                message: 'Replay failed at step 1 (open Demo): boom',
                hint: 'retry me',
                diagnosticId: 'diag-123',
                logPath: '/tmp/diag.ndjson',
                details: { command: 'open', reason: 'selector_not_found' },
              },
            },
          ],
          tests: [
            {
              file: '/tmp/01-flaky.ad',
              session: 'default:test:suite:1',
              status: 'passed',
              durationMs: 10,
              attempts: 2,
              replayed: 1,
              healed: 0,
            },
            {
              file: '/tmp/02-fail.ad',
              session: 'default:test:suite:2',
              status: 'failed',
              durationMs: 5,
              attempts: 2,
              artifactsDir: '/tmp/test-artifacts/02-fail',
              error: {
                code: 'COMMAND_FAILED',
                message: 'Replay failed at step 1 (open Demo): boom',
                hint: 'retry me',
                diagnosticId: 'diag-123',
                logPath: '/tmp/diag.ndjson',
                details: { command: 'open', reason: 'selector_not_found' },
              },
            },
            {
              file: '/tmp/03-skip.ad',
              status: 'skipped',
              durationMs: 0,
              message: 'not runnable',
              reason: 'skipped-by-filter',
            },
          ],
        },
      }),
    );

    assert.equal(result.code, 1);
    const xml = await fs.readFile(reportPath, 'utf8');
    assert.match(
      xml,
      /<testsuite name="agent-device replay suite" tests="3" failures="1" skipped="1" time="0\.025">/,
    );
    assert.match(
      xml,
      /<testcase classname="\/tmp" name="02-fail\.ad" file="\/tmp\/02-fail\.ad" time="0\.005">/,
    );
    assert.match(xml, /<failure message="Replay failed at step 1 \(open Demo\): boom">/);
    assert.match(xml, /diagnosticId: diag-123/);
    assert.match(xml, /logPath: \/tmp\/diag\.ndjson/);
    assert.match(xml, /artifactsDir: \/tmp\/test-artifacts\/02-fail/);
    assert.match(xml, /errorCode: COMMAND_FAILED/);
    assert.match(xml, /errorMessage: Replay failed at step 1 \(open Demo\): boom/);
    assert.match(
      xml,
      /details: \{&quot;command&quot;:&quot;open&quot;,&quot;reason&quot;:&quot;selector_not_found&quot;\}/,
    );
    assert.match(xml, /flaky: true/);
    assert.match(xml, /<skipped message="not runnable" \/>/);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
