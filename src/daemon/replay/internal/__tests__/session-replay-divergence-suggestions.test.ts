import { divergenceFixture } from './session-replay-divergence.fixtures.ts';
import path from 'node:path';
import { beforeEach, expect, test } from 'vitest';
import { mkdtempForTestSync } from '../../../../__tests__/test-utils/tmp-dir.ts';
import { makeIosSession } from '../../../../__tests__/test-utils/session-factories.ts';
import { SessionStore } from '../../../session-store.ts';
import { replayDivergenceForTest } from './replay-session-fixture.ts';

const { buildReplayFailureDivergence, mockDispatchCommand, resetDivergenceCapture } =
  divergenceFixture;
beforeEach(resetDivergenceCapture);

test('buildReplayFailureDivergence dedupes suggestions using the strongest basis', async () => {
  const root = mkdtempForTestSync('agent-device-replay-suggest-dedupe-');
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  sessionStore.set(sessionName, makeIosSession(sessionName, { appBundleId: 'com.example.app' }));

  mockDispatchCommand.mockResolvedValue({
    nodes: [
      {
        index: 0,
        depth: 0,
        type: 'Button',
        label: 'Save',
        identifier: 'save',
        rect: { x: 0, y: 0, width: 100, height: 44 },
        hittable: true,
      },
    ],
    truncated: false,
    backend: 'xctest',
  });

  const action = {
    ts: 0,
    command: 'click',
    positionals: ['label="Save"'],
    flags: {},
    result: { selectorChain: ['label="Save"', 'id="save"'] },
  };
  const divergence = await buildReplayFailureDivergence({
    error: { code: 'COMMAND_FAILED', message: 'not hittable' },
    action,
    index: 0,
    sourcePath: path.join(root, 'flow.ad'),
    sourceLine: 1,
    ...replayDivergenceForTest(sessionStore, sessionName),
    logPath: path.join(root, 'daemon.log'),
    responseLevel: 'default',
    planActions: [action],
    planDigest: 'test-plan-digest',
  });

  expect(divergence.suggestionCount).toBe(1);
  expect(divergence.suggestions).toHaveLength(1);
  expect(divergence.suggestions[0]?.ref).toBe('e1');
  expect(divergence.suggestions[0]?.basis).toBe('id');
});
