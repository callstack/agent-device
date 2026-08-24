import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { assertRpcError, assertRpcOk } from './assertions.ts';
import { PARALLEL_PROVIDER_SCENARIO_TIMEOUT_MS } from './test-timeouts.ts';
import { PROVIDER_SCENARIO_IOS_SIMULATOR } from './fixtures.ts';
import {
  createProviderScenarioHarness,
  withProviderScenarioResource,
  type ProviderScenarioHarness,
} from './harness.ts';
import {
  createAppleRunnerProviderFromTranscript,
  createRecordingAppleToolProvider,
  simctlDeviceLifecycleHandler,
} from './providers.ts';
import {
  createProviderTranscript,
  type ProviderScenarioProviderEntry,
  type ProviderScenarioTranscript,
} from './transcript.ts';

// ADR 0011 delegation-on-error for the direct iOS selector path: when the
// runner fails with a semantic shape (ELEMENT_NOT_FOUND / AMBIGUOUS_MATCH),
// the dispatch falls back to tree-based runtime resolution, which supplies
// runtime disambiguation, occlusion refusal, and non-hittable
// promotion/annotation. Maestro replay dispatches keep the runner-native
// error shapes (no fallback).

const APP = 'com.example.app';
const DEVICE_ID = PROVIDER_SCENARIO_IOS_SIMULATOR.id;

const APPLICATION_NODE = {
  index: 0,
  type: 'Application',
  label: 'Example',
  rect: { x: 0, y: 0, width: 400, height: 800 },
};

function snapshotEntry(nodes: unknown[]): ProviderScenarioProviderEntry {
  return {
    command: 'ios.runner.snapshot',
    deviceId: DEVICE_ID,
    platform: 'apple',
    result: { nodes, truncated: false },
  };
}

async function withDirectSelectorScenario(
  transcript: ProviderScenarioTranscript,
  run: (daemon: ProviderScenarioHarness) => Promise<void>,
): Promise<void> {
  const appleRunnerProvider = createAppleRunnerProviderFromTranscript(transcript, 'ios.runner');
  const appleTool = createRecordingAppleToolProvider({
    simctl: simctlDeviceLifecycleHandler('com.apple.CoreSimulator.SimRuntime.iOS-18-0', [
      { name: PROVIDER_SCENARIO_IOS_SIMULATOR.name, udid: DEVICE_ID },
    ]),
  });

  await withProviderScenarioResource(
    async () =>
      await createProviderScenarioHarness({
        appleRunnerProvider: () => appleRunnerProvider,
        appleToolProvider: () => appleTool.provider,
        deviceInventoryProvider: async () => [PROVIDER_SCENARIO_IOS_SIMULATOR],
      }),
    async (daemon) => {
      const open = await daemon.callCommand('open', [APP], {
        platform: 'ios',
        udid: DEVICE_ID,
      });
      assertRpcOk(open);
      await run(daemon);
      transcript.assertComplete();
    },
  );
}

// `wait` asks the admitted Apple owner first for simple selector existence. A positive
// owner observation avoids a sparse canonical tree; a miss still falls through to the
// request-bound capture. The public response strips the internal `selectorChain` either way.
test('Provider-backed iOS selector wait accepts the owner observation and strips selectorChain', async () => {
  const transcript = createProviderTranscript([
    {
      command: 'ios.runner.querySelector',
      deviceId: DEVICE_ID,
      platform: 'apple',
      request: {
        command: 'querySelector',
        selectorKey: 'label',
        selectorValue: 'Continue',
        appBundleId: APP,
      },
      result: { found: true, nodes: [] },
    },
  ]);

  await withDirectSelectorScenario(transcript, async (daemon) => {
    const wait = await daemon.callCommand('wait', ['label="Continue"']);
    const data = assertRpcOk(wait);
    assert.equal(data.selector, 'label="Continue"');
    assert.equal('selectorChain' in data, false);
  });
});

test('Provider-backed iOS selector wait falls through to capture after an owner miss', async () => {
  const transcript = createProviderTranscript([
    {
      command: 'ios.runner.querySelector',
      deviceId: DEVICE_ID,
      platform: 'apple',
      request: {
        command: 'querySelector',
        selectorKey: 'label',
        selectorValue: 'Continue',
        appBundleId: APP,
      },
      result: { found: false, nodes: [] },
    },
    snapshotEntry([
      APPLICATION_NODE,
      {
        index: 1,
        parentIndex: 0,
        type: 'Button',
        label: 'Continue',
        hittable: true,
        rect: { x: 100, y: 300, width: 200, height: 44 },
      },
    ]),
  ]);

  await withDirectSelectorScenario(transcript, async (daemon) => {
    const wait = await daemon.callCommand('wait', ['label="Continue"']);
    const data = assertRpcOk(wait);
    assert.equal(data.selector, 'label="Continue"');
    assert.equal('selectorChain' in data, false);
  });
});

test('Provider-backed integration maestro replay dispatch keeps runner AMBIGUOUS_MATCH without fallback', async () => {
  const transcript = createProviderTranscript([
    {
      command: 'ios.runner.tap',
      deviceId: DEVICE_ID,
      platform: 'apple',
      // Proves the maestro flag rode along on the direct dispatch AND that no
      // snapshot fallback follows: this is the only transcript entry.
      request: {
        command: 'tap',
        selectorKey: 'label',
        selectorValue: 'Continue',
        allowNonHittableCoordinateFallback: true,
        synthesized: true,
        appBundleId: APP,
      },
      error: new AppError('AMBIGUOUS_MATCH', 'Selector matched multiple elements'),
    },
  ]);

  await withDirectSelectorScenario(transcript, async (daemon) => {
    const click = await daemon.callCommand('click', ['label="Continue"'], {
      maestro: { allowNonHittableCoordinateFallback: true },
    });
    assertRpcError(click, 'AMBIGUOUS_MATCH', /matched multiple/);
  });
});

test(
  'Provider-backed integration maestro replay dispatch keeps runner ELEMENT_OFFSCREEN without fallback',
  async () => {
    const transcript = createProviderTranscript([
      {
        command: 'ios.runner.tap',
        deviceId: DEVICE_ID,
        platform: 'apple',
        request: {
          command: 'tap',
          selectorKey: 'label',
          selectorValue: 'Continue',
          allowNonHittableCoordinateFallback: true,
          synthesized: true,
          appBundleId: APP,
        },
        error: new AppError('ELEMENT_OFFSCREEN', 'element resolved off-screen at (-161, 265)'),
      },
    ]);

    await withDirectSelectorScenario(transcript, async (daemon) => {
      const click = await daemon.callCommand('click', ['label="Continue"'], {
        maestro: { allowNonHittableCoordinateFallback: true },
      });
      assertRpcError(click, 'ELEMENT_OFFSCREEN', /resolved off-screen/);
    });
  },
  PARALLEL_PROVIDER_SCENARIO_TIMEOUT_MS,
);
