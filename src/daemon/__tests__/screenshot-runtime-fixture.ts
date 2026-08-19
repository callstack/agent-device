import {
  localRuntimeOwner,
  narrowDeviceBinding,
  screenshotRuntimeOperationFacts,
  snapshotRuntimeOperationFacts,
  type CaptureScreenshotInput,
  type CaptureSnapshotInput,
  type DeviceRuntimeGateway,
  type PlatformRuntimeOperations,
  type RuntimeFacts,
  type RuntimeOperationFact,
  type SnapshotResult,
} from '@agent-device/contracts/platform';
import { deviceShape, type DeviceInfo } from '@agent-device/kernel/device';
import fs from 'node:fs';
import { vi, type Mock } from 'vitest';
import { PNG } from '../../utils/png.ts';
import type { BindDeviceRuntime, InspectDeviceRuntimeFacts } from '../request-runtime-binding.ts';
import { unavailableDeviceRuntimeGateway } from './test-device-runtime-gateway.ts';

const available = Object.freeze({ available: true } as const);

export type ScreenshotRuntimeFixtureOptions = Readonly<{
  /** The exact-owner `captureScreenshot` fact this fake device reports. */
  capture?: RuntimeOperationFact;
  /** The exact-owner `captureSnapshot` fact, which `--overlay-refs` also requires. */
  snapshot?: RuntimeOperationFact;
  /** Replaces the default "write a solid PNG at the requested path" capture behavior. */
  onCapture?: (input: CaptureScreenshotInput) => Promise<void> | void;
  snapshotResult?: (input: CaptureSnapshotInput) => SnapshotResult;
}>;

export type ScreenshotRuntimeFixture = Readonly<{
  gateway: DeviceRuntimeGateway<PlatformRuntimeOperations>;
  inspectFacts: InspectDeviceRuntimeFacts;
  bindDevice: BindDeviceRuntime;
  captureScreenshot: Mock<(input: CaptureScreenshotInput) => Promise<void>>;
  captureSnapshot: Mock<(input: CaptureSnapshotInput) => Promise<SnapshotResult>>;
  /** Every `(device, use)` the route bound, so a test can prove exactly one bind happened. */
  binds: Array<Readonly<{ device: DeviceInfo }>>;
}>;

/**
 * The request-scoped screenshot seam a migrated route consumes: exact owner facts plus one
 * binding. Tests assert against the capture input the runtime received, never against a legacy
 * dispatch call.
 */
export function screenshotRuntimeFixture(
  options: ScreenshotRuntimeFixtureOptions = {},
): ScreenshotRuntimeFixture {
  const binds: Array<Readonly<{ device: DeviceInfo }>> = [];
  const captureScreenshot = vi.fn(async (input: CaptureScreenshotInput) => {
    if (options.onCapture) {
      await options.onCapture(input);
      return;
    }
    writeSolidPng(input.outPath);
  });
  const captureSnapshot = vi.fn(
    async (input: CaptureSnapshotInput): Promise<SnapshotResult> =>
      options.snapshotResult?.(input) ?? { nodes: [], backend: 'android' },
  );

  // The unavailable gateway is the exhaustive fact catalog; only the capture cells are overridden.
  const facts = async (device: DeviceInfo): Promise<RuntimeFacts<PlatformRuntimeOperations>> => {
    const base = await unavailableDeviceRuntimeGateway.inspectFacts(device);
    return {
      device: { ...deviceShape(device), providerMode: 'local' },
      operations: {
        ...base.operations,
        ...screenshotRuntimeOperationFacts({ capture: options.capture ?? available }),
        ...snapshotRuntimeOperationFacts({
          capture: options.snapshot ?? available,
          customActions: options.snapshot ?? available,
          withoutActiveApp: options.snapshot ?? available,
        }),
      },
    };
  };

  const binding = async (device: DeviceInfo) => {
    binds.push({ device });
    return {
      device,
      owner: localRuntimeOwner(device.platform),
      facts: await facts(device),
      operations: {
        captureScreenshot,
        captureSnapshot,
        captureSnapshotWithCustomActions: captureSnapshot,
        captureSnapshotWithoutActiveApp: captureSnapshot,
      },
      [Symbol.asyncDispose]: async () => {},
    };
  };

  const inspectFacts: InspectDeviceRuntimeFacts = async (device) => await facts(device);
  const bindDevice: BindDeviceRuntime = async (device, use) =>
    narrowDeviceBinding(await binding(device), use);

  return {
    gateway: Object.freeze({
      inspectFacts,
      bind: async ({ device }) => await binding(device),
      shutdown: async () => {},
    }),
    inspectFacts,
    bindDevice,
    captureScreenshot,
    captureSnapshot,
    binds,
  };
}

export function writeSolidPng(filePath: string, width = 100, height = 50): void {
  const png = new PNG({ width, height });
  png.data.fill(255);
  fs.writeFileSync(filePath, PNG.sync.write(png));
}
