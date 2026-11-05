import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempWorkspace } from '@agent-device/test-kit';
import { runCliCapture, type CapturedDaemonRequest } from './cli-capture.ts';

// The daemon reads one flag for this decision, `postGestureStabilization`. The CLI states the
// opt-out in its own words, so these pin where each source of the opt-out lands in the request
// the daemon receives, and that the default request is the one that existed before the option.
const SCROLL = ['scroll', 'down'] as const;
const SWIPE = ['swipe', '10', '10', '10', '200'] as const;

function daemonFlag(call: CapturedDaemonRequest | undefined): unknown {
  return call?.flags?.postGestureStabilization;
}

function carriesCallerKey(call: CapturedDaemonRequest | undefined): boolean {
  return Object.hasOwn(call?.flags ?? {}, 'noPostGestureStabilization');
}

test.each([
  ['scroll', SCROLL],
  ['swipe', SWIPE],
] as const)(
  '%s --no-post-gesture-stabilization reaches the daemon as postGestureStabilization: false',
  async (_command, argv) => {
    const optedOut = await runCliCapture([...argv, '--no-post-gesture-stabilization']);
    assert.equal(optedOut.code, null);
    assert.equal(daemonFlag(optedOut.calls[0]), false);
    assert.equal(carriesCallerKey(optedOut.calls[0]), false);

    const plain = await runCliCapture([...argv]);
    assert.equal(plain.code, null);
    assert.equal(plain.calls[0]?.command, argv[0]);
    assert.equal(Object.hasOwn(plain.calls[0]?.flags ?? {}, 'postGestureStabilization'), false);
    assert.equal(carriesCallerKey(plain.calls[0]), false);
  },
);

test('the opt-out from the environment reaches the daemon, and a command that ignores it is untouched', async () => {
  const env = { AGENT_DEVICE_NO_POST_GESTURE_STABILIZATION: '1' };

  const scroll = await runCliCapture([...SCROLL], { env });
  assert.equal(daemonFlag(scroll.calls[0]), false);

  const press = await runCliCapture(['press', '10', '20'], { env });
  assert.equal(press.code, null);
  assert.equal(press.calls[0]?.command, 'press');
  assert.equal(Object.hasOwn(press.calls[0]?.flags ?? {}, 'postGestureStabilization'), false);
});

test('the opt-out from the user config reaches the daemon', async () => {
  const { root, home, project } = makeTempWorkspace();
  fs.mkdirSync(path.join(home, '.agent-device'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.agent-device', 'config.json'),
    JSON.stringify({ noPostGestureStabilization: true }),
    'utf8',
  );

  const result = await runCliCapture([...SWIPE], { cwd: project, env: { HOME: home } });

  assert.equal(result.code, null);
  assert.equal(daemonFlag(result.calls[0]), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a repository config cannot switch the stabilization off for whoever runs it', async () => {
  const { root, home, project } = makeTempWorkspace();
  fs.writeFileSync(
    path.join(project, 'agent-device.json'),
    JSON.stringify({ noPostGestureStabilization: true }),
    'utf8',
  );

  const result = await runCliCapture([...SCROLL], { cwd: project, env: { HOME: home } });

  assert.equal(result.code, 1);
  assert.equal(result.calls.length, 0);
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /noPostGestureStabilization.*not allowed in project config file/s,
  );
  fs.rmSync(root, { recursive: true, force: true });
});
