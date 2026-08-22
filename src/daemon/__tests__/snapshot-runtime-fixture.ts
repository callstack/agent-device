import {
  type RuntimeFacts,
  localRuntimeOwner,
  narrowDeviceBinding,
  providerRuntimeOwner,
} from '@agent-device/contracts/platform-runtime';
import type { PlatformRuntimeOperations } from '@agent-device/contracts/platform-runtime-operations';
import {
  type CaptureScreenshotInput,
  screenshotRuntimeOperationFacts,
} from '@agent-device/contracts/screenshot-runtime';
import {
  type CaptureSnapshotInput,
  type SnapshotResult,
  snapshotRuntimeOperationFacts,
} from '@agent-device/contracts/snapshot-runtime';
import { deviceShape, isIosFamily, type DeviceInfo } from '@agent-device/kernel/device';
import { dispatchCommand, type DispatchContext } from '../../core/dispatch.ts';
import { getRequestSignal } from '../../request/cancel.ts';
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
        },
        [Symbol.asyncDispose]: async () => {},
      },
      use,
    );
  };

  return { inspectFacts, bindDevice };
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
  return (await dispatchCommand(device, 'snapshot', [], undefined, context)) as SnapshotResult;
}
