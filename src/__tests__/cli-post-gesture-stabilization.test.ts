import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempWorkspace } from '@agent-device/test-kit';
import { runCliCapture, type CapturedDaemonRequest } from './cli-capture.ts';

// One key, `postGestureStabilization`, names this decision in the CLI token, the environment, the
// user config, and the request the daemon receives. These pin where each source of the opt-out
// lands in that request, and that the default request is the one that existed before the option.
const SCROLL = ['scroll', 'down'] as const;
const SWIPE = ['swipe', '10', '10', '10', '200'] as const;
const GESTURE_SWIPE = ['gesture', 'swipe', 'left'] as const;

function daemonFlag(call: CapturedDaemonRequest | undefined): unknown {
  return call?.flags?.postGestureStabilization;
}

test.each([
  ['scroll', SCROLL],
  ['swipe', SWIPE],
  ['gesture swipe', GESTURE_SWIPE],
] as const)(
  '%s --no-post-gesture-stabilization reaches the daemon as postGestureStabilization: false',
  async (_command, argv) => {
    const optedOut = await runCliCapture([...argv, '--no-post-gesture-stabilization']);
    assert.equal(optedOut.code, null);
    assert.equal(daemonFlag(optedOut.calls[0]), false);

    const plain = await runCliCapture([...argv]);
    assert.equal(plain.code, null);
    assert.equal(plain.calls[0]?.command, argv[0]);
    assert.equal(Object.hasOwn(plain.calls[0]?.flags ?? {}, 'postGestureStabilization'), false);
  },
);

test.each(['0', 'false'])(
  'AGENT_DEVICE_POST_GESTURE_STABILIZATION=%s reaches the daemon, and a command that ignores it is untouched',
  async (value) => {
    const env = { AGENT_DEVICE_POST_GESTURE_STABILIZATION: value };

    const scroll = await runCliCapture([...SCROLL], { env });
    assert.equal(daemonFlag(scroll.calls[0]), false);

    const press = await runCliCapture(['press', '10', '20'], { env });
    assert.equal(press.code, null);
    assert.equal(press.calls[0]?.command, 'press');
    assert.equal(Object.hasOwn(press.calls[0]?.flags ?? {}, 'postGestureStabilization'), false);

    // The default reaches every `gesture` kind's reader, and a kind that never stabilizes keeps it out.
    const pinch = await runCliCapture(['gesture', 'pinch', '2'], { env });
    assert.equal(pinch.code, null);
    assert.equal(pinch.calls[0]?.command, 'gesture');
    assert.equal(Object.hasOwn(pinch.calls[0]?.flags ?? {}, 'postGestureStabilization'), false);
    const gestureSwipe = await runCliCapture([...GESTURE_SWIPE], { env });
    assert.equal(daemonFlag(gestureSwipe.calls[0]), false);
  },
);

test('the opt-out from the user config reaches the daemon', async () => {
  const { root, home, project } = makeTempWorkspace();
  fs.mkdirSync(path.join(home, '.agent-device'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.agent-device', 'config.json'),
    JSON.stringify({ postGestureStabilization: false }),
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
    JSON.stringify({ postGestureStabilization: false }),
    'utf8',
  );

  const result = await runCliCapture([...SCROLL], { cwd: project, env: { HOME: home } });

  assert.equal(result.code, 1);
  assert.equal(result.calls.length, 0);
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /postGestureStabilization.*not allowed in project config file/s,
  );
  fs.rmSync(root, { recursive: true, force: true });
});
