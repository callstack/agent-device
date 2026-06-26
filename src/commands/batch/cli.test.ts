import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DaemonResponse } from '../../daemon-client.ts';
import {
  runCliCapture as captureCli,
  type CapturedCliRun,
  type CapturedDaemonRequest,
  type CliCaptureOptions,
} from '../../__tests__/cli-capture.ts';

const batchDefaultResponse: DaemonResponse = {
  ok: true,
  data: { total: 0, executed: 0, totalDurationMs: 1, results: [] },
};

function runCliCapture(
  argv: string[],
  responder?: (req: CapturedDaemonRequest) => Promise<DaemonResponse>,
  options?: CliCaptureOptions,
): Promise<CapturedCliRun> {
  return captureCli(argv, responder, { ...options, defaultResponse: batchDefaultResponse });
}

test('batch --steps parses JSON and forwards batchSteps only', async () => {
  const result = await runCliCapture([
    'batch',
    '--session',
    'sim',
    '--platform',
    'ios',
    '--steps',
    '[{"command":"open","input":{"app":"settings"}}]',
    '--json',
  ]);
  assert.equal(result.code, null);
  assert.equal(result.calls.length, 1);
  const req = result.calls[0]!;
  assert.equal(req.command, 'batch');
  assert.equal(req.session, 'sim');
  assert.equal(req.flags?.platform, 'ios');
  assert.ok(Array.isArray(req.flags?.batchSteps));
  assert.equal((req.flags?.batchSteps ?? [])[0]?.command, 'open');
  assert.equal(Object.hasOwn(req.flags ?? {}, 'steps'), false);
});

test('batch --steps-file parses file payload', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-batch-'));
  const stepsPath = path.join(tmpDir, 'steps.json');
  fs.writeFileSync(
    stepsPath,
    JSON.stringify([{ command: 'wait', input: { kind: 'duration', durationMs: 100 } }]),
    'utf8',
  );
  const result = await runCliCapture(['batch', '--steps-file', stepsPath, '--json']);
  assert.equal(result.code, null);
  assert.equal(result.calls.length, 1);
  const req = result.calls[0]!;
  assert.equal(req.command, 'batch');
  assert.equal((req.flags?.batchSteps ?? [])[0]?.command, 'wait');
});

test('batch structured interaction target is projected to positionals, not device flags', async () => {
  const result = await runCliCapture([
    'batch',
    '--steps',
    '[{"command":"press","input":{"target":{"kind":"point","x":10,"y":20},"count":2,"platform":"ios","udid":"sim-1"}}]',
    '--json',
  ]);

  assert.equal(result.code, null);
  assert.equal(result.calls.length, 1);
  const step = (result.calls[0]?.flags?.batchSteps ?? [])[0];
  assert.deepEqual(step?.positionals, ['10', '20']);
  assert.equal(step?.flags?.target, undefined);
  assert.equal(step?.flags?.count, 2);
  assert.equal(step?.flags?.platform, 'ios');
  assert.equal(step?.flags?.udid, 'sim-1');
});

test('batch rejects invalid structured step input before daemon projection', async () => {
  const result = await runCliCapture([
    'batch',
    '--steps',
    '[{"command":"focus","input":{"x":10}}]',
  ]);

  assert.equal(result.code, 1);
  assert.equal(result.calls.length, 0);
  assert.match(result.stderr, /Batch step 1 focus input is invalid: Expected y to be set\./);
  assert.doesNotMatch(result.stderr, /undefined/);
});

test('batch rejects structured scroll duration above the shared cap before daemon projection', async () => {
  const result = await runCliCapture([
    'batch',
    '--steps',
    '[{"command":"scroll","input":{"direction":"down","pixels":200,"durationMs":10001}}]',
  ]);

  assert.equal(result.code, 1);
  assert.equal(result.calls.length, 0);
  assert.match(
    result.stderr,
    /Batch step 1 scroll input is invalid: Expected durationMs to be at most 10000\./,
  );
});

test('batch rejects structured replay steps before daemon dispatch', async () => {
  const result = await runCliCapture([
    'batch',
    '--steps',
    '[{"command":"replay","input":{"path":"flow.ad"}}]',
  ]);

  assert.equal(result.code, 1);
  assert.equal(result.calls.length, 0);
  assert.match(result.stderr, /not available through command batch/);
});

test('batch rejects invalid structured runtime without falling back to legacy parsing', async () => {
  const result = await runCliCapture([
    'batch',
    '--steps',
    '[{"command":"open","input":{"app":"settings"},"runtime":null}]',
  ]);

  assert.equal(result.code, 1);
  assert.equal(result.calls.length, 0);
  assert.match(result.stderr, /Batch step 1 runtime is invalid/);
  assert.doesNotMatch(result.stderr, /unknown legacy field\(s\): input/);
});

test('batch accepts legacy positionals/flags steps with deprecation warning', async () => {
  const result = await runCliCapture([
    'batch',
    '--steps',
    '[{"command":"open","positionals":["settings"],"flags":{"platform":"ios"}}]',
    '--json',
  ]);
  assert.equal(result.code, null);
  assert.match(result.stderr, /positionals\/flags are deprecated.*next major version/);
  assert.equal(result.calls.length, 1);
  const req = result.calls[0]!;
  assert.equal(req.command, 'batch');
  assert.deepEqual((req.flags?.batchSteps ?? [])[0], {
    command: 'open',
    positionals: ['settings'],
    flags: { platform: 'ios' },
    runtime: undefined,
  });
});

