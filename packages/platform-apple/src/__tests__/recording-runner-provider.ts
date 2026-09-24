import type { GesturePlan } from '@agent-device/contracts/gesture-plan-types';
import type {
  AppleRunnerCommandOptions,
  AppleRunnerProvider,
  RunnerCommand,
} from '../runner/index.ts';

export type RecordedRunnerCall = Readonly<{
  command: RunnerCommand;
  options: AppleRunnerCommandOptions;
}>;

/** A runner transport that answers every command with a minimal valid result and records it. */
export function recordingRunnerProvider(
  calls: RecordedRunnerCall[],
  results: Partial<Record<RunnerCommand['command'], Record<string, unknown>>> = {},
): AppleRunnerProvider {
  return {
    hasLiveSession: () => true,
    runCommand: async (_device, command, options) => {
      calls.push({ command, options });
      return results[command.command] ?? runnerResultFor(command);
    },
  };
}

export function runnerResultFor(sent: Pick<RunnerCommand, 'command' | 'orientation'>) {
  switch (sent.command) {
    case 'snapshot':
      return {
        nodes: [
          { index: 0, type: 'Application', rect: { x: 0, y: 0, width: 390, height: 844 } },
          {
            index: 1,
            parentIndex: 0,
            type: 'Button',
            label: 'Go',
            hittable: true,
            rect: { x: 10, y: 10, width: 80, height: 40 },
          },
        ],
      };
    case 'gestureViewport':
      return { x: 0, y: 0, x2: 390, y2: 844 };
    case 'rotate':
      return { orientation: sent.orientation };
    case 'scroll':
    case 'desktopScroll':
      return { referenceWidth: 390, referenceHeight: 844 };
    default:
      return {};
  }
}

export function singlePointerPanPlan(): GesturePlan {
  return {
    topology: 'single',
    intent: 'pan',
    executionProfile: 'timed-pan',
    durationMs: 120,
    viewport: { x: 0, y: 0, width: 390, height: 844 },
    pointers: [
      {
        pointerId: 0,
        samples: [
          { offsetMs: 0, point: { x: 100, y: 400 } },
          { offsetMs: 120, point: { x: 100, y: 200 } },
        ],
      },
    ],
  };
}
