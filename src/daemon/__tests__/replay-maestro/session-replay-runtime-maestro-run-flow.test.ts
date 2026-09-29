import {
  maestroReplayFixture,
  type CapturedInvocation,
} from './session-replay-runtime-maestro.fixtures.ts';
import assert from 'node:assert/strict';
import { test } from 'vitest';

const { runReplayFixture } = maestroReplayFixture;

test('runReplayCommand propagates Maestro runFlow.when runtime errors', async () => {
  const { response } = await runReplayFixture({
    label: 'maestro-run-flow-when-visible-runtime-error',
    script: [
      'appId: demo.app',
      '---',
      '- runFlow:',
      '    when:',
      '      visible: Continue',
      '    commands:',
      '      - tapOn: Continue',
      '',
    ].join('\n'),
    flags: { replayBackend: 'maestro' },
    invoke: async () => ({
      ok: false,
      error: { code: 'UNKNOWN', message: 'fetch failed' },
    }),
  });

  assert.equal(response.ok, false);
  if (!response.ok) {
    // ADR 0012 migration step 2: the wire-level code is now REPLAY_DIVERGENCE;
    // the original code/message are preserved verbatim in divergence.cause.
    assert.equal(response.error.code, 'REPLAY_DIVERGENCE');
    assert.match(response.error.message, /fetch failed/);
    const divergence = response.error.details?.divergence as
      | { cause: { code: string; message: string }; repairHint: string }
      | undefined;
    assert.equal(divergence?.cause.code, 'UNKNOWN');
    assert.match(divergence?.cause.message ?? '', /fetch failed/);
    assert.equal(divergence?.repairHint, 'manual');
  }
});

test('runReplayCommand runs Maestro runFlow.when.visible commands when present', async () => {
  const calls: CapturedInvocation[] = [];
  const { response } = await runReplayFixture({
    label: 'maestro-run-flow-when-visible-run',
    script: [
      'appId: demo.app',
      '---',
      '- runFlow:',
      '    when:',
      '      visible: Continue',
      '    commands:',
      '      - tapOn: Continue',
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
                index: 0,
                type: 'application',
                rect: { x: 0, y: 0, width: 390, height: 844 },
              },
              {
                index: 1,
                depth: 1,
                parentIndex: 0,
                type: 'button',
                label: 'Continue',
                rect: { x: 16, y: 100, width: 120, height: 44 },
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
      ['snapshot', []],
      ['click', ['76', '122']],
    ],
  );
  assert.equal(
    calls.find((call) => call.command === 'click')?.flags?.interactionOutcome,
    undefined,
  );
  assert.equal(
    calls.find((call) => call.command === 'click')?.flags?.postGestureStabilization,
    undefined,
  );
});

test('runReplayCommand runs nested Maestro runtime commands inside runFlow.when', async () => {
  const calls: CapturedInvocation[] = [];
  let snapshots = 0;
  const { response } = await runReplayFixture({
    label: 'maestro-run-flow-when-nested-runtime',
    script: [
      'appId: demo.app',
      '---',
      '- runFlow:',
      '    when:',
      '      visible: Feed',
      '    commands:',
      '      - scrollUntilVisible:',
      '          element: Done',
      '          direction: DOWN',
      '          timeout: 500',
      '',
    ].join('\n'),
    flags: { replayBackend: 'maestro' },
    invoke: async (req) => {
      calls.push({ command: req.command, positionals: req.positionals, flags: req.flags });
      if (req.command === 'snapshot') {
        snapshots += 1;
        return {
          ok: true,
          data: {
            nodes: [
              {
                index: 0,
                type: 'application',
                rect: { x: 0, y: 0, width: 390, height: 844 },
              },
              {
                index: 1,
                depth: 1,
                parentIndex: 0,
                type: 'statictext',
                label: 'Feed',
                rect: { x: 16, y: 100, width: 120, height: 24 },
              },
              ...(snapshots < 3
                ? []
                : [
                    {
                      index: 2,
                      depth: 1,
                      parentIndex: 0,
                      type: 'statictext',
                      label: 'Done',
                      rect: { x: 16, y: 300, width: 120, height: 24 },
                    },
                  ]),
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
      ['snapshot', []],
      ['scroll', ['down']],
      ['snapshot', []],
      ['snapshot', []],
    ],
  );
});

test('runReplayCommand resolves nested Maestro runFlow.when command variables once at execution', async () => {
  const calls: CapturedInvocation[] = [];
  const { response } = await runReplayFixture({
    label: 'maestro-run-flow-when-nested-vars',
    script: [
      'appId: demo.app',
      'env:',
      '  TARGET_LABEL: ${NEXT_LABEL}',
      '  NEXT_LABEL: ${FINAL_LABEL}',
      '  FINAL_LABEL: Done',
      '---',
      '- runFlow:',
      '    when:',
      '      visible: Feed',
      '    commands:',
      '      - tapOn: ${TARGET_LABEL}',
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
                index: 0,
                type: 'application',
                rect: { x: 0, y: 0, width: 390, height: 844 },
              },
              {
                index: 1,
                depth: 1,
                parentIndex: 0,
                type: 'statictext',
                label: 'Feed',
                rect: { x: 16, y: 100, width: 120, height: 24 },
              },
              {
                index: 2,
                depth: 1,
                parentIndex: 0,
                type: 'button',
                label: 'Done',
                rect: { x: 100, y: 300, width: 80, height: 40 },
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
      ['snapshot', []],
      ['click', ['140', '320']],
    ],
  );
});
