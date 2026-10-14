import {
  maestroReplayFixture,
  type CapturedInvocation,
} from './session-replay-runtime-maestro.fixtures.ts';
import assert from 'node:assert/strict';
import { test } from 'vitest';

const { runReplayFixture } = maestroReplayFixture;

test('runReplayCommand resolves a text-entry target once before typing', async () => {
  const calls: CapturedInvocation[] = [];
  const { response } = await runReplayFixture({
    label: 'maestro-tap-input-text-snapshot',
    script: [
      'appId: demo.app',
      '---',
      '- tapOn:',
      '    id: editableNameInput',
      '- inputText: Saved list',
      '- pressKey: Enter',
      '',
    ].join('\n'),
    flags: { replayBackend: 'maestro', platform: 'android' },
    invoke: async (req) => {
      calls.push({ command: req.command, positionals: req.positionals, flags: req.flags });
      if (req.command === 'snapshot') {
        return {
          ok: true,
          data: {
            nodes: [
              {
                index: 1,
                identifier: 'editableNameInput',
                rect: { x: 20, y: 100, width: 200, height: 40 },
              },
            ],
          },
        };
      }
      return { ok: true, data: {} };
    },
  });

  assert.equal(response.ok, true);
  assert.deepEqual(
    calls.map((call) => [call.command, call.positionals]),
    [
      ['snapshot', []],
      ['click', ['120', '120']],
      ['snapshot', []],
      ['type', ['Saved list']],
      ['snapshot', []],
      ['snapshot', []],
      ['keyboard', ['enter']],
    ],
  );
});

test('runReplayCommand resolves scalar Maestro swipe.from to an element rect', async () => {
  const calls: CapturedInvocation[] = [];
  const { response } = await runReplayFixture({
    label: 'maestro-swipe-label',
    script: [
      'appId: demo.app',
      '---',
      '- swipe:',
      '    from: Thread body',
      '    direction: UP',
      '    duration: 400',
      '',
    ].join('\n'),
    flags: { replayBackend: 'maestro' },
    invoke: async (req) => {
      calls.push({
        command: req.command,
        positionals: req.positionals,
        input: req.input,
        flags: req.flags,
      });
      if (req.command === 'snapshot') {
        return {
          ok: true,
          data: {
            nodes: [
              {
                index: 1,
                label: 'Thread body',
                rect: { x: 10, y: 100, width: 200, height: 300 },
              },
            ],
          },
        };
      }
      return { ok: true, data: {} };
    },
  });

  assert.equal(response.ok, true);
  assert.deepEqual(
    calls.map((call) => [call.command, call.input]),
    [
      ['snapshot', undefined],
      [
        'gesture',
        {
          kind: 'pan',
          origin: { x: 110, y: 250 },
          delta: { x: 0, y: -210 },
          durationMs: 400,
        },
      ],
    ],
  );
});

test('runReplayCommand anchors scalar Maestro swipe.from to the matched element rect', async () => {
  const calls: CapturedInvocation[] = [];
  const { response } = await runReplayFixture({
    label: 'maestro-swipe-label-child-rect',
    script: [
      'appId: demo.app',
      '---',
      '- swipe:',
      '    from: Article',
      '    direction: UP',
      '    duration: 400',
      '',
    ].join('\n'),
    flags: { replayBackend: 'maestro', platform: 'ios' },
    invoke: async (req) => {
      calls.push({
        command: req.command,
        positionals: req.positionals,
        input: req.input,
        flags: req.flags,
      });
      if (req.command === 'snapshot') {
        return {
          ok: true,
          data: {
            nodes: [
              {
                index: 1,
                type: 'XCUIElementTypeButton',
                rect: { x: 40, y: 100, width: 120, height: 48 },
                hittable: true,
              },
              {
                index: 2,
                parentIndex: 1,
                type: 'XCUIElementTypeStaticText',
                label: 'Article',
                rect: { x: 76, y: 114, width: 48, height: 20 },
                hittable: false,
              },
            ],
          },
        };
      }
      return { ok: true, data: {} };
    },
  });

  assert.equal(response.ok, true);
  assert.deepEqual(
    calls.map((call) => [call.command, call.input]),
    [
      ['snapshot', undefined],
      [
        'gesture',
        {
          kind: 'pan',
          origin: { x: 100, y: 124 },
          delta: { x: 0, y: -110 },
          durationMs: 400,
        },
      ],
    ],
  );
});

test('runReplayCommand resolves Maestro screen swipes from the admitted runtime viewport', async () => {
  const { response, calls } = await runReplayFixture({
    label: 'maestro-screen-swipe',
    script: [
      'appId: demo.app',
      '---',
      '- swipe:',
      '    direction: LEFT',
      '    duration: 300',
      '- swipe:',
      '    start: 90%,50%',
      '    end: 10%,50%',
      '    duration: 300',
      '',
    ].join('\n'),
    flags: { replayBackend: 'maestro' },
    sessionPlatform: 'ios',
  });

  assert.equal(response.ok, true);
  assert.deepEqual(
    calls.map((call) => [call.command, call.input]),
    [
      ['runtime', undefined],
      [
        'gesture',
        {
          kind: 'pan',
          origin: { x: 340, y: 400 },
          delta: { x: -280, y: 0 },
          durationMs: 300,
        },
      ],
      ['snapshot', undefined],
      ['snapshot', undefined],
      ['runtime', undefined],
      [
        'gesture',
        {
          kind: 'pan',
          origin: { x: 360, y: 400 },
          delta: { x: -320, y: 0 },
          durationMs: 300,
        },
      ],
    ],
  );
});

test('runReplayCommand delegates Android directional swipes and preserves percentage points', async () => {
  const { response, calls } = await runReplayFixture({
    label: 'maestro-screen-swipe-android-midpoint-lane',
    script: [
      'appId: demo.app',
      '---',
      '- swipe:',
      '    direction: LEFT',
      '    duration: 300',
      '- swipe:',
      '    start: 90%,50%',
      '    end: 10%,50%',
      '    duration: 300',
      '',
    ].join('\n'),
    flags: { replayBackend: 'maestro', platform: 'android' },
    sessionPlatform: 'android',
  });

  assert.equal(response.ok, true);
  assert.deepEqual(
    calls.map((call) => [call.command, call.input]),
    [
      ['runtime', undefined],
      [
        'gesture',
        {
          kind: 'pan',
          origin: { x: 340, y: 400 },
          delta: { x: -280, y: 0 },
          durationMs: 300,
        },
      ],
      ['snapshot', undefined],
      ['snapshot', undefined],
      ['runtime', undefined],
      [
        'gesture',
        {
          kind: 'pan',
          origin: { x: 360, y: 400 },
          delta: { x: -320, y: 0 },
          durationMs: 300,
        },
      ],
    ],
  );
});
