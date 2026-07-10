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
  simctlListDevicesHandler,
} from '../provider-scenarios/providers.ts';
import {
  createProviderTranscript,
  type ProviderScenarioProviderEntry,
  type ProviderScenarioTranscript,
} from '../provider-scenarios/transcript.ts';

export const CONTRACT_APP = 'com.example.app';
const CONTRACT_DEVICE_ID = PROVIDER_SCENARIO_IOS_SIMULATOR.id;

/**
 * Provider-transcript harness for contract scenarios whose path involves the
 * iOS runner (direct-ios-selector, maestro-non-hittable-fallback) or that
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
  const transcript = createProviderTranscript(entries);
  const appleRunnerProvider = createAppleRunnerProviderFromTranscript(transcript, 'ios.runner');
  const appleTool = createRecordingAppleToolProvider({
    simctl: simctlListDevicesHandler('com.apple.CoreSimulator.SimRuntime.iOS-18-0', [
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
      await run(daemon, transcript);
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

export function runnerTapErrorEntry(error: Error): ProviderScenarioProviderEntry {
  return {
    command: 'ios.runner.tap',
    deviceId: CONTRACT_DEVICE_ID,
    platform: 'apple',
    error,
  };
}
