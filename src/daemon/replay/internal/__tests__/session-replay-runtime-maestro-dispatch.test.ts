import { maestroReplayFixture } from './session-replay-runtime-maestro.fixtures.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { mkdtempForTestSync } from '../../../../__tests__/test-utils/tmp-dir.ts';
import type { DaemonResponse } from '../../../daemon-request.ts';
import { SessionStore } from '../../../session-store.ts';
import { replayScriptSourceBundleFor } from '../../../../__tests__/test-utils/replay-script-source.ts';
import { makeIosSession } from '../../../../__tests__/test-utils/session-factories.ts';

const { runReplayFixture, runReplayForTest, assertNoUnresolvedInterpolation } =
  maestroReplayFixture;

test('--update no longer rejects Maestro compat flow controls (the guard existed only for rewrite safety)', async () => {
  const { response } = await runReplayFixture({
    label: 'maestro-replay-update-flow-control',
    script: [
      'appId: demo.app',
      '---',
      '- retry:',
      '    maxRetries: 1',
      '    commands:',
      '      - back',
      '',
    ].join('\n'),
    flags: { replayBackend: 'maestro', replayUpdate: true },
  });

  assert.equal(response.ok, true);
});

test('runReplayCommand dispatches resolved literals with file env overridden by CLI', async () => {
  const { response, calls } = await runReplayFixture({
    label: 'green',
    script:
      [
        'context platform=android',
        'env APP=file-app',
        'env SCOPE=file-scope',
        '',
        'open ${APP}',
        'snapshot -s ${SCOPE}',
        'click "at ${AD_FILENAME}"',
      ].join('\n') + '\n',
    flags: { replayEnv: ['APP=cli-app'] },
  });
  assert.equal(response.ok, true);
  const [open, snapshot, click] = calls;
  assert.ok(open && snapshot && click);
  // open ${APP} -> CLI override wins.
  assert.equal(open.command, 'open');
  assert.deepEqual(open.positionals, ['cli-app']);
  // snapshot -s ${SCOPE} -> file env fills in.
  assert.equal(snapshot.command, 'snapshot');
  assert.equal(snapshot.flags?.snapshotScope, 'file-scope');
  // click with ${AD_FILENAME} resolves to the relative script path.
  assert.equal(click.command, 'click');
  assert.deepEqual(click.positionals, ['at flow.ad']);
  // And nothing dispatched still contains a literal ${...} token.
  assertNoUnresolvedInterpolation(calls);
});

test('.ad replay normalizes resolved gesture and swipe syntax into structured daemon input', async () => {
  const { response, calls } = await runReplayFixture({
    label: 'structured-gesture-input',
    script: [
      'env X=10',
      'gesture pan ${X} 20 30 40 500 --pointer-count 2',
      'swipe ${X} 20 30 40 --count 2 --pause-ms 5 --pattern ping-pong',
      '',
    ].join('\n'),
  });

  assert.equal(response.ok, true);
  assert.deepEqual(
    calls.map((call) => ({
      command: call.command,
      positionals: call.positionals,
      input: call.input,
    })),
    [
      {
        command: 'gesture',
        positionals: [],
        input: {
          kind: 'pan',
          origin: { x: 10, y: 20 },
          delta: { x: 30, y: 40 },
          pointerCount: 2,
          durationMs: 500,
        },
      },
      {
        command: 'swipe',
        positionals: [],
        input: {
          from: { x: 10, y: 20 },
          to: { x: 30, y: 40 },
          count: 2,
          pauseMs: 5,
          pattern: 'ping-pong',
        },
      },
    ],
  );
});

