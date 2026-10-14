import { expect, test, vi } from 'vitest';
import type { MaestroActionEvent } from '@agent-device/maestro';
import { createMaestroReplayObserver } from '../session-replay-maestro-observer.ts';

test('forwards command labels to progress and replay trace projection', () => {
  const tracePath = '/trace/replay-timing.ndjson';
  const replayPath = '/flows/flow.yaml';
  const onStep = vi.fn();
  const appendTraceEvent = vi.fn();
  const event: MaestroActionEvent = {
    action: 'tapOn',
    value: 'save action',
    source: { path: replayPath, line: 3 },
    generation: 0,
    stepIndex: 1,
    stepTotal: 1,
  };

  const observer = createMaestroReplayObserver({
    appendTraceEvent,
    tracePath,
    filePath: replayPath,
    onStep,
  });
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
  expect(appendTraceEvent).toHaveBeenNthCalledWith(
    1,
    tracePath,
    expect.objectContaining({
      type: 'replay_action_start',
      command: 'tapOn',
      positionals: ['save action'],
    }),
  );
});