test('batch rejects hybrid structured and legacy step shapes', async () => {
  const result = await runCliCapture([
    'batch',
    '--steps',
    '[{"command":"open","input":{},"positionals":["settings"]}]',
  ]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /unknown legacy field\(s\): input/);
});

test('batch --steps-file returns clear error for missing file', async () => {
  const result = await runCliCapture([
    'batch',
    '--steps-file',
    '/tmp/definitely-missing-batch-steps.json',
  ]);
  assert.equal(result.code, 1);
  assert.equal(result.calls.length, 0);
  assert.match(result.stderr, /Failed to read --steps-file/);
});

test('batch --steps-file rejects invalid JSON payload', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-batch-invalid-'));
  const stepsPath = path.join(tmpDir, 'steps.json');
  fs.writeFileSync(stepsPath, '{"command":"open"', 'utf8');
  const result = await runCliCapture(['batch', '--steps-file', stepsPath]);
  assert.equal(result.code, 1);
  assert.equal(result.calls.length, 0);
  assert.match(result.stderr, /Batch steps must be valid JSON/);
});

test('batch forwards strip lock policy for nested steps when bound session uses strip mode', async () => {
  const result = await runCliCapture(
    [
      'batch',
      '--steps',
      '[{"command":"snapshot","input":{"platform":"android","serial":"emulator-5554"}}]',
      '--json',
    ],
    undefined,
    {
      env: {
        AGENT_DEVICE_SESSION: 'qa-ios',
        AGENT_DEVICE_PLATFORM: 'ios',
        AGENT_DEVICE_SESSION_LOCK: 'strip',
      },
    },
  );
  assert.equal(result.code, null);
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0]?.meta?.lockPolicy, 'strip');
  assert.equal(result.calls[0]?.meta?.lockPlatform, 'ios');
  const stepFlags = (result.calls[0]?.flags?.batchSteps ?? [])[0]?.flags ?? {};
  assert.equal(stepFlags.platform, 'android');
  assert.equal(stepFlags.serial, 'emulator-5554');
});

test('batch forwards reject lock policy for target retargeting', async () => {
  const result = await runCliCapture(
    ['batch', '--steps', '[{"command":"open","input":{"target":"tv"}}]', '--json'],
    undefined,
    {
      env: {
        AGENT_DEVICE_PLATFORM: 'ios',
        AGENT_DEVICE_SESSION_LOCK: 'reject',
      },
    },
  );
  assert.equal(result.code, null);
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0]?.meta?.lockPolicy, 'reject');
  const stepFlags = (result.calls[0]?.flags?.batchSteps ?? [])[0]?.flags ?? {};
  assert.equal(stepFlags.target, 'tv');
});

test('batch session lock flags apply to nested steps without env configuration', async () => {
  const result = await runCliCapture(
    [
      'batch',
      '--session-lock',
      'strip',
      '--steps',
      '[{"command":"snapshot","input":{"target":"tv","serial":"emulator-5554"}}]',
      '--json',
    ],
    undefined,
    {
      env: {
        AGENT_DEVICE_PLATFORM: 'ios',
      },
    },
  );
  assert.equal(result.code, null);
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0]?.meta?.lockPolicy, 'strip');
  assert.equal(result.calls[0]?.meta?.lockPlatform, 'ios');
  assert.equal(result.calls[0]?.flags?.platform, 'ios');
  const stepFlags = (result.calls[0]?.flags?.batchSteps ?? [])[0]?.flags ?? {};
  assert.equal(stepFlags.platform, 'ios');
  assert.equal(stepFlags.target, 'tv');
  assert.equal(stepFlags.serial, 'emulator-5554');
});

test('batch step without explicit platform inherits parent platform over env default', async () => {
  const previousPlatform = process.env.AGENT_DEVICE_PLATFORM;
  process.env.AGENT_DEVICE_PLATFORM = 'ios';

  try {
    const result = await runCliCapture([
      'batch',
      '--platform',
      'android',
      '--steps',
      '[{"command":"snapshot","input":{}}]',
      '--json',
    ]);
    assert.equal(result.code, null);
    assert.equal(result.calls.length, 1);
    const stepFlags = (result.calls[0]?.flags?.batchSteps ?? [])[0]?.flags ?? {};
    assert.equal(stepFlags.platform, 'android');
  } finally {
    if (previousPlatform === undefined) delete process.env.AGENT_DEVICE_PLATFORM;
    else process.env.AGENT_DEVICE_PLATFORM = previousPlatform;
  }
});

test('batch human output renders per-step results', async () => {
  const result = await runCliCapture(
    ['batch', '--steps', '[{"command":"open","input":{}}]'],
    async () => ({
      ok: true,
      data: {
        total: 2,
        executed: 2,
        totalDurationMs: 15,
        results: [
          {
            step: 1,
            command: 'open',
            ok: true,
            data: { appName: 'Settings', message: 'Opened: Settings' },
            durationMs: 7,
          },
          {
            step: 2,
            command: 'type',
            ok: true,
            data: { text: 'hello', message: 'Typed 5 chars' },
            durationMs: 8,
          },
        ],
      },
    }),
  );

  assert.equal(result.code, null);
  assert.match(result.stdout, /Batch completed: 2\/2 steps in 15ms/);
  assert.match(result.stdout, /1\. OK Opened: Settings \(7ms\)/);
  assert.match(result.stdout, /2\. OK Typed 5 chars \(8ms\)/);
});