test('runReplayCommand reports snapshot diagnostics from per-action session samples', async () => {
  const root = mkdtempForTestSync('agent-device-replay-snapshot-samples-');
  const scriptPath = path.join(root, 'flow.ad');
  // Four warm captures beyond the cold start: the slow-run warning judges warm
  // samples only and needs at least three of them.
  fs.writeFileSync(
    scriptPath,
    ['snapshot', 'snapshot', 'snapshot', 'snapshot', 'snapshot', ''].join('\n'),
  );
  const sessionStore = new SessionStore(path.join(root, 'state'));
  sessionStore.set(
    's',
    makeIosSession('s', {
      snapshotDiagnostics: { samples: [] },
    }),
  );
  let captures = 0;

  const response = await runReplayForTest({
    req: {
      token: 't',
      session: 's',
      command: 'replay',
      positionals: [scriptPath],
      flags: { replayScriptSource: replayScriptSourceBundleFor(scriptPath) },
      meta: { cwd: root },
    },
    sessionName: 's',
    logPath: path.join(root, 'log'),
    sessionStore,
    invoke: async (): Promise<DaemonResponse> => {
      captures += 1;
      const session = sessionStore.get('s');
      session?.snapshotDiagnostics?.samples.push({
        durationMs: captures === 1 ? 400 : 1_900,
        backend: 'xctest',
        platform: 'ios',
      });
      return {
        ok: true,
        data: {
          snapshotDiagnostics: {
            stats: {
              count: captures,
              p50Ms: captures === 1 ? 400 : 1_900,
              p95Ms: captures === 1 ? 400 : 1_900,
              maxMs: captures === 1 ? 400 : 1_900,
              slowThresholdMs: 1_500,
              platform: 'ios',
            },
          },
        },
      };
    },
  });

  assert.equal(response.ok, true);
  const diagnostics = response.data?.snapshotDiagnostics as
    | { stats?: { count?: number }; warning?: string }
    | undefined;
  assert.equal(diagnostics?.stats?.count, 5);
  assert.match(String(diagnostics?.warning), /p95 1900ms over 4 captures/);
});

test('runReplayCommand reports snapshot diagnostics on replay failure', async () => {
  const root = mkdtempForTestSync('agent-device-replay-snapshot-failure-');
  const scriptPath = path.join(root, 'flow.ad');
  // Three warm captures precede the failing click so the failure-path summary
  // has enough warm samples to judge.
  fs.writeFileSync(
    scriptPath,
    ['snapshot', 'snapshot', 'snapshot', 'snapshot', 'click "Missing"', ''].join('\n'),
  );
  const sessionStore = new SessionStore(path.join(root, 'state'));
  sessionStore.set(
    's',
    makeIosSession('s', {
      snapshotDiagnostics: { samples: [] },
    }),
  );
  let captures = 0;

  const response = await runReplayForTest({
    req: {
      token: 't',
      session: 's',
      command: 'replay',
      positionals: [scriptPath],
      flags: { replayScriptSource: replayScriptSourceBundleFor(scriptPath) },
      meta: { cwd: root },
    },
    sessionName: 's',
    logPath: path.join(root, 'log'),
    sessionStore,
    invoke: async (): Promise<DaemonResponse> => {
      captures += 1;
      const session = sessionStore.get('s');
      session?.snapshotDiagnostics?.samples.push({
        durationMs: captures === 1 ? 450 : 2_100,
        backend: 'xctest',
        platform: 'ios',
      });
      if (captures < 5) return { ok: true, data: {} };
      return { ok: false, error: { code: 'COMMAND_FAILED', message: 'button missing' } };
    },
  });

  assert.equal(response.ok, false);
  const diagnostics = response.error.details?.snapshotDiagnostics as
    | { stats?: { count?: number; p95Ms?: number }; warning?: string }
    | undefined;
  assert.equal(diagnostics?.stats?.count, 5);
  assert.equal(diagnostics?.stats?.p95Ms, 2_100);
  assert.match(String(diagnostics?.warning), /p95 2100ms over 4 captures/);
});

test('runReplayCommand applies CLI env overrides before Maestro compat mapping', async () => {
  const { response, calls } = await runReplayFixture({
    label: 'maestro-env',
    script: [
      'appId: ${APP_ID}',
      'env:',
      '  APP_ID: yaml-app',
      '  BUTTON_ID: yaml-button',
      '---',
      '- launchApp',
      '- tapOn:',
      '    id: ${BUTTON_ID}',
      '',
    ].join('\n'),
    flags: {
      replayBackend: 'maestro',
      platform: 'android',
      replayShellEnv: { AD_VAR_BUTTON_ID: 'shell-button' },
      replayEnv: ['APP_ID=cli-app'],
    },
    invoke: async (req) => {
      if (req.command === 'snapshot') {
        return {
          ok: true,
          data: {
            nodes: [
              {
                index: 1,
                identifier: 'shell-button',
                rect: { x: 20, y: 40, width: 120, height: 44 },
              },
            ],
          },
        };
      }
      return { ok: true, data: {} };
    },
  });

  assert.equal(response.ok, true);
  assert.deepEqual(calls[0]?.positionals, ['cli-app']);
  assert.deepEqual(
    calls.map((call) => [call.command, call.positionals]),
    [
      ['open', ['cli-app']],
      ['snapshot', []],
      ['snapshot', []],
      ['click', ['80', '62']],
    ],
  );
});
