import assert from 'node:assert/strict';
import { test } from 'vitest';
import { IOS_SIMULATOR } from '../../../__tests__/test-utils/index.ts';
import { createAppleInteractor } from '../interactor.ts';
import { AppError } from '../../../kernel/errors.ts';
import type { GesturePlan } from '../../../contracts/gesture-plan-types.ts';
import type { Interactor, RunnerContext } from '../../../core/interactor-types.ts';
import type {
  AppleRunnerCommandOptions,
  AppleRunnerProvider,
} from '../core/runner/runner-provider.ts';
import type { RunnerCommand } from '../core/runner/runner-contract.ts';

type RecordedRunnerCall = { command: RunnerCommand; options: AppleRunnerCommandOptions };

// Every Interactor method must either ride the injected runner transport or
// fail fast as a local-tooling method the provider composes itself. The two
// tables below partition the surface; the partition test keeps them total, so
// a new Interactor method fails loudly here until it is classified.
const RUNNER_TRANSPORT_METHODS: Record<
  string,
  { invoke: (interactor: Interactor) => Promise<unknown>; runnerCommand: string }
> = {
  tap: { invoke: (i) => i.tap(10, 20), runnerCommand: 'tap' },
  tapElementSelector: {
    invoke: (i) => i.tapElementSelector!({ key: 'label', value: 'Go' }),
    runnerCommand: 'tap',
  },
  doubleTap: { invoke: (i) => i.doubleTap(10, 20), runnerCommand: 'sequence' },
  longPress: { invoke: (i) => i.longPress(10, 20, 600), runnerCommand: 'longPress' },
  focus: { invoke: (i) => i.focus(10, 20), runnerCommand: 'tap' },
  type: { invoke: (i) => i.type('hi'), runnerCommand: 'type' },
  fillElementSelector: {
    invoke: (i) => i.fillElementSelector!({ key: 'label', value: 'Go' }, 'hi'),
    runnerCommand: 'type',
  },
  fill: { invoke: (i) => i.fill(10, 20, 'hi'), runnerCommand: 'type' },
  scroll: { invoke: (i) => i.scroll('down'), runnerCommand: 'scroll' },
  performGesture: {
    invoke: (i) => i.performGesture!(singlePointerPanPlan()),
    runnerCommand: 'gesture',
  },
  gestureViewport: { invoke: (i) => i.gestureViewport!(), runnerCommand: 'gestureViewport' },
  snapshot: { invoke: (i) => i.snapshot(), runnerCommand: 'snapshot' },
  back: { invoke: (i) => i.back(), runnerCommand: 'backInApp' },
  home: { invoke: (i) => i.home(), runnerCommand: 'home' },
  setOrientation: { invoke: (i) => i.setOrientation('portrait'), runnerCommand: 'rotate' },
  appSwitcher: { invoke: (i) => i.appSwitcher(), runnerCommand: 'appSwitcher' },
  tvRemote: { invoke: (i) => i.tvRemote('select'), runnerCommand: 'remotePress' },
};

const LOCAL_TOOL_METHODS: Record<string, (interactor: Interactor) => Promise<unknown>> = {
  open: (i) => i.open('com.example.app'),
  openDevice: (i) => i.openDevice(),
  close: (i) => i.close('com.example.app'),
  screenshot: (i) => i.screenshot('/dev/null'),
  readClipboard: (i) => i.readClipboard(),
  writeClipboard: (i) => i.writeClipboard('hi'),
  setSetting: (i) => i.setSetting('wifi', 'on'),
};

test('the runner/local partition covers the full provider-backed interactor surface', () => {
  const interactor = createAppleInteractor(IOS_SIMULATOR, {}, recordingRunnerProvider([]));
  const classified = [
    ...Object.keys(RUNNER_TRANSPORT_METHODS),
    ...Object.keys(LOCAL_TOOL_METHODS),
  ].sort();
  assert.deepEqual(Object.keys(interactor).sort(), classified);
});

test('provider-backed interactor routes runner-command methods through the injected transport', async () => {
  const calls: RecordedRunnerCall[] = [];
  const interactor = createAppleInteractor(
    IOS_SIMULATOR,
    { appBundleId: 'com.example.app' },
    recordingRunnerProvider(calls),
  );
  for (const [method, { invoke, runnerCommand }] of Object.entries(RUNNER_TRANSPORT_METHODS)) {
    calls.length = 0;
    await invoke(interactor);
    assert.ok(calls.length >= 1, `${method} never reached the injected runner transport`);
    assert.equal(calls[0]!.command.command, runnerCommand, `${method} sent a different command`);
  }
});

test('provider-backed interactor rejects local Apple tooling methods with a clear error', async () => {
  const interactor = createAppleInteractor(IOS_SIMULATOR, {}, recordingRunnerProvider([]));
  for (const [method, invoke] of Object.entries(LOCAL_TOOL_METHODS)) {
    await assert.rejects(
      invoke(interactor),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'UNSUPPORTED_OPERATION' &&
        error.message.includes('provider session'),
      `${method} should reject as a local-tooling method`,
    );
  }
});

test('injected transport still resolves when the runner context carries a request id', async () => {
  const calls: RecordedRunnerCall[] = [];
  const runnerContext: RunnerContext = { requestId: 'req-42' };
  const interactor = createAppleInteractor(
    IOS_SIMULATOR,
    runnerContext,
    recordingRunnerProvider(calls),
  );
  await interactor.tap(10, 20);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.options.requestId, 'req-42');
});

test('snapshot over the injected transport keeps the shared xctest result shape', async () => {
  const interactor = createAppleInteractor(IOS_SIMULATOR, {}, recordingRunnerProvider([]));
  const result = await interactor.snapshot();
  assert.equal(result.backend, 'xctest');
  assert.equal(result.nodes?.length, 2);
});

function recordingRunnerProvider(calls: RecordedRunnerCall[]): AppleRunnerProvider {
  return {
    runCommand: async (_device, command, options) => {
      calls.push({ command, options });
      return runnerResultFor(command);
    },
  };
}

function runnerResultFor(command: RunnerCommand): Record<string, unknown> {
  switch (command.command) {
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
    default:
      return {};
  }
}

function singlePointerPanPlan(): GesturePlan {
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
