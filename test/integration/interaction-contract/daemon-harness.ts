import { assertRpcOk } from '../provider-scenarios/assertions.ts';
import { PROVIDER_SCENARIO_IOS_SIMULATOR } from '../provider-scenarios/fixtures.ts';
import {
  createProviderScenarioHarness,
  withProviderScenarioResource,
  type ProviderScenarioHarness,
} from '../provider-scenarios/harness.ts';
import {
  createAppleRunnerProviderFromTranscript,
  createRecordingAppleToolProvider,
  simctlDeviceLifecycleHandler,
} from '../provider-scenarios/providers.ts';
import {
  createProviderTranscript,
  type ProviderScenarioProviderEntry,
  type ProviderScenarioTranscript,
} from '../provider-scenarios/transcript.ts';

export const CONTRACT_APP = 'com.example.app';
const CONTRACT_DEVICE_ID = PROVIDER_SCENARIO_IOS_SIMULATOR.id;

const SETTLING_CAPTURE_READS = 2;
const SETTLING_CAPTURE_NODES = [
  {
    index: 0,
    type: 'Application',
    label: 'Example',
    rect: { x: 0, y: 0, width: 400, height: 800 },
  },
];

/**
 * Provider-transcript harness for contract scenarios whose path involves the
 * iOS runner (maestro-non-hittable-fallback) or that
 * prove daemon-level response construction. The transcript is the proof
 * vehicle: `assertComplete` after `run` guarantees exactly the scripted
 * runner conversation happened — a path that dispatched differently either
 * consumes an unexpected entry or leaves one behind.
 */
export async function withIosContractDaemon(
  entries: readonly ProviderScenarioProviderEntry[],
  run: (daemon: ProviderScenarioHarness, transcript: ProviderScenarioTranscript) => Promise<void>,
  options: { saveScript?: boolean | string } = {},
): Promise<void> {
  // The scripted open is not read back, so the first capture after it settles over a quiet pair of
  // reads and pauses the direct selector path. A snapshot consumes that pair here, keeping each
  // scenario's own conversation with the runner exactly as scripted.
  const transcript = createProviderTranscript([
    ...Array.from({ length: SETTLING_CAPTURE_READS }, () =>
      runnerSnapshotEntry(SETTLING_CAPTURE_NODES),
    ),
    ...entries,
  ]);
  const scenarioTranscript: ProviderScenarioTranscript = {
    get calls() {
      return transcript.calls.slice(SETTLING_CAPTURE_READS);
    },
    get remaining() {
      return transcript.remaining;
    },
    assertComplete: () => transcript.assertComplete(),
    next: (command, request, scope) => transcript.next(command, request, scope),
  };
  const appleRunnerProvider = createAppleRunnerProviderFromTranscript(transcript, 'ios.runner');
  const appleTool = createRecordingAppleToolProvider({
    simctl: simctlDeviceLifecycleHandler('com.apple.CoreSimulator.SimRuntime.iOS-18-0', [
      { name: PROVIDER_SCENARIO_IOS_SIMULATOR.name, udid: CONTRACT_DEVICE_ID },
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
      const open = await daemon.callCommand('open', [CONTRACT_APP], {
        platform: 'ios',
        udid: CONTRACT_DEVICE_ID,
        ...(options.saveScript !== undefined ? { saveScript: options.saveScript } : {}),
      });
      assertRpcOk(open);
      assertRpcOk(await daemon.callCommand('snapshot'));
      await run(daemon, scenarioTranscript);
      transcript.assertComplete();
    },
  );
}

export function runnerSnapshotEntry(nodes: readonly unknown[]): ProviderScenarioProviderEntry {
  return {
    command: 'ios.runner.snapshot',
    deviceId: CONTRACT_DEVICE_ID,
    platform: 'apple',
    result: { nodes, truncated: false },
  };
}

export function runnerTapEntry(
  result: Record<string, unknown>,
  request?: Record<string, unknown>,
): ProviderScenarioProviderEntry {
  return {
    command: 'ios.runner.tap',
    deviceId: CONTRACT_DEVICE_ID,
    platform: 'apple',
    ...(request ? { request } : {}),
    result,
  };
}

export function runnerTypeEntry(
  result: Record<string, unknown>,
  request?: Record<string, unknown>,
): ProviderScenarioProviderEntry {
  return {
    command: 'ios.runner.type',
    deviceId: CONTRACT_DEVICE_ID,
    platform: 'apple',
    ...(request ? { request } : {}),
    result,
  };
}

export function runnerLongPressEntry(
  result: Record<string, unknown>,
  request?: Record<string, unknown>,
): ProviderScenarioProviderEntry {
  return {
    command: 'ios.runner.longPress',
    deviceId: CONTRACT_DEVICE_ID,
    platform: 'apple',
    ...(request ? { request } : {}),
    result,
  };
}

export function runnerGestureViewportEntry(): ProviderScenarioProviderEntry {
  return {
    command: 'ios.runner.gestureViewport',
    deviceId: CONTRACT_DEVICE_ID,
    platform: 'apple',
    result: { x: 0, y: 0, x2: 400, y2: 800 },
  };
}

export function runnerGestureEntry(
  result: Record<string, unknown> = {},
): ProviderScenarioProviderEntry {
  return {
    command: 'ios.runner.gesture',
    deviceId: CONTRACT_DEVICE_ID,
    platform: 'apple',
    result,
  };
}

export function runnerTapErrorEntry(error: Error): ProviderScenarioProviderEntry {
  return {
    command: 'ios.runner.tap',
    deviceId: CONTRACT_DEVICE_ID,
    platform: 'apple',
    error,
  };
}
