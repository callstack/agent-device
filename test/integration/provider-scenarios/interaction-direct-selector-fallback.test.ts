import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AppError } from '../../../src/kernel/errors.ts';
import { assertRpcError, assertRpcOk } from './assertions.ts';
import { PROVIDER_SCENARIO_IOS_SIMULATOR } from './fixtures.ts';
import {
  createProviderScenarioHarness,
  withProviderScenarioResource,
  type ProviderScenarioHarness,
} from './harness.ts';
import {
  createAppleRunnerProviderFromTranscript,
  createRecordingAppleToolProvider,
  simctlListDevicesHandler,
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

// Drawer twin: same label off-screen and on-screen — runtime disambiguation
// prefers the visible candidate where the runner raised AMBIGUOUS_MATCH.
const AMBIGUOUS_NODES = [
  APPLICATION_NODE,
  {
    index: 1,
    parentIndex: 0,
    type: 'Button',
    label: 'Continue',
    hittable: true,
    rect: { x: -300, y: 300, width: 200, height: 44 },
  },
  {
    index: 2,
    parentIndex: 0,
    type: 'Button',
    label: 'Continue',
    hittable: true,
    rect: { x: 100, y: 300, width: 200, height: 44 },
  },
];

// A later overlay-like sibling covering the target's center: the runtime path
// annotates the target as covered and refuses the interaction with a hint.
const COVERED_NODES = [
  APPLICATION_NODE,
  {
    index: 1,
    parentIndex: 0,
    type: 'Button',
    label: 'Continue',
    hittable: true,
    rect: { x: 100, y: 300, width: 200, height: 44 },
  },
  {
    index: 2,
    parentIndex: 0,
    type: 'Sheet',
    label: 'Cookie consent',
    hittable: true,
    rect: { x: 0, y: 200, width: 400, height: 400 },
  },
];

// The runner skips non-hittable matches (ELEMENT_NOT_FOUND); the runtime path
// still resolves the element and annotates targetHittable/hint.
const NON_HITTABLE_NODES = [
  APPLICATION_NODE,
  {
    index: 1,
    parentIndex: 0,
    type: 'Button',
    label: 'Continue',
    hittable: false,
    rect: { x: 100, y: 300, width: 200, height: 44 },
  },
];

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
    simctl: simctlListDevicesHandler('com.apple.CoreSimulator.SimRuntime.iOS-18-0', [
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

test('Provider-backed direct iOS selector wait strips selectorChain from the public response', async () => {
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
      result: { found: true, node: { label: 'Continue' } },
    },
  ]);

  await withDirectSelectorScenario(transcript, async (daemon) => {
    const wait = await daemon.callCommand('wait', ['label="Continue"']);
    const data = assertRpcOk(wait);
    assert.equal(data.kind, 'selector');
    assert.equal(data.selector, 'label="Continue"');
    assert.equal('selectorChain' in data, false);
  });
});

test('Provider-backed integration runner AMBIGUOUS_MATCH falls back to runtime disambiguation', async () => {
  const transcript = createProviderTranscript([
    // Direct selector tap attempt fails with the runner's semantic shape.
    {
      command: 'ios.runner.tap',
      deviceId: DEVICE_ID,
      platform: 'apple',
      error: new AppError('AMBIGUOUS_MATCH', 'Selector matched multiple elements'),
    },
    // Fallback: tree capture, disambiguation picks the visible twin, taps it.
    snapshotEntry(AMBIGUOUS_NODES),
    {
      command: 'ios.runner.tap',
      deviceId: DEVICE_ID,
      platform: 'apple',
      result: { x: 200, y: 322 },
    },
  ]);

  await withDirectSelectorScenario(transcript, async (daemon) => {
    const click = await daemon.callCommand('click', ['label="Continue"']);
    const data = assertRpcOk(click);
    assert.equal(data.x, 200);
    assert.equal(data.y, 322);
    assert.ok(
      Array.isArray(data.selectorChain) && data.selectorChain.includes('label="Continue"'),
      `selectorChain must include the resolved selector, got ${JSON.stringify(data.selectorChain)}`,
    );

    const tapCalls = transcript.calls.filter((call) => call.command === 'ios.runner.tap');
    assert.equal(tapCalls.length, 2);
    const fallbackTap = tapCalls[1]?.request as Record<string, unknown>;
    assert.equal(fallbackTap.x, 200);
    assert.equal(fallbackTap.y, 322);
  });
});

test('Provider-backed integration runner ELEMENT_NOT_FOUND on a covered element surfaces the occlusion refusal', async () => {
  const transcript = createProviderTranscript([
    {
      command: 'ios.runner.tap',
      deviceId: DEVICE_ID,
      platform: 'apple',
      error: new AppError('ELEMENT_NOT_FOUND', 'element not found'),
    },
    // Interactive capture filters the covered node, so the runtime retries
    // with a full capture before raising the covered-element refusal.
    snapshotEntry(COVERED_NODES),
    snapshotEntry(COVERED_NODES),
  ]);

  await withDirectSelectorScenario(transcript, async (daemon) => {
    const click = await daemon.callCommand('click', ['label="Continue"']);
    const details = assertRpcError(
      click,
      'COMMAND_FAILED',
      /covered by another visible element and cannot be tapped safely/,
    );
    assert.match(String(details.hint ?? ''), /scroll it clear of the overlay/);
  });
});

test('Provider-backed integration runner ELEMENT_NOT_FOUND on a non-hittable element annotates targetHittable', async () => {
  const transcript = createProviderTranscript([
    {
      command: 'ios.runner.tap',
      deviceId: DEVICE_ID,
      platform: 'apple',
      error: new AppError('ELEMENT_NOT_FOUND', 'element not found'),
    },
    snapshotEntry(NON_HITTABLE_NODES),
    {
      command: 'ios.runner.tap',
      deviceId: DEVICE_ID,
      platform: 'apple',
      result: { x: 200, y: 322 },
    },
  ]);

  await withDirectSelectorScenario(transcript, async (daemon) => {
    const click = await daemon.callCommand('click', ['label="Continue"']);
    const data = assertRpcOk(click);
    assert.equal(data.targetHittable, false);
    assert.match(String(data.hint ?? ''), /hittable: false/);
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

test('Provider-backed integration maestro replay dispatch keeps runner ELEMENT_OFFSCREEN without fallback', async () => {
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
});
