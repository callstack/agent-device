import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import type { MaestroActionEvent } from '@agent-device/maestro';
import { mkdtempForTestSync } from '../../../__tests__/test-utils/tmp-dir.ts';
import { createMaestroReplayObserver } from '../session-replay-maestro-observer.ts';

test('forwards command labels to progress and replay trace projection', () => {
  const root = mkdtempForTestSync('agent-device-maestro-label-trace-');
  const tracePath = path.join(root, 'replay-timing.ndjson');
  const replayPath = path.join(root, 'flow.yaml');
  const onStep = vi.fn();
  const event: MaestroActionEvent = {
    action: 'tapOn',
    value: 'save action',
    source: { path: replayPath, line: 3 },
    generation: 0,
    stepIndex: 1,
    stepTotal: 1,
  };

  const observer = createMaestroReplayObserver({ tracePath, filePath: replayPath, onStep });
  observer.actionStarted?.(event);
  observer.actionCompleted?.({
    ...event,
    durationMs: 5,
    runtimeMetrics: {
      hierarchyCaptures: 1,
      screenshotCaptures: 0,
      tapRetries: 0,
      settleLatches: 0,
      settleTimeouts: 0,
    },
  });

  expect(onStep).toHaveBeenCalledWith({
    index: 1,
    total: 1,
    command: 'tapOn',
    value: 'save action',
  });
  const traceStart = JSON.parse(fs.readFileSync(tracePath, 'utf8').split('\n')[0]!) as Record<
    string,
    unknown
  >;
  expect(traceStart).toMatchObject({
    type: 'replay_action_start',
    command: 'tapOn',
    positionals: ['save action'],
  });
});
