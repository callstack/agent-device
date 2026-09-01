import {
  type RuntimeFacts,
  localRuntimeOwner,
  narrowDeviceBinding,
  providerRuntimeOwner,
} from '@agent-device/contracts/platform-runtime';
import type { PlatformRuntimeOperations } from '@agent-device/contracts/platform-runtime-operations';
import { legacyDispatchCapture } from './legacy-snapshot-capture-fixture.ts';
import {
  type AlertRuntimeInput,
  alertRuntimeOperationFacts,
} from '@agent-device/contracts/alert-runtime';
import {
  type SetSettingInput,
  settingsRuntimeOperationFacts,
} from '@agent-device/contracts/settings-runtime';
import {
  type CaptureScreenshotInput,
  screenshotRuntimeOperationFacts,
} from '@agent-device/contracts/screenshot-runtime';
import {
  type CaptureSnapshotInput,
  type SnapshotResult,
  snapshotRuntimeOperationFacts,
} from '@agent-device/contracts/snapshot-runtime';
import {
  deviceShape,
  isApplePlatform,
  isIosFamily,
  isMacOs,
  type DeviceInfo,
} from '@agent-device/kernel/device';
import { applePlugin } from '@agent-device/platform-apple';
import { type DispatchContext } from '../../core/dispatch-context.ts';
import { getRequestSignal } from '@agent-device/host-kit/request';
import { isActiveProviderDevice } from '../../provider-device-runtime.ts';
import type { BindDeviceRuntime, InspectDeviceRuntimeFacts } from '../request-runtime-binding.ts';
import { unavailableDeviceRuntimeGateway } from './test-device-runtime-gateway.ts';
import { writeSolidPng } from './screenshot-runtime-fixture.ts';

/**
 * Every capture the fixture's bound screenshot operation received, newest last. Handler tests that
 * cannot reach the fixture instance (the snapshot route builds it internally) assert the capture
 * intent here instead of on a legacy dispatch call.
 */
export const fixtureScreenshotCaptures: CaptureScreenshotInput[] = [];

/**
 * Every mutation the fixture's bound settings operation received, newest last. The neutral input
 * is the whole assertion surface now: whether a request reached the owner, and with which setting,
 * state and resolved app id, is exactly what the retired positional dispatch used to witness.
 */
export const fixtureSettingsMutations: SetSettingInput[] = [];

/** Clears both recorders so a suite can assert "the owner was never reached" from a known zero. */
export function resetSnapshotRuntimeFixture(): void {
  fixtureScreenshotCaptures.length = 0;
  fixtureSettingsMutations.length = 0;
}

/** Request-scoped snapshot seam for handler tests that mock the legacy leaf dispatch. */
export function snapshotRuntimeFixture(requestId?: string): Readonly<{
  inspectFacts: InspectDeviceRuntimeFacts;
  bindDevice: BindDeviceRuntime;
}> {
  const requestSignal = getRequestSignal(requestId) ?? new AbortController().signal;

  const inspectFacts: InspectDeviceRuntimeFacts = async (device) => await snapshotFacts(device);
  const bindDevice: BindDeviceRuntime = async (device, use) => {
    const facts = await snapshotFacts(device);
    const providerOwned = facts.device.providerMode === 'provider-runtime';
    const captureSnapshot = async (input: CaptureSnapshotInput) =>
      await dispatchFixtureSnapshot(device, input, requestSignal);
    const captureScreenshot = async (input: CaptureScreenshotInput) => {
      fixtureScreenshotCaptures.push(input);
      writeSolidPng(input.outPath);
    };
    const setSetting = async (input: SetSettingInput) => {
      fixtureSettingsMutations.push(input);
      return {};
    };
    // R59: the alert legs delegate to the Apple owner's own module, so the poll and retry windows
    // these suites exercise are the shipped ones rather than a fixture's imitation of them. The
    // runner underneath is the suite's own mock.
    const runnerOptions = { signal: requestSignal };
    const appleInteractor = isApplePlatform(device.platform)
      ? await applePlugin.createInteractor(device, runnerOptions)
      : undefined;
    const alertOptions = (input: AlertRuntimeInput) => ({
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      ...(input.appBundleId === undefined ? {} : { appBundleId: input.appBundleId }),
      ...(input.surface === undefined ? {} : { surface: input.surface }),
    });
    return narrowDeviceBinding(
      {
        device,
        owner: providerOwned
          ? providerRuntimeOwner('test', 'snapshot-runtime-fixture')
          : localRuntimeOwner(device.platform),
        facts,
        operations: {
          captureSnapshot,
          captureSnapshotWithCustomActions: captureSnapshot,
          captureSnapshotWithoutActiveApp: captureSnapshot,
          captureScreenshot,
          setSetting,
          ...(appleInteractor
            ? {
                readAlert: async (input: AlertRuntimeInput) =>
                  await appleInteractor.readAlert(alertOptions(input)),
                awaitAlert: async (input: AlertRuntimeInput) =>
                  await appleInteractor.awaitAlert(alertOptions(input)),
                acceptAlert: async (input: AlertRuntimeInput) =>
                  await appleInteractor.acceptAlert(alertOptions(input)),
                dismissAlert: async (input: AlertRuntimeInput) =>
                  await appleInteractor.dismissAlert(alertOptions(input)),
              }
            : {}),
        },
        [Symbol.asyncDispose]: async () => {},
      },
      use,
    );
  };

  return { inspectFacts, bindDevice };
}

