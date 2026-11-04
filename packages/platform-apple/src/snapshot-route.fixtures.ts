import { vi } from 'vitest';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { IOS_SYSTEM_SURFACE_HOSTS } from '@agent-device/contracts/ios-system-surface';
import { simulatorAddressFor } from './core/simctl.ts';
import { platformRuntimeHostFixture } from './runtime.fixtures.ts';
import type { SimulatorSnapshotSource, SnapshotSourceOutcome } from './snapshot-source-facade.ts';

export const ios = {
  platform: 'apple',
  appleOs: 'ios',
  id: 'ios-1',
  name: 'iPhone',
  kind: 'simulator',
  target: 'mobile',
  booted: true,
} as const satisfies DeviceInfo;

export const target = {
  simulator: simulatorAddressFor(ios),
  runtime: 'iOS 26.0',
  pid: 42,
  generation: '42:launch-a',
  targetId: `${ios.id}:com.example.app`,
  processStartTime: 'target-start',
} as const;

export const input = { options: { appBundleId: 'com.example.app' } } as const;

/** A proven-present surface as the runner's foreground read reports it: the matched host travels with the verdict. */
export const presentSurface = { kind: 'present', host: IOS_SYSTEM_SURFACE_HOSTS[0]! } as const;

/** The bridge's refusal while a registered host process runs for the Simulator. */
export const surfaceHostPresent = {
  stage: 'failed',
  failure: {
    kind: 'unsupported',
    code: 'system-surface-host-present',
    details: { surfaceHostExecutable: presentSurface.host.processExecutable },
  },
} as const satisfies SnapshotSourceOutcome;

/** The bridge's refusal when it found a host process it could not place on a Simulator. */
export const surfaceHostUnverified = {
  stage: 'failed',
  failure: { kind: 'unsupported', code: 'system-surface-host-unverified' },
} as const satisfies SnapshotSourceOutcome;

export const surfaceHostExecutables = IOS_SYSTEM_SURFACE_HOSTS.map(
  (host) => host.processExecutable,
);

export function bridgeAcquisition(): Extract<SnapshotSourceOutcome, { stage: 'acquired' }> {
  return {
    stage: 'acquired',
    acquisition: {
      producer: 'simulator-ax-bridge',
      intent: 'full',
      hint: {
        projection: 'regular',
        rawTraversalDepth: null,
        regularPresentedDepth: null,
        interactiveOnly: false,
        customActions: false,
        acquisitionIntent: 'full',
      },
      nodes: [{ index: 0, type: 'Application' }],
      truncated: false,
      viewport: { kind: 'reported', rect: { x: 0, y: 0, width: 100, height: 200 } },
      lineage: { targetId: target.targetId, generation: target.generation },
      residue: [],
    },
  };
}

/** A runtime host whose presenter publishes every bridge acquisition. */
export function bridgePresentingHost(): PlatformRuntimeHost {
  return {
    ...platformRuntimeHostFixture(),
    snapshot: {
      captureSurface: vi.fn(),
      presentIosAcquisition: vi.fn(async () => ({
        backend: 'xctest' as const,
        producer: 'simulator-ax-bridge' as const,
        nodes: [{ index: 0, type: 'Application' }],
      })),
    },
  };
}

export function sourceReturning(
  outcome: Awaited<ReturnType<SimulatorSnapshotSource['acquire']>>,
): SimulatorSnapshotSource {
  return { acquire: vi.fn(async () => outcome), close: vi.fn(async () => {}) };
}

export function runnerResult() {
  return { backend: 'xctest' as const, producer: 'apple-runner' as const, nodes: [] };
}

/** The runner's capture OF the sheet: it stamps the surface it actually served onto the result. */
export function surfaceRunnerResult() {
  return {
    ...runnerResult(),
    systemSurface: { bundleId: presentSurface.host.bundleId, kind: presentSurface.host.kind },
  };
}

export function signal(): AbortSignal {
  return new AbortController().signal;
}
