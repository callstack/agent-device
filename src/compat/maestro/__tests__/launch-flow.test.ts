import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { SessionAction } from '../../../daemon/types.ts';
import { parseMaestroReplayFlow } from '../replay-flow.ts';

test('bare launchApp uses Maestro default stop-and-relaunch semantics', () => {
  const parsed = parseMaestroReplayFlow(`appId: com.pagerviewexample
---
- launchApp
`);

  assert.deepEqual(projectAction(parsed.actions[0]), [
    'open',
    ['com.pagerviewexample'],
    { relaunch: true },
  ]);
});

test('launchApp stopApp false opts out of relaunch', () => {
  const parsed = parseMaestroReplayFlow(`appId: com.pagerviewexample
---
- launchApp:
    stopApp: false
`);

  assert.deepEqual(projectAction(parsed.actions[0]), ['open', ['com.pagerviewexample'], {}]);
});

function projectAction(action: SessionAction | undefined) {
  if (!action) throw new Error('expected parsed action');
  return [action.command, action.positionals, action.flags];
}
