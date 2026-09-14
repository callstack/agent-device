import {
  maestroReplayFixture,
  type CapturedInvocation,
} from './session-replay-runtime-maestro.fixtures.ts';
import assert from 'node:assert/strict';
import { test } from 'vitest';

const { runReplayFixture } = maestroReplayFixture;

test('runReplayCommand reports iOS Maestro openLink setup failures before assertions', async () => {
  const { response, calls } = await runReplayFixture({
    label: 'maestro-ios-openlink-prewarm-fail',
    script: [
      'appId: demo.app',
      '---',
      '- openLink: demo://screen',
      '- assertVisible: Ready',
      '',
    ].join('\n'),
    flags: { replayBackend: 'maestro', platform: 'ios' },
    invoke: async (req) => {
      if (req.command === 'open') {
        return {
          ok: false,
          error: {
            code: 'COMMAND_FAILED',
            message: 'Developer mode is disabled for Apple development tools',
            details: {
              hint: 'Run `sudo DevToolsSecurity -enable`.',
            },
          },
        };
      }
      return { ok: true, data: {} };
    },
  });

  assert.equal(response.ok, false);
  if (!response.ok) {
    assert.match(response.error.message, /Replay failed at step 1/);
    assert.match(response.error.message, /openLink "demo:\/\/screen"/);
    assert.match(response.error.message, /Developer mode is disabled/);
    // The cause's details-borne hint is hoisted onto the error field by the
    // divergence transport (arbitrary cause details are stripped).
    assert.match(String(response.error.hint ?? ''), /DevToolsSecurity -enable/);
  }
  assert.deepEqual(
    calls.map((call) => [call.command, call.positionals]),
    [['open', ['demo.app', 'demo://screen']]],
  );
  assert.equal(calls[0]?.flags?.maestro?.prewarmRunnerBeforeOpen, true);
});

