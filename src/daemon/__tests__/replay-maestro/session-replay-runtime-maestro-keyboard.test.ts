import {
  maestroReplayFixture,
  type CapturedInvocation,
} from './session-replay-runtime-maestro.fixtures.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'vitest';
import { PNG } from '@agent-device/capture-kit/png';

const { runReplayFixture } = maestroReplayFixture;

test('runReplayCommand maps Maestro enter to keyboard enter', async () => {
  const calls: CapturedInvocation[] = [];
  const { response } = await runReplayFixture({
    label: 'maestro-press-enter',
    script: ['appId: demo.app', '---', '- pressKey: Enter', ''].join('\n'),
    flags: { replayBackend: 'maestro' },
    invoke: async (req) => {
      calls.push({ command: req.command, positionals: req.positionals, flags: req.flags });
      return { ok: true, data: {} };
    },
  });

  assert.equal(response.ok, true);
  assert.deepEqual(
    calls.map((call) => [call.command, call.positionals]),
    [['keyboard', ['enter']]],
  );
});

test('runReplayCommand waits for Maestro animation screenshots to stabilize', async () => {
  const calls: CapturedInvocation[] = [];
  const screenshot = PNG.sync.write(new PNG({ width: 1, height: 1 }));
  const { response } = await runReplayFixture({
    label: 'maestro-wait-animation-stable',
    script: ['appId: demo.app', '---', '- waitForAnimationToEnd:', '    timeout: 0', ''].join('\n'),
    flags: { replayBackend: 'maestro' },
    invoke: async (req) => {
      calls.push({ command: req.command, positionals: req.positionals, flags: req.flags });
      if (req.command === 'screenshot') fs.writeFileSync(req.positionals[0]!, screenshot);
      return { ok: true, data: {} };
    },
  });

  assert.equal(response.ok, true);
  assert.deepEqual(
    calls.map((call) => [call.command, call.positionals]),
    [
      ['screenshot', [calls[0]?.positionals?.[0]]],
      ['screenshot', [calls[1]?.positionals?.[0]]],
    ],
  );
  assert.equal(calls[0]?.flags?.screenshotNoStabilize, true);
  assert.equal(calls[1]?.flags?.screenshotNoStabilize, true);
});

test('runReplayCommand propagates unsupported keyboard enter dispatch', async () => {
  const calls: CapturedInvocation[] = [];
  const { response } = await runReplayFixture({
    label: 'maestro-press-enter-unsupported',
    script: ['appId: demo.app', '---', '- pressKey: Enter', ''].join('\n'),
    flags: { replayBackend: 'maestro' },
    invoke: async (req) => {
      calls.push({ command: req.command, positionals: req.positionals, flags: req.flags });
      if (req.command === 'keyboard') {
        return { ok: false, error: { code: 'UNSUPPORTED_OPERATION', message: 'unsupported' } };
      }
      return { ok: true, data: {} };
    },
  });

  assert.equal(response.ok, false);
  if (!response.ok) {
    assert.equal(response.error.code, 'REPLAY_DIVERGENCE');
    assert.match(response.error.message, /unsupported/);
  }
  assert.deepEqual(
    calls.map((call) => [call.command, call.positionals]),
    [['keyboard', ['enter']]],
  );
});

test('runReplayCommand retries Maestro retry commands until they pass', async () => {
  const calls: CapturedInvocation[] = [];
  let openAttempts = 0;
  const { response } = await runReplayFixture({
    label: 'maestro-retry',
    script: [
      'appId: demo.app',
      '---',
      '- retry:',
      '    maxRetries: 2',
      '    commands:',
      '      - openLink:',
      '          link: demo://details',
      '      - extendedWaitUntil:',
      '          visible: Article',
      '          timeout: 1',
      '',
    ].join('\n'),
    flags: { replayBackend: 'maestro' },
    invoke: async (req) => {
      calls.push({ command: req.command, positionals: req.positionals, flags: req.flags });
      if (req.command === 'open') openAttempts += 1;
      if (req.command === 'snapshot') {
        return {
          ok: true,
          data: {
            nodes: [
              {
                index: 0,
                type: 'application',
                rect: { x: 0, y: 0, width: 390, height: 844 },
              },
              ...(openAttempts > 1
                ? [
                    {
                      index: 1,
                      depth: 1,
                      parentIndex: 0,
                      type: 'statictext',
                      label: 'Article',
                      rect: { x: 16, y: 100, width: 120, height: 24 },
                    },
                  ]
                : []),
            ],
          },
        };
      }
      return { ok: true, data: {} };
    },
  });

  assert.equal(response.ok, true);
  assert.deepEqual(
    calls.filter((call) => call.command === 'open').map((call) => [call.command, call.positionals]),
    [
      ['open', ['demo.app', 'demo://details']],
      ['open', ['demo.app', 'demo://details']],
    ],
  );
  assert.equal(calls.filter((call) => call.command === 'snapshot').length > 1, true);
});
