import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { AgentDeviceClient } from '@agent-device/command-surface';
import { AppError } from '@agent-device/kernel/errors';
import { createCommandToolExecutor } from '../command-tools.ts';

// The default MCP server returns text only, so a replay divergence must reach the model through
// the error text with its repair data, and its screen refs must still be pinned.
test('a default-mode divergence is error text carrying the repair data, and its refs are pinned', async () => {
  const runCalls: Array<{ name: string; input: unknown }> = [];
  const executor = createCommandToolExecutor({
    createClient: () => ({}) as AgentDeviceClient,
    runCommand: async (_client, name, input) => {
      runCalls.push({ name, input });
      if (name !== 'replay') return {};
      throw new AppError('REPLAY_DIVERGENCE', 'Replay failed at step 2 (click "Save")', {
        divergence: {
          version: 1,
          kind: 'action-failure',
          step: { index: 2, source: { path: '/tmp/flow.ad', line: 2 } },
          action: 'click "Save"',
          screen: {
            state: 'available',
            refsGeneration: 12,
            refs: [{ ref: 'e5', role: 'button', label: 'Save' }],
          },
          suggestions: [
            { selector: 'id="save"', basis: 'id', ref: 'e5', role: 'button', label: 'Save' },
          ],
          suggestionCount: 1,
          resume: { allowed: true, from: 2, planDigest: 'digest-abc' },
          repairHint: 'state-repair',
        },
      });
    },
  });

  const result = await executor.execute('replay', { path: '/tmp/flow.ad' });

  assert.equal(result.isError, true);
  assert.equal('structuredContent' in result, false);
  const text = result.content[0]?.text ?? '';
  assert.match(text, /^Error \(REPLAY_DIVERGENCE\)/);
  assert.match(text, /Divergence at step 2 \(\/tmp\/flow\.ad:2\)/);
  assert.match(text, /Repair hint: state-repair — .*--from 2 --plan-digest digest-abc/);
  assert.match(text, /@e5 \[button\] "Save"/);
  assert.match(text, /\[id\] "Save" id="save"/);

  await executor.execute('press', { ref: '@e5' });
  assert.deepEqual(runCalls[1]?.input, { ref: '@e5~s12' });
});