test('runReplayCommand retries Maestro scrollUntilVisible with scroll probes', async () => {
  const calls: CapturedInvocation[] = [];
  let snapshotAttempts = 0;
  const { response } = await runReplayFixture({
    label: 'maestro-scroll-until-visible',
    script: [
      'appId: demo.app',
      '---',
      '- scrollUntilVisible:',
      '    element: Discover',
      '    direction: UP',
      '    timeout: 1200',
      '',
    ].join('\n'),
    flags: { replayBackend: 'maestro' },
    invoke: async (req) => {
      calls.push({ command: req.command, positionals: req.positionals, flags: req.flags });
      if (req.command === 'snapshot') {
        snapshotAttempts += 1;
        return {
          ok: true,
          data: {
            nodes:
              snapshotAttempts < 3
                ? []
                : [
                    {
                      index: 1,
                      label: 'Discover',
                      rect: { x: 10, y: 600, width: 240, height: 44 },
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
      ['scroll', ['up']],
      ['snapshot', []],
      ['snapshot', []],
      ['snapshot', []],
    ],
  );
});

test('runReplayCommand uses semantic iOS dispatch for an exact text tapOn', async () => {
  const calls: CapturedInvocation[] = [];
  const { response } = await runReplayFixture({
    label: 'maestro-tap-visible-text-atomic-ios',
    script: ['appId: demo.app', '---', '- tapOn: Article', ''].join('\n'),
    flags: { replayBackend: 'maestro', platform: 'ios' },
    invoke: async (req) => {
      calls.push({ command: req.command, positionals: req.positionals, flags: req.flags });
      if (req.command === 'snapshot') {
        return {
          ok: true,
          data: {
            nodes: [
              {
                index: 1,
                type: 'XCUIElementTypeButton',
                label: 'Article',
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
    calls.map((call) => [call.command, call.positionals]),
    [
      ['snapshot', []],
      ['click', ['text="Article"']],
    ],
  );
});

test('runReplayCommand uses matched Android id geometry for tapOn', async () => {
  const calls: CapturedInvocation[] = [];
  const { response } = await runReplayFixture({
    label: 'maestro-tap-id-matched-geometry',
    script: ['appId: demo.app', '---', '- tapOn:', '    id: album-0', ''].join('\n'),
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
                type: 'android.widget.Button',
                rect: { x: 24, y: 320, width: 312, height: 64 },
                hittable: true,
              },
              {
                index: 2,
                parentIndex: 1,
                type: 'android.widget.TextView',
                identifier: 'album-0',
                rect: { x: 44, y: 334, width: 80, height: 24 },
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
    calls.map((call) => [call.command, call.positionals]),
    [
      ['snapshot', []],
      ['click', ['84', '346']],
    ],
  );
});

test('runReplayCommand captures fresh geometry for tapOn after assertVisible', async () => {
  let snapshots = 0;
  const { response, calls } = await runReplayFixture({
    label: 'maestro-assert-visible-tap-fresh-snapshot',
    script: [
      'appId: demo.app',
      '---',
      '- assertVisible:',
      '    id: open-feed',
      '- tapOn: Open feed',
      '',
    ].join('\n'),
    flags: { replayBackend: 'maestro', platform: 'android' },
    invoke: async (req) => {
      if (req.command === 'snapshot') {
        snapshots += 1;
        return {
          ok: true,
          data: {
            nodes: [
              {
                index: 1,
                label: 'Article',
                rect: { x: 10, y: 100, width: 160, height: 44 },
              },
              {
                index: 2,
                label: 'Open feed',
                identifier: 'open-feed',
                rect: { x: 20, y: 180, width: 180, height: 48 },
              },
            ],
          },
        };
      }
      return { ok: true, data: {} };
    },
  });

  assert.equal(response.ok, true);
  assert.equal(snapshots, 2);
  assert.deepEqual(
    calls.map((call) => [call.command, call.positionals]),
    [
      ['snapshot', []],
      ['snapshot', []],
      ['click', ['110', '204']],
    ],
  );
});

test('runReplayCommand scopes duplicate tap targets after native Maestro assertVisible', async () => {
  const { response, calls } = await runReplayFixture({
    label: 'maestro-native-assert-context-duplicate-tap',
    script: ['appId: demo.app', '---', '- assertVisible: Albums', '- tapOn: Push article', ''].join(
      '\n',
    ),
    flags: { replayBackend: 'maestro', platform: 'android' },
    invoke: async (req) => {
      if (req.command === 'snapshot') {
        return {
          ok: true,
          data: {
            nodes: [
              {
                index: 1,
                depth: 1,
                type: 'android.widget.ScrollView',
                rect: { x: 0, y: 0, width: 390, height: 844 },
              },
              {
                index: 2,
                depth: 2,
                parentIndex: 1,
                type: 'android.widget.TextView',
                label: 'Albums',
                rect: { x: 24, y: 120, width: 120, height: 40 },
              },
              {
                index: 3,
                depth: 2,
                parentIndex: 1,
                type: 'android.widget.TextView',
                label: 'Push article',
                rect: { x: 32, y: 220, width: 160, height: 44 },
              },
              {
                index: 10,
                depth: 1,
                type: 'android.widget.ScrollView',
                rect: { x: 0, y: 0, width: 390, height: 844 },
              },
              {
                index: 11,
                depth: 2,
                parentIndex: 10,
                type: 'android.widget.TextView',
                label: 'Push article',
                rect: { x: 32, y: 520, width: 160, height: 44 },
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
      ['click', ['112', '242']],
    ],
  );
});

test('runReplayCommand treats absent Maestro assertNotVisible targets as passing', async () => {
  const calls: CapturedInvocation[] = [];
  const { response } = await runReplayFixture({
    label: 'maestro-assert-not-visible-absent',
    script: ['appId: demo.app', '---', '- assertNotVisible: Archived banner', ''].join('\n'),
    flags: { replayBackend: 'maestro' },
    invoke: async (req) => {
      calls.push({ command: req.command, positionals: req.positionals, flags: req.flags });
      return {
        ok: true,
        data: {
          createdAt: 1,
          nodes: [],
        },
      };
    },
  });

  assert.equal(response.ok, true);
  assert.deepEqual(
    calls.map((call) => [call.command, call.positionals]),
    [['snapshot', []]],
  );
  assert.equal(calls[0]?.flags?.noRecord, true);
});

test('runReplayCommand propagates Maestro assertNotVisible infrastructure failures', async () => {
  const calls: CapturedInvocation[] = [];
  const { response } = await runReplayFixture({
    label: 'maestro-assert-not-visible-infra-fail',
    script: ['appId: demo.app', '---', '- assertNotVisible: Archived banner', ''].join('\n'),
    flags: { replayBackend: 'maestro' },
    invoke: async (req) => {
      calls.push({ command: req.command, positionals: req.positionals, flags: req.flags });
      return {
        ok: false,
        error: { code: 'COMMAND_FAILED', message: 'Snapshot capture failed' },
      };
    },
  });

  assert.equal(response.ok, false);
  if (!response.ok) {
    assert.match(response.error.message, /Replay failed at step 1/);
    assert.match(response.error.message, /Snapshot capture failed/);
  }
  assert.equal(calls.length, 1);
});

test('runReplayCommand waits briefly for Maestro assertNotVisible to stabilize', async () => {
  const calls: CapturedInvocation[] = [];
  let snapshots = 0;
  const { response } = await runReplayFixture({
    label: 'maestro-assert-not-visible-stable',
    script: ['appId: demo.app', '---', '- assertNotVisible: Archived banner', ''].join('\n'),
    flags: { replayBackend: 'maestro' },
    invoke: async (req) => {
      calls.push({ command: req.command, positionals: req.positionals, flags: req.flags });
      snapshots += 1;
      if (snapshots === 1) {
        return {
          ok: true,
          data: {
            createdAt: 1,
            nodes: [
              {
                index: 1,
                label: 'Archived banner',
                rect: { x: 10, y: 20, width: 180, height: 44 },
              },
            ],
          },
        };
      }
      return {
        ok: true,
        data: {
          createdAt: snapshots,
          nodes: [],
        },
      };
    },
  });

  assert.equal(response.ok, true);
  assert.equal(calls.length, 2);
});

test('runReplayCommand treats absent Maestro extendedWaitUntil.notVisible targets as passing', async () => {
  const { response, calls } = await runReplayFixture({
    label: 'maestro-extended-wait-not-visible-absent',
    script: [
      'appId: demo.app',
      '---',
      '- extendedWaitUntil:',
      '    notVisible: Archived banner',
      '    timeout: 1',
      '',
    ].join('\n'),
    flags: { replayBackend: 'maestro' },
    invoke: async () => ({
      ok: true,
      data: {
        createdAt: 1,
        nodes: [],
      },
    }),
  });

  assert.equal(response.ok, true);
  assert.deepEqual(
    calls.map((call) => [call.command, call.positionals]),
    [['snapshot', []]],
  );
  assert.equal(calls[0]?.flags?.noRecord, true);
});

test('runReplayCommand resolves Maestro percentage point taps from the admitted runtime viewport', async () => {
  const { response, calls } = await runReplayFixture({
    label: 'maestro-tap-point-percent',
    script: ['appId: demo.app', '---', '- tapOn:', '    point: 20%,20%', ''].join('\n'),
    flags: { replayBackend: 'maestro' },
    sessionPlatform: 'ios',
  });

  assert.equal(response.ok, true);
  assert.deepEqual(
    calls.map((call) => [call.command, call.positionals]),
    [
      ['runtime', ['gesture-viewport']],
      ['click', ['80', '160']],
    ],
  );
  assert.equal(
    calls.some((call) => call.command === 'snapshot'),
    false,
  );
});

test('runReplayCommand retries Maestro id tapOn through snapshot coordinates', async () => {
  const calls: CapturedInvocation[] = [];
  let snapshotAttempts = 0;
  const { response } = await runReplayFixture({
    label: 'maestro-tap-on-retry',
    script: ['appId: demo.app', '---', '- tapOn:', '    id: delayedButton', ''].join('\n'),
    flags: { replayBackend: 'maestro', platform: 'android' },
    invoke: async (req) => {
      calls.push({ command: req.command, positionals: req.positionals, flags: req.flags });
      if (req.command === 'snapshot') {
        snapshotAttempts += 1;
        if (snapshotAttempts === 3) {
          return {
            ok: true,
            data: {
              nodes: [
                {
                  index: 1,
                  identifier: 'delayedButton',
                  rect: { x: 20, y: 40, width: 120, height: 44 },
                },
              ],
            },
          };
        }
        return { ok: true, data: { nodes: [] } };
      }
      if (req.command === 'click') return { ok: true, data: {} };
      return {
        ok: false,
        error: { code: 'ELEMENT_NOT_FOUND', message: 'element not found' },
      };
    },
  });

  assert.equal(response.ok, true);
  assert.deepEqual(
    calls.map((call) => [call.command, call.positionals]),
    [
      ['snapshot', []],
      ['snapshot', []],
      ['snapshot', []],
      ['click', ['80', '62']],
    ],
  );
});

test('runReplayCommand resolves Maestro tapOn index and childOf from snapshots', async () => {
  const calls: CapturedInvocation[] = [];
  const { response } = await runReplayFixture({
    label: 'maestro-tap-index-childof',
    script: [
      'appId: demo.app',
      '---',
      '- tapOn:',
      '    id: childActionButton',
      '    childOf:',
      '      id: parent-row-secondary',
      '- tapOn:',
      '    id: overflowButton',
      '    index: 1',
      '',
    ].join('\n'),
    flags: { replayBackend: 'maestro' },
    invoke: async (req) => {
      calls.push({ command: req.command, positionals: req.positionals, flags: req.flags });
      if (req.command === 'snapshot') {
        return {
          ok: true,
          data: {
            nodes: [
              { index: 1, identifier: 'parent-row-primary' },
              {
                index: 2,
                parentIndex: 1,
                identifier: 'childActionButton',
                rect: { x: 10, y: 10, width: 40, height: 20 },
              },
              { index: 10, identifier: 'parent-row-secondary' },
              {
                index: 11,
                parentIndex: 10,
                identifier: 'childActionButton',
                rect: { x: 20, y: 120, width: 40, height: 20 },
              },
              {
                index: 20,
                identifier: 'overflowButton',
                rect: { x: 100, y: 200, width: 40, height: 20 },
              },
              {
                index: 21,
                identifier: 'overflowButton',
                rect: { x: 200, y: 300, width: 40, height: 20 },
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
      ['click', ['40', '130']],
      ['snapshot', []],
      ['click', ['220', '310']],
    ],
  );
  assert.equal(calls[0]?.flags?.noRecord, true);
});

test('runReplayCommand lets snapshot id tap handle Maestro one-point edge controls', async () => {
  const calls: CapturedInvocation[] = [];
  const { response } = await runReplayFixture({
    label: 'maestro-tap-edge-rect',
    script: ['appId: demo.app', '---', '- tapOn:', '    id: hiddenTestLogin', ''].join('\n'),
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
                identifier: 'hiddenTestLogin',
                rect: { x: 0, y: 0, width: 1, height: 1 },
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
      ['click', ['0', '0']],
    ],
  );
});
