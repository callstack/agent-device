import assert from 'node:assert/strict';
import { describe, expect, test } from 'vitest';
import { buildGesturePlan } from '../../../contracts/gesture-plan.ts';
import { readGesturePayload } from '../../../contracts/gesture-input.ts';
import { normalizePublicGesture } from '../../../contracts/gesture-normalization.ts';
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
        command: 'gesture',
        positionals: [],
        input: {
          kind: 'pan',
          origin: { x: 90, y: 50 },
          delta: { x: -80, y: 0 },
          durationMs: 400,
        },
        flags: { postGestureStabilization: false },
        internal: {
          gestureExecutionProfile: 'endpoint-hold',
          gestureViewport: { x: 0, y: 0, width: 100, height: 200 },
        },
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

  test('preserves endpoint-hold for swipes without a viewport and omits scroll duration', () => {
    expect(
      projectMaestroPublicOperation({
        kind: 'swipe',
        gesture: { from: { x: 1, y: 2 }, to: { x: 3, y: 4 }, durationMs: 5 },
      }),
    ).toMatchObject({
      command: 'gesture',
      internal: { gestureExecutionProfile: 'endpoint-hold' },
    });
    expect(projectMaestroPublicOperation({ kind: 'scroll', direction: 'up' })).not.toHaveProperty(
      'input',
    );
  });

  test('a 400 ms Maestro swipe reaches plan execution with endpoint-hold profile', () => {
    const viewport = { x: 0, y: 0, width: 400, height: 800 };
    const projected = projectMaestroPublicOperation({
      kind: 'swipe',
      gesture: { from: { x: 360, y: 430 }, to: { x: 40, y: 430 }, durationMs: 400 },
      viewport,
    });
    const input = readGesturePayload(projected.input);
    const normalized = normalizePublicGesture(input);
    if (normalized.gesture.intent === 'pan' && projected.internal?.gestureExecutionProfile) {
      normalized.gesture.executionProfile = projected.internal.gestureExecutionProfile;
    }
    const plan = buildGesturePlan(
      normalized.gesture,
      projected.internal?.gestureViewport ?? viewport,
    );
    assert.equal(plan.topology, 'single');
    assert.equal(plan.intent, 'pan');
    assert.equal(plan.executionProfile, 'endpoint-hold');
    assert.equal(plan.durationMs, 400);
  });
});
