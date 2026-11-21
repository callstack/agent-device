import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createLinuxHostStub } from './toolbox.fixtures.ts';
import { createLinuxInteractor } from './interactor.ts';
import { createLinuxToolProvider } from './tool-provider.ts';
import { buildGesturePlan } from '@agent-device/gestures/gesture-plan';

function host(
  tools: readonly string[] = ['xdotool'],
  overrides: Parameters<typeof createLinuxToolProvider>[1] = {},
) {
  const stub = createLinuxHostStub({
    env: { PATH: '/usr/bin', XDG_SESSION_TYPE: 'x11' },
    tools,
    respond: () => ({}),
  });
  // Pacing replaced: this file is about which route each interactor method takes, not about clocks.
  const provider = createLinuxToolProvider(stub.toolbox, { sleep: async () => {}, ...overrides });
  return { stub, interactor: createLinuxInteractor(stub.toolbox, provider) };
}

function commands(stub: ReturnType<typeof host>['stub']): Array<[string, readonly string[]]> {
  return stub.commands.map((command) => [command.executable, command.args]);
}

test('the Linux interactor routes alternate buttons to the alternate-button routes', async () => {
  const { stub, interactor } = host();

  await interactor.alternateClick!({ x: 10, y: 20 }, 'secondary');
  await interactor.alternateClick!({ x: 30, y: 40 }, 'middle');

  // Button 3 is the secondary button and button 2 the middle one in xdotool's numbering, and a
  // primary press is never substituted for either.
  assert.deepEqual(commands(stub), [
    ['xdotool', ['getmouselocation', '--shell']],
    ['xdotool', ['mousemove', '--sync', '10', '20']],
    ['xdotool', ['click', '3']],
    ['xdotool', ['getmouselocation', '--shell']],
    ['xdotool', ['mousemove', '--sync', '30', '40']],
    ['xdotool', ['click', '2']],
  ]);
});

test('the Linux interactor executes a planned fling as one drag with the resolved duration', async () => {
  const { stub, interactor } = host();
  const plan = buildGesturePlan(
    { intent: 'fling', from: { x: 10, y: 20 }, to: { x: 110, y: 20 } },
    { x: 0, y: 0, width: 200, height: 200 },
    'linux',
  );

  await interactor.performGesture!(plan);

  assert.deepEqual(commands(stub), [
    ['xdotool', ['getmouselocation', '--shell']],
    ['xdotool', ['mousemove', '--sync', '10', '20']],
    ['xdotool', ['mousedown', '1']],
    ['xdotool', ['mousemove', '--sync', '110', '20']],
    ['xdotool', ['mouseup', '1']],
  ]);
});

test('the Linux interactor refuses a multi-touch plan', async () => {
  const { stub, interactor } = host();
  const plan = buildGesturePlan(
    { intent: 'pinch', scale: 2 },
    { x: 0, y: 0, width: 2000, height: 2000 },
    'linux',
  );
  assert.equal(plan.topology, 'multi');

  await assert.rejects(() => interactor.performGesture!(plan), /Multi-touch/);
  assert.deepEqual(stub.commands, []);
});

test('the Linux interactor routes lifecycle and clipboard intents to the desktop tools', async () => {
  const { stub, interactor } = host(['xdotool', 'wmctrl', 'xdg-open', 'xclip', 'demo-app']);

  await interactor.open('demo-app');
  await interactor.close('Demo');
  await interactor.writeClipboard!('copied');
  await interactor.readClipboard!();

  const spawned = commands(stub);
  assert.deepEqual(
    stub.launches.map((launch) => [launch.executable, [...launch.args]]),
    [['demo-app', []]],
  );
  assert.deepEqual(
    spawned.map(([executable]) => executable),
    ['wmctrl', 'xclip', 'xclip'],
  );
  assert.equal(spawned[0]![1][0], '-c');
  assert.equal(spawned[1]![1].includes('-o'), false);
  assert.equal(spawned[2]![1].includes('-o'), true);
});

test('the Linux interactor reports the unsupported device intents rather than approximating them', async () => {
  const { interactor } = host();

  await assert.rejects(() => interactor.setOrientation!('portrait'), /orientation/);
  await assert.rejects(() => interactor.appSwitcher!(), /appSwitcher/);
  await assert.rejects(() => interactor.tvRemote!('back'), /tv-remote/);
  await assert.rejects(() => interactor.setSetting!('darkMode', 'on'), /setSetting/);
});

test('the Linux interactor reports a capture through the plugin producer', async () => {
  const { interactor } = host(['xdotool'], {
    accessibility: {
      captureTree: async (surface) => ({ nodes: [], truncated: false, surface }),
    },
  });

  const snapshot = await interactor.snapshot!({ surface: 'desktop' });

  // The Linux capture is a plain one: the plugin stamps its own producer rather than asking the core
  // for a desktop-surface capture.
  assert.equal('producer' in snapshot ? snapshot.producer : undefined, 'linux-atspi');
});

test('the Linux interactor reads text at a point from the captured tree', async () => {
  const { interactor } = host(['xdotool'], {
    accessibility: {
      captureTree: async (surface) => ({
        nodes: [
          {
            index: 0,
            type: 'Text',
            value: 'menu bar',
            rect: { x: 0, y: 0, width: 400, height: 40 },
            depth: 0,
          },
        ],
        truncated: false,
        surface,
      }),
    },
  });

  assert.equal(await interactor.readTextAtPoint!({ x: 5, y: 5 }), 'menu bar');
});
