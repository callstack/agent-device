import {
  type DeviceRuntimeGateway,
  type RuntimeFacts,
  type RuntimeOperationFact,
  localRuntimeOwner,
  narrowDeviceBinding,
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
import { deviceShape, type DeviceInfo } from '@agent-device/kernel/device';
import fs from 'node:fs';
import { vi, type Mock } from 'vitest';
import { PNG } from '@agent-device/capture-kit/png';
import type { BindDeviceRuntime, InspectDeviceRuntimeFacts } from '../request-runtime-binding.ts';
import { unavailableDeviceRuntimeGateway } from './test-device-runtime-gateway.ts';
import {
  type TapPointInput,
  touchRuntimeOperationFacts,
} from '@agent-device/contracts/touch-runtime';

const available = Object.freeze({ available: true } as const);
const unavailable = Object.freeze({
  available: false,
  reason: 'owner-capability-missing',
} as const);

export type ScreenshotRuntimeFixtureOptions = Readonly<{
  /** The exact-owner `captureScreenshot` fact this fake device reports. */
  capture?: RuntimeOperationFact;
  /** The exact-owner `captureSnapshot` fact, which `--overlay-refs` also requires. */
  snapshot?: RuntimeOperationFact;
  /** Replaces the default "write a solid PNG at the requested path" capture behavior. */
  onCapture?: (input: CaptureScreenshotInput) => Promise<void> | void;
  snapshotResult?: (input: CaptureSnapshotInput) => SnapshotResult;
  /** Gate for the neighbouring bound `scroll`, used by the device-lock serialization tests. */
  onScroll?: () => Promise<void> | void;
}>;

export type ScreenshotRuntimeFixture = Readonly<{
  gateway: DeviceRuntimeGateway<PlatformRuntimeOperations>;
  inspectFacts: InspectDeviceRuntimeFacts;
  bindDevice: BindDeviceRuntime;
  captureScreenshot: Mock<(input: CaptureScreenshotInput) => Promise<void>>;
  captureSnapshot: Mock<(input: CaptureSnapshotInput) => Promise<SnapshotResult>>;
  tapPoint: Mock<(input: TapPointInput) => Promise<Record<string, unknown>>>;
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
      options.snapshotResult?.(input) ?? {
        nodes: [],
        backend: 'android',
        producer: 'android-uiautomator',
      },
  );
  const tapPoint = vi.fn(async (_input: TapPointInput) => ({}));
  // R43: `scroll` is the neighbouring command the device-lock tests use to prove serialization,
  // and it now reaches the platform through a bound operation like the screenshot beside it.
  const scrollDirection = vi.fn(async () => {
    await options.onScroll?.();
    return {};
  });

  // The unavailable gateway is the exhaustive fact catalog; only the capture cells are overridden.
  const facts = async (device: DeviceInfo): Promise<RuntimeFacts<PlatformRuntimeOperations>> => {
    const base = await unavailableDeviceRuntimeGateway.inspectFacts(device);
    return {
      device: { ...deviceShape(device), providerMode: 'local' },
      operations: {
        ...base.operations,
        ...screenshotRuntimeOperationFacts({ capture: options.capture ?? available }),
        scrollDirection: available,
        ...snapshotRuntimeOperationFacts({
          capture: options.snapshot ?? available,
          customActions: options.snapshot ?? available,
          withoutActiveApp: options.snapshot ?? available,
        }),
        ...touchRuntimeOperationFacts({
          tap: available,
          longPress: unavailable,
          hover: unavailable,
          fill: unavailable,
          tapElementSelector: unavailable,
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
        tapPoint,
        scrollDirection,
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
    tapPoint,
    binds,
  };
}

export function writeSolidPng(filePath: string, width = 100, height = 50): void {
  const png = new PNG({ width, height });
  png.data.fill(255);
  fs.writeFileSync(filePath, PNG.sync.write(png));
}
