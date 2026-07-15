import { describe, expect, test } from 'vitest';
import {
  projectMaestroPublicOperation,
  type MaestroPublicOperation,
} from '../daemon-runtime-public-operation.ts';

describe('Maestro public operation projection', () => {
  test.each<{
    operation: MaestroPublicOperation;
    expected: ReturnType<typeof projectMaestroPublicOperation>;
  }>([
    {
      operation: {
        kind: 'launchApp',
        appId: 'com.example',
        relaunch: true,
        clearState: false,
        launchArgs: ['--mode', 'test'],
      },
      expected: {
        command: 'open',
        positionals: ['com.example'],
        flags: { relaunch: true, launchArgs: ['--mode', 'test'] },
      },
    },
    {
      operation: {
        kind: 'launchApp',
        relaunch: false,
        clearState: true,
        launchArgs: [],
      },
      expected: { command: 'open', positionals: [], flags: { clearAppState: true } },
    },
    {
      operation: { kind: 'stopApp', appId: 'com.example' },
      expected: {
        command: 'close',
        positionals: ['com.example'],
        internal: { closeAppOnly: true },
      },
    },
    {
      operation: { kind: 'stopApp' },
      expected: { command: 'close', positionals: [], internal: { closeAppOnly: true } },
    },
    {
      operation: {
        kind: 'openLink',
        appId: 'com.example',
        link: 'example://home',
        prewarmRunner: true,
      },
      expected: {
        command: 'open',
        positionals: ['com.example', 'example://home'],
        flags: { maestro: { prewarmRunnerBeforeOpen: true } },
      },
    },
    {
      operation: { kind: 'openLink', link: 'example://home', prewarmRunner: false },
      expected: { command: 'open', positionals: ['example://home'] },
    },
    {
      operation: { kind: 'typeText', text: 'hello' },
      expected: { command: 'type', positionals: ['hello'] },
    },
    {
      operation: {
        kind: 'clickSelector',
        selector: { key: 'id', value: 'submit' },
        expectedPoint: { x: 10, y: 20 },
        options: { count: 2 },
      },
      expected: {
        command: 'click',
        positionals: ['id="submit"'],
        flags: {
          count: 2,
          maestro: {
            allowNonHittableCoordinateFallback: true,
            expectedTapPoint: { x: 10, y: 20 },
          },
        },
      },
    },
    {
      operation: { kind: 'clickPoint', point: { x: 10, y: 20 }, options: { holdMs: 3000 } },
      expected: { command: 'click', positionals: ['10', '20'], flags: { holdMs: 3000 } },
    },
    {
      operation: {
        kind: 'swipe',
        gesture: { from: { x: 90, y: 50 }, to: { x: 10, y: 50 }, durationMs: 400 },
        viewport: { x: 0, y: 0, width: 100, height: 200 },
      },
      expected: {
        command: 'swipe',
        positionals: [],
        input: { from: { x: 90, y: 50 }, to: { x: 10, y: 50 }, durationMs: 400 },
        flags: { postGestureStabilization: false },
        internal: { gestureViewport: { x: 0, y: 0, width: 100, height: 200 } },
      },
    },
    {
      operation: {
        kind: 'scroll',
        direction: 'down',
        durationMs: 601,
      },
      expected: {
        command: 'scroll',
        positionals: ['down'],
        input: { direction: 'down', durationMs: 601 },
        flags: { postGestureStabilization: false },
      },
    },
    {
      operation: { kind: 'pressKey', key: 'back' },
      expected: { command: 'back', positionals: [] },
    },
    {
      operation: { kind: 'pressKey', key: 'enter' },
      expected: { command: 'keyboard', positionals: ['enter'] },
    },
    {
      operation: { kind: 'screenshot', path: '/tmp/screen.png' },
      expected: { command: 'screenshot', positionals: ['/tmp/screen.png'] },
    },
    {
      operation: { kind: 'screenshot', path: '/tmp/animation.png', stabilize: false },
      expected: {
        command: 'screenshot',
        positionals: ['/tmp/animation.png'],
        flags: { screenshotNoStabilize: true },
      },
    },
    {
      operation: {
        kind: 'screenshot',
        path: '/tmp/animation-runner.png',
        stabilize: false,
        captureBackend: 'runner',
      },
      expected: {
        command: 'screenshot',
        positionals: ['/tmp/animation-runner.png'],
        flags: {
          screenshotNoStabilize: true,
          maestro: { screenshotCaptureBackend: 'runner' },
        },
      },
    },
    {
      operation: { kind: 'snapshot' },
      expected: {
        command: 'snapshot',
        positionals: [],
        flags: { noRecord: true },
      },
    },
  ])('projects $operation.kind', ({ operation, expected }) => {
    expect(projectMaestroPublicOperation(operation)).toEqual(expected);
  });

  test('omits optional swipe and scroll fields', () => {
    expect(
      projectMaestroPublicOperation({
        kind: 'swipe',
        gesture: { from: { x: 1, y: 2 }, to: { x: 3, y: 4 }, durationMs: 5 },
      }),
    ).not.toHaveProperty('internal');
    expect(projectMaestroPublicOperation({ kind: 'scroll', direction: 'up' })).not.toHaveProperty(
      'input',
    );
  });
});