/** A physical Apple device that is not the macOS host: the one settings refusal these suites use. */
function appleHostOrSimulatorOnly(device: DeviceInfo): boolean {
  return device.platform === 'apple' && device.kind === 'device' && !isMacOs(device);
}

const settingsUnavailable = {
  available: false,
  reason: 'unsupported-platform-leaf',
  hint: 'settings is supported on Apple simulators and the macOS host, not on physical devices of this OS.',
} as const;

const alertUnavailable = {
  available: false,
  reason: 'unsupported-platform-leaf',
  hint: 'This fixture models the Apple alert legs only.',
} as const;

function alertCell(device: DeviceInfo) {
  return isApplePlatform(device.platform) ? ({ available: true } as const) : alertUnavailable;
}

async function snapshotFacts(device: DeviceInfo): Promise<RuntimeFacts<PlatformRuntimeOperations>> {
  const base = await unavailableDeviceRuntimeGateway.inspectFacts(device);
  const providerOwned = isActiveProviderDevice(device);
  const available = { available: true } as const;
  const customActionsUnavailable = {
    available: false,
    reason: 'unsupported-platform-leaf',
    hint: 'Re-run without --actions, or target an iOS simulator.',
  } as const;
  const activeAppRequired = {
    available: false,
    reason: 'owner-capability-missing',
    hint: 'Local Apple snapshot capture requires an active app session.',
  } as const;
  return {
    device: {
      ...deviceShape(device),
      providerMode: providerOwned ? 'provider-runtime' : 'local',
    },
    operations: {
      ...base.operations,
      ...screenshotRuntimeOperationFacts({ capture: available }),
      ...snapshotRuntimeOperationFacts({
        capture: available,
        customActions:
          isIosFamily(device) && device.kind === 'simulator' ? available : customActionsUnavailable,
        withoutActiveApp: providerOwned || !isIosFamily(device) ? available : activeAppRequired,
      }),
      // R58: `settings` runs on the snapshot route, so this fixture states its cell too. It
      // restates only the one refusal these suites exercise — a physical non-macOS Apple device
      // has no settings surface — and the full Apple cell table is pinned where it belongs, in
      // `platform-apple/src/system/runtime.test.ts`.
      ...settingsRuntimeOperationFacts({
        setSetting: appleHostOrSimulatorOnly(device) ? settingsUnavailable : available,
      }),
      // R59: `alert` runs on the snapshot route too. Only the Apple legs are modeled — every
      // alert suite that reaches this fixture drives an Apple session — and the full per-owner
      // cell tables are pinned where they belong, in each platform package's runtime test.
      ...alertRuntimeOperationFacts({
        read: alertCell(device),
        wait: alertCell(device),
        accept: alertCell(device),
        dismiss: alertCell(device),
      }),
    },
  };
}

async function dispatchFixtureSnapshot(
  device: DeviceInfo,
  input: CaptureSnapshotInput,
  signal: AbortSignal,
): Promise<SnapshotResult> {
  const options = input.options ?? {};
  const context: DispatchContext = {
    ...input.execution,
    signal,
    appBundleId: options.appBundleId,
    snapshotInteractiveOnly: options.interactiveOnly,
    snapshotPreferredBackend: options.preferredBackend,
    snapshotDepth: options.depth,
    snapshotScope: options.scope,
    snapshotRaw: options.raw,
    snapshotCustomActions: options.customActions,
    snapshotIncludeHiddenContentHints: options.includeHiddenContentHints,
    surface: options.surface,
  };
  return (await legacyDispatchCapture(
    device,
    'snapshot',
    [],
    undefined,
    context,
  )) as SnapshotResult;
}
